import type {
  MatchPair,
  Question,
  QuestionResult,
  RawAnswer,
  ValidationReport,
} from './types';

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Finds the first balanced {...} block, respecting strings. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parses the JSON that the user pasted from DeepSeek.
 * Tolerates ```json fences, text around the object, smart quotes and trailing commas.
 */
export function parseAnswerText(raw: string): ParseResult {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'Поле ответа пустое. Вставьте JSON из DeepSeek.' };

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = extractJsonObject(fenced ? fenced[1] : text) ?? extractJsonObject(text);
  if (!candidate) return { ok: false, error: 'В тексте не найден JSON-объект ({ ... }).' };

  const attempts = [
    candidate,
    candidate.replace(/[“”«»]/g, '"').replace(/,\s*([}\]])/g, '$1'),
  ];
  let lastError = '';
  for (const attempt of attempts) {
    try {
      return { ok: true, value: JSON.parse(attempt) };
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  return { ok: false, error: `Некорректный JSON: ${lastError}` };
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[.。;:]+$/, '').trim();
}

function resolveOptionId(q: Question, value: string, messages: string[]): string | null {
  if (q.options.some((o) => o.id === value)) return value;
  // Tolerate "2" or "option 2" style ids.
  const num = value.match(/^(?:option[_\s-]?)?(\d+)$/i);
  if (num) {
    const id = `option_${num[1]}`;
    if (q.options.some((o) => o.id === id)) {
      messages.push(`ID "${value}" приведён к "${id}".`);
      return id;
    }
  }
  // Exact text match is still structured enough to trust, but flag it.
  const byText = q.options.filter((o) => norm(o.text) === norm(value));
  if (byText.length === 1) {
    messages.push(`Вариант указан текстом ("${value}"), сопоставлен с ${byText[0].id}.`);
    return byText[0].id;
  }
  return null;
}

function validateOne(q: Question, a: RawAnswer): QuestionResult {
  const messages: string[] = [];
  let hasError = false;
  let hasWarning = false;

  // confidence
  let confidence: number | null = null;
  if (a.confidence !== undefined && a.confidence !== null) {
    const c = typeof a.confidence === 'string' ? Number(a.confidence) : a.confidence;
    if (typeof c === 'number' && Number.isFinite(c)) {
      confidence = c > 1 && c <= 100 ? c / 100 : c;
      if (confidence < 0 || confidence > 1) {
        messages.push(`confidence вне диапазона 0..1: ${String(a.confidence)}`);
        confidence = Math.min(1, Math.max(0, confidence));
        hasWarning = true;
      }
    } else {
      messages.push('confidence не является числом.');
      hasWarning = true;
    }
  }

  const answerText = typeof a.answer_text === 'string' ? a.answer_text.trim() : '';
  if (a.answer_text !== undefined && typeof a.answer_text !== 'string') {
    messages.push('answer_text должен быть строкой.');
    hasWarning = true;
  }

  // selected_options
  const selectedOptionIds: string[] = [];
  let rawSelected: unknown[] = [];
  if (Array.isArray(a.selected_options)) rawSelected = a.selected_options;
  else if (typeof a.selected_options === 'string') {
    rawSelected = [a.selected_options];
    messages.push('selected_options должен быть массивом, строка принята как один вариант.');
    hasWarning = true;
  } else if (a.selected_options !== undefined && a.selected_options !== null) {
    messages.push('selected_options имеет неверный тип.');
    hasError = true;
  }
  for (const v of rawSelected) {
    if (typeof v !== 'string' && typeof v !== 'number') {
      messages.push(`Неверный элемент selected_options: ${JSON.stringify(v)}`);
      hasError = true;
      continue;
    }
    const before = messages.length;
    const id = resolveOptionId(q, String(v), messages);
    if (messages.length > before) hasWarning = true; // id was coerced from text / number
    if (!id) {
      messages.push(`Вариант "${String(v)}" не существует в вопросе ${q.id}.`);
      hasError = true;
    } else if (!selectedOptionIds.includes(id)) selectedOptionIds.push(id);
    else hasWarning = true;
  }

  // matches
  const matches: MatchPair[] = [];
  if (q.type === 'matching') {
    const items = q.items ?? [];
    if (!Array.isArray(a.matches)) {
      messages.push('Для сопоставления нужен массив matches.');
      hasError = true;
    } else {
      for (const m of a.matches as unknown[]) {
        const rec = (m ?? {}) as Record<string, unknown>;
        const itemId = String(rec.item_id ?? '');
        const optRaw = rec.option_id;
        if (!items.some((i) => i.id === itemId)) {
          messages.push(`Элемент "${itemId}" не существует.`);
          hasError = true;
          continue;
        }
        const before = messages.length;
        const optionId = optRaw == null ? null : resolveOptionId(q, String(optRaw), messages);
        if (messages.length > before) hasWarning = true;
        if (!optionId) {
          messages.push(`Для ${itemId} указан несуществующий вариант "${String(optRaw)}".`);
          hasError = true;
          continue;
        }
        if (matches.some((p) => p.itemId === itemId)) {
          messages.push(`Элемент ${itemId} сопоставлен несколько раз.`);
          hasWarning = true;
          continue;
        }
        matches.push({ itemId, optionId });
      }
      const missing = items.filter((i) => !matches.some((p) => p.itemId === i.id));
      if (missing.length) {
        messages.push(`Не сопоставлены: ${missing.map((i) => i.id).join(', ')}.`);
        hasWarning = true;
      }
    }
  }

  // type-specific rules
  switch (q.type) {
    case 'single':
    case 'true_false':
    case 'dropdown':
      if (selectedOptionIds.length === 0) {
        messages.push('Не выбран ни один вариант.');
        hasError = true;
      } else if (selectedOptionIds.length > 1) {
        messages.push(`Вопрос допускает один вариант, получено ${selectedOptionIds.length}.`);
        hasError = true;
      }
      break;
    case 'multiple':
      if (selectedOptionIds.length === 0) {
        messages.push('Не выбран ни один вариант.');
        hasError = true;
      }
      break;
    case 'text':
      if (!answerText) {
        messages.push('Для поля ввода нужен непустой answer_text.');
        hasError = true;
      }
      break;
    case 'matching':
      if (matches.length === 0) hasError = true;
      break;
  }

  if (confidence !== null && confidence < 0.5 && !hasError) {
    messages.push(`Низкая уверенность (${confidence}). Проверьте ответ вручную.`);
    hasWarning = true;
  }

  return {
    questionId: q.id,
    status: hasError ? 'error' : hasWarning ? 'warning' : 'ok',
    selectedOptionIds,
    answerText,
    matches,
    confidence,
    messages,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** One answer in either format: {selected_options, answer_text} or {answers, text_answer}. */
function normalizeEntry(e: unknown): unknown {
  if (!isRecord(e)) return e;
  const out: Record<string, unknown> = { ...e };
  if (out.selected_options === undefined && Array.isArray(e.answers)) out.selected_options = e.answers;
  if (out.answer_text === undefined && e.text_answer !== undefined) out.answer_text = e.text_answer;
  delete out.answers;
  delete out.text_answer;
  return out;
}

/**
 * Accepts every shape the prompts allow:
 *  {"answers": [{question_id, selected_options|answers, answer_text|text_answer, matches, confidence}]}
 *  {"question_id": "q1", "answers": ["option_2"], ...}   (one question)
 *  [{...}, {...}]                                         (bare list)
 */
export function normalizeAnswerPayload(parsed: unknown): { value: unknown; note: string | null } {
  if (Array.isArray(parsed)) return { value: { answers: parsed.map(normalizeEntry) }, note: 'Получен массив вместо объекта {"answers": [...]}; принят как answers.' };
  if (!isRecord(parsed)) return { value: parsed, note: null };
  if (typeof parsed.question_id === 'string' || typeof parsed.question_id === 'number')
    return { value: { answers: [normalizeEntry(parsed)] }, note: null };
  if (Array.isArray(parsed.answers) && parsed.answers.every((a) => isRecord(a)))
    return { value: { ...parsed, answers: parsed.answers.map(normalizeEntry) }, note: null };
  return { value: parsed, note: null };
}

export function validateAnswers(questions: Question[], rawParsed: unknown): ValidationReport {
  const warnings: string[] = [];
  const fail = (fatal: string): ValidationReport => ({ ok: false, fatal, results: [], warnings });
  const normalized = normalizeAnswerPayload(rawParsed);
  if (normalized.note) warnings.push(normalized.note);
  let parsed = normalized.value;

  if (!isRecord(parsed)) return fail('Ожидался JSON-объект с полем "answers".');
  parsed = parsed as Record<string, unknown>;
  const answers = (parsed as Record<string, unknown>).answers;
  if (!Array.isArray(answers)) return fail('Поле "answers" отсутствует или не является массивом.');
  if (answers.length === 0) return fail('Массив "answers" пуст.');

  const byId = new Map(questions.map((q) => [q.id, q]));
  const seen = new Map<string, QuestionResult>();

  answers.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      warnings.push(`answers[${index}] не является объектом и пропущен.`);
      return;
    }
    const a = entry as RawAnswer;
    const qid = typeof a.question_id === 'string' ? a.question_id.trim() : String(a.question_id ?? '');
    const q = byId.get(qid);
    if (!q) {
      warnings.push(`answers[${index}]: вопрос "${qid}" не существует среди распознанных.`);
      return;
    }
    if (seen.has(qid)) {
      warnings.push(`Вопрос ${qid} встречается несколько раз, использован первый ответ.`);
      return;
    }
    seen.set(qid, validateOne(q, { ...a, question_id: qid }));
  });

  const results: QuestionResult[] = questions.map(
    (q) =>
      seen.get(q.id) ?? {
        questionId: q.id,
        status: 'missing',
        selectedOptionIds: [],
        answerText: '',
        matches: [],
        confidence: null,
        messages: ['Ответ на этот вопрос отсутствует.'],
      },
  );

  const missing = results.filter((r) => r.status === 'missing').length;
  if (missing) warnings.push(`Ответ неполный: нет ответов на ${missing} из ${questions.length} вопросов.`);

  const usable = results.some((r) => r.status === 'ok' || r.status === 'warning');
  return {
    ok: usable,
    fatal: usable ? null : 'Нет ни одного корректного ответа для заполнения.',
    results,
    warnings,
  };
}
