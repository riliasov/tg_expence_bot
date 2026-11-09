// Минимальный клиент Telegram Bot API поверх fetch.

async function call(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const description = data.description ?? `HTTP ${res.status}`;
    // Повторное редактирование тем же текстом — не ошибка для пользователя.
    if (description.includes('message is not modified')) return null;
    throw new Error(`Telegram ${method}: ${description}`);
  }
  return data.result;
}

export const sendMessage = (env, chatId, text, extra = {}) =>
  call(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

export const editMessage = (env, chatId, messageId, text, extra = {}) =>
  call(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });

export const answerCallback = (env, callbackQueryId) =>
  call(env, 'answerCallbackQuery', { callback_query_id: callbackQueryId });
