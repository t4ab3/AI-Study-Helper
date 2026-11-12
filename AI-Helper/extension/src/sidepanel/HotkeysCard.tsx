import { useEffect, useState } from 'react';
import {
  DEFAULT_HOTKEYS,
  HOTKEYS_KEY,
  hotkeyFromEvent,
  hotkeyLabel,
  normalizeHotkeys,
  sameHotkey,
  type Hotkey,
  type Hotkeys,
} from '../shared/hotkeys';

/** Current shortcuts, kept in sync with chrome.storage (the page reads the same value). */
export function useHotkeys(): [Hotkeys, (h: Hotkeys) => void] {
  const [hk, setHk] = useState<Hotkeys>(DEFAULT_HOTKEYS);
  useEffect(() => {
    chrome.storage.local
      .get(HOTKEYS_KEY)
      .then((v) => setHk(normalizeHotkeys(v[HOTKEYS_KEY])))
      .catch(() => undefined);
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[HOTKEYS_KEY]) setHk(normalizeHotkeys(changes[HOTKEYS_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  const save = (h: Hotkeys) => {
    setHk(h);
    chrome.storage.local.set({ [HOTKEYS_KEY]: h }).catch(() => undefined);
  };
  return [hk, save];
}

type Which = 'question' | 'next';

function KeyField(props: { which: Which; value: Hotkey; other: Hotkey; onChange: (h: Hotkey) => void }) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="key-field">
      <button
        className={`btn small key-btn${recording ? ' recording' : ''}`}
        onClick={() => {
          setError(null);
          setRecording(true);
        }}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.code === 'Escape') {
            setRecording(false);
            return;
          }
          const hk = hotkeyFromEvent(e.nativeEvent);
          if (!hk) return; // a modifier on its own: wait for the key itself
          if (sameHotkey(hk, props.other)) {
            setError(`${hotkeyLabel(hk)} уже занята другим действием.`);
            return;
          }
          setRecording(false);
          setError(null);
          props.onChange(hk);
        }}
        title="Нажмите и затем нажмите нужную клавишу (Esc — отмена)"
        data-testid={`hotkey-${props.which}`}
      >
        {recording ? 'нажмите клавишу…' : hotkeyLabel(props.value)}
      </button>
      {error && <span className="key-error">{error}</span>}
    </span>
  );
}

export function HotkeysCard() {
  const [hk, save] = useHotkeys();
  const isDefault = sameHotkey(hk.question, DEFAULT_HOTKEYS.question) && sameHotkey(hk.next, DEFAULT_HOTKEYS.next);
  return (
    <details className="card hotkeys" data-testid="hotkeys-card">
      <summary>
        Горячие клавиши: {hk.enabled ? `${hotkeyLabel(hk.question)} — вопрос, ${hotkeyLabel(hk.next)} — «Далее»` : 'выключены'}
      </summary>
      <p className="hint" style={{ marginTop: 6 }}>
        Для сайтов, где не работает правая кнопка мыши. Выделите текст вопроса и нажмите клавишу вопроса. Наведите курсор на кнопку
        «Далее» и нажмите её клавишу. Пока вы печатаете в поле ответа, клавиши не срабатывают.
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={hk.enabled}
          onChange={(e) => save({ ...hk, enabled: e.target.checked })}
          data-testid="hotkeys-enabled"
        />
        Включены
      </label>
      <div className="key-rows">
        <span>Это текст вопроса</span>
        <KeyField which="question" value={hk.question} other={hk.next} onChange={(question) => save({ ...hk, question })} />
        <span>Это кнопка «Далее»</span>
        <KeyField which="next" value={hk.next} other={hk.question} onChange={(next) => save({ ...hk, next })} />
      </div>
      {!isDefault && (
        <button className="btn small ghost" onClick={() => save({ ...DEFAULT_HOTKEYS, enabled: hk.enabled })} data-testid="hotkeys-reset">
          Вернуть K и M
        </button>
      )}
    </details>
  );
}
