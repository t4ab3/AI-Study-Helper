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

async function inject(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

/** Sends a request to the content script, injecting it first if the tab was opened before install. */
export async function sendToContent<K extends ContentRequest['kind']>(
  tabId: number,
  msg: Extract<ContentRequest, { kind: K }>,
): Promise<ContentResponse<K>> {
  let resp: Envelope<ContentResponse<K>> | undefined;
  try {
    resp = await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    const text = (e as Error).message ?? '';
    if (!/Receiving end does not exist|Could not establish connection/i.test(text)) throw e;
    log('info', 'tabs', 'content script missing, injecting', { tabId });
    try {
      await inject(tabId);
    } catch (ie) {
      throw new Error(`Не удалось подключиться к странице: ${(ie as Error).message}. Обновите страницу (F5).`);
    }
    resp = await chrome.tabs.sendMessage(tabId, msg);
  }
  if (!resp) throw new Error('Страница не ответила. Обновите её (F5) и попробуйте снова.');
  if (!resp.ok) throw new Error(resp.error);
  return resp.data;
}
