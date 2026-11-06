import type { Question } from './types';

const TYPE_HINT: Record<Question['type'], string> = {
  single: 'один правильный вариант',
  true_false: 'верно / неверно, один вариант',
  multiple: 'может быть несколько правильных вариантов',
  dropdown: 'выпадающий список, один вариант',
  text: 'ввод текста',
  matching: 'сопоставление: заполни matches для каждого элемента',
};

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function formatQuestion(q: Question): string {
  const lines: string[] = [];
  lines.push(`[${q.id}] (${TYPE_HINT[q.type]})`);
  lines.push(`Вопрос: ${oneLine(q.text) || '(текст вопроса не найден)'}`);
  if (q.type === 'matching' && q.items?.length) {
    lines.push('Элементы для сопоставления:');
    for (const item of q.items) lines.push(`  ${item.id}: ${oneLine(item.text)}`);
  }
  if (q.options.length) {
    lines.push('Варианты:');
    for (const o of q.options) lines.push(`  ${o.id}: ${oneLine(o.text)}`);
  }
  return lines.join('\n');
}

export const AUTO_PROMPT_HEADER = `Ты — помощник по решению учебных тестовых заданий.
Реши вопросы ниже. Правила:
- Определи правильный ответ; если правильных вариантов несколько, укажи все.
- Используй только ID вариантов из списка, не придумывай новых и не меняй текст.
- Если информации недостаточно, верни пустой список answers и confidence = 0.

Ответь ТОЛЬКО JSON без пояснений, в таком формате:
{
  "answers": [
    {"question_id": "q1", "answers": ["option_2"], "confidence": 0.95},
    {"question_id": "q2", "answers": ["option_1", "option_3"], "confidence": 0.9},
    {"question_id": "q3", "text_answer": "Ответ на вопрос", "confidence": 0.92},
    {"question_id": "q4", "matches": [{"item_id": "q4_item_1", "option_id": "option_2"}], "confidence": 0.9}
  ]
}
- answers — ID выбранных вариантов (radio, checkbox, список, верно/неверно).
- text_answer — только для вопросов с вводом текста.
- matches — только для вопросов на сопоставление: для каждого элемента item_id укажи option_id.`;

/** Prompt for automatic mode: same question layout, shorter answer format. */
export function buildAutoPrompt(questions: Question[]): string {
  if (!questions.length) throw new Error('Нет вопросов для формирования запроса');
  const body = questions.map(formatQuestion).join('\n\n');
  return `${AUTO_PROMPT_HEADER}\n\nВопросы (${questions.length}):\n\n${body}\n`;
}

/** Follow-up when the previous reply could not be used. Repeats the questions so it stands alone. */
export function buildCorrectionPrompt(questions: Question[], problems: string[]): string {
  const list = problems.slice(0, 8).map((p) => `- ${p}`).join('\n');
  return `Твой предыдущий ответ не удалось обработать:\n${list}\n\nОтветь заново строго в формате JSON из предыдущего сообщения, только с ID из списка.\n\n${buildAutoPrompt(questions)}`;
}
