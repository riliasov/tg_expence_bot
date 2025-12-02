import re
from dataclasses import dataclass
from typing import Optional

@dataclass
class ParsedExpense:
    amount: int
    currency: str
    source: str
    description: str
    raw_text: str

class ParseError(Exception):
    pass

class ExpenseParser:
    CURRENCY_KEYWORDS = {
        'rub': 'RUB',
        'руб': 'RUB',
        'р': 'RUB',
        'рубль': 'RUB',
        'рублей': 'RUB',
        'usd': 'USD',
        'доллар': 'USD',
        'dollar': 'USD',
        'eur': 'EUR',
        'евро': 'EUR',
        'euro': 'EUR',
        'kzt': 'KZT',
        'тенге': 'KZT',
        'tenge': 'KZT',
        'clp': 'CLP',
        'песо': 'CLP',
        'peso': 'CLP',
        'usdt': 'USDT',
        'thb': 'THB',
        'бат': 'THB',
        'bat': 'THB',
    }
    
    SOURCE_KEYWORDS = {
        'нал': 'Cash',
        'наличн': 'Cash',
        'наличные': 'Cash',
        'наличка': 'Cash',
        'cash': 'Cash',
        'кэш': 'Cash',
        'кеш': 'Cash',
        'тбанк': 'TBank',
        'tbank': 'TBank',
        'т-банк': 'TBank',
        't-bank': 'TBank',
        'тинькофф': 'TBank',
        'tinkoff': 'TBank',
        'тиньк': 'TBank',
        'ozon': 'Ozon',
        'озон': 'Ozon',
        'sber': 'Sber',
        'сбер': 'Sber',
        'сберbank': 'Sber',
        'sberbank': 'Sber',
        'yandex': 'Yandex',
        'яндекс': 'Yandex',
        'alfa': 'Alfa',
        'альфа': 'Alfa',
        'альфабанк': 'Alfa',
        'alfabank': 'Alfa',
        'iron': 'BCC',
        'бcc': 'BCC',
        'bcc': 'BCC',
        'travel': 'Travel',
    }
    
    AMOUNT_PATTERN = re.compile(r'[₽$₸]?[-]?\d+(?:[\s.,]\d+)*[₽$₸]?')
    
    @classmethod
    def parse(cls, raw_input: str) -> ParsedExpense:
        text = raw_input.strip()
        if not text:
            raise ParseError("Ошибка: укажите сумму")
        
        text_lower = text.lower()
        tokens = text.split()
        
        # Find currency
        currency = cls._find_currency(text_lower, tokens)
        
        # Find all amount candidates
        candidates = cls._find_amount_candidates(text)
        if not candidates:
            raise ParseError("Ошибка: укажите сумму")
        
        # Pick best amount based on currency proximity
        amount, amount_str, amount_start, amount_end = cls._pick_best_amount(
            candidates, text, currency, tokens
        )
        
        # Find source
        source = cls._find_source(text_lower, tokens)
        
        # Extract description
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
        matches = list(cls.AMOUNT_PATTERN.finditer(text))
        candidates = []
        
        for match in matches:
            match_str = match.group(0)
            cleaned = re.sub(r'[₽$₸-]', '', match_str).strip()
            
            # Remove decimal part (last 1-2 digits after separator)
            cleaned = re.sub(r'[.,]\d{1,2}$', '', cleaned)
            
            # Remove all remaining separators
            cleaned = re.sub(r'[\s.,]', '', cleaned)
            
            if cleaned.isdigit():
                amt = int(cleaned)
                if amt > 0:
                    candidates.append((amt, match_str, match.start(), match.end()))
        
        return candidates
    
    @classmethod
    def _find_currency(cls, text_lower: str, tokens: list) -> str:
        for token in tokens:
            token_clean = token.lower().strip('.,!?;:-—–)')
            if token_clean in cls.CURRENCY_KEYWORDS:
                return cls.CURRENCY_KEYWORDS[token_clean]
        return 'RUB'
    
    @classmethod
    def _find_source(cls, text_lower: str, tokens: list) -> str:
        for token in tokens:
            token_clean = token.lower().strip('.,!?;:-—–)')
            if token_clean in cls.SOURCE_KEYWORDS:
                return cls.SOURCE_KEYWORDS[token_clean]
            for keyword, source in cls.SOURCE_KEYWORDS.items():
                if token_clean.startswith(keyword):
                    return source
        return 'Cash'
    
    @classmethod
    def _pick_best_amount(cls, candidates: list, text: str, currency: str, tokens: list) -> tuple:
        if len(candidates) == 1:
            return candidates[0]
        
        # Find currency token position
        curr_token = None
        for token in tokens:
            if token.lower().strip('.,!?;:-—–)') in cls.CURRENCY_KEYWORDS:
                curr_token = token
                break
        
        if curr_token:
            curr_start = text.find(curr_token)
            if curr_start != -1:
                curr_end = curr_start + len(curr_token)
                
                # Prefer amount to the left of currency
                left_candidates = [c for c in candidates if c[3] <= curr_start]
                if left_candidates:
                    return max(left_candidates, key=lambda c: c[3])
                
                # Otherwise take amount to the right
                right_candidates = [c for c in candidates if c[2] >= curr_end]
                if right_candidates:
                    return min(right_candidates, key=lambda c: c[2])
        
        # Default: first candidate
        return candidates[0]
    
    @classmethod
    def _extract_description(cls, text: str, amount_str: str, currency: str, source: str, tokens: list) -> str:
        desc = text.replace(amount_str, '')
        
        # Remove currency token
        for token in tokens:
            token_clean = token.lower().strip('.,!?;:-—–)')
            if token_clean in cls.CURRENCY_KEYWORDS:
                desc = desc.replace(token, '')
                break
        
        # Remove source token
        for token in tokens:
            token_clean = token.lower().strip('.,!?;:-—–)')
            if token_clean in cls.SOURCE_KEYWORDS or any(token_clean.startswith(kw) for kw in cls.SOURCE_KEYWORDS):
                desc = desc.replace(token, '')
                break
        
        return ' '.join(desc.split()).strip()
