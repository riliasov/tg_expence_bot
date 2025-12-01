# Telegram Expense Bot

Telegram бот для учета расходов с автоматической записью в Google Sheets.

## Возможности

- ✅ Парсинг свободного текста: `"кофе 250 нал"`, `"тбанк кино 20 USD"`
- ✅ Поддержка 7 валют: RUB, USD, EUR, KZT, CLP, USDT
- ✅ 15+ источников платежей: Cash, TBank, Ozon, Sber, Alfa, и др.
- ✅ Показ последних 3 записей: `/last`
- ✅ Редактирование через inline-кнопки
- ✅ Emoji-форматирование для лучшего UX

## Быстрый старт

### 1. Установка зависимостей

```bash
pip install -r requirements.txt
```

### 2. Создание Google Service Account

1. Перейти в [Google Cloud Console](https://console.cloud.google.com)
2. Создать новый проект (или выбрать существующий)
3. Включить API:
   - Google Sheets API
   - Google Drive API
4. Создать Service Account:
   - IAM & Admin → Service Accounts → Create Service Account
   - Название: `expense-bot`
   - Скачать JSON ключ
5. Создать Google Sheet:
   - Добавить заголовки: `Date | Amount | Currency | FX | RUB | Category | SubCategory | Description | Account`
   - Поделиться с email сервисного аккаунта (Editor)
   - Скопировать Sheet ID из URL

### 3. Настройка переменных окружения

Создать `.env` файл:

```bash
cp .env.example .env
```

Заполнить значения:

```env
TELEGRAM_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
WEBHOOK_URL=
SPREADSHEET_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUF...
GOOGLE_CREDENTIALS_JSON={"type":"service_account","project_id":"..."}
```

**Конвертация JSON в одну строку:**

```bash
# macOS/Linux
cat service-account.json | jq -c .

# Windows PowerShell
(Get-Content service-account.json | ConvertFrom-Json | ConvertTo-Json -Compress)
```

### 4. Локальный запуск

**Вариант A: С ngrok (webhook)**

```bash
# Терминал 1: запустить ngrok
ngrok http 8080

# Скопировать HTTPS URL и добавить в .env:
# WEBHOOK_URL=https://abc123.ngrok.io

# Терминал 2: запустить бота
python main.py
```

**Вариант B: Polling (для разработки)**

Изменить `main.py` (закомментировать FastAPI, использовать polling):

```python
if __name__ == "__main__":
    ptb_app.run_polling()
```

### 5. Тестирование

Отправить боту:
```
кофе 250 нал
```

Ожидаемый ответ:
```
✅ Добавлено:
📝 кофе
💰 250 RUB
💳 Cash
```

Проверить команду `/last`:
```
📋 Последние 3 записи:

1️⃣ 250 RUB — кофе
   💳 Cash | 📅 2024-12-02

[Изменить 1: 250 (кофе...)]
```

## Деплой в Google Cloud Run

### 1. Установка gcloud CLI

```bash
# macOS
brew install google-cloud-sdk

# Windows
# Скачать installer с cloud.google.com/sdk

# Linux
curl https://sdk.cloud.google.com | bash
```

### 2. Аутентификация

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

### 3. Деплой

```bash
gcloud run deploy expense-bot \
  --source . \
  --platform managed \
  --region europe-west1 \
  --allow-unauthenticated \
  --set-env-vars="TELEGRAM_TOKEN=xxx" \
  --set-env-vars="SPREADSHEET_ID=xxx" \
  --set-env-vars="GOOGLE_CREDENTIALS_JSON={\"type\":\"service_account\",...}" \
  --set-env-vars="WEBHOOK_URL=https://expense-bot-xxx.run.app"
```

**Важно:** WEBHOOK_URL нужно установить после первого деплоя:
1. Первый деплой → получить Cloud Run URL
2. Обновить WEBHOOK_URL с этим URL
3. Второй деплой → webhook установится корректно

### 4. Проверка

```bash
# Получить URL сервиса
gcloud run services describe expense-bot --region europe-west1 --format="value(status.url)"

# Проверить health endpoint
curl https://expense-bot-xxx.run.app/health
```

### 5. Логи

```bash
gcloud run services logs read expense-bot --region europe-west1 --limit 50
```

## Формат сообщений

Бот принимает текст в **любом порядке**:

```
кофе 250 нал          → 250 RUB, Cash
тбанк кино 20 USD     → 20 USD, TBank
30,33 EUR топливо     → 30 EUR, Cash (дробная часть отбрасывается)
1 200 хлеб карта      → 1200 RUB, Card (пробелы удаляются)
-500 кофе             → 500 RUB, Cash (минус игнорируется)
₸500 топливо          → 500 RUB, Cash (символы удаляются)
```

## Поддерживаемые валюты

- RUB (руб, р, рубль, рублей)
- USD (доллар, dollar)
- EUR (евро, euro)
- KZT (тенге, tenge)
- CLP (песо, peso)
- USDT

## Поддерживаемые источники

- Cash (нал, наличн, наличные, кэш)
- TBank (тбанк, т-банк, тинькофф)
- Card (карта)
- KZCard (kzcard, казкард)
- Ozon (озон)
- Sber (сбер, сберbank)
- Yandex (яндекс)
- Alfa (альфа, альфабанк)
- Travel
- BCC (бcc)

## Команды бота

- `/last` — показать последние 3 записи с кнопками редактирования
- `/cancel` — отменить текущее редактирование

## Структура проекта

```
telegram-expense-bot/
├── requirements.txt          # Python зависимости
├── Dockerfile                # Для Cloud Run
├── .env.example              # Шаблон конфигурации
├── main.py                   # FastAPI + Telegram webhook
├── src/
│   ├── config.py             # Pydantic настройки
│   ├── parser/
│   │   └── core.py           # Парсер расходов
│   ├── sheets/
│   │   └── client.py         # Google Sheets клиент
│   └── bot/
│       ├── handlers.py       # Telegram обработчики
│       └── keyboards.py      # Inline клавиатуры
└── README.md
```

## Troubleshooting

### Ошибка: "TELEGRAM_TOKEN is missing"
- Проверить `.env` файл
- Убедиться что переменная называется `TELEGRAM_TOKEN` (не `TELEGRAM_BOT_TOKEN`)

### Ошибка: "403 Forbidden" при записи в Sheets
- Проверить, что Sheet поделен с email сервисного аккаунта
- Права должны быть "Editor", не "Viewer"

### Webhook не устанавливается
- Убедиться что WEBHOOK_URL указан с HTTPS
- Проверить что URL доступен публично (не localhost)
- Проверить логи: `gcloud run services logs read expense-bot`

### Бот не отвечает локально
- Если используется webhook: проверить что ngrok запущен
- Если используется polling: убрать логику webhook из main.py
- Проверить токен бота через curl:
  ```bash
  curl https://api.telegram.org/botYOUR_TOKEN/getMe
  ```

## Лицензия

MIT

## Автор

Integrated version combining best practices from multiple implementations.