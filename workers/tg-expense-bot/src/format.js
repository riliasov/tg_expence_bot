// Вспомогательные функции форматирования для Telegram (HTML) и Google Sheets.

/** Экранирует текст пользователя для parse_mode=HTML. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 250 -> "250", 250.5 -> "250.5", 250.25 -> "250.25". */
export function formatAmount(amount) {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/0$/, '');
}

/** Дата сообщения в строку "DD.MM.YYYY HH:MM" со сдвигом часового пояса (как в Python-версии). */
export function formatSheetDate(date, offsetHours = 0) {
  const d = new Date(date.getTime() + offsetHours * 3_600_000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** "DD.MM.YYYY HH:MM" -> "HH:MM DD/MM"; иной формат возвращается как есть. */
export function formatShortDate(text) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(text ?? '');
  return m ? `${m[4]}:${m[5]} ${m[1]}/${m[2]}` : (text ?? '');
}
