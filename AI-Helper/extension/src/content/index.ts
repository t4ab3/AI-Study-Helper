import type { ContentEvent, ContentRequest, Envelope } from '../shared/messages';
import type { LearnedNext, NextCandidate, QuestionRule, RecognitionResult } from '../shared/types';
import { applyPlan } from './fill';
import {
  buttonLabel,
  clickFinish,
  clickNext,
  buttonFromTarget,
  clickableOf,
  describeLearned,
  findFinishCandidates,
  findLearned,
  findNextCandidates,
  isFinishLabel,
} from './navigation';
import { uniqueSelector } from '../shared/selectors';
import { normalizeSpace, recognizeDom } from './recognize';
import { buildQuestionSelector, questionElementFromRange } from './questionRule';
import { PageOverlay, siteKey } from './overlay';
import { HOTKEYS_KEY, isTypingTarget, matchesHotkey, normalizeHotkeys, type Hotkeys } from '../shared/hotkeys';

declare global {
  interface Window {
    __aiHelper?: { alive: () => boolean };
  }
}

function send(event: ContentEvent): void {
  try {
    chrome.runtime.sendMessage(event).catch(() => undefined);
  } catch {
    /* extension reloaded; nothing to notify */
  }
}

function isVisible(el: Element): boolean {
  const anyEl = el as HTMLElement & { checkVisibility?: (o?: object) => boolean };
  if (typeof anyEl.checkVisibility === 'function') {
    // opacity:0 inputs (custom-styled radios) still count; their labels carry the visuals
    return anyEl.checkVisibility({ visibilityProperty: true });
  }
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
}

