// Core data model shared by the content script, side panel and tests.

export type QuestionType =
  | 'single'
  | 'multiple'
  | 'dropdown'
  | 'text'
  | 'true_false'
  | 'matching';

/** How a question can be filled on the page. `none` = recognized from plain text / OCR, answer is display-only. */
export type TargetKind =
  | 'radio'
  | 'checkbox'
  | 'aria-radio'
  | 'aria-checkbox'
  | 'select'
  | 'text'
  | 'none';

export interface AnswerOption {
  id: string; // option_1, option_2 ... (unique inside its question)
  text: string;
  /** CSS selector of the clickable control (radio / checkbox / aria element). */
  selector?: string;
  /** <option value> for dropdowns. */
  value?: string;
}

export interface MatchItem {
  id: string; // q5_item_1 ...
  text: string;
  /** Selector of the <select> for this item. */
  selector?: string;
}

export interface Question {
  id: string; // q1, q2 ...
  type: QuestionType;
  text: string;
  options: AnswerOption[];
  items?: MatchItem[];
  target: TargetKind;
  /** Selector of the single control (select / text input) when the question has one. */
  selector?: string;
  source: 'dom' | 'text' | 'ocr';
}

export type RecognitionMode = 'dom' | 'text' | 'ocr' | 'none';

export interface RecognitionResult {
  mode: RecognitionMode;
  questions: Question[];
  rawText: string;
  warnings: string[];
}

// ---------- answers ----------

export interface RawAnswer {
  question_id: string;
  selected_options?: unknown;
  answer_text?: unknown;
  confidence?: unknown;
  matches?: unknown;
}

export type AnswerStatus = 'ok' | 'warning' | 'error' | 'missing';

export interface MatchPair {
  itemId: string;
  optionId: string;
}

export interface QuestionResult {
  questionId: string;
  status: AnswerStatus;
  selectedOptionIds: string[];
  answerText: string;
  matches: MatchPair[];
  confidence: number | null;
  messages: string[];
}

export interface ValidationReport {
  ok: boolean; // JSON parsed and at least one usable answer
  fatal: string | null; // JSON-level error (nothing usable)
  results: QuestionResult[];
  warnings: string[];
}

// ---------- filling ----------

export type FillAction =
  | { type: 'check'; selector: string; checked: boolean; control: 'native' | 'aria'; label: string }
  | { type: 'select'; selector: string; value: string; label: string }
  | { type: 'text'; selector: string; value: string; label: string };

export interface FillPlanItem {
  questionId: string;
  summary: string;
  actions: FillAction[];
}

export interface ActionReport {
  action: FillAction;
  ok: boolean;
  message: string;
}

export interface FillReportItem {
  questionId: string;
  ok: boolean;
  actions: ActionReport[];
}

// ---------- statuses ----------

export interface NextCandidate {
  selector: string;
  text: string;
  /** Present but disabled (e.g. "Далее" waits until the answer is accepted). */
  disabled?: boolean;
  /** The button the user showed by clicking it once (remembered per site). */
  learned?: boolean;
}

/** "This is the question text" rule taught by the user, stored per site as `questionRule:<site>`. */
export interface QuestionRule {
  selector: string;
  /** the text the user selected, for display */
  sample: string;
  url: string;
  savedAt: number;
}

/** "Next" button remembered from the user's click, stored per site as `nextButton:<site>`. */
export interface LearnedNext {
  selector: string;
  text: string;
  tag: string;
  url: string;
  savedAt: number;
}
