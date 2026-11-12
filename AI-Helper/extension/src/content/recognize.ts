import type { AnswerOption, MatchItem, Question, TargetKind } from '../shared/types';
import { isTrueFalse } from '../shared/textParse';
import { uniqueSelector } from '../shared/selectors';
import { ruleElementFor } from './questionRule';

export interface RecognizeOptions {
  /** Limits recognition to part of the page (tests); default: the whole page. */
  inRegion?: (el: Element) => boolean;
  /** Is the element rendered? (jsdom has no layout, so tests pass () => true.) */
  isVisible?: (el: Element) => boolean;
  /** Elements to ignore entirely (our own overlay). */
  ignore?: (el: Element) => boolean;
  /** Site rule taught by the user: CSS selector of the element that holds question text. */
  questionSelector?: string | null;
}

type ControlKind = 'radio' | 'checkbox' | 'aria-radio' | 'aria-checkbox' | 'select' | 'text';

interface Control {
  el: HTMLElement;
  kind: ControlKind;
  groupKey: string;
}

interface Group {
  key: string;
  kind: ControlKind;
  controls: Control[];
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'number', 'url', 'tel']);
const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SELECT', 'OPTION', 'TEXTAREA', 'BUTTON', 'TEMPLATE', 'SVG']);
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LEGEND', 'LABEL',
  'FIELDSET', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'TBODY', 'DT', 'DD', 'BR', 'FORM', 'HEADER', 'FOOTER',
]);

const INSTRUCTION_RE =
  /(выберите\s+(?:один|одну|один\s+или\s+несколько|несколько|все|верный|верные|правильный|правильные)?\s*(?:правильный|правильные|верный|верные)?\s*(?:ответ|ответа|ответов|вариант|варианта|вариантов)(?:\s+ответа)?\s*:?)|(select\s+one(?:\s+or\s+more)?\s*:?)|(choose\s+(?:one|all\s+that\s+apply|the\s+correct\s+answer)\s*[:.]?)|(очистить\s+мой\s+выбор)|(clear\s+my\s+choice)/gi;

export function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function stripInstructions(s: string): string {
  return normalizeSpace(s.replace(INSTRUCTION_RE, ' '));
}

function hasAncestorIn(node: Node, set: Set<Node>, stop: Node): boolean {
  let n: Node | null = node;
  while (n && n !== stop.parentNode) {
    if (set.has(n)) return true;
    n = n.parentNode;
  }
  return false;
}

/** Visible-ish text of `root`, skipping control internals and any node inside `exclude`. */
export function textOf(root: Node, exclude: Set<Node> = new Set(), skip?: (el: Element) => boolean): string {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const out: string[] = [];
  let node: Node | null = walker.currentNode;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (
        SKIP_TEXT_TAGS.has(el.tagName.toUpperCase()) ||
        exclude.has(el) ||
        el.getAttribute('aria-hidden') === 'true' ||
        (skip && el !== root && skip(el))
      ) {
        // skip subtree
        let next: Node | null = null;
        let cur: Node | null = el;
        while (cur && !next) {
          if (cur === root) break;
          next = cur.nextSibling;
          cur = cur.parentNode;
        }
        if (!next) break;
        walker.currentNode = next;
        node = next;
        continue;
      }
      if (BLOCK_TAGS.has(el.tagName.toUpperCase())) out.push(' ');
    } else if (node.nodeType === Node.TEXT_NODE && !exclude.has(node)) {
      out.push(node.nodeValue ?? '');
    }
    node = walker.nextNode();
  }
  return normalizeSpace(out.join(''));
}

function controlKind(el: Element): ControlKind | null {
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (type === 'radio') return 'radio';
    if (type === 'checkbox') return 'checkbox';
    if (TEXT_INPUT_TYPES.has(type)) return 'text';
    return null;
  }
  if (tag === 'SELECT') return (el as HTMLSelectElement).multiple ? null : 'select';
  if (tag === 'TEXTAREA') return 'text';
  const role = el.getAttribute('role');
  if (role === 'radio') return 'aria-radio';
  if (role === 'checkbox') return 'aria-checkbox';
  return null;
}

const CONTROL_SELECTOR =
  'input, select, textarea, [role="radio"], [role="checkbox"]';

function stripIndexSuffix(name: string): string {
  return name.replace(/(\[\d*\]|_?choice\d+|[_-]\d+)$/i, '');
}

