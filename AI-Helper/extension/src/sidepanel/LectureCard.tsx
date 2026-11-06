import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BridgeError,
  LECTURE_LANGUAGES,
  lectures,
  type EngineStatus,
  type LectureInfo,
  type LectureLanguage,
  type LectureStatus,
} from './bridge';
import { NoAudioError, Recorder } from './recorder';
import { errorMessage, log } from '../shared/logger';

const CURRENT_KEY = 'lectureCurrent';
const LANGUAGE_KEY = 'lectureLanguage';

function langName(code: string | undefined): string {
  return LECTURE_LANGUAGES.find((l) => l.code === code)?.name ?? '';
}

function isLanguage(v: unknown): v is LectureLanguage {
  return LECTURE_LANGUAGES.some((l) => l.code === v);
}

const STATE_TEXT: Record<LectureInfo['state'], string> = {
  new: 'Новая',
  recording: 'Идёт запись',
  transcribing: 'Распознаю',
  transcribed: 'Текст готов',
  summarizing: 'DeepSeek пишет конспект',
  done: 'Конспект готов',
  error: 'Ошибка',
};

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

function busyState(s: LectureInfo['state'] | undefined): boolean {
  return s === 'recording' || s === 'transcribing' || s === 'summarizing' || s === 'new';
}

