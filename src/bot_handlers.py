from telegram import Update
from telegram.ext import ContextTypes, CommandHandler, MessageHandler, CallbackQueryHandler, ConversationHandler, filters
from src.parser_core import ExpenseParser, ParseError
from src.sheets_client import get_sheets_client
from src.bot_keyboards import get_edit_keyboard

WAITING_FOR_NEW_TEXT = 1

parser = ExpenseParser()

async def text_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text
    
    try:
        expense = parser.parse(text)
        get_sheets_client().append_row(expense)
        
        response = (
            f"✅ Добавлено:\n"
            f"📝 {expense.description}\n"
            f"💰 {expense.amount} {expense.currency}\n"
            f"💳 {expense.source}"
        )
        await update.message.reply_text(response)
        
    except ParseError as e:
        await update.message.reply_text(f"⚠️ {str(e)}")
    except Exception as e:
        await update.message.reply_text(f"❌ Системная ошибка: {str(e)}")

async def last_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        rows = get_sheets_client().get_last_rows(3)
        if not rows:
            await update.message.reply_text("📋 Список пуст.")
            return
        
        msg = "📋 <b>Последние 3 записи:</b>\n\n"
        for i, r in enumerate(rows, 1):
            date_short = r['date'][:10] if len(r['date']) >= 10 else r['date']
            msg += (
                f"{i}️⃣ <b>{r['amount']} {r['currency']}</b> — {r['description']}\n"
                f"   💳 {r['source']} | 📅 {date_short}\n\n"
            )
        
        kb = get_edit_keyboard(rows)
        await update.message.reply_text(msg, parse_mode='HTML', reply_markup=kb)
        
    except Exception as e:
        await update.message.reply_text(f"❌ Ошибка получения данных: {str(e)}")

async def edit_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    data = query.data
    if data.startswith("edit_request:"):
        row_num = int(data.split(":")[1])
        context.user_data['editing_row'] = row_num
        
        await query.edit_message_text(
            f"✏️ Редактирование строки {row_num}.\n\n"
            "Отправьте новый текст записи (например: кофе 300 карта):"
        )
        return WAITING_FOR_NEW_TEXT

async def process_edit_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text
    row_num = context.user_data.get('editing_row')
    
    if not row_num:
        await update.message.reply_text("⚠️ Ошибка контекста. Повторите /last")
        return ConversationHandler.END
    
    try:
        expense = parser.parse(text)
        get_sheets_client().update_row(row_num, expense)
        
        response = (
            f"✅ Запись (строка {row_num}) обновлена:\n"
            f"📝 {expense.description}\n"
            f"💰 {expense.amount} {expense.currency}\n"
            f"💳 {expense.source}"
        )
        await update.message.reply_text(response)
        del context.user_data['editing_row']
        return ConversationHandler.END
        
    except ParseError as e:
        await update.message.reply_text(f"⚠️ {str(e)}\n\nПопробуйте еще раз:")
        return WAITING_FOR_NEW_TEXT
    except Exception as e:
        await update.message.reply_text(f"❌ Ошибка: {str(e)}")
        return ConversationHandler.END

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("❌ Отменено.")
    if 'editing_row' in context.user_data:
        del context.user_data['editing_row']
    return ConversationHandler.END

def setup_handlers(application):
    conv_handler = ConversationHandler(
        entry_points=[CallbackQueryHandler(edit_callback, pattern="^edit_request:")],
        states={
            WAITING_FOR_NEW_TEXT: [MessageHandler(filters.TEXT & ~filters.COMMAND, process_edit_text)]
        },
        fallbacks=[CommandHandler("cancel", cancel)]
    )
    
    application.add_handler(conv_handler)
    application.add_handler(CommandHandler("last", last_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_handler))