function containerKey(el: Element, sel: string): string {
  const c = el.closest(sel);
  return c ? uniqueSelector(c) : uniqueSelector(el.parentElement?.parentElement ?? el);
}

function groupKeyFor(el: HTMLElement, kind: ControlKind, index: number): string {
  const form = (el as HTMLInputElement).form;
  const formKey = form ? uniqueSelector(form) : 'doc';
  const name = el.getAttribute('name');
  switch (kind) {
    case 'radio':
      return name ? `radio|${formKey}|${name}` : `radio|${containerKey(el, 'fieldset, [role="radiogroup"]')}`;
    case 'checkbox': {
      const group = el.closest('fieldset, [role="group"]');
      if (group) return `checkbox|${uniqueSelector(group)}`;
      return name ? `checkbox|${formKey}|${stripIndexSuffix(name)}` : `checkbox|${containerKey(el, 'ul, ol, div')}`;
    }
    case 'aria-radio':
      return `aria-radio|${containerKey(el, '[role="radiogroup"]')}`;
    case 'aria-checkbox':
      return `aria-checkbox|${containerKey(el, '[role="group"], [role="list"]')}`;
    default:
      return `${kind}|${index}`;
  }
}

function lowestCommonAncestor(nodes: Element[]): Element {
  if (nodes.length === 1) return nodes[0];
  let lca: Element | null = nodes[0];
  while (lca && !nodes.every((n) => lca!.contains(n))) lca = lca.parentElement;
  return lca ?? nodes[0].ownerDocument.body;
}

interface LabelInfo {
  text: string;
  nodes: Node[]; // nodes that make up the label (to exclude from question text)
}

function idsText(doc: Document, ids: string): LabelInfo | null {
  const els = ids
    .split(/\s+/)
    .map((id) => doc.getElementById(id))
    .filter((e): e is HTMLElement => !!e);
  if (!els.length) return null;
  const text = normalizeSpace(els.map((e) => textOf(e)).join(' '));
  return text ? { text, nodes: els } : null;
}

/** Label of an option-like control (radio/checkbox) or a select/text field. */
function labelOf(el: HTMLElement, allControls: Set<Element>): LabelInfo {
  const doc = el.ownerDocument;
  const labelled = el.getAttribute('aria-labelledby');
  if (labelled) {
    const r = idsText(doc, labelled);
    if (r) return r;
  }
  const native = (el as HTMLInputElement).labels;
  if (native && native.length) {
    const nodes = Array.from(native);
    const text = normalizeSpace(nodes.map((l) => textOf(l)).join(' '));
    if (text) return { text, nodes };
  }
  const aria = el.getAttribute('aria-label');
  if (aria && normalizeSpace(aria)) return { text: normalizeSpace(aria), nodes: [] };

  if (el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'checkbox') {
    const own = textOf(el);
    if (own) return { text: own, nodes: [el] };
    const dv = el.getAttribute('data-value');
    if (dv) return { text: normalizeSpace(dv), nodes: [] };
  }

  // Text right after the control, up to the next control or block boundary.
  const nodes: Node[] = [];
  const parts: string[] = [];
  let sib: Node | null = el.nextSibling;
  while (sib) {
    if (sib.nodeType === Node.ELEMENT_NODE) {
      const se = sib as Element;
      if (allControls.has(se) || se.querySelector(CONTROL_SELECTOR) || se.tagName === 'BR' || BLOCK_TAGS.has(se.tagName)) break;
      parts.push(textOf(se));
      nodes.push(se);
    } else if (sib.nodeType === Node.TEXT_NODE) {
      parts.push(sib.nodeValue ?? '');
      nodes.push(sib);
    }
    sib = sib.nextSibling;
  }
  const after = normalizeSpace(parts.join(' '));
  if (after) return { text: after, nodes };

  // The closest block that holds only this control plus text: the parent (<div><input> text</div>)
  // or a few levels up, when the control sits in its own styling wrapper and the text in a
  // neighbouring block (Testportal and other Material-style radios:
  // <div class="answer"><div class="radio"><input></div><div class="answer_body">text</div></div>)
  let anc = el.parentElement;
  for (let i = 0; anc && i < 4 && anc !== doc.body; i++, anc = anc.parentElement) {
    if (!Array.from(anc.querySelectorAll(CONTROL_SELECTOR)).every((c) => c === el)) break;
    const text = textOf(anc);
    if (text) {
      if (text.length > 400) break;
      return { text, nodes: [anc] };
    }
  }
  const ph = el.getAttribute('placeholder') ?? el.getAttribute('title');
  if (ph) return { text: normalizeSpace(ph), nodes: [] };
  return { text: '', nodes: [] };
}

