// Поиск ЛПР в интернете. Два провайдера, выбираются в .env: SEARCH_PROVIDER
//
//   builtin — поиск встроен в API Anthropic, отдельных ключей не нужно.
//             Работает сразу, но опирается на западные индексы: региональные
//             российские источники видит хуже.
//   yandex  — Yandex Cloud Search API. Выдача по РФ заметно полнее, но нужны
//             аккаунт в Яндекс Облаке, API-ключ и folder id.
//   none    — этап отключён.
//
// Запросы собираются шаблоном в коде — нейросеть для этого не нужна.

import { withRetry } from './http.js';
import { logUsage } from './db.js';
import { getProvider } from './llm.js';

export const searchProviderName = () => (process.env.SEARCH_PROVIDER || 'builtin').toLowerCase();

/** Склонение слова: именительный / родительный / творительный. */
function wordForms(w) {
  const b = w.slice(0, -2), c = w.slice(0, -1);
  if (/ый$/.test(w)) return [w, b + 'ого', b + 'ым'];
  if (/ий$/.test(w)) return [w, b + 'его', b + 'им'];
  if (/ой$/.test(w)) return [w, b + 'ого', b + 'ым'];
  if (/ь$/.test(w))  return [w, c + 'я',   c + 'ем'];
  if (/[бвгджзклмнпрстфхцчшщ]$/i.test(w)) return [w, w + 'а', w + 'ом'];
  return [w, w, w];
}

/** Первая часть составного слова, которая не склоняется:
 *  «арт-директора», а не «арта-директора». В отличие от «инженера-технолога»,
 *  где обе части — полноценные существительные и склоняются обе. */
const INDECLINABLE_PREFIX = new Set([
  'арт', 'веб', 'интернет', 'медиа', 'бизнес', 'топ', 'бренд', 'пиар', 'гейм',
  'ивент', 'продакт', 'проджект', 'аккаунт', 'контент', 'тимлид', 'экс', 'вице',
  'пресс', 'смм', 'сео', 'ит', 'хр', 'бэк', 'фронт', 'фулл', 'дата', 'скрам',
]);

const isIndeclinable = (w) =>
  INDECLINABLE_PREFIX.has(w.toLowerCase()) || /^[a-z]+$/i.test(w) || w.length <= 3;

/** «главный инженер» → «главного инженера», «главным инженером». */
function caseForms(title) {
  const words = title.trim().split(/\s+/);
  const per = words.map((w) => {
    const parts = w.split('-');
    return parts.map((part, i) => {
      // в составном слове первые части часто неизменяемы, последняя склоняется
      const last = i === parts.length - 1;
      return (!last && isIndeclinable(part)) ? [part, part, part] : wordForms(part);
    });
  });
  const out = new Set();
  for (let i = 0; i < 3; i++) {
    out.add(per.map((parts) => parts.map((f) => f[i]).join('-')).join(' '));
  }
  return [...out];
}

