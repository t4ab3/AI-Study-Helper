import { useEffect, useState } from 'react';
import { bridge } from './bridge';
import { errorMessage, log } from '../shared/logger';

/**
 * First sign-up / sign-in to DeepSeek in an ordinary Chrome window (no automation) on the
 * program's own profile. The person goes through DeepSeek's checks by hand there; once that
 * window is closed, the program's DeepSeek window starts already signed in.
 */
export function DeepSeekLoginCard(props: { bridgeOnline: boolean | null; signupOpen: boolean; flash: (msg: string) => void }) {
  const [opening, setOpening] = useState(false);
  const [open, setOpen] = useState(false);
  // the bridge status (polled by the panel) is the truth once it has caught up
  useEffect(() => setOpen(props.signupOpen), [props.signupOpen]);

  const start = () => {
    setOpening(true);
    bridge
      .signup()
      .then((r) => {
        setOpen(true);
        log('info', 'deepseek', r.action === 'already_open' ? 'окно входа уже открыто' : 'открыто окно входа / регистрации');
        props.flash(r.action === 'already_open' ? 'Окно DeepSeek для входа уже открыто' : 'Открыл DeepSeek в обычном окне Chrome');
      })
      .catch((e) => props.flash(errorMessage(e)))
      .finally(() => setOpening(false));
  };

  return (
    <section className="card signup" data-testid="signup-card">
      <div className="row">
        <strong className="signup-title">Вход в DeepSeek</strong>
        <button
          className={`btn small${open ? '' : ' primary'}`}
          disabled={!props.bridgeOnline || opening || open}
          onClick={start}
          data-testid="btn-signup"
        >
          {opening ? 'Открываю…' : open ? 'Окно открыто' : 'Открыть для входа или регистрации'}
        </button>
      </div>
      {open ? (
        <p className="hint" data-testid="signup-open">
          Окно DeepSeek открыто как обычный Chrome. Зарегистрируйтесь или войдите, пройдите проверку, если она появится, и{' '}
          <b>закройте это окно</b>. Вход сохранится, и программа будет открывать DeepSeek уже с ним. Пока окно открыто, решение
          тестов ждёт.
        </p>
      ) : (
        <p className="hint">
          Первый раз или если DeepSeek не пускает в окне программы (например, не проходит проверка при регистрации): откройте его
          здесь как обычный браузер.
          {props.bridgeOnline === false && ' Сначала запустите bridge.'}
        </p>
      )}
    </section>
  );
}
