// Поиск ЛПР в интернете. Два провайдера, выбираются в .env: SEARCH_PROVIDER
//
//   builtin — поиск встроен в API Anthropic, отдельных ключей не нужно.
//             Работает сразу, но опирается на западные индексы: региональные
//             российские источники видит хуже.
//   yandex  — Yandex Cloud Search API. Выдача по РФ заметно полнее, но нужны
//             аккаунт в Яндекс Облаке, API-ключ и folder id.
//   none    — этап отключён.
//   auto    — значение по умолчанию: Яндекс, если его ключи заполнены,
//             иначе встроенный. Отдельно переключать ничего не нужно.
//
// Запросы собираются шаблоном в коде — нейросеть для этого не нужна.

import { withRetry } from './http.js';
import { logUsage } from './db.js';
import { getProvider } from './llm.js';

/** Ключи Яндекса заполнены? Пустая строка и пробелы не считаются. */
export const yandexKeysPresent = () =>
  (process.env.YANDEX_API_KEY ?? '').trim().length > 5 &&
  (process.env.YANDEX_FOLDER_ID ?? '').trim().length > 5;

/** Ключ Serper (Google через API) заполнен? */
export const serperKeyPresent = () => (process.env.SERPER_API_KEY ?? '').trim().length > 5;

/** Ключи официального Google Custom Search заполнены? */
export const googleKeysPresent = () =>
  (process.env.GOOGLE_API_KEY ?? '').trim().length > 5 &&
  (process.env.GOOGLE_CX ?? '').trim().length > 3;

/** Ключи XMLRiver (Google или Яндекс через API) заполнены? */
export const xmlriverKeysPresent = () =>
  (process.env.XMLRIVER_USER ?? '').trim().length > 0 &&
  (process.env.XMLRIVER_KEY ?? '').trim().length > 5;

/** Отправлять запросы в Яндекс отложенно? Это в 16 раз дешевле обычного
 *  режима, но ответ приходит не сразу. Спрашивается у пользователя. */
export const yandexDeferred = () => (process.env.YANDEX_DEFERRED ?? 'false') === 'true';

/**
 * Полный каталог способов искать людей — единственный источник правды
 * и для меню выбора, и для проверки настройки, и для объяснений агента.
 *
 * Показываем ВСЕ варианты, включая те, на которые ключа ещё нет: иначе
 * пользователь не знает, из чего выбирает, и не может оценить, стоит ли
 * заводить ещё один ключ. Цена у большинства — за один поисковый запрос,
 * у встроенного поиска — сразу за компанию: внутри одного вызова модель
 * делает несколько поисков и платит ещё и за токены.
 */
export function searchOptions() {
  return [
    {
      id: 'yandex-deferred', label: 'Яндекс Search API, отложенные запросы',
      region: 'Россия', speed: 'ответ от минут до нескольких часов',
      usdPerQuery: YANDEX_RUB_DEFERRED / USD_RUB, ready: yandexKeysPresent(),
      need: 'YANDEX_API_KEY + YANDEX_FOLDER_ID', where: 'console.yandex.cloud',
      note: 'самый дешёвый вариант: в 16 раз дешевле обычных запросов',
    },
    {
      id: 'yandex', label: 'Яндекс Search API, обычные запросы',
      region: 'Россия', speed: 'ответ сразу',
      usdPerQuery: YANDEX_RUB / USD_RUB, ready: yandexKeysPresent(),
      need: 'YANDEX_API_KEY + YANDEX_FOLDER_ID', where: 'console.yandex.cloud',
      note: 'дороже отложенных, зато не надо ждать',
    },
    {
      id: 'serper', label: 'Google через Serper',
      region: 'весь мир', speed: 'ответ сразу',
      usdPerQuery: SERPER_USD, ready: serperKeyPresent(),
      need: 'SERPER_API_KEY', where: 'serper.dev',
      note: 'обычная гугловая выдача, видит LinkedIn',
    },
    {
      id: 'xmlriver', label: 'Google или Яндекс через XMLRiver',
      region: 'весь мир', speed: 'ответ сразу',
      usdPerQuery: XMLRIVER_RUB / USD_RUB, ready: xmlriverKeysPresent(),
      need: 'XMLRIVER_USER + XMLRIVER_KEY', where: 'xmlriver.com',
      note: 'российский сервис-посредник, оплата в рублях',
    },
    {
      id: 'google', label: 'Google Custom Search API (официальный)',
      region: 'весь мир', speed: 'ответ сразу',
      usdPerQuery: GOOGLE_USD, ready: googleKeysPresent(),
      need: 'GOOGLE_API_KEY + GOOGLE_CX', where: 'developers.google.com/custom-search',
      note: 'ЗАКРЫТ для новых клиентов, работает до 01.01.2027; 100 запросов в день бесплатно',
    },
    {
      id: 'builtin', label: 'Встроенный поиск внутри API Anthropic',
      region: 'весь мир', speed: 'ответ сразу',
      usdPerCompany: BUILTIN_USD_PER_COMPANY, ready: builtinAvailable(),
      need: 'LLM_PROVIDER=anthropic', where: 'отдельного ключа не нужно',
      note: 'САМЫЙ ДОРОГОЙ: примерно в 50 раз дороже отложенных запросов Яндекса',
    },
  ];
}

