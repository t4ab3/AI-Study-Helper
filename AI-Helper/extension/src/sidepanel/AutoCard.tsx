import { useState } from 'react';
import type { LearnedNext, QuestionRule } from '../shared/types';
import type { AutoState } from './autoRunner';
import { STEP_TEXT } from './autoRunner';

const PHASE_TEXT: Record<AutoState['phase'], string> = {
  idle: 'Не запущено',
  running: 'Автоматическое решение',
  paused: 'Пауза',
  waiting_user: 'Ожидаю действия пользователя',
  finished: 'Тест заполнен',
  error: 'Ошибка',
  stopped: 'Остановлено',
};

const DS_TEXT: Record<AutoState['deepseek'], string> = {
  unknown: 'не проверен',
  ready: 'Подключён',
  login_required: 'Нужен вход',
  captcha: 'Проверка (CAPTCHA)',
  ui_changed: 'Интерфейс не распознан',
  offline: 'Bridge не запущен',
};

export function AutoCard(props: {
  state: AutoState;
  bridgeOnline: boolean | null;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onFinish: (selector: string) => void;
  learnedNext: LearnedNext | null;
  onForgetNext: () => void;
  questionRule: QuestionRule | null;
  onForgetQuestionRule: () => void;
}) {
  const s = props.state;
  const [confirmFinish, setConfirmFinish] = useState<string | null>(null);
  const active = s.phase === 'running' || s.phase === 'waiting_user';
  const canStart = !active && s.phase !== 'paused';
  const canResume = s.phase === 'paused' || s.phase === 'error' || (s.phase === 'waiting_user' && !!s.displayOnly);
  const canStop = active || s.phase === 'paused' || s.phase === 'error';
  const ds = s.deepseek === 'unknown' && props.bridgeOnline === false ? 'offline' : s.deepseek;
  const dsClass = ds === 'ready' ? 'ok' : ds === 'unknown' ? '' : 'bad';
  const lastAction = s.actions[s.actions.length - 1];
  const current = s.current ? (s.current[0] === s.current[1] ? `${s.current[0]}` : `${s.current[0]}–${s.current[1]}`) : '—';

  return (
    <section className="card auto" data-testid="auto-card">
      <div className="card-head">
        <span className="step auto-icon">⚡</span>
        <h2>Автоматическое решение</h2>
        <span className={`phase p-${s.phase}`} data-testid="auto-phase">
          {PHASE_TEXT[s.phase]}
        </span>
      </div>

      <dl className="auto-grid">
        <dt>Действие</dt>
        <dd data-testid="auto-step">
          {s.phase === 'running' && s.step ? (
            <>
              <span className="spinner" />
              {STEP_TEXT[s.step]}
            </>
          ) : (
            lastAction?.text ?? '—'
          )}
        </dd>
        <dt>DeepSeek</dt>
        <dd>
          <span className={`ds ${dsClass}`} data-testid="auto-deepseek">
            {DS_TEXT[ds]}
          </span>
        </dd>
        <dt>Текущий вопрос</dt>
        <dd data-testid="auto-current">{current}</dd>
        <dt>Обработано</dt>
        <dd data-testid="auto-processed">{s.processed}</dd>
        <dt>Текст вопроса</dt>
        <dd data-testid="auto-qrule">
          {props.questionRule ? (
            <>
              как «{props.questionRule.sample.length > 40 ? `${props.questionRule.sample.slice(0, 38)}…` : props.questionRule.sample}»{' '}
              <button className="btn small ghost" onClick={props.onForgetQuestionRule} data-testid="btn-forget-qrule">
                Забыть
              </button>
            </>
          ) : (
            <span className="hint-inline">ищу сам; если не находит, выделите текст вопроса → правая кнопка → «AI Helper: это текст вопроса»</span>
          )}
        </dd>
        <dt>«Далее»</dt>
        <dd data-testid="auto-next">
          {props.learnedNext ? (
            <>
              запомнена «{props.learnedNext.text || 'кнопка без текста'}»{' '}
              <button className="btn small ghost" onClick={props.onForgetNext} data-testid="btn-forget-next">
                Забыть
              </button>
            </>
          ) : (
            <span className="hint-inline">ищу сам; или правая кнопка на ней → «AI Helper: это кнопка «Далее»»</span>
          )}
        </dd>
      </dl>

      {s.message && (
        <div className={`banner ${s.phase === 'error' ? 'err' : s.phase === 'finished' ? 'ok' : 'warn'}`} data-testid="auto-message">
          {s.message}
        </div>
      )}

      {s.displayOnly && (
        <ul className="auto-answers">
          {s.displayOnly.answers.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}

      <div className="row">
        {canStart && (
          <button className="btn primary" onClick={props.onStart} data-testid="btn-auto-start">
            {s.phase === 'idle' ? 'Начать автоматическое решение' : 'Начать заново'}
          </button>
        )}
        {active && !s.displayOnly && (
          <button className="btn" onClick={props.onPause} data-testid="btn-auto-pause">
            Приостановить
          </button>
        )}
        {canResume && (
          <button className="btn primary" onClick={props.onResume} data-testid="btn-auto-resume">
            Продолжить
          </button>
        )}
        {canStop && (
          <button className="btn danger" onClick={props.onStop} data-testid="btn-auto-stop">
            Остановить
          </button>
        )}
      </div>

      {s.phase === 'finished' && (
        <div className="auto-summary" data-testid="auto-summary">
          <div>
            Обработано вопросов: <b>{s.processed}</b>
            {s.startedAt && s.finishedAt ? ` за ${Math.round((s.finishedAt - s.startedAt) / 1000)} с` : ''}
          </div>
          {s.failed.length > 0 && (
            <div className="bad-list">
              Не удалось обработать:
              <ul>
                {s.failed.map((f, i) => (
                  <li key={i}>
                    {f.text}: {f.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {s.lowConfidence.length > 0 && (
            <div className="hint">Низкая уверенность DeepSeek: {s.lowConfidence.join(', ')}. Проверьте эти ответы.</div>
          )}
          {s.finishCandidates.length > 0 && (
            <div className="finish-box">
              {confirmFinish ? (
                <>
                  <p className="hint" style={{ marginTop: 0 }}>
                    Отправить тест кнопкой «{s.finishCandidates.find((c) => c.selector === confirmFinish)?.text}»? Это действие
                    нельзя отменить.
                  </p>
                  <div className="row">
                    <button className="btn danger" onClick={() => { props.onFinish(confirmFinish); setConfirmFinish(null); }} data-testid="btn-finish-confirm">
                      Да, завершить тест
                    </button>
                    <button className="btn" onClick={() => setConfirmFinish(null)}>
                      Отмена
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="hint" style={{ marginTop: 0 }}>Тест не отправлен. Проверьте ответы на странице.</p>
                  {s.finishCandidates.map((c) => (
                    <button key={c.selector} className="btn small" onClick={() => setConfirmFinish(c.selector)} data-testid="btn-finish">
                      {c.text}…
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {s.actions.length > 0 && (
        <div className="auto-log" data-testid="auto-log">
          {[...s.actions].slice(-8).reverse().map((a, i) => (
            <div key={i} className={a.level}>
              <span className="time">{new Date(a.t).toLocaleTimeString()}</span> {a.text}
            </div>
          ))}
        </div>
      )}
      <p className="hint">Не закрывайте эту панель во время решения. Финальная отправка теста — только по вашему подтверждению.</p>
    </section>
  );
}
