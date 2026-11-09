import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

// Тестовый service account с настоящим RSA-ключом (нужен для подписи JWT).
async function makeServiceAccountJson() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ client_email: 'bot@test.iam.gserviceaccount.com', private_key: pem });
}

const baseEnv = {
  TELEGRAM_TOKEN: '111:TEST',
  WEBHOOK_SECRET: 's3cret_value',
  ALLOWED_USER_ID: '42',
  SPREADSHEET_ID: 'sheet-id',
  SHEET_GID: '0',
  TZ_OFFSET_HOURS: '5',
  GOOGLE_SERVICE_ACCOUNT_JSON: await makeServiceAccountJson(),
};

const webhookRequest = (update, secret = baseEnv.WEBHOOK_SECRET) =>
  new Request('https://tg-expense-bot.test.workers.dev/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    },
    body: JSON.stringify(update),
  });

const message = (text, fromId = 42) => ({
  update_id: 1,
  message: {
    message_id: 10,
    date: 1_733_307_000, // фиксированная дата сообщения
    from: { id: fromId, is_bot: false },
    chat: { id: fromId, type: 'private' },
    text,
  },
});

// Мок внешних сервисов: Google token, Google Sheets, Telegram.
function mockExternal() {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET', body: init.body });
    const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('oauth2.googleapis.com/token')) return json({ access_token: 'tok', expires_in: 3600 });
    if (u.includes('sheets.googleapis.com')) return json({ values: [['x']] });
    if (u.includes('api.telegram.org')) return json({ ok: true, result: {} });
    return new Response('unexpected', { status: 500 });
  });
  return calls;
}

test.afterEach(() => mock.restoreAll());

test('без или с неверным secret token — 403 и никаких внешних вызовов', async () => {
  const calls = mockExternal();
  const res1 = await worker.fetch(webhookRequest(message('кофе 250'), 'wrong'), baseEnv);
  const res2 = await worker.fetch(new Request('https://x.test/', { method: 'POST', body: '{}' }), baseEnv);
  assert.equal(res1.status, 403);
  assert.equal(res2.status, 403);
  assert.equal(calls.length, 0);
});

test('если WEBHOOK_SECRET не задан — всё закрыто', async () => {
  const calls = mockExternal();
  const env = { ...baseEnv, WEBHOOK_SECRET: undefined };
  const res = await worker.fetch(webhookRequest(message('кофе 250'), ''), env);
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('GET отвечает 404', async () => {
  const res = await worker.fetch(new Request('https://x.test/'), baseEnv);
  assert.equal(res.status, 404);
});

test('чужой Telegram user ID игнорируется молча', async () => {
  const calls = mockExternal();
  const res = await worker.fetch(webhookRequest(message('кофе 250', 999)), baseEnv);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
});

test('расход с десятичной суммой: 1 запрос Sheets append + 1 Telegram sendMessage', async () => {
  const calls = mockExternal();
  const res = await worker.fetch(webhookRequest(message('кофе 250.50 нал')), baseEnv);
  assert.equal(res.status, 200);

  const appendCall = calls.find((c) => c.url.includes(':append'));
  assert.ok(appendCall, 'должен быть вызов append');
  const sent = JSON.parse(appendCall.body).values[0];
  // Дата: 1733307000 = 2024-12-04 10:10 UTC -> 15:10 при UTC+5
  assert.deepEqual(sent, ['04.12.2024 15:10', 250.5, 'RUB', 1, 250.5, '', '', 'кофе 250.50 нал', 'Cash']);

  const sends = calls.filter((c) => c.url.includes('sendMessage'));
  assert.equal(sends.length, 1);
  assert.match(JSON.parse(sends[0].body).text, /Добавлено: кофе \| 250\.5 RUB \| Cash/);
});

test('VND расход записывается с валютой VND', async () => {
  const calls = mockExternal();
  await worker.fetch(webhookRequest(message('кофе 50000 vnd')), baseEnv);
  const appendCall = calls.find((c) => c.url.includes(':append'));
  const sent = JSON.parse(appendCall.body).values[0];
  // [дата, B сумма, C валюта, D курс, E рубли, F, G, H исходный текст, I источник]
  assert.equal(sent[1], 50000);
  assert.equal(sent[2], 'VND');
  assert.equal(sent[3], '');
  assert.equal(sent[4], '');
});

test('ошибка парсинга не обращается к Sheets', async () => {
  const calls = mockExternal();
  await worker.fetch(webhookRequest(message('без цифр')), baseEnv);
  assert.equal(calls.some((c) => c.url.includes('sheets.googleapis.com')), false);
  const send = calls.find((c) => c.url.includes('sendMessage'));
  assert.match(JSON.parse(send.body).text, /укажите сумму/);
});

test('ответ на подсказку редактирования обновляет строку из текста родителя', async () => {
  const calls = mockExternal();
  const update = {
    update_id: 2,
    message: {
      message_id: 11,
      date: 1_733_307_000,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: 'private' },
      text: 'такси 300 сбер',
      reply_to_message: {
        message_id: 9,
        from: { id: 111, is_bot: true },
        chat: { id: 42, type: 'private' },
        text: '✏️ Редактирование строки (стр. 7)\nИсходный текст: кофе',
      },
    },
  };
  const res = await worker.fetch(webhookRequest(update), baseEnv);
  assert.equal(res.status, 200);
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put, 'должен быть PUT');
  assert.match(put.url, /values\/B7:I7/);
  assert.equal(JSON.parse(put.body).values[0][0], 300);
});

test('callback delete_row: удаление строки со сдвигом через batchUpdate', async () => {
  const calls = mockExternal();
  const update = {
    update_id: 3,
    callback_query: {
      id: 'cb1',
      from: { id: 42, is_bot: false },
      data: 'delete_row:5',
      message: { message_id: 20, chat: { id: 42, type: 'private' }, text: 'x' },
    },
  };
  await worker.fetch(webhookRequest(update), baseEnv);
  const batch = calls.find((c) => c.url.endsWith(':batchUpdate'));
  assert.ok(batch, 'должен быть batchUpdate');
  const req = JSON.parse(batch.body).requests[0].deleteDimension.range;
  assert.deepEqual(req, { sheetId: 0, dimension: 'ROWS', startIndex: 4, endIndex: 5 });
  assert.ok(calls.some((c) => c.url.includes('answerCallbackQuery')));
  assert.ok(calls.some((c) => c.url.includes('editMessageText')));
});
