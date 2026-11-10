// Логика бота: маршрутизация обновлений Telegram. Состояния нет:
// режим редактирования определяется по reply на подсказку с "(стр. N, #fingerprint)".
// Любое действие над строкой сначала сверяет fingerprint, чтобы не затронуть сдвинувшуюся строку.

import { parseExpense, ParseError, detectExpenseDraft, completeExpenseDraft, hasUnresolvedAmountAmbiguity } from './parser.js';
import * as sheets from './sheets.js';
import * as tg from './telegram.js';
import { esc, formatAmount, formatShortDate } from './format.js';

const LIST_BUTTON = 'Посмотреть последние записи';
const EDIT_MARK = /Редактирование строки \(стр\. (\d+), #([0-9a-f]{8})\)/;
const EXPENSE_DRAFT_TTL_SECONDS = 5 * 60;
const EXPENSE_DRAFT_MARK = /\n\[\[TG_EXPENSE_DRAFT_V1\|(description|amount)\|([^\]\r\n]+)\]\]$/;

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

const STALE_TEXT = '⚠️ Запись изменилась или не найдена. Откройте список заново: /last';

function describeEntry(entry) {
  return `${formatShortDate(entry.timestamp)} ${esc(entry.amount)} ${esc(entry.currency)} ${esc(entry.source)} (<i>${esc(entry.description)}</i>)`;
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
    `<i>Описание: ${esc(entry.description)}</i>`
  );
}

function rowActionKeyboard(entry) {
  const n = entry.row_number;
  const fp = sheets.fingerprint(entry);
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✏️ Редактировать', callback_data: `edit_row:${n}:${fp}` }],
        [{ text: '🗑 Удалить', callback_data: `delete_row:${n}:${fp}` }],
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
  if (editMatch) return handleEditReply(env, chatId, msg, Number(editMatch[1]), editMatch[2]);

  const expenseDraft = readExpenseDraft(replyTo, chatId, env);
  if (expenseDraft) return handleExpenseDraftReply(env, chatId, msg, expenseDraft);

  return handleAdd(env, chatId, msg, text);
}

function readExpenseDraft(replyTo, chatId, env) {
  const configuredBotId = String(env.TELEGRAM_TOKEN ?? '').split(':', 1)[0];
  if (!replyTo?.from?.is_bot || String(replyTo.from.id) !== configuredBotId || String(replyTo.chat?.id) !== String(chatId)) return null;
  const match = EXPENSE_DRAFT_MARK.exec(replyTo.text ?? '');
  if (!match) return null;
  try {
    const text = decodeURIComponent(match[2]);
    const draft = detectExpenseDraft(text);
    return draft?.kind === match[1] && draft.text === text ? draft : null;
  } catch {
    return null;
  }
}

function expenseDraftPrompt(draft) {
  const prompt = draft.kind === 'description' ? 'Укажи описание.' : 'Укажи сумму и валюту, если она известна.';
  const marker = `[[TG_EXPENSE_DRAFT_V1|${draft.kind}|${encodeURIComponent(draft.text)}]]`;
  const placeholder = draft.kind === 'description' ? 'еда' : '40 VND';
  return {
    text: `📝 ${prompt} Ответь на это сообщение в течение 5 минут.\nЧерновик: <code>${esc(draft.text)}</code>\n${marker}`,
    options: { reply_markup: { force_reply: true, input_field_placeholder: placeholder } },
  };
}

async function promptForExpenseDraft(env, chatId, draft) {
  const prompt = expenseDraftPrompt(draft);
  return tg.sendMessage(env, chatId, prompt.text, prompt.options);
}

async function handleAdd(env, chatId, msg, text) {
  let expense;
  try {
    expense = parseExpense(text);
  } catch (err) {
    if (err instanceof ParseError) {
      if (err.code === 'missing_description' || err.code === 'missing_amount') {
        const draft = detectExpenseDraft(text);
        if (draft && ((err.code === 'missing_description' && draft.kind === 'description') || (err.code === 'missing_amount' && draft.kind === 'amount'))) {
          return promptForExpenseDraft(env, chatId, draft);
        }
      }
      return tg.sendMessage(env, chatId, `⚠️ ${esc(err.message)}`, MAIN_KEYBOARD);
    }
    throw err;
  }

  return saveExpense(env, chatId, msg, expense);
}

async function handleExpenseDraftReply(env, chatId, msg, draft) {
  if (hasUnresolvedAmountAmbiguity(msg.text)) {
    return tg.sendMessage(env, chatId, '⚠️ В ответе несколько возможных сумм. Укажи валюту или отправь расход целиком с одной суммой.', MAIN_KEYBOARD);
  }

  let expense;
  try {
    // A complete operation always stands alone, even when it replies to an older prompt.
    expense = parseExpense(msg.text);
  } catch (err) {
    if (!(err instanceof ParseError) || !['missing_amount', 'missing_description'].includes(err.code)) {
      if (err instanceof ParseError) return tg.sendMessage(env, chatId, `⚠️ ${esc(err.message)}`, MAIN_KEYBOARD);
      throw err;
    }

    const promptDate = Number(msg.reply_to_message?.date);
    const replyDate = Number(msg.date);
    if (!Number.isFinite(promptDate) || !Number.isFinite(replyDate) || replyDate < promptDate || replyDate - promptDate > EXPENSE_DRAFT_TTL_SECONDS) {
      return tg.sendMessage(env, chatId, '⌛ Черновик истёк. Отправь расход целиком одним сообщением.', MAIN_KEYBOARD);
    }

    try {
      expense = completeExpenseDraft(draft.text, msg.text, draft.kind);
    } catch (draftError) {
      if (draftError instanceof ParseError) return tg.sendMessage(env, chatId, `⚠️ ${esc(draftError.message)}`, MAIN_KEYBOARD);
      throw draftError;
    }
  }

  return saveExpense(env, chatId, msg, expense);
}

