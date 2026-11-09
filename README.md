# Telegram Expense Bot

Личный Telegram-бот для ежедневного ввода расходов в Google Sheets.
Работает на Cloudflare Workers Free. Без БД, KV, Docker и платных сервисов.

Код: [workers/tg-expense-bot/](workers/tg-expense-bot/). Инструкция по запуску и секреты: [workers/tg-expense-bot/README.md](workers/tg-expense-bot/README.md).

## Быстрый старт

```bash
cd workers/tg-expense-bot
npm ci
npm test
npm run deploy   # после подготовки секретов; webhook при этом не переключается
```

Тесты и проверка сборки также выполняются в GitHub Actions: `.github/workflows/worker-ci.yml`.
