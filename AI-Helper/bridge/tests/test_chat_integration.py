"""DeepSeekChat against the local fake chat page, in a real headless Chrome.

Skipped when Chrome is not installed. Run: .venv\\Scripts\\python -m pytest tests/test_chat_integration.py
"""

from __future__ import annotations

import json
import re
import threading

import pytest

from deepseek_bridge import browser_manager as bm
from deepseek_bridge.browser_manager import DeepSeekBrowserManager
from deepseek_bridge.config import TEST_PAGES_DIR
from deepseek_bridge.deepseek_chat import ChatError, DeepSeekChat
from deepseek_bridge.server import make_server

pytestmark = pytest.mark.skipif(bm.find_chrome() is None, reason="Chrome not installed")

PROMPT = """Верни JSON.

[q1] (один правильный вариант)
Вопрос: Столица Франции?
Варианты:
  option_1: Берлин
  option_2: Париж

[q2] (ввод текста: ответ в answer_text, selected_options = [])
Вопрос: Как называется самая длинная река в мире?
"""


@pytest.fixture(scope="module")
def pages_url():
    srv = make_server(DeepSeekBrowserManager(driver_factory=lambda p: None), "127.0.0.1", 0, pages_dir=TEST_PAGES_DIR)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/test-pages"
    srv.shutdown()
    srv.server_close()


@pytest.fixture
def chat_for(tmp_path, monkeypatch):
    monkeypatch.setattr(bm, "HEADLESS", True)
    managers = []

    def make(url: str) -> DeepSeekChat:
        m = DeepSeekBrowserManager(profile_dir=tmp_path / f"profile{len(managers)}", url=url)
        managers.append(m)
        return DeepSeekChat(m)

    yield make
    for m in managers:
        m.close()


def _json_from(text: str) -> dict:
    return json.loads(re.search(r"\{[\s\S]*\}", text).group(0))


def test_ask_types_sends_and_waits_for_full_reply(pages_url, chat_for):
    chat = chat_for(f"{pages_url}/fake-deepseek.html")
    assert chat.check()["ready"] is True
    r = chat.ask(PROMPT)
    data = _json_from(r["text"])  # complete JSON, not a half-streamed reply
    assert data["answers"][0] == {"question_id": "q1", "answers": ["option_2"], "confidence": 0.95}
    assert data["answers"][1]["text_answer"] == "Нил"
    # a second question in the same chat returns only the new reply
    r2 = chat.ask(PROMPT.replace("Париж", "Мадрид"))
    assert _json_from(r2["text"])["answers"][0]["answers"] == []


@pytest.mark.parametrize("keep", [2, 3])
def test_long_chat_that_drops_old_messages(pages_url, chat_for, keep):
    # DeepSeek keeps only part of a long chat on the page: the number of replies stops growing,
    # yet every new reply must still be found (and not an old one)
    chat = chat_for(f"{pages_url}/fake-deepseek.html?keep={keep}")
    for options in ("Париж", "Мадрид", "Париж", "Мадрид"):
        r = chat.ask(PROMPT.replace("Париж", options))
        got = _json_from(r["text"])["answers"][0]["answers"]
        assert got == (["option_2"] if options == "Париж" else [])


def test_multiline_prompt_is_not_sent_early(pages_url, chat_for):
    chat = chat_for(f"{pages_url}/fake-deepseek.html")
    chat.ask(PROMPT)
    with chat.manager.lock:
        drv = chat.manager.driver()
        users = drv.execute_script("return Array.from(document.querySelectorAll('.user')).map(e => e.textContent)")
    assert users == [PROMPT]  # one message with all lines


def test_login_required_is_reported(pages_url, chat_for):
    chat = chat_for(f"{pages_url}/fake-deepseek.html?login=1")
    state = chat.check()
    assert state["ready"] is False and state["reason"] == "login_required"
    with pytest.raises(ChatError) as e:
        chat.ask(PROMPT)
    assert e.value.code == "login_required"


def test_cancel_stops_waiting(pages_url, chat_for):
    chat = chat_for(f"{pages_url}/fake-deepseek.html")
    chat.check()
    threading.Timer(0.3, chat.cancel).start()
    with pytest.raises(ChatError) as e:
        chat.ask(PROMPT)
    assert e.value.code == "cancelled"


def test_missing_input_means_ui_changed(pages_url, chat_for):
    chat = chat_for(f"{pages_url}/index.html")  # a page without a chat box
    state = chat.check(timeout=1)
    assert state["reason"] == "ui_changed"
