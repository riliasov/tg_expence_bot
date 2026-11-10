// Порт src/parser_core.py на JavaScript.
// Отличия от Python-версии:
// - десятичные суммы сохраняются: "250.50" -> 250.5;
// - явные малые суммы VND трактуются как тысячи донгов;
// - описание очищается по токенам, а не через replace() по подстроке.

export class ParseError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'ParseError';
    this.code = code;
  }
}

export const MAX_INPUT_LENGTH = 200;

const CURRENCY = new Map(Object.entries({
  rub: 'RUB', 'руб': 'RUB', 'р': 'RUB', 'рубль': 'RUB', 'рублей': 'RUB',
  usd: 'USD', 'доллар': 'USD', dollar: 'USD',
  eur: 'EUR', 'евро': 'EUR', euro: 'EUR',
  kzt: 'KZT', 'тенге': 'KZT', tenge: 'KZT',
  clp: 'CLP', 'песо': 'CLP', peso: 'CLP',
  usdt: 'USDT',
  thb: 'THB', 'бат': 'THB', bat: 'THB',
  bnd: 'BND',
  vnd: 'VND', 'внд': 'VND', 'внг': 'VND', vng: 'VND',
  'донг': 'VND', 'донга': 'VND', 'донгов': 'VND', dong: 'VND',
}));

// Символы, которые однозначно задают валюту (остальные символы ₽ $ ₸ игнорируются, как раньше).
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

// Сумма: необязательный символ валюты и минус, группы тысяч либо цифры,
// затем необязательная дробная часть из 1-2 цифр.
const AMOUNT_RE = /[₽$₸₫]?(-?)(\d{1,3}(?:[  .,]\d{3})+|\d+)(?:([.,])(\d{1,2}))?(?!\d)[₽$₸₫]?/gu;

const round2 = (x) => Math.round(x * 100) / 100;
const cleanText = (raw) => String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();

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
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
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

function inspect(text) {
  const tokens = tokenize(text);
  const candidates = findAmountCandidates(text);
  const currencies = [];
  const sources = [];
  const currencyIndices = new Set();
  const sourceIndices = new Set();

  tokens.forEach((token, index) => {
    const currency = currencyOf(token);
    if (currency) {
      currencies.push({ currency, token, index });
      currencyIndices.add(index);
    }
    const source = sourceOfWord(wordOf(token.raw));
    if (source) {
      sources.push({ source, token, index });
      sourceIndices.add(index);
    }
  });

  const description = tokens
    .filter((token, index) => {
      const overlapsAmount = candidates.some((candidate) => candidate.start < token.end && candidate.end > token.start);
      return !overlapsAmount && !currencyIndices.has(index) && !sourceIndices.has(index) && Boolean(wordOf(token.raw));
    })
    .map((token) => token.raw)
    .join(' ');

  return { text, tokens, candidates, currencies, sources, description };
}

/** Return a safe, stateless prompt context only for a clearly incomplete operation. */
export function detectExpenseDraft(raw) {
  const info = inspect(cleanText(raw));
  if (!info.text || info.text.length > MAX_INPUT_LENGTH || info.currencies.length > 1 || info.sources.length > 1) return null;

  if (info.currencies.some(({ currency }) => currency === 'VND') && info.candidates.some(({ amount }) => !Number.isInteger(amount))) return null;

  if (info.candidates.length === 1 && !info.description) {
    return { kind: 'description', text: info.text };
  }
  if (info.candidates.length === 0 && info.description) {
    return { kind: 'amount', text: info.text };
  }
  return null;
}

/** Several independent amounts remain ambiguous even when a currency is present. */
export function hasUnresolvedAmountAmbiguity(raw) {
  const info = inspect(cleanText(raw));
  return info.candidates.length > 1;
}

