import re
from dataclasses import dataclass
from typing import Optional

@dataclass
class ParsedExpense:
    amount: int
    currency: str
    source: str
    description: str

class ExpenseParser:
    CURRENCIES = {
        'rub': 'RUB', 'руб': 'RUB',
        'usd': 'USD', 'dollar': 'USD',
        'eur': 'EUR', 'euro': 'EUR',
        'kzt': 'KZT', 'tenge': 'KZT',
        'clp': 'CLP',
        'usdt': 'USDT'
    }

    SOURCES = {
        'нал': 'Cash', 'налич': 'Cash', 'cash': 'Cash',
        'тбанк': 'T-Bank', 'tbank': 'T-Bank', 'tinkoff': 'T-Bank',
        'kzcard': 'KZ Card', 'карта': 'Card'
    }

    def parse(self, text: str) -> ParsedExpense:
        # Normalize text
        text = text.strip()
        parts = text.split()
        
        amount = None
        currency = 'RUB'
        source = 'Cash'
        desc_parts = []
        
        # Regex to find numbers that look like amounts (e.g. 100, 1000, 1 200, 1.200)
        # We look for a token that consists of digits, optionally separated by dot, comma or space
        
        processed_indices = set()

        # Strategy: Iterate through parts to find specific entities
        
        # 1. Find Amount
        for i, part in enumerate(parts):
            if i in processed_indices:
                continue
            
            # Clean part to check if it's a number
            clean_part = re.sub(r'[^\d]', '', part)
            if not clean_part:
                continue
                
            # Check if original part resembles a number (allows 100, 100.5, 1,200)
            # We reject parts that are clearly mixed like "item1"
            if re.match(r'^[\d\s.,]+$', part):
                # Try to parse
                try:
                    # Remove spaces and replace comma with dot for float conversion
                    normalized_num = part.replace(' ', '').replace(',', '.')
                    val = float(normalized_num)
                    amount = int(val) # Integer required
                    processed_indices.add(i)
                    break # Stop after finding first number
                except ValueError:
                    continue

        if amount is None:
            raise ValueError("Ошибка: укажите сумму")

        # 2. Find Currency and Source
        for i, part in enumerate(parts):
            if i in processed_indices:
                continue
            
            clean_lower = part.lower().strip('.,')
            
            if clean_lower in self.CURRENCIES:
                currency = self.CURRENCIES[clean_lower]
                processed_indices.add(i)
                continue
                
            if clean_lower in self.SOURCES:
                source = self.SOURCES[clean_lower]
                processed_indices.add(i)
                continue
            
            # Remove symbols like ₽, $, ₸
            if clean_lower in ['₽', '$', '€', '₸']:
                processed_indices.add(i)
                continue

        # 3. Description is everything else
        for i, part in enumerate(parts):
            if i not in processed_indices:
                desc_parts.append(part)

        description = " ".join(desc_parts).strip()
        if not description:
            description = "Expense"

        return ParsedExpense(
            amount=amount,
            currency=currency,
            source=source,
            description=description
        )
