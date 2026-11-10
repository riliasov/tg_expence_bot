import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createFakeGoogle, GID_EXPENSES, TARGET_HEADER } from './fake-google.js';
import { fingerprint, getRow } from '../src/sheets.js';

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

const SA_JSON = await makeServiceAccountJson();
const baseEnv = () => ({
  TELEGRAM_TOKEN: '111:TEST',
  WEBHOOK_SECRET: 's3cret_value',
  ALLOWED_USER_ID: '42',
  SPREADSHEET_ID: 'sheet-id',
  SHEET_GID: String(GID_EXPENSES),
  TZ_OFFSET_HOURS: '5',
  GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON,
});

const DATE = 1_733_307_000; // 2024-12-04 10:10 UTC -> 15:10 при UTC+5
const EXPECTED_TS = 45630 + (15 * 3600 + 10 * 60) / 86_400;
const EXPECTED_DAY = 45630;

const req = (update, secret = 's3cret_value') =>
  new Request('https://tg-expense-bot.test.workers.dev/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(update),
  });

const privateMsg = (text, extra = {}) => ({
  update_id: 1,
  message: {
    message_id: 10,
    date: DATE,
    from: { id: 42, is_bot: false },
    chat: { id: 42, type: 'private' },
    text,
    ...extra,
  },
});

const callbackUpdate = (data, chat = { id: 42, type: 'private' }, from = { id: 42, is_bot: false }) => ({
  update_id: 5,
  callback_query: {
    id: 'cb1',
    from,
    data,
    message: { message_id: 20, chat, text: 'x' },
  },
});

let google;
let env;

beforeEach(() => {
  env = baseEnv();
  google = createFakeGoogle();
  mock.method(globalThis, 'fetch', google.fetch);
});
afterEach(() => mock.restoreAll());

function seedExpenses(rows) {
  google.tab('tg_bot').rows = [TARGET_HEADER.slice(), ...rows];
}

function storedRow({
  timestamp = '04.12.2024 15:10:00', amount = '-500', currency = 'RUB', fxRub = '1', rub = '-500',
  category = 'Еда', subcategory = 'Кафе', description = 'обед', account = 'Cash', fx = '',
  commission = '', purchaseCurrency = currency, operationDate = '04.12.2024',
} = {}) {
  return [timestamp, amount, currency, fxRub, rub, category, subcategory, description, account, fx, commission, purchaseCurrency, operationDate];
}

const lastTelegramText = () => {
  const sends = google.telegramCalls('sendMessage');
  return JSON.parse(sends[sends.length - 1].raw).text;
};
const lastTelegramPayload = () => {
  const sends = google.telegramCalls('sendMessage');
  return JSON.parse(sends[sends.length - 1].raw);
};
const ownBotPromptReply = () => ({
  message_id: 100,
  date: DATE,
  from: { id: 111, is_bot: true },
  chat: { id: 42, type: 'private' },
  text: lastTelegramPayload().text,
});
const lastEditText = () => {
  const edits = google.telegramCalls('editMessageText');
  return JSON.parse(edits[edits.length - 1].raw).text;
};

test('без или с неверным secret token — 403 и никаких внешних вызовов', async () => {
  const r1 = await worker.fetch(req(privateMsg('кофе 250'), 'wrong'), env);
  const r2 = await worker.fetch(new Request('https://x.test/', { method: 'POST', body: '{}' }), env);
  assert.equal(r1.status, 403);
  assert.equal(r2.status, 403);
  assert.equal(google.calls.length, 0);
});

test('если WEBHOOK_SECRET не задан — всё закрыто', async () => {
  env.WEBHOOK_SECRET = undefined;
  const r = await worker.fetch(req(privateMsg('кофе 250'), ''), env);
  assert.equal(r.status, 403);
  assert.equal(google.calls.length, 0);
});

test('GET отвечает 404', async () => {
  assert.equal((await worker.fetch(new Request('https://x.test/'), env)).status, 404);
});

test('чужой user ID и групповой чат игнорируются молча', async () => {
  const outsider = privateMsg('кофе 250');
  outsider.message.from.id = 999;
  outsider.message.chat.id = 999;
  await worker.fetch(req(outsider), env);
  await worker.fetch(req(privateMsg('кофе 250', { chat: { id: -100123, type: 'supergroup' } })), env);
  assert.equal(google.calls.length, 0);
});

