"""
Обработчики команд и сообщений Telegram бота.
Управляет взаимодействием пользователя с ботом и обработкой расходов.
"""
from telegram import Update, ReplyKeyboardRemove
from telegram.ext import ContextTypes, CommandHandler, MessageHandler, CallbackQueryHandler, ConversationHandler, filters
from src.parser_core import ExpenseParser, ParseError
from src.sheets_client import get_sheets_client
from src.bot_keyboards import get_last_rows_keyboard, get_row_action_keyboard, get_main_keyboard, get_edit_keyboard
from src.logger import setup_logger
from datetime import datetime, timezone, timedelta

# Состояние для ConversationHandler при редактировании
WAITING_FOR_NEW_TEXT = 1

# Инициализация парсера и логгера
parser = ExpenseParser()
logger = setup_logger(__name__)

async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Обработчик команды /start.
    Отправляет приветственное сообщение с инструкцией.
    """
    logger.info("Команда /start вызвана")
    await update.message.reply_text(
        "👋 Привет! Я бот для учета расходов.\n"
        "Просто отправь мне сумму и описание, например:\n"
        "продукты 500 тбанк\n",
        reply_markup=get_main_keyboard()
    )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Обработчик команды /help.
    Отправляет подробную справку по использованию бота.
    """
    logger.info("Команда /help вызвана")
    help_text = (
        "🤖 <b>Справка по командам:</b>\n\n"
        "📝 <b>Добавление расхода:</b>\n"
        "Просто напишите сообщение, например:\n"
        "• <i>продукты 500</i>\n"
        "• <i>такси 300 сбер</i>\n"
        "• <i>30 usd подарок</i>\n\n"
        "🎛 <b>Меню:</b>\n"
        "• <b>Посмотреть последние</b> — список последних 4 записей с возможностью редактирования и удаления.\n\n"
        "🛠 <b>Команды:</b>\n"
        "/start — Перезапуск и показ меню\n"
        "/help — Эта справка\n"
        "/last — Показать последние записи"
    )
    await update.message.reply_text(help_text, parse_mode='HTML')

async def text_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Обработчик текстовых сообщений.
    Парсит расход или обрабатывает кнопки меню.
    """
    text = update.message.text
    
    # Обработка кнопки меню
    if text == "Посмотреть последние записи":
        await last_command(update, context)
        return
    
    try:
        expense = parser.parse(text)
        # Конвертируем время сообщения в UTC+5
        utc_plus_5 = timezone(timedelta(hours=5))
        message_time = update.message.date.astimezone(utc_plus_5)
        get_sheets_client().append_row(expense, timestamp=message_time)
        
        logger.info(f"Расход добавлен: {expense.amount} {expense.currency}, источник: {expense.source}")
        
        # Формат ответа: ✅ Добавлено: продукты | 500 RUB | TBank
        response = f"✅ Добавлено: {expense.description} | {expense.amount} {expense.currency} | {expense.source}"
        await update.message.reply_text(response, reply_markup=get_main_keyboard())
        
    except ParseError as e:
        logger.warning(f"Ошибка парсинга: {e}")
        await update.message.reply_text(f"⚠️ {str(e)}")
    except Exception as e:
        logger.error(f"Системная ошибка при обработке расхода: {e}", exc_info=True)
        await update.message.reply_text(f"❌ Системная ошибка: {str(e)}")

async def last_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Обработчик команды /last и кнопки "Посмотреть последние записи".
    Показывает последние 4 записи с inline-клавиатурой для действий.
    """
    try:
        rows = get_sheets_client().get_last_rows(4)
        if not rows:
            logger.info("Запрошены последние записи, но таблица пуста")
            await update.message.reply_text("📋 Список пуст.", reply_markup=get_main_keyboard())
            return
        
        msg = "📋 <b>Последние записи:</b>\n\n"
        for i, r in enumerate(rows, 1):
            # Парсим дату из формата DD.MM.YYYY HH:MM -> HH:MM DD/MM
            try:
                # Формат: 04.12.2024 15:30
                dt = datetime.strptime(r['date'], "%d.%m.%Y %H:%M")
                date_fmt = dt.strftime("%H:%M %d/%m")
            except ValueError:
                # Fallback: если формат не совпадает, показываем как есть
                date_fmt = r['date']

            # Формат вывода: 03:28 04/12 500 RUB Cash (исходный текст)
            msg += f"{i}. {date_fmt} {r['amount']} {r['currency']} {r['source']} (<i>{r['description']}</i>)\n"
        
        kb = get_last_rows_keyboard(rows)
        # Сохраняем записи в контексте для избежания повторных запросов
        context.user_data['last_rows'] = rows
        
        logger.info(f"Показаны последние {len(rows)} записи")
        await update.message.reply_text(msg, parse_mode='HTML', reply_markup=kb)

    except Exception as e:
        logger.error(f"Ошибка при получении последних записей: {e}", exc_info=True)
        await update.message.reply_text(f"❌ Ошибка получения данных: {str(e)}")