/** Два запроса на компанию: по сайту и по названию рядом с должностью. */
export function buildQueries(company, titles) {
  const domain = company.domain;
  const short = (company.name ?? '').replace(/^(ООО|АО|ПАО|ЗАО|ОАО|НПО|ТД)\s*/i, '').replace(/["«»]/g, '').trim();
  const roles = titles.flatMap(caseForms);
  const roleGroup = roles.map((r) => `"${r}"`).join(' OR ');
  return [
    { kind: 'site',    q: `site:${domain} (${titles.map((t) => `"${t}"`).join(' OR ')})` },
    { kind: 'company', q: `"${short}" (${roleGroup})` },
  ];
}

// ─────────────────────────── Yandex Cloud Search API ───────────────────────────

async function yandexSearch(db, query, { limit = 10 } = {}) {
  const key = process.env.YANDEX_API_KEY;
  const folder = process.env.YANDEX_FOLDER_ID;
  if (!key || !folder) throw new Error('Для SEARCH_PROVIDER=yandex нужны YANDEX_API_KEY и YANDEX_FOLDER_ID');

  const res = await withRetry(async () => {
    const r = await fetch('https://searchapi.api.cloud.yandex.net/v2/web/search', {
      method: 'POST',
      headers: { Authorization: `Api-Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: { searchType: 'SEARCH_TYPE_RU', queryText: query },
        folderId: folder,
        // FORMAT_HTML вернёт отрисованную страницу выдачи целиком (под мегабайт);
        // структура нужна только в XML
        responseFormat: 'FORMAT_XML',
        l10n: 'LOCALIZATION_RU',
      }),
    });
    if (!r.ok) { const e = new Error(`Yandex ${r.status}: ${(await r.text()).slice(0, 200)}`); e.status = r.status; throw e; }
    return r.json();
  });

  const raw = res.rawData ? Buffer.from(res.rawData, 'base64').toString('utf8') : '';
  const out = parseYandexXml(raw, limit);
  // тарифицируется по запросам, а не по токенам — считаем единицы
  logUsage(db, { stage: 'search', provider: 'yandex', units: 1, usd: 0 });
  return out;
}

/** Разбор XML Яндекса. Вынесен отдельно, чтобы тестировать на сохранённом ответе. */
export function parseYandexXml(raw, limit = 10) {
  const strip = (s) => s
    .replace(/<[^>]+>/g, '')          // в том числе <hlword>, которыми подсвечены совпадения
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ').trim();

  const out = [];
  // у <doc> есть атрибуты: <doc id="...">
  for (const m of raw.matchAll(/<doc\b[^>]*>([\s\S]*?)<\/doc>/g)) {
    const d = m[1];
    const url = strip(d.match(/<url>([\s\S]*?)<\/url>/)?.[1] ?? '');
    if (!url) continue;
    const title = strip(d.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const passages = [...d.matchAll(/<passage>([\s\S]*?)<\/passage>/g)].map((p) => strip(p[1])).filter(Boolean);
    // modtime формата 20260325T161542
    const mt = d.match(/<modtime>(\d{4})(\d{2})(\d{2})/);
    out.push({
      url, title,
      snippet: passages.join(' ').slice(0, 600),
      date: mt ? `${mt[1]}-${mt[2]}-${mt[3]}` : '',
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ─────────────────────── Встроенный поиск (Anthropic) ───────────────────────

async function builtinSearch(client, db, query, { limit = 10 } = {}) {
  const p = getProvider();
  if (p.name !== 'anthropic') {
    throw new Error(
      'SEARCH_PROVIDER=builtin работает только с LLM_PROVIDER=anthropic.\n' +
      '  При работе через OpenAI укажите SEARCH_PROVIDER=yandex (или none).');
  }
  // Содержимое найденных страниц приходит зашифрованным: читать его может
  // только модель. Поэтому просим её саму выписать факты из выдачи —
  // разбирать сниппеты программно тут не получится.
  const res = await client.messages.create({
    model: process.env.SEARCH_MODEL || 'claude-haiku-4-5',
    max_tokens: 4000,
    // базовый вариант работает на всех моделях, включая дешёвые;
    // расширенный (_20260209) требует программного вызова инструментов
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    system:
      'Ты выполняешь поисковый запрос и выписываешь из выдачи только факты. ' +
      'Для каждого найденного результата, где упоминается человек и место его ' +
      'работы, выпиши строку вида:\n' +
      'ФИО | должность | адрес источника | год публикации\n' +
      'Если год неизвестен — поставь 0. Ничего не додумывай и не делай выводов. ' +
      'Если подходящих упоминаний нет — напиши «ничего не найдено».',
    messages: [{ role: 'user', content: `Поисковый запрос:\n${query}` }],
  });
  const u = res.usage ?? {};
  logUsage(db, {
    stage: 'search', provider: 'anthropic', model: res.model,
    tokens_in: u.input_tokens ?? 0, tokens_out: u.output_tokens ?? 0,
    usd: p.price(res.model, { tokens_in: u.input_tokens ?? 0, tokens_out: u.output_tokens ?? 0 }),
  });

  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text || /ничего не найдено/i.test(text)) return [];

  // адреса найденных страниц — из блоков результатов поиска
  const urls = [];
  for (const block of res.content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const it of block.content) if (it.url) urls.push({ url: it.url, title: it.title ?? '' });
  }

  // отдаём выписку модели как один «результат»: дальше её разбирает этап people
  return [{
    url: urls[0]?.url ?? '',
    title: 'выписка из поисковой выдачи',
    snippet: text.slice(0, 3000),
    date: '',
    urls: urls.slice(0, limit),
  }];
}

/** Единая точка входа. Возвращает [{url, title, snippet, date}]. */
export async function search(client, db, query, opts = {}) {
  const provider = searchProviderName();
  if (provider === 'none') return [];
  if (provider === 'yandex') return yandexSearch(db, query, opts);
  if (provider === 'builtin') return builtinSearch(client, db, query, opts);
  throw new Error(`Неизвестный SEARCH_PROVIDER="${provider}". Допустимо: builtin, yandex, none`);
}
