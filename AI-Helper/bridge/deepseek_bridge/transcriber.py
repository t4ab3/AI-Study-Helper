"""Speech to text for lecture notes: faster-whisper running on this computer.

The model is loaded on first use, in a background thread (the first time it is downloaded from
Hugging Face, ~1.6 GB for large-v3-turbo). The NVIDIA GPU is used when its libraries load,
otherwise the CPU with a smaller model.

The language is chosen per lecture (uk / ru / en); AIH_LANGUAGE only sets the default.
Settings (environment): AIH_WHISPER_MODEL, AIH_WHISPER_DEVICE (cuda / cpu), AIH_LANGUAGE (uk).
"""

from __future__ import annotations

import logging
import os
import re
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("deepseek_bridge.transcriber")

SAMPLE_RATE = 16_000
# languages offered in the panel: code -> name shown there
LANGUAGES = {"uk": "Українська", "ru": "Русский", "en": "English"}
LANGUAGE = os.environ.get("AIH_LANGUAGE", "uk").strip().lower()
if LANGUAGE not in LANGUAGES:
    LANGUAGE = "uk"
GPU_MODEL = os.environ.get("AIH_WHISPER_MODEL", "large-v3-turbo")
CPU_MODEL = os.environ.get("AIH_WHISPER_MODEL", "small")
DEVICE = os.environ.get("AIH_WHISPER_DEVICE", "auto")

# Whisper invents these on silence or music (trained on subtitled videos)
HALLUCINATIONS = re.compile(
    r"(субтитр|дякую за перегляд|спасибо за просмотр|продовження сл[іе]дує|підписуйтесь на канал|"
    r"подписывайтесь на канал|редактор субтитр|амара|amara\.org|thanks for watching|ставте лайк)",
    re.IGNORECASE,
)


@dataclass
class Segment:
    start: float
    end: float
    text: str


def _add_cuda_dll_dirs() -> None:
    """pip's nvidia-cublas-cu12 / nvidia-cudnn-cu12 put their DLLs in site-packages/nvidia/*/bin."""
    if sys.platform != "win32":
        return
    for base in map(Path, sys.path):
        nv = base / "nvidia"
        if not nv.is_dir():
            continue
        for bin_dir in nv.glob("*/bin"):
            try:
                os.add_dll_directory(str(bin_dir))
            except OSError:
                continue
            os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"


def decode_file(path: str) -> Any:
    """Any audio/video file → float32 mono 16 kHz numpy array (PyAV, which ships its own FFmpeg).

    faster_whisper.decode_audio is not used: it passes an argument that newer PyAV removed.
    """
    import av
    import numpy as np

    pieces = []
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    with av.open(path, mode="r") as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise ValueError("В файле нет звуковой дорожки.")
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                pieces.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):  # flush
            pieces.append(out.to_ndarray().reshape(-1))
    if not pieces:
        raise ValueError("Не удалось прочитать звук из файла.")
    return np.concatenate(pieces).astype(np.float32) / 32768.0


class Engine:
    """One shared Whisper model. States: idle → loading → ready | error."""

    def __init__(self, factory: Optional[Callable[[], tuple[Any, str, str]]] = None):
        self._factory = factory or self._load
        self._model: Any = None
        self._lock = threading.Lock()  # one transcription at a time on the GPU
        self._load_lock = threading.Lock()
        self.state = "idle"
        self.device = ""
        self.model_name = ""
        self.message = "Модель распознавания ещё не загружена."
        self._ready = threading.Event()

    # ---------- loading ----------

    def _load(self) -> tuple[Any, str, str]:
        _add_cuda_dll_dirs()
        from faster_whisper import WhisperModel  # heavy import, only when needed

        errors = []
        if DEVICE in ("auto", "cuda"):
            try:
                self.message = f"Загружаю модель {GPU_MODEL} на видеокарту (первый раз она скачивается, ~1,6 ГБ)…"
                model = WhisperModel(GPU_MODEL, device="cuda", compute_type="float16")
                # a tiny run makes missing cuBLAS / cuDNN fail now, not in the middle of a lecture
                import numpy as np

                list(model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language=LANGUAGE)[0])
                return model, "cuda", GPU_MODEL
            except Exception as e:  # noqa: BLE001
                errors.append(f"видеокарта: {e}")
                log.warning("GPU model failed, falling back to CPU: %s", e)
                if DEVICE == "cuda":
                    raise
        self.message = f"Загружаю модель {CPU_MODEL} на процессор (первый раз она скачивается)…"
        model = WhisperModel(CPU_MODEL, device="cpu", compute_type="int8", cpu_threads=max(2, (os.cpu_count() or 4) - 2))
        if errors:
            log.info("using CPU: %s", "; ".join(errors))
        return model, "cpu", CPU_MODEL

    def start_loading(self) -> None:
        """Loads the model in the background (no-op if loading or loaded)."""
        with self._load_lock:
            if self.state in ("loading", "ready"):
                return
            self.state = "loading"
            self.message = "Загружаю модель распознавания…"
        threading.Thread(target=self._load_thread, name="whisper-load", daemon=True).start()

    def _load_thread(self) -> None:
        try:
            model, device, name = self._factory()
            self._model, self.device, self.model_name = model, device, name
            self.state = "ready"
            where = "на видеокарте" if device == "cuda" else "на процессоре (медленнее, видеокарта недоступна)"
            self.message = f"Распознавание готово: {name} {where}."
            log.info("whisper ready: %s on %s", name, device)
        except Exception as e:  # noqa: BLE001
            log.exception("whisper load failed")
            self.state = "error"
            self.message = f"Не удалось загрузить модель распознавания: {e}"
        finally:
            self._ready.set()

    def wait_ready(self, timeout: Optional[float] = None) -> bool:
        self.start_loading()
        self._ready.wait(timeout)
        return self.state == "ready"

    def status(self) -> dict:
        return {"state": self.state, "device": self.device, "model": self.model_name, "message": self.message, "language": LANGUAGE, "languages": LANGUAGES}

    # ---------- transcription ----------

    def transcribe(
        self,
        audio: Any,
        offset: float = 0.0,
        prompt: str = "",
        progress: Optional[Callable[[float], None]] = None,
        language: Optional[str] = None,
    ) -> list[Segment]:
        """audio: float32 mono 16 kHz numpy array. Times in the result are shifted by `offset`."""
        if not self.wait_ready():
            raise RuntimeError(self.message)
        with self._lock:
            segments, _info = self._model.transcribe(
                audio,
                language=language or LANGUAGE,
                beam_size=5,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
                initial_prompt=prompt[-300:] or None,
                condition_on_previous_text=False,
            )
            out: list[Segment] = []
            for s in segments:
                text = (s.text or "").strip()
                if not text or HALLUCINATIONS.search(text):
                    continue
                if getattr(s, "no_speech_prob", 0) > 0.6 and getattr(s, "avg_logprob", 0) < -1.0:
                    continue
                out.append(Segment(offset + s.start, offset + s.end, text))
                if progress:
                    progress(offset + s.end)
            return out
