export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  t: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: string;
}

const KEY = 'logs';
const MAX = 600;

let queue: Promise<void> = Promise.resolve();

function hasStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

/** Logs to the console and to a ring buffer in chrome.storage.local (visible in the side panel). */
export function log(level: LogLevel, scope: string, message: string, data?: unknown): void {
  const entry: LogEntry = { t: Date.now(), level, scope, message };
  if (data !== undefined) {
    try {
      entry.data = data instanceof Error ? `${data.name}: ${data.message}` : JSON.stringify(data).slice(0, 2000);
    } catch {
      entry.data = String(data);
    }
  }
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  fn(`[AI Helper:${scope}] ${message}`, data ?? '');
  if (!hasStorage()) return;
  queue = queue
    .then(async () => {
      const stored = await chrome.storage.local.get(KEY);
      const list: LogEntry[] = Array.isArray(stored[KEY]) ? stored[KEY] : [];
      list.push(entry);
      await chrome.storage.local.set({ [KEY]: list.slice(-MAX) });
    })
    .catch(() => undefined);
}

export async function readLogs(): Promise<LogEntry[]> {
  if (!hasStorage()) return [];
  const stored = await chrome.storage.local.get(KEY);
  return Array.isArray(stored[KEY]) ? stored[KEY] : [];
}

export async function clearLogs(): Promise<void> {
  if (hasStorage()) await chrome.storage.local.remove(KEY);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : JSON.stringify(e);
}
