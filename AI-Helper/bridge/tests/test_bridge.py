"""Tests for DeepSeekBrowserManager and the HTTP bridge, with a fake WebDriver."""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from deepseek_bridge.browser_manager import BrowserManagerError, DeepSeekBrowserManager, _translate_start_error
from deepseek_bridge.config import CLIENT_HEADER, CLIENT_HEADER_VALUE
from deepseek_bridge.server import make_server


class FakeSwitch:
    def __init__(self, drv):
        self.drv = drv

    def window(self, handle):
        if handle not in self.drv.windows:
            raise RuntimeError("no such window")
        self.drv.current = handle

    def new_window(self, kind):
        h = f"w{len(self.drv.windows) + 1}"
        self.drv.windows[h] = "about:blank"
        self.drv.current = h


class FakeDriver:
    """Mimics the parts of selenium's Chrome driver the manager uses."""

    instances = 0

    def __init__(self):
        FakeDriver.instances += 1
        self.windows = {"w1": "about:blank"}
        self.current = "w1"
        self.switch_to = FakeSwitch(self)
        self.quit_called = False
        self.focus_calls = 0

    # user closing the window
    def user_closes_all(self):
        self.windows.clear()

    @property
    def window_handles(self):
        if self.quit_called:
            raise RuntimeError("session deleted")
        return list(self.windows)

    @property
    def current_window_handle(self):
        if self.current not in self.windows:
            raise RuntimeError("no such window")
        return self.current

    @property
    def current_url(self):
        return self.windows[self.current_window_handle]

    def get(self, url):
        self.windows[self.current_window_handle] = url

    def get_window_rect(self):
        return {"x": 0, "y": 0, "width": 1000, "height": 800}

    def minimize_window(self):
        pass

    def set_window_rect(self, **kw):
        self.focus_calls += 1

    def execute_cdp_cmd(self, *a):
        return {}

    def quit(self):
        self.quit_called = True


@pytest.fixture
def manager(tmp_path: Path):
    created: list[FakeDriver] = []

    def factory(profile_dir: Path):
        assert profile_dir == tmp_path / "profile"
        d = FakeDriver()
        created.append(d)
        return d

    m = DeepSeekBrowserManager(profile_dir=tmp_path / "profile", driver_factory=factory)
    m.created = created  # type: ignore[attr-defined]
    return m


def test_open_starts_one_window_and_navigates(manager):
    r = manager.open()
    assert r["action"] == "opened"
    assert r["status"]["running"] is True
    assert r["status"]["on_deepseek"] is True
    assert len(manager.created) == 1


def test_second_open_focuses_instead_of_duplicating(manager):
    manager.open()
    r = manager.open()
    assert r["action"] == "focused"
    assert len(manager.created) == 1
    assert manager.created[0].focus_calls >= 2


def test_reopens_after_user_closed_window(manager):
    manager.open()
    manager.created[0].user_closes_all()
    assert manager.status()["running"] is False
    r = manager.open()
    assert r["action"] == "opened"
    assert len(manager.created) == 2


def test_navigated_away_opens_deepseek_tab_in_same_window(manager):
    manager.open()
    drv = manager.created[0]
    drv.windows["w1"] = "https://example.com/"
    r = manager.open()
    assert r["action"] == "focused"
    assert r["status"]["on_deepseek"] is True
    assert len(drv.windows) == 2
    assert len(manager.created) == 1


def test_close(manager):
    manager.open()
    assert manager.close() is True
    assert manager.created[0].quit_called
    assert manager.status()["running"] is False
    assert manager.close() is False


def test_start_error_is_translated(tmp_path):
    def factory(_):
        raise RuntimeError("session not created: user data directory is already in use, please specify a unique value")

    m = DeepSeekBrowserManager(profile_dir=tmp_path, driver_factory=factory)
    with pytest.raises(BrowserManagerError) as e:
        m.open()
    assert e.value.code == "profile_in_use"
    assert m.status()["last_error"]


@pytest.mark.parametrize(
    "text,code",
    [
        ("Unable to obtain driver for chrome", "driver_not_found"),
        ("unknown error: cannot find Chrome binary", "chrome_not_found"),
        ("session not created: This version of ChromeDriver only supports Chrome version 120", "session_not_created"),
        # a leftover DeepSeek window holds the profile
        ("session not created: Chrome failed to start: crashed.", "profile_in_use"),
        ("something else", "webdriver_error"),
    ],
)
def test_error_codes(text, code):
    assert _translate_start_error(RuntimeError(text)).code == code


def test_leftover_port_file_without_chrome_is_ignored(tmp_path):
    from deepseek_bridge.browser_manager import DEBUG_PORT_FILE, _free_port, running_chrome_address

    assert running_chrome_address(tmp_path) is None
    (tmp_path / DEBUG_PORT_FILE).write_text(str(_free_port()), encoding="ascii")  # nothing listens there
    (tmp_path / "DevToolsActivePort").write_text("garbage\n", encoding="ascii")
    assert running_chrome_address(tmp_path, timeout=0.3) is None


