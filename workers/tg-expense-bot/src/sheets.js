// Google Sheets через REST API без SDK: JWT service account подписывается WebCrypto (RS256).
// Токен, импортированный ключ и название листа кэшируются в памяти isolate (KV/D1 не используются).
//
// Инвариант безопасности: каждая операция с листом сначала резолвит title по SHEET_GID
// и адресует только его. Если SHEET_GID не задан или не найден — запись блокируется (fail closed).

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// RFC 7523 JWT bearer grant. Значение совпадает с google-auth (urn:ietf:params:oauth:..., без "2").
export const JWT_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_TTL_SEC = 3600;
export const SHEET_HEADERS = [
  'Timestamp', 'Amount', 'Currency', 'FX RUB', 'RUB', 'Category', 'SubCategory',
  'Description', 'Account', 'FX', 'Commission', 'Purchase Currency', 'Operation Date',
];

const enc = new TextEncoder();
let keyCache = null; // { pem, key }
let tokenCache = null; // { token, expiresAt }
let sheetCache = null; // { key: "<spreadsheetId>:<gid>", title }

export function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function importPrivateKey(pemRaw) {
  const pem = pemRaw.replace(/\\n/g, '\n');
  if (keyCache && keyCache.pem === pem) return keyCache.key;
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  keyCache = { pem, key };
  return key;
}

export async function buildJwt(serviceAccount, nowSec, key) {
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(enc.encode(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + TOKEN_TTL_SEC,
  })));
  const input = `${header}.${claims}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

export async function getAccessToken(env, now = Date.now()) {
  if (tokenCache && now < tokenCache.expiresAt) return tokenCache.token;

  const serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const key = await importPrivateKey(serviceAccount.private_key);
  const assertion = await buildJwt(serviceAccount, Math.floor(now / 1000), key);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: JWT_GRANT_TYPE,
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Google token request failed: HTTP ${res.status}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: now + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

async function sheetsCall(env, method, path, body) {
  const token = await getAccessToken(env);
  const res = await fetch(`${SHEETS_API}/${env.SPREADSHEET_ID}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google Sheets ${res.status}: ${data?.error?.message ?? 'unknown error'}`);
  }
  return data;
}

/** SHEET_GID обязателен и должен быть целым неотрицательным числом. */
export function requireGid(env) {
  const raw = String(env.SHEET_GID ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error('SHEET_GID не задан или не число. Запись заблокирована.');
  }
  return Number(raw);
}

/**
 * Находит title листа по gid. Один дополнительный запрос на холодный isolate.
 * Если gid нет в таблице — ошибка, операции не выполняются.
 */
export async function resolveSheetTitle(env) {
  const gid = requireGid(env);
  const key = `${env.SPREADSHEET_ID}:${gid}`;
  let title;
  if (sheetCache && sheetCache.key === key) {
    title = sheetCache.title;
  } else {
    const data = await sheetsCall(env, 'GET', '?fields=sheets.properties(sheetId,title)');
    const found = (data.sheets ?? []).map((s) => s.properties).find((p) => p.sheetId === gid);
    if (!found) throw new Error(`Лист с gid=${gid} не найден в таблице. Запись заблокирована.`);
    title = found.title;
    sheetCache = { key, title };
  }

  // Refuse to read or mutate legacy rows through the new A:M mapping.
  const header = await sheetsCall(env, 'GET', `/values/${pathRange(title, 'A1:M1')}`);
  if (JSON.stringify(header.values?.[0] ?? []) !== JSON.stringify(SHEET_HEADERS)) {
    throw new Error('Заголовки A:M не совпадают с целевой схемой. Операция заблокирована.');
  }
  return title;
}

/** A1-диапазон с явным листом: 'Название листа'!A1:B2 (апострофы экранируются). */
export function a1(title, range) {
  return `'${title.replace(/'/g, "''")}'!${range}`;
}

const pathRange = (title, range) => encodeURIComponent(a1(title, range));

/** Колонки B..E: сумма, валюта, FX RUB, RUB. */
export function amountCells(expense) {
  const isRub = expense.currency === 'RUB';
  const amount = -Math.abs(Number(expense.amount));
  return [amount, expense.currency, isRub ? 1 : '', isRub ? amount : ''];
}

/** Колонки H..I: описание и счёт. */
export function textCells(expense) {
  return [expense.description, expense.source];
}

/** Колонки B..L. При создании категория — «Покупка», остальные ручные поля пусты. */
export function expenseCells(expense) {
  return [
    ...amountCells(expense),
    'Покупка', '',
    ...textCells(expense),
    '', '',
    expense.currency,
  ];
}

const COLS = 13; // A:M

const SHEETS_EPOCH_DAYS = 25_569; // 1899-12-30 to 1970-01-01
const MS_PER_DAY = 86_400_000;

