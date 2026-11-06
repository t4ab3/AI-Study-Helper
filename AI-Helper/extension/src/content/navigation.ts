import type { LearnedNext, NextCandidate } from '../shared/types';
import { uniqueSelector } from '../shared/selectors';
import { normalizeSpace } from './recognize';

const NEXT_RE = /^(далее|дальше|следующ\S*|вперёд|вперед|продолжить|next|continue|forward|›|»|→|>|>>)(\s|$|\b)/i;
// Anything that looks like finishing the test is never offered.
const FINISH_RE =
  /(заверш|закончи|законч|отправ|сдать|сдаю|готово|проверить|submit|finish|complete|end\s+test|done|send|check\s+answer|grade)/i;

function labelOf(el: HTMLElement): string {
  if (el instanceof HTMLInputElement) return normalizeSpace(el.value || el.getAttribute('aria-label') || '');
  return normalizeSpace(el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '');
}

export const buttonLabel = labelOf;

const BUTTON_SELECTOR = 'button, input[type="submit"], input[type="button"], a[href], [role="button"]';
/** div/span "buttons": only considered when their text says "Next" and they look clickable. */
const SOFT_BUTTON_SELECTOR = 'div, span, li, p, a, td';

function looksClickable(el: Element): boolean {
  if (el.hasAttribute('onclick') || el.hasAttribute('tabindex') || el.hasAttribute('ng-click')) return true;
  try {
    return getComputedStyle(el).cursor === 'pointer';
  } catch {
    return false;
  }
}

function isDisabled(el: Element): boolean {
  const cls = typeof el.className === 'string' ? el.className : '';
  return (
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute('aria-disabled') === 'true' ||
    /(^|\s)(disabled|is-disabled)(\s|$)/.test(cls)
  );
}

/** Next-like elements: real buttons, plus clickable div/span with the text "Далее" (outermost clickable one). */
function nextLikeElements(doc: Document): HTMLElement[] {
  const out = Array.from(doc.querySelectorAll<HTMLElement>(BUTTON_SELECTOR));
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(SOFT_BUTTON_SELECTOR))) {
    if (el.closest(BUTTON_SELECTOR)) continue;
    const raw = el.textContent ?? '';
    if (raw.length > 80 || !isNextLabel(raw) || !looksClickable(el)) continue;
    if (out.some((o) => o.contains(el) || el.contains(o))) continue;
    out.push(el);
  }
  return out;
}

/** Clicks like a user: some sites listen to mousedown/pointerup instead of click. */
export function userClick(el: HTMLElement): void {
  if (!el.matches('button, input, a[href]')) {
    const r = el.getBoundingClientRect?.();
    const init = { bubbles: true, cancelable: true, clientX: r ? r.left + r.width / 2 : 0, clientY: r ? r.top + r.height / 2 : 0 };
    const P = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new P('pointerdown', init));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new P('pointerup', init));
    el.dispatchEvent(new MouseEvent('mouseup', init));
  }
  el.click();
}

// ---------- the button the user showed us ----------

const ANSWER_CONTROL =
  'input:not([type="submit"]):not([type="button"]):not([type="image"]), select, textarea, option, label, [role="radio"], [role="checkbox"], [role="option"], [role="radiogroup"], [role="listbox"]';
const CLICKABLE = 'button, a[href], input[type="submit"], input[type="button"], input[type="image"], [role="button"], [onclick]';

/** The button behind a user's click, or null for clicks on answers or on long text. */
/** A click on an <svg> icon lands on its <path>: use the HTML element that holds the icon. */
function outOfSvg(target: Element): Element {
  return target instanceof SVGElement ? (target.closest('svg')?.parentElement ?? target) : target;
}

export function clickableOf(target: Element): HTMLElement | null {
  target = outOfSvg(target);
  if (target.closest(ANSWER_CONTROL)) return null;
  const c = target.closest<HTMLElement>(CLICKABLE);
  if (c && labelOf(c).length <= 80) return c;
  let el: Element | null = target;
  for (let i = 0; el && i < 6 && el !== el.ownerDocument.body; i++, el = el.parentElement) {
    if (normalizeSpace(el.textContent ?? '').length > 80) break;
    if (looksClickable(el)) return el as HTMLElement;
  }
  return null;
}

/**
 * The button the user right-clicked: like clickableOf, but also accepts an element that does not
 * look clickable (a plain div with an arrow icon).
 */
export function buttonFromTarget(target: Element): HTMLElement | null {
  target = outOfSvg(target);
  if (target.closest(ANSWER_CONTROL)) return null;
  const c = clickableOf(target);
  if (c) return c;
  // not a button by its looks (a plain div or icon): use the clicked element itself; a click on
  // it reaches the site's handler on its parents anyway
  if (!(target instanceof HTMLElement) || target === target.ownerDocument.body || target.tagName === 'HTML') return null;
  if (labelOf(target).length > 80 || target.querySelector(ANSWER_CONTROL)) return null;
  return target;
}

