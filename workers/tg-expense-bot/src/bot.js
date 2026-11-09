// Логика бота: маршрутизация обновлений Telegram. Состояния нет:
// режим редактирования определяется по reply на сообщение-подсказку с "(стр. N)".

import { parseExpense, ParseError } from './parser.js';
import * as sheets from './sheets.js';
import * as tg from './telegram.js';
import { esc, formatAmount, formatShortDate } from './format.js';

const LIST_BUTTON = 'Посмотреть последние записи';
const EDIT_MARK = /Редактирование строки \(стр\. (\d+)\)/;

const MAIN_KEYBOARD = {
  reply_markup: { keyboard: [[{ text: LIST_BUTTON }]], resize_keyboard: true },
};

const START_TEXT =
  '👋 Привет! Я бот для учета расходов.\n' +
  'Просто отправь мне сумму и описание, например:\n' +
  'продукты 500 тбанк';

const HELP_TEXT =
  '🤖 <b>Справка по командам:</b>\n\n' +
  '📝 <b>Добавление расхода:</b>\n' +
  'Просто напишите сообщение, например:\n' +
  '• <i>продукты 500</i>\n' +
  '• <i>такси 300 сбер</i>\n' +
  '• <i>30 usd подарок</i>\n' +
  '• <i>50000 vnd кофе</i>\n' +
  '• <i>12.50 eur чай</i>\n\n' +
  '🛠 <b>Команды:</b>\n' +
  '/start — Перезапуск и показ меню\n' +
  '/help — Эта справка\n' +
  '/last — Показать последние записи\n' +
  '/cancel — Отменить редактирование';

const HOME_TEXT =
  '🏠 Главное меню\n\n' +
  'Просто отправь мне сумму и описание, например: продукты 500 тбанк.';

function describeEntry(entry) {
  return `${formatShortDate(entry.date)} ${esc(entry.amount)} ${entry.currency} ${esc(entry.source)} (<i>${esc(entry.raw_text)}</i>)`;
}

function renderList(rows) {
  const lines = rows.map((r, i) => `${i + 1}. ${describeEntry(r)}`);
  const text = `📋 <b>Последние записи:</b>\n\n${lines.join('\n')}`;
  const keyboard = rows.map((r, i) => [{ text: `Запись ${i + 1}`, callback_data: `select_row:${r.row_number}` }]);
  keyboard.push([{ text: '🏠 В начало', callback_data: 'home' }]);
  return { text, markup: { reply_markup: { inline_keyboard: keyboard } } };
}

function renderDetails(entry) {
  return (
    `🔍 <b>Детали записи (стр. ${entry.row_number}):</b>\n\n` +
    `${describeEntry(entry)}\n\n` +
    `<i>Исходный текст: ${esc(entry.raw_text)}</i>`
  );
}

function rowActionKeyboard(rowNumber) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✏️ Редактировать', callback_data: `edit_row:${rowNumber}` }],
        [{ text: '🗑 Удалить', callback_data: `delete_row:${rowNumber}` }],
        [{ text: '🔙 Назад', callback_data: 'back_to_list' }],
        [{ text: '🏠 В начало', callback_data: 'home' }],
      ],
    },
  };
}

async function sendList(env, chatId) {
  const rows = await sheets.getLastRows(env, 4);
  if (rows.length === 0) {
    return tg.sendMessage(env, chatId, '📋 Список пуст.', MAIN_KEYBOARD);
  }
  const { text, markup } = renderList(rows);
  return tg.sendMessage(env, chatId, text, markup);
}

async function handleText(env, msg) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === '/start') return tg.sendMessage(env, chatId, START_TEXT, MAIN_KEYBOARD);
  if (text === '/help') return tg.sendMessage(env, chatId, HELP_TEXT, MAIN_KEYBOARD);
  if (text === '/last' || text === LIST_BUTTON) return sendList(env, chatId);
  if (text === '/cancel') return tg.sendMessage(env, chatId, '❌ Отменено.', MAIN_KEYBOARD);
  if (text.startsWith('/')) return tg.sendMessage(env, chatId, 'Неизвестная команда. Смотрите /help.');

  const replyTo = msg.reply_to_message;
  const editMatch = replyTo?.from?.is_bot ? EDIT_MARK.exec(replyTo.text ?? '') : null;
  if (editMatch) return handleEditReply(env, chatId, msg, Number(editMatch[1]));

  return handleAdd(env, chatId, msg, text);
}

