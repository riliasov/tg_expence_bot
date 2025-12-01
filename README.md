Telegram Expense Bot

Бот для учета расходов с записью в Google Sheets.

1. Подготовка

Google Cloud & Sheets

Создайте проект в Google Cloud Console.

Включите Google Sheets API и Google Drive API.

Создайте Service Account, скачайте JSON-ключ.

Создайте Google Таблицу.

Нажмите "Настройки доступа" в таблице и добавьте email сервисного аккаунта (из JSON) как Редактора.

Скопируйте ID таблицы из URL (между /d/ и /edit).

Переменные окружения (.env)

Создайте файл .env:

TELEGRAM_TOKEN=ващ_токен_бота
WEBHOOK_URL=[https://ваш-клауд-ран-url.run.app](https://ваш-клауд-ран-url.run.app)
SPREADSHEET_ID=айди_таблицы
GOOGLE_CREDENTIALS_JSON={"type": "service_account", ...весь json в одну строку...}


2. Локальный запуск (Polling/Local Webhook)

Для локальной разработки используйте ngrok для вебхука или уберите логику вебхука в main.py для пулинга (в текущем коде только вебхук).

pip install -r requirements.txt
python main.py


3. Деплой в Google Cloud Run

Установите gcloud CLI.

Сборка и деплой:

# 1. Сборка образа
gcloud builds submit --tag gcr.io/PROJECT_ID/expense-bot

# 2. Деплой
gcloud run deploy expense-bot \
  --image gcr.io/PROJECT_ID/expense-bot \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars="TELEGRAM_TOKEN=xxx,SPREADSHEET_ID=xxx,WEBHOOK_URL=https://сервис-url"


Примечание: GOOGLE_CREDENTIALS_JSON лучше передавать через Secret Manager, но для теста можно добавить в --set-env-vars (экранируйте кавычки).
