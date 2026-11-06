"""Lecture notes without a real speech model: a fake engine stands in for Whisper."""

from __future__ import annotations

import json
import math
import struct
import threading
import time
import urllib.request

import pytest

from deepseek_bridge import lecture as lec_mod
from deepseek_bridge.browser_manager import DeepSeekBrowserManager
from deepseek_bridge.config import CLIENT_HEADER, CLIENT_HEADER_VALUE
from deepseek_bridge.lecture import LectureStore, split_parts
from deepseek_bridge.notes_docx import notes_to_docx, parse_html
from deepseek_bridge.server import make_server
from deepseek_bridge.transcriber import SAMPLE_RATE, Engine, Segment


class FakeModel:
    """Says "слово<N>" for every second of non-silent audio it gets."""

    def __init__(self) -> None:
        self.calls: list[float] = []
        self.languages: list[str] = []

    def transcribe(self, audio, **kw):
        dur = len(audio) / SAMPLE_RATE
        self.calls.append(dur)
        self.languages.append(kw.get("language"))

        class S:
            def __init__(self, i):
                self.start, self.end, self.text = float(i), float(i) + 1, f" слово{len(fake_words)}"
                fake_words.append(1)
                self.no_speech_prob, self.avg_logprob = 0.0, -0.1

        loud = [i for i in range(int(dur)) if max(abs(x) for x in audio[i * SAMPLE_RATE:(i + 1) * SAMPLE_RATE:400]) > 0.05]
        return iter([S(i) for i in loud]), None


fake_words: list[int] = []


@pytest.fixture
def store(tmp_path):
    fake_words.clear()
    model = FakeModel()
    engine = Engine(factory=lambda: (model, "cpu", "fake"))
    s = LectureStore(tmp_path / "notes", engine)
    s.model = model  # type: ignore[attr-defined]
    return s


def tone(seconds: float, loud: bool = True) -> bytes:
    n = int(seconds * SAMPLE_RATE)
    amp = 8000 if loud else 0
    return struct.pack(f"<{n}h", *(int(amp * math.sin(i / 8)) for i in range(n)))


