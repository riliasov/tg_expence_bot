"""
Модуль конфигурации приложения.
Загружает настройки из переменных окружения и .env файла.
"""
import os
import json
from typing import Optional
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings
from dotenv import load_dotenv

load_dotenv()

class Settings(BaseSettings):
    """
    Настройки приложения.
    Использует Pydantic для валидации переменных окружения.
    """
    telegram_token: str = Field(..., alias="TELEGRAM_TOKEN", description="Токен Telegram бота")
    webhook_url: Optional[str] = Field(None, alias="WEBHOOK_URL", description="URL вебхука (опционально)")
    spreadsheet_id: str = Field(..., alias="SPREADSHEET_ID", description="ID Google таблицы")
    google_credentials_json: str = Field(..., alias="GOOGLE_CREDENTIALS_JSON", description="JSON ключ сервисного аккаунта Google")
    
    @field_validator('google_credentials_json')
    @classmethod
    def parse_credentials(cls, v: str) -> str:
        """Проверяет, что google_credentials_json является валидным JSON."""
        try:
            json.loads(v)
            return v
        except json.JSONDecodeError:
            raise ValueError("GOOGLE_CREDENTIALS_JSON должен быть валидной JSON строкой")
    
    class Config:
        # Вычисляем абсолютный путь к secrets/.env
        _base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        env_file = os.path.join(_base_dir, "secrets", ".env")
        case_sensitive = False

settings = Settings()