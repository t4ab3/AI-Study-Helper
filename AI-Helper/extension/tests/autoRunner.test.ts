import { describe, expect, it } from 'vitest';
import { AutoRunner, initialAutoState, type AutoDeps, type AutoState, type DeepSeekCheck } from '../src/sidepanel/autoRunner';
import type { FillPlanItem, NextCandidate, Question } from '../src/shared/types';

// ---------- a simulated test site ----------

function radio(name: string, text: string, options: string[]): Question {
  return {
    id: 'q1', type: 'single', text, target: 'radio', source: 'dom',
    options: options.map((t, i) => ({ id: `option_${i + 1}`, text: t, selector: `input[name=${name}][value="${i}"]` })),
  };
}
function checkbox(name: string, text: string, options: string[]): Question {
  return {
    id: 'q1', type: 'multiple', text, target: 'checkbox', source: 'dom',
    options: options.map((t, i) => ({ id: `option_${i + 1}`, text: t, selector: `input[name=${name}_${i}]` })),
  };
}
function textQ(name: string, text: string): Question {
  return { id: 'q1', type: 'text', text, target: 'text', source: 'dom', options: [], selector: `#${name}` };
}

const KEY: Record<string, string[]> = {
  'Столица Франции?': ['Париж'],
  'Простые числа?': ['2', '7'],
  'Сколько бит в байте?': ['8'],
  'Самая длинная река?': ['Нил'],
  'HTTP поверх TCP?': ['Верно'],
};

