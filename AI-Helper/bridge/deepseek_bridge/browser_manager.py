"""DeepSeek Browser Manager.

Opens https://chat.deepseek.com/ in a separate Chrome window driven by Selenium, using a
dedicated persistent profile directory inside the project. The user logs in manually once;
the session is kept in that profile.

What this module deliberately does NOT do: it never types into DeepSeek, never sends
messages and never reads the chat DOM. The only things it inspects are the window handles
and the current URL, to know whether the window is alive and on DeepSeek.
"""

from __future__ import annotations

import logging
import os
import shutil
import socket
import threading
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlparse

from .config import DEEPSEEK_URL, HEADLESS, PROFILE_DIR

log = logging.getLogger("deepseek_bridge.browser")

DriverFactory = Callable[[Path], Any]


class BrowserManagerError(Exception):
    """Error with a stable code the extension can show a hint for."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


CHROME_CANDIDATES = [
    os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
    os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
    os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
]


def find_chrome() -> Optional[str]:
    """Path to the Chrome binary, or None. AITS_CHROME_BINARY overrides the search."""
    override = os.environ.get("AITS_CHROME_BINARY")
    if override:
        return override if Path(override).exists() else None
    for c in CHROME_CANDIDATES:
        if c and Path(c).exists():
            return c
    for name in ("chrome", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    return None


def default_driver_factory(profile_dir: Path) -> Any:
    """Starts Chrome through Selenium with the dedicated profile."""
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options

    chrome = find_chrome()
    if not chrome:
        raise BrowserManagerError(
            "chrome_not_found",
            "Google Chrome не найден. Установите Chrome или укажите путь в переменной AITS_CHROME_BINARY.",
        )
    profile_dir.mkdir(parents=True, exist_ok=True)

    # A DeepSeek window from an earlier bridge run may still be open (the bridge was closed, the
    # window was not). A second Chrome cannot start on the same profile, so connect to that one.
    address = running_chrome_address(profile_dir)
    if address:
        log.info("DeepSeek window from an earlier run is still open, connecting to it (%s)", address)
        attach = Options()
        attach.add_experimental_option("debuggerAddress", address)
        try:
            drv = webdriver.Chrome(options=attach)
            drv.aits_attached = True
            return drv
        except Exception as e:  # noqa: BLE001
            log.warning("cannot connect to the open window: %s", str(e).splitlines()[0] if str(e) else e)
            raise BrowserManagerError(
                "profile_in_use",
                "Профиль DeepSeek занят окном Chrome, которое осталось от прошлого запуска. Закройте это окно и повторите.",
            ) from e

    opts = Options()
    opts.binary_location = chrome
    opts.add_argument(f"--user-data-dir={profile_dir}")
    opts.add_argument("--profile-directory=Default")
    opts.add_argument("--no-first-run")
    opts.add_argument("--no-default-browser-check")
    opts.add_argument("--window-size=1100,900")
    if HEADLESS:
        opts.add_argument("--headless=new")
    # A known DevTools port (local only), saved in the profile: if the bridge is closed but the
    # window stays open, the next bridge run connects to that window instead of failing.
    port = _free_port()
    opts.add_argument(f"--remote-debugging-port={port}")
    try:
        (profile_dir / DEBUG_PORT_FILE).write_text(str(port), encoding="ascii")
    except OSError as e:
        log.warning("cannot save the debugging port: %s", e)
    # Keep the window open if the bridge process crashes; a clean shutdown still closes it.
    opts.add_experimental_option("detach", True)
    return webdriver.Chrome(options=opts)


DEBUG_PORT_FILE = "aits-debug-port"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def running_chrome_address(profile_dir: Path, timeout: float = 1.0) -> Optional[str]:
    """Debugging address of a Chrome that is still running with this profile, or None.

    The port comes from our own aits-debug-port file or Chrome's DevToolsActivePort. Both may
    be left behind after Chrome exits, so the port is checked before use."""
    for name in (DEBUG_PORT_FILE, "DevToolsActivePort"):
        try:
            port = int((Path(profile_dir) / name).read_text(encoding="ascii").splitlines()[0].strip())
        except (OSError, ValueError, IndexError):
            continue
        if not 0 < port < 65536:
            continue
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=timeout) as r:
                if r.status == 200:
                    return f"127.0.0.1:{port}"
        except (OSError, ValueError):
            continue
    return None


def _translate_start_error(exc: Exception) -> BrowserManagerError:
    text = str(exc)
    low = text.lower()
    if isinstance(exc, BrowserManagerError):
        return exc
    if "user data directory is already in use" in low or "profile appears to be in use" in low:
        return BrowserManagerError(
            "profile_in_use",
            "Профиль DeepSeek уже используется другим окном Chrome. Закройте окно DeepSeek (или все окна Chrome с этим профилем) и повторите.",
        )
    if "cannot find chrome binary" in low or "no chrome binary" in low:
        return BrowserManagerError("chrome_not_found", "Google Chrome не найден.")
    if "unable to obtain driver" in low or ("chromedriver" in low and "not found" in low):
        return BrowserManagerError(
            "driver_not_found",
            "Не удалось получить ChromeDriver. Нужен доступ в интернет при первом запуске (Selenium Manager скачивает драйвер сам).",
        )
    if "session not created" in low and ("crashed" in low or "devtoolsactiveport" in low):
        # the usual cause: another Chrome (an earlier DeepSeek window) holds the profile
        return BrowserManagerError(
            "profile_in_use",
            "Chrome не запустился: профиль DeepSeek, скорее всего, занят окном Chrome, оставшимся от прошлого запуска. "
            "Закройте окно DeepSeek и повторите.",
        )
    if "session not created" in low:
        return BrowserManagerError("session_not_created", f"Chrome не запустился: {text.splitlines()[0]}")
    return BrowserManagerError("webdriver_error", f"Ошибка Selenium: {text.splitlines()[0] if text else type(exc).__name__}")


def _is_deepseek(url: Optional[str], base: str = DEEPSEEK_URL) -> bool:
    """URL belongs to the chat: same host, and under the base path if one is configured."""
    if not url:
        return False
    try:
        u, b = urlparse(url), urlparse(base)
    except ValueError:
        return False
    if u.hostname != b.hostname or u.port != b.port:
        return False
    prefix = b.path.rsplit("/", 1)[0] if b.path.endswith(".html") else b.path.rstrip("/")
    return u.path.startswith(prefix) if prefix else True


class DeepSeekBrowserManager:
    """Owns at most one Selenium-driven Chrome window with DeepSeek. Thread-safe."""

    def __init__(
        self,
        profile_dir: Path = PROFILE_DIR,
        url: str = DEEPSEEK_URL,
        driver_factory: DriverFactory = default_driver_factory,
    ):
        self.profile_dir = Path(profile_dir)
        self.url = url
        self._factory = driver_factory
        self._driver: Any = None
        self._lock = threading.RLock()
        self.last_error: Optional[str] = None

    # ---------- state ----------

    def _alive(self) -> bool:
        """True if the driver session exists and at least one window is open."""
        if self._driver is None:
            return False
        try:
            return len(self._driver.window_handles) > 0
        except Exception:  # noqa: BLE001 - any WebDriver error means the window is gone
            return False

    def _drop_driver(self) -> None:
        drv, self._driver = self._driver, None
        if drv is not None:
            if getattr(drv, "aits_attached", False):
                # ChromeDriver does not close a browser it did not start: close it explicitly
                try:
                    drv.execute_cdp_cmd("Browser.close", {})
                except Exception:  # noqa: BLE001
                    pass
            try:
                drv.quit()
            except Exception:  # noqa: BLE001
                pass

    def _deepseek_handle(self) -> Optional[str]:
        """Window handle whose tab shows DeepSeek (only the URL is read)."""
        drv = self._driver
        current = None
        try:
            current = drv.current_window_handle
        except Exception:  # noqa: BLE001
            pass
        handles = list(drv.window_handles)
        if current in handles:
            handles.remove(current)
            handles.insert(0, current)
        for h in handles:
            try:
                drv.switch_to.window(h)
                if _is_deepseek(drv.current_url, self.url):
                    return h
            except Exception:  # noqa: BLE001
                continue
        return None

    def status(self, wait: float = 0.5) -> dict:
        # A chat request can hold the lock for minutes: report "busy" instead of blocking.
        if not self._lock.acquire(timeout=wait):
            return {
                "running": True,
                "on_deepseek": True,
                "busy": True,
                "url": None,
                "profile_dir": str(self.profile_dir),
                "last_error": self.last_error,
            }
        try:
            return self._status_locked()
        finally:
            self._lock.release()

    def _status_locked(self) -> dict:
        running = self._alive()
        url = None
        on_deepseek = False
        if running:
            try:
                url = self._driver.current_url
                on_deepseek = _is_deepseek(url, self.url)
            except Exception:  # noqa: BLE001
                running = False
        if not running and self._driver is not None:
            log.info("DeepSeek window was closed by the user")
            self._drop_driver()
        return {
            "running": running,
            "on_deepseek": on_deepseek,
            "busy": False,
            "url": url,
            "profile_dir": str(self.profile_dir),
            "last_error": self.last_error,
        }

    @property
    def lock(self) -> threading.RLock:
        return self._lock

    def driver(self) -> Any:
        """Live driver switched to the DeepSeek tab, opening the window if needed. Call under `lock`."""
        if not self._alive() or self._deepseek_handle() is None:
            self.open()
        self._deepseek_handle()
        return self._driver

    # ---------- actions ----------

    def _focus(self) -> None:
        drv = self._driver
        try:
            rect = drv.get_window_rect()
            # minimize + restore is the reliable way to raise a window on Windows
            drv.minimize_window()
            drv.set_window_rect(**{k: rect[k] for k in ("x", "y", "width", "height")})
        except Exception as e:  # noqa: BLE001
            log.debug("window raise failed: %s", e)
        try:
            drv.execute_cdp_cmd("Page.bringToFront", {})
        except Exception:  # noqa: BLE001
            pass

    def open(self) -> dict:
        """Opens the DeepSeek window, or focuses it if it already exists. Never opens a duplicate."""
        with self._lock:
            self.last_error = None
            if self._alive():
                try:
                    handle = self._deepseek_handle()
                    if handle is None:
                        # The user navigated away or closed the tab: open DeepSeek in a new tab of the same window.
                        self._driver.switch_to.new_window("tab")
                        self._driver.get(self.url)
                    self._focus()
                    log.info("DeepSeek window focused")
                    return {"action": "focused", "status": self._status_locked()}
                except Exception as e:  # noqa: BLE001
                    log.warning("existing window unusable, restarting: %s", e)
                    self._drop_driver()
                    action = "reopened"
            else:
                if self._driver is not None:
                    self._drop_driver()
                action = "opened"

            try:
                log.info("starting Chrome with profile %s", self.profile_dir)
                self._driver = self._factory(self.profile_dir)
                self._driver.get(self.url)
                self._focus()
            except Exception as e:  # noqa: BLE001
                err = _translate_start_error(e)
                self.last_error = err.message
                log.error("failed to open DeepSeek: %s (%s)", err.message, err.code)
                self._drop_driver()
                raise err from e
            log.info("DeepSeek window %s", action)
            return {"action": action, "status": self._status_locked()}

    def close(self) -> bool:
        with self._lock:
            had = self._driver is not None
            self._drop_driver()
            if had:
                log.info("DeepSeek window closed by request")
            return had
