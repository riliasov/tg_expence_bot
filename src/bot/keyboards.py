from telegram import InlineKeyboardButton, InlineKeyboardMarkup

def get_edit_keyboard(rows_data: list) -> InlineKeyboardMarkup:
    keyboard = []
    for i, entry in enumerate(rows_data, 1):
        row_num = entry['row_number']
        desc = entry['description'][:15] if entry['description'] else 'Запись'
        amt = entry['amount']
        
        btn_text = f"Изменить {i}: {amt} ({desc}...)"
        callback_data = f"edit_request:{row_num}"
        
        keyboard.append([InlineKeyboardButton(btn_text, callback_data=callback_data)])
    
    return InlineKeyboardMarkup(keyboard)