/** Answers like DeepSeek would, using the question layout of the auto prompt. */
function deepseekReply(prompt: string, opts: { bad?: 'json' | 'unknown' } = {}): string {
  if (opts.bad === 'json') return 'Давайте подумаем... ответ, скорее всего, второй вариант.';
  const blocks = prompt.split(/\n(?=\[q\d+\])/).filter((b) => /^\[q\d+\]/.test(b));
  const answers = blocks.map((b) => {
    const id = b.match(/^\[(q\d+)\]/)![1];
    const text = b.match(/Вопрос: (.*)/)![1];
    const options = [...b.matchAll(/^\s+(option_\d+): (.*)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
    if (opts.bad === 'unknown') return { question_id: id, answers: ['option_42'], confidence: 0.9 };
    const key = KEY[text] ?? [];
    if (!options.length) return { question_id: id, text_answer: key[0] ?? '', confidence: 0.9 };
    return { question_id: id, answers: options.filter((o) => key.includes(o.text)).map((o) => o.id), confidence: 0.95 };
  });
  return 'Ответ:\n```json\n' + JSON.stringify({ answers }) + '\n```';
}

interface SiteOpts {
  /** polls during which the old page is still shown after "Next" */
  lag?: number;
  /** "Next" does nothing */
  stuck?: boolean;
  /** no "Next" button: the next question appears on the same page after answering */
  reveal?: boolean;
  checks?: DeepSeekCheck[];
  replies?: ((prompt: string) => string | Error)[];
}

function makeSite(pages: Question[][], o: SiteOpts = {}) {
  let t = 0;
  let idx = 0;
  let lagLeft = 0;
  let answered = 0; // reveal mode: how many questions are answered
  const log = { asks: [] as string[], fills: [] as FillPlanItem[][], nextClicks: 0, finishClicks: 0, newChats: 0 };
  const checks = [...(o.checks ?? [])];
  const replies = [...(o.replies ?? [])];

  const deps: AutoDeps = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    async scan() {
      if (o.reveal) return { mode: 'dom', questions: pages.flat().slice(0, answered + 1), rawText: '', warnings: [] };
      if (lagLeft > 0) {
        lagLeft--;
        return { mode: 'dom', questions: pages[idx - 1], rawText: '', warnings: [] }; // old question still visible
      }
      return { mode: 'dom', questions: pages[idx] ?? [], rawText: '', warnings: [] };
    },
    async checkDeepSeek() {
      return checks.shift() ?? { ready: true, reason: null, message: 'ok' };
    },
    async ask(prompt, newChat) {
      log.asks.push(prompt);
      if (newChat) log.newChats++;
      const r = replies.shift();
      const out = r ? r(prompt) : deepseekReply(prompt);
      if (out instanceof Error) throw out;
      return out;
    },
    async cancelAsk() {},
    async fill(plan) {
      log.fills.push(plan);
      answered += plan.length;
      return plan.map((p) => ({ questionId: p.questionId, ok: true, actions: [] }));
    },
    async findNext(): Promise<NextCandidate[]> {
      if (o.reveal) return [];
      return idx < pages.length - 1 ? [{ selector: '#next', text: 'Далее' }] : [];
    },
    async clickNext() {
      log.nextClicks++;
      if (!o.stuck) {
        idx++;
        lagLeft = o.lag ?? 0;
      }
      return { ok: true, message: 'ok' };
    },
    async findFinish() {
      return idx === pages.length - 1 || o.reveal ? [{ selector: '#finish', text: 'Завершить тест' }] : [];
    },
  };
  return { deps, log };
}

function codeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function runToEnd(deps: AutoDeps): Promise<{ runner: AutoRunner; states: AutoState[] }> {
  const states: AutoState[] = [];
  const runner = new AutoRunner(deps, initialAutoState(), (s) => states.push(s));
  await runner.start();
  return { runner, states };
}

const SEQ = [
  [radio('a', 'Столица Франции?', ['Берлин', 'Париж', 'Рим'])],
  [checkbox('b', 'Простые числа?', ['2', '4', '7'])],
  [textQ('c', 'Самая длинная река?')],
  [radio('d', 'Сколько бит в байте?', ['4', '8'])],
];

describe('AutoRunner', () => {
  it('solves a one-question-at-a-time test from first to last question', async () => {
    const { deps, log } = makeSite(SEQ);
    const { runner, states } = await runToEnd(deps);
    const s = runner.state;
    expect(s.phase).toBe('finished');
    expect(s.processed).toBe(4);
    expect(log.asks).toHaveLength(4);
    expect(log.nextClicks).toBe(3);
    expect(s.finishCandidates[0].text).toBe('Завершить тест'); // reported, not pressed
    // run-wide ids: the 3rd question is asked as q3
    expect(log.asks[2]).toContain('[q3] (ввод текста)');
    expect(log.fills[0][0].actions[0]).toMatchObject({ selector: 'input[name=a][value="1"]', checked: true });
    expect(log.fills[1][0].actions.filter((a) => a.type === 'check' && a.checked).map((a) => a.selector)).toEqual([
      'input[name=b_0]', 'input[name=b_2]',
    ]);
    expect(log.fills[2][0].actions[0]).toMatchObject({ type: 'text', value: 'Нил' });
    expect(log.newChats).toBe(1);
    // the steps the user sees
    const steps = new Set(states.map((x) => x.step));
    for (const st of ['connect', 'read', 'send', 'process', 'fill', 'next']) expect(steps.has(st as never)).toBe(true);
  });

  it('does not solve the same question twice while the page is slow to update', async () => {
    const { deps, log } = makeSite(SEQ, { lag: 5 });
    const { runner } = await runToEnd(deps);
    expect(runner.state.phase).toBe('finished');
    expect(log.asks).toHaveLength(4);
    expect(log.fills).toHaveLength(4);
  });

  it('asks again when the reply is not JSON, then fills', async () => {
    const { deps, log } = makeSite([SEQ[0]], { replies: [(p) => deepseekReply(p, { bad: 'json' })] });
    const { runner } = await runToEnd(deps);
    expect(runner.state.phase).toBe('finished');
    expect(log.asks).toHaveLength(2);
    expect(log.asks[1]).toContain('не удалось обработать');
    expect(log.fills).toHaveLength(1);
  });

  it('stops without choosing anything when the answer cannot be matched', async () => {
    const bad = (p: string) => deepseekReply(p, { bad: 'unknown' });
    const { deps, log } = makeSite(SEQ, { replies: [bad, bad, bad] });
    const { runner } = await runToEnd(deps);
    expect(runner.state.phase).toBe('error');
    expect(runner.state.message).toMatch(/не удалось сопоставить/i);
    expect(log.fills).toHaveLength(0);
    expect(log.nextClicks).toBe(0);
    expect(runner.state.failed).toHaveLength(1);
  });

  it('retries a timeout and does not move on while DeepSeek is silent', async () => {
    const timeout = () => codeError('timeout', 'DeepSeek не закончил ответ вовремя.');
    const ok = makeSite([SEQ[0]], { replies: [timeout] });
    expect((await runToEnd(ok.deps)).runner.state.phase).toBe('finished');

    const dead = makeSite(SEQ, { replies: [timeout, timeout, timeout, timeout] });
    const { runner } = await runToEnd(dead.deps);
    expect(runner.state.phase).toBe('error');
    expect(dead.log.nextClicks).toBe(0);
    expect(dead.log.fills).toHaveLength(0);
  });

  it('waits for the user to log in to DeepSeek, then continues', async () => {
    const login = { ready: false, reason: 'login_required', message: 'Войдите в DeepSeek' };
    const { deps } = makeSite([SEQ[0]], { checks: [login, login, login] });
    const { runner, states } = await runToEnd(deps);
    expect(states.some((s) => s.phase === 'waiting_user' && s.deepseek === 'login_required')).toBe(true);
    expect(runner.state.phase).toBe('finished');
  });

  it('reports a changed DeepSeek interface instead of working around it', async () => {
    const { deps, log } = makeSite(SEQ, { checks: [{ ready: false, reason: 'ui_changed', message: 'Не найдено поле ввода DeepSeek.' }] });
    const { runner } = await runToEnd(deps);
    expect(runner.state.phase).toBe('error');
    expect(runner.state.deepseek).toBe('ui_changed');
    expect(log.asks).toHaveLength(0);
  });

  it('errors out when "Next" does not bring a new question', async () => {
    const { deps } = makeSite(SEQ, { stuck: true });
    const { runner } = await runToEnd(deps);
    expect(runner.state.phase).toBe('error');
    expect(runner.state.message).toMatch(/новый вопрос не появился/);
    expect(runner.state.processed).toBe(1);
  });

  it('handles questions revealed on the same page without a "Next" button', async () => {
    const { deps, log } = makeSite(SEQ, { reveal: true });
    const { runner } = await runToEnd(deps);
    expect(runner.state.phase).toBe('finished');
    expect(runner.state.processed).toBe(4);
    expect(log.asks).toHaveLength(4);
  });

  it('pause and resume continue from the current question; stop ends the run', async () => {
    let runner!: AutoRunner;
    const { deps, log } = makeSite(SEQ, {
      replies: [
        (p) => deepseekReply(p),
        () => {
          runner.pause(); // user presses pause while DeepSeek is answering question 2
          return codeError('cancelled', 'Остановлено пользователем.') as unknown as string;
        },
      ],
    });
    runner = new AutoRunner(deps, initialAutoState(), () => undefined);
    await runner.start();
    expect(runner.state.phase).toBe('paused');
    expect(runner.state.processed).toBe(1);
    await runner.resume();
    expect(runner.state.phase).toBe('finished');
    expect(runner.state.processed).toBe(4);
    expect(log.fills).toHaveLength(4);

    runner.stop();
    expect(runner.state.phase).toBe('stopped');
  });

  it('reports a page without questions', async () => {
    const { deps } = makeSite([[]]);
    const { runner } = await runToEnd(deps);
    expect(runner.state.phase).toBe('error');
    expect(runner.state.message).toMatch(/не найдено вопросов/);
  });
});

describe('AutoRunner: "Next" the user shows once', () => {
  /** Site whose "Next" cannot be recognised until the user clicks it once. */
  function unknownNextSite(pages: Question[][], finishAlways = false) {
    const site = makeSite(pages);
    let idx = 0;
    let armed = false;
    let learned: { text: string } | null = null;
    const events = { armed: 0, userClicks: 0, autoClicks: 0, cancelled: 0 };
    const deps: AutoDeps = {
      ...site.deps,
      async scan() {
        return { mode: 'dom', questions: pages[idx] ?? [], rawText: '', warnings: [] };
      },
      async findNext() {
        return learned && idx < pages.length - 1 ? [{ selector: '.go', text: 'Перейти', learned: true }] : [];
      },
      async clickNext() {
        events.autoClicks++;
        idx++;
        return { ok: true, message: 'ok' };
      },
      async findFinish() {
        return finishAlways || idx === pages.length - 1 ? [{ selector: '#finish', text: 'Завершить тест' }] : [];
      },
      async armLearnNext() {
        armed = true;
        events.armed++;
      },
      async learnedNext() {
        if (!armed) return null;
        // the user clicks "Перейти" a moment after being asked
        events.userClicks++;
        armed = false;
        learned = { text: 'Перейти' };
        idx++;
        return learned;
      },
      async cancelLearnNext() {
        armed = false;
        events.cancelled++;
      },
    };
    return { deps, events };
  }

  it('waits for the first click, then presses the remembered button itself', async () => {
    const { deps, events } = unknownNextSite(SEQ);
    const states: AutoState[] = [];
    const runner = new AutoRunner(deps, initialAutoState(), (s) => states.push({ ...s }));
    await runner.start();
    expect(runner.state.phase).toBe('finished');
    expect(runner.state.processed).toBe(4);
    expect(events.armed).toBe(1);
    expect(events.userClicks).toBe(1);
    expect(events.autoClicks).toBe(2);
    expect(states.some((s) => s.phase === 'waiting_user' && /Нажмите её на странице/.test(s.message ?? ''))).toBe(true);
  });

  it('a site that always shows "Завершить" still learns "Next" on the first question', async () => {
    const { deps, events } = unknownNextSite(SEQ, true);
    const runner = new AutoRunner(deps, initialAutoState(), () => undefined);
    await runner.start();
    expect(runner.state.phase).toBe('finished');
    expect(runner.state.processed).toBe(4);
    expect(events.userClicks).toBe(1);
  });

  it('all questions on one page plus a finish button: done, nothing to learn', async () => {
    const page = [radio('a', 'Столица Франции?', ['Берлин', 'Париж']), radio('d', 'Сколько бит в байте?', ['4', '8'])];
    const { deps, events } = unknownNextSite([page]);
    const runner = new AutoRunner(deps, initialAutoState(), () => undefined);
    await runner.start();
    expect(runner.state.phase).toBe('finished');
    expect(runner.state.processed).toBe(2);
    expect(events.armed).toBe(0);
  });

  it('stop while waiting for the click cancels the wait', async () => {
    const { deps, events } = unknownNextSite(SEQ);
    let runner!: AutoRunner;
    runner = new AutoRunner(
      {
        ...deps,
        async learnedNext() {
          runner.stop();
          return null;
        },
      },
      initialAutoState(),
      () => undefined,
    );
    await runner.start();
    expect(runner.state.phase).toBe('stopped');
    expect(events.cancelled).toBe(1);
  });
});