def test_concurrent_open_creates_single_window(manager):
    threads = [threading.Thread(target=manager.open) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(manager.created) == 1


# ---------------- HTTP ----------------


@pytest.fixture
def server(manager, tmp_path):
    pages = tmp_path / "pages"
    pages.mkdir()
    (pages / "index.html").write_text("<h1>ok</h1>", encoding="utf-8")
    srv = make_server(manager, "127.0.0.1", 0, pages_dir=pages)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


def req(url, method="GET", headers=None):
    r = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            body = resp.read()
            return resp.status, dict(resp.headers), json.loads(body) if body and resp.headers.get_content_type() == "application/json" else body
    except urllib.error.HTTPError as e:
        body = e.read()
        return e.code, dict(e.headers), json.loads(body) if body else None


EXT = {"Origin": "chrome-extension://abcdefghijklmnop", CLIENT_HEADER: CLIENT_HEADER_VALUE}


def test_health_and_status(server):
    code, headers, body = req(f"{server}/health", headers=EXT)
    assert code == 200 and body["ok"] is True
    assert headers["Access-Control-Allow-Origin"] == EXT["Origin"]
    code, _, body = req(f"{server}/status", headers=EXT)
    assert code == 200 and body["running"] is False


def test_open_via_http(server, manager):
    code, _, body = req(f"{server}/open", "POST", EXT)
    assert code == 200 and body["action"] == "opened"
    code, _, body = req(f"{server}/open", "POST", EXT)
    assert body["action"] == "focused"
    assert len(manager.created) == 1
    code, _, body = req(f"{server}/close", "POST", EXT)
    assert body == {"closed": True}


def test_rejects_web_origins_and_missing_header(server, manager):
    code, _, body = req(f"{server}/open", "POST", {"Origin": "https://evil.example", CLIENT_HEADER: CLIENT_HEADER_VALUE})
    assert code == 403 and body["error"]["code"] == "forbidden_origin"
    code, _, body = req(f"{server}/open", "POST", {"Origin": EXT["Origin"]})
    assert code == 403 and body["error"]["code"] == "missing_client_header"
    code, _, _ = req(f"{server}/open", "OPTIONS", {"Origin": "https://evil.example"})
    assert code == 403
    assert manager.created == []


def test_preflight_for_extension(server):
    code, headers, _ = req(f"{server}/open", "OPTIONS", {"Origin": EXT["Origin"], "Access-Control-Request-Method": "POST"})
    assert code == 204
    assert CLIENT_HEADER in headers["Access-Control-Allow-Headers"]


def test_error_maps_to_http(tmp_path):
    def factory(_):
        raise BrowserManagerError("chrome_not_found", "нет хрома")

    m = DeepSeekBrowserManager(profile_dir=tmp_path, driver_factory=factory)
    srv = make_server(m, "127.0.0.1", 0)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        code, _, body = req(f"http://127.0.0.1:{srv.server_address[1]}/open", "POST", EXT)
        assert code == 503 and body["error"]["code"] == "chrome_not_found"
    finally:
        srv.shutdown()
        srv.server_close()


def test_test_pages_are_served_without_traversal(server):
    code, headers, body = req(f"{server}/test-pages/")
    assert code == 200 and b"ok" in body
    code, _, _ = req(f"{server}/test-pages/..%2F..%2Fsecret.txt")
    assert code == 404


def test_second_bridge_cannot_take_the_same_port():
    # Windows lets two sockets share a port with SO_REUSEADDR: requests then went to a hung bridge
    m = DeepSeekBrowserManager(driver_factory=lambda p: None)
    first = make_server(m, "127.0.0.1", 0)
    try:
        with pytest.raises(OSError):
            make_server(m, "127.0.0.1", first.server_address[1])
    finally:
        first.server_close()


def test_logging_does_not_wait_for_a_frozen_console(monkeypatch, tmp_path):
    """A click in the console window freezes its output; requests must not wait for it."""
    import logging
    import threading
    import time

    from deepseek_bridge import __main__ as entry

    gate = threading.Event()

    class FrozenStdout:
        def write(self, s):
            gate.wait(10)  # like a console with a text selection
            return len(s)

        def flush(self):
            pass

    root = logging.getLogger()
    saved = root.handlers[:]
    monkeypatch.setattr(entry, "LOG_DIR", tmp_path)
    monkeypatch.setattr(entry.sys, "stdout", FrozenStdout())
    try:
        root.handlers = []
        entry.setup_logging()
        start = time.monotonic()
        for i in range(50):
            logging.getLogger("deepseek_bridge.server").info("request %s", i)
        assert time.monotonic() - start < 1.0
    finally:
        gate.set()
        root.handlers = saved
