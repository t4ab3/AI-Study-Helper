import { describe, expect, it } from 'vitest';
import { extractJsonObject, parseAnswerText, validateAnswers } from '../src/shared/answers';
import { buildAutoPrompt } from '../src/shared/prompt';
import type { Question } from '../src/shared/types';
import { loadPage, recognizeAll } from './helpers';

const single: Question = {
  id: 'q1', type: 'single', text: 'Столица Франции?', target: 'radio', source: 'dom',
  options: [{ id: 'option_1', text: 'Берлин' }, { id: 'option_2', text: 'Париж' }],
};
const multi: Question = {
  id: 'q2', type: 'multiple', text: 'Простые числа', target: 'checkbox', source: 'dom',
  options: [{ id: 'option_1', text: '2' }, { id: 'option_2', text: '4' }, { id: 'option_3', text: '7' }],
};
const text: Question = { id: 'q3', type: 'text', text: 'Река?', target: 'text', source: 'dom', options: [] };
const matching: Question = {
  id: 'q4', type: 'matching', text: 'Сопоставьте', target: 'select', source: 'dom',
  items: [{ id: 'q4_item_1', text: 'Япония' }, { id: 'q4_item_2', text: 'Канада' }],
  options: [{ id: 'option_1', text: 'Токио', value: '1' }, { id: 'option_2', text: 'Оттава', value: '2' }],
};
const all = [single, multi, text, matching];

describe('prompt', () => {
  it('contains the required instructions, JSON format and real ids', () => {
    loadPage('mixed.html');
    const { questions } = recognizeAll();
    const p = buildAutoPrompt(questions);
    expect(p).toContain('Ты — помощник по решению учебных тестовых заданий.');
    expect(p).toContain('"question_id": "q1"');
    expect(p).toContain('не придумывай новых');
    expect(p).toContain('[q1] (один правильный вариант)');
    expect(p).toContain('option_2: CSS');
    expect(p).toContain('[q5] (ввод текста');
  });
  it('lists matching items', () => {
    const p = buildAutoPrompt([matching]);
    expect(p).toContain('q4_item_1: Япония');
    expect(p).toContain('"matches"');
  });
  it('refuses an empty list', () => {
    expect(() => buildAutoPrompt([])).toThrow();
  });
});

describe('parseAnswerText', () => {
  it('reads JSON inside a markdown fence with text around', () => {
    const r = parseAnswerText('Вот ответ:\n```json\n{"answers": [{"question_id": "q1", "selected_options": ["option_2"]}]}\n```\nУдачи!');
    expect(r.ok).toBe(true);
  });
  it('tolerates trailing commas and smart quotes', () => {
    const r = parseAnswerText('{“answers”: [{“question_id”: “q1”, “selected_options”: [“option_2”],},]}');
    expect(r.ok).toBe(true);
  });
  it('handles braces inside strings', () => {
    expect(extractJsonObject('x {"a": "}{", "b": 1} y')).toBe('{"a": "}{", "b": 1}');
  });
  it('reports broken JSON and empty input', () => {
    expect(parseAnswerText('').ok).toBe(false);
    expect(parseAnswerText('нет json').ok).toBe(false);
    const broken = parseAnswerText('{"answers": [ {"question_id": "q1" "x": 1} ]}');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toMatch(/Некорректный JSON/);
  });
});

describe('validateAnswers', () => {
  it('accepts a complete correct answer', () => {
    const r = validateAnswers(all, {
      answers: [
        { question_id: 'q1', selected_options: ['option_2'], answer_text: 'Париж', confidence: 0.98 },
        { question_id: 'q2', selected_options: ['option_1', 'option_3'], confidence: 0.9 },
        { question_id: 'q3', selected_options: [], answer_text: 'Нил', confidence: 0.8 },
        { question_id: 'q4', selected_options: [], matches: [{ item_id: 'q4_item_1', option_id: 'option_1' }, { item_id: 'q4_item_2', option_id: 'option_2' }], confidence: 0.9 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.results.map((x) => x.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(r.results[1].selectedOptionIds).toEqual(['option_1', 'option_3']);
  });

  it('flags unknown question ids, unknown options and missing answers', () => {
    const r = validateAnswers(all, {
      answers: [
        { question_id: 'q1', selected_options: ['option_9'] },
        { question_id: 'q99', selected_options: ['option_1'] },
        { question_id: 'q3', answer_text: 'Нил' },
      ],
    });
    expect(r.ok).toBe(true); // q3 is usable
    expect(r.results[0].status).toBe('error');
    expect(r.results[0].messages.join()).toMatch(/option_9/);
    expect(r.warnings.join()).toMatch(/q99/);
    expect(r.warnings.join()).toMatch(/неполный/);
    expect(r.results.find((x) => x.questionId === 'q2')?.status).toBe('missing');
  });

  it('rejects several options for a single-choice question', () => {
    const r = validateAnswers([single], { answers: [{ question_id: 'q1', selected_options: ['option_1', 'option_2'] }] });
    expect(r.ok).toBe(false);
    expect(r.results[0].status).toBe('error');
  });

  it('maps option text and bare numbers to ids, with a warning', () => {
    const r = validateAnswers([single, multi], {
      answers: [
        { question_id: 'q1', selected_options: ['Париж'] },
        { question_id: 'q2', selected_options: [1, '3'] },
      ],
    });
    expect(r.results[0]).toMatchObject({ status: 'warning', selectedOptionIds: ['option_2'] });
    expect(r.results[1]).toMatchObject({ status: 'warning', selectedOptionIds: ['option_1', 'option_3'] });
  });

  it('rejects text answers without answer_text and matching without matches', () => {
    const r = validateAnswers([text, matching], {
      answers: [{ question_id: 'q3', selected_options: [] }, { question_id: 'q4', selected_options: ['option_1'] }],
    });
    expect(r.ok).toBe(false);
    expect(r.results.map((x) => x.status)).toEqual(['error', 'error']);
  });

  it('warns on low confidence and out-of-range values', () => {
    const r = validateAnswers([single], { answers: [{ question_id: 'q1', selected_options: ['option_2'], confidence: 0.3 }] });
    expect(r.results[0].status).toBe('warning');
    const pct = validateAnswers([single], { answers: [{ question_id: 'q1', selected_options: ['option_2'], confidence: 95 }] });
    expect(pct.results[0].confidence).toBeCloseTo(0.95);
  });

  it('rejects wrong top-level shapes', () => {
    expect(validateAnswers(all, { foo: 1 }).fatal).toMatch(/answers/);
    expect(validateAnswers(all, { answers: [] }).fatal).toMatch(/пуст/);
    expect(validateAnswers(all, 'x').ok).toBe(false);
  });
});
