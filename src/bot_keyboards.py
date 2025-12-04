"""
Модуль для создания клавиатур Telegram бота.
Содержит функции для генерации Reply и Inline клавиатур.
"""
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup, KeyboardButton
from telegram.constants import ParseMode

def get_main_keyboard() -> ReplyKeyboardMarkup:
    """
    Создает главную клавиатуру с основными действиями.
    
    Returns:
        ReplyKeyboardMarkup: Клавиатура с кнопкой "Посмотреть последние записи"
    """
    keyboard = [
        [KeyboardButton("Посмотреть последние записи")]
    ]
    return ReplyKeyboardMarkup(keyboard, resize_keyboard=True)

def get_last_rows_keyboard(rows_data: list) -> InlineKeyboardMarkup:
    """
    Создает inline-клавиатуру со списком последних записей.
    
    Args:
        rows_data: Список словарей с данными записей
        
    Returns:
        InlineKeyboardMarkup: Клавиатура с кнопками для выбора записи
    """
    keyboard = []
    for i, entry in enumerate(rows_data, 1):
        row_num = entry['row_number']
        
        btn_text = f"Запись {i}"
        callback_data = f"select_row:{row_num}"
        
        keyboard.append([InlineKeyboardButton(btn_text, callback_data=callback_data)])
    
    keyboard.append([InlineKeyboardButton("🏠 В начало", callback_data="home")])
    return InlineKeyboardMarkup(keyboard)

def get_row_action_keyboard(row_number: int) -> InlineKeyboardMarkup:
    """
    Создает клавиатуру действий для выбранной записи.
    
    Args:
        row_number: Номер строки в таблице
        
    Returns:
        InlineKeyboardMarkup: Кнопки Редактировать, Удалить, Назад, Домой
    """
    keyboard = [
        [InlineKeyboardButton("✏️ Редактировать", callback_data=f"edit_row:{row_number}")],
        [InlineKeyboardButton("🗑 Удалить", callback_data=f"delete_row:{row_number}")],
        [InlineKeyboardButton("🔙 Назад", callback_data="back_to_list")],
        [InlineKeyboardButton("🏠 В начало", callback_data="home")]
    ]
    return InlineKeyboardMarkup(keyboard)

def get_edit_keyboard(row_number: int) -> InlineKeyboardMarkup:
    """
    Создает клавиатуру для режима редактирования.
    
    Args:
        row_number: Номер строки (для возврата назад)
        
    Returns:
        InlineKeyboardMarkup: Кнопки Назад, Домой
    """
    keyboard = [
        [InlineKeyboardButton("🔙 Назад", callback_data=f"select_row:{row_number}")],
        [InlineKeyboardButton("🏠 В начало", callback_data="home")]
    ]
    return InlineKeyboardMarkup(keyboard)