async function handleAdd(env, chatId, msg, text) {
  let expense;
  try {
    expense = parseExpense(text);
  } catch (err) {
    if (err instanceof ParseError) return tg.sendMessage(env, chatId, `⚠️ ${esc(err.message)}`, MAIN_KEYBOARD);
    throw err;
  }

  await sheets.appendExpense(env, expense, new Date(msg.date * 1000));
  const reply =
    `✅ Добавлено: ${esc(expense.description)} | ${formatAmount(expense.amount)} ${expense.currency} | ${esc(expense.source)}`;
  return tg.sendMessage(env, chatId, reply, MAIN_KEYBOARD);
}

async function handleEditReply(env, chatId, msg, rowNumber) {
  let expense;
  try {
    expense = parseExpense(msg.text);
  } catch (err) {
    if (err instanceof ParseError) {
      // Остаёмся в режиме редактирования: пользователь может ответить на то же сообщение ещё раз.
      return tg.sendMessage(env, chatId, `⚠️ ${esc(err.message)}`);
    }
    throw err;
  }

  await sheets.updateRow(env, rowNumber, expense);
  const reply =
    `✅ Обновлено (стр. ${rowNumber}):\n` +
    `${esc(expense.description)} - ${formatAmount(expense.amount)} ${expense.currency} - ${esc(expense.source)}`;
  return tg.sendMessage(env, chatId, reply, MAIN_KEYBOARD);
}

async function handleCallback(env, cq) {
  await tg.answerCallback(env, cq.id);
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const [action, arg] = String(cq.data ?? '').split(':');
  const rowNumber = Number(arg);

  switch (action) {
    case 'home':
      return tg.editMessage(env, chatId, messageId, HOME_TEXT);

    case 'back_to_list': {
      const rows = await sheets.getLastRows(env, 4);
      if (rows.length === 0) return tg.editMessage(env, chatId, messageId, '📋 Список пуст.');
      const { text, markup } = renderList(rows);
      return tg.editMessage(env, chatId, messageId, text, markup);
    }

    case 'select_row': {
      const entry = await sheets.getRow(env, rowNumber);
      if (!entry) return tg.editMessage(env, chatId, messageId, '⚠️ Запись не найдена. Обновите список.');
      return tg.editMessage(env, chatId, messageId, renderDetails(entry), rowActionKeyboard(rowNumber));
    }

    case 'edit_row': {
      const entry = await sheets.getRow(env, rowNumber);
      if (!entry) return tg.sendMessage(env, chatId, '⚠️ Запись не найдена. Обновите список.');
      // Подсказка с force_reply: ответ на неё несёт номер строки в тексте родительского сообщения.
      return tg.sendMessage(
        env,
        chatId,
        `✏️ Редактирование строки (стр. ${rowNumber})\n` +
          `Исходный текст: <code>${esc(entry.raw_text)}</code>\n\n` +
          'Ответьте на это сообщение новым текстом записи. /cancel — отмена.',
        { reply_markup: { force_reply: true, input_field_placeholder: 'продукты 500 тбанк' } },
      );
    }

    case 'delete_row':
      await sheets.deleteRow(env, rowNumber);
      return tg.editMessage(env, chatId, messageId, '✅ Запись удалена.');

    default:
      return null;
  }
}

/**
 * Обрабатывает один update Telegram. Чужие пользователи игнорируются без ответа.
 */
export async function handleUpdate(env, update) {
  const from = update?.message?.from ?? update?.callback_query?.from;
  if (!from || String(from.id) !== String(env.ALLOWED_USER_ID)) return;

  try {
    if (update.callback_query) return await handleCallback(env, update.callback_query);
    if (update.message?.text) return await handleText(env, update.message);
    return null;
  } catch (err) {
    console.error('update failed:', err?.message);
    const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (chatId) {
      await tg.sendMessage(env, chatId, `❌ Системная ошибка: ${esc(err?.message)}`).catch(() => {});
    }
    return null;
  }
}
