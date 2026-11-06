import { beforeEach, describe, expect, it } from 'vitest';
import { loadPage, recognizeAll } from './helpers';
import { validateAnswers } from '../src/shared/answers';
import { buildFillPlan } from '../src/shared/plan';
import { applyPlan, verifyPlan } from '../src/content/fill';
import { clickNext, findNextCandidates, isNextLabel } from '../src/content/navigation';

function solve(answers: unknown[]) {
  const { questions } = recognizeAll();
  const report = validateAnswers(questions, { answers });
  const { plan, skipped } = buildFillPlan(questions, report.results);
  return { questions, report, plan, skipped };
}

describe('fill: full cycle on the test pages (recognize → validate → plan → fill → verify)', () => {
  let changes = 0;
  beforeEach(() => {
    changes = 0;
    document.addEventListener('change', () => changes++, { capture: true });
  });

  it('mixed page: radio, checkbox, true/false, select, text', () => {
    loadPage('mixed.html');
    const { plan } = solve([
      { question_id: 'q1', selected_options: ['option_2'], confidence: 0.99 },
      { question_id: 'q2', selected_options: ['option_1', 'option_2'], confidence: 0.95 },
      { question_id: 'q3', selected_options: ['option_1'], confidence: 0.9 },
      { question_id: 'q4', selected_options: ['option_2'], confidence: 0.97 },
      { question_id: 'q5', selected_options: [], answer_text: 'HyperText Markup Language', confidence: 0.99 },
    ]);
    expect(plan).toHaveLength(5);
    const report = applyPlan(document, plan);
    expect(report.every((r) => r.ok)).toBe(true);

    const $ = <T extends Element>(s: string) => document.querySelector(s) as unknown as T;
    expect($<HTMLInputElement>('input[name=m1][value=css]').checked).toBe(true);
    expect($<HTMLInputElement>('input[name=m2_choice0]').checked).toBe(true);
    expect($<HTMLInputElement>('input[name=m2_choice1]').checked).toBe(true);
    expect($<HTMLInputElement>('input[name=m2_choice2]').checked).toBe(false);
    expect($<HTMLInputElement>('input[name=m3][value=t]').checked).toBe(true);
    expect($<HTMLSelectElement>('select[name=m4]').value).toBe('443');
    expect($<HTMLInputElement>('#m5').value).toBe('HyperText Markup Language');
    expect(changes).toBeGreaterThanOrEqual(5); // real change events were dispatched
    expect(verifyPlan(document, plan).every((r) => r.ok)).toBe(true);
  });

  it('multiple choice unchecks options that were wrongly pre-checked', () => {
    loadPage('multiple.html');
    const { plan } = solve([
      { question_id: 'q1', selected_options: ['option_1', 'option_3', 'option_5'] },
      { question_id: 'q2', selected_options: ['option_1', 'option_3'] },
    ]);
    expect(applyPlan(document, plan).every((r) => r.ok)).toBe(true);
    const checked = (n: string) => (document.querySelector(`input[name="${n}"]`) as HTMLInputElement).checked;
    expect(checked('q2_choice0')).toBe(true); // Python
    expect(checked('q2_choice2')).toBe(true); // Java
    expect(checked('q2_choice3')).toBe(false); // JPEG was pre-checked
    const primes = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="q1[]"]')).filter((i) => i.checked).map((i) => i.value);
    expect(primes).toEqual(['2', '7', '11']);
  });

  it('dropdown + matching', () => {
    loadPage('dropdown.html');
    const { plan } = solve([
      { question_id: 'q1', selected_options: ['option_2'] },
      { question_id: 'q2', selected_options: ['option_2'] },
      { question_id: 'q3', selected_options: [], matches: [
        { item_id: 'q3_item_1', option_id: 'option_1' },
        { item_id: 'q3_item_2', option_id: 'option_2' },
        { item_id: 'q3_item_3', option_id: 'option_3' },
      ] },
    ]);
    expect(applyPlan(document, plan).every((r) => r.ok)).toBe(true);
    const v = (n: string) => (document.querySelector(`select[name="${n}"]`) as HTMLSelectElement).value;
    expect([v('q1'), v('q2'), v('q3_sub0'), v('q3_sub1'), v('q3_sub2')]).toEqual(['1939', 'jupiter', '1', '2', '3']);
  });

  it('ARIA widgets are clicked and their aria-checked is verified', () => {
    loadPage('aria.html');
    // emulate the page's widget script (jsdom does not run page scripts here)
    document.querySelectorAll('[role=radio]').forEach((el) =>
      el.addEventListener('click', () => {
        el.closest('[role=radiogroup]')!.querySelectorAll('[role=radio]').forEach((r) => r.setAttribute('aria-checked', 'false'));
        el.setAttribute('aria-checked', 'true');
      }),
    );
    document.querySelectorAll('[role=checkbox]').forEach((el) =>
      el.addEventListener('click', () => el.setAttribute('aria-checked', el.getAttribute('aria-checked') === 'true' ? 'false' : 'true')),
    );
    const { plan } = solve([
      { question_id: 'q1', selected_options: ['option_2'] },
      { question_id: 'q2', selected_options: ['option_1', 'option_3'] },
    ]);
    expect(applyPlan(document, plan).every((r) => r.ok)).toBe(true);
    expect(document.getElementById('g1-b')!.getAttribute('aria-checked')).toBe('true');
    expect(document.getElementById('g2-a')!.getAttribute('aria-checked')).toBe('true');
    expect(document.getElementById('g2-b')!.getAttribute('aria-checked')).toBe('false');
    expect(document.getElementById('g2-c')!.getAttribute('aria-checked')).toBe('true');
  });

  it('reports elements that disappeared and skips questions with errors', () => {
    loadPage('single.html');
    const { plan, skipped } = solve([
      { question_id: 'q1', selected_options: ['option_2'] },
      { question_id: 'q2', selected_options: ['option_7'] },
    ]);
    expect(plan.map((p) => p.questionId)).toEqual(['q1']);
    expect(skipped.map((s) => s.questionId)).toEqual(['q2', 'q3']);
    document.querySelector('input[name=q1][value=b]')!.remove();
    const report = applyPlan(document, plan);
    expect(report[0].ok).toBe(false);
    expect(report[0].actions[0].message).toMatch(/не найден/);
  });

  it('verifyPlan detects state changed after filling', () => {
    loadPage('text.html');
    const { plan } = solve([{ question_id: 'q1', answer_text: 'Нил' }]);
    applyPlan(document, plan);
    (document.querySelector('#a1') as HTMLInputElement).value = 'Амазонка';
    expect(verifyPlan(document, plan)[0].ok).toBe(false);
  });
});

describe('navigation', () => {
  it('finds "next" buttons and never offers finish/submit buttons', () => {
    loadPage('mixed.html');
    const c = findNextCandidates(document, () => true, () => false);
    expect(c.map((x) => x.text)).toEqual(['Следующая страница']);
    expect(isNextLabel('Завершить тест')).toBe(false);
    expect(isNextLabel('Отправить')).toBe(false);
    expect(isNextLabel('Далее »')).toBe(true);
    expect(isNextLabel('Next')).toBe(true);
    expect(isNextLabel('Submit and next')).toBe(false);
  });

  it('refuses to click a button that is not a "next" button', () => {
    loadPage('mixed.html');
    const r = clickNext(document, 'button.finish');
    expect(r.ok).toBe(false);
  });
});
