import type {
  FillPlanItem,
  FillReportItem,
  LearnedNext,
  QuestionRule,
  NextCandidate,
  RecognitionResult,
} from './types';

/** Messages from the side panel to the content script. */
export type ContentRequest =
  | { kind: 'PING' }
  | { kind: 'RECOGNIZE' }
  | { kind: 'CLEAR_HIGHLIGHT' }
  | { kind: 'FILL'; plan: FillPlanItem[] }
  | { kind: 'FIND_NEXT' }
  | { kind: 'CLICK_NEXT'; selector: string }
  | { kind: 'FIND_FINISH' }
  /** Remember the next "Next"-like button the user clicks. */
  | { kind: 'NEXT_LEARN_START' }
  | { kind: 'NEXT_LEARN_CANCEL' }
  | { kind: 'NEXT_GET' }
  | { kind: 'NEXT_FORGET' }
  /** From the context menu: the current selection is a question's text. */
  | { kind: 'TEACH_QUESTION' }
  | { kind: 'TEACH_NEXT' }
  /** a shortcut pressed while the side panel had the keyboard focus */
  | { kind: 'HOTKEY'; action: 'question' | 'next' }
  | { kind: 'QUESTION_RULE_GET' }
  | { kind: 'QUESTION_RULE_FORGET' }
  /** Sent only after the user confirmed finishing the test in the panel. */
  | { kind: 'CLICK_FINISH'; selector: string };

export interface ContentResponses {
  PING: { ok: true; url: string };
  RECOGNIZE: RecognitionResult;
  CLEAR_HIGHLIGHT: { ok: true };
  FILL: { report: FillReportItem[] };
  FIND_NEXT: { candidates: NextCandidate[] };
  CLICK_NEXT: { ok: boolean; message: string };
  FIND_FINISH: { candidates: NextCandidate[] };
  CLICK_FINISH: { ok: boolean; message: string };
  /** key: chrome.storage.local key the learned button will be written to */
  NEXT_LEARN_START: { ok: true; key: string };
  NEXT_LEARN_CANCEL: { ok: true };
  NEXT_GET: { learned: LearnedNext | null };
  NEXT_FORGET: { ok: true };
  TEACH_QUESTION: { ok: boolean; message: string; rule?: QuestionRule; matches?: number };
  TEACH_NEXT: { ok: boolean; message: string; learned?: LearnedNext };
  HOTKEY: { ok: boolean; message: string };
  QUESTION_RULE_GET: { rule: QuestionRule | null };
  QUESTION_RULE_FORGET: { ok: true };
}

export type ContentResponse<K extends ContentRequest['kind']> = ContentResponses[K];

/** Broadcasts from the content script. */
export type ContentEvent =
  | { kind: 'NEXT_LEARNED'; learned: LearnedNext }
  /** The user clicked a finish-like button while we were learning: not remembered. */
  | { kind: 'NEXT_LEARN_REJECTED'; text: string }
  | { kind: 'QUESTION_RULE_SAVED'; rule: QuestionRule; matches: number }
  | { kind: 'QUESTION_RULE_FAILED'; message: string }
  | { kind: 'NEXT_TEACH_FAILED'; message: string };

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };
