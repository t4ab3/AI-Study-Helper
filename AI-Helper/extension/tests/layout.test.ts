import { describe, expect, it } from 'vitest';
import { recognizeAll } from './helpers';
import { clickNext, clickableOf, findLearned, findNextCandidates } from '../src/content/navigation';
import type { LearnedNext } from '../src/shared/types';

const set = (html: string) => {
  document.body.innerHTML = html;
};

describe('question text in unusual layouts', () => {
  it('finds the text above the options when another control sits next to them', () => {
    set(`<div class="test"><div class="top">Вопрос 1 из 2</div>
      <p>Столица Франции?</p>
      <div class="row">
        <div class="col"><label><input type="radio" name="a" value="1"> Берлин</label><label><input type="radio" name="a" value="2"> Париж</label></div>
        <div class="col"><label><input type="checkbox" name="sure"> Уверен</label></div>
      </div></div>`);
    const { questions } = recognizeAll();
    const q = questions.find((x) => x.type === 'single')!;
    expect(q.text).toBe('Столица Франции?');
  });

  it('ignores "Отметить вопрос" flags', () => {
    set(`<div class="que"><p>Сколько бит в байте?</p>
      <div><label><input type="radio" name="b" value="4"> 4</label><label><input type="radio" name="b" value="8"> 8</label></div>
      <label><input type="checkbox" name="flag"> Отметить вопрос</label></div>`);
    const { questions } = recognizeAll();
    expect(questions).toHaveLength(1);
    expect(questions[0].text).toBe('Сколько бит в байте?');
  });

  it('does not take button captions as the question text', () => {
    set(`<div class="layout"><div class="q">Столица Италии?</div>
      <div class="a"><label><input type="radio" name="c" value="1"> Рим</label><label><input type="radio" name="c" value="2"> Милан</label>
      <div class="go" style="cursor:pointer"><span>Перейти</span></div><a href="#">Пропустить</a></div></div>`);
    const { questions } = recognizeAll();
    expect(questions[0].text).toBe('Столица Италии?');
  });

  it('skips "Вопрос 3"-like labels and reads the text before them', () => {
    set(`<p>Сколько будет 2+2?</p>
      <div class="q"><span>Вопрос 3</span><label><input type="radio" name="d" value="4"> 4</label><label><input type="radio" name="d" value="5"> 5</label></div>`);
    const { questions } = recognizeAll();
    expect(questions[0].text).toBe('Сколько будет 2+2?');
  });

  it('a text field with a generic "Ответ:" label gets the question from the page', () => {
    set(`<div class="layout"><div class="qcol"><div id="qtext">Столица Италии?</div></div>
      <div class="acol"><div class="card"><label for="t">Ответ:</label><input type="text" id="t"></div>
      <label class="flag"><input type="checkbox" name="flag"> Отметить вопрос</label>
      <div class="go" style="cursor:pointer"><span>Перейти</span></div></div></div>`);
    const { questions } = recognizeAll();
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ type: 'text', text: 'Столица Италии?' });
  });
});

describe('"Next" buttons that are not buttons', () => {
  it('finds a clickable div with the text "Далее"', () => {
    set(`<div class="nav"><div class="btn-like" style="cursor:pointer"><span>Далее</span></div></div>`);
    const c = findNextCandidates(document, () => true, () => false);
    expect(c.map((x) => x.text)).toEqual(['Далее']);
    expect(clickNext(document, c[0].selector).ok).toBe(true);
  });

  it('remembers the clicked element, not the answer the user picked', () => {
    set(`<label id="opt"><input type="radio" name="x"> Париж</label>
      <div class="go" style="cursor:pointer"><span id="inner">Перейти</span></div>`);
    expect(clickableOf(document.getElementById('opt')!)).toBeNull();
    expect(clickableOf(document.querySelector('#opt input')!)).toBeNull();
    expect(clickableOf(document.getElementById('inner')!)?.className).toBe('go');
  });

  it('finds the remembered button again, even when its position changed', () => {
    set(`<main><div class="go" style="cursor:pointer">Перейти</div></main>`);
    const learned: LearnedNext = { selector: 'body > div:nth-of-type(3)', text: 'Перейти', tag: 'div', url: '', savedAt: 0 };
    const el = findLearned(document, learned, () => true, () => false);
    expect(el?.className).toBe('go');
    // a remembered button may have any caption, but only that one is clicked
    expect(clickNext(document, 'main > div', el).ok).toBe(true);
    expect(clickNext(document, 'main > div', null).ok).toBe(false);
  });

  it('never treats a finish button as the remembered "Next"', () => {
    set(`<div class="go" style="cursor:pointer">Завершить тест</div>`);
    const learned: LearnedNext = { selector: 'div.go', text: '', tag: 'div', url: '', savedAt: 0 };
    expect(findLearned(document, learned, () => true, () => false)).toBeNull();
    const el = document.querySelector<HTMLElement>('div.go')!;
    expect(clickNext(document, 'div.go', el).ok).toBe(false);
  });
});
