import uvicorn
from fastapi import FastAPI, Request
from telegram import Update
from telegram.ext import ApplicationBuilder
from src.config import TELEGRAM_TOKEN, WEBHOOK_URL
from src.bot.handlers import setup_handlers

app = FastAPI()

# Build Bot Application
ptb_app = ApplicationBuilder().token(TELEGRAM_TOKEN).build()
setup_handlers(ptb_app)

@app.on_event("startup")
async def startup_event():
    await ptb_app.initialize()
    await ptb_app.start()
    
    # Set Webhook if URL is configured
    if WEBHOOK_URL:
        # Ensure trailing slash for set_webhook is correct based on logic
        webhook_path = f"{WEBHOOK_URL}/webhook"
        await ptb_app.bot.set_webhook(webhook_path)
        print(f"Webhook set to {webhook_path}")

@app.on_event("shutdown")
async def shutdown_event():
    await ptb_app.stop()
    await ptb_app.shutdown()

@app.post("/webhook")
async def webhook_handler(request: Request):
    data = await request.json()
    update = Update.de_json(data, ptb_app.bot)
    await ptb_app.process_update(update)
    return {"status": "ok"}

if __name__ == "__main__":
    # Local run
    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=True)