def wait_for(cond, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


def test_live_recording_is_transcribed_in_pieces(store):
    lec = store.start_recording("Физика")
    # 70 s of sound, sent in 2 s pieces like the panel does
    for _ in range(35):
        lec.add_audio(tone(2))
    assert wait_for(lambda: len(store.model.calls) >= 2)  # the first pieces are done while still recording
    assert lec.state == "recording"
    lec.stop()
    assert wait_for(lambda: lec.state == "transcribed")
    assert sum(store.model.calls) == pytest.approx(70, abs=0.1)  # nothing lost or doubled at the cuts
    assert all(c <= lec_mod.CHUNK_S + 0.01 for c in store.model.calls)
    assert lec.recorded_s == pytest.approx(70, abs=0.1)
    assert (lec.folder / "audio.wav").stat().st_size > 70 * SAMPLE_RATE * 2
    assert lec.transcript_path().read_text(encoding="utf-8").count("слово") == len(lec.segments) > 0
    meta = json.loads((lec.folder / "meta.json").read_text(encoding="utf-8"))
    assert meta["state"] == "transcribed" and meta["title"] == "Физика"


def test_pieces_are_cut_in_a_pause(store):
    lec = store.start_recording("")
    # speech 27 s, pause 1 s, speech 10 s: the first cut must land in the pause, not at 30 s
    lec.add_audio(tone(27) + tone(1, loud=False) + tone(10))
    assert wait_for(lambda: len(store.model.calls) >= 1)
    assert 27.0 <= store.model.calls[0] <= 28.0
    lec.stop()
    assert wait_for(lambda: lec.state == "transcribed")


def test_silence_only_is_an_error_not_empty_notes(store):
    lec = store.start_recording("")
    lec.add_audio(tone(5, loud=False))
    lec.stop()
    assert wait_for(lambda: lec.state == "error")
    assert "не распознано речи" in lec.message


def test_recording_stops_when_audio_stops_coming(store, monkeypatch):
    monkeypatch.setattr(lec_mod, "SILENT_STOP_S", 0.5)
    lec = store.start_recording("")
    lec.add_audio(tone(3))
    assert wait_for(lambda: lec.state == "transcribed", 5)
    assert "перестал приходить" in lec.message
    with pytest.raises(ValueError):
        lec.add_audio(tone(1))  # a late piece is refused, not appended to a finished lecture


def test_notes_go_to_deepseek_and_into_word(store):
    lec = store.start_recording("Хімія")
    lec.add_audio(tone(4))
    lec.stop()
    assert wait_for(lambda: lec.state == "transcribed")
    asked = []

    def ask(prompt, **kw):
        asked.append((prompt, kw))
        return {"text": "# Тема", "html": "<h1>Тема</h1><p>Текст <strong>термін</strong></p><ul><li>пункт</li></ul>"}

    lec.summarize(ask, open_when_done=False)
    assert wait_for(lambda: lec.state == "done")
    prompt, kw = asked[0]
    assert "слово" in prompt and "конспект" in prompt
    assert kw["new_chat"] is True and kw["html"] is True
    from docx import Document

    doc = Document(str(lec.folder / lec.docx))
    texts = [(p.style.name, p.text) for p in doc.paragraphs]
    assert texts[0] == ("Title", "Хімія")
    assert ("Heading 1", "Тема") in texts and ("List Bullet", "пункт") in texts


def test_failed_notes_keep_the_transcript(store):
    lec = store.start_recording("")
    lec.add_audio(tone(3))
    lec.stop()
    assert wait_for(lambda: lec.state == "transcribed")

    def ask(prompt, **kw):
        raise RuntimeError("Войдите в DeepSeek")

    lec.summarize(ask, open_when_done=False)
    assert wait_for(lambda: lec.state != "summarizing")
    assert lec.state == "transcribed" and "Войдите в DeepSeek" in lec.message


def test_interrupted_lecture_is_recovered_after_restart(store, tmp_path):
    lec = store.start_recording("Обрив")
    lec.add_audio(tone(3))
    lec.stop()
    assert wait_for(lambda: lec.state == "transcribed")
    lec._worker.join(5)  # its last meta.json write must not land after ours
    lec._set(state="recording")  # as if the bridge died while recording
    again = LectureStore(store.root, store.engine)
    got = again.get(lec.id)
    assert got.state == "transcribed" and got.segments and "закрыт во время работы" in got.message


def test_split_parts_keeps_everything():
    text = " ".join(f"Речення номер {i}." for i in range(5000))
    parts = split_parts(text, 20_000)
    assert len(parts) > 1 and all(len(p) <= 20_000 + 100 for p in parts)
    assert " ".join(parts).split() == text.split()
    assert split_parts("коротко") == ["коротко"]


def test_html_from_deepseek_to_blocks(tmp_path):
    html = (
        '<div class="md-code-block"><div class="md-code-block-banner"><span>python</span><div role="button">Copy</div></div>'
        "<pre>x = 1</pre></div>"
        "<h2>Розділ</h2><ol><li><p>перший <em>курсив</em></p><ul><li>вкладений</li></ul></li><li>другий</li></ol>"
        '<p>Формула <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow>'
        '<annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span>'
        '<span class="katex-html" aria-hidden="true">E=mc2</span></span> кінець</p>'
        "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>"
    )
    items = parse_html(html)
    texts = [getattr(i, "text", lambda: "table")() for i in items]
    assert texts[0] == "x = 1"  # code kept, "Copy" button dropped
    assert "Copy" not in " ".join(texts)
    assert texts[1] == "Розділ"
    assert [(i.kind, i.level, i.ordered) for i in items[2:5]] == [("li", 1, True), ("li", 2, False), ("li", 1, True)]
    assert "E=mc^2" in texts[5] and "mc2" not in texts[5]
    assert texts[6] == "table"
    out = tmp_path / "n.docx"
    assert notes_to_docx(out, "T", "sub", html=html) == len(items)
    from docx import Document

    d = Document(str(out))
    styles = [p.style.name for p in d.paragraphs]
    assert "List Number" in styles and "List Bullet 2" in styles
    assert [[c.text for c in r.cells] for r in d.tables[0].rows] == [["A", "B"], ["1", "2"]]


def test_markdown_fallback(tmp_path):
    out = tmp_path / "m.docx"
    notes_to_docx(out, "T", "", markdown="# Тема\n\n- **термін** — означення\n1. крок\n")
    from docx import Document

    d = Document(str(out))
    assert [(p.style.name, p.text) for p in d.paragraphs][1:] == [("Heading 1", "Тема"), ("List Bullet", "термін — означення"), ("List Number", "крок")]
    assert d.paragraphs[2].runs[0].bold


def test_http_api(store):
    srv = make_server(DeepSeekBrowserManager(driver_factory=lambda p: None), "127.0.0.1", 0, lectures=store)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    H = {CLIENT_HEADER: CLIENT_HEADER_VALUE}

    def call(path, body=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        headers = dict(H, **({"Content-Type": "application/octet-stream"} if raw is not None else {"Content-Type": "application/json"}))
        req = urllib.request.Request(base + path, data=data, headers=headers, method="POST" if data is not None else "GET")
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    try:
        lec = call("/lecture/start", {"title": "Тест"})
        assert lec["state"] == "recording"
        r = call(f"/lecture/{lec['id']}/audio", raw=tone(3))
        assert r["recorded_s"] == pytest.approx(3, abs=0.01)
        call(f"/lecture/{lec['id']}/stop", {})
        assert wait_for(lambda: call(f"/lecture/{lec['id']}")["state"] == "transcribed")
        full = call(f"/lecture/{lec['id']}?full=1")
        assert "слово" in full["text"]
        assert call("/lectures")["lectures"][0]["id"] == lec["id"]
        assert lec["language"] == "uk"  # the default
        en = call("/lecture/start", {"title": "Eng", "language": "en"})
        assert en["language"] == "en"
        call(f"/lecture/{en['id']}/stop", {})
        assert call("/lecture/engine")["languages"] == {"uk": "Українська", "ru": "Русский", "en": "English"}
        with pytest.raises(urllib.error.HTTPError) as e:
            call("/lecture/start", {"language": "de"})
        assert e.value.code == 409
        with pytest.raises(urllib.error.HTTPError) as e:
            call("/lecture/upload?name=a.wav&language=de", raw=b"x")
        assert e.value.code == 400
        with pytest.raises(urllib.error.HTTPError) as e:
            call(f"/lecture/{lec['id']}/audio", raw=tone(1))
        assert e.value.code == 409  # recording already stopped
        with pytest.raises(urllib.error.HTTPError) as e:
            call("/lecture/nope")
        assert e.value.code == 404
    finally:
        srv.shutdown()
        srv.server_close()


def test_uploaded_file_is_decoded_and_transcribed(store, tmp_path):
    import wave

    src = tmp_path / "лекція.wav"
    with wave.open(str(src), "wb") as w:  # 44.1 kHz stereo: must come out as 16 kHz mono
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(44100)
        n = 44100 * 5
        w.writeframes(struct.pack(f"<{2 * n}h", *(int(8000 * math.sin(i // 2 / 8)) for i in range(2 * n))))
    data = src.read_bytes()
    lec = store.from_file("", src.name, lambda f: f.write(data))
    assert wait_for(lambda: lec.state in ("transcribed", "error"))
    assert lec.state == "transcribed", lec.message
    assert lec.recorded_s == pytest.approx(5, abs=0.05)
    assert lec.title == "лекція" and lec.source == "file"


@pytest.mark.parametrize("language,marker", [("uk", "Розшифровка:"), ("ru", "Расшифровка:"), ("en", "Transcript:")])
def test_language_goes_to_whisper_and_to_the_notes_prompt(store, language, marker):
    lec = store.start_recording("Lang", language)
    lec.add_audio(tone(3))
    lec.stop()
    assert wait_for(lambda: lec.state == "transcribed")
    assert store.model.languages and set(store.model.languages) == {language}
    asked = []
    lec.summarize(lambda prompt, **kw: asked.append(prompt) or {"text": "# T", "html": "<h1>T</h1>"}, open_when_done=False)
    assert wait_for(lambda: lec.state == "done")
    assert marker in asked[0] and "слово" in asked[0]
    # kept in meta.json: a restarted bridge still knows the language
    again = LectureStore(store.root, store.engine).get(lec.id)
    assert again.language == language


def test_unknown_language_is_refused(store):
    with pytest.raises(ValueError):
        store.start_recording("x", "de")


def test_long_lecture_parts_are_numbered_in_its_language():
    from deepseek_bridge.lecture import notes_prompt

    assert "(part 2 of 3)" in notes_prompt("en", "text", 2, 3)
    assert "(часть 1 из 2)" in notes_prompt("ru", "text", 1, 2)
    assert "частина" not in notes_prompt("uk", "text")
