import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpense, ParseError } from '../src/parser.js';

const parse = (text) => parseExpense(text);

test('простой расход в рублях по умолчанию', () => {
  const r = parse('кофе 250');
  assert.equal(r.amount, -250);
  assert.equal(r.currency, 'RUB');
  assert.equal(r.description, 'кофе');
  assert.equal(r.source, 'Cash');
});

test('источник в конце и в начале', () => {
  assert.deepEqual(
    [parse('такси 500 тбанк').source, parse('такси 500 тбанк').description],
    ['TBank', 'такси'],
  );
  const r = parse('тбанк 1000 продукты');
  assert.equal(r.amount, -1000);
  assert.equal(r.source, 'TBank');
  assert.equal(r.description, 'продукты');
});

test('валюта USD после суммы', () => {
  const r = parse('подарок 30 usd');
  assert.equal(r.amount, -30);
  assert.equal(r.currency, 'USD');
  assert.equal(r.description, 'подарок');
});

test('сумма с пробелом как разделителем тысяч', () => {
  const r = parse('хлеб 1 500');
  assert.equal(r.amount, -1500);
  assert.equal(r.description, 'хлеб');
});

test('десятичная сумма с точкой сохраняется', () => {
  const r = parse('кофе 250.50');
  assert.equal(r.amount, -250.5);
  assert.equal(r.description, 'кофе');
});

test('десятичная сумма с запятой сохраняется', () => {
  const r = parse('обед 500,75');
  assert.equal(r.amount, -500.75);
  assert.equal(r.description, 'обед');
});

test('точка и запятая как разделители тысяч', () => {
  assert.equal(parse('еда 1.500').amount, -1500);
  assert.equal(parse('еда 1,500.50').amount, -1500.5);
  assert.equal(parse('еда 12.5 eur').amount, -12.5);
});

test('VND: слова и символ', () => {
  const r = parse('кофе 50000 vnd');
  assert.equal(r.amount, -50000);
  assert.equal(r.currency, 'VND');
  assert.equal(r.description, 'кофе');

  assert.equal(parse('банан 20000 донг').currency, 'VND');
  assert.equal(parse('банан 20000 dong').currency, 'VND');
  assert.equal(parse('кофе 30000₫').currency, 'VND');
  assert.equal(parse('кофе 30000₫').description, 'кофе');
});

test('валюта, слитная с суммой', () => {
  const r = parse('кофе 50000vnd');
  assert.equal(r.amount, -50000);
  assert.equal(r.currency, 'VND');
  assert.equal(r.description, 'кофе');
});

test('все поддерживаемые валюты', () => {
  const cases = [
    ['100 евро еда', 'EUR'],
    ['500 тенге такси', 'KZT'],
    ['50 usdt перевод', 'USDT'],
    ['50 clp покупка', 'CLP'],
    ['50 thb массаж', 'THB'],
  ];
  for (const [text, currency] of cases) {
    assert.equal(parse(text).currency, currency, text);
  }
});

test('все поддерживаемые источники', () => {
  const cases = [
    ['кофе 100 нал', 'Cash'],
    ['обед 200 сбер', 'Sber'],
    ['доставка 300 озон', 'Ozon'],
    ['подписка 400 альфа', 'Alfa'],
    ['билет 500 яндекс', 'Yandex'],
  ];
  for (const [text, source] of cases) {
    assert.equal(parse(text).source, source, text);
  }
});

test('пустой ввод и ввод без суммы', () => {
  assert.throws(() => parse(''), (e) => e instanceof ParseError && /укажите сумму/.test(e.message));
  assert.throws(() => parse('просто текст без цифр'), (e) => e instanceof ParseError && /укажите сумму/.test(e.message));
});

test('ввод без описания', () => {
  assert.throws(() => parse('500'), (e) => e instanceof ParseError && /укажите описание/.test(e.message));
  assert.throws(() => parse('500 usd'), (e) => e instanceof ParseError && /укажите описание/.test(e.message));
});

test('символы валют не мешают сумме', () => {
  assert.equal(parse('₽500 еда').amount, -500);
  assert.equal(parse('$30 кино').amount, -30);
});

test('расходы всегда отрицательные, даже если пользователь ввёл сумму с плюсом', () => {
  const r = parse('-500 возврат');
  assert.equal(r.amount, -500);
  assert.equal(r.description, 'возврат');
});

test('сложное описание с несколькими словами', () => {
  const r = parse('покупка продуктов в магазине 1500 тбанк');
  assert.equal(r.amount, -1500);
  assert.equal(r.source, 'TBank');
  assert.equal(r.description, 'покупка продуктов в магазине');
});

test('регрессия: валюта "р" не режет буквы в описании', () => {
  const r = parse('продукты 500 р');
  assert.equal(r.currency, 'RUB');
  assert.equal(r.description, 'продукты');
});

test('выбор суммы рядом с валютой при нескольких числах', () => {
  assert.equal(parse('кофе 100 и 500 руб').amount, -500);
  assert.equal(parse('кофе 100 и 500руб').amount, -500);
  assert.equal(parse('кофе usd 30 и 40').amount, -30);
});

test('пробел между тремя цифрами — разделитель тысяч (как в исходной версии)', () => {
  // "100 500" читается как 100500; для двух сумм используйте другой разделитель.
  assert.equal(parse('кофе 100 500 руб').amount, -100500);
});

test('raw_text сохраняется как есть', () => {
  assert.equal(parse('кофе 250 нал').raw_text, 'кофе 250 нал');
});
