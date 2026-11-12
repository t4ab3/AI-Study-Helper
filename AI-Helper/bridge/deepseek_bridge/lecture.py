"""Lecture notes: audio → text (live, while recording) → DeepSeek → Word document.

Every lecture lives in its own folder under NOTES_DIR:
  meta.json         state, title, times
  audio.wav         the recording (16 kHz mono), or the uploaded file as is
  текст лекции.txt  the transcript, written as it grows
  Конспект — <title>.docx  the notes from DeepSeek
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import wave
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional

from .transcriber import LANGUAGE, LANGUAGES, SAMPLE_RATE, Engine, Segment

log = logging.getLogger("deepseek_bridge.lecture")

# Live transcription works on pieces of about this length, cut in a pause between words.
CHUNK_S = 30.0
CUT_SEARCH_S = 6.0
# No audio for this long while recording (the panel was closed): the recording is stopped.
SILENT_STOP_S = 90.0
# One DeepSeek message holds at most this much transcript; longer lectures go in parts.
PART_CHARS = 30_000
TRANSCRIPT_NAME = "текст лекции.txt"

NOTES_PROMPTS = {
    "uk": """Ти — помічник студента. Нижче — розшифровка аудіозапису лекції{part}, отримана автоматичним розпізнаванням мовлення, тому в ній можуть бути неправильно розпізнані слова.

Склади з неї детальний конспект українською мовою, який студент перепише в зошит:
- {title_rule};
- розділи з підзаголовками в порядку лекції;
- ключові терміни виділяй жирним і давай їм означення;
- зберігай формули, дати, імена, числа, приклади, класифікації, переліки;
- використовуй марковані й нумеровані списки, де це доречно;
- в кінці — короткі висновки;
- виправляй очевидні помилки розпізнавання за змістом, але не вигадуй того, чого в лекції немає;
- без вступних і заключних фраз від себе, одразу конспект у форматі Markdown.

Розшифровка:
\"\"\"
{text}
\"\"\"""",
    "ru": """Ты — помощник студента. Ниже — расшифровка аудиозаписи лекции{part}, полученная автоматическим распознаванием речи, поэтому в ней могут быть неправильно распознанные слова.

Составь из неё подробный конспект на русском языке, который студент перепишет в тетрадь:
- {title_rule};
- разделы с подзаголовками в порядке лекции;
- ключевые термины выделяй жирным и давай им определения;
- сохраняй формулы, даты, имена, числа, примеры, классификации, перечни;
- используй маркированные и нумерованные списки, где это уместно;
- в конце — краткие выводы;
- исправляй очевидные ошибки распознавания по смыслу, но не выдумывай того, чего в лекции нет;
- без вступительных и заключительных фраз от себя, сразу конспект в формате Markdown.

Расшифровка:
\"\"\"
{text}
\"\"\"""",
    "en": """You are a student's assistant. Below is a transcript of a lecture recording{part}, made by automatic speech recognition, so some words may be misrecognized.

Turn it into detailed lecture notes in English that the student will copy into a notebook:
- {title_rule};
- sections with subheadings, in the order of the lecture;
- key terms in bold, each with a definition;
- keep formulas, dates, names, numbers, examples, classifications and lists;
- use bulleted and numbered lists where they fit;
- short conclusions at the end;
- fix obvious recognition errors from context, but do not add anything that is not in the lecture;
- no introductory or closing remarks of your own, just the notes in Markdown.

Transcript:
\"\"\"
{text}
\"\"\"""",
}
# the pieces of the prompt that depend on the part: (part i of n, first part, later parts)
PROMPT_PARTS = {
    "uk": (" (частина {i} з {n})", "на початку — назва теми лекції заголовком", "продовжуй конспект попередніх частин, без загального заголовка"),
    "ru": (" (часть {i} из {n})", "в начале — название темы лекции заголовком", "продолжай конспект предыдущих частей, без общего заголовка"),
    "en": (" (part {i} of {n})", "start with the topic of the lecture as a heading", "continue the notes of the previous parts, without a common heading"),
}
SUBTITLES = {
    "uk": "{date} · запис {length} · конспект складено DeepSeek за автоматичною розшифровкою",
    "ru": "{date} · запись {length} · конспект составлен DeepSeek по автоматической расшифровке",
    "en": "{date} · recording {length} · notes written by DeepSeek from an automatic transcript",
}