test('несовпадающий заголовок блокирует чтение и запись по новой схеме', async () => {
  google.tab('tg_bot').rows[0] = ['Дата', 'Сумма', 'Валюта', 'Курс', 'RUB', 'Категория', 'Подкатегория', 'Текст', 'Источник'];
  await worker.fetch(req(privateMsg('кофе 35000 vnd нал')), env);
  assert.equal(google.tab('tg_bot').rows.length, 1);
  assert.equal(google.sheetCalls().filter((c) => c.method === 'POST').length, 0);
  assert.match(lastTelegramText(), /Заголовки A:M не совпадают/);
});

test('расход VND записывается во все 13 колонок A:M, другие вкладки не меняются', async () => {
  const response = await worker.fetch(req(privateMsg('кофе 35000 vnd нал')), env);
  assert.equal(response.status, 200);
  assert.deepEqual(google.tab('Банк').rows, [TARGET_HEADER]);
  assert.deepEqual(google.tab('tg_bot').rows[1], [
    EXPECTED_TS, -35000, 'VND', '', '', 'Покупка', '', 'кофе', 'Cash', '', '', 'VND', EXPECTED_DAY,
  ]);
  assert.match(lastTelegramText(), /Добавлено: кофе \| -35000 VND \| Cash/);

  const append = google.sheetCalls().find((c) => c.path.endsWith(':append'));
  assert.ok(append, 'используется values.append');
  assert.equal(decodeURIComponent(append.path.split('/values/')[1].split(':append')[0]), "'tg_bot'!A:M");
  assert.match(append.search, /valueInputOption=RAW/);
  assert.match(append.search, /insertDataOption=INSERT_ROWS/);
  assert.equal(append.body.values[0].length, 13);
  assert.equal(typeof append.body.values[0][0], 'number');
  assert.equal(typeof append.body.values[0][12], 'number');
  assert.ok(google.sheetCalls().some((c) => c.method === 'GET' && decodeURIComponent(c.path).includes("'tg_bot'!A1:M1")));
});

test('RUB расход получает FX RUB = 1, RUB равен отрицательному Amount', async () => {
  await worker.fetch(req(privateMsg('кофе 35000 нал')), env);
  const row = google.tab('tg_bot').rows[1];
  assert.deepEqual(row.slice(1, 5), [-35000, 'RUB', 1, -35000]);
  assert.equal(row[11], 'RUB');
});

test('пользовательский текст записывается литералом RAW', async () => {
  await worker.fetch(req(privateMsg('=HYPERLINK("x") 100')), env);
  const row = google.tab('tg_bot').rows[1];
  assert.equal(row[7], '=HYPERLINK("x")');
  const append = google.sheetCalls().find((c) => c.path.endsWith(':append'));
  assert.match(append.search, /valueInputOption=RAW/);
});

test('сумма без описания запрашивает ForceReply и пишет только после ответа', async () => {
  await worker.fetch(req(privateMsg('40 внг')), env);
  assert.equal(google.sheetCalls().length, 0, 'до ответа нет обращений к Google Sheets');
  const prompt = lastTelegramPayload();
  assert.equal(prompt.reply_markup.force_reply, true);
  assert.match(prompt.text, /Укажи описание/);

  await worker.fetch(req(privateMsg('еда', { date: DATE + 60, reply_to_message: ownBotPromptReply() })), env);
  assert.equal(google.tab('tg_bot').rows.length, 2);
  assert.deepEqual(google.tab('tg_bot').rows[1].slice(1, 3), [-40000, 'VND']);
  assert.equal(google.tab('tg_bot').rows[1][7], 'еда');
  assert.equal(google.sheetCalls().filter((call) => call.path.endsWith(':append')).length, 1);
});

test('описание без суммы запрашивает ForceReply и объединяется с ответом', async () => {
  await worker.fetch(req(privateMsg('кофе vnd')), env);
  assert.equal(google.sheetCalls().length, 0);
  const prompt = lastTelegramPayload();
  assert.equal(prompt.reply_markup.force_reply, true);
  assert.match(prompt.text, /Укажи сумму/);

  await worker.fetch(req(privateMsg('25', { date: DATE + 30, reply_to_message: ownBotPromptReply() })), env);
  const row = google.tab('tg_bot').rows[1];
  assert.deepEqual(row.slice(1, 3), [-25000, 'VND']);
  assert.equal(row[7], 'кофе');
  assert.equal(google.sheetCalls().filter((call) => call.path.endsWith(':append')).length, 1);
});

