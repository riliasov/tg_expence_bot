"""
Тесты для парсера расходов (ExpenseParser).
Проверяет корректность парсинга различных форматов ввода.
"""
import pytest
from src.parser_core import ExpenseParser, ParseError, ParsedExpense


class TestExpenseParser:
    """Тесты для ExpenseParser"""
    
    def test_simple_expense_rub(self):
        """Тест простого расхода в рублях"""
        result = ExpenseParser.parse("кофе 250")
        assert result.amount == 250
        assert result.currency == "RUB"
        assert result.description == "кофе"
        assert result.source == "Cash"
    
    def test_expense_with_source(self):
        """Тест расхода с указанием источника"""
        result = ExpenseParser.parse("такси 500 тбанк")
        assert result.amount == 500
        assert result.currency == "RUB"
        assert result.description == "такси"
        assert result.source == "TBank"
    
    def test_expense_with_currency_usd(self):
        """Тест расхода в долларах"""
        result = ExpenseParser.parse("подарок 30 usd")
        assert result.amount == 30
        assert result.currency == "USD"
        assert result.description == "подарок"
    
    def test_expense_reverse_order(self):
        """Тест парсинга в обратном порядке (источник в начале)"""
        result = ExpenseParser.parse("тбанк 1000 продукты")
        assert result.amount == 1000
        assert result.source == "TBank"
        assert result.description == "продукты"
    
    def test_expense_with_spaces_in_amount(self):
        """Тест суммы с пробелами (1 500)"""
        result = ExpenseParser.parse("хлеб 1 500")
        assert result.amount == 1500
        assert result.description == "хлеб"
    
    def test_expense_with_decimal(self):
        """Тест суммы с десятичной частью (отбрасывается)"""
        result = ExpenseParser.parse("кофе 250.50")
        assert result.amount == 250
        assert result.description == "кофе"
    
    def test_expense_with_comma_decimal(self):
        """Тест суммы с запятой в дробной части"""
        result = ExpenseParser.parse("обед 500,75")
        assert result.amount == 500
        assert result.description == "обед"
    
    def test_multiple_currencies(self):
        """Тест различных валют"""
        test_cases = [
            ("100 евро еда", "EUR"),
            ("500 тенге такси", "KZT"),
            ("50 usdt перевод", "USDT"),
        ]
        for text, expected_currency in test_cases:
            result = ExpenseParser.parse(text)
            assert result.currency == expected_currency
    
    def test_multiple_sources(self):
        """Тест различных источников оплаты"""
        test_cases = [
            ("кофе 100 нал", "Cash"),
            ("обед 200 сбер", "Sber"),
            ("доставка 300 озон", "Ozon"),
            ("подписка 400 альфа", "Alfa"),
        ]
        for text, expected_source in test_cases:
            result = ExpenseParser.parse(text)
            assert result.source == expected_source
    
    def test_empty_input(self):
        """Тест пустого ввода - должна вызваться ошибка"""
        with pytest.raises(ParseError, match="укажите сумму"):
            ExpenseParser.parse("")
    
    def test_no_amount(self):
        """Тест ввода без суммы"""
        with pytest.raises(ParseError, match="укажите сумму"):
            ExpenseParser.parse("просто текст без цифр")
    
    def test_no_description(self):
        """Тест ввода без описания"""
        with pytest.raises(ParseError, match="укажите описание"):
            ExpenseParser.parse("500")
    
    def test_amount_with_symbols(self):
        """Тест суммы с валютными символами"""
        test_cases = [
            ("₽500 еда", 500, "RUB"),
            ("$30 кино", 30, "RUB"),  # Символ игнорируется, если нет текста "usd"
        ]
        for text, expected_amount, expected_currency in test_cases:
            result = ExpenseParser.parse(text)
            assert result.amount == expected_amount
    
    def test_negative_amount(self):
        """Тест отрицательной суммы (минус должен игнорироваться)"""
        result = ExpenseParser.parse("-500 возврат")
        assert result.amount == 500
        assert result.description == "возврат"
    
    def test_complex_description(self):
        """Тест сложного описания с несколькими словами"""
        result = ExpenseParser.parse("покупка продуктов в магазине 1500 тбанк")
        assert result.amount == 1500
        assert result.source == "TBank"
        assert "продуктов" in result.description
        assert "магазине" in result.description
    
    def test_raw_text_preserved(self):
        """Тест сохранения исходного текста"""
        original_text = "кофе 250 нал"
        result = ExpenseParser.parse(original_text)
        assert result.raw_text == original_text
