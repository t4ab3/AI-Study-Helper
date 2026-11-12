import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContentEvent } from '../shared/messages';
import type { LearnedNext, QuestionRule } from '../shared/types';
import { clearLogs, errorMessage, log, readLogs, type LogEntry } from '../shared/logger';
import { Banner } from './components';
import { loadSession, patchSession, saveSession, type Session } from './session';
import { HotkeysCard, useHotkeys } from './HotkeysCard';
import { isTypingTarget, matchesHotkey } from '../shared/hotkeys';
import { isPageGone, isPinnedToTab, isRestrictedUrl, resolveTargetTab, sendToContent } from './tabs';
import { bridge, loadBridgePort, type BridgeStatus } from './bridge';
import { AutoCard } from './AutoCard';
import { AutoRunner, type AutoDeps, type AutoState } from './autoRunner';
import { LectureCard } from './LectureCard';

type BridgeState = { kind: 'unknown' } | { kind: 'off' } | { kind: 'on'; status: BridgeStatus };
type View = 'tests' | 'notes';
const VIEW_KEY = 'panelView';

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function App() {
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) as View) || 'tests');
  const [bridgeState, setBridgeState] = useState<BridgeState>({ kind: 'unknown' });
  const [toast, setToast] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  }, []);

  const choose = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode */
    }
  };

  useEffect(() => {
    loadBridgePort().catch(() => undefined);
  }, []);

  // bridge status, polled lightly
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const status = await bridge.status();
        if (!stop) setBridgeState({ kind: 'on', status });
      } catch {
        if (!stop) setBridgeState({ kind: 'off' });
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!logsOpen) return;
    readLogs().then(setLogs);
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.logs) setLogs((changes.logs.newValue as LogEntry[]) ?? []);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [logsOpen]);

  const bridgeOnline = bridgeState.kind === 'unknown' ? null : bridgeState.kind === 'on';

  return (
    <>
      <header className="header">
        <div className="logo">AI</div>
        <div className="grow">
          <h1>AI Helper</h1>
          <div className="sub" data-testid="bridge-line">
            <span className={`dot ${bridgeState.kind === 'on' ? 'on' : bridgeState.kind === 'off' ? 'off' : ''}`} />
            {bridgeState.kind === 'on'
              ? `Bridge подключён · DeepSeek ${bridgeState.status.running ? 'открыт' : 'закрыт'}`
              : bridgeState.kind === 'off'
                ? 'Bridge не запущен (bridge\\start_bridge.bat)'
                : 'Проверяю bridge…'}
          </div>
        </div>
      </header>

      <nav className="tabs">
        <button className={view === 'tests' ? 'on' : ''} onClick={() => choose('tests')} data-testid="tab-tests">
          Тесты
        </button>
        <button className={view === 'notes' ? 'on' : ''} onClick={() => choose('notes')} data-testid="tab-notes">
          Конспект
        </button>
      </nav>

      {/* both stay mounted: a test run or a recording keeps going while the other tab is open */}
      <div hidden={view !== 'tests'}>
        <TestsView bridgeOnline={bridgeOnline} flash={flash} />
        <HotkeysCard />
      </div>
      <div hidden={view !== 'notes'}>
        <LectureCard bridgeOnline={bridgeOnline} flash={flash} />
      </div>

      <details className="logs" open={logsOpen} onToggle={(e) => setLogsOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Журнал</summary>
        <div className="row" style={{ marginTop: 6 }}>
          <button
            className="btn small"
            onClick={() =>
              copyText(logs.map((l) => `${new Date(l.t).toISOString()} ${l.level} [${l.scope}] ${l.message} ${l.data ?? ''}`).join('\n')).then(() =>
                flash('Журнал скопирован'),
              )
            }
          >
            Копировать
          </button>
          <button className="btn small ghost" onClick={() => clearLogs().then(() => setLogs([]))}>
            Очистить
          </button>
        </div>
        <div className="log">
          {logs.length === 0 && <div>Пусто</div>}
          {[...logs].reverse().map((l, i) => (
            <div key={i} className={l.level}>
              {new Date(l.t).toLocaleTimeString()} [{l.scope}] {l.message} {l.data ?? ''}
            </div>
          ))}
        </div>
      </details>

      {toast && (
        <div className="toast" data-testid="toast">
          {toast}
        </div>
      )}
    </>
  );
}

