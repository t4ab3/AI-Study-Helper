// Service worker: opens the side panel on toolbar click and prunes old sessions.

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_SESSIONS = 40;

function enablePanel(): void {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.error(e));
}

async function pruneSessions(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const sessions = Object.entries(all)
    .filter(([k]) => k.startsWith('session:'))
    .map(([k, v]) => ({ k, t: Number((v as { updatedAt?: number })?.updatedAt ?? 0) }))
    .sort((a, b) => b.t - a.t);
  const now = Date.now();
  const stale = sessions.filter((s, i) => i >= MAX_SESSIONS || now - s.t > MAX_AGE_MS).map((s) => s.k);
  if (stale.length) await chrome.storage.local.remove(stale);
}

const MENU_QUESTION = 'aits-question-text';
const MENU_NEXT = 'aits-next-button';

function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_QUESTION,
      title: 'AI Helper: это текст вопроса',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU_NEXT,
      title: 'AI Helper: это кнопка «Далее»',
      contexts: ['page', 'link', 'image', 'frame'],
    });
  });
}

// The content script reads the selection itself (it needs the DOM range, not just the text).
// The button is the element under the cursor, which only the content script knows.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id === undefined) return;
  const kind = info.menuItemId === MENU_QUESTION ? 'TEACH_QUESTION' : info.menuItemId === MENU_NEXT ? 'TEACH_NEXT' : null;
  if (!kind) return;
  chrome.tabs
    .sendMessage(tab.id, { kind }, { frameId: info.frameId ?? 0 })
    .catch((e) => console.warn(`${kind} failed (reload the page?)`, e));
});

chrome.runtime.onInstalled.addListener(() => {
  enablePanel();
  createMenus();
  pruneSessions().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  enablePanel();
  createMenus();
  pruneSessions().catch(() => undefined);
});
