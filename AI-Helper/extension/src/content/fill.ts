import type { ActionReport, FillAction, FillPlanItem, FillReportItem } from '../shared/types';

function find(doc: Document, selector: string): HTMLElement | null {
  try {
    return doc.querySelector<HTMLElement>(selector);
  } catch {
    return null;
  }
}

/** Sets a value through the prototype setter so React/Vue-controlled inputs notice the change. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
}

function fire(el: Element, type: string): void {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

function isChecked(el: HTMLElement, control: 'native' | 'aria'): boolean {
  if (control === 'native') return (el as HTMLInputElement).checked;
  return el.getAttribute('aria-checked') === 'true';
}

function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
}

/** Current state matches the action? Used both after filling and for the separate "verify" step. */
export function verifyAction(doc: Document, action: FillAction): ActionReport {
  const el = find(doc, action.selector);
  if (!el) return { action, ok: false, message: 'Элемент не найден на странице' };
  switch (action.type) {
    case 'check': {
      const state = isChecked(el, action.control);
      return state === action.checked
        ? { action, ok: true, message: action.checked ? 'Отмечено' : 'Снято' }
        : { action, ok: false, message: `Состояние не совпадает (сейчас ${state ? 'отмечено' : 'не отмечено'})` };
    }
    case 'select': {
      const v = (el as HTMLSelectElement).value;
      return v === action.value
        ? { action, ok: true, message: 'Выбрано' }
        : { action, ok: false, message: `Выбрано другое значение: "${v}"` };
    }
    case 'text': {
      const v = (el as HTMLInputElement).value;
      return v === action.value
        ? { action, ok: true, message: 'Введено' }
        : { action, ok: false, message: `В поле другое значение: "${v}"` };
    }
  }
}

function runAction(doc: Document, action: FillAction): ActionReport {
  const el = find(doc, action.selector);
  if (!el) return { action, ok: false, message: 'Элемент не найден (страница изменилась? Считайте тест заново)' };
  if (isDisabled(el)) return { action, ok: false, message: 'Элемент заблокирован' };

  switch (action.type) {
    case 'check': {
      if (isChecked(el, action.control) !== action.checked) {
        // click() fires click/input/change exactly like a user would
        el.click();
        if (action.control === 'native' && (el as HTMLInputElement).checked !== action.checked) {
          (el as HTMLInputElement).checked = action.checked;
          fire(el, 'input');
          fire(el, 'change');
        }
      }
      break;
    }
    case 'select': {
      const sel = el as HTMLSelectElement;
      if (!Array.from(sel.options).some((o) => o.value === action.value))
        return { action, ok: false, message: `В списке нет значения "${action.value}"` };
      sel.focus();
      setNativeValue(sel, action.value);
      fire(sel, 'input');
      fire(sel, 'change');
      sel.blur();
      break;
    }
    case 'text': {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      if (input.readOnly) return { action, ok: false, message: 'Поле только для чтения' };
      input.focus();
      setNativeValue(input, action.value);
      fire(input, 'input');
      fire(input, 'change');
      input.blur();
      break;
    }
  }
  return verifyAction(doc, action);
}

export function applyPlan(doc: Document, plan: FillPlanItem[]): FillReportItem[] {
  return plan.map((item) => {
    // Unchecks go first so that "max N answers" widgets do not block new checks.
    const ordered = [...item.actions].sort((a, b) => {
      const ua = a.type === 'check' && !a.checked ? 0 : 1;
      const ub = b.type === 'check' && !b.checked ? 0 : 1;
      return ua - ub;
    });
    const actions = ordered.map((a) => {
      try {
        return runAction(doc, a);
      } catch (e) {
        return { action: a, ok: false, message: `Ошибка: ${(e as Error).message}` };
      }
    });
    return { questionId: item.questionId, ok: actions.every((a) => a.ok), actions };
  });
}

export function verifyPlan(doc: Document, plan: FillPlanItem[]): FillReportItem[] {
  return plan.map((item) => {
    const actions = item.actions.map((a) => verifyAction(doc, a));
    return { questionId: item.questionId, ok: actions.every((a) => a.ok), actions };
  });
}
