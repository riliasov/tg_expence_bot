# tg-expense-bot (Cloudflare Workers Free)

Личный Telegram-бот расходов. Пишет в Google Sheets. Без Docker, Cloud Run, БД, KV, D1 и платных сервисов.
Python-версия в корне репозитория не изменена и продолжает работать как прежде, пока вы не переключите webhook.

## Что умеет

- Добавление расхода: `продукты 500`, `такси 300 сбер`, `30 usd подарок`, `50000 vnd кофе`, `12.50 eur чай`.
- Просмотр последних 4 записей (`/last` или кнопка), открытие записи.
- Редактирование: кнопка «Редактировать», затем ответ (reply) на подсказку с новым текстом.
- Удаление строки кнопкой.
- Доступ только для одного Telegram user ID. Чужие сообщения игнорируются без ответа.
- Проверка заголовка `X-Telegram-Bot-Api-Secret-Token` (секрет webhook).

Исправлено относительно Python-версии:
- **Десятичные суммы** сохраняются: `250.50` → 250.5, `500,75` → 500.75 (раньше отбрасывались).
- **VND**: слова `vnd`, `донг`, `dong`, символ `₫`.
- **Описание**: `продукты 500 р` больше не превращается в `одукты` (раньше `replace` вырезал букву «р» из всех слов).
- HTML-экранирование пользовательского текста в ответах Telegram.
- Ответ после редактирования теперь содержит строку целиком (в Python-версии вторая строка была отдельным выражением и терялась).

## Файлы

```
workers/tg-expense-bot/
├── src/
│   ├── index.js     # webhook: проверка secret token, 403/400/200
│   ├── bot.js       # маршрутизация сообщений и callback-кнопок, проверка user ID
│   ├── parser.js    # парсер расходов (порт parser_core.py)
│   ├── sheets.js    # Google Sheets REST + JWT service account через WebCrypto
│   ├── telegram.js  # sendMessage / editMessageText / answerCallbackQuery
│   └── format.js    # экранирование HTML, форматы сумм и дат
├── test/            # node:test, без внешних зависимостей
├── wrangler.toml    # имя Worker'а, не секретные переменные
├── .dev.vars.example
└── package.json
```

## Секреты (Cloudflare Secrets, не GitHub)

| Имя | Что это |
|---|---|
| `TELEGRAM_TOKEN` | токен бота от @BotFather |
| `WEBHOOK_SECRET` | случайная строка для заголовка secret token. Сгенерировать: `openssl rand -hex 32` |
| `ALLOWED_USER_ID` | ваш числовой Telegram user ID (единственный, кому отвечает бот) |
| `SPREADSHEET_ID` | ID таблицы из URL: `docs.google.com/spreadsheets/d/{ID}/edit` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | весь JSON ключа сервисного аккаунта (одной строкой или как есть) |

Несекретные значения лежат в `wrangler.toml` (`[vars]`): `SHEET_GID` (gid листа из URL `#gid=`, по умолчанию `0`) и `TZ_OFFSET_HOURS` (`5`).

## Деплой (выполняйте вручную, по шагам)

1. Установка и тесты:
   ```bash
   cd workers/tg-expense-bot
   npm ci
   npm test
   ```
2. Проверка сборки без деплоя: `npm run build:check`.
3. Вход в Cloudflare (один раз, откроется браузер): `npx wrangler login`.
4. Выдать сервисному аккаунту доступ к таблице: откройте таблицу → «Настройки доступа» → добавьте `client_email` из JSON с правом **Редактор**.
5. Проверить `SHEET_GID` в `wrangler.toml`.
6. Записать секреты (wrangler спросит значение в терминале, не в файлах):
   ```bash
   npx wrangler secret put TELEGRAM_TOKEN
   npx wrangler secret put WEBHOOK_SECRET
   npx wrangler secret put ALLOWED_USER_ID
   npx wrangler secret put SPREADSHEET_ID
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
   ```