/** Automatic test solving on the tab shown in this window. */
function TestsView(props: { bridgeOnline: boolean | null; flash: (msg: string) => void }) {
  const { flash } = props;
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [s, setS] = useState<Session | null>(null);
  const sRef = useRef<Session | null>(null);
  const tabRef = useRef<chrome.tabs.Tab | null>(null);
  /** "Next" button remembered for the current site. */
  const [learnedNext, setLearnedNext] = useState<LearnedNext | null>(null);
  /** "This is the question text" rule for the current site. */
  const [questionRule, setQuestionRule] = useState<QuestionRule | null>(null);
  // One automatic run at a time; it keeps working on its own tab even if another tab is shown.
  const runnerRef = useRef<{ tabId: number; runner: AutoRunner } | null>(null);

  // K / M pressed while the panel has the keyboard focus (after a click on «Начать», for example):
  // hovering the page's button does not move the focus there, so the panel passes the key on
  const [hotkeys] = useHotkeys();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hotkeys.enabled || e.repeat || e.isComposing || e.defaultPrevented) return;
      if (isTypingTarget(e.target instanceof Element ? e.target : null)) return;
      const action = matchesHotkey(e, hotkeys.question) ? 'question' : matchesHotkey(e, hotkeys.next) ? 'next' : null;
      const tabId = tabRef.current?.id;
      if (!action || tabId === undefined) return;
      e.preventDefault();
      log('info', 'hotkey', `${action} из панели`);
      // success and failure both come back as page events and show up as a toast
      sendToContent(tabId, { kind: 'HOTKEY', action }).catch((err) => props.flash(errorMessage(err)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys, props.flash]);

  const refreshLearned = useCallback((tabId: number) => {
    sendToContent(tabId, { kind: 'NEXT_GET' })
      .then((r) => setLearnedNext(r.learned))
      .catch(() => setLearnedNext(null));
    sendToContent(tabId, { kind: 'QUESTION_RULE_GET' })
      .then((r) => setQuestionRule(r.rule))
      .catch(() => setQuestionRule(null));
  }, []);

  const update = useCallback((patch: Partial<Session>) => {
    setS((prev) => {
      if (!prev) return prev;
      const next: Session = { ...prev, ...patch, updatedAt: Date.now() };
      sRef.current = next;
      saveSession(next).catch((e) => log('error', 'session', 'save failed', e));
      return next;
    });
  }, []);

  const loadTab = useCallback(async () => {
    const t = await resolveTargetTab();
    tabRef.current = t;
    setTab(t);
    if (!t?.id) {
      setS(null);
      sRef.current = null;
      return;
    }
    const sess = await loadSession(t.id, t.url ?? '');
    const live = runnerRef.current;
    if (live && live.tabId === t.id && live.runner.busy) sess.auto = live.runner.state;
    sRef.current = sess;
    setS(sess);
    if (!isRestrictedUrl(t.url) && t.status === 'complete') refreshLearned(t.id);
  }, [refreshLearned]);

  useEffect(() => {
    let myWindowId: number | undefined;
    chrome.windows.getCurrent().then((w) => (myWindowId = w.id));
    loadTab().catch((e) => log('error', 'tabs', 'load failed', e));

    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
      if (isPinnedToTab() || (myWindowId !== undefined && info.windowId !== myWindowId)) return;
      loadTab().catch(() => undefined);
    };
    const onUpdated = (tabId: number, change: chrome.tabs.TabChangeInfo, t: chrome.tabs.Tab) => {
      if (tabId !== tabRef.current?.id) return;
      if (change.status === 'complete') {
        tabRef.current = t;
        setTab(t);
        setTimeout(() => t.id && refreshLearned(t.id), 400);
      } else if (change.url) setTab(t);
    };
    const onMessage = (msg: ContentEvent, sender: chrome.runtime.MessageSender) => {
      if (sender.tab?.id !== tabRef.current?.id) return;
      if (msg.kind === 'NEXT_LEARNED') {
        setLearnedNext(msg.learned);
        flash(`Запомнил кнопку «${msg.learned.text || 'Далее'}»`);
      } else if (msg.kind === 'QUESTION_RULE_SAVED') {
        setQuestionRule(msg.rule);
        flash(`Запомнил, где текст вопроса (найдено на странице: ${msg.matches})`);
        log('info', 'question', `rule ${msg.rule.selector} for «${msg.rule.sample}»`);
      } else if (msg.kind === 'QUESTION_RULE_FAILED' || msg.kind === 'NEXT_TEACH_FAILED') {
        flash(msg.message);
      } else if (msg.kind === 'NEXT_LEARN_REJECTED') {
        flash(`«${msg.text}» завершает тест: эту кнопку я не запоминаю`);
      }
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [loadTab, refreshLearned, flash]);

  if (!tab) return <Banner kind="info">Откройте вкладку с тестом.</Banner>;
  if (isRestrictedUrl(tab.url))
    return <Banner kind="warn">На служебных страницах Chrome расширения не работают. Откройте страницу с тестом.</Banner>;
  if (!s) return null;

  const tabId = tab.id!;

  const makeRunner = (initial: AutoState): AutoRunner => {
    const runTab = tabId;
    let learnKey: string | null = null;
    let learnArmedAt = 0;
    const deps: AutoDeps = {
      scan: () => sendToContent(runTab, { kind: 'RECOGNIZE' }),
      checkDeepSeek: () => bridge.check(),
      ask: (prompt, newChat) => bridge.ask(prompt, newChat).then((r) => r.text),
      cancelAsk: () => bridge.cancel().then(() => undefined),
      fill: (plan) => sendToContent(runTab, { kind: 'FILL', plan }).then((r) => r.report),
      findNext: () => sendToContent(runTab, { kind: 'FIND_NEXT' }).then((r) => r.candidates),
      clickNext: (selector) =>
        sendToContent(runTab, { kind: 'CLICK_NEXT', selector }).catch((e: unknown) => {
          // the page started loading the next question before it could answer: the click worked.
          // Not pressed again (that could skip a question); waiting for the new question checks it.
          if (!isPageGone(e)) throw e;
          log('warn', 'auto', `«Далее»: страница перезагрузилась, не ответив (${(e as Error).message})`);
          return { ok: true, message: '' };
        }),
      findFinish: () => sendToContent(runTab, { kind: 'FIND_FINISH' }).then((r) => r.candidates),
      async armLearnNext() {
        learnArmedAt = Date.now();
        const r = await sendToContent(runTab, { kind: 'NEXT_LEARN_START' });
        learnKey = r.key;
      },
      async learnedNext() {
        if (!learnKey) return null;
        const v = (await chrome.storage.local.get(learnKey))[learnKey] as LearnedNext | undefined;
        return v && v.savedAt >= learnArmedAt - 1000 ? v : null;
      },
      cancelLearnNext: () =>
        sendToContent(runTab, { kind: 'NEXT_LEARN_CANCEL' })
          .then(() => undefined)
          .catch(() => undefined),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    };
    let lastLogged = 0;
    let lastStep: string | null = null;
    const emit = (st: AutoState) => {
      // everything goes to the log, so a stop can be traced afterwards
      for (const a of st.actions.slice(-3)) {
        if (a.t > lastLogged) {
          log(a.level, 'auto', a.text);
          lastLogged = a.t;
        }
      }
      const stepKey = `${st.phase}/${st.step ?? '-'}`;
      if (stepKey !== lastStep) {
        lastStep = stepKey;
        log('info', 'auto', `шаг: ${stepKey}`);
      }
      if (sRef.current?.tabId === runTab) update({ auto: st });
      else patchSession(runTab, { auto: st }).catch(() => undefined);
    };
    return new AutoRunner(deps, initial, emit);
  };

  const runnerForThisTab = (): AutoRunner | null => {
    const live = runnerRef.current;
    if (live?.runner.busy && live.tabId !== tabId) {
      flash('Автоматическое решение уже идёт в другой вкладке');
      return null;
    }
    if (live && live.tabId === tabId) return live.runner;
    const runner = makeRunner(s.auto);
    runnerRef.current = { tabId, runner };
    return runner;
  };

  const autoFinish = (selector: string) =>
    sendToContent(tabId, { kind: 'CLICK_FINISH', selector })
      .then((r) => {
        flash(r.message);
        log(r.ok ? 'info' : 'warn', 'auto', `finish: ${r.message}`);
      })
      .catch((e) => flash(errorMessage(e)));

  return (
    <AutoCard
      state={s.auto}
      bridgeOnline={props.bridgeOnline}
      onStart={() => runnerForThisTab()?.start().catch((e) => log('error', 'auto', errorMessage(e)))}
      onPause={() => runnerForThisTab()?.pause()}
      onResume={() => runnerForThisTab()?.resume().catch((e) => log('error', 'auto', errorMessage(e)))}
      onStop={() => runnerForThisTab()?.stop()}
      onFinish={autoFinish}
      learnedNext={learnedNext}
      questionRule={questionRule}
      onForgetQuestionRule={() =>
        sendToContent(tabId, { kind: 'QUESTION_RULE_FORGET' })
          .then(() => {
            setQuestionRule(null);
            flash('Правило для текста вопроса забыто');
          })
          .catch((e) => log('warn', 'question', errorMessage(e)))
      }
      onForgetNext={() =>
        sendToContent(tabId, { kind: 'NEXT_FORGET' })
          .then(() => {
            setLearnedNext(null);
            flash('Кнопка «Далее» забыта');
          })
          .catch((e) => log('warn', 'next', errorMessage(e)))
      }
    />
  );
}
