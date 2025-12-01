from telegram import InlineKeyboardButton, InlineKeyboardMarkup

def get_edit_keyboard(rows_data):
    keyboard = []
    for entry in rows_data:
        # We use the row number in callback data
        row_num = entry['row_number']
        desc = entry['description'][:15]
        amt = entry['amount']
        
        btn_text = f"Изменить: {amt} ({desc}...)"
        callback_data = f"edit_request:{row_num}"
        
        keyboard.append([InlineKeyboardButton(btn_text, callback_data=callback_data)])
    
    return InlineKeyboardMarkup(keyboard)