const UI_SELECTOR = 'a[href], button, [role="button"], [role="link"], [onclick], [class*="btn"], [class*="button"]';

/**
 * Test UI around a question: links, buttons, clickable short blocks ("Перейти"), flag labels.
 * Their text is never part of the question.
 */
export function isUiElement(el: Element): boolean {
  if (el.matches(UI_SELECTOR) && !el.querySelector(CONTROL_SELECTOR)) return true;
  const text = el.textContent ?? '';
  if (el.tagName === 'LABEL') return FLAG_RE.test(normalizeSpace(text));
  if (text.length > 40 || el.querySelector(CONTROL_SELECTOR)) return false;
  try {
    const view = el.ownerDocument.defaultView;
    if (!view) return false;
    if (view.getComputedStyle(el).cursor !== 'pointer') return false;
    const parent = el.parentElement;
    // cursor is inherited: only the outermost element of the clickable block counts
    return !parent || view.getComputedStyle(parent).cursor !== 'pointer';
  } catch {
    return false;
  }
}

const QUESTION_TEXT_SELECTOR =
  '.qtext, .question-text, .question_text, .questiontext, [class*="question-title"], [data-question-text]';

/**
 * Climbs from the group's common ancestor until it finds text that is not an option label.
 * Never climbs into a container that holds controls of another question.
 */
function questionTextFor(
  start: Element,
  groupEls: Set<Element>,
  exclude: Set<Node>,
  controlGroup: Map<Element, string>,
  groupKey: string,
  /** elements whose text is never part of a question: test UI, hidden blocks */
  skipText: (el: Element) => boolean = isUiElement,
): string {
  const ownsOnly = (el: Element) =>
    Array.from(el.querySelectorAll(CONTROL_SELECTOR)).every((c) => {
      const g = controlGroup.get(c);
      return g === undefined || g === groupKey || groupEls.has(c);
    });

  // fieldset > legend / role=radiogroup labels win
  const fs = start.closest('fieldset');
  if (fs && ownsOnly(fs)) {
    const legend = fs.querySelector(':scope > legend');
    if (legend) {
      const t = stripInstructions(textOf(legend, new Set(), skipText));
      if (t.length >= 2) return t;
    }
  }
  const rg = start.closest('[role="radiogroup"], [role="group"]');
  if (rg && ownsOnly(rg)) {
    const l = rg.getAttribute('aria-labelledby');
    const r = l ? idsText(rg.ownerDocument, l) : null;
    if (r?.text) return stripInstructions(r.text);
    const al = rg.getAttribute('aria-label');
    if (al) return normalizeSpace(al);
  }

  let candidate: Element = start;
  for (let depth = 0; depth < 12; depth++) {
    const explicit = candidate.querySelector(QUESTION_TEXT_SELECTOR);
    if (explicit && !hasAncestorIn(explicit, exclude, candidate)) {
      const t = stripInstructions(textOf(explicit, exclude, skipText));
      if (t.length >= 2) return t;
    }
    const own = stripInstructions(textOf(candidate, exclude, skipText));
    if (own.length >= 2) return own.slice(0, 2000);

    const parent = candidate.parentElement;
    if (!parent || parent === candidate.ownerDocument.documentElement) break;
    if (!ownsOnly(parent)) {
      // Parent mixes several questions: take text from preceding siblings of `candidate`.
      const parts: string[] = [];
      let prev = candidate.previousElementSibling;
      while (prev && parts.length < 3) {
        if (prev.querySelector(CONTROL_SELECTOR) || prev.matches(CONTROL_SELECTOR)) break;
        const t = stripInstructions(textOf(prev, exclude, skipText));
        if (t) parts.unshift(t);
        prev = prev.previousElementSibling;
      }
      return normalizeSpace(parts.join(' ')).slice(0, 2000);
    }
    candidate = parent;
  }
  return '';
}