def notes_prompt(language: str, text: str, i: int = 1, n: int = 1) -> str:
    lang = language if language in NOTES_PROMPTS else "uk"
    part, first, later = PROMPT_PARTS[lang]
    return NOTES_PROMPTS[lang].format(part=part.format(i=i, n=n) if n > 1 else "", title_rule=first if i == 1 else later, text=text)


def _safe_name(s: str, limit: int = 60) -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", s).strip().rstrip(".")
    return re.sub(r"\s+", " ", s)[:limit].strip() or "Лекция"


def _fmt_time(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 3600:d}:{sec % 3600 // 60:02d}:{sec % 60:02d}" if sec >= 3600 else f"{sec // 60:d}:{sec % 60:02d}"


def open_path(path: Path) -> None:
    """Opens a file or folder in its Windows program (Word for .docx)."""
    if os.environ.get("AIH_NO_OPEN") == "1":  # automated tests
        log.info("would open %s", path)
        return
    if sys.platform == "win32":
        os.startfile(str(path))  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])  # noqa: S603, S607
    else:
        subprocess.Popen(["xdg-open", str(path)])  # noqa: S603, S607


def read_meta(path: Path) -> dict:
    """meta.json, retried: on Windows it cannot be opened while it is being replaced."""
    for attempt in range(20):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (PermissionError, json.JSONDecodeError):
            if attempt == 19:
                raise
            time.sleep(0.05)
    raise OSError(path)


def split_parts(text: str, limit: int = PART_CHARS) -> list[str]:
    """Splits the transcript into parts of at most `limit` chars, at line or sentence ends."""
    if len(text) <= limit:
        return [text]
    parts, cur = [], ""
    for piece in re.split(r"(?<=[.!?…])\s+|\n", text):
        if cur and len(cur) + len(piece) + 1 > limit:
            parts.append(cur.strip())
            cur = ""
        cur += piece + " "
    if cur.strip():
        parts.append(cur.strip())
    # avoid a tiny last part: merge it into the previous one
    if len(parts) > 1 and len(parts[-1]) < limit * 0.25:
        parts[-2] = f"{parts[-2]} {parts.pop()}"
    return parts