export function LectureCard(props: { bridgeOnline: boolean | null; flash: (msg: string) => void }) {
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<LectureLanguage>('uk');
  /** the user picked a language: the bridge default does not override it */
  const languageChosen = useRef(false);
  const [current, setCurrent] = useState<LectureStatus | null>(null);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [history, setHistory] = useState<LectureInfo[]>([]);
  const [folder, setFolder] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const recRef = useRef<Recorder | null>(null);
  /** the lecture being recorded (refs: the recorder's callbacks outlive renders) */
  const idRef = useRef<string | null>(null);
  const queue = useRef<ArrayBuffer[]>([]);
  const sending = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { flash } = props;

  const select = useCallback(async (id: string | null) => {
    if (!id) {
      setCurrent(null);
      chrome.storage.local.remove(CURRENT_KEY).catch(() => undefined);
      return;
    }
    chrome.storage.local.set({ [CURRENT_KEY]: id }).catch(() => undefined);
    try {
      setCurrent(await lectures.get(id));
    } catch (e) {
      if (e instanceof BridgeError && e.code === 'no_lecture') {
        setCurrent(null);
        chrome.storage.local.remove(CURRENT_KEY).catch(() => undefined);
      }
    }
  }, []);

  const refreshHistory = useCallback(() => {
    lectures
      .list()
      .then((r) => {
        setHistory(r.lectures);
        setFolder(r.folder);
      })
      .catch(() => undefined);
  }, []);

  // the language chosen last time
  useEffect(() => {
    chrome.storage.local
      .get(LANGUAGE_KEY)
      .then((v) => {
        if (isLanguage(v[LANGUAGE_KEY])) {
          languageChosen.current = true;
          setLanguage(v[LANGUAGE_KEY]);
        }
      })
      .catch(() => undefined);
  }, []);

  const chooseLanguage = (code: LectureLanguage) => {
    languageChosen.current = true;
    setLanguage(code);
    chrome.storage.local.set({ [LANGUAGE_KEY]: code }).catch(() => undefined);
  };

  // first load: the lecture shown last time, the history and the engine state
  useEffect(() => {
    if (!props.bridgeOnline) return;
    chrome.storage.local
      .get(CURRENT_KEY)
      .then((v) => (v[CURRENT_KEY] ? select(v[CURRENT_KEY] as string) : undefined))
      .catch(() => undefined);
    refreshHistory();
    lectures
      .engine()
      .then((e) => {
        setEngine(e);
        // nothing chosen yet: start from the bridge default (AIH_LANGUAGE)
        if (!languageChosen.current && isLanguage(e.language)) setLanguage(e.language);
      })
      .catch(() => undefined);
  }, [props.bridgeOnline, select, refreshHistory]);

  // poll the current lecture while something is happening
  const currentId = current?.id;
  const currentState = current?.state;
  useEffect(() => {
    if (!currentId || (!busyState(currentState) && !recording)) return;
    const t = setInterval(() => {
      lectures
        .get(currentId)
        .then((st) => {
          setCurrent(st);
          setEngine(st.engine);
          if (!busyState(st.state)) refreshHistory();
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [currentId, currentState, recording, refreshHistory]);

  // ---------- sending audio, in order, with retries if the bridge hiccups ----------

  const pump = useCallback(async (id: string) => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (queue.current.length) {
        try {
          await lectures.audio(id, queue.current[0]);
          queue.current.shift();
        } catch (e) {
          if (e instanceof BridgeError && e.code === 'bad_state') {
            queue.current = [];
            break;
          }
          // keep the audio and try again shortly (at most ~2 min of backlog)
          if (queue.current.length > 60) queue.current.shift();
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    } finally {
      sending.current = false;
    }
  }, []);

  const stopRecording = useCallback(
    async (why?: string) => {
      const rec = recRef.current;
      recRef.current = null;
      rec?.stop();
      setRecording(false);
      setLevel(0);
      const id = idRef.current;
      if (!id) return;
      // the last pieces first, then "stop"
      for (let i = 0; i < 20 && (queue.current.length || sending.current); i++) {
        await pump(id);
        await new Promise((r) => setTimeout(r, 200));
      }
      try {
        setCurrent(await lectures.stop(id));
        if (why) flash(why);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [pump, flash],
  );

  const startRecording = async () => {
    setError(null);
    queue.current = [];
    idRef.current = null;
    const rec = new Recorder({
      onChunk: (pcm) => {
        queue.current.push(pcm);
        if (idRef.current) pump(idRef.current);
      },
      onLevel: (l) => setLevel(l),
      onEnded: () => stopRecording('Показ звука остановлен в Chrome: запись завершена.'),
    });
    try {
      await rec.start(); // Chrome's picker: must come first, straight from the click
    } catch (e) {
      if (e instanceof NoAudioError) setError(e.message);
      else if ((e as Error).name !== 'NotAllowedError') setError(errorMessage(e));
      return;
    }
    try {
      const lec = await lectures.start(title, language);
      idRef.current = lec.id;
      recRef.current = rec;
      pump(lec.id);
      setRecording(true);
      setCurrent(lec);
      chrome.storage.local.set({ [CURRENT_KEY]: lec.id }).catch(() => undefined);
      log('info', 'lecture', `recording ${lec.id} (${language}) from ${rec.surface} «${rec.label}»`);
      refreshHistory();
    } catch (e) {
      rec.stop();
      setError(errorMessage(e));
    }
  };

  // recording dies with the panel: warn before closing it
  useEffect(() => {
    if (!recording) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [recording]);

  const upload = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const lec = await lectures.upload(file, title || file.name.replace(/\.[^.]+$/, ''), language);
      setCurrent(lec);
      chrome.storage.local.set({ [CURRENT_KEY]: lec.id }).catch(() => undefined);
      refreshHistory();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const summarize = async () => {
    if (!current) return;
    setError(null);
    try {
      setCurrent(await lectures.summarize(current.id, true));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const openFile = (what: 'docx' | 'folder' | 'transcript') => {
    if (!current) return;
    lectures.open(current.id, what).catch((e) => setError(errorMessage(e)));
  };

  // ---------- view ----------

  if (props.bridgeOnline === false) {
    return (
      <section className="card" data-testid="lecture-card">
        <div className="card-head">
          <span className="step auto-icon">✎</span>
          <h2>Конспект лекции</h2>
        </div>
        <div className="banner warn">Bridge не запущен. Запустите bridge\start_bridge.bat: он распознаёт речь и пишет конспект через DeepSeek.</div>
      </section>
    );
  }

  const st = current?.state;
  const canNotes = st === 'transcribed' || st === 'done' || (st === 'error' && (current?.chars ?? 0) > 0);
  const lag = current && recording ? current.recorded_s - current.transcribed_s : 0;
  const engineNote = engine && engine.state !== 'ready' && (recording || busyState(st)) ? engine.message : null;

  return (
    <section className="card auto" data-testid="lecture-card">
      <div className="card-head">
        <span className="step auto-icon">✎</span>
        <h2>Конспект лекции</h2>
        {current && (
          <span className={`phase p-${st === 'error' ? 'error' : st === 'done' ? 'finished' : busyState(st) ? 'running' : 'idle'}`} data-testid="lecture-state">
            {STATE_TEXT[current.state]}
          </span>
        )}
      </div>

      {!recording && !busyState(st) && (
        <>
          <div className="row lecture-setup">
            <input
              className="text-input"
              placeholder="Название лекции (необязательно)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="lecture-title"
            />
            <select
              className="text-input lang-select"
              value={language}
              onChange={(e) => chooseLanguage(e.target.value as LectureLanguage)}
              title="Язык лекции: на нём распознаётся речь и пишется конспект"
              data-testid="lecture-language"
            >
              {LECTURE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <button className="btn primary" onClick={startRecording} data-testid="btn-lecture-record">
              ● Начать запись
            </button>
            <button className="btn" onClick={() => fileRef.current?.click()} disabled={uploading} data-testid="btn-lecture-file">
              {uploading ? 'Загружаю файл…' : 'Готовый аудиофайл…'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,video/*,.m4a,.mp3,.wav,.ogg,.opus,.webm,.mp4,.mkv"
              style={{ display: 'none' }}
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
              data-testid="lecture-file-input"
            />
          </div>
          <p className="hint">
            Выберите язык, на котором читают лекцию: на нём распознаётся речь и пишется конспект. Chrome спросит, что записывать. Лекция в браузере: вкладка с ней и «Поделиться звуком вкладки». Zoom, Teams и другие
            программы: «Весь экран» и «Поделиться системным звуком».
          </p>
        </>
      )}

      {recording && (
        <div className="rec-box" data-testid="lecture-recording">
          <div className="row" style={{ alignItems: 'center' }}>
            <span className="rec-dot" />
            <b data-testid="lecture-recorded">{fmtTime(current?.recorded_s ?? 0)}</b>
            {current?.language && <span className="lang-tag">{current.language.toUpperCase()}</span>}
            <div className="level" title="Уровень звука">
              <div style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
            <button className="btn danger" onClick={() => stopRecording()} data-testid="btn-lecture-stop">
              Остановить запись
            </button>
          </div>
          <p className="hint" style={{ marginTop: 6 }}>
            Распознано: {fmtTime(current?.transcribed_s ?? 0)}
            {lag > 45 ? ` (отстаёт на ${fmtTime(lag)}, догонит после остановки)` : ''}. Не закрывайте эту панель до конца
            записи.
          </p>
        </div>
      )}

      {engineNote && <div className="banner info">{engineNote}</div>}
      {error && (
        <div className="banner err" data-testid="lecture-error">
          {error}
        </div>
      )}
      {current?.message && !recording && (
        <div className={`banner ${st === 'error' ? 'err' : st === 'done' ? 'ok' : 'info'}`} data-testid="lecture-message">
          {st === 'summarizing' || st === 'transcribing' ? <span className="spinner" /> : null}
          {current.message}
          {st === 'transcribing' && current.recorded_s > 0 && ` ${fmtTime(current.transcribed_s)} из ${fmtTime(current.recorded_s)}`}
        </div>
      )}

      {current && current.text && (
        <div className="transcript" data-testid="lecture-text">
          {current.text.length >= 1500 ? '…' : ''}
          {current.text}
        </div>
      )}

      {current && !recording && (
        <div className="row">
          {canNotes && (
            <button className="btn primary" onClick={summarize} data-testid="btn-lecture-notes">
              {st === 'done' ? 'Сделать конспект заново' : 'Сделать конспект'}
            </button>
          )}
          {current.docx && (
            <button className="btn" onClick={() => openFile('docx')} data-testid="btn-lecture-open">
              Открыть конспект
            </button>
          )}
          {current.chars > 0 && (
            <button className="btn ghost" onClick={() => openFile('transcript')}>
              Текст лекции
            </button>
          )}
          <button className="btn ghost" onClick={() => openFile('folder')}>
            Папка
          </button>
        </div>
      )}

      {history.length > 0 && (
        <details className="history">
          <summary>Прошлые лекции ({history.length})</summary>
          <ul>
            {history.map((h) => (
              <li key={h.id} className={h.id === current?.id ? 'sel' : ''}>
                <button className="link" onClick={() => select(h.id)}>
                  {h.title}
                </button>
                <span className="hint-inline">
                  {new Date(h.created * 1000).toLocaleDateString()} · {fmtTime(h.recorded_s)}
                  {h.language ? ` · ${langName(h.language)}` : ''} · {STATE_TEXT[h.state]}
                </span>
              </li>
            ))}
          </ul>
          {folder && <p className="hint">Все конспекты лежат в папке {folder}</p>}
        </details>
      )}
    </section>
  );
}