test('команды в ответ на черновик не создают расходы', async () => {
  await worker.fetch(req(privateMsg('40 vnd')), env);
  const prompt = ownBotPromptReply();
  for (const command of ['/cancel', '/start', '/help', '/unknown']) {
    await worker.fetch(req(privateMsg(command, { date: DATE + 20, reply_to_message: prompt })), env);
  }
  assert.equal(google.sheetCalls().filter((call) => call.method === 'POST').length, 0);
});

test('просроченный неполный ответ не сохраняется', async () => {
  await worker.fetch(req(privateMsg('40 vnd')), env);
  await worker.fetch(req(privateMsg('еда', { date: DATE + 301, reply_to_message: ownBotPromptReply() })), env);
  assert.equal(google.sheetCalls().length, 0);
  assert.match(lastTelegramText(), /Черновик истёк/);
});

test('чужой reply и неоднозначные суммы не пишутся, полная новая операция обрабатывается отдельно', async () => {
  await worker.fetch(req(privateMsg('40 vnd')), env);
  const prompt = ownBotPromptReply();

  await worker.fetch(req(privateMsg('еда', {
    reply_to_message: { ...prompt, from: { id: 222, is_bot: true } },
  })), env);
  assert.equal(google.sheetCalls().filter((call) => call.path.endsWith(':append')).length, 0);
  assert.match(lastTelegramText(), /Укажи сумму/);

  await worker.fetch(req(privateMsg('еда', {
    reply_to_message: { ...prompt, chat: { id: 77, type: 'private' } },
  })), env);
  assert.equal(google.sheetCalls().filter((call) => call.path.endsWith(':append')).length, 0);

  await worker.fetch(req(privateMsg('50 60', { reply_to_message: prompt })), env);
  assert.equal(google.sheetCalls().filter((call) => call.path.endsWith(':append')).length, 0);
  assert.match(lastTelegramText(), /несколько возможных сумм/);

  await worker.fetch(req(privateMsg('такси 40', { date: DATE + 60, reply_to_message: prompt })), env);
  assert.equal(google.sheetCalls().filter((call) => call.path.endsWith(':append')).length, 1);
  assert.deepEqual(google.tab('tg_bot').rows[1].slice(1, 3), [-40, 'RUB']);
  assert.equal(google.tab('tg_bot').rows[1][7], 'такси');
});

test('полный расход в reply обрабатывается самостоятельно, даже после срока черновика', async () => {
  await worker.fetch(req(privateMsg('кофе')), env);
  await worker.fetch(req(privateMsg('такси 40', {
    date: DATE + 3600,
    reply_to_message: ownBotPromptReply(),
  })), env);
  assert.equal(google.tab('tg_bot').rows.length, 2);
  assert.deepEqual(google.tab('tg_bot').rows[1].slice(1, 3), [-40, 'RUB']);
  assert.equal(google.tab('tg_bot').rows[1][7], 'такси');
  assert.equal(google.sheetCalls().filter((call) => call.path.endsWith(':append')).length, 1);
});

test('слишком длинный ввод отклоняется без чтения или записи Sheets', async () => {
  await worker.fetch(req(privateMsg('к'.repeat(300) + ' 100')), env);
  assert.equal(google.sheetCalls().length, 0);
  assert.match(lastTelegramText(), /длиннее 200/);
});

test('управляющие символы удаляются из описания', async () => {
  await worker.fetch(req(privateMsg('кофе\n250\tнал')), env);
  assert.equal(google.tab('tg_bot').rows[1][7], 'кофе');
});

test('неверный или неизвестный GID блокирует любые записи', async () => {
  delete env.SHEET_GID;
  await worker.fetch(req(privateMsg('кофе 250')), env);
  assert.equal(google.sheetCalls().filter((c) => c.method === 'POST').length, 0);
  assert.match(lastTelegramText(), /SHEET_GID не задан/);

  env.SHEET_GID = '999';
  await worker.fetch(req(privateMsg('кофе 250')), env);
  assert.equal(google.sheetCalls().filter((c) => c.method === 'POST').length, 0);
  assert.match(lastTelegramText(), /gid=999 не найден/);
});

