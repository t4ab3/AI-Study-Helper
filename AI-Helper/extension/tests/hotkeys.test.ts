import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOTKEYS,
  hotkeyFromEvent,
  hotkeyLabel,
  isTypingTarget,
  matchesHotkey,
  normalizeHotkeys,
} from '../src/shared/hotkeys';

const key = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('keyboard shortcuts', () => {
  it('K and M by default, by physical key (so «Л» in the Cyrillic layout is K)', () => {
    expect(matchesHotkey(key('KeyK'), DEFAULT_HOTKEYS.question)).toBe(true);
    expect(matchesHotkey(key('KeyM'), DEFAULT_HOTKEYS.next)).toBe(true);
    expect(matchesHotkey(key('KeyK', { ctrlKey: true }), DEFAULT_HOTKEYS.question)).toBe(false); // Ctrl+K is not K
    expect(matchesHotkey(key('KeyL'), DEFAULT_HOTKEYS.question)).toBe(false);
  });

  it('records a new key with its modifiers, ignores a lone modifier and reserved keys', () => {
    expect(hotkeyFromEvent(key('KeyQ', { altKey: true }))).toEqual({ code: 'KeyQ', alt: true });
    expect(hotkeyFromEvent(key('ShiftLeft', { shiftKey: true }))).toBeNull();
    expect(hotkeyFromEvent(key('Enter'))).toBeNull();
    expect(hotkeyFromEvent(key('Escape'))).toBeNull();
    const hk = hotkeyFromEvent(key('Digit2', { ctrlKey: true, shiftKey: true }))!;
    expect(matchesHotkey(key('Digit2', { ctrlKey: true, shiftKey: true }), hk)).toBe(true);
    expect(hotkeyLabel(hk)).toBe('Ctrl+Shift+2');
  });

  it('labels', () => {
    expect(hotkeyLabel({ code: 'KeyK' })).toBe('K');
    expect(hotkeyLabel({ code: 'F2' })).toBe('F2');
    expect(hotkeyLabel({ code: 'Period', alt: true })).toBe('Alt+.');
  });

  it('broken stored settings fall back to the defaults', () => {
    expect(normalizeHotkeys(undefined)).toEqual(DEFAULT_HOTKEYS);
    expect(normalizeHotkeys({ enabled: false, question: { code: '' } })).toEqual({ ...DEFAULT_HOTKEYS, enabled: false });
    expect(normalizeHotkeys({ next: { code: 'KeyN', alt: true } }).next).toEqual({ code: 'KeyN', alt: true });
  });

  it('never fires while typing an answer', () => {
    const text = document.createElement('input');
    const radio = document.createElement('input');
    radio.type = 'radio';
    const area = document.createElement('textarea');
    const div = document.createElement('div');
    expect(isTypingTarget(text)).toBe(true);
    expect(isTypingTarget(area)).toBe(true);
    expect(isTypingTarget(radio)).toBe(false);
    expect(isTypingTarget(div)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