function init(): void {
  const overlay = new PageOverlay();
  const ignore = (el: Element) => overlay.isOwn(el);

  // ---------- "Next" button learned from the user's click ----------
  const nextKey = () => `nextButton:${siteKey()}`;
  let learning = false;

  // ---------- "this is the question text" rule taught from the context menu ----------
  const ruleKey = () => `questionRule:${siteKey()}`;
  let questionRule: QuestionRule | null = null;
  async function loadRule(): Promise<QuestionRule | null> {
    try {
      const k = ruleKey();
      questionRule = ((await chrome.storage.local.get(k))[k] as QuestionRule | undefined) ?? null;
    } catch {
      questionRule = null;
    }
    return questionRule;
  }
  async function teachQuestion(): Promise<{ ok: boolean; message: string; rule?: QuestionRule; matches?: number }> {
    const fail = (message: string) => {
      overlay.notice(message, true);
      send({ kind: 'QUESTION_RULE_FAILED', message });
      return { ok: false, message };
    };
    const sel = window.getSelection();
    const text = normalizeSpace(sel?.toString() ?? '');
    if (!sel || !sel.rangeCount || !text) return fail('Сначала выделите на странице текст вопроса.');
    const el = questionElementFromRange(sel.getRangeAt(0));
    if (!el || ignore(el))
      return fail('Не удалось определить, где на странице лежит текст вопроса. Выделите только текст вопроса, без вариантов ответа.');
    const selector = buildQuestionSelector(el);
    if (!selector) return fail('Не получилось составить правило для этого текста. Попробуйте выделить текст вопроса целиком.');
    const rule: QuestionRule = { selector, sample: text.slice(0, 120), url: location.href, savedAt: Date.now() };
    await chrome.storage.local.set({ [ruleKey()]: rule });
    questionRule = rule;
    const matches = Array.from(document.querySelectorAll(selector)).filter((m) => isVisible(m));
    overlay.highlight(matches.map((m) => ({ rect: m.getBoundingClientRect(), label: 'вопрос', uncheck: false })));
    setTimeout(() => overlay.clearHighlights(), 3500);
    overlay.notice('Запомнил, где на этом сайте текст вопроса. Теперь он будет браться отсюда на каждом вопросе.');
    send({ kind: 'QUESTION_RULE_SAVED', rule, matches: matches.length });
    return { ok: true, message: 'Правило сохранено', rule, matches: matches.length };
  }
  async function loadLearned(): Promise<LearnedNext | null> {
    try {
      const k = nextKey();
      return ((await chrome.storage.local.get(k))[k] as LearnedNext | undefined) ?? null;
    } catch {
      return null;
    }
  }
  function onLearnClick(e: Event): void {
    if (!learning) return;
    const t = e.target;
    if (!(t instanceof Element) || ignore(t)) return;
    const el = clickableOf(t);
    if (!el) return; // a click on an answer or on text: keep waiting
    const text = buttonLabel(el);
    if (isFinishLabel(text)) {
      send({ kind: 'NEXT_LEARN_REJECTED', text });
      return;
    }
    learning = false;
    const learned = describeLearned(el);
    // pointerdown comes before the click and the navigation, so the write starts in time
    chrome.storage.local.set({ [nextKey()]: learned }).catch(() => undefined);
    send({ kind: 'NEXT_LEARNED', learned });
  }
  // "это кнопка «Далее»" from the context menu: the element that was right-clicked
  let menuTarget: Element | null = null;
  document.addEventListener(
    'contextmenu',
    (e) => {
      menuTarget = e.target instanceof Element ? e.target : null;
    },
    true,
  );
  async function teachNext(
    t: Element | null = menuTarget,
    how: 'menu' | 'key' = 'menu',
  ): Promise<{ ok: boolean; message: string; learned?: LearnedNext }> {
    const fail = (message: string) => {
      overlay.notice(message, true);
      send({ kind: 'NEXT_TEACH_FAILED', message });
      return { ok: false, message };
    };
    const where = how === 'key' ? 'Наведите курсор прямо на кнопку «Далее» и нажмите клавишу ещё раз.' : 'Нажмите правой кнопкой прямо на кнопку «Далее» и выберите пункт ещё раз.';
    if (!t || !t.isConnected || ignore(t)) return fail(where);
    const el = buttonFromTarget(t);
    if (!el) return fail(`Это похоже на вариант ответа или на текст, а не на кнопку. ${where}`);
    const text = buttonLabel(el);
    if (isFinishLabel(text)) {
      send({ kind: 'NEXT_LEARN_REJECTED', text });
      return fail(`«${text}» завершает тест. Такую кнопку программа не нажимает сама.`);
    }
    const learned = describeLearned(el);
    await chrome.storage.local.set({ [nextKey()]: learned });
    learning = false;
    overlay.highlight([{ rect: el.getBoundingClientRect(), label: 'Далее', uncheck: false }]);
    setTimeout(() => overlay.clearHighlights(), 3500);
    overlay.notice(`Запомнил кнопку «${learned.text || 'без текста'}». Дальше программа будет нажимать её сама.`);
    send({ kind: 'NEXT_LEARNED', learned });
    return { ok: true, message: 'Кнопка сохранена', learned };
  }
  // ---------- keyboard shortcuts (for sites that block the right-click menu) ----------
  let hotkeys: Hotkeys = normalizeHotkeys(null);
  chrome.storage.local
    .get(HOTKEYS_KEY)
    .then((v) => (hotkeys = normalizeHotkeys(v[HOTKEYS_KEY])))
    .catch(() => undefined);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[HOTKEYS_KEY]) hotkeys = normalizeHotkeys(changes[HOTKEYS_KEY].newValue);
  });
  // the element under the mouse: the "Next" shortcut teaches that one
  let pointer: { x: number; y: number; target: Element | null; inside: boolean } = { x: -1, y: -1, target: null, inside: false };
  const onPointer = (e: PointerEvent | MouseEvent) => {
    pointer = { x: e.clientX, y: e.clientY, target: e.target instanceof Element ? e.target : null, inside: true };
  };
  document.addEventListener('pointermove', onPointer, { capture: true, passive: true });
  document.addEventListener('mouseover', onPointer, { capture: true, passive: true });
  // the mouse went to the side panel or out of the window: nothing is hovered on the page
  document.addEventListener(
    'mouseout',
    (e) => {
      if (!e.relatedTarget) pointer.inside = false;
    },
    { capture: true, passive: true },
  );
  function hovered(): Element | null {
    if (!pointer.inside) return null;
    const at = pointer.x >= 0 ? document.elementFromPoint(pointer.x, pointer.y) : null;
    return at && !ignore(at) ? at : pointer.target;
  }
  /** true when the key was ours */
  function onHotkey(e: KeyboardEvent): boolean {
    if (!hotkeys.enabled || e.isComposing) return false;
    // typing an answer must stay typing
    const active = document.activeElement;
    if (isTypingTarget(e.target instanceof Element ? e.target : null) || isTypingTarget(active)) return false;
    if (matchesHotkey(e, hotkeys.question)) {
      // without a selection the key is left to the site (K pauses a YouTube video, for example)
      if (!normalizeSpace(window.getSelection()?.toString() ?? '')) return false;
      teachQuestion().catch(() => undefined);
      return true;
    }
    if (matchesHotkey(e, hotkeys.next)) {
      const t = hovered();
      // nothing clickable under the mouse: not meant for us (M mutes a YouTube video, for example)
      if (!t || ignore(t) || !buttonFromTarget(t)) return false;
      teachNext(t, 'key').catch(() => undefined);
      return true;
    }
    return false;
  }
  // Some sites swallow keydown (the same scripts that block the right-click menu). keyup is the
  // fallback: a key whose keydown never reached us is handled when it is released.
  const downSeen = new Set<string>();
  window.addEventListener(
    'keydown',
    (e) => {
      downSeen.add(e.code);
      if (e.repeat) return;
      if (onHotkey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (downSeen.delete(e.code)) return;
      if (onHotkey(e)) e.stopPropagation();
    },
    true,
  );
  window.addEventListener('blur', () => downSeen.clear());

  document.addEventListener('pointerdown', onLearnClick, true);
  document.addEventListener('click', onLearnClick, true);

  function recognize(): RecognitionResult {
    // The whole page is scanned; hidden questions are skipped by isVisible, so tests that reveal
    // one question at a time work naturally.
    const dom = recognizeDom(document, { inRegion: () => true, isVisible, ignore, questionSelector: questionRule?.selector });
    return { mode: dom.questions.length ? 'dom' : 'none', questions: dom.questions, rawText: '', warnings: dom.warnings };
  }

  async function handle(msg: ContentRequest): Promise<unknown> {
    switch (msg.kind) {
      case 'PING':
        return { ok: true, url: location.href };
      case 'RECOGNIZE':
        overlay.clearHighlights();
        await loadRule();
        return recognize();
      case 'CLEAR_HIGHLIGHT':
        overlay.clearHighlights();
        return { ok: true };
      case 'FILL': {
        overlay.clearHighlights();
        return { report: applyPlan(document, msg.plan) };
      }
      case 'FIND_NEXT': {
        let candidates: NextCandidate[] = findNextCandidates(document, isVisible, ignore);
        const learned = await loadLearned();
        const el = learned && findLearned(document, learned, isVisible, ignore);
        if (el) {
          const selector = uniqueSelector(el);
          const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
          const own: NextCandidate = { selector, text: buttonLabel(el) || learned!.text || 'Далее', learned: true };
          if (disabled) own.disabled = true;
          const rest = candidates.filter((c) => c.selector !== selector);
          candidates = disabled ? [...rest.filter((c) => !c.disabled), own, ...rest.filter((c) => c.disabled)] : [own, ...rest];
        }
        return { candidates };
      }
      case 'CLICK_NEXT': {
        overlay.clearHighlights();
        const learned = await loadLearned();
        return clickNext(document, msg.selector, learned ? findLearned(document, learned, isVisible, ignore) : null);
      }
      case 'NEXT_LEARN_START':
        learning = true;
        return { ok: true, key: nextKey() };
      case 'NEXT_LEARN_CANCEL':
        learning = false;
        return { ok: true };
      case 'NEXT_GET':
        return { learned: await loadLearned() };
      case 'NEXT_FORGET':
        await chrome.storage.local.remove(nextKey());
        return { ok: true };
      case 'TEACH_QUESTION':
        return teachQuestion();
      case 'TEACH_NEXT':
        return teachNext(menuTarget, 'menu');
      case 'HOTKEY':
        // the key went to the side panel; the selection and the mouse are still on the page
        if (msg.action === 'question') return teachQuestion();
        return teachNext(hovered(), 'key');
      case 'QUESTION_RULE_GET':
        return { rule: await loadRule() };
      case 'QUESTION_RULE_FORGET':
        await chrome.storage.local.remove(ruleKey());
        questionRule = null;
        return { ok: true };
      case 'FIND_FINISH':
        return { candidates: findFinishCandidates(document, isVisible, ignore) };
      case 'CLICK_FINISH':
        return clickFinish(document, msg.selector);
    }
  }

  chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || !('kind' in msg)) return false;
    handle(msg)
      .then((data) => sendResponse({ ok: true, data } satisfies Envelope<unknown>))
      .catch((e: unknown) => sendResponse({ ok: false, error: (e as Error)?.message ?? String(e) } satisfies Envelope<unknown>));
    return true;
  });

  window.__aiHelper = { alive: () => !!chrome.runtime?.id };
}

// Declared content script + on-demand injection may both run; keep a single live instance.
if (!window.__aiHelper?.alive()) init();
