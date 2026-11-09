// Google Sheets через REST API без SDK: JWT service account подписывается WebCrypto (RS256).
// Токен и импортированный ключ кэшируются в памяти isolate (KV/D1 не используются).

import { formatSheetDate } from './format.js';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_TTL_SEC = 3600;
const COLS = 9; // A:I

const enc = new TextEncoder();
let keyCache = null; // { pem, key }
let tokenCache = null; // { token, expiresAt }

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

/** Поля B..I для одной записи (без даты, которая лежит в A). */
export function expenseCells(expense) {
  const isRub = expense.currency === 'RUB';
  return [
    expense.amount,
    expense.currency,
    isRub ? 1 : '',
    isRub ? expense.amount : '',
    '', // F: категория (заполняется вручную)
    '', // G: подкатегория
    expense.raw_text,
    expense.source,
  ];
}

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

/** 1 запрос Sheets: добавление строки. */
export async function appendExpense(env, expense, messageDate) {
  const dateText = formatSheetDate(messageDate, Number(env.TZ_OFFSET_HOURS ?? 0));
  await sheetsCall(
    env,
    'POST',
    '/values/A:I:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
    { values: [[dateText, ...expenseCells(expense)]] },
  );
}

/** 1 запрос Sheets: число заполненных строк по колонке A (чтобы не тянуть всю таблицу). */
async function countRows(env) {
  const data = await sheetsCall(env, 'GET', '/values/A:A');
  return data.values?.length ?? 0;
}

async function readRows(env, from, to) {
  const data = await sheetsCall(env, 'GET', `/values/A${from}:I${to}`);
  return data.values ?? [];
}

/** 2 запроса Sheets: количество строк + диапазон последних n. Новые сверху. */
export async function getLastRows(env, n = 4) {
  const total = await countRows(env);
  if (total <= 1) return []; // только заголовок или пусто
  const start = Math.max(2, total - n + 1);
  const values = await readRows(env, start, total);
  return values.map((cells, i) => toEntry(cells, start + i)).reverse();
}

/** 1 запрос Sheets. Возвращает null, если строки нет или это заголовок. */
export async function getRow(env, rowNumber) {
  if (rowNumber < 2) return null;
  const [cells] = await readRows(env, rowNumber, rowNumber);
  if (!cells || cells.length === 0) return null;
  return toEntry(cells, rowNumber);
}

/** 1 запрос Sheets: перезапись B..I выбранной строки. */
export async function updateRow(env, rowNumber, expense) {
  if (rowNumber < 2) throw new Error('Нельзя редактировать строку заголовка');
  await sheetsCall(
    env,
    'PUT',
    `/values/B${rowNumber}:I${rowNumber}?valueInputOption=USER_ENTERED`,
    { values: [expenseCells(expense)] },
  );
}

/** 1 запрос Sheets: удаление строки со сдвигом (как delete_rows в gspread). */
export async function deleteRow(env, rowNumber) {
  if (rowNumber < 2) throw new Error('Нельзя удалить строку заголовка');
  await sheetsCall(env, 'POST', ':batchUpdate', {
    requests: [{
      deleteDimension: {
        range: {
          sheetId: Number(env.SHEET_GID ?? 0),
          dimension: 'ROWS',
          startIndex: rowNumber - 1,
          endIndex: rowNumber,
        },
      },
    }],
  });
}
