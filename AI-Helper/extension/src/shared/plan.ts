import type { FillAction, FillPlanItem, Question, QuestionResult } from './types';

function optionText(q: Question, id: string): string {
  return q.options.find((o) => o.id === id)?.text ?? id;
}

/**
 * Turns validated answers into concrete DOM actions.
 * Questions with errors, missing answers or no fillable target are skipped.
 */
export function buildFillPlan(
  questions: Question[],
  results: QuestionResult[],
  include: (questionId: string) => boolean = () => true,
): { plan: FillPlanItem[]; skipped: { questionId: string; reason: string }[] } {
  const plan: FillPlanItem[] = [];
  const skipped: { questionId: string; reason: string }[] = [];

  for (const q of questions) {
    const r = results.find((x) => x.questionId === q.id);
    if (!r || r.status === 'missing') {
      skipped.push({ questionId: q.id, reason: 'нет ответа' });
      continue;
    }
    if (r.status === 'error') {
      skipped.push({ questionId: q.id, reason: 'ответ содержит ошибки' });
      continue;
    }
    if (!include(q.id)) {
      skipped.push({ questionId: q.id, reason: 'исключён пользователем' });
      continue;
    }
    if (q.target === 'none') {
      skipped.push({ questionId: q.id, reason: 'на странице нет полей для заполнения (только показ ответа)' });
      continue;
    }

    const actions: FillAction[] = [];
    switch (q.target) {
      case 'radio':
      case 'aria-radio': {
        const opt = q.options.find((o) => o.id === r.selectedOptionIds[0]);
        if (opt?.selector)
          actions.push({
            type: 'check',
            selector: opt.selector,
            checked: true,
            control: q.target === 'radio' ? 'native' : 'aria',
            label: opt.text,
          });
        break;
      }
      case 'checkbox':
      case 'aria-checkbox':
        for (const opt of q.options) {
          if (!opt.selector) continue;
          actions.push({
            type: 'check',
            selector: opt.selector,
            checked: r.selectedOptionIds.includes(opt.id),
            control: q.target === 'checkbox' ? 'native' : 'aria',
            label: opt.text,
          });
        }
        break;
      case 'select':
        if (q.type === 'matching') {
          for (const pair of r.matches) {
            const item = q.items?.find((i) => i.id === pair.itemId);
            const opt = q.options.find((o) => o.id === pair.optionId);
            if (item?.selector && opt?.value !== undefined)
              actions.push({
                type: 'select',
                selector: item.selector,
                value: opt.value,
                label: `${item.text} → ${opt.text}`,
              });
          }
        } else {
          const opt = q.options.find((o) => o.id === r.selectedOptionIds[0]);
          if (q.selector && opt?.value !== undefined)
            actions.push({ type: 'select', selector: q.selector, value: opt.value, label: opt.text });
        }
        break;
      case 'text':
        if (q.selector && r.answerText)
          actions.push({ type: 'text', selector: q.selector, value: r.answerText, label: r.answerText });
        break;
    }

    if (!actions.length) {
      skipped.push({ questionId: q.id, reason: 'не удалось сопоставить ответ с элементами страницы' });
      continue;
    }

    const summary =
      q.type === 'text'
        ? `Ввести: «${r.answerText}»`
        : q.type === 'matching'
          ? `Сопоставить ${actions.length} элемент(ов)`
          : `Выбрать: ${r.selectedOptionIds.map((id) => `«${optionText(q, id)}»`).join(', ')}`;
    plan.push({ questionId: q.id, summary, actions });
  }
  return { plan, skipped };
}
