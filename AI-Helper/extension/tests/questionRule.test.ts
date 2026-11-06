import { describe, expect, it } from 'vitest';
import { recognizeDom } from '../src/content/recognize';
import { buildQuestionSelector, questionElementFromRange } from '../src/content/questionRule';
import { buttonFromTarget } from '../src/content/navigation';

const set = (html: string) => {
  document.body.innerHTML = html;
};
const recognize = (questionSelector?: string | null) =>
  recognizeDom(document, { inRegion: () => true, questionSelector }).questions;

function selectText(el: Element): Range {
  const r = document.createRange();
  r.selectNodeContents(el);
  return r;
}

const PAGE = `
  <div class="qq-head">Вопрос 1 из 2</div>
  <div class="qq-title"><b id="t">Столица Франции?</b></div>
  <div class="card"><p class="hint">Выберите один вариант из списка ниже</p>
    <label><input type="radio" name="a" value="1"> Берлин</label><label><input type="radio" name="a" value="2"> Париж</label></div>`;

describe('"это текст вопроса" rule', () => {
  it('automatic search picks the hint here, the taught rule picks the question', () => {
    set(PAGE);
    expect(recognize()[0].text).not.toMatch(/Франции/); // the hint text, not the question
    const el = questionElementFromRange(selectText(document.getElementById('t')!))!;
    expect(el.className).toBe('qq-title'); // stepped out of the <b> wrapper
    const selector = buildQuestionSelector(el)!;
    expect(selector).toBe('div.qq-title');
    expect(recognize(selector)[0].text).toBe('Столица Франции?');
  });

  it('every question on the page gets its own text, not the previous one', () => {
    set(`
      <div class="q"><p class="question-text q-1">Столица Франции?</p>
        <div><p>подсказка</p><label><input type="radio" name="a"> Париж</label><label><input type="radio" name="a"> Рим</label></div></div>
      <div class="q"><div><p>подсказка</p><label><input type="radio" name="b"> 4</label><label><input type="radio" name="b"> 8</label></div></div>
      <div class="q"><p class="question-text q-3">Сколько будет 2+2?</p>
        <div><p>подсказка</p><label><input type="radio" name="c"> 4</label><label><input type="radio" name="c"> 5</label></div></div>`);
    const el = document.querySelector('.q-1')!;
    const selector = buildQuestionSelector(el)!;
    expect(selector).toBe('p.question-text'); // the numbered class is left out
    const qs = recognize(selector);
    // the group without its own question text is not a separate question
    expect(qs.map((q) => q.text)).toEqual(['Столица Франции?', 'Сколько будет 2+2?']);
    expect(qs[1].options.map((o) => o.text)).toEqual(['4', '5']);
  });

  it('with a taught rule, site menus and question navigators are not questions', () => {
    set(`
      <div class="top">Шрифт: <label><input type="radio" name="font"> обычный</label><label><input type="radio" name="font"> крупный</label></div>
      <div class="qq-title"><b>Столица Франции?</b></div>
      <div class="card"><p class="hint">Выберите один вариант</p>
        <label><input type="radio" name="a"> Берлин</label><label><input type="radio" name="a"> Париж</label></div>
      <div class="nav">К вопросу: <label><input type="radio" name="go"> 1</label><label><input type="radio" name="go"> 2</label></div>`);
    expect(recognize().length).toBe(3); // the automatic search sees three groups
    const qs = recognize('div.qq-title');
    expect(qs.length).toBe(1);
    expect(qs[0].text).toBe('Столица Франции?');
    expect(qs[0].options.map((o) => o.text)).toEqual(['Берлин', 'Париж']);
  });

  it('a rule that matches nothing on the page leaves the automatic search alone', () => {
    set(PAGE);
    expect(recognize('div.no-such-class').length).toBe(1);
  });

  it('a selection that spills over the options is cut to the question block', () => {
    set(PAGE);
    const r = document.createRange();
    r.setStart(document.getElementById('t')!.firstChild!, 0);
    r.setEnd(document.querySelector('label')!, 1);
    const el = questionElementFromRange(r);
    expect(el?.className).toBe('qq-title');
  });

  it('an id without numbers is used as is; a numbered id becomes a prefix', () => {
    set(`<div id="qtext">Вопрос?</div><div id="question-12-text">Другой?</div>`);
    expect(buildQuestionSelector(document.getElementById('qtext')!)).toBe('#qtext');
    expect(buildQuestionSelector(document.getElementById('question-12-text')!)).toBe('div[id^="question-"]');
  });

  it('never uses a selector that would grab whole cards with the options', () => {
    set(`<div class="card"><span>Столица?</span><label><input type="radio" name="a"> A</label></div>`);
    const span = document.querySelector('span')!;
    // span alone: fine
    expect(buildQuestionSelector(span)).toBe('div.card > span');
  });
});

describe('"это кнопка «Далее»" target', () => {
  it('a click on an svg arrow gives the element that holds the icon', () => {
    set(`<div id="go" class="arrow"><svg><path d="M0 0"/></svg></div><label><input type="radio" name="a"> A</label>`);
    expect(buttonFromTarget(document.querySelector('path')!)?.id).toBe('go');
  });
  it('answers and long text are not buttons', () => {
    set(`<label id="l"><input type="radio" name="a"> Париж</label><p id="p">${'длинный текст '.repeat(10)}</p>`);
    expect(buttonFromTarget(document.getElementById('l')!)).toBeNull();
    expect(buttonFromTarget(document.getElementById('p')!)).toBeNull();
  });
  it('a real button is used even when the click lands on its inner span', () => {
    set(`<button id="b"><span>Перейти</span></button>`);
    expect(buttonFromTarget(document.querySelector('span')!)?.id).toBe('b');
  });
});
