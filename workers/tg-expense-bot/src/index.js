// Точка входа Cloudflare Worker: приём webhook от Telegram.

import { handleUpdate } from './bot.js';

const enc = new TextEncoder();

// Сравнение за постоянное время, чтобы не подбирать secret по задержкам.
export function safeEqual(a, b) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });

    const secret = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
    if (!env.WEBHOOK_SECRET || !safeEqual(secret, env.WEBHOOK_SECRET)) {
      return new Response('Forbidden', { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    // Ошибки обрабатываются внутри handleUpdate; всегда отвечаем 200, чтобы Telegram не повторял update.
    await handleUpdate(env, update);
    return new Response('ok');
  },
};
