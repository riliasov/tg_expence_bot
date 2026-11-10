# tg-expense-bot (Cloudflare Workers Free)

Личный Telegram-бот расходов. Пишет в Google Sheets. Без Docker, БД, KV, D1, R2 и платных сервисов.
Webhook переключается отдельно от деплоя Worker; прежний Cloud Run сервис сохраняется для отката.

## Что умеет

- Добавление расхода: `продукты 500`, `такси 300 сбер`, `30 usd подарок`, `50000 vnd кофе`, `12.50 eur чай`.
- Просмотр последних 4 записей (`/last` или кнопка), открытие записи.
- Редактирование: кнопка «Редактировать», затем ответ (reply) на подсказку с новым текстом.
- Удаление: кнопка «Удалить», затем отдельное подтверждение.

Защиты:
- Работает только с личным чатом владельца (`ALLOWED_USER_ID`). Группы, каналы и чужие пользователи игнорируются без ответа.
- Проверка заголовка `X-Telegram-Bot-Api-Secret-Token`.
- Все операции с листом адресуются по `SHEET_GID`. Если gid не задан или не найден в таблице, запись блокируется.
- Редактирование и удаление сверяют fingerprint строки: если строка сдвинулась или изменилась, действие отменяется.
- Редактирование меняет только B:E, H:I и L. Категории F:G, FX/Commission J:K и даты A/M сохраняются.
- Текст пишется в Sheets как литерал (`valueInputOption=RAW`): `=...` не превращается в формулу.
- Текст длиннее 200 символов отклоняется, управляющие символы заменяются пробелом.

Исправлено относительно Python-версии:
- **Десятичные суммы** сохраняются: `250.50` → 250.5, `500,75` → 500.75.
- **VND**: слова `vnd`, `донг`, `dong`, символ `₫`.
- **Описание**: `продукты 500 р` больше не превращается в `одукты`.
- HTML-экранирование пользовательского текста в ответах Telegram.

## Формат данных `tg_bot`

Worker работает только со вкладкой `tg_bot` по заданному `SHEET_GID`. До первого запуска после миграции строка 1 должна иметь заголовки A:M в таком порядке:

`Timestamp | Amount | Currency | FX RUB | RUB | Category | SubCategory | Description | Account | FX | Commission | Purchase Currency | Operation Date`

Worker сверяет все 13 заголовков перед чтением и изменением строк. При старой или изменённой схеме операция прекращается без записи.

- Расходы записываются отрицательными числами. Для RUB `FX RUB = 1` и `RUB = Amount`; для других валют D:E пустые.
- При создании F = `Покупка`, G пустая, H содержит разобранное описание, I — счёт, J:K пустые, L равен валюте операции.
- A — нативная дата-время Sheets, M — нативная дата. Обе рассчитаны в UTC+5; часовой пояс таблицы должен оставаться UTC+5. Отформатируйте A как `dd.MM.yyyy HH:mm:ss`, M как `dd.MM.yyyy`.
- Строки передаются с `valueInputOption=RAW`: пользовательский текст остаётся литералом и никогда не исполняется как формула. Нативные даты передаются числовыми serial-значениями Sheets.
- Редактирование не меняет A, F:G, J:K и M.

## Файлы

```
workers/tg-expense-bot/
├── src/
│   ├── index.js     # webhook: проверка secret token, 403/400/200
│   ├── bot.js       # маршрутизация, проверка владельца и чата, подтверждения
│   ├── parser.js    # парсер расходов (порт parser_core.py)
│   ├── sheets.js    # Google Sheets REST: SHEET_GID -> title, A:M, RAW, fingerprint
│   ├── telegram.js  # sendMessage / editMessageText / answerCallbackQuery
│   └── format.js    # экранирование HTML, форматы сумм и дат
├── test/            # node:test, без внешних зависимостей; fake Google Sheets с двумя вкладками
├── wrangler.toml    # имя Worker'а, несекретные переменные
├── .dev.vars.example
└── package.json
```

## Секреты (Cloudflare Secrets, не GitHub)

| Имя | Что это |
|---|---|
| `TELEGRAM_TOKEN` | токен бота от @BotFather |
| `WEBHOOK_SECRET` | случайная строка для заголовка secret token. Сгенерировать: `openssl rand -hex 32` |
| `ALLOWED_USER_ID` | ваш числовой Telegram user ID (единственный, кому отвечает бот) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | весь JSON ключа сервисного аккаунта (передаётся из файла через stdin, см. ниже) |

Несекретные значения лежат в `wrangler.toml` (`[vars]`): `SPREADSHEET_ID`, `SHEET_GID` (gid вкладки `tg_bot`, обязателен, значения по умолчанию нет) и `TZ_OFFSET_HOURS` = `5`.

## Деплой (выполняйте вручную, по шагам)

1. Установка и тесты:
   ```bash
   cd workers/tg-expense-bot
   npm ci
   npm test
   npm run build:check
   ```