/** Combine one unambiguous reply with a message-text draft; no external state is used. */
export function completeExpenseDraft(draftRaw, replyRaw, kind) {
  const draft = inspect(cleanText(draftRaw));
  const reply = inspect(cleanText(replyRaw));
  const ambiguous = () => new ParseError('Ответ неполный или неоднозначный. Отправь расход целиком одним сообщением.', 'ambiguous_reply');
  if (!draft.text || !reply.text || draft.currencies.length > 1 || draft.sources.length > 1 || reply.currencies.length > 1 || reply.sources.length > 1) {
    throw ambiguous();
  }

  if (kind === 'description') {
    if (draft.candidates.length !== 1 || draft.description || reply.candidates.length !== 0 || reply.currencies.length !== 0 || reply.sources.length !== 0 || !reply.description) {
      throw ambiguous();
    }
    const currency = draft.currencies[0]?.currency ?? 'RUB';
    const source = draft.sources[0]?.source;
    return parseExpense([reply.description, String(draft.candidates[0].amount), currency.toLowerCase(), source?.toLowerCase()].filter(Boolean).join(' '));
  }

  if (kind !== 'amount' || draft.candidates.length !== 0 || !draft.description || reply.candidates.length !== 1 || reply.description) {
    throw ambiguous();
  }

  const draftCurrency = draft.currencies[0]?.currency;
  const replyCurrency = reply.currencies[0]?.currency;
  if (draftCurrency && replyCurrency && draftCurrency !== replyCurrency) throw ambiguous();
  const draftSource = draft.sources[0]?.source;
  const replySource = reply.sources[0]?.source;
  if (draftSource && replySource && draftSource !== replySource) throw ambiguous();

  const currency = draftCurrency ?? replyCurrency ?? 'RUB';
  const source = draftSource ?? replySource;
  return parseExpense([draft.description, String(reply.candidates[0].amount), currency.toLowerCase(), source?.toLowerCase()].filter(Boolean).join(' '));
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
  const text = cleanText(raw);
  if (!text) throw new ParseError('Ошибка: укажите сумму и описание', 'missing_fields');
  if (text.length > MAX_INPUT_LENGTH) {
    throw new ParseError(`Ошибка: текст длиннее ${MAX_INPUT_LENGTH} символов`, 'too_long');
  }

  const tokens = tokenize(text);
  const candidates = findAmountCandidates(text);
  if (candidates.length === 0) {
    const partial = inspect(text);
    throw new ParseError(
      partial.description ? 'Ошибка: укажите сумму' : 'Ошибка: укажите сумму и описание',
      partial.description ? 'missing_amount' : 'missing_fields',
    );
  }

  const currencyTokens = tokens.map(currencyOf).filter(Boolean);
  if (new Set(currencyTokens).size > 1) throw new ParseError('Ошибка: указана неоднозначная валюта', 'ambiguous_currency');
  const sourceTokens = tokens.map((token) => sourceOfWord(wordOf(token.raw))).filter(Boolean);
  if (new Set(sourceTokens).size > 1) throw new ParseError('Ошибка: указано несколько счетов', 'ambiguous_source');

  const currencyIndex = findCurrencyIndex(tokens);
  const currency = currencyIndex >= 0 ? currencyOf(tokens[currencyIndex]) : 'RUB';
  const best = pickBestAmount(candidates, tokens, currencyIndex);
  const { source } = findSource(tokens);

  if (currency === 'VND' && !Number.isInteger(best.amount)) {
    throw new ParseError('Дробная сумма VND неоднозначна. Укажи целое число донгов.', 'fractional_vnd');
  }

  // Короткая явная сумма VND трактуется как тысячи; большие суммы не масштабируются повторно.
  const amount = currency === 'VND' && best.amount >= 1 && best.amount <= 999
    ? best.amount * 1000
    : best.amount;

  // Вырезаем сумму по позиции, затем убираем токены валюты и источника.
  const rest = tokenize(text.slice(0, best.start) + ' ' + text.slice(best.end));
  const withoutCurrency = rest.filter((_, i) => currencyOf(rest[i]) === null);
  const withoutSource = withoutCurrency.filter((token) => sourceOfWord(wordOf(token.raw)) === null);
  const description = withoutSource.map((t) => t.raw).join(' ');

  if (!description) throw new ParseError('Ошибка: укажите описание', 'missing_description');

  return {
    amount: -Math.abs(amount),
    currency,
    source,
    description,
    raw_text: text,
  };
}
