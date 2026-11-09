// Минимальный fake Google Sheets + Telegram + OAuth для тестов. Хранит строки в памяти.
// Нужен, чтобы проверять не только запросы, а итоговое содержимое вкладок.

export const SPREADSHEET_ID = 'sheet-id';
export const GID_MAIN = 0;
export const GID_EXPENSES = 555;

const COL_LETTERS = 'ABCDEFGHI';

function parseBody(raw) {
  if (!raw || typeof raw !== 'string') return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

export function createFakeGoogle({ tabs } = {}) {
  const store = tabs ?? [
    { sheetId: GID_MAIN, title: 'Общая', rows: [['Дата', 'Сумма', 'Валюта', 'Курс', 'RUB', 'Категория', 'Подкатегория', 'Текст', 'Источник']] },
    { sheetId: GID_EXPENSES, title: 'Расходы', rows: [['Дата', 'Сумма', 'Валюта', 'Курс', 'RUB', 'Категория', 'Подкатегория', 'Текст', 'Источник']] },
  ];
  const byTitle = (title) => {
    const tab = store.find((t) => t.title === title);
    if (!tab) throw new Error(`fake: no tab ${title}`);
    return tab;
  };
  const calls = [];
  let failSheets = false;

  function parseA1(decoded) {
    const m = /^'((?:[^']|'')+)'!([A-Z]+)(\d*):([A-Z]+)(\d*)$/.exec(decoded);
    if (!m) throw new Error(`fake: unsupported range ${decoded}`);
    return {
      title: m[1].replace(/''/g, "'"),
      colFrom: COL_LETTERS.indexOf(m[2]),
      rowFrom: m[3] ? Number(m[3]) : null,
      colTo: COL_LETTERS.indexOf(m[4]),
      rowTo: m[5] ? Number(m[5]) : null,
    };
  }

  function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  }

  async function handle(url, init = {}) {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    const body = parseBody(init.body);
    calls.push({ url: u.toString(), method, body, raw: init.body, path: decodeURIComponent(u.pathname), search: u.search });

    if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'tok', expires_in: 3600 });
    if (u.hostname === 'api.telegram.org') return json({ ok: true, result: { message_id: 1 } });
    if (u.hostname !== 'sheets.googleapis.com') return new Response('unexpected', { status: 500 });

    if (failSheets) return json({ error: { message: 'boom' } }, 500);

    const base = `/v4/spreadsheets/${SPREADSHEET_ID}`;
    const rest = u.pathname.slice(base.length);

    // Метаданные листов
    if (method === 'GET' && rest === '' && u.searchParams.has('fields')) {
      return json({ sheets: store.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title } })) });
    }

    // values:batchUpdate
    if (method === 'POST' && rest === '/values:batchUpdate') {
      for (const d of body.data) {
        const r = parseA1(d.range);
        const tab = byTitle(r.title);
        d.values.forEach((vals, i) => {
          const rowIdx = r.rowFrom + i - 1;
          tab.rows[rowIdx] = tab.rows[rowIdx] ?? [];
          vals.forEach((v, j) => { tab.rows[rowIdx][r.colFrom + j] = v; });
        });
      }
      return json({ totalUpdatedRows: body.data.length });
    }

    // structural batchUpdate (deleteDimension)
    if (method === 'POST' && rest === ':batchUpdate') {
      for (const req of body.requests) {
        const { sheetId, startIndex, endIndex } = req.deleteDimension.range;
        const tab = store.find((t) => t.sheetId === sheetId);
        if (!tab) return json({ error: { message: 'no sheetId' } }, 400);
        tab.rows.splice(startIndex, endIndex - startIndex);
      }
      return json({});
    }

    if (rest.startsWith('/values/')) {
      const encoded = rest.slice('/values/'.length);
      const decoded = decodeURIComponent(encoded);
      if (method === 'POST' && decoded.endsWith(':append')) {
        const r = parseA1(decoded.slice(0, -':append'.length));
        byTitle(r.title).rows.push(body.values[0].slice());
        return json({});
      }
      const r = parseA1(decoded);
      const tab = byTitle(r.title);
      if (method === 'GET') {
        if (r.rowFrom === null) {
          // A:A — колонка A до последней непустой строки
          let last = -1;
          tab.rows.forEach((row, i) => { if (row?.[0] !== undefined && row[0] !== '') last = i; });
          return json({ values: tab.rows.slice(0, last + 1).map((row) => [row?.[0] ?? '']) });
        }
        const from = r.rowFrom - 1;
        const to = r.rowTo;
        const values = tab.rows.slice(from, to).map((row) => {
          const cells = [];
          for (let c = r.colFrom; c <= r.colTo; c++) cells.push(row?.[c] ?? '');
          while (cells.length && cells[cells.length - 1] === '') cells.pop();
          return cells;
        });
        // Sheets не возвращает пустые хвостовые строки
        while (values.length && values[values.length - 1].length === 0) values.pop();
        return json(values.length ? { values } : {});
      }
    }

    return new Response('fake: unhandled', { status: 500 });
  }

  return {
    fetch: handle,
    calls,
    tab: byTitle,
    setFailSheets(v) { failSheets = v; },
    sheetCalls: () => calls.filter((c) => c.url.includes('sheets.googleapis.com')),
    telegramCalls: (method) => calls.filter((c) => c.url.includes('api.telegram.org') && (!method || c.url.includes(`/${method}`))),
  };
}