2. Вход в Cloudflare (один раз, откроется браузер): `npx wrangler login`.
3. Выдать сервисному аккаунту доступ к таблице: «Настройки доступа» → `client_email` из JSON с правом **Редактор**.
4. Записать секреты (wrangler спросит значение в терминале, в файлы не пишется):
   ```bash
   npx wrangler secret put TELEGRAM_TOKEN
   npx wrangler secret put WEBHOOK_SECRET
   npx wrangler secret put ALLOWED_USER_ID
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < ../../secrets/service-account.json
   ```
   Ключ передаётся через stdin из файла: в терминал и в промежуточные файлы он не выводится.
5. Деплой Worker'а (это **не** переключает webhook):
   ```bash
   npm run deploy
   ```
   URL вида `https://tg-expense-bot.<ваш-поддомен>.workers.dev`. Имя не пересекается с `ninjago-relay`.
6. **Переключение webhook — отдельный шаг, только после решения владельца.** `setWebhook` перенаправит бота с Cloud Run на Worker. У бота может быть только один webhook.
   ```bash
   curl -X POST "https://api.telegram.org/bot$TELEGRAM_TOKEN/setWebhook" \
     -d "url=https://tg-expense-bot.<поддомен>.workers.dev/" \
     -d "secret_token=$WEBHOOK_SECRET" \
     -d 'allowed_updates=["message","callback_query"]'
   ```
   Откат: `setWebhook` с URL Cloud Run. Токен не записывайте в файлы и историю shell.

Локальная отладка: скопируйте `.dev.vars.example` в `.dev.vars`, заполните и запустите `npm run dev`. `.dev.vars` в git не попадает.

## CI

Workflow `.github/workflows/worker-ci.yml` запускается только при изменениях в `workers/tg-expense-bot/**` и делает `npm ci`, `npm test`, `npm run build:check`. Деплоя и доступа к Cloudflare в CI нет.

## Внешние API-запросы на одну операцию

Входящий webhook от Telegram не считается. Учитываются разовые запросы на холодный isolate: токен Google (`oauth2.googleapis.com/token`, раз в час) и название листа по gid (`sheets.googleapis.com` с `fields=sheets.properties`, один раз на isolate).

| Операция | Google Sheets | Telegram | Итого |
|---|---|---|---|
| Добавить расход | 1 (append) | 1 (sendMessage) | **2** |
| `/last` или кнопка | 2 (счёт строк A:A, чтение A:M) | 1 | **3** |
| Открыть запись (select_row) | 1 | 2 (answerCallback, editMessageText) | **3** |
| Редактирование, шаг 1 (edit_row) | 1 | 2 (answerCallback, sendMessage с force_reply) | **3** |
| Редактирование, шаг 2 (ответ) | 2 (чтение строки для сверки, batchUpdate B:E, H:I и L) | 1 | **3** |
| Удаление, шаг 1 (запрос подтверждения) | 1 (чтение для сверки) | 2 (answerCallback, editMessageText) | **3** |
| Удаление, шаг 2 (подтверждено) | 2 (чтение для сверки, deleteDimension) | 2 (answerCallback, editMessageText) | **4** |
| «Назад» к списку | 2 | 2 | **4** |
| `/start`, `/help`, `/cancel` | 0 | 1 | **1** |

Худший холодный вызов: 4 запроса операции + токен + метаданные листа = 6. Лимит 50 subrequests на вызов Workers Free не близок.

## Лимиты

- **Workers Free** (по [документации Cloudflare](https://developers.cloudflare.com/workers/platform/limits/)): 100 000 запросов в сутки, 10 мс CPU на вызов, 50 subrequests на вызов.
- **Google Sheets API** (по [документации Google](https://developers.google.com/workspace/sheets/api/limits)): ограничения на чтение и запись в минуту на пользователя и проект. Для личного бота с ручным вводом их достаточно. Худший случай одной операции — 2 записи и 2 чтения.
- **CPU**: парсер и сборка строк занимают микросекунды (замер в Node). Подпись JWT выполняется только на холодном старте: импорт ключа около 1 мс и подпись около 0.6 мс в Node. Это оценка для Node, а не замер на Workers. Реальное CPU Time проверяется после деплоя: `npx wrangler tail`.
- **Размер bundle**: около 25 KiB (gzip около 7 KiB).
- **Состояние**: память между вызовами не сохраняется. Кэши токена, ключа и названия листа живут только в памяти isolate и пересоздаются при холодном старте. Редактирование и удаление не зависят от памяти: они сверяют строку по fingerprint.

## Ошибки и повторы

- Ошибка при обработке update (например, Sheets вернул 500) не падает наружу: владелец получает сообщение `❌ Системная ошибка: ...` в чат, Worker отвечает 200.
- Telegram не будет повторять такой update. Временную ошибку нужно повторить вручную, отправив сообщение ещё раз.
- Ответ 403 получает только запрос без верного secret token. Ответ 200 без записи получают чужие пользователи и групповые чаты.

## Известные ограничения

- Пробел между тремя цифрами считается разделителем тысяч: `кофе 100 500 руб` → 100500 (как в Python-версии). Для двух сумм используйте `и`: `кофе 100 и 500 руб`.
- Кэш названия листа не видит переименования вкладки до следующего холодного старта.
- Подсказка редактирования работает через reply. Если её удалить, начните заново через `/last`.
