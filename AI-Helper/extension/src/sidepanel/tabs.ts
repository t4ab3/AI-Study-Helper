import type { ContentRequest, ContentResponse, Envelope } from '../shared/messages';
import { log } from '../shared/logger';

const RESTRICTED = /^(chrome|edge|about|devtools|chrome-extension|view-source):|^https:\/\/chrome(webstore)?\.google\.com\/webstore|^https:\/\/chromewebstore\.google\.com/;

export function isRestrictedUrl(url: string | undefined): boolean {
  return !url || RESTRICTED.test(url);
}

/** Tab the panel works with: `?tabId=` (used by tests/debugging) or the active tab of this window. */
export async function resolveTargetTab(): Promise<chrome.tabs.Tab | null> {
  const fixed = new URLSearchParams(location.search).get('tabId');
  if (fixed) {
    try {
      return await chrome.tabs.get(Number(fixed));
    } catch {
      return null;
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

export function isPinnedToTab(): boolean {
  return new URLSearchParams(location.search).has('tabId');
}

/**
 * How long the page may take to answer. Without a limit a request sent while the page was
 * reloading (after "Next") could stay unanswered forever, and the solving silently stopped.
 */
export const PAGE_TIMEOUT = { defaultMs: 10_000, fillMs: 20_000, injectMs: 15_000 };

/** The page did not answer in time, or it was unloaded while answering (navigation). */
export class PageGoneError extends Error {
  readonly code = 'page_gone';
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PageGoneError(`Страница не ответила за ${ms / 1000} с (${what}).`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function isMissing(e: unknown): boolean {
  return /Receiving end does not exist|Could not establish connection/i.test((e as Error)?.message ?? '');
}

/** The answer was lost because the page went away (reload, navigation, back-forward cache). */
export function isPageGone(e: unknown): boolean {
  return (
    e instanceof PageGoneError ||
    /message port closed|message channel closed|back\/forward cache|Frame with ID|No tab with id|tab was closed/i.test(
      (e as Error)?.message ?? '',
    )
  );
}

async function inject(tabId: number): Promise<void> {
  await withTimeout(chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }), PAGE_TIMEOUT.injectMs, 'подключение');
}

async function sendOnce<K extends ContentRequest['kind']>(
  tabId: number,
  msg: Extract<ContentRequest, { kind: K }>,
  ms: number,
): Promise<Envelope<ContentResponse<K>> | undefined> {
  try {
    return await withTimeout(chrome.tabs.sendMessage(tabId, msg), ms, msg.kind);
  } catch (e) {
    if (!isMissing(e)) throw e;
    log('info', 'tabs', 'content script missing, injecting', { tabId });
    try {
      await inject(tabId);
    } catch (ie) {
      if (isPageGone(ie)) throw ie;
      throw new Error(`Не удалось подключиться к странице: ${(ie as Error).message}. Обновите страницу (F5).`);
    }
    return await withTimeout(chrome.tabs.sendMessage(tabId, msg), ms, msg.kind);
  }
}

/** Requests that change the page: sent once, never repeated (a second "Next" would skip a question). */
const NO_RETRY = new Set<ContentRequest['kind']>(['CLICK_NEXT', 'CLICK_FINISH']);

/** Sends a request to the content script, injecting it first if the tab was opened before install. */
export async function sendToContent<K extends ContentRequest['kind']>(
  tabId: number,
  msg: Extract<ContentRequest, { kind: K }>,
): Promise<ContentResponse<K>> {
  const ms = msg.kind === 'FILL' ? PAGE_TIMEOUT.fillMs : PAGE_TIMEOUT.defaultMs;
  let resp: Envelope<ContentResponse<K>> | undefined;
  try {
    resp = await sendOnce(tabId, msg, ms);
  } catch (e) {
    if (!isPageGone(e) || NO_RETRY.has(msg.kind)) throw e;
    // the page was reloading: once more, on the page that is there now
    log('warn', 'tabs', `${msg.kind}: ${(e as Error).message} Повторяю.`, { tabId });
    await new Promise((r) => setTimeout(r, 800));
    resp = await sendOnce(tabId, msg, ms);
  }
  if (!resp) throw new Error('Страница не ответила. Обновите её (F5) и попробуйте снова.');
  if (!resp.ok) throw new Error(resp.error);
  return resp.data;
}