test('редактирование обновляет только B:E, H:I и L, сохраняя категории, FX, комиссию и даты', async () => {
  seedExpenses([storedRow({ fx: 'manual FX', commission: 'manual fee' })]);
  const fp = fingerprint(await getRow(env, 2));

  await worker.fetch(req(callbackUpdate(`edit_row:2:${fp}`)), env);
  const prompt = lastTelegramText();
  assert.match(prompt, new RegExp(`стр\\. 2, #${fp}`));

  const reply = privateMsg('такси 300 сбер', {
    reply_to_message: {
      message_id: 9,
      from: { id: 111, is_bot: true },
      chat: { id: 42, type: 'private' },
      text: prompt,
    },
  });
  await worker.fetch(req(reply), env);

  const row = google.tab('tg_bot').rows[1];
  assert.deepEqual(row, [
    '04.12.2024 15:10:00', -300, 'RUB', 1, -300, 'Еда', 'Кафе', 'такси', 'Sber', 'manual FX', 'manual fee', 'RUB', '04.12.2024',
  ]);
  const update = google.sheetCalls().find((c) => c.path.endsWith('/values:batchUpdate'));
  assert.equal(update.body.valueInputOption, 'RAW');
  assert.deepEqual(update.body.data.map((d) => d.range), [
    "'tg_bot'!B2:E2", "'tg_bot'!H2:I2", "'tg_bot'!L2:L2",
  ]);
});

test('изменение любой колонки инвалидирует fingerprint редактирования', async () => {
  seedExpenses([storedRow()]);
  const fp = fingerprint(await getRow(env, 2));
  google.tab('tg_bot').rows[1][5] = 'Изменено вручную';
  const prompt = `✏️ Редактирование строки (стр. 2, #${fp})`;
  const reply = privateMsg('такси 300', {
    reply_to_message: { message_id: 9, from: { id: 111, is_bot: true }, text: prompt },
  });
  await worker.fetch(req(reply), env);
  assert.equal(google.sheetCalls().filter((c) => c.path.endsWith('/values:batchUpdate')).length, 0);
  assert.match(lastTelegramText(), /изменилась или не найдена/);
});

test('удаление требует подтверждение и удаляет только строку tg_bot', async () => {
  seedExpenses([storedRow()]);
  const fp = fingerprint(await getRow(env, 2));
  await worker.fetch(req(callbackUpdate(`delete_row:2:${fp}`)), env);
  assert.equal(google.tab('tg_bot').rows.length, 2);
  assert.equal(google.sheetCalls().filter((c) => c.path.endsWith(':batchUpdate')).length, 0);
  assert.match(lastEditText(), /Удалить запись \(стр\. 2\)/);

  await worker.fetch(req(callbackUpdate(`confirm_delete:2:${fp}`)), env);
  assert.equal(google.tab('tg_bot').rows.length, 1);
  assert.deepEqual(google.tab('Банк').rows, [TARGET_HEADER]);
  const deletion = google.sheetCalls().find((c) => c.path.endsWith(':batchUpdate'));
  assert.equal(deletion.body.requests[0].deleteDimension.range.sheetId, GID_EXPENSES);
});

test('/last показывает последние записи с временем UTC+5', async () => {
  seedExpenses([
    storedRow({ timestamp: '01.12.2024 10:00:00', amount: '-100', description: 'а', category: '', subcategory: '' }),
    storedRow({ timestamp: '02.12.2024 11:00:00', amount: '-200', description: 'б', category: '', subcategory: '' }),
  ]);
  await worker.fetch(req(privateMsg('/last')), env);
  const text = lastTelegramText();
  assert.match(text, /1\. 11:00 02\/12 -200 RUB Cash/);
  assert.match(text, /2\. 10:00 01\/12 -100 RUB Cash/);
});

test('ошибка Sheets видна владельцу, Worker отвечает Telegram HTTP 200', async () => {
  google.setFailSheets(true);
  const response = await worker.fetch(req(privateMsg('кофе 250')), env);
  assert.equal(response.status, 200);
  assert.match(lastTelegramText(), /Системная ошибка: Google Sheets 500/);
});

test('запись заголовка не редактируется и не удаляется', async () => {
  await worker.fetch(req(callbackUpdate('confirm_delete:1:00000000')), env);
  assert.equal(google.tab('tg_bot').rows.length, 1);
  assert.equal(google.sheetCalls().filter((c) => c.path.endsWith(':batchUpdate')).length, 0);
});