// Lines that sit near a question but are not the question itself.
const NOISE_RE =
  /^(?:(?:вопрос|задание|question)\s*№?\s*\d+(?:\s*(?:из|of|\/)\s*\d+)?|\d+\s*(?:из|of|\/)\s*\d+|(?:баллов|балл|оценка|mark(?:ed)?(?:\s+out\s+of)?|points?)\s*:?\s*[\d.,\s]*(?:из\s*[\d.,]+)?|пока нет ответа|нет ответа|not yet answered|answer saved|ответ сохранен|отметить вопрос|flag question|осталось времени.*|time left.*|\d{1,2}:\d{2}(?::\d{2})?)[.:]?$/i;

const FLAG_RE =
  /^(?:отметить|пометить|флаг|flag|mark|bookmark)(?:\s+(?:вопрос|этот вопрос|question|this question|for review|для проверки|для просмотра))?$|^(?:вернуться\s+позже|не\s+уверен[а]?|в\s+закладки|закладка)$/i;

export function isNoiseText(s: string): boolean {
  const t = normalizeSpace(s);
  return !t || NOISE_RE.test(t);
}

/** Text found for a question is useless: empty, only "Question 3 of 10"-like labels, or an option label. */
function isWeakQuestionText(text: string, optionTexts: string[]): boolean {
  const t = normalizeSpace(stripInstructions(text));
  if (t.length < 3 || isNoiseText(t)) return true;
  const low = t.toLowerCase();
  return optionTexts.some((o) => o && o.toLowerCase() === low);
}

/**
 * Fallback: the text right above the first option, read backwards in document order up to the
 * previous question's last option (or the site header). Works for layouts where the question
 * text is not in a common container with the options.
 */
function precedingText(
  doc: Document,
  start: Node,
  boundary: Node | null,
  exclude: Set<Node>,
  isVisible: (el: Element) => boolean,
  ignore: (el: Element) => boolean,
): string {
  const root = doc.body ?? doc.documentElement;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  walker.currentNode = start;
  const visible = new Map<Element, boolean>();
  const ui = new Map<Element, boolean>();
  const inUi = (el: Element | null): boolean => {
    const chain: Element[] = [];
    let res = false;
    for (let e = el; e && e !== root; e = e.parentElement) {
      const known = ui.get(e);
      if (known !== undefined) {
        res = known;
        break;
      }
      chain.push(e);
      if (isUiElement(e)) {
        res = true;
        break;
      }
    }
    chain.forEach((e) => ui.set(e, res));
    return res;
  };
  const isVis = (el: Element) => {
    let v = visible.get(el);
    if (v === undefined) visible.set(el, (v = isVisible(el)));
    return v;
  };
  const blocks: string[] = [];
  let curBlock: Element | null = null;
  let cur: string[] = [];
  let total = 0;
  const flush = (): boolean => {
    const t = stripInstructions(normalizeSpace(cur.reverse().join(' ')));
    cur = [];
    if (!t || isNoiseText(t)) return false;
    blocks.unshift(t);
    total += t.length;
    // enough: a real sentence, a line ending like a question, or three blocks
    return total >= 15 || /[?:]$/.test(t) || blocks.length >= 3;
  };
  let n = walker.previousNode();
  let scanned = 0;
  while (n && scanned++ < 400) {
    if (boundary && (boundary === n || boundary.contains(n) || boundary.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING)) break;
    const p = n.parentElement;
    const value = n.nodeValue ?? '';
    if (p && value.trim()) {
      if (p.closest(SITE_CHROME)) break;
      const skip =
        SKIP_TEXT_TAGS.has(p.tagName.toUpperCase()) ||
        !!p.closest('script, style, noscript, template, button, [aria-hidden="true"]') ||
        ignore(p) ||
        hasAncestorIn(n, exclude, root) ||
        !isVis(p) ||
        inUi(p);
      if (!skip) {
        let block: Element | null = p;
        while (block && !BLOCK_TAGS.has(block.tagName.toUpperCase())) block = block.parentElement;
        if (block !== curBlock && cur.length) {
          if (flush()) break;
        }
        curBlock = block;
        cur.push(value);
        if (total + cur.join('').length > 1500) break;
      }
    }
    n = walker.previousNode();
  }
  if (cur.length) flush();
  return normalizeSpace(blocks.join(' ')).slice(0, 2000);
}