async function saveExpense(env, chatId, msg, expense) {
  await sheets.appendExpense(env, expense, new Date(msg.date * 1000));
  const reply =
    `✅ Добавлено: ${esc(expense.description)} | ${formatAmount(expense.amount)} ${expense.currency} | ${esc(expense.source)}`;
  return tg.sendMessage(env, chatId, reply, MAIN_KEYBOARD);
}

async function handleEditReply(env, chatId, msg, rowNumber, fp) {
  let expense;
  try {
    expense = parseExpense(msg.text);
  } catch (err) {
    if (err instanceof ParseError) {
      // Остаёмся в режиме редактирования: пользователь может ответить на ту же подсказку ещё раз.
      return tg.sendMessage(env, chatId, `⚠️ ${esc(err.message)}`);
    }
    throw err;
  }

  const current = await sheets.getRow(env, rowNumber);
  if (!current || sheets.fingerprint(current) !== fp) {
    return tg.sendMessage(env, chatId, STALE_TEXT, MAIN_KEYBOARD);
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
  const [action, arg, fp] = String(cq.data ?? '').split(':');
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
      if (!entry) return tg.editMessage(env, chatId, messageId, '⚠️ Запись не найдена. Обновите список: /last');
      return tg.editMessage(env, chatId, messageId, renderDetails(entry), rowActionKeyboard(entry));
    }

    case 'edit_row': {
      const entry = await sheets.getRow(env, rowNumber);
      if (!entry || sheets.fingerprint(entry) !== fp) return tg.sendMessage(env, chatId, STALE_TEXT);
      // Подсказка с force_reply: ответ на неё несёт номер строки и fingerprint в тексте родителя.
      return tg.sendMessage(
        env,
        chatId,
        `✏️ Редактирование строки (стр. ${rowNumber}, #${fp})\n` +
          `Текущая запись: <code>${esc(entry.description)} ${esc(entry.amount)} ${esc(entry.currency)} ${esc(entry.source)}</code>\n\n` +
          'Ответьте на это сообщение новым текстом записи. /cancel — отмена.',
        { reply_markup: { force_reply: true, input_field_placeholder: 'продукты 500 тбанк' } },
      );
    }

    case 'delete_row': {
      // Шаг 1: только запрос подтверждения, без изменений в таблице.
      const entry = await sheets.getRow(env, rowNumber);
      if (!entry || sheets.fingerprint(entry) !== fp) {
        return tg.editMessage(env, chatId, messageId, STALE_TEXT);
      }
      return tg.editMessage(
        env,
        chatId,
        messageId,
        `⚠️ <b>Удалить запись (стр. ${rowNumber})?</b>\n\n${describeEntry(entry)}\n\nДействие нельзя отменить.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🗑 Да, удалить', callback_data: `confirm_delete:${rowNumber}:${fp}` }],
              [{ text: '✖️ Нет, назад', callback_data: `select_row:${rowNumber}` }],
            ],
          },
        },
      );
    }

    case 'confirm_delete': {
      // Шаг 2: повторная проверка fingerprint прямо перед удалением.
      const entry = await sheets.getRow(env, rowNumber);
      if (!entry || sheets.fingerprint(entry) !== fp) {
        return tg.editMessage(env, chatId, messageId, STALE_TEXT);
      }
      await sheets.deleteRow(env, rowNumber);
      return tg.editMessage(env, chatId, messageId, '✅ Запись удалена.');
    }

    default:
      return null;
  }
}

/**
 * Обрабатывает один update Telegram.
 * Работает только с личным чатом владельца; всё остальное игнорируется без ответа.
 * Ошибки логируются и показываются владельцу в чате (Telegram не повторяет update: см. README).
 */
export async function handleUpdate(env, update) {
  const from = update?.message?.from ?? update?.callback_query?.from;
  const chat = update?.message?.chat ?? update?.callback_query?.message?.chat;
  const isOwner = from && String(from.id) === String(env.ALLOWED_USER_ID);
  const isPrivateOwnerChat = chat?.type === 'private' && String(chat.id) === String(from?.id);
  if (!isOwner || !isPrivateOwnerChat) return;

  try {
    if (update.callback_query) return await handleCallback(env, update.callback_query);
    if (update.message?.text) return await handleText(env, update.message);
    return null;
  } catch (err) {
    console.error('update failed:', err?.message);
    await tg.sendMessage(env, chat.id, `❌ Системная ошибка: ${esc(err?.message)}`).catch(() => {});
    return null;
  }
}
