import { describe, expect, it } from 'vitest';
import { loadPage, recognizeAll } from './helpers';
import { recognizeDom } from '../src/content/recognize';

describe('recognizeDom', () => {
  it('single choice, including Moodle-like markup', () => {
    loadPage('single.html');
    const { questions } = recognizeAll();
    expect(questions.map((q) => q.id)).toEqual(['q1', 'q2', 'q3']);
    expect(questions.every((q) => q.type === 'single' && q.target === 'radio')).toBe(true);
    expect(questions[0].text).toBe('1. Столица Франции?');
    expect(questions[0].options.map((o) => o.text)).toEqual(['Берлин', 'Париж', 'Мадрид', 'Рим']);
    expect(questions[1].text).toBe('2. Сколько будет 7 × 8?');
    expect(questions[1].options.map((o) => o.text)).toEqual(['54', '56', '64']);
    // Moodle: question text comes from .qtext, not from "Выберите один ответ:" or the info block
    expect(questions[2].text).toBe('Какой химический элемент обозначается символом O?');
    expect(questions[2].options.map((o) => o.text)).toEqual(['a. Золото', 'b. Кислород', 'c. Осмий']);
    expect(questions[2].options.every((o) => !!o.selector)).toBe(true);
  });

  it('multiple choice: fieldset legend and Moodle-style checkbox names', () => {
    loadPage('multiple.html');
    const { questions } = recognizeAll();
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({ type: 'multiple', target: 'checkbox', text: '1. Какие из чисел простые?' });
    expect(questions[0].options.map((o) => o.text)).toEqual(['2', '4', '7', '9', '11']);
    expect(questions[1].text).toBe('2. Выберите языки программирования:');
    expect(questions[1].options).toHaveLength(4);
  });

  it('dropdowns and a matching table', () => {
    loadPage('dropdown.html');
    const { questions } = recognizeAll();
    expect(questions.map((q) => q.type)).toEqual(['dropdown', 'dropdown', 'matching']);
    expect(questions[0].text).toBe('1. В каком году началась Вторая мировая война?');
    expect(questions[0].options.map((o) => o.text)).toEqual(['1914', '1939', '1941']); // placeholder dropped
    expect(questions[1].text).toBe('2. Самая большая планета Солнечной системы:');
    expect(questions[1].options.map((o) => o.value)).toEqual(['earth', 'jupiter', 'saturn']);
    const m = questions[2];
    expect(m.text).toBe('3. Сопоставьте страны и их столицы.');
    expect(m.items?.map((i) => i.text)).toEqual(['Япония', 'Канада', 'Австралия']);
    expect(m.items?.map((i) => i.id)).toEqual(['q3_item_1', 'q3_item_2', 'q3_item_3']);
    expect(m.options.map((o) => o.text)).toEqual(['Токио', 'Оттава', 'Канберра']);
  });

  it('text inputs and textarea', () => {
    loadPage('text.html');
    const { questions } = recognizeAll();
    expect(questions.map((q) => q.type)).toEqual(['text', 'text', 'text']);
    expect(questions[0].text).toBe('1. Как называется самая длинная река в мире?');
    // generic "Ответ:" label is replaced with the real question text
    expect(questions[1].text).toBe('2. Чему равен квадратный корень из 144?');
    expect(questions[2].text).toBe('3. Кратко объясните, что такое фотосинтез.');
    expect(questions.every((q) => q.target === 'text' && q.selector)).toBe(true);
  });

  it('true / false', () => {
    loadPage('truefalse.html');
    const { questions } = recognizeAll();
    expect(questions.map((q) => q.type)).toEqual(['true_false', 'true_false']);
    expect(questions[1].options.map((o) => o.text)).toEqual(['True', 'False']);
  });

  it('mixed page keeps document order and unique ids', () => {
    loadPage('mixed.html');
    const { questions } = recognizeAll();
    expect(questions.map((q) => `${q.id}:${q.type}`)).toEqual([
      'q1:single', 'q2:multiple', 'q3:true_false', 'q4:dropdown', 'q5:text',
    ]);
    expect(new Set(questions.map((q) => q.id)).size).toBe(5);
  });

  it('ARIA widgets (role=radio / role=checkbox)', () => {
    loadPage('aria.html');
    const { questions } = recognizeAll();
    expect(questions.map((q) => `${q.type}:${q.target}`)).toEqual(['single:aria-radio', 'multiple:aria-checkbox']);
    expect(questions[0].text).toBe('1. Какой океан самый большой?');
    expect(questions[0].options.map((o) => o.text)).toEqual(['Атлантический', 'Тихий', 'Индийский']);
    expect(questions[1].text).toBe('2. Отметьте млекопитающих:');
  });

  it('region filter keeps only questions inside the region', () => {
    loadPage('single.html');
    const second = document.querySelector('input[name="q2"]')!.closest('.question')!;
    const { questions } = recognizeDom(document, { inRegion: (el) => second.contains(el) });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ id: 'q1', text: '2. Сколько будет 7 × 8?' });
  });

  it('ignores invisible controls', () => {
    loadPage('single.html');
    const hidden = document.querySelector('input[name="q1"]')!.closest('.question')!;
    const { questions } = recognizeDom(document, { inRegion: () => true, isVisible: (el) => !hidden.contains(el) });
    expect(questions).toHaveLength(2);
  });
});

describe('page-wide scan ignores site chrome', () => {
  it('skips header search, nav and footer controls', () => {
    document.body.innerHTML = `
      <header><input type="text" name="q" placeholder="Поиск по сайту"></header>
      <nav><select><option>RU</option><option>EN</option></select></nav>
      <input type="search" placeholder="Search">
      <div class="question"><p>Столица Франции?</p>
        <label><input type="radio" name="a" value="1"> Париж</label>
        <label><input type="radio" name="a" value="2"> Рим</label></div>
      <footer><input type="email" placeholder="Подписка"></footer>`;
    const { questions } = recognizeAll();
    expect(questions).toHaveLength(1);
    expect(questions[0].text).toBe('Столица Франции?');
  });
});
