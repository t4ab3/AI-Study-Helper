// Client for the local Python bridge (bridge/deepseek_bridge). The bridge drives a separate
// Chrome window with the DeepSeek web chat through Selenium (types the prompt, returns the
// reply), and turns lecture audio into text and the text into notes.

export const DEFAULT_BRIDGE_PORT = 8765;
const PORT_KEY = 'bridgePort';
let bridgeUrl = `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;

/** The port can be changed in chrome.storage.local ("bridgePort"), e.g. when 8765 is taken. */
export async function loadBridgePort(): Promise<number> {
  try {
    const v = (await chrome.storage.local.get(PORT_KEY))[PORT_KEY];
    const port = Number(v) > 0 && Number(v) < 65536 ? Number(v) : DEFAULT_BRIDGE_PORT;
    bridgeUrl = `http://127.0.0.1:${port}`;
    return port;
  } catch {
    return DEFAULT_BRIDGE_PORT;
  }
}
const CLIENT_HEADER = { 'X-AITS-Client': 'ai-test-solver' };

export interface BridgeStatus {
  running: boolean;
  busy?: boolean;
  on_deepseek: boolean;
  url: string | null;
  profile_dir: string;
  last_error: string | null;
}

export interface OpenResult {
  action: 'opened' | 'focused' | 'reopened';
  status: BridgeStatus;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, method: 'GET' | 'POST', timeoutMs: number, body?: unknown): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const raw = body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
  let res: Response;
  try {
    res = await fetch(`${bridgeUrl}${path}`, {
      method,
      headers:
        body === undefined
          ? CLIENT_HEADER
          : { ...CLIENT_HEADER, 'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
      body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new BridgeError('Bridge не ответил вовремя.', 'timeout');
    throw new BridgeError(
      'DeepSeek Bridge не запущен. Запустите bridge\\start_bridge.bat (или python -m deepseek_bridge).',
      'unavailable',
    );
  } finally {
    clearTimeout(timer);
  }
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = (payload as { error?: { message?: string; code?: string } })?.error;
    throw new BridgeError(err?.message ?? `HTTP ${res.status}`, err?.code ?? 'http_error');
  }
  return payload as T;
}

export const bridge = {
  health: () => call<{ ok: boolean; version: string }>('/health', 'GET', 1500),
  status: () => call<BridgeStatus>('/status', 'GET', 4000),
  /** Opens the DeepSeek window, or focuses it if it is already open. First start can take a while. */
  open: () => call<OpenResult>('/open', 'POST', 120_000),
  close: () => call<{ closed: boolean }>('/close', 'POST', 15_000),
  /** Opens the window if needed and reports whether the chat can be used (logged in, no CAPTCHA). */
  check: () =>
    call<{ ready: boolean; logged_in: boolean; reason: string | null; message: string }>('/deepseek/check', 'POST', 120_000, {}),
  /** Types the prompt into DeepSeek, sends it and returns the finished reply. */
  ask: (prompt: string, newChat: boolean) =>
    call<{ text: string; elapsed: number }>('/deepseek/ask', 'POST', 200_000, { prompt, new_chat: newChat, timeout: 180 }),
  cancel: () => call<{ ok: boolean }>('/deepseek/cancel', 'POST', 5_000, {}),
};

// ---------- lecture notes ----------

export type LectureState = 'new' | 'recording' | 'transcribing' | 'transcribed' | 'summarizing' | 'done' | 'error';

export interface EngineStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  device: string;
  model: string;
  message: string;
  /** the default language (AIH_LANGUAGE) */
  language: string;
  languages?: Record<string, string>;
}

/** Lecture languages: speech recognition and the notes are in this language. */
export type LectureLanguage = 'uk' | 'ru' | 'en';
export const LECTURE_LANGUAGES: { code: LectureLanguage; name: string }[] = [
  { code: 'uk', name: 'Українська' },
  { code: 'ru', name: 'Русский' },
  { code: 'en', name: 'English' },
];

export interface LectureInfo {
  id: string;
  title: string;
  created: number;
  source: 'record' | 'file';
  language?: LectureLanguage;
  state: LectureState;
  message: string;
  recorded_s: number;
  transcribed_s: number;
  docx: string | null;
  folder: string;
}

export interface LectureStatus extends LectureInfo {
  engine: EngineStatus;
  chars: number;
  /** the end of the transcript (all of it with full=1) */
  text: string;
  pending_s: number;
}

const enc = encodeURIComponent;

export const lectures = {
  engine: () => call<EngineStatus>('/lecture/engine', 'GET', 4000),
  list: () => call<{ lectures: LectureInfo[]; folder: string }>('/lectures', 'GET', 6000),
  get: (id: string, full = false) => call<LectureStatus>(`/lecture/${enc(id)}${full ? '?full=1' : ''}`, 'GET', 8000),
  start: (title: string, language: LectureLanguage) => call<LectureStatus>('/lecture/start', 'POST', 15_000, { title, language }),
  /** 16 kHz mono 16-bit PCM */
  audio: (id: string, pcm: ArrayBuffer) =>
    call<{ ok: boolean; recorded_s: number; transcribed_s: number }>(`/lecture/${enc(id)}/audio`, 'POST', 15_000, pcm),
  stop: (id: string) => call<LectureStatus>(`/lecture/${enc(id)}/stop`, 'POST', 15_000, {}),
  upload: (file: File, title: string, language: LectureLanguage) =>
    call<LectureStatus>(
      `/lecture/upload?title=${enc(title)}&name=${enc(file.name)}&language=${enc(language)}`,
      'POST',
      30 * 60_000,
      file,
    ),
  summarize: (id: string, open = true) => call<LectureStatus>(`/lecture/${enc(id)}/summarize`, 'POST', 15_000, { open }),
  open: (id: string, what: 'docx' | 'folder' | 'transcript') =>
    call<{ ok: boolean; path: string }>(`/lecture/${enc(id)}/open`, 'POST', 10_000, { what }),
};
