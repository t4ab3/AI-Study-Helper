import { initialAutoState, type AutoState } from './autoRunner';

/** What the panel knows about one tab. Persisted, so switching windows or reloading loses nothing. */
export interface Session {
  tabId: number;
  url: string;
  /** Automatic mode progress. */
  auto: AutoState;
  updatedAt: number;
}

export function emptySession(tabId: number, url: string): Session {
  return { tabId, url, auto: initialAutoState(), updatedAt: Date.now() };
}

const key = (tabId: number) => `session:${tabId}`;

function stripUrl(url: string): string {
  return url.split('#')[0];
}

/** Keeps only the fields of the current version (older versions stored more). */
function revive(tabId: number, url: string, stored: Partial<Session>): Session {
  return { tabId, url, auto: reviveAuto(stored.auto), updatedAt: stored.updatedAt ?? Date.now() };
}

/** Session of the tab, or (after a browser restart changed tab ids) the newest one for the same URL. */
export async function loadSession(tabId: number, url: string): Promise<Session> {
  const stored = await chrome.storage.local.get(key(tabId));
  const own = stored[key(tabId)] as Session | undefined;
  if (own) return revive(tabId, own.url || url, own);

  const all = await chrome.storage.local.get(null);
  const sameUrl = Object.entries(all)
    .filter(([k, v]) => k.startsWith('session:') && stripUrl((v as Session)?.url ?? '') === stripUrl(url))
    .map(([, v]) => v as Session)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (sameUrl) return revive(tabId, url, sameUrl);
  return emptySession(tabId, url);
}

/** A run cannot survive the panel being closed: show it as paused so the user can continue. */
export function reviveAuto(a: AutoState | undefined): AutoState {
  const base = { ...initialAutoState(), ...(a ?? {}) };
  if ((base.phase === 'running' || base.phase === 'waiting_user') && !base.displayOnly)
    return { ...base, phase: 'paused', step: null, message: 'Панель была закрыта во время решения. Нажмите «Продолжить».' };
  return base;
}

/** Writes part of a session for a tab other than the one on screen. */
export async function patchSession(tabId: number, patch: Partial<Session>): Promise<void> {
  const k = key(tabId);
  const cur = (await chrome.storage.local.get(k))[k] as Session | undefined;
  if (cur) await chrome.storage.local.set({ [k]: { ...cur, ...patch, updatedAt: Date.now() } });
}

export async function saveSession(s: Session): Promise<void> {
  await chrome.storage.local.set({ [key(s.tabId)]: { ...s, updatedAt: Date.now() } });
}
