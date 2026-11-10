// Вспомогательные функции форматирования для Telegram (HTML) и Google Sheets.

/** Экранирует текст пользователя для parse_mode=HTML. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Adds readable space grouping without changing decimal precision. */
export function formatAmount(amount) {
  const value = Number(amount);
  const raw = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
  return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Parses Google Sheets formatted numeric cells, accepting locale separators and grouping. */
export function parseFormattedNumber(amount) {
  if (typeof amount === 'number') return Number.isFinite(amount) ? amount : null;
  let value = String(amount ?? '').trim().replace(/[\s\u00a0\u202f]/g, '');
  const comma = value.lastIndexOf(',');
  const dot = value.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimalIndex = Math.max(comma, dot);
    const integerPart = value.slice(0, decimalIndex).replace(/[,.]/g, '');
    const fractionalPart = value.slice(decimalIndex + 1);
    value = `${integerPart}.${fractionalPart}`;
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? ',' : '.';
    const trailingDigits = value.length - Math.max(comma, dot) - 1;
    if (trailingDigits === 3) value = value.replace(/[,.]/g, '');
    else if (separator === ',') value = value.replace(',', '.');
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Telegram presents outflows as positive magnitudes while Sheets keeps signed amounts. */
export function formatExpenseAmount(amount) {
  const numeric = parseFormattedNumber(amount);
  return numeric === null ? esc(String(amount ?? '')) : formatAmount(Math.abs(numeric));
}

/** Дата сообщения в строку "DD.MM.YYYY HH:MM" со сдвигом часового пояса (как в Python-версии). */
export function formatSheetDate(date, offsetHours = 0) {
  const d = new Date(date.getTime() + offsetHours * 3_600_000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** "DD.MM.YYYY HH:MM[:SS]" -> "HH:MM DD/MM"; иной формат возвращается как есть. */
export function formatShortDate(text) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})(?::\d{2})?$/.exec(text ?? '');
  return m ? `${m[4]}:${m[5]} ${m[1]}/${m[2]}` : (text ?? '');
}
