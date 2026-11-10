import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJwt, importPrivateKey, b64url, expenseCells, amountCells, textCells,
  a1, requireGid, fingerprint, sheetDateSerial, sheetDateTimeSerial,
} from '../src/sheets.js';
import { formatAmount, formatExpenseAmount, formatSheetDate, formatShortDate, esc } from '../src/format.js';
import { parseExpense } from '../src/parser.js';

async function makeServiceAccount() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----\n`;
  return { pair, sa: { client_email: 'bot@test.iam.gserviceaccount.com', private_key: pem } };
}

test('JWT подписан RS256 и проверяется публичным ключом', async () => {
  const { pair, sa } = await makeServiceAccount();
  const key = await importPrivateKey(sa.private_key);
  const jwt = await buildJwt(sa, 1_700_000_000, key);

  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(claims.iss, sa.client_email);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.exp - claims.iat, 3600);

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    pair.publicKey,
    Buffer.from(s, 'base64url'),
    new TextEncoder().encode(`${h}.${p}`),
  );
  assert.equal(ok, true);
});

test('b64url без паддинга и без + и /', () => {
  assert.equal(b64url(new Uint8Array([251, 255])), '-_8');
});

test('13 значений A:M соответствуют целевой схеме, расход отрицательный', () => {
  const rub = expenseCells(parseExpense('кофе 250.5 руб нал'));
  assert.deepEqual(rub, [-250.5, 'RUB', 1, -250.5, 'Покупка', '', 'кофе', 'Cash', '', '', 'RUB']);

  const vnd = expenseCells(parseExpense('кофе 50000 vnd сбер'));
  assert.deepEqual(vnd, [-50000, 'VND', '', '', 'Покупка', '', 'кофе', 'Sber', '', '', 'VND']);
  assert.equal(rub.length + 2, 13, 'Timestamp и Operation Date добавляются при записи');
});

test('timestamp и Operation Date — числовые даты Sheets в UTC+5', () => {
  const instant = new Date('2024-12-04T20:10:23Z');
  const expectedTimestamp = 45631 + (1 * 3600 + 10 * 60 + 23) / 86_400; // 2024-12-05 01:10:23 в UTC+5
  assert.equal(sheetDateTimeSerial(instant, 5), expectedTimestamp);
  assert.equal(sheetDateSerial(instant, 5), 45631);

  const dayBoundary = new Date('2024-12-04T19:30:00Z');
  assert.equal(sheetDateSerial(dayBoundary, 5), 45631);
});

test('форматирование сумм, дат и текста Telegram', () => {
  assert.equal(formatAmount(-250), '-250');
  assert.equal(formatAmount(-250.5), '-250.5');
  assert.equal(formatAmount(-250.25), '-250.25');
  assert.equal(formatAmount(100000), '100 000');
  assert.equal(formatAmount(-123456.75), '-123 456.75');
  assert.equal(formatExpenseAmount(-100000), '100 000');
  assert.equal(formatExpenseAmount('-1,234.50'), '1 234.5');
  // 2024-12-04 10:30 UTC -> 15:30 при UTC+5
  assert.equal(formatSheetDate(new Date('2024-12-04T10:30:00Z'), 5), '04.12.2024 15:30');
  assert.equal(formatShortDate('04.12.2024 15:10:23'), '15:10 04/12');
  assert.equal(formatShortDate('как есть'), 'как есть');
  assert.equal(esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
});

test('редактирование меняет расчётные поля, не включает ручные поля', () => {
  const e = parseExpense('такси 300 руб сбер');
  assert.deepEqual(amountCells(e), [-300, 'RUB', 1, -300]);
  assert.deepEqual(textCells(e), ['такси', 'Sber']);
});

test('a1: имя листа берётся в апострофы, апостроф экранируется', () => {
  assert.equal(a1('tg_bot', 'A:M'), "'tg_bot'!A:M");
  assert.equal(a1("Bob's", 'B2:E2'), "'Bob''s'!B2:E2");
});

test('requireGid: пустой, нечисловой и отрицательный SHEET_GID отклоняются', () => {
  assert.equal(requireGid({ SHEET_GID: '717952579' }), 717952579);
  assert.equal(requireGid({ SHEET_GID: '0' }), 0);
  for (const bad of [undefined, '', 'abc', '-1', '1.5']) {
    assert.throws(() => requireGid({ SHEET_GID: bad }), /SHEET_GID не задан/, String(bad));
  }
});

test('fingerprint учитывает все 13 колонок, но не номер строки', () => {
  const base = {
    timestamp: '04.12.2024 15:10:23', amount: '-500', currency: 'RUB', fx_rub: '1', rub: '-500',
    category: 'Покупка', subcategory: '', description: 'обед', source: 'Cash', fx: '',
    commission: '', purchase_currency: 'RUB', operation_date: '04.12.2024',
  };
  assert.equal(fingerprint(base), fingerprint({ ...base, row_number: 9 }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, amount: '-501' }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, category: 'Еда' }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, fx: '0.5' }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, operation_date: '05.12.2024' }));
  assert.match(fingerprint(base), /^[0-9a-f]{8}$/);
});

test('grant_type совпадает с RFC 7523 / google-auth (urn:ietf:params:oauth:...)', async () => {
  const { JWT_GRANT_TYPE } = await import('../src/sheets.js');
  assert.equal(JWT_GRANT_TYPE, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
});
