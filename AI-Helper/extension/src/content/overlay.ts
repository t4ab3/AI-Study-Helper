/**
 * Page overlay: highlights (what was found or learned) and short notices in the corner.
 * Lives in a shadow root attached to <html>, positioned in document coordinates so it scrolls
 * with the page and never takes part in recognition.
 */

export const HOST_ID = 'ai-helper-overlay-host';

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.hl { position: absolute; border: 2px solid #3ccf91; background: rgba(60, 207, 145, .12); border-radius: 4px; pointer-events: none; z-index: 2147483644; }
.hl.uncheck { border-color: #8892a6; background: rgba(136,146,166,.08); border-style: dashed; }
.hl span { position: absolute; top: -18px; left: -2px; background: #3ccf91; color: #08130e; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px; white-space: nowrap; }
.notice { position: fixed; right: 16px; bottom: 16px; max-width: 380px; background: #151a24; color: #e7ecf5; border: 1px solid #2d3546;
  border-left: 3px solid #3ccf91; padding: 9px 12px; border-radius: 10px; font-size: 13px; line-height: 1.4; z-index: 2147483647;
  box-shadow: 0 8px 24px rgba(0,0,0,.4); pointer-events: none; }
.notice.err { border-left-color: #ff6b6b; }
`;

export class PageOverlay {
  private host: HTMLDivElement;
  private root: ShadowRoot;
  private highlightLayer: HTMLDivElement;
  private noticeEl: HTMLDivElement | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    document.getElementById(HOST_ID)?.remove();
    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    Object.assign(this.host.style, {
      position: 'absolute', top: '0', left: '0', width: '0', height: '0', zIndex: '2147483645', overflow: 'visible',
    });
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.root.appendChild(style);
    this.highlightLayer = document.createElement('div');
    this.root.appendChild(this.highlightLayer);
    document.documentElement.appendChild(this.host);
  }

  /** Keeps the host attached if the page replaces <body> or re-renders <html> children. */
  private ensureAttached(): void {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
  }

  isOwn(el: Element): boolean {
    return el === this.host || this.host.contains(el);
  }

  highlight(boxes: { rect: DOMRect; label: string; uncheck: boolean }[]): void {
    this.ensureAttached();
    this.clearHighlights();
    for (const b of boxes) {
      const d = document.createElement('div');
      d.className = `hl${b.uncheck ? ' uncheck' : ''}`;
      Object.assign(d.style, {
        left: `${b.rect.left + window.scrollX - 3}px`,
        top: `${b.rect.top + window.scrollY - 3}px`,
        width: `${b.rect.width + 6}px`,
        height: `${b.rect.height + 6}px`,
      });
      if (b.label) {
        const s = document.createElement('span');
        s.textContent = b.label;
        d.appendChild(s);
      }
      this.highlightLayer.appendChild(d);
    }
  }

  clearHighlights(): void {
    this.highlightLayer.replaceChildren();
  }

  /** Short message in the corner of the page (the side panel may be closed). */
  notice(text: string, error = false, ms = 4500): void {
    this.ensureAttached();
    this.noticeEl?.remove();
    clearTimeout(this.noticeTimer);
    const d = document.createElement('div');
    d.className = `notice${error ? ' err' : ''}`;
    d.textContent = text;
    this.root.appendChild(d);
    this.noticeEl = d;
    this.noticeTimer = setTimeout(() => {
      d.remove();
      if (this.noticeEl === d) this.noticeEl = null;
    }, ms);
  }
}

/** Learned rules are remembered per site; file:// pages have origin "null", so they are keyed by path. */
export function siteKey(): string {
  return location.origin && location.origin !== 'null' ? location.origin : location.href.split('#')[0].split('?')[0];
}
