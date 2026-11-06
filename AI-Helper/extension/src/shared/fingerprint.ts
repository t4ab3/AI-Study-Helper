import type { Question } from './types';

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Identity of a question that does not depend on its position or id, used to avoid
 * solving the same question twice while the page is still updating.
 * Selectors are included so that two different questions with identical text on one page
 * (e.g. "Выберите правильный ответ" with images) still differ.
 */
export function fingerprint(q: Question): string {
  const parts = [
    q.type,
    norm(q.text),
    ...q.options.map((o) => norm(o.text)),
    ...(q.items ?? []).map((i) => norm(i.text)),
    q.selector ?? q.options[0]?.selector ?? q.items?.[0]?.selector ?? '',
  ];
  let h = 5381;
  const s = parts.join('\u001f');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${q.type}:${(h >>> 0).toString(36)}:${norm(q.text).slice(0, 40)}`;
}

/** Gives questions run-wide ids (q7, q7_item_1 …) so a stale reply cannot match a new question. */
export function renumber(questions: Question[], startAt: number): Question[] {
  return questions.map((q, i) => {
    const id = `q${startAt + i}`;
    return {
      ...q,
      id,
      items: q.items?.map((it, k) => ({ ...it, id: `${id}_item_${k + 1}` })),
    };
  });
}