function localDateParts(date, offsetHours) {
  const instant = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(instant.getTime())) throw new Error('Некорректная дата операции');
  const shifted = new Date(instant.getTime() + offsetHours * 3_600_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/** Native Sheets date-time serial for the spreadsheet's UTC+5 wall clock. */
export function sheetDateTimeSerial(date, offsetHours = 5) {
  const p = localDateParts(date, offsetHours);
  const localMidnight = Date.UTC(p.year, p.month, p.day);
  const seconds = p.hour * 3600 + p.minute * 60 + p.second;
  return SHEETS_EPOCH_DAYS + localMidnight / MS_PER_DAY + seconds / 86_400;
}

/** Native Sheets date serial for the operation's local calendar day. */
export function sheetDateSerial(date, offsetHours = 5) {
  const p = localDateParts(date, offsetHours);
  return SHEETS_EPOCH_DAYS + Date.UTC(p.year, p.month, p.day) / MS_PER_DAY;
}

function toEntry(cells, rowNumber) {
  const c = [...cells];
  while (c.length < COLS) c.push('');
  return {
    row_number: rowNumber,
    timestamp: c[0],
    date: c[0],
    amount: c[1],
    currency: c[2],
    fx_rub: c[3],
    rub: c[4],
    category: c[5],
    subcategory: c[6],
    description: c[7],
    source: c[8],
    fx: c[9],
    commission: c[10],
    purchase_currency: c[11],
    operation_date: c[12],
  };
}

/** Короткий отпечаток строки (FNV-1a, 8 hex). Защищает от действий над сдвинувшейся строкой. */
export function fingerprint(entry) {
  const s = JSON.stringify([
    entry.timestamp ?? entry.date,
    entry.amount,
    entry.currency,
    entry.fx_rub,
    entry.rub,
    entry.category,
    entry.subcategory,
    entry.description,
    entry.source,
    entry.fx,
    entry.commission,
    entry.purchase_currency,
    entry.operation_date,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Запись в конец листа. RAW: текст никогда не интерпретируется как формула. 1 запрос. */
export async function appendExpense(env, expense, messageDate) {
  const title = await resolveSheetTitle(env);
  const offset = Number(env.TZ_OFFSET_HOURS ?? 5);
  if (!Number.isFinite(offset)) throw new Error('Некорректный TZ_OFFSET_HOURS');
  await sheetsCall(
    env,
    'POST',
    `/values/${pathRange(title, 'A:M')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { values: [[sheetDateTimeSerial(messageDate, offset), ...expenseCells(expense), sheetDateSerial(messageDate, offset)]] },
  );
}

async function countRows(env, title) {
  const data = await sheetsCall(env, 'GET', `/values/${pathRange(title, 'A:A')}`);
  return data.values?.length ?? 0;
}

async function readRows(env, title, from, to) {
  const data = await sheetsCall(env, 'GET', `/values/${pathRange(title, `A${from}:M${to}`)}`);
  return data.values ?? [];
}

/** Последние n записей, новые сверху. 2 запроса на вызов (+1 для резолва листа на холодный isolate). */
export async function getLastRows(env, n = 4) {
  const title = await resolveSheetTitle(env);
  const total = await countRows(env, title);
  if (total <= 1) return []; // только заголовок или пусто
  const start = Math.max(2, total - n + 1);
  const values = await readRows(env, title, start, total);
  return values.map((cells, i) => toEntry(cells, start + i)).reverse();
}

/** Одна строка или null (заголовок, пустая или отсутствующая строка). 1 запрос. */
export async function getRow(env, rowNumber) {
  if (!Number.isInteger(rowNumber) || rowNumber < 2) return null;
  const title = await resolveSheetTitle(env);
  const [cells] = await readRows(env, title, rowNumber, rowNumber);
  if (!cells || cells.length === 0) return null;
  return toEntry(cells, rowNumber);
}

/**
 * Обновляет только B:E, H:I и L. Ручные категории, курсы, комиссии и даты не трогаются.
 * Одним batchUpdate. 1 запрос.
 */
export async function updateRow(env, rowNumber, expense) {
  if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new Error('Нельзя редактировать строку заголовка');
  const title = await resolveSheetTitle(env);
  await sheetsCall(env, 'POST', '/values:batchUpdate', {
    valueInputOption: 'RAW',
    data: [
      { range: a1(title, `B${rowNumber}:E${rowNumber}`), values: [amountCells(expense)] },
      { range: a1(title, `H${rowNumber}:I${rowNumber}`), values: [textCells(expense)] },
      { range: a1(title, `L${rowNumber}:L${rowNumber}`), values: [[expense.currency]] },
    ],
  });
}

/** Удаление строки со сдвигом. sheetId берётся из проверенного SHEET_GID. 1 запрос (+резолв). */
export async function deleteRow(env, rowNumber) {
  if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new Error('Нельзя удалить строку заголовка');
  await resolveSheetTitle(env); // проверяет, что gid существует в таблице
  await sheetsCall(env, 'POST', ':batchUpdate', {
    requests: [{
      deleteDimension: {
        range: {
          sheetId: requireGid(env),
          dimension: 'ROWS',
          startIndex: rowNumber - 1,
          endIndex: rowNumber,
        },
      },
    }],
  });
}
