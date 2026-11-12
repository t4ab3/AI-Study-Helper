"""Local HTTP bridge between the Chrome extension and DeepSeekBrowserManager.

Listens on 127.0.0.1 only. API:
  GET  /health   -> {"ok": true, "version": ...}
  GET  /status   -> window state
  POST /open     -> open or focus the DeepSeek window
  POST /close    -> close it
  POST /deepseek/check     -> is the chat ready / logged in?
  POST /deepseek/ask       -> {"prompt": "...", "new_chat": bool} -> {"text": reply}
  POST /deepseek/new_chat  -> start a fresh conversation
  POST /deepseek/cancel    -> abort the request that is waiting for a reply
  GET  /test-pages/<file>  -> static local test pages (for trying the extension)

Lecture notes:
  GET  /lecture/engine            -> speech recognition model state
  GET  /lectures                  -> recent lectures
  GET  /lecture/<id>[?full=1]     -> state, recorded / transcribed seconds, transcript
  POST /lecture/start             -> {"title", "language": "uk" | "ru" | "en"} -> new lecture, recording
  POST /lecture/<id>/audio        -> raw 16 kHz mono s16le PCM (application/octet-stream)
  POST /lecture/<id>/stop
  POST /lecture/upload?title=&name=&language= -> an audio/video file as the body
  POST /lecture/<id>/summarize    -> {"open": true} DeepSeek writes the notes into a .docx
  POST /lecture/<id>/open         -> {"what": "docx" | "folder" | "transcript"}

API calls must come from a chrome-extension:// origin (or no origin, e.g. curl) and carry
the X-AITS-Client header, so ordinary web pages cannot open windows on the user's machine.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import socket
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, unquote, urlparse

from .browser_manager import BrowserManagerError, DeepSeekBrowserManager
from .deepseek_chat import DeepSeekChat
from .config import CLIENT_HEADER, CLIENT_HEADER_VALUE, NOTES_DIR, TEST_PAGES_DIR, VERSION
from .lecture import LectureStore, open_path
from .transcriber import LANGUAGES

log = logging.getLogger("deepseek_bridge.server")


def _origin_allowed(origin: Optional[str]) -> bool:
    return origin is None or origin.startswith("chrome-extension://")


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "AIHelperBridge/" + VERSION
    manager: DeepSeekBrowserManager  # set by make_server
    chat: DeepSeekChat
    lectures: LectureStore
    pages_dir: Path = TEST_PAGES_DIR

    # quieter default logging, routed to our logger
    def log_message(self, fmt: str, *args) -> None:  # noqa: D401
        log.info("%s %s", self.address_string(), fmt % args)

    # ---------- helpers ----------

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin and origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", f"Content-Type, {CLIENT_HEADER}")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")

    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        try:
            self.end_headers()
            self.wfile.write(data)
        except CLIENT_GONE:
            # the panel stopped waiting (closed, reloaded or timed out): nothing to answer
            self.close_connection = True

    def _error(self, status: int, code: str, message: str) -> None:
        self._json(status, {"error": {"code": code, "message": message}})

    def _authorized(self) -> bool:
        if not _origin_allowed(self.headers.get("Origin")):
            self._error(HTTPStatus.FORBIDDEN, "forbidden_origin", "Запросы разрешены только из расширения.")
            return False
        if self.headers.get(CLIENT_HEADER) != CLIENT_HEADER_VALUE:
            self._error(HTTPStatus.FORBIDDEN, "missing_client_header", f"Нужен заголовок {CLIENT_HEADER}.")
            return False
        return True

    # ---------- routes ----------

    def do_OPTIONS(self) -> None:  # noqa: N802
        if not _origin_allowed(self.headers.get("Origin")):
            self.send_response(HTTPStatus.FORBIDDEN)
            self.end_headers()
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path.startswith("/test-pages"):
            self._serve_page(path)
            return
        if path == "/health":
            if self._authorized():
                self._json(HTTPStatus.OK, {"ok": True, "version": VERSION})
            return
        if path.startswith("/lecture"):
            if self._authorized():
                self._lecture_get(path, parse_qs(urlparse(self.path).query))
            return
        if path == "/status":
            if self._authorized():
                try:
                    self._json(HTTPStatus.OK, self.manager.status())
                except Exception as e:  # noqa: BLE001
                    log.exception("status failed")
                    self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "status_failed", str(e))
            return
        self._error(HTTPStatus.NOT_FOUND, "not_found", "Нет такого адреса.")

    POST_ROUTES = ("/open", "/close", "/deepseek/check", "/deepseek/ask", "/deepseek/new_chat", "/deepseek/cancel")
    MAX_BODY = 256 * 1024

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > self.MAX_BODY:
            raise ValueError("Слишком большой запрос.")
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("Ожидался JSON-объект.")
        return data

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path.startswith("/lecture/"):
            if self._authorized():
                self._lecture_post(path, parse_qs(urlparse(self.path).query))
            return
        if path not in self.POST_ROUTES:
            self._error(HTTPStatus.NOT_FOUND, "not_found", "Нет такого адреса.")
            return
        if not self._authorized():
            return
        try:
            body = self._read_json()
        except ValueError as e:
            self._error(HTTPStatus.BAD_REQUEST, "bad_request", str(e))
            return
        try:
            if path == "/open":
                self._json(HTTPStatus.OK, self.manager.open())
            elif path == "/close":
                self._json(HTTPStatus.OK, {"closed": self.manager.close()})
            elif path == "/deepseek/check":
                self._json(HTTPStatus.OK, self.chat.check())
            elif path == "/deepseek/new_chat":
                self.chat.new_chat()
                self._json(HTTPStatus.OK, {"ok": True})
            elif path == "/deepseek/cancel":
                self.chat.cancel()
                self._json(HTTPStatus.OK, {"ok": True})
            else:
                prompt = body.get("prompt")
                if not isinstance(prompt, str) or not prompt.strip():
                    self._error(HTTPStatus.BAD_REQUEST, "bad_request", "Нужно поле prompt.")
                    return
                timeout = float(body.get("timeout") or 180)
                result = self.chat.ask(prompt, new_chat=bool(body.get("new_chat")), timeout=min(max(timeout, 10), 600))
                self._json(HTTPStatus.OK, result)
        except BrowserManagerError as e:
            status = {
                "profile_in_use": HTTPStatus.CONFLICT,
                "login_required": HTTPStatus.CONFLICT,
                "captcha": HTTPStatus.CONFLICT,
                "cancelled": HTTPStatus.CONFLICT,
                "timeout": HTTPStatus.GATEWAY_TIMEOUT,
            }.get(e.code, HTTPStatus.SERVICE_UNAVAILABLE)
            log.warning("%s -> %s: %s", path, e.code, e.message)
            self._error(status, e.code, e.message)
        except Exception as e:  # noqa: BLE001
            log.exception("%s failed", path)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error", f"Внутренняя ошибка: {e}")

    # ---------- lecture notes ----------

    MAX_AUDIO_POST = 8 * 1024 * 1024
    MAX_UPLOAD = 4 * 1024 * 1024 * 1024

    def _lecture_get(self, path: str, query: dict) -> None:
        try:
            if path == "/lecture/engine":
                self._json(HTTPStatus.OK, self.lectures.engine.status())
            elif path == "/lectures":
                self._json(HTTPStatus.OK, {"lectures": self.lectures.list(), "folder": str(self.lectures.root)})
            elif path.startswith("/lecture/") and len(path.strip("/").split("/")) == 2:
                lec = self.lectures.get(path.strip("/").split("/")[1])
                self._json(HTTPStatus.OK, lec.status(full=query.get("full", ["0"])[0] == "1"))
            else:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "Нет такого адреса.")
        except KeyError:
            self._error(HTTPStatus.NOT_FOUND, "no_lecture", "Такой лекции нет.")

    def _lecture_post(self, path: str, query: dict) -> None:
        parts = path.strip("/").split("/")  # lecture, <id|start|upload>, [action]
        try:
            if parts[1:] == ["start"]:
                body = self._read_json()
                title, language = str(body.get("title") or ""), str(body.get("language") or "")
                self._json(HTTPStatus.OK, self.lectures.start_recording(title, language).status())
                return
            if parts[1:] == ["upload"]:
                length = int(self.headers.get("Content-Length") or 0)
                if not length or length > self.MAX_UPLOAD:
                    self._error(HTTPStatus.BAD_REQUEST, "bad_request", "Пустой или слишком большой файл.")
                    return
                language = query.get("language", [""])[0]
                if language and language not in LANGUAGES:
                    self._error(HTTPStatus.BAD_REQUEST, "bad_request", f"Язык не поддерживается: {language}.")
                    return

                def read(f) -> None:
                    left = length
                    while left > 0:
                        chunk = self.rfile.read(min(left, 1 << 20))
                        if not chunk:
                            raise ValueError("Файл передан не полностью.")
                        f.write(chunk)
                        left -= len(chunk)

                lec = self.lectures.from_file(
                    query.get("title", [""])[0], query.get("name", ["audio"])[0], read, language
                )
                self._json(HTTPStatus.OK, lec.status())
                return
            if len(parts) != 3:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "Нет такого адреса.")
                return
            lec = self.lectures.get(parts[1])
            action = parts[2]
            if action == "audio":
                length = int(self.headers.get("Content-Length") or 0)
                if length > self.MAX_AUDIO_POST:
                    self._error(HTTPStatus.BAD_REQUEST, "bad_request", "Слишком большой кусок звука.")
                    return
                lec.add_audio(self.rfile.read(length) if length else b"")
                self._json(HTTPStatus.OK, {"ok": True, "recorded_s": round(lec.recorded_s, 1), "transcribed_s": round(lec.transcribed_s, 1)})
            elif action == "stop":
                lec.stop()
                self._json(HTTPStatus.OK, lec.status())
            elif action == "summarize":
                body = self._read_json()
                lec.summarize(self.chat.ask, open_when_done=bool(body.get("open", True)))
                self._json(HTTPStatus.OK, lec.status())
            elif action == "open":
                what = str(self._read_json().get("what") or "docx")
                target = {
                    "docx": lec.folder / lec.docx if lec.docx else None,
                    "folder": lec.folder,
                    "transcript": lec.transcript_path(),
                }.get(what)
                if target is None or not target.exists():
                    self._error(HTTPStatus.NOT_FOUND, "no_file", "Файла ещё нет.")
                    return
                open_path(target)
                self._json(HTTPStatus.OK, {"ok": True, "path": str(target)})
            else:
                self._error(HTTPStatus.NOT_FOUND, "not_found", "Нет такого адреса.")
        except KeyError:
            self._error(HTTPStatus.NOT_FOUND, "no_lecture", "Такой лекции нет.")
        except ValueError as e:
            self._error(HTTPStatus.CONFLICT, "bad_state", str(e))
        except Exception as e:  # noqa: BLE001
            log.exception("%s failed", path)
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error", f"Внутренняя ошибка: {e}")

    def _serve_page(self, path: str) -> None:
        rel = unquote(path[len("/test-pages"):]).lstrip("/") or "index.html"
        base = self.pages_dir.resolve()
        target = (base / rel).resolve()
        if base not in target.parents or not target.is_file():
            self._error(HTTPStatus.NOT_FOUND, "not_found", "Файл не найден.")
            return
        data = target.read_bytes()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


# the other end closed the connection before the answer was written
CLIENT_GONE = (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second bridge listen on the same port: requests then go to
    # either process at random, including one that hangs. Take the port exclusively instead.
    allow_reuse_address = sys.platform != "win32"

    def server_bind(self) -> None:
        if sys.platform == "win32" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address) -> None:
        if isinstance(sys.exc_info()[1], CLIENT_GONE):
            return
        super().handle_error(request, client_address)


def make_server(
    manager: DeepSeekBrowserManager,
    host: str,
    port: int,
    pages_dir: Path = TEST_PAGES_DIR,
    chat: DeepSeekChat | None = None,
    lectures: LectureStore | None = None,
) -> BridgeServer:
    handler = type(
        "Handler",
        (BridgeHandler,),
        {
            "manager": manager,
            "pages_dir": pages_dir,
            "chat": chat or DeepSeekChat(manager),
            "lectures": lectures or LectureStore(NOTES_DIR),
        },
    )
    return BridgeServer((host, port), handler)
