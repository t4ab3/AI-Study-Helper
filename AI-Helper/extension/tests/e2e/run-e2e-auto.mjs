// End-to-end test: real extension in Chromium + real Python bridge + real Selenium Chrome.
// Covers automatic test solving and lecture notes (tab audio → Whisper → DeepSeek → .docx). The only stand-in is the chat itself: the bridge is pointed at
// test-pages/fake-deepseek.html (same input/send/stream behaviour as the DeepSeek UI), because
// a test cannot log in to a real DeepSeek account.
//
// Starts its own bridge on port 8766 (headless), so it does not touch a bridge you run on 8765.
// Needs: npm run build, bridge/.venv (bridge\start_bridge.bat once), Playwright's Chromium.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const project = resolve(root, '..');
const dist = join(root, 'dist');
const PORT = 8766;
const BASE = `http://127.0.0.1:${PORT}/test-pages`;

function findChromium() {
  if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM;
  const dir = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (!existsSync(dir)) return undefined;
  const builds = readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const b of builds) {
    const exe = join(dir, b, 'chrome-win64', 'chrome.exe');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

let failures = 0;
function check(cond, name, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

async function startBridge(tmp) {
  const python = join(project, 'bridge', '.venv', 'Scripts', 'python.exe');
  if (!existsSync(python)) throw new Error('bridge/.venv not found: run bridge\\start_bridge.bat once');
  const proc = spawn(python, ['-m', 'deepseek_bridge', '--port', String(PORT)], {
    cwd: join(project, 'bridge'),
    env: {
      ...process.env,
      AITS_DEEPSEEK_URL: `${BASE}/fake-deepseek.html`,
      AITS_HEADLESS: '1',
      AITS_PROFILE_DIR: join(tmp, 'ds-profile'),
      AITS_LOG_DIR: join(tmp, 'logs'),
      AIH_NOTES_DIR: join(tmp, 'notes'),
      AIH_NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { 'X-AITS-Client': 'ai-test-solver' } }).catch(() => null);
    if (ok?.ok) return proc;
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error(`bridge did not start on ${PORT}:\n${out}`);
}

async function main() {
  if (!existsSync(join(dist, 'manifest.json'))) throw new Error('dist/ not found: run npm run build');
  const tmp = mkdtempSync(join(tmpdir(), 'aits-auto-'));
  const bridgeProc = await startBridge(tmp);
  const ctx = await chromium.launchPersistentContext(join(tmp, 'user'), {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1200, height: 900 },
    // --mute-audio would make the recorded tab silent
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      // Chrome's "share" picker answers itself with the tab of test-pages/lecture.html
      '--auto-select-tab-capture-source-by-title=Lecture sample',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    await sw.evaluate((port) => chrome.storage.local.set({ bridgePort: port }), PORT);

    async function openPanel(url) {
      const test = await ctx.newPage();
      test.on('dialog', (d) => d.accept());
      await test.goto(url);
      const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
      const pagePromise = ctx.waitForEvent('page');
      await sw.evaluate(
        (u) => chrome.windows.create({ url: u, type: 'popup', width: 420, height: 900 }),
        `chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`,
      );
      const panel = await pagePromise;
      await panel.waitForSelector('[data-testid=btn-auto-start]');
      return { test, panel };
    }

    const phase = (panel) => panel.textContent('[data-testid=auto-phase]');
    const waitPhase = (panel, text, timeout = 120000) =>
      panel.waitForFunction(
        ([t]) => {
          const p = document.querySelector('[data-testid=auto-phase]')?.textContent;
          return p === t || p === 'Ошибка';
        },
        [text],
        { timeout },
      );
    const autoMessage = (panel) => panel.textContent('[data-testid=auto-message]').catch(() => '');

    // ---------------- one question at a time ----------------
    console.log('\nSequential test: 7 questions shown one by one, "Далее" disabled until answered');
    {
      const { test, panel } = await openPanel(`${BASE}/sequential.html`);
      const t0 = Date.now();
      await panel.click('[data-testid=btn-auto-start]');

      // pause in the middle, then resume
      await panel.waitForFunction(() => Number(document.querySelector('[data-testid=auto-processed]')?.textContent) >= 2, null, { timeout: 90000 });
      await panel.click('[data-testid=btn-auto-pause]');
      await waitPhase(panel, 'Пауза');
      check((await phase(panel)) === 'Пауза', 'pause works mid-run');
      const pausedAt = Number(await panel.textContent('[data-testid=auto-processed]'));
      await panel.waitForTimeout(1500);
      check(Number(await panel.textContent('[data-testid=auto-processed]')) === pausedAt, 'nothing happens while paused');
      await panel.click('[data-testid=btn-auto-resume]');

      await waitPhase(panel, 'Тест заполнен', 180000);
      check((await phase(panel)) === 'Тест заполнен', 'run finished', await autoMessage(panel));
      check((await panel.textContent('[data-testid=auto-processed]')) === '7', '7 questions processed', await panel.textContent('[data-testid=auto-processed]'));
      const state = await test.evaluate(() => ({
        s1: document.querySelector('input[name=s1]:checked')?.value,
        s2: [0, 1, 2, 3].map((i) => document.querySelector(`input[name=s2_choice${i}]`).checked),
        s3: document.querySelector('input[name=s3]:checked')?.value,
        s4: document.querySelector('select[name=s4]').value,
        s5: document.querySelector('#s5').value,
        s6: [0, 1, 2].map((i) => document.querySelector(`select[name=s6_sub${i}]`).value),
        s7: document.querySelector('input[name=s7]:checked')?.value,
        onLast: document.querySelector('.card[data-q="7"]').classList.contains('active'),
        submitted: window.__submitted,
      }));
      check(
        state.s1 === 'b' && JSON.stringify(state.s2) === '[true,false,true,false]' && state.s3 === 't' && state.s4 === '443' &&
          state.s5 === 'Нил' && JSON.stringify(state.s6) === '["1","2","3"]' && state.s7 === '8',
        'every answer is filled on the page',
        JSON.stringify(state),
      );
      check(state.onLast, 'reached the last question');
      check(state.submitted === false, '"Завершить тест" NOT pressed automatically');
      check(await panel.isVisible('[data-testid=btn-finish]'), 'finish button offered for manual confirmation');
      if (process.env.E2E_SCREENSHOTS) await panel.screenshot({ path: join(process.env.E2E_SCREENSHOTS, 'auto-panel.png') });
      const logText = await panel.textContent('[data-testid=auto-log]');
      check(/Готово: обработано 7/.test(logText), 'summary in the action log');
      console.log(`  (took ${Math.round((Date.now() - t0) / 1000)} s)`);
      await panel.close();
      await test.close();
    }

    // ---------------- reveal on the same page ----------------
    console.log('\nReveal test: next question appears after answering, no "Next" button');
    {
      const { test, panel } = await openPanel(`${BASE}/reveal.html`);
      await panel.click('[data-testid=btn-auto-start]');
      await waitPhase(panel, 'Тест заполнен');
      check((await phase(panel)) === 'Тест заполнен', 'run finished', await autoMessage(panel));
      check((await panel.textContent('[data-testid=auto-processed]')) === '3', '3 questions processed');
      const st = await test.evaluate(() => ({
        r1: document.querySelector('input[name=r1]:checked')?.value,
        r2: [0, 1, 2].map((i) => document.querySelector(`input[name=r2_choice${i}]`).checked),
        r3: document.querySelector('input[name=r3]:checked')?.value,
      }));
      check(st.r1 === 'css' && JSON.stringify(st.r2) === '[true,false,true]' && st.r3 === 't', 'answers filled', JSON.stringify(st));

      // the user explicitly confirms finishing
      await panel.click('[data-testid=btn-finish]');
      check(await test.evaluate(() => window.__submitted === false), 'first click only asks for confirmation');
      await panel.click('[data-testid=btn-finish-confirm]');
      await test.waitForFunction(() => window.__submitted === true, null, { timeout: 5000 }).catch(() => undefined);
      check(await test.evaluate(() => window.__submitted === true), 'finish pressed after confirmation');
      await panel.close();
      await test.close();
    }

    // ---------------- unknown "Next" button, learned from the user's click ----------------
    console.log('\nLearn-next test: question text apart from options, "Перейти" is a div; the user clicks it once');
    {
      const { test, panel } = await openPanel(`${BASE}/learn-next.html`);
      await panel.click('[data-testid=btn-auto-start]');
      await panel.waitForFunction(
        () => /Нажмите её на странице/.test(document.querySelector('[data-testid=auto-message]')?.textContent ?? ''),
        null,
        { timeout: 90000 },
      );
      check((await phase(panel)) === 'Ожидаю действия пользователя', 'asks the user to press "Next" once');
      check((await panel.textContent('[data-testid=auto-processed]')) === '1', 'question 1 answered before asking');
      check(await test.evaluate(() => window.__goClicks === 0), 'did not click anything by itself');
      // the user clicks the div button on the page
      await test.click('#go-wrap span');
      await waitPhase(panel, 'Тест заполнен', 120000);
      check((await phase(panel)) === 'Тест заполнен', 'run finished', await autoMessage(panel));
      check((await panel.textContent('[data-testid=auto-processed]')) === '3', '3 questions processed');
      const st = await test.evaluate(() => ({
        l1: document.querySelector('input[name=l1]:checked')?.value,
        l2: document.querySelector('#l2').value,
        l3: [0, 1, 2, 3].map((i) => document.querySelector(`input[name=l3_${i}]`).checked),
        flag: document.querySelector('input[name=flag]').checked,
        clicks: window.__goClicks,
        submitted: window.__submitted,
      }));
      // "Рим" is only right if the question text "Столица Италии?" reached DeepSeek
      check(st.l1 === 'b' && st.l2 === 'Рим' && JSON.stringify(st.l3) === '[true,false,true,false]', 'answers filled, question text was read', JSON.stringify(st));
      check(st.flag === false, '"Отметить вопрос" left alone');
      check(st.clicks === 2, 'one click by the user, one by the extension', String(st.clicks));
      check(st.submitted === false, '"Завершить тест" NOT pressed');
      check(/Перейти/.test(await panel.textContent('[data-testid=auto-next]')), 'panel shows the remembered button');

      // second run on the same site: no waiting, the remembered button is pressed right away
      await test.reload();
      await test.waitForFunction(() => document.querySelector('#qtext')?.textContent === 'Столица Франции?');
      await panel.waitForTimeout(800);
      await panel.click('[data-testid=btn-auto-start]');
      await waitPhase(panel, 'Тест заполнен', 120000);
      const log2 = await panel.textContent('[data-testid=auto-log]');
      check((await panel.textContent('[data-testid=auto-processed]')) === '3', 'second run: 3 processed', await autoMessage(panel));
      check(!/Жду, пока вы нажмёте/.test(log2), 'second run did not wait for the user');
      check(await test.evaluate(() => window.__goClicks === 2), 'second run: both clicks by the extension');
      await panel.close();
      await test.close();
    }

    // ---------------- question text taught with the context menu ----------------
    console.log('\nTeach-question test: the user marks the question text once ("это текст вопроса")');
    {
      const { test, panel } = await openPanel(`${BASE}/teach-question.html`);
      // the user selects the question text on the page and picks the context-menu item;
      // the menu item sends exactly this message to the tab (background/index.ts)
      await test.evaluate(() => {
        const r = document.createRange();
        r.selectNodeContents(document.getElementById('qtext'));
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
      });
      const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, test.url());
      const taught = await sw.evaluate((id) => chrome.tabs.sendMessage(id, { kind: 'TEACH_QUESTION' }), tabId);
      check(taught?.ok === true && taught.data?.ok === true, 'rule saved from the selection', JSON.stringify(taught));
      await panel.waitForFunction(() => /Столица Франции/.test(document.querySelector('[data-testid=auto-qrule]')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => undefined);
      check(/Столица Франции/.test(await panel.textContent('[data-testid=auto-qrule]')), 'panel shows the taught rule');
      // "это кнопка «Далее»": right-click the text-less arrow, then the menu item's message
      await test.click('#next svg', { button: 'right' });
      await test.keyboard.press('Escape');
      const nextTaught = await sw.evaluate((id) => chrome.tabs.sendMessage(id, { kind: 'TEACH_NEXT' }), tabId);
      check(nextTaught?.ok === true && nextTaught.data?.ok === true, 'next button saved from the right-click', JSON.stringify(nextTaught));
      await panel.waitForFunction(() => /запомнена/.test(document.querySelector('[data-testid=auto-next]')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => undefined);
      check(/запомнена/.test(await panel.textContent('[data-testid=auto-next]')), 'panel shows the taught next button');

      await panel.click('[data-testid=btn-auto-start]');
      await waitPhase(panel, 'Тест заполнен', 120000);
      check((await phase(panel)) === 'Тест заполнен', 'run finished', await autoMessage(panel));
      const st = await test.evaluate(() => ({
        t1: document.querySelector('input[name=t1]:checked')?.value,
        t2: document.querySelector('#t2').value,
        t3: [0, 1, 2, 3].map((i) => document.querySelector(`input[name=t3_${i}]`).checked),
        font: document.querySelector('input[name=font]:checked')?.value,
        goto: document.querySelector('input[name=goto]:checked')?.value ?? null,
      }));
      check((await panel.textContent('[data-testid=auto-processed]')) === '3', 'exactly 3 questions (site menus skipped)', await panel.textContent('[data-testid=auto-processed]'));
      check(st.font === 'n' && st.goto === null, 'font switcher and navigator untouched', JSON.stringify(st));
      // "Рим" only if "Столица Италии?" (not the hint "Введите ответ в поле ниже") reached DeepSeek
      check(st.t1 === 'b' && st.t2 === 'Рим' && JSON.stringify(st.t3) === '[true,false,true,false]', 'question text came from the rule', JSON.stringify(st));
      const log = await panel.textContent('[data-testid=auto-log]');
      check(/Какие из чисел простые/.test(log), 'log names the real question (not the hint)', log);
      await panel.close();
      await test.close();
    }

    // ---------------- page navigation (form submit) ----------------
    console.log('\nTwo-page test: 5 questions, "Следующая страница" (form submit), then 2 more');
    {
      const { test, panel } = await openPanel(`${BASE}/mixed.html`);
      await panel.click('[data-testid=btn-auto-start]');
      await waitPhase(panel, 'Тест заполнен');
      check((await phase(panel)) === 'Тест заполнен', 'run finished', await autoMessage(panel));
      check((await panel.textContent('[data-testid=auto-processed]')) === '7', '7 questions over 2 pages');
      check(/mixed-page2\.html/.test(test.url()), 'moved to page 2');
      const st = await test.evaluate(() => ({
        p6: document.querySelector('input[name=p6]:checked')?.value,
        p7: document.querySelector('input[name=p7]:checked')?.value,
      }));
      check(st.p6 === '8' && st.p7 === 'a', 'page 2 answered', JSON.stringify(st));
      await panel.close();
      await test.close();
    }

    // ---------------- lecture notes ----------------
    if (process.env.E2E_SKIP_LECTURE !== '1') {
      console.log('\nLecture notes: record a tab with a lecture, transcribe it live, notes from DeepSeek into .docx');
      const { test, panel } = await openPanel(`${BASE}/lecture.html`);
      await test.evaluate(() => document.getElementById('a').play().catch(() => undefined));
      await panel.click('[data-testid=tab-notes]');
      await panel.fill('[data-testid=lecture-title]', 'Фотосинтез');
      // the sample recording is Russian (Windows has no Ukrainian voice); the default is Ukrainian
      check((await panel.inputValue('[data-testid=lecture-language]')) === 'uk', 'lecture language defaults to Ukrainian');
      await panel.selectOption('[data-testid=lecture-language]', 'ru');
      await panel.click('[data-testid=btn-lecture-record]');
      const rec = await panel.waitForSelector('[data-testid=lecture-recording]', { timeout: 20000 }).catch(() => null);
      check(!!rec, 'recording started (tab picked in Chrome\'s share dialog)', (await panel.textContent('[data-testid=lecture-card]'))?.slice(0, 300));
      if (rec) {
        // the sample is 52 s long; the first run also loads the Whisper model
        await panel.waitForFunction(() => /^0:5[4-9]|^[1-9]:/.test(document.querySelector('[data-testid=lecture-recorded]')?.textContent ?? ''), null, { timeout: 120000 });
        await panel.click('[data-testid=btn-lecture-stop]');
        await panel.waitForFunction(() => /Текст готов|Ошибка/.test(document.querySelector('[data-testid=lecture-state]')?.textContent ?? ''), null, { timeout: 15 * 60000 });
        const text = (await panel.textContent('[data-testid=lecture-text]').catch(() => '')) ?? '';
        check(/фотосинтез/i.test(text) && /хлорофилл/i.test(text), 'speech recognized from the tab audio', text.slice(0, 200));
        await panel.click('[data-testid=btn-lecture-notes]');
        await panel.waitForFunction(() => /Конспект готов/.test(document.querySelector('[data-testid=lecture-state]')?.textContent ?? '') || /не сделан/.test(document.querySelector('[data-testid=lecture-message]')?.textContent ?? ''), null, { timeout: 180000 });
        check(/Конспект готов/.test(await panel.textContent('[data-testid=lecture-state]')), 'notes written', await panel.textContent('[data-testid=lecture-message]'));
        check(!!(await panel.$('[data-testid=btn-lecture-open]')), '"Открыть конспект" button');
        const folders = readdirSync(join(tmp, 'notes'));
        const docx = folders.flatMap((f) => readdirSync(join(tmp, 'notes', f)).filter((x) => x.endsWith('.docx')).map((x) => join(tmp, 'notes', f, x)));
        check(docx.length === 1 && /Фотосинтез/.test(docx[0]) && statSync(docx[0]).size > 5000, 'Word file saved', JSON.stringify(docx));
        const meta = JSON.parse(readFileSync(join(docx[0], '..', 'meta.json'), 'utf8'));
        check(meta.language === 'ru', 'lecture recorded with the language chosen in the list', meta.language);
      }

      // a ready audio file instead of recording
      await panel.setInputFiles('[data-testid=lecture-file-input]', join(project, 'test-pages', 'lecture-sample.wav'));
      await panel.waitForFunction(() => /Текст готов|Ошибка/.test(document.querySelector('[data-testid=lecture-state]')?.textContent ?? ''), null, { timeout: 10 * 60000 });
      const t2 = (await panel.textContent('[data-testid=lecture-text]').catch(() => '')) ?? '';
      check(/фотосинтез/i.test(t2), 'uploaded file recognized (the chosen language is remembered)', t2.slice(0, 120));
      await panel.close();
      await test.close();
    }
  } finally {
    await ctx.close();
    // close the Selenium window through the API so no headless Chrome is left behind
    await fetch(`http://127.0.0.1:${PORT}/close`, { method: 'POST', headers: { 'X-AITS-Client': 'ai-test-solver' } }).catch(() => null);
    bridgeProc.kill();
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      console.log(`  (temp folder left: ${tmp})`);
    }
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll automatic-mode E2E checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