7. Деплой Worker'а (это **не** переключает webhook бота):
   ```bash
   npm run deploy
   ```
   URL будет вида `https://tg-expense-bot.<ваш-поддомен>.workers.dev`. Имя `tg-expense-bot` не пересекается с `ninjago-relay`.
8. **Переключение webhook: отдельный шаг, только после вашего решения.** `setWebhook` перенаправит бота с Cloud Run на Worker. У бота может быть только один webhook, поэтому одновременно работать две версии не будут.
   ```bash
   curl -X POST "https://api.telegram.org/bot$TELEGRAM_TOKEN/setWebhook" \
     -d "url=https://tg-expense-bot.<поддомен>.workers.dev/" \
     -d "secret_token=$WEBHOOK_SECRET" \
     -d 'allowed_updates=["message","callback_query"]'
   ```
   Чтобы откатиться, вызовите `setWebhook` с URL Cloud Run. Токен не записывайте в файлы и историю shell.

Локальная отладка: скопируйте `.dev.vars.example` в `.dev.vars`, заполните и запустите `npm run dev`. `.dev.vars` в git не попадает.

## Оценка внешних API-запросов на одну операцию

Входящий webhook от Telegram не считается. Отдельно учитывается **токен Google**: `POST oauth2.googleapis.com/token` один раз на холодный isolate и примерно раз в час, пока isolate жив.

| Операция | Google Sheets | Telegram | Итого |
|---|---|---|---|
| Добавить расход | 1 (append) | 1 (sendMessage) | **2** |
| `/last` или кнопка «Посмотреть последние» | 2 (счёт строк по A:A, чтение A:I) | 1 | **3** |
| Открыть запись (select_row) | 1 | 2 (answerCallback, editMessageText) | **3** |
| Редактирование, шаг 1 (edit_row) | 1 | 2 (answerCallback, sendMessage с force_reply) | **3** |
| Редактирование, шаг 2 (ответ с текстом) | 1 (update) | 1 | **2** |
| Удаление строки | 1 (batchUpdate) | 2 (answerCallback, editMessageText) | **3** |
| «Назад» к списку | 2 | 2 | **4** |
| `/start`, `/help`, `/cancel` | 0 | 1 | **1** |

Наибольшее число за одну операцию — 4 (+ токен Google), что далеко от лимита 50 subrequests на вызов Workers Free.

## Соответствие лимитам Workers Free

- **CPU 10 мс на вызов**: основная работа — парсинг (порядка 5 мкс в Node на тестовых строках), сборка строк и JSON. Подпись JWT выполняется только при холодном старте или раз в час: импорт ключа около 1 мс и подпись около 0.6 мс в Node. Это грубая оценка для Node, а не замер на Workers. Реальное CPU-время проверяйте после деплоя: `npx wrangler tail` показывает `CPU Time` для каждого вызова.
- **Размер bundle**: 24.7 KiB (gzip 7 KiB), лимиты Free не близко.
- **Состояние**: в Workers нет памяти между вызовами, поэтому редактирование сделано через `reply` на подсказку `force_reply`, а кэш токена живёт только в памяти isolate. Без KV/D1 токен не сохраняется между холодными стартами.
- Квоты Cloudflare и Google Sheets API (например, лимиты чтений в минуту на пользователя) проверьте в актуальной документации. Для личного бота их обычно достаточно.

## Известные ограничения

- Пробел между тремя цифрами считается разделителем тысяч: `кофе 100 500 руб` → 100500 (так работала и Python-версия). Для двух сумм используйте `и` или запятую: `кофе 100 и 500 руб`.
- Удаление и редактирование работают по номеру строки из кнопки, как и раньше. Если строки сдвинулись между показом списка и нажатием, можно изменить не ту запись. Подтверждения удаления нет, как и в исходной версии.
- Редактирование работает через reply на подсказку бота. Если подсказку удалить, отправьте `/last` и начните заново.