export function describeLearned(el: HTMLElement): LearnedNext {
  return { selector: uniqueSelector(el), text: labelOf(el), tag: el.tagName.toLowerCase(), url: location.href, savedAt: Date.now() };
}

/** Finds the remembered button on the current page. Never returns a finish-like button. */
export function findLearned(
  doc: Document,
  learned: LearnedNext,
  isVisible: (el: Element) => boolean,
  ignore: (el: Element) => boolean,
): HTMLElement | null {
  const want = learned.text.toLowerCase();
  const ok = (el: HTMLElement) => {
    if (ignore(el) || !isVisible(el)) return false;
    const t = labelOf(el);
    if (isFinishLabel(t)) return false;
    return !want || t.toLowerCase() === want;
  };
  let bySel: HTMLElement | null = null;
  try {
    bySel = doc.querySelector<HTMLElement>(learned.selector);
  } catch {
    /* selector from another page layout */
  }
  if (bySel && ok(bySel)) return bySel;
  if (!want) return null;
  // same tag and text, innermost match
  const same = Array.from(doc.querySelectorAll<HTMLElement>(learned.tag || '*')).filter(
    (el) => ok(el) && !Array.from(el.children).some((ch) => normalizeSpace(ch.textContent ?? '').toLowerCase() === want && ch.tagName.toLowerCase() === learned.tag),
  );
  return same[0] ?? null;
}

export function isNextLabel(text: string): boolean {
  const t = normalizeSpace(text);
  return t.length > 0 && t.length < 60 && NEXT_RE.test(t) && !FINISH_RE.test(t);
}

/** Finds "Next / Далее" buttons. Final-submit buttons are filtered out by text. */
export function findNextCandidates(
  doc: Document,
  isVisible: (el: Element) => boolean,
  ignore: (el: Element) => boolean,
): NextCandidate[] {
  const out: NextCandidate[] = [];
  for (const el of nextLikeElements(doc)) {
    if (ignore(el) || !isVisible(el)) continue;
    const text = labelOf(el);
    if (!isNextLabel(text)) continue;
    out.push(isDisabled(el) ? { selector: uniqueSelector(el), text, disabled: true } : { selector: uniqueSelector(el), text });
  }
  // enabled buttons first, otherwise in page order
  out.sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled));
  return out.slice(0, 5);
}

const FINISH_BUTTON_RE =
  /(заверш|закончи|отправить\s+(все|ответ|тест)|сдать|submit|finish|complete|end\s+test)/i;

export function isFinishLabel(text: string): boolean {
  const t = normalizeSpace(text);
  return t.length > 0 && t.length < 60 && FINISH_BUTTON_RE.test(t);
}

/** Buttons that finish/submit the whole test. They are only reported, never pressed automatically. */
export function findFinishCandidates(
  doc: Document,
  isVisible: (el: Element) => boolean,
  ignore: (el: Element) => boolean,
): NextCandidate[] {
  const els = Array.from(
    doc.querySelectorAll<HTMLElement>('button, input[type="submit"], input[type="button"], a[href], [role="button"]'),
  );
  return els
    .filter((el) => !ignore(el) && isVisible(el) && !(el as HTMLButtonElement).disabled && isFinishLabel(labelOf(el)))
    .slice(0, 3)
    .map((el) => ({ selector: uniqueSelector(el), text: labelOf(el) }));
}

export function clickFinish(doc: Document, selector: string): { ok: boolean; message: string } {
  const el = doc.querySelector<HTMLElement>(selector);
  if (!el) return { ok: false, message: 'Кнопка завершения не найдена' };
  const text = labelOf(el);
  if (!isFinishLabel(text)) return { ok: false, message: `Кнопка «${text}» не похожа на завершение теста` };
  el.click();
  return { ok: true, message: `Нажата кнопка «${text}»` };
}

/** `learned`: the remembered button on this page; it may have any text except a finishing one. */
export function clickNext(doc: Document, selector: string, learned: HTMLElement | null = null): { ok: boolean; message: string } {
  const el = doc.querySelector<HTMLElement>(selector);
  if (!el) return { ok: false, message: 'Кнопка не найдена' };
  const text = labelOf(el);
  if (el !== learned && !isNextLabel(text))
    return { ok: false, message: `Кнопка «${text}» не похожа на переход дальше, нажатие отменено` };
  if (isFinishLabel(text)) return { ok: false, message: `Кнопка «${text}» завершает тест, нажатие отменено` };
  if (isDisabled(el)) return { ok: false, message: `Кнопка «${text}» неактивна: сайт не принял ответ` };
  userClick(el);
  return { ok: true, message: `Нажата кнопка «${text || 'Далее'}»` };
}
