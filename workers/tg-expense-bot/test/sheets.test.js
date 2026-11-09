import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJwt, importPrivateKey, b64url, expenseCells } from '../src/sheets.js';
import { formatAmount, formatSheetDate, formatShortDate, esc } from '../src/format.js';
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

test('строка для Sheets: поля B..I, курс и рубли только для RUB', () => {
  const rub = expenseCells(parseExpense('кофе 250.5 нал'));
  assert.deepEqual(rub, [250.5, 'RUB', 1, 250.5, '', '', 'кофе 250.5 нал', 'Cash']);

  const vnd = expenseCells(parseExpense('кофе 50000 vnd сбер'));
  assert.deepEqual(vnd, [50000, 'VND', '', '', '', '', 'кофе 50000 vnd сбер', 'Sber']);
});

test('форматирование сумм и дат', () => {
  assert.equal(formatAmount(250), '250');
  assert.equal(formatAmount(250.5), '250.5');
  assert.equal(formatAmount(250.25), '250.25');
  // 2024-12-04 10:30 UTC -> 15:30 при UTC+5
  assert.equal(formatSheetDate(new Date('2024-12-04T10:30:00Z'), 5), '04.12.2024 15:30');
  assert.equal(formatShortDate('04.12.2024 15:30'), '15:30 04/12');
  assert.equal(formatShortDate('как есть'), 'как есть');
  assert.equal(esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
});
