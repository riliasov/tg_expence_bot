from telegram import InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup, KeyboardButton
from telegram.constants import ParseMode

def get_main_keyboard() -> ReplyKeyboardMarkup:
    keyboard = [
        [KeyboardButton("Посмотреть последние записи")]
    ]
    return ReplyKeyboardMarkup(keyboard, resize_keyboard=True)

def get_last_rows_keyboard(rows_data: list) -> InlineKeyboardMarkup:
    keyboard = []
    for i, entry in enumerate(rows_data, 1):
        row_num = entry['row_number']
        # Use raw text (description) but truncate it
        desc = entry['description'][:20] if entry['description'] else 'Запись'
        amt = entry['amount']
        curr = entry['currency']
        
        btn_text = f"{i}. {amt} {curr} - {desc}..."
        callback_data = f"select_row:{row_num}"
        
        keyboard.append([InlineKeyboardButton(btn_text, callback_data=callback_data)])
    
    keyboard.append([InlineKeyboardButton("🏠 В начало", callback_data="home")])
    return InlineKeyboardMarkup(keyboard)

def get_row_action_keyboard(row_number: int) -> InlineKeyboardMarkup:
    keyboard = [
        [InlineKeyboardButton("✏️ Редактировать", callback_data=f"edit_row:{row_number}")],
        [InlineKeyboardButton("🗑 Удалить", callback_data=f"delete_row:{row_number}")],
        [InlineKeyboardButton("🔙 Назад", callback_data="back_to_list")],
        [InlineKeyboardButton("🏠 В начало", callback_data="home")]
    ]
    return InlineKeyboardMarkup(keyboard)

def get_edit_keyboard(row_number: int) -> InlineKeyboardMarkup:
    keyboard = [
        [InlineKeyboardButton("🔙 Назад", callback_data=f"select_row:{row_number}")],
        [InlineKeyboardButton("🏠 В начало", callback_data="home")]
    ]
    return InlineKeyboardMarkup(keyboard)
