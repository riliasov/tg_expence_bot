import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createFakeGoogle, GID_EXPENSES } from './fake-google.js';
import { fingerprint } from '../src/sheets.js';

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

// Записываем строки в «Расходы» (gid 555), «Общая» остаётся пустой.
const EXPENSE_HEADER = ['Дата', 'Сумма', 'Валюта', 'Курс', 'RUB', 'Категория', 'Подкатегория', 'Текст', 'Источник'];
function seedExpenses(rows) {
  google.tab('Расходы').rows = [EXPENSE_HEADER, ...rows];
}
const lastTelegramText = () => {
  const sends = google.telegramCalls('sendMessage');
  return JSON.parse(sends[sends.length - 1].raw).text;
};
const lastEditText = () => {
  const edits = google.telegramCalls('editMessageText');
  return JSON.parse(edits[edits.length - 1].raw).text;
};

// --- Доступ и webhook ---

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

test('чужой user ID игнорируется молча', async () => {
  const u = privateMsg('кофе 250');
  u.message.from.id = 999;
  u.message.chat.id = 999;
  assert.equal((await worker.fetch(req(u), env)).status, 200);
  assert.equal(google.calls.length, 0);
});

test('групповой чат владельца игнорируется: ни записи, ни ответа', async () => {
  const u = privateMsg('кофе 250', { chat: { id: -100123, type: 'supergroup' } });
  await worker.fetch(req(u), env);
  assert.equal(google.calls.length, 0);
});

test('callback из группы тоже игнорируется', async () => {
  await worker.fetch(req(callbackUpdate('delete_row:5', { id: -100123, type: 'group' })), env);
  assert.equal(google.calls.length, 0);
});

// --- Адресация по SHEET_GID ---

test('запись идёт на лист с gid из SHEET_GID, а не на первый лист', async () => {
  await worker.fetch(req(privateMsg('кофе 250.50 нал')), env);
  assert.equal(google.tab('Общая').rows.length, 1, 'первый лист не тронут');
  const rows = google.tab('Расходы').rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ['04.12.2024 15:10', 250.5, 'RUB', 1, 250.5, '', '', 'кофе 250.50 нал', 'Cash']);
});

test('все запросы values адресуют лист по title, без голого A:I', async () => {
  await worker.fetch(req(privateMsg('кофе 250')), env);
  const valueCalls = google.sheetCalls().filter((c) => c.path.includes('/values'));
  assert.ok(valueCalls.length > 0);
  for (const c of valueCalls) {
    const decoded = c.path + decodeURIComponent(c.search);
    assert.ok(decoded.includes("'Расходы'!"), `нет явного листа в ${decoded}`);
  }
});

test('SHEET_GID не задан — запись заблокирована, Sheets не вызывается', async () => {
  delete env.SHEET_GID;
  await worker.fetch(req(privateMsg('кофе 250')), env);
  assert.equal(google.sheetCalls().filter((c) => c.method === 'POST').length, 0);
  assert.match(lastTelegramText(), /SHEET_GID не задан/);
});

test('SHEET_GID не существует в таблице — запись заблокирована', async () => {
  env.SHEET_GID = '999';
  await worker.fetch(req(privateMsg('кофе 250')), env);
  assert.equal(google.sheetCalls().filter((c) => c.method === 'POST').length, 0);
  assert.match(lastTelegramText(), /gid=999 не найден/);
});

// --- Добавление и безопасная запись ---

test('текст, похожий на формулу, пишется литералом (RAW)', async () => {
  await worker.fetch(req(privateMsg('=HYPERLINK("x") 100')), env);
  const append = google.sheetCalls().find((c) => c.path.endsWith(':append'));
  assert.match(append.search, /valueInputOption=RAW/);
  assert.equal(google.tab('Расходы').rows[1][7], '=HYPERLINK("x") 100');
});

