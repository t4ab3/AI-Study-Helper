import type {
  FillPlanItem,
  FillReportItem,
  NextCandidate,
  Question,
  RecognitionResult,
  ValidationReport,
} from '../shared/types';
import { parseAnswerText, validateAnswers } from '../shared/answers';
import { buildAutoPrompt, buildCorrectionPrompt } from '../shared/prompt';
import { buildFillPlan } from '../shared/plan';
import { fingerprint, renumber } from '../shared/fingerprint';

/*
  Automatic mode: read → ask DeepSeek → validate → fill → verify → "Next" → wait for a new
  question → repeat. Runs until no new question appears. Never presses the final "finish /
  submit" button (it only reports it), never picks an option DeepSeek did not clearly give.
*/

export type AutoPhase = 'idle' | 'running' | 'paused' | 'waiting_user' | 'finished' | 'error' | 'stopped';
export type AutoStep = 'connect' | 'read' | 'send' | 'wait' | 'process' | 'fill' | 'next';
export type DeepSeekState = 'unknown' | 'ready' | 'login_required' | 'captcha' | 'ui_changed' | 'offline';

export interface AutoAction {
  t: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface AutoState {
  phase: AutoPhase;
  step: AutoStep | null;
  deepseek: DeepSeekState;
  /** Run-wide numbers of the questions being worked on: [from, to]. */
  current: [number, number] | null;
  processed: number;
  processedFingerprints: string[];
  failed: { text: string; reason: string }[];
  lowConfidence: string[];
  actions: AutoAction[];
  message: string | null;
  finishCandidates: NextCandidate[];
  /** Questions without page controls (text/OCR): answer shown, the user picks it and resumes. */
  displayOnly: { fingerprints: string[]; answers: string[] } | null;
  asks: number;
  /** Times the run moved to another question (Next pressed, or a question was revealed). */
  navigations: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export const STEP_TEXT: Record<AutoStep, string> = {
  connect: 'Проверяю DeepSeek',
  read: 'Считываю вопрос',
  send: 'Отправляю вопрос в DeepSeek',
  wait: 'Ожидаю ответ DeepSeek',
  process: 'Обрабатываю ответ',
  fill: 'Заполняю ответ',
  next: 'Перехожу к следующему вопросу',
};

export function initialAutoState(): AutoState {
  return {
    phase: 'idle',
    step: null,
    deepseek: 'unknown',
    current: null,
    processed: 0,
    processedFingerprints: [],
    failed: [],
    lowConfidence: [],
    actions: [],
    message: null,
    finishCandidates: [],
    displayOnly: null,
    asks: 0,
    navigations: 0,
    startedAt: null,
    finishedAt: null,
  };
}

export interface DeepSeekCheck {
  ready: boolean;
  reason: string | null;
  message: string;
}

export interface AutoDeps {
  scan(): Promise<RecognitionResult>;
  checkDeepSeek(): Promise<DeepSeekCheck>;
  ask(prompt: string, newChat: boolean): Promise<string>;
  cancelAsk(): Promise<void>;
  fill(plan: FillPlanItem[]): Promise<FillReportItem[]>;
  findNext(): Promise<NextCandidate[]>;
  clickNext(selector: string): Promise<{ ok: boolean; message: string }>;
  findFinish(): Promise<NextCandidate[]>;
  /** Remember the next button the user clicks on the page (optional: without it the run just ends). */
  armLearnNext?(): Promise<void>;
  /** The button the user clicked since armLearnNext, or null. */
  learnedNext?(): Promise<{ text: string } | null>;
  cancelLearnNext?(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const TIMING = {
  pollMs: 400,
  /** wait for a new question after "Next" */
  navTimeoutMs: 25_000,
  /** wait for a question revealed on the same page (no "Next" button) */
  revealTimeoutMs: 4_000,
  loginPollMs: 3_000,
  loginTimeoutMs: 10 * 60_000,
  /** how long to wait for the user to press "Next" once */
  learnTimeoutMs: 10 * 60_000,
  waitLabelDelayMs: 1_200,
  maxAskAttempts: 3,
  maxTransientRetries: 3,
  maxRounds: 300,
  newChatEvery: 12,
  /** pause between stages (read → ask → fill → next), so the site and DeepSeek keep up */
  stepPauseMs: 2_500,
};

class Halt extends Error {
  constructor(public kind: 'pause' | 'stop') {
    super(kind);
  }
}

class Fatal extends Error {}

function errCode(e: unknown): string {
  return (e as { code?: string })?.code ?? '';
}

const TRANSIENT = new Set(['timeout', 'busy', 'empty_answer', 'send_failed', 'http_error', 'internal_error', 'webdriver_error']);
const WAIT_FOR_USER = new Set(['login_required', 'captcha']);

export class AutoRunner {
  private stopReq = false;
  private pauseReq = false;
  private loop: Promise<void> | null = null;
  /** How many questions the last solved page had. */
  private lastBatch = 0;

  constructor(
    private deps: AutoDeps,
    private s: AutoState,
    private emit: (s: AutoState) => void,
  ) {}

  get state(): AutoState {
    return this.s;
  }

  get busy(): boolean {
    return this.loop !== null;
  }

  // ---------- controls ----------

  start(): Promise<void> {
    if (this.loop) return this.loop;
    this.s = { ...initialAutoState(), deepseek: this.s.deepseek, startedAt: this.deps.now() };
    this.log('info', 'Автоматическое решение запущено');
    return this.launch();
  }

  resume(): Promise<void> {
    if (this.loop) return this.loop;
    if (this.s.displayOnly) {
      // the user answered the display-only questions by hand
      this.markProcessed(this.s.displayOnly.fingerprints);
      this.log('info', 'Продолжаю после ручного ответа');
      this.set({ displayOnly: null });
    } else this.log('info', 'Продолжаю');
    return this.launch();
  }

  pause(): void {
    if (!this.loop) return;
    this.pauseReq = true;
    this.deps.cancelAsk().catch(() => undefined);
  }

  stop(): void {
    this.stopReq = true;
    if (this.loop) this.deps.cancelAsk().catch(() => undefined);
    else if (this.s.phase !== 'idle') {
      this.set({ phase: 'stopped', step: null, message: null });
      this.log('info', 'Остановлено');
    }
  }

  private launch(): Promise<void> {
    this.stopReq = false;
    this.pauseReq = false;
    this.set({ phase: 'running', message: null, finishedAt: null });
    this.loop = this.run().finally(() => {
      this.loop = null;
    });
    return this.loop;
  }

  // ---------- state helpers ----------

  private set(patch: Partial<AutoState>): void {
    this.s = { ...this.s, ...patch };
    this.emit(this.s);
  }

  private log(level: AutoAction['level'], text: string): void {
    const actions = [...this.s.actions, { t: this.deps.now(), level, text }].slice(-40);
    this.set({ actions });
  }

  private step(step: AutoStep): void {
    this.set({ step });
  }

  private halt(): void {
    if (this.stopReq) throw new Halt('stop');
    if (this.pauseReq) throw new Halt('pause');
  }

  private markProcessed(fps: string[]): void {
    const set = new Set(this.s.processedFingerprints);
    const fresh = fps.filter((f) => !set.has(f));
    this.set({
      processedFingerprints: [...this.s.processedFingerprints, ...fresh],
      processed: this.s.processed + fresh.length,
    });
  }

  // ---------- main loop ----------

  private async run(): Promise<void> {
    try {
      await this.ensureDeepSeek();
      let pending: Question[] | null = null;
      for (let round = 0; ; round++) {
        if (round > TIMING.maxRounds) throw new Fatal('Слишком много шагов без завершения. Решение остановлено.');
        this.halt();
        this.step('read');
        const questions = pending ?? (await this.scanNew());
        pending = null;

        if (!questions.length) {
          if (this.s.processed === 0)
            throw new Fatal('На странице не найдено вопросов. Откройте страницу теста с первым вопросом.');
          const next = await this.advance();
          if (next === null) break;
          pending = next;
          continue;
        }

        const from = this.s.processed + 1;
        const numbered = renumber(questions, from);
        const fps = questions.map(fingerprint);
        this.lastBatch = numbered.length;
        this.set({ current: [from, from + numbered.length - 1] });
        this.log('info', numbered.length === 1 ? `Вопрос ${from}: ${short(numbered[0].text)}` : `Вопросы ${from}–${from + numbered.length - 1}`);

        await this.breather();
        const report = await this.solve(numbered);
        this.halt();
        await this.breather();

        if (numbered.every((q) => q.target === 'none')) {
          const answers = describeAnswers(numbered, report);
          answers.forEach((a) => this.log('info', a));
          this.set({
            phase: 'waiting_user',
            step: null,
            displayOnly: { fingerprints: fps, answers },
            message: 'На странице нет полей для этих вопросов. Ответ DeepSeek показан ниже: выберите его вручную и нажмите «Продолжить».',
          });
          return;
        }

        await this.fillAndVerify(numbered, report);
        this.markProcessed(fps);
        this.halt();
        await this.breather();

        const next = await this.advance();
        if (next === null) break;
        pending = next;
      }
      await this.finish();
    } catch (e) {
      if (e instanceof Halt) {
        if (e.kind === 'stop') {
          this.set({ phase: 'stopped', step: null, message: null });
          this.log('info', 'Остановлено пользователем');
        } else {
          this.set({ phase: 'paused', step: null, message: 'Пауза. Нажмите «Продолжить», чтобы продолжить с текущего вопроса.' });
          this.log('info', 'Пауза');
        }
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      this.set({ phase: 'error', step: null, message: msg });
      this.log('error', msg);
    }
  }

  private async finish(): Promise<void> {
    let finishCandidates: NextCandidate[] = [];
    try {
      finishCandidates = await this.deps.findFinish();
    } catch {
      /* page may be navigating; the user can look for the button */
    }
    this.set({
      phase: 'finished',
      step: null,
      current: null,
      finishedAt: this.deps.now(),
      finishCandidates,
      message: `Все вопросы заполнены. Обработано: ${this.s.processed}.`,
    });
    this.log('info', `Готово: обработано ${this.s.processed} вопр. Тест не отправлен.`);
  }

  // ---------- DeepSeek ----------

  private async ensureDeepSeek(): Promise<void> {
    this.step('connect');
    let st: DeepSeekCheck;
    try {
      st = await this.deps.checkDeepSeek();
    } catch (e) {
      this.set({ deepseek: 'offline' });
      throw new Fatal(e instanceof Error ? e.message : String(e));
    }
    if (st.ready) {
      if (this.s.deepseek !== 'ready') this.log('info', 'DeepSeek подключён');
      this.set({ deepseek: 'ready' });
      return;
    }
    if (st.reason && WAIT_FOR_USER.has(st.reason)) return this.waitForUser(st);
    this.set({ deepseek: (st.reason as DeepSeekState) ?? 'ui_changed' });
    throw new Fatal(st.message);
  }

  /** Login or CAPTCHA: the user handles it in the DeepSeek window, we poll until ready. */
  private async waitForUser(st: DeepSeekCheck): Promise<void> {
    this.set({ phase: 'waiting_user', deepseek: st.reason as DeepSeekState, message: st.message });
    this.log('warn', st.message);
    const deadline = this.deps.now() + TIMING.loginTimeoutMs;
    while (this.deps.now() < deadline) {
      this.halt();
      await this.deps.sleep(TIMING.loginPollMs);
      this.halt();
      let cur: DeepSeekCheck;
      try {
        cur = await this.deps.checkDeepSeek();
      } catch {
        continue;
      }
      if (cur.ready) {
        this.set({ phase: 'running', deepseek: 'ready', message: null });
        this.log('info', 'DeepSeek готов, продолжаю');
        return;
      }
      if (cur.reason && !WAIT_FOR_USER.has(cur.reason)) {
        this.set({ deepseek: cur.reason as DeepSeekState });
        throw new Fatal(cur.message);
      }
    }
    throw new Fatal('Не дождался входа в DeepSeek. Войдите и нажмите «Продолжить».');
  }

  /** The pause between stages; Pause/Stop still act right away after it. */
  private async breather(): Promise<void> {
    if (TIMING.stepPauseMs > 0) await this.deps.sleep(TIMING.stepPauseMs);
    this.halt();
  }

  private async askOnce(prompt: string, newChat: boolean): Promise<string> {
    this.step('send');
    const label = setTimeout(() => this.s.step === 'send' && this.step('wait'), TIMING.waitLabelDelayMs);
    try {
      return await this.deps.ask(prompt, newChat);
    } finally {
      clearTimeout(label);
    }
  }

  /** Asks until the reply is valid for every question; never guesses. */
  private async solve(questions: Question[]): Promise<ValidationReport> {
    let prompt = buildAutoPrompt(questions);
    let newChat = this.s.asks === 0 || this.s.asks % TIMING.newChatEvery === 0;
    let invalid = 0;
    let transient = 0;
    for (;;) {
      this.halt();
      let text: string;
      try {
        text = await this.askOnce(prompt, newChat);
      } catch (e) {
        const code = errCode(e);
        const msg = e instanceof Error ? e.message : String(e);
        if (code === 'cancelled' || this.stopReq || this.pauseReq) {
          this.halt();
          throw new Fatal('Запрос к DeepSeek прерван.');
        }
        if (WAIT_FOR_USER.has(code)) {
          await this.waitForUser({ ready: false, reason: code, message: msg });
          continue;
        }
        if (code === 'unavailable') {
          this.set({ deepseek: 'offline' });
          throw new Fatal(msg);
        }
        if (code === 'ui_changed') {
          this.set({ deepseek: 'ui_changed' });
          throw new Fatal(`${msg} Автоматизация DeepSeek остановлена.`);
        }
        if (TRANSIENT.has(code) && ++transient <= TIMING.maxTransientRetries) {
          this.log('warn', `${msg} Повтор ${transient}/${TIMING.maxTransientRetries}…`);
          await this.deps.sleep(2_000 * transient);
          continue;
        }
        throw new Fatal(`DeepSeek не ответил: ${msg} Переход к следующему вопросу не выполнен.`);
      }
      newChat = false;
      this.set({ asks: this.s.asks + 1, deepseek: 'ready' });

      this.step('process');
      const parsed = parseAnswerText(text);
      let problems: string[];
      if (!parsed.ok) problems = [parsed.error];
      else {
        const report = validateAnswers(questions, parsed.value);
        const bad = report.results.filter((r) => r.status === 'error' || r.status === 'missing');
        if (!bad.length) {
          report.results
            .filter((r) => r.confidence !== null && r.confidence < 0.5)
            .forEach((r) => this.set({ lowConfidence: [...this.s.lowConfidence, r.questionId] }));
          return report;
        }
        problems = bad.flatMap((r) => r.messages.map((m) => `${r.questionId}: ${m}`));
      }
      if (++invalid >= TIMING.maxAskAttempts) {
        questions.forEach((q) => this.set({ failed: [...this.s.failed, { text: short(q.text), reason: problems[0] }] }));
        throw new Fatal(
          `Ответ DeepSeek не удалось сопоставить с вариантами (${problems[0]}). Решение остановлено, вариант не выбран.`,
        );
      }
      this.log('warn', `Ответ не подошёл: ${problems[0]}. Прошу DeepSeek ответить заново.`);
      prompt = buildCorrectionPrompt(questions, problems);
    }
  }

  // ---------- page ----------

  private async scanNew(): Promise<Question[]> {
    const rec = await this.deps.scan();
    const done = new Set(this.s.processedFingerprints);
    return rec.questions.filter((q) => !done.has(fingerprint(q)));
  }

  private async fillAndVerify(questions: Question[], report: ValidationReport): Promise<void> {
    this.step('fill');
    const { plan, skipped } = buildFillPlan(questions, report.results);
    const blocking = skipped.filter((x) => questions.find((q) => q.id === x.questionId)?.target !== 'none');
    if (blocking.length) {
      const b = blocking[0];
      throw new Fatal(`Не удалось сопоставить ответ на ${b.questionId} с элементами страницы (${b.reason}).`);
    }
    const result = await this.deps.fill(plan);
    const bad = result.find((r) => !r.ok);
    if (bad) {
      const why = bad.actions.find((a) => !a.ok);
      throw new Fatal(`Ответ на ${bad.questionId} не принят страницей: ${why?.message ?? 'проверка не прошла'}. Переход не выполнен.`);
    }
    plan.forEach((p) => this.log('info', `${p.questionId}: ${p.summary}`));
  }

  /**
   * Moves to the next question. Returns the new questions, or null when the test is over.
   * Throws when "Next" was pressed but nothing new appeared.
   */
  private async advance(): Promise<Question[] | null> {
    this.step('next');
    const candidates = await this.deps.findNext();
    const enabled = candidates.filter((c) => !c.disabled);
    if (enabled.length) {
      const res = await this.deps.clickNext(enabled[0].selector);
      if (!res.ok) throw new Fatal(res.message);
      this.set({ navigations: this.s.navigations + 1 });
      this.log('info', `Ответ выбран, нажата «${enabled[0].text}»`);
      const fresh = await this.waitForNew(TIMING.navTimeoutMs);
      if (fresh.length) return fresh;
      const finish = await this.deps.findFinish().catch(() => []);
      if (finish.length) return null;
      const hint = enabled[0].learned
        ? ' Если запомнена не та кнопка, нажмите «Забыть» рядом с ней в панели и нажмите «Далее» на странице сами.'
        : '';
      throw new Fatal(
        `После нажатия «${enabled[0].text}» новый вопрос не появился за ${TIMING.navTimeoutMs / 1000} с. Возможно, страница не приняла ответ или требует действия.${hint}`,
      );
    }
    // No active "Next": the next question may appear on the same page after answering.
    const fresh = await this.waitForNew(TIMING.revealTimeoutMs);
    if (fresh.length) {
      this.set({ navigations: this.s.navigations + 1 });
      return fresh;
    }
    const finish = await this.deps.findFinish().catch(() => []);
    if (candidates.some((c) => c.disabled)) {
      if (!finish.length)
        throw new Fatal(`Кнопка «${candidates[0].text}» неактивна: сайт не принял ответ. Проверьте вопрос на странице.`);
      return null;
    }
    // Already moved through the test and now there is nowhere to go: this was the last question.
    if (this.s.navigations > 0 || !this.deps.armLearnNext) return null;
    // All questions on one page and a finish button: the test is simply done.
    // (One question with a finish button usually means the site shows "finish" all the time.)
    if (finish.length && this.lastBatch > 1) return null;
    // Never moved yet and no button found: the site's "Next" is not recognisable. Learn it from the user.
    return this.learnNext();
  }

  /** Waits until the user presses "Next" once on the page; the content script remembers that button. */
  private async learnNext(): Promise<Question[] | null> {
    await this.deps.armLearnNext!();
    this.set({
      phase: 'waiting_user',
      step: null,
      message:
        'Не нашёл кнопку перехода к следующему вопросу. Нажмите её на странице один раз сами: я запомню её и дальше буду нажимать сам. Если это был последний вопрос, нажмите «Остановить».',
    });
    this.log('warn', 'Жду, пока вы нажмёте «Далее» на странице');
    let learned = false;
    try {
      const deadline = this.deps.now() + TIMING.learnTimeoutMs;
      let prev = '';
      while (this.deps.now() < deadline) {
        this.halt();
        await this.deps.sleep(TIMING.pollMs);
        this.halt();
        const btn = await this.deps.learnedNext!().catch(() => null);
        if (btn) {
          learned = true;
          this.set({ phase: 'running', message: null, navigations: this.s.navigations + 1 });
          this.log('info', `Запомнил кнопку «${btn.text || 'Далее'}», дальше нажимаю её сам`);
          this.step('next');
          const fresh = await this.waitForNew(TIMING.navTimeoutMs);
          if (fresh.length) return fresh;
          const finish = await this.deps.findFinish().catch(() => []);
          if (finish.length) return null;
          throw new Fatal(`После нажатия «${btn.text || 'Далее'}» новый вопрос не появился за ${TIMING.navTimeoutMs / 1000} с.`);
        }
        // the user moved on some other way (keyboard, a link we did not catch): just continue
        let qs: Question[] = [];
        try {
          qs = await this.scanNew();
        } catch {
          prev = '';
          continue;
        }
        const key = qs.map(fingerprint).join(',');
        if (qs.length && key === prev) {
          this.set({ phase: 'running', message: null, navigations: this.s.navigations + 1 });
          this.log('info', 'Появился новый вопрос, продолжаю');
          return qs;
        }
        prev = key;
      }
      throw new Fatal('Не дождался нажатия «Далее». Нажмите кнопку на странице и затем «Продолжить».');
    } finally {
      if (!learned) await this.deps.cancelLearnNext?.().catch(() => undefined);
    }
  }

  /** Polls the page until unprocessed questions appear and stay the same for two polls. */
  private async waitForNew(timeoutMs: number): Promise<Question[]> {
    const deadline = this.deps.now() + timeoutMs;
    let prev = '';
    while (this.deps.now() < deadline) {
      this.halt();
      await this.deps.sleep(TIMING.pollMs);
      let qs: Question[];
      try {
        qs = await this.scanNew();
      } catch {
        prev = ''; // page is reloading
        continue;
      }
      const key = qs.map(fingerprint).join(',');
      if (qs.length && key === prev) return qs;
      prev = key;
    }
    return [];
  }
}

function short(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 70 ? `${t.slice(0, 67)}…` : t || '(без текста)';
}

function describeAnswers(questions: Question[], report: ValidationReport): string[] {
  return questions.map((q) => {
    const r = report.results.find((x) => x.questionId === q.id);
    const opts = (r?.selectedOptionIds ?? []).map((id) => q.options.find((o) => o.id === id)?.text ?? id);
    const answer = opts.length ? opts.join(', ') : r?.answerText || '—';
    return `${q.id}: ${short(q.text)} → ${answer}`;
  });
}