/** Какой поиск использовать.
 *
 *  auto выбирает из ОПЛАЧИВАЕМЫХ ключом движков и никогда не включает
 *  встроенный поиск сам. Раньше включал: при пустых ключах Яндекса auto
 *  уходил в builtin, а запуск не из терминала молча брал первый пункт меню,
 *  где стоял «Яндекс + Google». Встроенный поиск — самый дорогой в конвейере,
 *  около 15 ₽ на компанию против 0.27 ₽ у отложенного Яндекса, и узнать
 *  об этом пользователь мог только из счёта. Теперь он включается
 *  исключительно явной строкой SEARCH_PROVIDER=builtin. */
export function searchProviderName() {
  const set = (process.env.SEARCH_PROVIDER ?? '').trim().toLowerCase();
  if (set && set !== 'auto') return set;
  if (yandexKeysPresent()) return 'yandex';
  if (serperKeyPresent()) return 'serper';
  if (xmlriverKeysPresent()) return 'xmlriver';
  if (googleKeysPresent()) return 'google';
  return 'none';
}

/** Сколько отдельных поисковых фраз просить у встроенного поиска на компанию.
 *  Каждая — отдельный вызов web_search ($0.01), поэтому не безлимитно. */
const BUILTIN_MAX_QUERIES = Number(process.env.BUILTIN_MAX_QUERIES ?? 8);

/** Название компании без организационной формы и кавычек: в поиск идёт
 *  «РДТЕХ», а не «ООО "РДТЕХ"» — так же, как его набирают руками. */
