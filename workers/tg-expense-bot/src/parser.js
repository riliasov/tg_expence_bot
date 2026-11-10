// Порт src/parser_core.py на JavaScript.
// Отличия от Python-версии:
// - десятичные суммы сохраняются: "250.50" -> 250.5, "500,75" -> 500.75;
// - добавлена валюта VND (слова vnd/донг/dong и символ ₫);
// - описание очищается по токенам, а не через replace() по подстроке
//   (в Python-версии "р" вырезала букву "р" из слов: "продукты 500 р" -> "одукты").

export class ParseError extends Error {}

export const MAX_INPUT_LENGTH = 200;

const CURRENCY = new Map(Object.entries({
  rub: 'RUB', 'руб': 'RUB', 'р': 'RUB', 'рубль': 'RUB', 'рублей': 'RUB',
  usd: 'USD', 'доллар': 'USD', dollar: 'USD',
  eur: 'EUR', 'евро': 'EUR', euro: 'EUR',
  kzt: 'KZT', 'тенге': 'KZT', tenge: 'KZT',
  clp: 'CLP', 'песо': 'CLP', peso: 'CLP',
  usdt: 'USDT',
  thb: 'THB', 'бат': 'THB', bat: 'THB',
  vnd: 'VND', 'донг': 'VND', 'донга': 'VND', 'донгов': 'VND', dong: 'VND',
}));

// Символы, которые однозначно задают валюту (остальные символы ₽ $ ₸ игнорируются, как раньше)
const CURRENCY_SYMBOLS = new Map([['₫', 'VND']]);

const SOURCE = new Map(Object.entries({
  'нал': 'Cash', 'наличн': 'Cash', 'наличные': 'Cash', 'наличка': 'Cash',
  cash: 'Cash', 'кэш': 'Cash', 'кеш': 'Cash',
  'тбанк': 'TBank', tbank: 'TBank', 'т-банк': 'TBank', 't-bank': 'TBank',
  'тинькофф': 'TBank', tinkoff: 'TBank', 'тиньк': 'TBank',
  'ozon': 'Ozon', 'озон': 'Ozon',
  sber: 'Sber', 'сбер': 'Sber', 'сберbank': 'Sber', sberbank: 'Sber',
  yandex: 'Yandex', 'яндекс': 'Yandex',
  alfa: 'Alfa', 'альфа': 'Alfa', 'альфабанк': 'Alfa', alfabank: 'Alfa',
  iron: 'BCC', 'бcc': 'BCC', bcc: 'BCC',
  travel: 'Travel',
}));

// Сумма: необязательный символ валюты, знак минуса (игнорируется), группы тысяч
// (пробел/точка/запятая + ровно 3 цифры) либо просто цифры, затем необязательная дробная часть из 1-2 цифр.
const AMOUNT_RE = /[₽$₸₫]?(-?)(\d{1,3}(?:[  .,]\d{3})+|\d+)(?:([.,])(\d{1,2}))?(?!\d)[₽$₸₫]?/gu;

const round2 = (x) => Math.round(x * 100) / 100;

function tokenize(text) {
  return [...text.matchAll(/\S+/g)].map((m) => ({
    raw: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
}

// Слово токена в нижнем регистре: без цифр, символов валют и крайней пунктуации.
function wordOf(raw) {
  return raw
    .toLowerCase()
    .replace(/[\d₽$₸₫]/g, '')
    .replace(/^[.,!?;:\-—–)]+|[.,!?;:\-—–)]+$/g, '');
}

function currencyOf(token) {
  for (const ch of token.raw) {
    if (CURRENCY_SYMBOLS.has(ch)) return CURRENCY_SYMBOLS.get(ch);
  }
  return CURRENCY.get(wordOf(token.raw)) ?? null;
}

function findCurrencyIndex(tokens) {
  return tokens.findIndex((t) => currencyOf(t) !== null);
}

function sourceOfWord(word) {
  if (SOURCE.has(word)) return SOURCE.get(word);
  for (const [keyword, source] of SOURCE) {
    if (word.startsWith(keyword)) return source;
  }
  return null;
}

function findSource(tokens) {
  for (let index = 0; index < tokens.length; index++) {
    const source = sourceOfWord(wordOf(tokens[index].raw));
    if (source) return { index, source };
  }
  return { index: -1, source: 'Cash' };
}

export function findAmountCandidates(text) {
  const candidates = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const digits = m[2].replace(/\D/g, '');
    const value = Number(m[4] ? `${digits}.${m[4]}` : digits);
    if (value > 0) {
      candidates.push({ amount: round2(value), start: m.index, end: m.index + m[0].length });
    }
  }
  return candidates;
}

// Выбор суммы: сначала та, что перекрывает валюту ("500руб"),
// затем ближайшая слева от валюты ("100 руб"), затем ближайшая справа ("usd 100"), иначе первая.
function pickBestAmount(candidates, tokens, currencyIndex) {
  if (candidates.length === 1) return candidates[0];
  if (currencyIndex >= 0) {
    const tok = tokens[currencyIndex];
    const overlap = candidates.find((c) => c.start < tok.end && c.end > tok.start);
    if (overlap) return overlap;
    const left = candidates.filter((c) => c.end <= tok.start);
    if (left.length) return left.reduce((a, b) => (b.end > a.end ? b : a));
    const right = candidates.filter((c) => c.start >= tok.end);
    if (right.length) return right.reduce((a, b) => (b.start < a.start ? b : a));
  }
  return candidates[0];
}

/**
 * Разбирает текст расхода.
 * @param {string} raw
 * @returns {{amount:number, currency:string, source:string, description:string, raw_text:string}}
 * @throws {ParseError}
 */
export function parseExpense(raw) {
  // Управляющие символы (включая переводы строк) заменяются пробелом; длина ограничена.
  const text = String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (!text) throw new ParseError('Ошибка: укажите сумму');
  if (text.length > MAX_INPUT_LENGTH) {
    throw new ParseError(`Ошибка: текст длиннее ${MAX_INPUT_LENGTH} символов`);
  }

  const tokens = tokenize(text);
  const candidates = findAmountCandidates(text);
  if (candidates.length === 0) throw new ParseError('Ошибка: укажите сумму');

  const currencyIndex = findCurrencyIndex(tokens);
  const currency = currencyIndex >= 0 ? currencyOf(tokens[currencyIndex]) : 'RUB';
  const best = pickBestAmount(candidates, tokens, currencyIndex);
  const { source } = findSource(tokens);

  // Вырезаем сумму по позиции, затем убираем первый токен валюты и первый токен источника.
  const rest = tokenize(text.slice(0, best.start) + ' ' + text.slice(best.end));
  const ci = findCurrencyIndex(rest);
  const withoutCurrency = rest.filter((_, i) => i !== ci);
  const si = findSource(withoutCurrency).index;
  const description = withoutCurrency
    .filter((_, i) => i !== si)
    .map((t) => t.raw)
    .join(' ');

  if (!description) throw new ParseError('Ошибка: укажите описание');

  return {
    // This parser handles expenses, so amounts are always stored as outflows.
    // A leading minus is accepted but is not required from the user.
    amount: -Math.abs(best.amount),
    currency,
    source,
    description,
    raw_text: text,
  };
}