test('слишком длинный текст отклоняется, запись не создаётся', async () => {
  await worker.fetch(req(privateMsg('к'.repeat(300) + ' 100')), env);
  assert.equal(google.sheetCalls().length, 0);
  assert.match(lastTelegramText(), /длиннее 200/);
});

test('управляющие символы в тексте заменяются пробелом', async () => {
  await worker.fetch(req(privateMsg('кофе\n250\tнал')), env);
  assert.equal(google.tab('Расходы').rows[1][7], 'кофе 250 нал');
});

// --- Редактирование: F:G сохраняются, stale-проверка ---

test('редактирование меняет B:E и H:I, ручные F:G остаются', async () => {
  seedExpenses([['04.12.2024 15:10', 500, 'RUB', 1, 500, 'Еда', 'Кафе', 'обед 500', 'Cash']]);
  const row = { row_number: 2, date: '04.12.2024 15:10', amount: '500', currency: 'RUB', raw_text: 'обед 500', source: 'Cash' };
  const fp = fingerprint(row);

  // шаг 1: edit_row возвращает подсказку с fingerprint
  await worker.fetch(req(callbackUpdate(`edit_row:2:${fp}`)), env);
  const prompt = lastTelegramText();
  assert.match(prompt, new RegExp(`стр\\. 2, #${fp}`));

  // шаг 2: ответ на подсказку
  const reply = privateMsg('такси 300 сбер', {
    reply_to_message: { message_id: 9, from: { id: 111, is_bot: true }, chat: { id: 42, type: 'private' }, text: prompt },
  });
  await worker.fetch(req(reply), env);

  const r = google.tab('Расходы').rows[1];
  assert.equal(r[1], 300);
  assert.equal(r[7], 'такси 300 сбер');
  assert.equal(r[8], 'Sber');
  assert.equal(r[5], 'Еда', 'F сохранена');
  assert.equal(r[6], 'Кафе', 'G сохранена');
  assert.equal(r[0], '04.12.2024 15:10', 'дата не меняется');

  const batch = google.sheetCalls().find((c) => c.path.endsWith('/values:batchUpdate'));
  const ranges = batch.body.data.map((d) => d.range);
  assert.deepEqual(ranges, ["'Расходы'!B2:E2", "'Расходы'!H2:I2"]);
});

test('редактирование строки, которая изменилась, отклоняется без записи', async () => {
  seedExpenses([['04.12.2024 15:10', 500, 'RUB', 1, 500, '', '', 'обед 500', 'Cash']]);
  const staleFp = '00000000';
  const prompt = `✏️ Редактирование строки (стр. 2, #${staleFp})\nИсходный текст: x`;
  const reply = privateMsg('такси 300', {
    reply_to_message: { message_id: 9, from: { id: 111, is_bot: true }, chat: { id: 42, type: 'private' }, text: prompt },
  });
  await worker.fetch(req(reply), env);
  assert.equal(google.sheetCalls().filter((c) => c.path.endsWith('/values:batchUpdate')).length, 0);
  assert.match(lastTelegramText(), /изменилась или не найдена/);
});

// --- Удаление: подтверждение и сверка строки ---

test('удаление: сначала подтверждение, таблица не меняется', async () => {
  seedExpenses([['04.12.2024 15:10', 500, 'RUB', 1, 500, '', '', 'обед 500', 'Cash']]);
  const row = { row_number: 2, date: '04.12.2024 15:10', amount: '500', currency: 'RUB', raw_text: 'обед 500', source: 'Cash' };
  const fp = fingerprint(row);
  await worker.fetch(req(callbackUpdate(`delete_row:2:${fp}`)), env);
  assert.equal(google.tab('Расходы').rows.length, 2);
  assert.equal(google.sheetCalls().filter((c) => c.path.endsWith(':batchUpdate')).length, 0);
  assert.match(lastEditText(), /Удалить запись \(стр\. 2\)/);
  const edit = google.telegramCalls('editMessageText').at(-1);
  assert.ok(JSON.stringify(JSON.parse(edit.raw).reply_markup).includes(`confirm_delete:2:${fp}`));
});

