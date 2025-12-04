"""
Клиент для работы с Google Sheets API.
Обеспечивает запись, чтение, обновление и удаление расходов в таблице.
"""
import json
import gspread
from google.oauth2.service_account import Credentials
from datetime import datetime
from src.config import settings
from src.parser_core import ParsedExpense
from src.logger import setup_logger, log_expense_action

# Области доступа для Google Sheets API
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
]

# Настройка логгера для этого модуля
logger = setup_logger(__name__)


class GoogleSheetsClient:
    """
    Клиент для взаимодействия с Google Sheets.
    
    Поддерживает операции:
    - Добавление новой записи расхода
    - Получение последних N записей
    - Обновление существующей записи
    - Удаление записи
    """
    
    def __init__(self):
        """Инициализирует клиент с авторизацией через Service Account."""
        try:
            creds_dict = json.loads(settings.google_credentials_json)
            creds = Credentials.from_service_account_info(creds_dict, scopes=SCOPES)
            self.client = gspread.authorize(creds)
            self.sheet_id = settings.spreadsheet_id
            self._sheet = None
            logger.info("Google Sheets клиент успешно инициализирован")
        except Exception as e:
            logger.error(f"Ошибка инициализации Google Sheets клиента: {e}", exc_info=True)
            raise
    
    @property
    def sheet(self):
        """
        Ленивая загрузка листа таблицы.
        Подключается к таблице только при первом обращении.
        """
        if self._sheet is None:
            try:
                self._sheet = self.client.open_by_key(self.sheet_id).sheet1
                logger.info(f"Подключение к Google Sheet: {self.sheet_id}")
            except Exception as e:
                logger.error(f"Не удалось открыть таблицу {self.sheet_id}: {e}", exc_info=True)
                raise
        return self._sheet
    
    def append_row(self, expense: ParsedExpense, timestamp: datetime = None):
        """
        Добавляет новую запись расхода в конец таблицы.
        
        Args:
            expense: Объект ParsedExpense с данными расхода
            timestamp: Время записи (если None, используется текущее время)
        
        Формат строки в таблице:
        [Date, Amount, Currency, FX, RUB, Category, SubCategory, Description, Account]
        """
        try:
            if timestamp is None:
                timestamp = datetime.now()
            
            # Форматируем дату как DD.MM.YYYY HH:MM
            date_str = timestamp.strftime("%d.%m.%Y %H:%M")
            
            # Рассчитываем курс и рублевый эквивалент только для RUB
            if expense.currency == 'RUB':
                fx = 1.0
                rub_val = expense.amount
            else:
                fx = ""
                rub_val = ""
            
            # Формируем строку данных для записи
            row_data = [
                date_str,              # A: Дата и время
                expense.amount,        # B: Сумма
                expense.currency,      # C: Валюта
                fx,                    # D: Курс обмена
                rub_val,               # E: Сумма в рублях
                '',                    # F: Категория (заполняется вручную)
                '',                    # G: Подкатегория (заполняется вручную)
                expense.raw_text,      # H: Исходный текст
                expense.source         # I: Источник оплаты
            ]
            
            self.sheet.append_row(row_data, value_input_option='USER_ENTERED')
            
            log_expense_action(
                logger,
                action='add',
                expense_data={
                    'amount': expense.amount,
                    'currency': expense.currency,
                    'source': expense.source
                }
            )
        except Exception as e:
            log_expense_action(logger, action='add', error=e)
            raise
    
    def get_last_rows(self, n: int = 4) -> list:
        """
        Получает последние N записей из таблицы.
        
        Args:
            n: Количество записей для получения (по умолчанию 4)
        
        Returns:
            Список словарей с данными записей, отсортированный от новых к старым
        """
        try:
            all_values = self.sheet.get_all_values()
            total_rows = len(all_values)
            
            # Если только заголовок или таблица пустая
            if total_rows <= 1:
                logger.info("Таблица пуста, нет записей для отображения")
                return []
            
            # Вычисляем индекс начальной строки (с учетом заголовка)
            start_index = max(2, total_rows - n + 1)
            data = []
            
            for i in range(start_index - 1, total_rows):
                row_content = all_values[i]
                
                # Дополняем строку пустыми значениями, если колонок меньше 9
                while len(row_content) < 9:
                    row_content.append("")
                
                entry = {
                    "row_number": i + 1,
                    "date": row_content[0],           # Дата в формате DD.MM.YYYY HH:MM
                    "amount": row_content[1],
                    "currency": row_content[2],
                    "description": row_content[7],    # Исходный текст
                    "source": row_content[8]
                }
                data.append(entry)
            
            logger.info(f"Получено {len(data)} записей из таблицы")
            # Возвращаем в обратном порядке (новые записи сверху)
            return list(reversed(data))
            
        except Exception as e:
            logger.error(f"Ошибка при получении записей: {e}", exc_info=True)
            raise
    
    def update_row(self, row_number: int, expense: ParsedExpense):
        """
        Обновляет существующую запись в таблице.
        
        Args:
            row_number: Номер строки для обновления (1-indexed)
            expense: Новые данные расхода
        
        Note:
            Не обновляет дату записи, только данные расхода (колонки B-I)
        """
        try:
            if expense.currency == 'RUB':
                fx = 1.0
                rub_val = expense.amount
            else:
                fx = ""
                rub_val = ""
            
            # Обновляем только колонки B-I (Amount до Account)
            updates = [
                expense.amount,        # B: Сумма
                expense.currency,      # C: Валюта
                fx,                    # D: Курс
                rub_val,               # E: RUB эквивалент
                '',                    # F: Категория
                '',                    # G: Подкатегория
                expense.raw_text,      # H: Исходный текст
                expense.source         # I: Источник
            ]
            
            range_name = f"B{row_number}:I{row_number}"
            self.sheet.update(range_name=range_name, values=[updates], value_input_option='USER_ENTERED')
            
            log_expense_action(
                logger,
                action='update',
                expense_data={
                    'row': row_number,
                    'amount': expense.amount,
                    'currency': expense.currency,
                    'source': expense.source
                }
            )
        except Exception as e:
            log_expense_action(logger, action='update', error=e)
            raise

    def delete_row(self, row_number: int):
        """
        Удаляет запись из таблицы.
        
        Args:
            row_number: Номер строки для удаления (1-indexed)
        """
        try:
            self.sheet.delete_rows(row_number)
            logger.info(f"Строка {row_number} удалена из таблицы")
        except Exception as e:
            logger.error(f"Ошибка при удалении строки {row_number}: {e}", exc_info=True)
            raise


# Глобальный singleton экземпляр клиента
_sheets_client = None


def get_sheets_client() -> GoogleSheetsClient:
    """
    Возвращает singleton экземпляр Google Sheets клиента.
    Создает новый экземпляр при первом вызове.
    
    Returns:
        Экземпляр GoogleSheetsClient
    """
    global _sheets_client
    if _sheets_client is None:
        _sheets_client = GoogleSheetsClient()
    return _sheets_client