function selectOptions(sel: HTMLSelectElement): AnswerOption[] {
  const opts: AnswerOption[] = [];
  Array.from(sel.options).forEach((o, i) => {
    const text = normalizeSpace(o.textContent ?? '');
    const isPlaceholder =
      (o.value === '' && i === 0) ||
      (o.disabled && i === 0) ||
      (i === 0 && /^(выберите|select|choose|--|—)/i.test(text));
    if (isPlaceholder || !text) return;
    opts.push({ id: `option_${opts.length + 1}`, text, value: o.value });
  });
  return opts;
}

function signature(opts: AnswerOption[]): string {
  return opts.map((o) => o.text.toLowerCase()).join('\n'); // option texts are single-line
}

const SITE_CHROME = 'header, nav, footer, [role="search"], [role="navigation"], [role="banner"], [role="contentinfo"]';
const SEARCH_RE = /(поиск|search|найти)/i;

/** Site search boxes, menus and footers are not part of the test. */
export function isSiteChrome(el: Element): boolean {
  if (el.closest(SITE_CHROME)) return true;
  if (el.tagName !== 'INPUT') return false;
  if ((el.getAttribute('type') ?? '').toLowerCase() === 'search') return true;
  const name = el.getAttribute('name') ?? '';
  const hint = `${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
  return /^(q|s|query|search)$/i.test(name) || SEARCH_RE.test(hint);
}

export interface DomRecognition {
  questions: Question[];
  warnings: string[];
}

export function recognizeDom(doc: Document, options: RecognizeOptions): DomRecognition {
  const isVisible = options.isVisible ?? (() => true);
  const ignore = options.ignore ?? (() => false);
  const warnings: string[] = [];

  // 1. All controls of the page (boundaries need the full picture), in document order.
  const all: Control[] = [];
  Array.from(doc.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).forEach((el, i) => {
    if (ignore(el) || isSiteChrome(el)) return;
    const kind = controlKind(el);
    if (!kind) return;
    if (el.tagName === 'INPUT' && (el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'checkbox')) {
      // native input with role: treat as native
    }
    const labels = (el as HTMLInputElement).labels;
    const visible = isVisible(el) || (labels ? Array.from(labels).some((l) => isVisible(l)) : false);
    if (!visible) return;
    // "Flag question" / "Отметить вопрос" checkboxes belong to the test UI, not to the question
    if ((kind === 'checkbox' || kind === 'aria-checkbox') && FLAG_RE.test(labelOf(el, new Set()).text)) return;
    all.push({ el, kind, groupKey: groupKeyFor(el, kind, i) });
  });

  const controlGroup = new Map<Element, string>(all.map((c) => [c.el, c.groupKey]));
  const allSet = new Set<Element>(all.map((c) => c.el));
  // hidden cards of other questions (one-at-a-time tests) and buttons are not question text
  const hidden = new Map<Element, boolean>();
  const skipText = (el: Element): boolean => {
    let h = hidden.get(el);
    if (h === undefined) hidden.set(el, (h = !isVisible(el)));
    return h || isUiElement(el);
  };

  /** Question text when the container climb found nothing usable: read the text above the first control. */
  const fallbackText = (els: Element[], groupEls: Set<Element>, exclude: Set<Node>): string => {
    const idx = all.findIndex((c) => c.el === els[0]);
    let boundary: Node | null = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (groupEls.has(all[i].el)) continue;
      const prev = all[i].el;
      const nodes = labelOf(prev, allSet).nodes;
      // the previous question ends at its last option label (or the control itself)
      boundary = nodes.reduce<Node>(
        (last, nd) => (last.compareDocumentPosition(nd) & Node.DOCUMENT_POSITION_FOLLOWING ? nd : last),
        prev,
      );
      break;
    }
    // start at the earliest node of the options block (a label may come before its control)
    let start: Node = els[0];
    for (const nd of [...els, ...exclude]) {
      if (nd.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING) start = nd;
    }
    return precedingText(doc, start, boundary, exclude, isVisible, ignore);
  };
  /** Question text from the site rule the user taught ("это текст вопроса"), or ''. */
  // which taught question element each group sits under (key: the group's first control)
  const ruleOwner = new Map<Element, Element>();
  // the same, for the rare layout with one question text placed after its answers
  const ruleAfter = new Map<Element, Element>();
  const ruleText = (els: Element[], _groupEls: Set<Element>, exclude: Set<Node>): string => {
    if (!options.questionSelector) return '';
    let first: Element = els[0];
    for (const nd of exclude) {
      if (nd.nodeType === Node.ELEMENT_NODE && nd.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING && !(nd as Element).contains(first))
        first = nd as Element;
    }
    // no boundary: a group that sits under another group's question text still points at it,
    // and step 5 keeps only the first group under each question text
    let el = ruleElementFor(doc, options.questionSelector, first, null, isVisible, false);
    if (el) ruleOwner.set(els[0], el);
    else if ((el = ruleElementFor(doc, options.questionSelector, first, null, isVisible))) ruleAfter.set(els[0], el);
    if (!el || ignore(el)) return '';
    return normalizeSpace(stripInstructions(textOf(el, exclude, (e) => e !== el && skipText(e)))).slice(0, 2000);
  };
  const ensureText = (text: string, optionTexts: string[], els: Element[], groupEls: Set<Element>, exclude: Set<Node>): string => {
    const taught = ruleText(els, groupEls, exclude);
    if (taught.length >= 2) return taught;
    if (!isWeakQuestionText(text, optionTexts)) return text;
    const alt = fallbackText(els, groupEls, exclude);
    return alt && !isWeakQuestionText(alt, optionTexts) ? alt : isNoiseText(text) ? '' : text;
  };

  // 2. Group, keep groups with at least one control inside the region.
  const groups = new Map<string, Group>();
  for (const c of all) {
    let g = groups.get(c.groupKey);
    if (!g) groups.set(c.groupKey, (g = { key: c.groupKey, kind: c.kind, controls: [] }));
    g.controls.push(c);
  }
  const within = options.inRegion ?? (() => true);
  const inRegion = (c: Control) => {
    if (within(c.el)) return true;
    const labels = (c.el as HTMLInputElement).labels;
    return labels ? Array.from(labels).some((l) => within(l)) : false;
  };
  const selected = Array.from(groups.values()).filter((g) => g.controls.some(inRegion));

  // 3. Merge runs of identical selects into matching questions.
  type Built = { order: Element; q: Omit<Question, 'id'> };
  const built: Built[] = [];
  const consumed = new Set<string>();

  const selectGroups = selected.filter((g) => g.kind === 'select');
  for (let i = 0; i < selectGroups.length; i++) {
    const g = selectGroups[i];
    if (consumed.has(g.key)) continue;
    const sel = g.controls[0].el as HTMLSelectElement;
    const sig = signature(selectOptions(sel));
    if (selectOptions(sel).length < 2) continue;
    const run = [g];
    for (let j = i + 1; j < selectGroups.length; j++) {
      const next = selectGroups[j];
      const nextSel = next.controls[0].el as HTMLSelectElement;
      // must be adjacent among all controls and share the option list
      const prevEl = run[run.length - 1].controls[0].el;
      const between = all.slice(all.findIndex((c) => c.el === prevEl) + 1, all.findIndex((c) => c.el === nextSel));
      if (between.length || signature(selectOptions(nextSel)) !== sig) break;
      run.push(next);
    }
    if (run.length < 2) continue;
    const els = run.map((r) => r.controls[0].el);
    const lca = lowestCommonAncestor(els);
    const lcaOnlyRun = Array.from(lca.querySelectorAll(CONTROL_SELECTOR)).every((c) => !allSet.has(c) || els.includes(c as HTMLElement));
    if (!lcaOnlyRun) continue;

    const rows = els.map((el) => {
      let row: Element = el;
      while (row.parentElement && row.parentElement !== lca) row = row.parentElement;
      return row;
    });
    const itemLabels = els.map((el, k) => {
      const l = labelOf(el, allSet);
      if (l.text) return l;
      const t = textOf(rows[k]);
      return { text: t, nodes: [rows[k]] };
    });
    const inTable = !!lca.closest('table, dl') || lca.tagName === 'TBODY' || lca.tagName === 'TABLE';
    const shortItems = itemLabels.every((l) => l.text.length > 0 && l.text.length < 80 && !/\?\s*$/.test(l.text));
    const exclude = new Set<Node>([...rows, ...itemLabels.flatMap((l) => l.nodes)]);
    const shared = stripInstructions(textOf(lca, exclude));
    if (!(inTable || (shortItems && shared.length >= 2))) continue;

    run.forEach((r) => consumed.add(r.key));
    const opts = selectOptions(sel);
    const items: MatchItem[] = els.map((el, k) => ({ id: '', text: itemLabels[k].text, selector: uniqueSelector(el) }));
    const text = ensureText(
      questionTextFor(lca, new Set(els), exclude, controlGroup, '__matching__', skipText),
      [...opts.map((o) => o.text), ...itemLabels.map((l) => l.text)],
      els,
      new Set(els),
      exclude,
    );
    built.push({
      order: els[0],
      q: { type: 'matching', text, options: opts, items, target: 'select', source: 'dom' },
    });
  }

  // 4. Everything else.
  for (const g of selected) {
    if (consumed.has(g.key)) continue;
    const els = g.controls.map((c) => c.el);
    const groupEls = new Set<Element>(els);

    if (g.kind === 'select' || g.kind === 'text') {
      const el = els[0];
      const label = labelOf(el, allSet);
      const exclude = new Set<Node>([el, ...label.nodes]);
      let text = label.text;
      // A missing or generic label ("Ответ:") is not the question: look at the surrounding text.
      if (!text || /^(ответ|answer|ваш ответ|your answer)\s*:?$/i.test(text)) {
        text = questionTextFor(el, groupEls, exclude, controlGroup, g.key, skipText) || text;
      }
      text = ensureText(text, [], els, groupEls, exclude);
      if (g.kind === 'select') {
        const opts = selectOptions(el as HTMLSelectElement);
        if (!opts.length) {
          warnings.push('Найден выпадающий список без вариантов, пропущен.');
          continue;
        }
        built.push({
          order: el,
          q: { type: 'dropdown', text, options: opts, target: 'select', selector: uniqueSelector(el), source: 'dom' },
        });
      } else {
        built.push({
          order: el,
          q: { type: 'text', text, options: [], target: 'text', selector: uniqueSelector(el), source: 'dom' },
        });
      }
      continue;
    }

    // radio / checkbox groups
    const labels = els.map((el) => labelOf(el, allSet));
    const optionNodes = new Set<Node>([...els, ...labels.flatMap((l) => l.nodes)]);
    const lca = lowestCommonAncestor([...els, ...labels.flatMap((l) => l.nodes.filter((n): n is Element => n.nodeType === 1))]);
    const optionTexts = labels.map((l) => l.text);
    const text = ensureText(questionTextFor(lca, groupEls, optionNodes, controlGroup, g.key, skipText), optionTexts, els, groupEls, optionNodes);
    const options: AnswerOption[] = els.map((el, k) => ({
      id: `option_${k + 1}`,
      text: labels[k].text || (el.getAttribute('value') ?? `Вариант ${k + 1}`),
      selector: uniqueSelector(el),
    }));
    if (labels.some((l) => !l.text)) warnings.push(`У части вариантов не найден текст (вопрос «${text.slice(0, 40)}»).`);

    const target: TargetKind = g.kind;
    let type: Question['type'];
    if (g.kind === 'radio' || g.kind === 'aria-radio') type = isTrueFalse(options.map((o) => o.text)) ? 'true_false' : 'single';
    else type = 'multiple';
    built.push({ order: els[0], q: { type, text, options, target, source: 'dom' } });
  }

  // 5. Order by position in the document and assign ids.
  built.sort((a, b) => (a.order.compareDocumentPosition(b.order) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  let kept = built;
  if (options.questionSelector && (ruleOwner.size || ruleAfter.size)) {
    const owners = ruleOwner.size ? ruleOwner : ruleAfter;
    // The user showed where the question text is: a question is the first group of answers under
    // such a text. Groups with no question text above them (site menus, question navigators,
    // flags) and extra groups under an already used text are not questions.
    const used = new Set<Element>();
    kept = built.filter((b) => {
      const owner = owners.get(b.order);
      if (!owner || used.has(owner)) return false;
      used.add(owner);
      return true;
    });
  }
  const questions: Question[] = kept.map((b, i) => {
    const id = `q${i + 1}`;
    const q: Question = { ...b.q, id };
    if (q.items) q.items = q.items.map((it, k) => ({ ...it, id: `${id}_item_${k + 1}` }));
    if (!q.text) warnings.push(`Для ${id} не найден текст вопроса.`);
    return q;
  });
  return { questions, warnings };
}
