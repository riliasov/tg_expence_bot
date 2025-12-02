import os
import uvicorn
from fastapi import FastAPI, Request
from telegram import Update
from telegram.ext import Application
from src.config import settings
from src.bot_handlers import setup_handlers

app = FastAPI()

ptb_app = Application.builder().token(settings.telegram_token).build()
setup_handlers(ptb_app)

@app.on_event("startup")
async def startup_event():
    await ptb_app.initialize()
    await ptb_app.start()
    
    if settings.webhook_url:
        webhook_path = f"{settings.webhook_url}/webhook"
        await ptb_app.bot.set_webhook(webhook_path)
        print(f"✅ Webhook set to {webhook_path}")
    else:
        print("ℹ️  No webhook URL configured (use for local development with ngrok)")

@app.on_event("shutdown")
async def shutdown_event():
    await ptb_app.stop()
    await ptb_app.shutdown()

@app.post("/webhook")
async def webhook_handler(request: Request):
    data = await request.json()
    update = Update.de_json(data, ptb_app.bot)
    await ptb_app.process_update(update)
    return {"ok": True}

@app.get("/health")
async def health():
    return {"status": "ok", "bot": "expense-tracker"}

if __name__ == "__main__":
    ptb_app.run_polling()