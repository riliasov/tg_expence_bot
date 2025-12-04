"""
Модуль парсинга текста расходов.
Отвечает за извлечение суммы, валюты, источника и описания из свободного текста.
"""
import re
from dataclasses import dataclass
from typing import Optional

@dataclass
class ParsedExpense:
    """Структура данных разобранного расхода."""
    amount: int
    currency: str
    source: str
    description: str
    raw_text: str

class ParseError(Exception):
    """Ошибка парсинга текста."""
    pass

class ExpenseParser:
    """
    Парсер для извлечения данных о расходах из текстовых сообщений.
    Поддерживает различные форматы ввода, валюты и источники оплаты.
    """
    
    # Словарь валют: ключевое слово -> код валюты
    CURRENCY_KEYWORDS = {
        # RUB
        'rub': 'RUB', 'руб': 'RUB', 'р': 'RUB', 'рубль': 'RUB', 'рублей': 'RUB',
        # USD
        'usd': 'USD', 'доллар': 'USD', 'dollar': 'USD',
        # EUR
        'eur': 'EUR', 'евро': 'EUR', 'euro': 'EUR',
        # KZT
        'kzt': 'KZT', 'тенге': 'KZT', 'tenge': 'KZT',
        # CLP
        'clp': 'CLP', 'песо': 'CLP', 'peso': 'CLP',
        # USDT
        'usdt': 'USDT',
        # THB
        'thb': 'THB', 'бат': 'THB', 'bat': 'THB',
    }
    
    # Словарь источников: ключевое слово -> название источника
    SOURCE_KEYWORDS = {
        # Cash
        'нал': 'Cash', 'наличн': 'Cash', 'наличные': 'Cash', 'наличка': 'Cash',
        'cash': 'Cash', 'кэш': 'Cash', 'кеш': 'Cash',
        # TBank
        'тбанк': 'TBank', 'tbank': 'TBank', 'т-банк': 'TBank', 't-bank': 'TBank',
        'тинькофф': 'TBank', 'tinkoff': 'TBank', 'тиньк': 'TBank',
        # Ozon
        'ozon': 'Ozon', 'озон': 'Ozon',
        # Sber
        'sber': 'Sber', 'сбер': 'Sber', 'сберbank': 'Sber', 'sberbank': 'Sber',
        # Yandex
        'yandex': 'Yandex', 'яндекс': 'Yandex',
        # Alfa
        'alfa': 'Alfa', 'альфа': 'Alfa', 'альфабанк': 'Alfa', 'alfabank': 'Alfa',
        # BCC
        'iron': 'BCC', 'бcc': 'BCC', 'bcc': 'BCC',
        # Travel
        'travel': 'Travel',
    }
    
    # Регулярное выражение для поиска суммы (поддерживает разделители и валютные символы)
    AMOUNT_PATTERN = re.compile(r'[₽$₸]?[-]?\d+(?:[\s.,]\d+)*[₽$₸]?')
    
    @classmethod
    def parse(cls, raw_input: str) -> ParsedExpense:
        """
        Парсит входную строку и возвращает объект ParsedExpense.
        
        Args:
            raw_input: Исходный текст сообщения
            
        Returns:
            ParsedExpense: Объект с разобранными данными
            
        Raises:
            ParseError: Если не удалось извлечь сумму или описание
        """
        text = raw_input.strip()
        if not text:
            raise ParseError("Ошибка: укажите сумму")
        
        text_lower = text.lower()
        tokens = text.split()
        
        # 1. Определяем валюту
        currency = cls._find_currency(text_lower, tokens)
        
        # 2. Ищем все возможные суммы в тексте
        candidates = cls._find_amount_candidates(text)
        if not candidates:
            raise ParseError("Ошибка: укажите сумму")
        
        # 3. Выбираем наиболее вероятную сумму (на основе близость к валюте)
        amount, amount_str, amount_start, amount_end = cls._pick_best_amount(
            candidates, text, currency, tokens
        )
        
        # 4. Определяем источник оплаты
        source = cls._find_source(text_lower, tokens)
        
        # 5. Извлекаем описание (все, что не является суммой, валютой или источником)
        description = cls._extract_description(
            text, amount_str, currency, source, tokens
        )
        
        if not description.strip():
            raise ParseError("Ошибка: укажите описание")
        
        return ParsedExpense(
            amount=amount,
            currency=currency,
            source=source,
            description=description.strip(),
            raw_text=text
        )
    
    @classmethod
    def _find_amount_candidates(cls, text: str) -> list:
        """Находит все подстроки, похожие на сумму."""
        matches = list(cls.AMOUNT_PATTERN.finditer(text))
        candidates = []
        
        for match in matches:
            match_str = match.group(0)
            # Очистка от валютных символов
            cleaned = re.sub(r'[₽$₸-]', '', match_str).strip()
            
            # Удаляем десятичную часть (копейки/центы), если она есть
            cleaned = re.sub(r'[.,]\d{1,2}$', '', cleaned)
            
            # Удаляем все остальные разделители
            cleaned = re.sub(r'[\s.,]', '', cleaned)
            
            if cleaned.isdigit():
                amt = int(cleaned)
                if amt > 0:
                    candidates.append((amt, match_str, match.start(), match.end()))
        
        return candidates
    
    @classmethod
    def _find_currency(cls, text_lower: str, tokens: list) -> str:
        """Определяет валюту по ключевым словам."""
        for token in tokens:
            token_clean = token.lower().strip('.,!?;:-—–)')
            if token_clean in cls.CURRENCY_KEYWORDS:
                return cls.CURRENCY_KEYWORDS[token_clean]
        return 'RUB'
    
    @classmethod
    def _find_source(cls, text_lower: str, tokens: list) -> str:
        """Определяет источник оплаты по ключевым словам."""
        for token in tokens:
            token_clean = token.lower().strip('.,!?;:-—–)')
            if token_clean in cls.SOURCE_KEYWORDS:
                return cls.SOURCE_KEYWORDS[token_clean]
            # Проверка частичного совпадения (например, "sberbank")
            for keyword, source in cls.SOURCE_KEYWORDS.items():
                if token_clean.startswith(keyword):
                    return source
        return 'Cash'
    
    @classmethod
    def _pick_best_amount(cls, candidates: list, text: str, currency: str, tokens: list) -> tuple:
        """Выбирает лучшего кандидата на сумму, основываясь на позиции валюты."""
        if len(candidates) == 1:
            return candidates[0]
        
        # Ищем позицию токена валюты
        curr_token = None
        for token in tokens:
            if token.lower().strip('.,!?;:-—–)') in cls.CURRENCY_KEYWORDS:
                curr_token = token
                break
        
        if curr_token:
            curr_start = text.find(curr_token)
            if curr_start != -1:
                curr_end = curr_start + len(curr_token)
                
                # Предпочитаем сумму слева от валюты ("100 руб")
                left_candidates = [c for c in candidates if c[3] <= curr_start]
                if left_candidates:
                    return max(left_candidates, key=lambda c: c[3])
                
                # Иначе берем сумму справа ("usd 100")
                right_candidates = [c for c in candidates if c[2] >= curr_end]
                if right_candidates:
                    return min(right_candidates, key=lambda c: c[2])
        
        # По умолчанию берем первую найденную сумму
        return candidates[0]
    
    @classmethod
    def _extract_description(cls, text: str, amount_str: str, currency: str, source: str, tokens: list) -> str:
        """Формирует описание, удаляя из текста сумму, валюту и источник."""
        desc = text.replace(amount_str, '')
        
        # Удаляем токен валюты
        for token in tokens:
            token_clean = token.lower().strip('.,!?;:-—–)')
            if token_clean in cls.CURRENCY_KEYWORDS:
                desc = desc.replace(token, '')
                break
        
        # Удаляем токен источника
        for token in tokens:
            token_clean = token.lower().strip('.,!?;:-—–)')
            if token_clean in cls.SOURCE_KEYWORDS or any(token_clean.startswith(kw) for kw in cls.SOURCE_KEYWORDS):
                desc = desc.replace(token, '')
                break
        
        return ' '.join(desc.split()).strip()
