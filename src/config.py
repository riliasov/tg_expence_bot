import os
import json
from dotenv import load_dotenv

load_dotenv()

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
WEBHOOK_URL = os.getenv("WEBHOOK_URL")  # Full URL: https://your-domain.com/webhook
SPREADSHEET_ID = os.getenv("SPREADSHEET_ID")
GOOGLE_CREDENTIALS_JSON = os.getenv("GOOGLE_CREDENTIALS_JSON")

if not TELEGRAM_TOKEN:
    raise ValueError("TELEGRAM_TOKEN is missing")
if not SPREADSHEET_ID:
    raise ValueError("SPREADSHEET_ID is missing")
if not GOOGLE_CREDENTIALS_JSON:
    raise ValueError("GOOGLE_CREDENTIALS_JSON is missing")

# Parse JSON string if provided, otherwise assume it's a file path logic handled by client
try:
    GOOGLE_CREDS_DICT = json.loads(GOOGLE_CREDENTIALS_JSON)
except json.JSONDecodeError:
    # If not valid JSON string, assume it might be a file path or handle error later
    GOOGLE_CREDS_DICT = None