class Lecture:
    def __init__(self, store: "LectureStore", folder: Path, meta: dict):
        self.store = store
        self.folder = folder
        self.id: str = meta["id"]
        self.title: str = meta.get("title") or "Лекция"
        self.created: float = meta.get("created") or time.time()
        self.source: str = meta.get("source") or "record"
        self.language: str = meta.get("language") if meta.get("language") in LANGUAGES else LANGUAGE
        self.state: str = meta.get("state") or "transcribed"
        self.message: str = meta.get("message") or ""
        self.recorded_s: float = float(meta.get("recorded_s") or 0)
        self.transcribed_s: float = float(meta.get("transcribed_s") or 0)
        self.docx: Optional[str] = meta.get("docx")
        self.segments: list[Segment] = []
        self._lock = threading.Condition()
        self._pending = bytearray()
        self._pending_start = 0.0
        self._stopped = False
        self._raw: Any = None  # open audio.wav while recording
        self._worker: Optional[threading.Thread] = None
        self._last_audio = time.monotonic()
        self._auto_stopped = False

    # ---------- persistence ----------

    def meta(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "created": self.created,
            "source": self.source,
            "language": self.language,
            "state": self.state,
            "message": self.message,
            "recorded_s": round(self.recorded_s, 1),
            "transcribed_s": round(self.transcribed_s, 1),
            "docx": self.docx,
        }

    def save_meta(self) -> None:
        tmp = self.folder / f"meta.json.{threading.get_ident()}.tmp"
        tmp.write_text(json.dumps(self.meta(), ensure_ascii=False, indent=1), encoding="utf-8")
        # Windows refuses to replace a file that is being read at that moment: retry briefly
        for attempt in range(20):
            try:
                tmp.replace(self.folder / "meta.json")
                return
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.05)

    def transcript_path(self) -> Path:
        return self.folder / TRANSCRIPT_NAME

    def _write_transcript(self) -> None:
        lines = [f"[{_fmt_time(s.start)}] {s.text}" for s in self.segments]
        self.transcript_path().write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")

    def load_segments(self) -> None:
        p = self.transcript_path()
        if not p.is_file():
            return
        out = []
        for line in p.read_text(encoding="utf-8").splitlines():
            m = re.match(r"\[(\d+):(\d+)(?::(\d+))?\]\s*(.*)", line)
            if not m:
                continue
            a, b, c, text = m.groups()
            sec = int(a) * 3600 + int(b) * 60 + int(c) if c is not None else int(a) * 60 + int(b)
            out.append(Segment(float(sec), float(sec), text))
        self.segments = out

    def recover_lengths(self) -> None:
        """After the bridge was closed mid-recording: lengths from the files, and a valid audio.wav.

        meta.json is not rewritten for every piece of audio, so its lengths can be far behind, and
        audio.wav is left with a header that says it is empty.
        """
        if self.segments:
            self.transcribed_s = max(self.transcribed_s, self.segments[-1].start)
        wav = self.folder / "audio.wav"
        try:
            size = wav.stat().st_size
        except OSError:
            return
        if size <= 44:
            return
        data = (size - 44) // 2 * 2
        self.recorded_s = max(self.recorded_s, data / 2 / SAMPLE_RATE)
        try:
            with open(wav, "r+b") as f:
                head = f.read(44)
                if head[:4] == b"RIFF" and head[36:40] == b"data":
                    f.seek(4)
                    f.write((36 + data).to_bytes(4, "little"))
                    f.seek(40)
                    f.write(data.to_bytes(4, "little"))
        except OSError:
            log.exception("audio.wav header repair failed")

    def text(self) -> str:
        """Transcript for DeepSeek: plain text, a line break at longer pauses."""
        out, prev_end = [], None
        for s in self.segments:
            if prev_end is not None and s.start - prev_end > 2.0:
                out.append("\n")
            out.append(s.text + " ")
            prev_end = s.end
        return "".join(out).strip()

    def status(self, full: bool = False) -> dict:
        d = self.meta()
        d["folder"] = str(self.folder)
        d["engine"] = self.store.engine.status()
        text = self.text()
        d["chars"] = len(text)
        d["text"] = text if full else text[-1500:]
        d["pending_s"] = round(len(self._pending) / 2 / SAMPLE_RATE, 1)
        return d

    def _set(self, **kw: Any) -> None:
        for k, v in kw.items():
            setattr(self, k, v)
        try:
            self.save_meta()
        except OSError:
            log.exception("meta save failed")

    # ---------- live recording ----------

    def start_recording(self) -> None:
        self._raw = wave.open(str(self.folder / "audio.wav"), "wb")
        self._raw.setnchannels(1)
        self._raw.setsampwidth(2)
        self._raw.setframerate(SAMPLE_RATE)
        self._set(state="recording", message="")
        self.store.engine.start_loading()
        self._worker = threading.Thread(target=self._live_loop, name=f"lecture-{self.id}", daemon=True)
        self._worker.start()

    def add_audio(self, pcm: bytes) -> None:
        """16-bit little-endian mono PCM at 16 kHz."""
        if len(pcm) % 2:
            pcm = pcm[:-1]
        with self._lock:
            if self.state != "recording" or self._stopped:
                raise ValueError("Запись этой лекции уже остановлена.")
            self._last_audio = time.monotonic()
            self._raw.writeframes(pcm)
            self._pending.extend(pcm)
            self.recorded_s += len(pcm) / 2 / SAMPLE_RATE
            self._lock.notify_all()

    def stop(self) -> None:
        with self._lock:
            if self._stopped:
                return
            self._stopped = True
            self._lock.notify_all()
        if self.state == "recording":
            self._set(state="transcribing", message="Запись остановлена, распознаю остаток…")

    def _take_chunk(self) -> Optional[tuple[bytes, float]]:
        """Waits for ~30 s of audio (or the end) and returns (pcm, start time)."""
        import numpy as np

        need = int(CHUNK_S * SAMPLE_RATE) * 2
        with self._lock:
            while len(self._pending) < need and not self._stopped:
                self._lock.wait(1.0)
                if not self._stopped and time.monotonic() - self._last_audio > SILENT_STOP_S:
                    log.warning("lecture %s: no audio for %ss, stopping", self.id, SILENT_STOP_S)
                    self._stopped = True
                    self._auto_stopped = True
                    self.state = "transcribing"
                    self.message = "Звук перестал приходить (панель закрыта?). Запись остановлена, распознаю то, что записано…"
            if not self._pending:
                return None
            if len(self._pending) < need:  # the end of the recording
                pcm = bytes(self._pending)
            else:
                # cut in the quietest 0.3 s of the last few seconds, so words are not split
                window = np.frombuffer(bytes(self._pending[:need]), dtype=np.int16).astype(np.float32)
                hop = int(0.1 * SAMPLE_RATE)
                frame = 3 * hop
                lo = len(window) - int(CUT_SEARCH_S * SAMPLE_RATE)
                best, best_at = None, len(window)
                for at in range(lo, len(window) - frame, hop):
                    e = float(np.mean(window[at:at + frame] ** 2))
                    if best is None or e < best:
                        best, best_at = e, at + frame // 2
                pcm = bytes(self._pending[: best_at * 2])
            start = self._pending_start
            del self._pending[: len(pcm)]
            self._pending_start += len(pcm) / 2 / SAMPLE_RATE
            return pcm, start

    def _live_loop(self) -> None:
        import numpy as np

        try:
            while True:
                got = self._take_chunk()
                if got is None:
                    break
                pcm, start = got
                audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
                if len(audio) >= SAMPLE_RATE // 2:
                    prompt = " ".join(s.text for s in self.segments[-6:])
                    segs = self.store.engine.transcribe(audio, offset=start, prompt=prompt, language=self.language)
                    with self._lock:
                        self.segments.extend(segs)
                    self._write_transcript()
                self.transcribed_s = start + len(audio) / SAMPLE_RATE
                if not self._stopped and self.state == "recording" and self.message:
                    self.message = ""
            self._finish_recording()
        except Exception as e:  # noqa: BLE001
            log.exception("live transcription failed")
            self._close_audio()
            self._set(state="error", message=f"Распознавание остановилось: {e}")

    def _close_audio(self) -> None:
        with self._lock:
            if self._raw is not None:
                try:
                    self._raw.close()
                except Exception:  # noqa: BLE001
                    pass
                self._raw = None

    def _finish_recording(self) -> None:
        self._close_audio()
        n = len(self.text())
        why = "Звук перестал приходить (панель была закрыта?), запись остановлена сама. " if self._auto_stopped else ""
        if n:
            self._set(state="transcribed", message=f"{why}Текст лекции готов ({n} символов). Можно делать конспект.")
        else:
            self._set(state="error", message="В записи не распознано речи. Проверьте, что выбран источник со звуком лекции.")

    # ---------- an uploaded file ----------

    def transcribe_file(self, path: Path) -> None:
        self._set(state="transcribing", message="Читаю аудиофайл…")
        threading.Thread(target=self._file_thread, args=(path,), name=f"lecture-file-{self.id}", daemon=True).start()

    def _file_thread(self, path: Path) -> None:
        try:
            from .transcriber import decode_file

            audio = decode_file(str(path))
            self._set(recorded_s=len(audio) / SAMPLE_RATE, message="Распознаю речь…")
            # by pieces: progress is visible and the transcript is saved as it grows
            step = int(10 * 60 * SAMPLE_RATE)
            for at in range(0, len(audio), step):
                piece = audio[at:at + step]
                prompt = " ".join(s.text for s in self.segments[-6:])

                def progress(t: float) -> None:
                    self.transcribed_s = t

                segs = self.store.engine.transcribe(piece, offset=at / SAMPLE_RATE, prompt=prompt, progress=progress, language=self.language)
                self.segments.extend(segs)
                self.transcribed_s = (at + len(piece)) / SAMPLE_RATE
                self._write_transcript()
                self.save_meta()
            self._finish_recording()
        except Exception as e:  # noqa: BLE001
            log.exception("file transcription failed")
            self._set(state="error", message=f"Не удалось распознать файл: {e}")

    # ---------- notes through DeepSeek ----------

    def summarize(self, ask: Callable[..., dict], open_when_done: bool = True) -> None:
        if self.state in ("recording", "transcribing", "summarizing"):
            raise ValueError("Сначала дождитесь, пока текст лекции будет готов.")
        if not self.segments:
            self.load_segments()
        if not self.text():
            raise ValueError("Текст лекции пуст: конспект делать не из чего.")
        prev = self.state
        self._set(state="summarizing", message="Отправляю текст лекции в DeepSeek…")
        threading.Thread(target=self._summarize_thread, args=(ask, open_when_done, prev), name=f"notes-{self.id}", daemon=True).start()

    def _summarize_thread(self, ask: Callable[..., dict], open_when_done: bool, prev: str) -> None:
        from .notes_docx import notes_to_docx

        try:
            parts = split_parts(self.text())
            html_parts, text_parts = [], []
            for i, part in enumerate(parts, 1):
                n = len(parts)
                self._set(message=f"DeepSeek пишет конспект{f' (часть {i} из {n})' if n > 1 else ''}…")
                prompt = notes_prompt(self.language, part, i, n)
                r = ask(prompt, new_chat=True, timeout=600, html=True, settle=12.0)
                html_parts.append(r.get("html") or "")
                text_parts.append(r.get("text") or "")
            name = f"Конспект — {_safe_name(self.title)}.docx"
            path = self.folder / name
            date = datetime.fromtimestamp(self.created).strftime("%d.%m.%Y")
            subtitle = SUBTITLES.get(self.language, SUBTITLES["uk"]).format(date=date, length=_fmt_time(self.recorded_s))
            notes_to_docx(path, self.title, subtitle, html="".join(html_parts), markdown="\n\n".join(text_parts))
            (self.folder / "конспект.md").write_text("\n\n".join(text_parts), encoding="utf-8")
            self._set(state="done", docx=name, message="Конспект готов.")
            if open_when_done:
                try:
                    open_path(path)
                except OSError:
                    log.exception("open docx failed")
        except Exception as e:  # noqa: BLE001
            log.warning("notes failed: %s", e)
            msg = getattr(e, "message", None) or str(e)
            self._set(state=prev if prev in ("transcribed", "done") else "transcribed", message=f"Конспект не сделан: {msg}")