test('удаление после подтверждения: строка удаляется со сдвигом в нужном листе', async () => {
  seedExpenses([
    ['04.12.2024 15:10', 500, 'RUB', 1, 500, '', '', 'обед 500', 'Cash'],
    ['05.12.2024 09:00', 200, 'RUB', 1, 200, '', '', 'кофе 200', 'Sber'],
  ]);
  const row = { row_number: 2, date: '04.12.2024 15:10', amount: '500', currency: 'RUB', raw_text: 'обед 500', source: 'Cash' };
  await worker.fetch(req(callbackUpdate(`confirm_delete:2:${fingerprint(row)}`)), env);
  const rows = google.tab('Расходы').rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[1][7], 'кофе 200');
  assert.equal(google.tab('Общая').rows.length, 1);
});

test('подтверждение удаления со сдвинувшейся строкой отклоняется', async () => {
  // На месте строки 2 теперь другая запись: старый fingerprint не совпадает.
  seedExpenses([['05.12.2024 09:00', 200, 'RUB', 1, 200, '', '', 'кофе 200', 'Sber']]);
  const oldRow = { row_number: 2, date: '04.12.2024 15:10', amount: '500', currency: 'RUB', raw_text: 'обед 500', source: 'Cash' };
  await worker.fetch(req(callbackUpdate(`confirm_delete:2:${fingerprint(oldRow)}`)), env);
  assert.equal(google.tab('Расходы').rows.length, 2, 'ничего не удалено');
  assert.equal(google.sheetCalls().filter((c) => c.path.endsWith(':batchUpdate')).length, 0);
  assert.match(lastEditText(), /изменилась или не найдена/);
});

// --- Просмотр и fail path ---

test('/last показывает две последние записи из нужного листа', async () => {
  seedExpenses([
    ['01.12.2024 10:00', 100, 'RUB', 1, 100, '', '', 'а', 'Cash'],
    ['02.12.2024 11:00', 200, 'RUB', 1, 200, '', '', 'б', 'Cash'],
  ]);
  await worker.fetch(req(privateMsg('/last')), env);
  const text = lastTelegramText();
  assert.match(text, /1\. 11:00 02\/12 200 RUB Cash/);
  assert.match(text, /2\. 10:00 01\/12 100 RUB Cash/);
});

test('ошибка Sheets: владелец получает видимое сообщение, Worker отвечает 200', async () => {
  google.setFailSheets(true);
  const r = await worker.fetch(req(privateMsg('кофе 250')), env);
  assert.equal(r.status, 200);
  assert.match(lastTelegramText(), /Системная ошибка: Google Sheets 500/);
});

test('подсказка старого формата без fingerprint не запускает редактирование', async () => {
  seedExpenses([['04.12.2024 15:10', 500, 'RUB', 1, 500, '', '', 'обед 500', 'Cash']]);
  const reply = privateMsg('такси 300', {
    reply_to_message: { message_id: 9, from: { id: 111, is_bot: true }, chat: { id: 42, type: 'private' }, text: 'Редактирование строки (стр. 2)' },
  });
  await worker.fetch(req(reply), env);
  // Строка 2 не изменилась; текст обработан как новый расход
  assert.equal(google.sheetCalls().filter((c) => c.path.endsWith('/values:batchUpdate')).length, 0);
  assert.equal(google.tab('Расходы').rows[1][7], 'обед 500');
  assert.equal(google.tab('Расходы').rows.length, 3);
});

test('номер строки заголовка нельзя изменить или удалить', async () => {
  seedExpenses([]);
  await worker.fetch(req(callbackUpdate('confirm_delete:1:00000000')), env);
  assert.equal(google.tab('Расходы').rows.length, 1);
  assert.equal(google.sheetCalls().filter((c) => c.path.endsWith(':batchUpdate')).length, 0);
});
