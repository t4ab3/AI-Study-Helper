import { cssEscape } from '../shared/selectors';

/*
  "This is the question text": the user selects a question's text once and picks the context
  menu item. We turn the element holding that text into a CSS selector general enough to match
  the same kind of element on every question of the site (tag + stable classes, an id prefix,
  or a parent path), and recognition then reads question text from those elements.
*/

const INLINE = new Set(['SPAN', 'B', 'I', 'STRONG', 'EM', 'FONT', 'U', 'SMALL', 'MARK', 'SUB', 'SUP', 'CODE', 'A', 'LABEL']);
const CONTROLS = 'input, select, textarea, [role="radio"], [role="checkbox"]';
const BLOCK_SKIP = new Set(['BODY', 'HTML', 'MAIN', 'FORM']);
// classes that describe a state, not the kind of element
const STATE_CLASS = /^(active|current|selected|show|shown|visible|hidden|open|opened|closed|focus|focused|hover|disabled|enabled|in|fade|ng-.*|is-.*|has-.*|js-.*|answered|correct|incorrect|wrong|right)$/i;
// classes that number the question ("q-12", "question3")
const NUMBERED_CLASS = /^[a-z_-]*?[-_]?\d+$/i;

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** The element that holds the selected question text. */
export function questionElementFromRange(range: Range): Element | null {
  const n = range.commonAncestorContainer;
  let el: Element | null = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
  if (!el) return null;
  // the selection spilled over the answer options: use the block where it starts
  if (el.querySelector(CONTROLS)) {
    const s = range.startContainer;
    el = s.nodeType === Node.ELEMENT_NODE ? (s as Element) : s.parentElement;
    while (el && INLINE.has(el.tagName) && el.parentElement) el = el.parentElement;
    if (!el || el.querySelector(CONTROLS)) return null;
  }
  // step out of <b>/<span> wrappers that hold the whole text of their block
  while (el.parentElement && INLINE.has(el.tagName) && !BLOCK_SKIP.has(el.parentElement.tagName) && norm(el.parentElement.textContent) === norm(el.textContent))
    el = el.parentElement;
  return BLOCK_SKIP.has(el.tagName) ? null : el;
}

function stableClasses(el: Element): string[] {
  return Array.from(el.classList).filter((c) => c.length > 1 && !STATE_CLASS.test(c) && !NUMBERED_CLASS.test(c));
}

function tagWithClasses(el: Element, classes: string[]): string {
  return el.tagName.toLowerCase() + classes.map((c) => `.${cssEscape(c)}`).join('');
}

function candidates(el: Element): string[] {
  const tag = el.tagName.toLowerCase();
  const out: string[] = [];
  const id = el.id;
  if (id && !/\d/.test(id)) out.push(`#${cssEscape(id)}`);
  const cls = stableClasses(el);
  if (cls.length) out.push(tagWithClasses(el, cls));
  if (cls.length > 1) cls.forEach((c) => out.push(tagWithClasses(el, [c])));
  if (id && /\d/.test(id)) {
    const prefix = id.replace(/\d.*$/, '');
    if (prefix.length >= 3) out.push(`${tag}[id^="${prefix.replace(/"/g, '\\"')}"]`);
  }
  // parent path: ".question-card > p", ".qbox .head > div"
  let parent = el.parentElement;
  let path = tag;
  for (let i = 0; parent && i < 3 && !BLOCK_SKIP.has(parent.tagName); i++, parent = parent.parentElement) {
    const pc = stableClasses(parent);
    const pid = parent.id && !/\d/.test(parent.id) ? `#${cssEscape(parent.id)}` : '';
    if (pid || pc.length) {
      out.push(`${pid || tagWithClasses(parent, pc)} > ${path}`);
      break;
    }
    path = `${parent.tagName.toLowerCase()} > ${path}`;
  }
  return out;
}

/** A selector that matches `el` and the same kind of element on other questions, or null. */
export function buildQuestionSelector(el: Element): string | null {
  const doc = el.ownerDocument;
  const ownHasControls = !!el.querySelector(CONTROLS);
  for (const sel of candidates(el)) {
    let matches: Element[];
    try {
      matches = Array.from(doc.querySelectorAll(sel));
    } catch {
      continue;
    }
    if (!matches.includes(el) || matches.length > 60) continue;
    // must not grab whole question cards with their options (unless the user selected one)
    if (!ownHasControls && matches.some((m) => m.querySelector(CONTROLS))) continue;
    return sel;
  }
  return null;
}

/**
 * The rule's element for a question whose first control is `first`: the closest match that
 * comes before it in the page (or wraps it), and not before `boundary` (the previous
 * question's last control).
 */
export function ruleElementFor(
  doc: Document,
  selector: string,
  first: Element,
  boundary: Element | null,
  isVisible: (el: Element) => boolean,
  allowAfter = true,
): Element | null {
  let matches: Element[];
  try {
    matches = Array.from(doc.querySelectorAll(selector));
  } catch {
    return null;
  }
  matches = matches.filter((m) => isVisible(m) && norm(m.textContent).length > 0);
  let best: Element | null = null;
  for (const m of matches) {
    const before = m.contains(first) || !!(m.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!before) break; // matches are in document order
    if (boundary && !m.contains(first) && m.compareDocumentPosition(boundary) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
    best = m;
  }
  if (best) return best;
  // a single question text on the page that sits after its options (rare layouts)
  return allowAfter && matches.length === 1 ? matches[0] : null;
}