class LectureStore:
    def __init__(self, root: Path, engine: Optional[Engine] = None):
        self.root = root
        self.engine = engine or Engine()
        self._lectures: dict[str, Lecture] = {}
        self._lock = threading.Lock()
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        if not self.root.is_dir():
            return
        for meta_file in self.root.glob("*/meta.json"):
            try:
                meta = read_meta(meta_file)
                lec = Lecture(self, meta_file.parent, meta)
            except (OSError, ValueError, KeyError):
                continue
            if lec.state in ("recording", "transcribing", "summarizing"):
                # the bridge was closed in the middle: keep what was transcribed
                lec.load_segments()
                lec.recover_lengths()
                lec.state = "transcribed" if lec.segments else "error"
                lec.message = "Bridge был закрыт во время работы. Сохранено то, что успело распознаться."
                lec.save_meta()
            elif lec.source == "record" and lec.recorded_s < 1 and (lec.folder / "audio.wav").is_file():
                # recovered by an older version, which left the lengths at zero
                lec.load_segments()
                lec.recover_lengths()
                lec.save_meta()
            self._lectures[lec.id] = lec

    def _new_folder(self, title: str) -> tuple[str, Path]:
        now = datetime.now()
        lid = now.strftime("%Y%m%d-%H%M%S")
        while lid in self._lectures:
            lid += "x"
        folder = self.root / f"{now.strftime('%Y-%m-%d %H-%M')} {_safe_name(title)}"
        k = 2
        while folder.exists():
            folder = folder.with_name(f"{folder.name} ({k})")
            k += 1
        folder.mkdir(parents=True)
        return lid, folder

    def create(self, title: str, source: str = "record", language: str = "") -> Lecture:
        language = (language or LANGUAGE).strip().lower()
        if language not in LANGUAGES:
            raise ValueError(f"Язык не поддерживается: {language}. Можно: {', '.join(LANGUAGES)}.")
        with self._lock:
            self._load()
            title = (title or "").strip() or f"Лекция {datetime.now().strftime('%d.%m.%Y %H:%M')}"
            lid, folder = self._new_folder(title)
            lec = Lecture(self, folder, {"id": lid, "title": title, "created": time.time(), "source": source, "language": language, "state": "new"})
            self._lectures[lid] = lec
            lec.save_meta()
            return lec

    def start_recording(self, title: str, language: str = "") -> Lecture:
        lec = self.create(title, language=language)
        lec.start_recording()
        return lec

    def from_file(self, title: str, filename: str, read: Callable[[Any], None], language: str = "") -> Lecture:
        """`read(f)` writes the uploaded bytes into the open file f."""
        lec = self.create(title or Path(filename).stem, source="file", language=language)
        ext = Path(filename).suffix.lower()[:8] or ".audio"
        path = lec.folder / f"audio{ext}"
        with open(path, "wb") as f:
            read(f)
        self.engine.start_loading()
        lec.transcribe_file(path)
        return lec

    def get(self, lid: str) -> Lecture:
        with self._lock:
            self._load()
            lec = self._lectures.get(lid)
        if not lec:
            raise KeyError(lid)
        if not lec.segments and lec.state not in ("recording", "new"):
            lec.load_segments()
        return lec

    def list(self, limit: int = 30) -> list[dict]:
        with self._lock:
            self._load()
            items = sorted(self._lectures.values(), key=lambda x: x.created, reverse=True)[:limit]
        return [dict(x.meta(), folder=str(x.folder)) for x in items]
