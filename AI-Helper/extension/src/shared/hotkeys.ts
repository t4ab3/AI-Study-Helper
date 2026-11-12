// Keyboard shortcuts for sites that block the right-click menu:
// one key marks the selected text as the question, another marks the button under the cursor as "Next".

export interface Hotkey {
  /** KeyboardEvent.code: the physical key, so K works in the Ukrainian / Russian layout too (Л) */
  code: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface Hotkeys {
  enabled: boolean;
  question: Hotkey;
  next: Hotkey;
}

export const HOTKEYS_KEY = 'hotkeys';

export const DEFAULT_HOTKEYS: Hotkeys = {
  enabled: true,
  question: { code: 'KeyK' },
  next: { code: 'KeyM' },
};

/** Keys that cannot be a shortcut on their own. */
const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)/;
const RESERVED = new Set(['Escape', 'Tab', 'Enter', 'NumpadEnter', 'Space', 'Backspace']);

type KeyLike = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

/** A key press (from the settings field) as a shortcut, or null if it cannot be one. */
export function hotkeyFromEvent(e: KeyLike): Hotkey | null {
  if (!e.code || MODIFIER_CODES.test(e.code) || RESERVED.has(e.code) || e.metaKey) return null;
  const hk: Hotkey = { code: e.code };
  if (e.ctrlKey) hk.ctrl = true;
  if (e.altKey) hk.alt = true;
  if (e.shiftKey) hk.shift = true;
  return hk;
}

export function matchesHotkey(e: KeyLike, hk: Hotkey): boolean {
  return (
    e.code === hk.code && !!e.ctrlKey === !!hk.ctrl && !!e.altKey === !!hk.alt && !!e.shiftKey === !!hk.shift && !e.metaKey
  );
}

export function sameHotkey(a: Hotkey, b: Hotkey): boolean {
  return a.code === b.code && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift;
}

function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  const names: Record<string, string> = {
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Insert: 'Insert',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
  };
  return names[code] ?? code;
}

/** "K", "Alt+K", "Ctrl+Shift+1" */
export function hotkeyLabel(hk: Hotkey): string {
  return [hk.ctrl && 'Ctrl', hk.alt && 'Alt', hk.shift && 'Shift', keyName(hk.code)].filter(Boolean).join('+');
}

/** Stored value → valid settings (anything broken falls back to the defaults). */
export function normalizeHotkeys(v: unknown): Hotkeys {
  const o = (v ?? {}) as Partial<Hotkeys>;
  const ok = (h: unknown): h is Hotkey => !!h && typeof (h as Hotkey).code === 'string' && !!(h as Hotkey).code;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_HOTKEYS.enabled,
    question: ok(o.question) ? o.question : DEFAULT_HOTKEYS.question,
    next: ok(o.next) ? o.next : DEFAULT_HOTKEYS.next,
  };
}

/** Typing into a field must never trigger a shortcut. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !['radio', 'checkbox', 'button', 'submit', 'reset', 'image', 'range', 'color', 'file'].includes(type);
  }
  return (el as HTMLElement).isContentEditable === true;
}
