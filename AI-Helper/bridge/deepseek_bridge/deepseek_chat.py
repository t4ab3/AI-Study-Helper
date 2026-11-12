"""Drives the DeepSeek web chat in the Selenium window: type a prompt, send it, wait for the
reply to finish and return its text.

It works only through the normal web UI of a logged-in user. It does not bypass the login,
CAPTCHA or any other protection: when DeepSeek asks for a login or shows a check, it reports
that and waits for the user to handle it in the window.

The selectors below match DeepSeek's markup at the time of writing. If DeepSeek changes its
UI, put corrected selectors into bridge/deepseek_selectors.json (same keys) instead of
editing code; `python -m deepseek_bridge --check` shows which ones match.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from typing import Any, Callable, Optional

from .browser_manager import BrowserManagerError, DeepSeekBrowserManager
from .config import SELECTORS_FILE

log = logging.getLogger("deepseek_bridge.chat")

DEFAULT_SELECTORS: dict[str, list[str]] = {
    # message box
    "input": ["textarea#chat-input", "textarea[placeholder]", "textarea"],
    # rendered assistant replies, in page order (the last one is the newest)
    # (checked on chat.deepseek.com 2026-11: the reply text lives in .ds-assistant-message-main-content;
    # listing it first keeps "DeepThink" reasoning blocks out of the answer)
    "assistant_message": [
        ".ds-markdown.ds-assistant-message-main-content",
        ".ds-markdown",
        "[class*='ds-markdown']",
        "[data-role='assistant'] .markdown",
    ],
    # send button, used only if Enter did not send (DeepSeek: round filled button next to the box)
    "send_button": [
        "button[type='submit']",
        "[aria-label*='Send']",
        "[aria-label*='Отправ']",
        "[aria-label*='Надісл']",
        "div.ds-button--primary.ds-button--filled.ds-button--circle[role='button']",
    ],
    # visible only while the answer is being generated. DeepSeek's buttons currently have no labels,
    # so this often matches nothing; the reply is then considered finished when its text stops changing.
    "stop_button": [
        "[aria-label*='Stop']",
        "[aria-label*='Останов']",
        "[aria-label*='Зупин']",
        "[data-generating='true']",
    ],
    # login / checks
    "login_form": ["input[type='password']", "form[action*='login']"],
    "captcha": [
        "iframe[src*='captcha']",
        "iframe[src*='challenges.cloudflare.com']",
        "iframe[title*='challenge']",
        "#cf-challenge-running",
        ".cf-turnstile",
        "[class*='captcha']",
    ],
}

LOGIN_URL_MARKERS = ("sign_in", "sign_up", "/login", "/signin")
BUSY_RE = re.compile(r"(server is busy|сервер занят|too many requests|try again later|попробуйте позже)", re.I)

# JS helpers (run in the DeepSeek tab; they only look at the elements listed above)
_JS_FIRST = """
const sels = arguments[0];
for (const s of sels) {
  try {
    for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none') return el;
    }
  } catch (e) {}
}
return null;
"""

_JS_MESSAGES = """
// arguments[1]: a mark to put on every reply now on the page (done right before sending).
// arguments[2]: the mark to look for. Replies after the last marked one are new. Counting replies
// is not enough: in a long chat DeepSeek removes old messages from the page as new ones arrive.
const sels = arguments[0], mark = arguments[1], want = arguments[2], html = arguments[3];
const ATTR = 'data-aits-seen';
for (const s of sels) {
  let list = [];
  try { list = Array.from(document.querySelectorAll(s)); } catch (e) { continue; }
  // drop nested matches so one reply counts once
  list = list.filter(el => !list.some(o => o !== el && o.contains(el)));
  if (!list.length) continue;
  if (mark) list.forEach(el => el.setAttribute(ATTR, mark));
  let lastSeen = -1, seen = 0;
  if (want) list.forEach((el, i) => { if (el.getAttribute(ATTR) === want) { lastSeen = i; seen++; } });
  const after = want ? list.slice(lastSeen + 1) : [];
  return {
    selector: s, count: list.length, last: list[list.length - 1].innerText || '',
    seen: seen, fresh: after.length, freshText: after.length ? (after[after.length - 1].innerText || '') : '',
    freshHtml: html && after.length ? after[after.length - 1].innerHTML : '',
    lastHtml: html ? list[list.length - 1].innerHTML : '',
  };
}
return { selector: null, count: 0, last: '', seen: 0, fresh: 0, freshText: '' };
"""

_JS_SET_VALUE = """
const el = arguments[0], value = arguments[1];
el.focus();
const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return el.value.length;
"""


PROBE_PROMPT = 'Проверка связи. Ответь строго одной строкой JSON без пояснений: {"ok": true, "answer": 4}'

# For --check-ask: short description of buttons near the message box and of the last reply's
# ancestors, so broken selectors can be fixed in deepseek_selectors.json.
_JS_HINTS = """
const box = document.querySelector('textarea');
const desc = el => {
  const a = el.getAttribute('aria-label'), r = el.getAttribute('role');
  return (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 4).join('.') : '') +
    (r ? `[role=${r}]` : '') + (a ? `[aria-label="${a}"]` : '') +
    (el.getAttribute('aria-disabled') ? `[aria-disabled=${el.getAttribute('aria-disabled')}]` : '')).slice(0, 160);
};
let buttons = [];
if (box) {
  let scope = box;
  for (let i = 0; i < 6 && scope.parentElement; i++) scope = scope.parentElement;
  buttons = Array.from(scope.querySelectorAll('button, [role=button]'))
    .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map(desc).slice(0, 15);
}
const md = Array.from(document.querySelectorAll('[class*=markdown]'));
const last = md[md.length - 1];
const chain = [];
for (let el = last, i = 0; el && i < 5; el = el.parentElement, i++) chain.push(desc(el));
return { buttons_near_input: buttons, markdown_nodes: md.length, last_markdown_chain: chain };
"""


class ChatError(BrowserManagerError):
    """Chat-level error. Codes: login_required, captcha, ui_changed, send_failed, timeout,
    busy, cancelled, empty_answer."""


def load_selectors() -> dict[str, list[str]]:
    sel = {k: list(v) for k, v in DEFAULT_SELECTORS.items()}
    try:
        if SELECTORS_FILE.exists():
            data = json.loads(SELECTORS_FILE.read_text(encoding="utf-8"))
            for k, v in data.items():
                if isinstance(v, list) and all(isinstance(x, str) for x in v):
                    sel[k] = v + [x for x in sel.get(k, []) if x not in v]
            log.info("selector overrides loaded from %s", SELECTORS_FILE)
    except Exception as e:  # noqa: BLE001
        log.warning("cannot read %s: %s", SELECTORS_FILE, e)
    return sel


def looks_like_complete_json(text: str) -> bool:
    """The reply already contains a parsable JSON object (lets us finish waiting early)."""
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return False
    try:
        json.loads(text[start : end + 1])
        return True
    except ValueError:
        return False


class DeepSeekChat:
    def __init__(
        self,
        manager: DeepSeekBrowserManager,
        selectors: Optional[dict[str, list[str]]] = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.manager = manager
        self.sel = selectors or load_selectors()
        self._cancel = threading.Event()
        self._clock = clock
        self._sleep = sleep
        self.asked = 0
        self._seq = 0

    # ---------- helpers ----------

    def _first(self, drv: Any, key: str) -> Any:
        return drv.execute_script(_JS_FIRST, self.sel[key])

    def _messages(self, drv: Any, mark: Optional[str] = None, want: Optional[str] = None, html: bool = False) -> dict:
        return drv.execute_script(_JS_MESSAGES, self.sel["assistant_message"], mark, want, html) or {"count": 0, "last": ""}

    def _reply_html(self, drv: Any, before: dict) -> str:
        """HTML of the reply that _new_reply found (DeepSeek renders its Markdown into it)."""
        msgs = self._messages(drv, want=before["mark"], html=True)
        if msgs.get("seen") or not before["count"]:
            return msgs.get("freshHtml") or ""
        return msgs.get("lastHtml") or ""

    def _mark_existing(self, drv: Any) -> dict:
        """Marks the replies already on the page; returns {"mark", "count"} to find the new one later."""
        self._seq += 1
        mark = f"{int(time.time() * 1000)}-{self._seq}"
        msgs = self._messages(drv, mark=mark)
        return {"mark": mark, "count": msgs.get("count", 0), "last": (msgs.get("last") or "").strip(), "latched": False}

    def _new_reply(self, drv: Any, before: dict) -> Optional[str]:
        """Text of the reply sent after `before` ('' while it is still empty), or None if there is none yet."""
        msgs = self._messages(drv, want=before["mark"])
        if msgs.get("seen") or not before["count"]:
            # the marks are on the page (or the chat was empty): a reply after them is the new one
            return (msgs.get("freshText") or "").strip() if msgs.get("fresh") else None
        # No marked reply is left on the page: DeepSeek removed them (the new reply pushed the
        # previous one out) or redrew the chat. The last reply is new once it differs from the one
        # we saw before sending; from then on it is followed until it stops changing.
        last = (msgs.get("last") or "").strip()
        if before["latched"] or msgs.get("count", 0) > before["count"] or last != before["last"]:
            before["latched"] = True
            return last
        return None

    def _state(self, drv: Any) -> dict:
        """Where the chat is: ready / login_required / captcha / ui_changed."""
        url = drv.current_url or ""
        if any(m in url for m in LOGIN_URL_MARKERS) or self._first(drv, "login_form"):
            return {"ready": False, "logged_in": False, "reason": "login_required",
                    "message": "Войдите в DeepSeek в открытом окне. После входа решение продолжится."}
        if self._first(drv, "captcha"):
            return {"ready": False, "logged_in": True, "reason": "captcha",
                    "message": "DeepSeek показывает проверку (CAPTCHA). Пройдите её вручную в окне DeepSeek."}
        if not self._first(drv, "input"):
            return {"ready": False, "logged_in": True, "reason": "ui_changed",
                    "message": "Не найдено поле ввода DeepSeek. Страница не загрузилась или интерфейс DeepSeek изменился."}
        return {"ready": True, "logged_in": True, "reason": None, "message": "DeepSeek готов"}

    def _wait_state(self, drv: Any, timeout: float) -> dict:
        """Waits for the page to settle into a known state (it may still be loading)."""
        deadline = self._clock() + timeout
        state = self._state(drv)
        while not state["ready"] and state["reason"] == "ui_changed" and self._clock() < deadline:
            self._sleep(0.4)
            state = self._state(drv)
        return state

    # ---------- API ----------

    def check(self, timeout: float = 15.0) -> dict:
        with self.manager.lock:
            drv = self.manager.driver()
            state = self._wait_state(drv, timeout)
            state["url"] = drv.current_url
            return state

    def cancel(self) -> None:
        self._cancel.set()

    def new_chat(self) -> None:
        with self.manager.lock:
            drv = self.manager.driver()
            drv.get(self.manager.url)
            self._wait_state(drv, 15)

    def ask(self, prompt: str, new_chat: bool = False, timeout: float = 180.0, html: bool = False, settle: float = 5.0) -> dict:
        """Sends `prompt` and returns {"text": reply, "elapsed": seconds} (+ "html" when asked)."""
        if not prompt.strip():
            raise ChatError("empty_prompt", "Пустой запрос.")
        self._cancel.clear()
        started = self._clock()
        with self.manager.lock:
            drv = self.manager.driver()
            if new_chat:
                drv.get(self.manager.url)
            state = self._wait_state(drv, 20)
            if not state["ready"]:
                raise ChatError(state["reason"], state["message"])

            box = self._first(drv, "input")
            self._type(drv, box, prompt)
            before = self._mark_existing(drv)
            # a long text (lecture notes) can take DeepSeek a minute or two before the reply starts
            self._send(drv, box, before, patience=30 if len(prompt) < 4000 else 150)
            log.info("prompt sent (%d chars), waiting for the reply", len(prompt))
            text = self._wait_reply(drv, before, started + timeout, settle)
            self.asked += 1
            elapsed = round(self._clock() - started, 1)
            log.info("reply received in %.1fs (%d chars)", elapsed, len(text))
            result = {"text": text, "elapsed": elapsed}
            if html:
                result["html"] = self._reply_html(drv, before)
            return result

    # ---------- steps ----------

    def _type(self, drv: Any, box: Any, prompt: str) -> None:
        length = drv.execute_script(_JS_SET_VALUE, box, prompt)
        if length == len(prompt):
            return
        # Fallback: real key presses, Shift+Enter for line breaks so nothing is sent early.
        from selenium.webdriver.common.action_chains import ActionChains
        from selenium.webdriver.common.keys import Keys

        drv.execute_script(_JS_SET_VALUE, box, "")
        box.click()
        chain = ActionChains(drv)
        for i, line in enumerate(prompt.split("\n")):
            if i:
                chain.key_down(Keys.SHIFT).send_keys(Keys.ENTER).key_up(Keys.SHIFT)
            chain.send_keys(line)
        chain.perform()
        if len(drv.execute_script("return arguments[0].value", box) or "") < len(prompt) * 0.9:
            raise ChatError("ui_changed", "Не удалось вставить запрос в поле ввода DeepSeek.")

    def _send(self, drv: Any, box: Any, before: dict, patience: float = 30) -> None:
        from selenium.webdriver.common.keys import Keys

        box.send_keys(Keys.ENTER)
        if self._wait_new_message(drv, before, 8):
            return
        if not self._box_text(drv):
            # the field emptied, so the prompt went out: DeepSeek is just slow to start the reply.
            # Pressing "send" again here could send a second message.
            if self._wait_new_message(drv, before, patience):
                return
            state = self._state(drv)
            if not state["ready"]:
                raise ChatError(state["reason"], state["message"])
            raise ChatError(
                "send_failed", f"Запрос отправлен, но ответ DeepSeek не появился на странице за {int(patience + 8)} с."
            )
        # Enter did not send: try the send button once.
        btn = self._first(drv, "send_button")
        if btn is not None:
            try:
                btn.click()
            except Exception:  # noqa: BLE001
                drv.execute_script("arguments[0].click()", btn)
            if self._wait_new_message(drv, before, 12):
                return
        state = self._state(drv)
        if not state["ready"]:
            raise ChatError(state["reason"], state["message"])
        raise ChatError(
            "send_failed",
            "Запрос не отправился: ответ DeepSeek не появился. Возможно, изменился интерфейс DeepSeek или есть лимит сообщений.",
        )

    def _box_text(self, drv: Any) -> str:
        box = self._first(drv, "input")
        if box is None:
            return ""
        try:
            return (drv.execute_script("return arguments[0].value || arguments[0].innerText || ''", box) or "").strip()
        except Exception:  # noqa: BLE001
            return ""

    def _wait_new_message(self, drv: Any, before: dict, timeout: float) -> bool:
        deadline = self._clock() + timeout
        while self._clock() < deadline:
            if self._cancel.is_set():
                raise ChatError("cancelled", "Остановлено пользователем.")
            if self._new_reply(drv, before) is not None:
                return True
            self._sleep(0.25)
        return False

    def _wait_reply(self, drv: Any, before: dict, deadline: float, settle: float = 5.0) -> str:
        """Waits until the reply stops changing and the UI no longer shows the stop button."""
        last_text = ""
        last_change = self._clock()
        while True:
            if self._cancel.is_set():
                raise ChatError("cancelled", "Остановлено пользователем.")
            now = self._clock()
            if now > deadline:
                raise ChatError("timeout", "DeepSeek не закончил ответ вовремя.")
            text = self._new_reply(drv, before) or ""
            if text != last_text:
                last_text, last_change = text, now
            generating = self._first(drv, "stop_button") is not None
            stable = now - last_change
            if text and not generating:
                # complete JSON: short settle time; otherwise wait longer for more text
                if stable >= (1.2 if looks_like_complete_json(text) else settle):
                    break
            self._sleep(0.3)
        if BUSY_RE.search(last_text) and not looks_like_complete_json(last_text):
            raise ChatError("busy", "DeepSeek занят или ограничил запросы. Повторю позже.")
        if not last_text:
            raise ChatError("empty_answer", "DeepSeek вернул пустой ответ.")
        return last_text

    def diagnose(self) -> dict:
        """Which selectors match right now (for --check)."""
        with self.manager.lock:
            drv = self.manager.driver()
            out = {"url": drv.current_url, "state": self._state(drv), "matches": {}}
            for key, sels in self.sel.items():
                out["matches"][key] = [s for s in sels if drv.execute_script(_JS_FIRST, [s]) is not None]
            out["assistant_messages"] = self._messages(drv).get("count", 0)
            return out

    def probe(self, prompt: str = PROBE_PROMPT, timeout: float = 120.0) -> dict:
        """--check-ask: sends one short test question and records which selectors match while
        DeepSeek is generating and after it finished. Prints page hints when something is missing."""
        out: dict = {"prompt": prompt}
        with self.manager.lock:
            drv = self.manager.driver()
            state = self._wait_state(drv, 20)
            out["state"] = state
            if not state["ready"]:
                return out
            box = self._first(drv, "input")
            self._type(drv, box, prompt)
            before = self._mark_existing(drv)
            out["typed"] = True
            seen: dict[str, set] = {k: set() for k in ("stop_button", "send_button")}
            from selenium.webdriver.common.keys import Keys

            box.send_keys(Keys.ENTER)
            started = self._clock()
            last, last_change, generating_samples, samples = "", started, 0, 0
            while self._clock() - started < timeout:
                text = self._new_reply(drv, before) or ""
                for k in seen:
                    for s in self.sel[k]:
                        if drv.execute_script(_JS_FIRST, [s]) is not None:
                            seen[k].add(s)
                samples += 1
                if drv.execute_script(_JS_FIRST, self.sel["stop_button"]) is not None:
                    generating_samples += 1
                if samples == 4:
                    out["hints_while_generating"] = drv.execute_script(_JS_HINTS)
                if text != last:
                    last, last_change = text, self._clock()
                if text and self._clock() - last_change > 6:
                    break
                self._sleep(0.4)
            out["new_messages"] = self._messages(drv)["count"] - before["count"]
            out["message_selector"] = self._messages(drv).get("selector")
            out["reply"] = last[:500]
            out["reply_is_json"] = looks_like_complete_json(last)
            out["stop_button_seen"] = sorted(seen["stop_button"])
            out["send_button_seen"] = sorted(seen["send_button"])
            out["samples"] = samples
            out["generating_samples"] = generating_samples
            out["hints_after"] = drv.execute_script(_JS_HINTS)
            return out