const shortName = (name) => (name ?? '')
  .replace(/^(ООО|АО|ПАО|ЗАО|ОАО|НПО|ТД)\s*/i, '').replace(/["«»]/g, '').trim();

/** Запросы для встроенного поиска — по одному на должность, каждый отдельным
 *  вызовом модели.
 *
 *  Формулировка буквальная («PR-директор Авито»), как в рабочем промпте Clay:
 *  по ней находятся интервью, новости, кейсы агентств и LinkedIn, который
 *  Яндекс не отдаёт вовсе.
 *
 *  Почему по одному вызову на запрос, а не восемь поисков в одном. Во-первых,
 *  внимание: к восьмому поиску в общем контексте лежат результаты предыдущих
 *  семи, и модель отвечает уже по каше. Во-вторых, деньги — и это главное.
 *  Внутри одного вызова каждый следующий поиск оплачивает весь накопленный
 *  контекст заново: восемь поисков — это девять проходов по растущей ленте,
 *  ~100k входных токенов вместо ~26k теми же восемью запросами по отдельности.
 *  Замер на живых вызовах: 16.5k токенов уже при трёх поисках в одном вызове. */
export function builtinQueries(company, titles) {
  const list = [...new Set(titles.map((t) => String(t).trim()).filter(Boolean))]
    .slice(0, BUILTIN_MAX_QUERIES);
  const short = shortName(company.name);
  if (!short) return [];
  return list.map((t) => ({
    q: `${t} ${short}`,
    text:
      `Найди через web_search по запросу: ${t} ${short}\n\n` +
      `Посмотри верхние результаты выдачи — интервью, новости, кейсы ` +
      `диджитал-агентств, LinkedIn-профили, упоминания на профильных ` +
      `площадках — и выпиши всех, кто по этим источникам работает ` +
      `в компании «${short}».`,
  }));
}

/** Встроенный поиск живёт внутри API Anthropic. На OpenAI его нет вовсе,
 *  и раньше это выяснялось только в прогоне: режим «Яндекс + Google»
 *  предлагался всем, а потом падал с ошибкой на каждой компании. */
export const builtinAvailable = () => getProvider().name === 'anthropic';

/** Ключи есть, но выбран другой поиск — сказать вслух, а не молчать. */
export function searchProviderNote() {
  const set = (process.env.SEARCH_PROVIDER ?? '').trim().toLowerCase();
  if (!yandexKeysPresent()) return null;
  if (set === 'builtin')
    return 'ключи Яндекса заполнены, но в .env стоит SEARCH_PROVIDER=builtin — '
         + 'поиск идёт встроенным, Яндекс не используется. Поставьте auto или yandex.';
  if (set === 'none')
    return 'ключи Яндекса заполнены, но поиск ЛПР выключен: SEARCH_PROVIDER=none.';
  return null;
}

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

// Предел длины запроса у Яндекса — 400 символов. Берём с запасом: всё, что
// не влезло, раньше просто пропадало, и должности из конца списка в поиск
// не попадали вообще.
const MAX_QUERY_CHARS = 380;

/** Слова, которые означают «начальник», а не предметную область. */
const ROLE_WORDS = new Set([
  'директор', 'директора', 'директором', 'руководитель', 'руководителя', 'начальник',
  'начальника', 'глава', 'главы', 'заместитель', 'зам', 'ведущий', 'главный', 'старший',
  'менеджер', 'специалист', 'сотрудник', 'по', 'и', 'отдел', 'отдела', 'департамент',
  'департамента', 'управление', 'управления', 'дирекции', 'дирекция', 'службы', 'служба',
  'группы', 'группа', 'направления', 'подразделения',
  'head', 'of', 'chief', 'officer', 'lead', 'leader', 'director', 'manager', 'managing',
  'senior', 'principal', 'vp', 'vice', 'president', 'executive', 'and', 'the',
  'department', 'team', 'global',
]);

/** Слова-начальники для широкого запроса. */
const ROLE_HEADS = ['директор', 'руководитель', 'начальник', 'head', 'chief', 'lead'];

/** Оператор «или» у Яндекса — вертикальная черта. Слово OR он ищет как слово,
 *  из-за чего выдача сокращалась: 5 результатов вместо 10 на том же запросе. */
const OR = ' | ';

/** Предметные слова из списка должностей: «маркетинг», «дизайн», «продаж».
 *
 *  Нужны для широкого запроса. Список должностей всегда неполный: у человека
 *  в профиле может стоять «Руководитель отдела маркетинга», хотя в списке
 *  написано «Директор по маркетингу». Точные фразы такого не находят,
 *  а «маркетинг + руководитель» находит. */
export function topicWords(titles, limit = 6) {
  const count = new Map();      // ключ — грубая основа слова, чтобы
  const sample = new Map();     // «маркетинга» и «маркетингу» не считались раздельно
  for (const t of titles) {
    for (const w of String(t).toLowerCase().split(/[^\p{L}]+/u)) {
      if (w.length < 3 || ROLE_WORDS.has(w)) continue;
      const stem = w.slice(0, 5);
      count.set(stem, (count.get(stem) ?? 0) + 1);
      if (!sample.has(stem)) sample.set(stem, w);
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([stem]) => sample.get(stem));
}

/** Сколько отдельных запросов по должностям делать на компанию. */
const TITLE_QUERIES = Number(process.env.TITLE_QUERIES ?? 8);

/** Запросы по компании.
 *
 *  Что изменилось и почему:
 *
 *  1. Убраны кавычки. Было «"РДТЕХ" "Директор по маркетингу"» — строгая фраза,
 *     страница обязана содержать её дословно. У человека на сайте написано
 *     «Директор департамента маркетинга», и под закавыченный запрос эта
 *     страница не подходит вообще. Так был потерян живой ЛПР, которого
 *     по незакавыченному «директор по маркетингу РДТЕХ» находит и Clay,
 *     и обычный поиск руками.
 *
 *  2. Убраны site:-запросы по списку площадок. Белый список из восьми доменов
 *     съедал два запроса из восьми и по определению неполон: про людей пишут
 *     десятки тысяч площадок, от отраслевых СМИ до микроблогов. Страницу,
 *     которая ранжируется, обычный запрос найдёт и так, а освободившийся
 *     бюджет уходит на дополнительные должности.
 *
 *  3. Должности спрашиваются по одной. Длинный OR возвращает столько же
 *     результатов, но ранжирует хуже: по запросу «КОРУС Консалтинг директор
 *     по маркетингу» в выдаче есть профиль человека, по тому же запросу
 *     в составе OR из тринадцати фраз — нет.
 *
 *  Про LinkedIn: Яндекс его не отдаёт (проверено — ноль результатов на всех
 *  вариантах запроса), поэтому за LinkedIn отвечает встроенный поиск. */
export function buildQueries(company, titles, { maxChars = MAX_QUERY_CHARS } = {}) {
  const short = shortName(company.name);
  const list = [...new Set(titles.map((t) => String(t).trim()).filter(Boolean))];
  const out = [];
  if (!short) return out;

  // «директор по маркетингу РДТЕХ» — ровно так, как набрал бы человек
  for (const t of list.slice(0, TITLE_QUERIES)) out.push({ kind: 'title', q: `${t} ${short}` });

  // Широкий запрос — единственный, где название остаётся в кавычках: это
  // не человеческая формулировка, а сеть из операторов, и без точного
  // названия она вылавливает однофамильцев чужих компаний.
  const topics = topicWords(list);
  if (topics.length) {
    out.push({ kind: 'broad', q: `"${short}" (${topics.join(OR)}) (${ROLE_HEADS.join(OR)})` });
  }
  return out.filter((x) => x.q.length <= maxChars);
}

/** Сколько запросов уйдёт на одну компанию — нужно, чтобы назвать цену заранее. */
export const queriesPerCompany = (titles) =>
  buildQueries({ name: 'Компания', domain: 'x.ru' }, titles).length;

// ─────────────────────────── Цены поиска ───────────────────────────
// Пишем реальную стоимость в таблицу расходов, а не ноль: раньше Яндекс
// логировался с usd=0, и в отчёте самый массовый этап выглядел бесплатным.

const USD_RUB = Number(process.env.USD_RUB ?? 86);
/** Обычный запрос — 488 ₽ за 1000. Отложенный — 30.5 ₽ за 1000, в 16 раз дешевле. */
export const YANDEX_RUB = Number(process.env.YANDEX_PRICE_RUB ?? 0.488);
export const YANDEX_RUB_DEFERRED = Number(process.env.YANDEX_PRICE_RUB_DEFERRED ?? 0.0305);
const SERPER_USD = Number(process.env.SERPER_PRICE_USD ?? 0.001);
const XMLRIVER_RUB = Number(process.env.XMLRIVER_PRICE_RUB ?? 0.5);
const GOOGLE_USD = Number(process.env.GOOGLE_PRICE_USD ?? 0.005);
/** Встроенный поиск считается не за запрос, а за компанию: внутри одного
 *  вызова модель делает несколько поисков и платит ещё и за токены. */
const BUILTIN_USD_PER_COMPANY = Number(process.env.BUILTIN_PRICE_USD ?? 0.18);

/** Цена одного запроса в долларах по каждому движку — для оценок до прогона. */
export function queryPriceUsd(engine) {
  if (engine === 'yandex') return (yandexDeferred() ? YANDEX_RUB_DEFERRED : YANDEX_RUB) / USD_RUB;
  if (engine === 'yandex-sync') return YANDEX_RUB / USD_RUB;
  if (engine === 'yandex-deferred') return YANDEX_RUB_DEFERRED / USD_RUB;
  if (engine === 'serper') return SERPER_USD;
  if (engine === 'xmlriver') return XMLRIVER_RUB / USD_RUB;
  return 0;
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
  logUsage(db, { stage: 'search', provider: 'yandex', units: 1, usd: YANDEX_RUB / USD_RUB });
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

// ─────────────────── Отложенные запросы Яндекса ───────────────────
// Те же запросы, но ответ приходит не сразу: от минут до нескольких часов.
// Взамен они стоят 30.5 ₽ за 1000 вместо 488 ₽ — в шестнадцать раз дешевле.
// На базе в 3000 компаний это разница примерно между 13 200 ₽ и 820 ₽.
//
// Отправка и разбор разнесены во времени, поэтому идентификаторы операций
// лежат в таблице search_ops: прогон можно прервать и продолжить завтра,
// повторно за отправленные запросы платить не придётся.

const YANDEX_ASYNC_URL = 'https://searchapi.api.cloud.yandex.net/v2/web/searchAsync';
const YANDEX_OP_URL = 'https://operation.api.cloud.yandex.net/operations/';

function yandexAuth() {
  const key = process.env.YANDEX_API_KEY, folder = process.env.YANDEX_FOLDER_ID;
  if (!key || !folder) throw new Error('Для Яндекса нужны YANDEX_API_KEY и YANDEX_FOLDER_ID');
  return { key, folder };
}

/** Отправить отложенный запрос. Возвращает идентификатор операции. */
export async function yandexSubmit(db, query) {
  const { key, folder } = yandexAuth();
  const op = await withRetry(async () => {
    const r = await fetch(YANDEX_ASYNC_URL, {
      method: 'POST',
      headers: { Authorization: `Api-Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: { searchType: 'SEARCH_TYPE_RU', queryText: query },
        folderId: folder, responseFormat: 'FORMAT_XML', l10n: 'LOCALIZATION_RU',
      }),
    });
    if (!r.ok) { const e = new Error(`Yandex async ${r.status}: ${(await r.text()).slice(0, 200)}`); e.status = r.status; throw e; }
    return r.json();
  });
  // платим в момент отправки, а не получения — результат уже оплачен
  logUsage(db, { stage: 'search', provider: 'yandex-deferred', units: 1, usd: YANDEX_RUB_DEFERRED / USD_RUB });
  return op.id;
}

/** Забрать результат операции. { done, hits, error } */
export async function yandexCollect(id, { limit = 10 } = {}) {
  const { key } = yandexAuth();
  const r = await fetch(YANDEX_OP_URL + id, { headers: { Authorization: `Api-Key ${key}` } });
  if (!r.ok) return { done: false, error: `HTTP ${r.status}` };
  const j = await r.json();
  if (!j.done) return { done: false };
  if (j.error) return { done: true, error: j.error.message ?? 'ошибка операции' };
  const raw = j.response?.rawData;
  if (!raw) return { done: true, error: 'пустой ответ' };
  const xml = Buffer.from(raw, 'base64').toString('utf8');
  return { done: true, hits: parseYandexXml(xml, limit).map((x) => ({ ...x, engine: 'yandex' })) };
}

// ─────────────────── Google через API-ключ ───────────────────
// Нужен тем, кто ищет не по России: там Google находит заметно больше
// Яндекса. Два сервиса на выбор — оба отдают обычную гугловую выдачу,
// в отличие от встроенного поиска стоят копейки и не требуют Anthropic.

async function serperSearch(db, query, { limit = 10 } = {}) {
  const key = (process.env.SERPER_API_KEY ?? '').trim();
  if (!key) throw new Error('Для SEARCH_PROVIDER=serper нужен SERPER_API_KEY');
  const d = await withRetry(async () => {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: query, num: limit,
        gl: process.env.SERPER_COUNTRY || 'us',
        hl: process.env.SERPER_LANG || 'en',
      }),
    });
    if (!r.ok) { const e = new Error(`Serper ${r.status}: ${(await r.text()).slice(0, 200)}`); e.status = r.status; throw e; }
    return r.json();
  });
  logUsage(db, { stage: 'search', provider: 'serper', units: 1, usd: SERPER_USD });
  // поля читаем мягко: у сервиса они называются по-разному в разных блоках
  const list = d.organic ?? d.results ?? [];
  return list.slice(0, limit).map((x) => ({
    url: x.link ?? x.url ?? '',
    title: x.title ?? '',
    snippet: (x.snippet ?? x.description ?? '').slice(0, 600),
    date: x.date ?? '',
    engine: 'serper',
  })).filter((x) => x.url);
}

/** Официальный Google Custom Search JSON API.
 *
 *  Внимание: с 2026 года закрыт для новых клиентов и работает до 01.01.2027.
 *  Оставлен для тех, у кого доступ уже есть; остальным — Serper или XMLRiver. */
async function googleSearch(db, query, { limit = 10 } = {}) {
  const key = (process.env.GOOGLE_API_KEY ?? '').trim();
  const cx = (process.env.GOOGLE_CX ?? '').trim();
  if (!key || !cx) throw new Error('Для SEARCH_PROVIDER=google нужны GOOGLE_API_KEY и GOOGLE_CX');
  const d = await withRetry(async () => {
    const u = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}`
            + `&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${Math.min(limit, 10)}`;
    const r = await fetch(u);
    const j = await r.json();
    if (!r.ok) { const e = new Error(`Google ${r.status}: ${j?.error?.message ?? ''}`); e.status = r.status; throw e; }
    return j;
  });
  logUsage(db, { stage: 'search', provider: 'google', units: 1, usd: GOOGLE_USD });
  return (d.items ?? []).slice(0, limit).map((x) => ({
    url: x.link ?? '', title: x.title ?? '',
    snippet: (x.snippet ?? '').slice(0, 600), date: '', engine: 'google',
  })).filter((x) => x.url);
}

/** XMLRiver отдаёт выдачу в том же XML, что и Яндекс, — разбор общий. */
async function xmlriverSearch(db, query, { limit = 10 } = {}) {
  const user = (process.env.XMLRIVER_USER ?? '').trim();
  const key = (process.env.XMLRIVER_KEY ?? '').trim();
  if (!user || !key) throw new Error('Для SEARCH_PROVIDER=xmlriver нужны XMLRIVER_USER и XMLRIVER_KEY');
  const url = `https://xmlriver.com/search/xml?user=${encodeURIComponent(user)}`
            + `&key=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}`
            + `&groupby=${limit}`;
  const xml = await withRetry(async () => {
    const r = await fetch(url);
    const t = await r.text();
    if (!r.ok) { const e = new Error(`XMLRiver ${r.status}`); e.status = r.status; throw e; }
    const err = t.match(/<error code="(\d+)">([^<]*)</);
    if (err) { const e = new Error(`XMLRiver: ${err[2]}`); e.providerIssue = true; throw e; }
    return t;
  });
  logUsage(db, { stage: 'search', provider: 'xmlriver', units: 1, usd: XMLRIVER_RUB / USD_RUB });
  return parseYandexXml(xml, limit).map((x) => ({ ...x, engine: 'xmlriver' }));
}

// ─────────────────────── Встроенный поиск (Anthropic) ───────────────────────

// $10 за 1000 поисков веб-инструмента — тарифицируется отдельно от токенов,
// в usage ответа приходит как usage.server_tool_use.web_search_requests.
const WEB_SEARCH_UNIT_USD = Number(process.env.WEB_SEARCH_UNIT_USD ?? 0.01);

/** Модель, которая ходит в поиск и выписывает найденных людей.
 *
 *  Выбираем за пользователя, а не оставляем «подешевле»: это единственный шаг,
 *  где модель читает сырую выдачу и решает, человек перед ней или совпадение
 *  названий. На Haiku здесь экономить нечего — после разбивки на отдельные
 *  вызовы токенов уходит вчетверо меньше, и Sonnet стоит дешевле, чем стоил
 *  Haiku на старой схеме. */
const searchModel = () => process.env.SEARCH_MODEL
  || (getProvider().name === 'openai' ? (process.env.OPENAI_MODEL || 'gpt-4o') : 'claude-sonnet-5');

async function builtinSearch(client, db, query, { limit = 10, maxUses = 1 } = {}) {
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
    model: searchModel(),
    max_tokens: 4000,
    // базовый вариант работает на всех моделях, включая дешёвые;
    // расширенный (_20260209) требует программного вызова инструментов.
    // max_uses=1: один вызов — один поисковый запрос. Несколько поисков
    // в одном вызове оплачивают накопленный контекст по кругу, см. builtinQueries.
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
    system:
      'Ты выполняешь набор поисковых запросов и выписываешь то, что реально ' +
      'нашлось в выдаче. По каждому найденному человеку дай строку:\n' +
      'ФИО | должность | адрес источника | год публикации (0, если неизвестен)\n\n' +
      'Выписывай всех, кто работает в компании и чья должность близка к искомой ' +
      'по смыслу: «директор по развитию, отвечает за маркетинг» — это находка, ' +
      'выписывай. Отсеивать по точности формулировки не нужно, это сделает ' +
      'следующий шаг.\n\n' +
      'Ничего не додумывай: человек должен быть назван в найденных источниках. ' +
      'Если по какому-то запросу людей не нашлось — просто перейди к следующему.',
    messages: [{ role: 'user', content: query }],
  });

  const u = res.usage ?? {};
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  logUsage(db, {
    stage: 'search', provider: 'anthropic', model: res.model,
    tokens_in: u.input_tokens ?? 0, tokens_out: u.output_tokens ?? 0,
    units: searches,
    usd: p.price(res.model, { tokens_in: u.input_tokens ?? 0, tokens_out: u.output_tokens ?? 0 })
       + searches * WEB_SEARCH_UNIT_USD,
  });

  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) return [];

  // адреса найденных страниц — из блоков результатов поиска
  const urls = [];
  for (const block of res.content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const it of block.content) {
      const u = it.url ?? it.page_url ?? it.source;   // поле отличается между версиями инструмента
      if (u) urls.push({ url: u, title: it.title ?? it.page_title ?? '' });
    }
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
/**
 * provider передаётся явно, а не читается из process.env на каждый вызов.
 *
 * Раньше движок выбирался глобальной переменной process.env.SEARCH_PROVIDER,
 * и вызывающий код переключал её прямо перед вызовом. Это ломалось под
 * конкурентной обработкой компаний (mapLimit с параллелизмом 3): пока один
 * запрос ждёт ответа, другая компания успевала переключить ту же глобальную
 * переменную на свой движок — и первый запрос уходил не туда. На прогоне
 * 175 компаний это привело к тому, что почти все запросы вместо «Яндекс
 * и Google» ушли через один движок вслепую. */
export async function search(client, db, query, opts = {}) {
  const provider = opts.provider ?? searchProviderName();
  if (provider === 'none') return [];
  if (provider === 'yandex') return (await yandexSearch(db, query, opts)).map((x) => ({ ...x, engine: 'yandex' }));
  if (provider === 'serper') return serperSearch(db, query, opts);
  if (provider === 'google') return googleSearch(db, query, opts);
  if (provider === 'xmlriver') return xmlriverSearch(db, query, opts);
  if (provider === 'builtin') return (await builtinSearch(client, db, query, opts)).map((x) => ({ ...x, engine: 'builtin' }));
  throw new Error(
    `Неизвестный SEARCH_PROVIDER="${provider}".\n` +
    '  Допустимо: yandex, serper, xmlriver, google, builtin, both, none (или auto).');
}
