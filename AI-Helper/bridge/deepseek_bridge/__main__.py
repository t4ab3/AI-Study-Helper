"""Entry point: python -m deepseek_bridge [--port 8765] [--open]"""

from __future__ import annotations

import argparse
import atexit
import logging
import queue
import signal
import sys
from logging.handlers import QueueHandler, QueueListener, RotatingFileHandler

from .browser_manager import BrowserManagerError, DeepSeekBrowserManager, find_chrome
from .config import DEEPSEEK_URL, HOST, LOG_DIR, PORT, PROFILE_DIR, VERSION
from .deepseek_chat import DeepSeekChat
from .server import make_server


def disable_quick_edit() -> None:
    """A click in the Windows console window starts a text selection ("QuickEdit") and freezes
    everything the process prints until the selection is cleared. The bridge then looked hung."""
    if sys.platform != "win32":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return  # no console (output redirected, tests)
        ENABLE_QUICK_EDIT_MODE, ENABLE_EXTENDED_FLAGS = 0x0040, 0x0080
        kernel32.SetConsoleMode(handle, (mode.value & ~ENABLE_QUICK_EDIT_MODE) | ENABLE_EXTENDED_FLAGS)
    except Exception:  # noqa: BLE001
        pass


def setup_logging() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    file_handler = RotatingFileHandler(LOG_DIR / "bridge.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    file_handler.setFormatter(fmt)
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    # Request threads only put records into a queue; one background thread writes them.
    # If the console window stops accepting output, logging waits there, not the whole bridge.
    records: queue.SimpleQueue = queue.SimpleQueue()
    listener = QueueListener(records, file_handler, console, respect_handler_level=True)
    listener.start()
    atexit.register(listener.stop)
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(QueueHandler(records))
    # Selenium is chatty at INFO
    logging.getLogger("selenium").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AI Helper: DeepSeek bridge (тесты и конспекты лекций)")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--open", action="store_true", help="сразу открыть окно DeepSeek")
    parser.add_argument(
        "--check",
        action="store_true",
        help="открыть DeepSeek, показать состояние входа и какие селекторы интерфейса найдены, и выйти",
    )
    parser.add_argument(
        "--check-ask",
        action="store_true",
        help="как --check, плюс отправить в DeepSeek один короткий тестовый вопрос и проверить чтение ответа",
    )
    args = parser.parse_args(argv)

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("Bridge слушает только локальный адрес.", file=sys.stderr)
        return 2

    disable_quick_edit()
    setup_logging()
    log = logging.getLogger("deepseek_bridge")
    chrome = find_chrome()
    log.info("AI Helper bridge %s", VERSION)
    log.info("Chrome: %s", chrome or "НЕ НАЙДЕН")
    log.info("DeepSeek profile: %s", PROFILE_DIR)
    log.info("DeepSeek URL: %s", DEEPSEEK_URL)

    manager = DeepSeekBrowserManager()
    chat = DeepSeekChat(manager)

    if args.check or args.check_ask:
        import json as _json

        try:
            print(_json.dumps(chat.diagnose(), ensure_ascii=False, indent=2))
            if args.check_ask:
                print(_json.dumps(chat.probe(), ensure_ascii=False, indent=2))
        except BrowserManagerError as e:
            log.error("%s", e.message)
            return 1
        finally:
            # close the window: nothing could control it after this process exits,
            # and an orphaned window keeps the profile locked. The login stays in the profile.
            manager.close()
        return 0
    try:
        server = make_server(manager, args.host, args.port, chat=chat)
    except OSError as e:
        log.error("Порт %s занят (%s). Bridge уже запущен? Закройте его или укажите --port.", args.port, e)
        return 1

    def shutdown(*_):
        log.info("stopping")
        manager.close()

    atexit.register(manager.close)
    # On --check we intentionally leave the window open, so register cleanup only here.
    signal.signal(signal.SIGTERM, lambda *_: (shutdown(), sys.exit(0)))

    if args.open:
        try:
            manager.open()
        except BrowserManagerError as e:
            log.error("%s", e.message)

    log.info("Listening on http://%s:%s  (test pages: http://%s:%s/test-pages/)", args.host, args.port, args.host, args.port)
    log.info("Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
