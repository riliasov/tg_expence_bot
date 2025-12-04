"""
Централизованная система логирования для бота.
Поддерживает structured logging для Cloud Run и консольный вывод для разработки.
"""
import logging
import sys
from typing import Optional

def setup_logger(name: str, level: str = "INFO") -> logging.Logger:
    """
    Настраивает логгер с унифицированным форматом.
    
    Args:
        name: Имя логгера (обычно __name__ модуля)
        level: Уровень логирования (DEBUG, INFO, WARNING, ERROR, CRITICAL)
    
    Returns:
        Настроенный логгер
    """
    logger = logging.getLogger(name)
    logger.setLevel(getattr(logging, level.upper()))
    
    # Если обработчики уже есть, не добавляем дубликаты
    if logger.handlers:
        return logger
    
    # Создаем обработчик для вывода в консоль/stdout
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(getattr(logging, level.upper()))
    
    # Формат: [2024-12-04 03:28:51] [INFO] [module_name] Message
    formatter = logging.Formatter(
        fmt='[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    handler.setFormatter(formatter)
    
    logger.addHandler(handler)
    return logger


def log_expense_action(
    logger: logging.Logger,
    action: str,
    expense_data: Optional[dict] = None,
    error: Optional[Exception] = None
):
    """
    Специализированная функция для логирования действий с расходами.
    
    Args:
        logger: Логгер для записи
        action: Тип действия (add, edit, delete, list)
        expense_data: Данные о расходе (без чувствительной информации)
        error: Ошибка, если произошла
    """
    if error:
        logger.error(f"Action '{action}' failed: {error}", exc_info=True)
    else:
        log_msg = f"Action '{action}' executed"
        if expense_data:
            # Логируем только базовую информацию
            safe_data = {
                'amount': expense_data.get('amount'),
                'currency': expense_data.get('currency'),
                'source': expense_data.get('source')
            }
            log_msg += f" | Data: {safe_data}"
        logger.info(log_msg)
