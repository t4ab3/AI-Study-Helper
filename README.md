# AI Helper

AI Helper — расширение для Chrome и программа для Windows, которые работают через ваш собственный аккаунт DeepSeek на сайте chat.deepseek.com. Без API-ключей и платных токенов. Речь в текст переводит Whisper прямо на вашем компьютере, звук никуда не отправляется.

## Что умеет

**Тесты.** Расширение само проходит тест на странице: читает вопрос и варианты, спрашивает DeepSeek, выбирает ответ и переходит к следующему вопросу. Работает с одиночным и множественным выбором, «верно/неверно» и вводом текста. Окончательную кнопку «Завершить тест» без вашего подтверждения не нажимает. Если DeepSeek не ответил, программа ждёт, а не выбирает наугад.

**Конспекты лекций.** Записывает звук лекции из вкладки или со всего компьютера и прямо во время записи переводит речь в текст. Потом DeepSeek делает из текста конспект, и он сохраняется в Word.

**Живой суфлёр (AI Helper Live).** Отдельная программа для созвонов, интервью и выступлений. Она слушает собеседника через звук компьютера и вас через микрофон, а после каждой фразы собеседника показывает готовую реплику в 2–3 предложения. Кнопка «Подробнее» или Ctrl+Alt+D разворачивает ответ.
- Окно полупрозрачное, всегда поверх других и скрыто от демонстрации экрана в Zoom, Teams, Meet и OBS.
- При запуске суфлёр сам поднимает bridge и сразу открывает DeepSeek, первую подсказку ждать не нужно.
- В настройках можно вписать тему разговора, например «физика» или «веб-технологии», и подсказки будут учитывать её.
- Языки: украинский, русский, английский.

## Быстрый старт

1. Скачайте проект и дважды щёлкните `install.bat`. Он сам скачает Python и Node.js, если их нет, соберёт расширение, поставит библиотеки и создаст ярлыки на рабочем столе. Права администратора не нужны.
2. В открывшемся `chrome://extensions` включите «Режим разработчика», нажмите «Загрузить распакованное» и выберите папку `extension\dist`.
3. Запустите ярлык **AI Helper (bridge)** и один раз войдите в DeepSeek. Если при регистрации мешает проверка, нажмите кнопку «Открыть для входа или регистрации».
4. Для тестов и конспектов нажмите на иконку расширения. Для разговоров запустите ярлык **AI Helper Live**.

## Подробная инструкция

В [docs/Инструкция AI Helper.docx](docs/Инструкция%20AI%20Helper.docx) лежит полная пошаговая инструкция для обычного пользователя, со скриншотами, от установки до работы. В ней каждый режим, все настройки и таблица «что делать, если не работает».

------------------------------------------------------------------------------------------------------------------------

# AI Helper

AI Helper is a Chrome extension and a Windows app that work through your own DeepSeek account on chat.deepseek.com. No API keys or paid tokens. Speech is turned into text by Whisper on your own computer, so audio never leaves it.

## Features

**Tests.** The extension works through a test on the page by itself: it reads the question and options, asks DeepSeek, picks the answer and moves to the next question. It handles single and multiple choice, true/false and text input. It never presses the final "Finish test" button without your confirmation. If DeepSeek doesn't answer, it waits instead of guessing.

**Lecture notes.** Records lecture audio from a tab or the whole computer and transcribes it live. DeepSeek then turns the transcript into structured notes, saved as a Word file.

**Live assistant (AI Helper Live).** A separate app for calls, interviews and talks. It listens to the other person through your computer's audio and to you through the microphone. After each phrase from the other person it shows a ready reply of 2–3 sentences. "More" or Ctrl+Alt+D expands the answer.
- The window is translucent, always on top and hidden from screen sharing in Zoom, Teams, Meet and OBS.
- On launch it starts the bridge by itself and opens DeepSeek right away, so the first hint doesn't have to wait.
- You can type the topic of the conversation in the settings, for example "physics" or "web technologies", and the hints take it into account.
- Languages: Ukrainian, Russian, English.

## Quick start

1. Download the project and double-click `install.bat`. It downloads Python and Node.js if they're missing, builds the extension, installs the libraries and creates desktop shortcuts. No admin rights needed.
2. In the `chrome://extensions` page it opens, turn on "Developer mode", click "Load unpacked" and choose the `extension\dist` folder.
3. Start the **AI Helper (bridge)** shortcut and sign in to DeepSeek once. If a check blocks sign-up, use the "Open for sign-in or sign-up" button.
4. For tests and lecture notes, click the extension icon. For conversations, start the **AI Helper Live** shortcut.

## Full guide

[docs/Инструкция AI Helper.docx](docs/Инструкция%20AI%20Helper.docx) is a complete step-by-step guide for non-technical users, with screenshots, from installation to everyday use. It covers every mode, all settings and a troubleshooting table. The guide is in Russian.
