import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_TIMEOUT, PageGoneError, isPageGone, sendToContent } from '../src/sidepanel/tabs';

type Reply = () => Promise<unknown>;

function stubChrome(replies: Reply[]) {
  const sendMessage = vi.fn(() => {
    const next = replies.shift();
    return next ? next() : new Promise(() => undefined);
  });
  const executeScript = vi.fn(async () => [{}]);
  vi.stubGlobal('chrome', { tabs: { sendMessage }, scripting: { executeScript } });
  return { sendMessage, executeScript };
}

const never: Reply = () => new Promise(() => undefined);
const ok = (data: unknown): Reply => async () => ({ ok: true, data });

describe('talking to the page', () => {
  const saved = { ...PAGE_TIMEOUT };
  beforeEach(() => {
    PAGE_TIMEOUT.defaultMs = 50;
    PAGE_TIMEOUT.fillMs = 50;
    PAGE_TIMEOUT.injectMs = 50;
  });
  afterEach(() => {
    Object.assign(PAGE_TIMEOUT, saved);
    vi.unstubAllGlobals();
  });

  it('a request the page never answers (it was reloading) is sent again instead of hanging', async () => {
    const c = stubChrome([never, ok({ questions: [] })]);
    await expect(sendToContent(1, { kind: 'RECOGNIZE' })).resolves.toEqual({ questions: [] });
    expect(c.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('gives up with an error, not silence, when the page stays dead', async () => {
    stubChrome([never, never]);
    const e = await sendToContent(1, { kind: 'FIND_NEXT' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PageGoneError);
    expect(isPageGone(e)).toBe(true);
  });

  it('"Next" is never clicked twice', async () => {
    const c = stubChrome([never, ok({ ok: true, message: '' })]);
    await expect(sendToContent(1, { kind: 'CLICK_NEXT', selector: '#next' })).rejects.toBeInstanceOf(PageGoneError);
    expect(c.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('a page without the script gets it injected', async () => {
    const c = stubChrome([
      async () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      ok({ candidates: [] }),
    ]);
    await expect(sendToContent(1, { kind: 'FIND_NEXT' })).resolves.toEqual({ candidates: [] });
    expect(c.executeScript).toHaveBeenCalledTimes(1);
  });

  it('a closed message port (navigation) counts as the page going away', () => {
    expect(isPageGone(new Error('The message port closed before a response was received.'))).toBe(true);
    expect(isPageGone(new Error('Ответ не принят'))).toBe(false);
  });
});
