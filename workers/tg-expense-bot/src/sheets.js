// Google Sheets через REST API без SDK: JWT service account подписывается WebCrypto (RS256).
// Токен, импортированный ключ и название листа кэшируются в памяти isolate (KV/D1 не используются).
//
// Инвариант безопасности: каждая операция с листом сначала резолвит title по SHEET_GID
// и адресует только его. Если SHEET_GID не задан или не найден — запись блокируется (fail closed).

import { formatSheetDate } from './format.js';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_TTL_SEC = 3600;

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
      grant_type: 'urn:ietf:params:oauth2:grant-type:jwt-bearer',
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
  if (sheetCache && sheetCache.key === key) return sheetCache.title;

  const data = await sheetsCall(env, 'GET', '?fields=sheets.properties(sheetId,title)');
  const found = (data.sheets ?? []).map((s) => s.properties).find((p) => p.sheetId === gid);
  if (!found) throw new Error(`Лист с gid=${gid} не найден в таблице. Запись заблокирована.`);

  sheetCache = { key, title: found.title };
  return found.title;
}

/** A1-диапазон с явным листом: 'Название листа'!A1:B2 (апострофы экранируются). */
export function a1(title, range) {
  return `'${title.replace(/'/g, "''")}'!${range}`;
}

const pathRange = (title, range) => encodeURIComponent(a1(title, range));

/** Колонки B..E: сумма, валюта, курс, рубли. Не трогают A (дата), F:G (ручные категории), H:I. */
export function amountCells(expense) {
  const isRub = expense.currency === 'RUB';
  return [expense.amount, expense.currency, isRub ? 1 : '', isRub ? expense.amount : ''];
}

/** Колонки H..I: исходный текст и источник. */
export function textCells(expense) {
  return [expense.raw_text, expense.source];
}

/** Колонки B..I для новой строки: F:G остаются пустыми для ручного заполнения. */
export function expenseCells(expense) {
  return [...amountCells(expense), '', '', ...textCells(expense)];
}

const COLS = 9; // A:I

function toEntry(cells, rowNumber) {
  const c = [...cells];
  while (c.length < COLS) c.push('');
  return {
    row_number: rowNumber,
    date: c[0],
    amount: c[1],
    currency: c[2],
    raw_text: c[7],
    source: c[8],
  };
}

/** Короткий отпечаток строки (FNV-1a, 8 hex). Защищает от действий над сдвинувшейся строкой. */
export function fingerprint(entry) {
  const s = [entry.date, entry.amount, entry.currency, entry.raw_text, entry.source].join('|');
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
  const dateText = formatSheetDate(messageDate, Number(env.TZ_OFFSET_HOURS ?? 0));
  await sheetsCall(
    env,
    'POST',
    `/values/${pathRange(title, 'A:I')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { values: [[dateText, ...expenseCells(expense)]] },
  );
}

async function countRows(env, title) {
  const data = await sheetsCall(env, 'GET', `/values/${pathRange(title, 'A:A')}`);
  return data.values?.length ?? 0;
}

async function readRows(env, title, from, to) {
  const data = await sheetsCall(env, 'GET', `/values/${pathRange(title, `A${from}:I${to}`)}`);
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
 * Обновляет только B:E и H:I выбранной строки. F:G (ручные категории) не трогаются.
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
