import os
import json
from typing import Optional
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings
from dotenv import load_dotenv

load_dotenv()

class Settings(BaseSettings):
    telegram_token: str = Field(..., alias="TELEGRAM_TOKEN")
    webhook_url: Optional[str] = Field(None, alias="WEBHOOK_URL")
    spreadsheet_id: str = Field(..., alias="SPREADSHEET_ID")
    google_credentials_json: str = Field(..., alias="GOOGLE_CREDENTIALS_JSON")
    
    @field_validator('google_credentials_json')
    @classmethod
    def parse_credentials(cls, v: str) -> str:
        try:
            json.loads(v)
            return v
        except json.JSONDecodeError:
            raise ValueError("GOOGLE_CREDENTIALS_JSON must be valid JSON string")
    
    class Config:
        env_file = ".env"
        case_sensitive = False

settings = Settings()