async def navigation_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    data = query.data
    
    if data == "home":
        # Return to main screen and cancel any ongoing action
        if 'editing_row' in context.user_data:
            del context.user_data['editing_row']
        if 'last_rows' in context.user_data:
            del context.user_data['last_rows']
        
        await query.edit_message_text(
            "🏠 Главное меню\n\n"
            "Просто отправь мне сумму и описание, например: продукты 500 тбанк."
        )
        return ConversationHandler.END
        
    elif data == "back_to_list":
        # Re-render list
        try:
            rows = get_sheets_client().get_last_rows(4)
            msg = "📋 <b>Последние записи:</b>\n\n"
            for i, r in enumerate(rows, 1):
                try:
                    dt = datetime.strptime(r['date'], "%d.%m.%Y %H:%M")
                    date_fmt = dt.strftime("%H:%M %d/%m")
                except ValueError:
                    date_fmt = r['date']
                
                msg += f"{i}. {date_fmt} {r['amount']} {r['currency']} {r['source']} (<i>{r['description']}</i>)\n"

            kb = get_last_rows_keyboard(rows)
            await query.edit_message_text(msg, parse_mode='HTML', reply_markup=kb)
        except Exception as e:
            await query.edit_message_text(f"❌ Ошибка: {str(e)}")
            
    elif data.startswith("select_row:"):
        row_num = int(data.split(":")[1])
        # Find row data
        rows = context.user_data.get('last_rows', [])
        # If not in context (e.g. bot restart), fetch again
        if not rows:
            rows = get_sheets_client().get_last_rows(4)
        
        selected_row = next((r for r in rows if r['row_number'] == row_num), None)
        
        if not selected_row:
             # Fallback if row not found (maybe deleted or out of range)
             await query.edit_message_text("⚠️ Запись не найдена. Обновите список.")
             return

        # Show details with original raw text
        try:
            dt = datetime.strptime(selected_row['date'], "%d.%m.%Y %H:%M")
            date_fmt = dt.strftime("%H:%M %d/%m")
        except ValueError:
            date_fmt = selected_row['date']

        detail_msg = (\
            f"🔍 <b>Детали записи (стр. {row_num}):</b>\n\n"\
            f"{date_fmt} {selected_row['amount']} {selected_row['currency']} {selected_row['source']} (<i>{selected_row['description']}</i>)\n\n"\
            f"<i>Исходный текст: {selected_row['description']}</i>"\
        )
        
        await query.edit_message_text(detail_msg, parse_mode='HTML', reply_markup=get_row_action_keyboard(row_num))

    elif data.startswith("delete_row:"):
        row_num = int(data.split(":")[1])
        try:
            get_sheets_client().delete_row(row_num)
            await query.edit_message_text("✅ Запись удалена.")
            # Optionally show list again automatically? 
            # User asked for "Return to start" button, but "Delete" usually implies done.
            # Let's just leave it as "Deleted". User can click "View Last" again.
        except Exception as e:
            logger.error(f"Ошибка при удалении строки {row_num}: {e}", exc_info=True)
            await query.edit_message_text(f"❌ Ошибка удаления: {str(e)}")

async def start_edit_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    data = query.data
    if data.startswith("edit_row:"):
        row_num = int(data.split(":")[1])
        context.user_data['editing_row'] = row_num
        
        # Get the original row data to show
        rows = context.user_data.get('last_rows', [])
        if not rows:
            rows = get_sheets_client().get_last_rows(4)
            context.user_data['last_rows'] = rows
        
        selected_row = next((r for r in rows if r['row_number'] == row_num), None)
        
        original_text = selected_row['description'] if selected_row else "Неизвестно"
        
        await query.edit_message_text(
            f"✏️ Редактирование строки {row_num}\n\n"
            f"Исходный текст: <code>{original_text}</code>\n\n"
            "Отправьте новый текст записи:",
            parse_mode='HTML',
            reply_markup=get_edit_keyboard(row_num)
        )
        return WAITING_FOR_NEW_TEXT

async def process_edit_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text
    row_num = context.user_data.get('editing_row')
    
    if not row_num:
        await update.message.reply_text("⚠️ Ошибка контекста. Повторите выбор записи.")
        return ConversationHandler.END
    
    try:
        expense = parser.parse(text)
        get_sheets_client().update_row(row_num, expense)
        
        logger.info(f"Запись {row_num} обновлена: {expense.amount} {expense.currency}")
        
        # Single line format like primary record
        response = f"✅ Обновлено (стр. {row_num}):\n"
        f"{expense.description} - {expense.amount} {expense.currency} - {expense.source}"
        await update.message.reply_text(response, reply_markup=get_main_keyboard())
        del context.user_data['editing_row']
        return ConversationHandler.END
        
    except ParseError as e:
        logger.warning(f"Ошибка парсинга при редактировании: {e}")
        await update.message.reply_text(f"⚠️ {str(e)}")
        return WAITING_FOR_NEW_TEXT
    except Exception as e:
        logger.error(f"Ошибка при обновлении строки {row_num}: {e}", exc_info=True)
        await update.message.reply_text(f"❌ Ошибка: {str(e)}")
        return ConversationHandler.END

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("❌ Отменено.", reply_markup=get_main_keyboard())
    if 'editing_row' in context.user_data:
        del context.user_data['editing_row']
    return ConversationHandler.END

def setup_handlers(application):
    # Conversation for Editing
    conv_handler = ConversationHandler(
        entry_points=[CallbackQueryHandler(start_edit_callback, pattern="^edit_row:")],
        states={
            WAITING_FOR_NEW_TEXT: [MessageHandler(filters.TEXT & ~filters.COMMAND, process_edit_text)]
        },
        fallbacks=[CommandHandler("cancel", cancel)]
    )
    
    application.add_handler(conv_handler)
    
    # Global Navigation Handler (Select, Delete, Back, Home)
    application.add_handler(CallbackQueryHandler(navigation_callback, pattern="^(select_row|delete_row|back_to_list|home)"))
    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("last", last_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_handler))