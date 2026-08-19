// Waterfall поиска почт и валидация.
//
// Провайдеры опрашиваются по очереди, пока почта не найдётся. Нашёл первый —
// за остальных не платим. Провайдер без ключа в .env просто пропускается,
// поэтому пайплайн работает и без единого платного сервиса.
//
// ВНИМАНИЕ: формы запросов у этих сервисов меняются. Каждый адаптер
// изолирован: если один перестал отвечать, остальные продолжают работать,
// а сырой ответ пишется в лог (ENRICH_DEBUG=true) — по нему адаптер чинится
// за пять минут, не трогая остальной код.

import { withRetry } from './http.js';
import { logUsage } from './db.js';
import { personVariants, translitName, guessPatterns } from './emails.js';

const dbg = (name, payload) => {
  if ((process.env.ENRICH_DEBUG ?? '') === 'true')
    console.log(`\n  [${name}] ответ: ${JSON.stringify(payload).slice(0, 600)}\n`);
};

/** Ответы, которые означают «человека нет в базе», а не поломку. */
const NOT_FOUND_CODES = ['NO_MATCH', 'NOT_FOUND', 'NO_RESULT', 'NO_RESULTS'];
const isNotFound = (data) =>
  NOT_FOUND_CODES.includes(String(data?.error_code ?? '').toUpperCase()) ||
  /no.?match|not.?found/i.test(String(data?.message ?? ''));

const jsonPost = async (url, headers, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 400) }; }
  if (!r.ok) {
    // «человека нет в базе» некоторые провайдеры отдают кодом 400 — это
    // штатный ответ, а не поломка, и кредит за него не списывается
    if (isNotFound(data)) return { __notFound: true };
    const e = new Error(`${r.status}: ${text.slice(0, 200)}`); e.status = r.status; e.data = data; throw e;
  }
  return data;
};

/** Вытащить первую похожую на почту строку из любого ответа — устойчиво к смене формата. */
function findEmailDeep(obj, depth = 0) {
  if (depth > 6 || obj == null) return null;
  if (typeof obj === 'string') return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(obj.trim()) ? obj.trim().toLowerCase() : null;
  if (Array.isArray(obj)) { for (const v of obj) { const e = findEmailDeep(v, depth + 1); if (e) return e; } return null; }
  if (typeof obj === 'object') {
    // сначала осмысленные ключи, потом всё подряд
    for (const k of ['email', 'work_email', 'professional_email', 'most_probable_email', 'value'])
      if (obj[k]) { const e = findEmailDeep(obj[k], depth + 1); if (e) return e; }
    for (const v of Object.values(obj)) { const e = findEmailDeep(v, depth + 1); if (e) return e; }
  }
  return null;
}

const jsonGet = async (url, headers) => {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 400) }; }
  if (!r.ok) { const e = new Error(`${r.status}: ${text.slice(0, 200)}`); e.status = r.status; throw e; }
  return data;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Сколько ждать асинхронный сервис, секунд. FullEnrich отвечает примерно
 *  за 70 секунд, а ждали мы 35 (14 опросов × 2.5 с) и записывали результат
 *  как «не найдено». Сервис ни разу не успел ответить за весь прогон, и по
 *  отчёту это выглядело так, будто он ничего не находит. */
const POLL_SECONDS = Number(process.env.ENRICH_POLL_SECONDS ?? 180);

/** Возвращается, когда сервис не ответил за отведённое время. Это НЕ «не
 *  найдено»: такой случай надо показать пользователю отдельно, иначе
 *  медленный сервис молча выглядит бесполезным. */
const TIMEOUT = Symbol('timeout');

/** Опрос асинхронной задачи, пока не появится результат. */
async function poll(fn, { seconds = POLL_SECONDS, delay = 3000 } = {}) {
  const tries = Math.max(1, Math.ceil((seconds * 1000) / delay));
  for (let i = 0; i < tries; i++) {
    await sleep(delay);
    const r = await fn();
    if (r !== undefined) return r;      // undefined = ещё считается
  }
  return TIMEOUT;
}

/** Превратить таймаут в явную ошибку провайдера. */
function orTimeout(r, name) {
  if (r !== TIMEOUT) return r;
  const e = new Error(`${name}: не ответил за ${POLL_SECONDS} с`);
  e.providerIssue = true; e.timeout = true;
  throw e;
}

const keepPersonal = () => (process.env.KEEP_PERSONAL_EMAILS ?? 'true') !== 'false';

// ─────────────────────────── Адаптеры ───────────────────────────
// Каждый: { name, env, find({first,last,full,domain,company}, key) → email|null }
// Формы запросов сверены с документацией провайдеров вживую.

const PROVIDERS = [
  {
    // синхронный; кредит не списывается, если ничего не найдено
    name: 'prospeo', env: 'PROSPEO_API_KEY',
    async find({ first, last, domain }, key) {
      const d = await jsonPost('https://api.prospeo.io/enrich-person',
        { 'X-KEY': key }, { data: { first_name: first, last_name: last, company_website: domain } });
      dbg('prospeo', d);
      if (d.__notFound) return null;
      return findEmailDeep(d.person?.email ?? d.person ?? d);
    },
  },
  {
    // синхронный
    name: 'findymail', env: 'FINDYMAIL_API_KEY',
    async find({ full, domain }, key) {
      const d = await jsonPost('https://app.findymail.com/api/search/name',
        { Authorization: `Bearer ${key}` }, { name: full, domain });
      dbg('findymail', d);
      return findEmailDeep(d.contact ?? d);
    },
  },
  {
    // асинхронный: ставит задачу, результат забирается опросом
    name: 'wiza', env: 'WIZA_API_KEY',
    async find({ full, domain, company }, key) {
      const auth = { Authorization: `Bearer ${key}` };
      const started = await jsonPost('https://wiza.co/api/individual_reveals', auth, {
        individual_reveal: { full_name: full, domain, company },
        enrichment_level: 'partial',
        email_options: { accept_work: true, accept_personal: keepPersonal() },
      });
      dbg('wiza:start', started);
      const id = started.data?.id;
      if (!id) return null;
      return poll(async () => {
        const d = await jsonGet(`https://wiza.co/api/individual_reveals/${id}`, auth);
        if (!d.data?.is_complete) return undefined;      // ещё считается
        dbg('wiza:done', d);
        if (d.data.fail_error) {
          const e = new Error(`Wiza: ${d.data.fail_error}`); e.providerIssue = true; throw e;
        }
        return findEmailDeep(d.data) ?? null;
      }).then((r) => orTimeout(r, 'Wiza'));
    },
  },
  {
    // асинхронный: возвращает enrichment_id, результат забирается опросом
    name: 'fullenrich', env: 'FULLENRICH_API_KEY',
    async find({ first, last, domain }, key) {
      const auth = { Authorization: `Bearer ${key}` };
      const started = await jsonPost('https://app.fullenrich.com/api/v2/contact/enrich/bulk', auth, {
        name: 'leadgen',
        data: [{ first_name: first, last_name: last, domain, enrich_fields: ['contact.work_emails'] }],
      });
      dbg('fullenrich:start', started);
      const id = started.enrichment_id;
      if (!id) return null;
      return poll(async () => {
        const d = await jsonGet(`https://app.fullenrich.com/api/v2/contact/enrich/bulk/${id}`, auth);
        const status = (d.status ?? d.data?.status ?? '').toLowerCase();
        if (status && !['finished', 'completed', 'done'].includes(status)) return undefined;
        dbg('fullenrich:done', d);
        return findEmailDeep(d) ?? null;
      }).then((r) => orTimeout(r, 'FullEnrich'));
    },
  },
];

export const activeProviders = () =>
  PROVIDERS.filter((p) => (process.env[p.env] ?? '').trim().length > 5);

/** Порядок из .env: EMAIL_WATERFALL=prospeo,findymail,wiza,fullenrich */
function ordered() {
  const want = (process.env.EMAIL_WATERFALL || 'wiza,prospeo,fullenrich,findymail')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const active = activeProviders();
  const byName = Object.fromEntries(active.map((p) => [p.name, p]));
  return want.map((n) => byName[n]).filter(Boolean);
}

/**
 * Найти почту человека. Идём по провайдерам, пока не найдём.
 * Возвращает { email, source } или { email: null, tried: [...] }.
 */
// Предохранитель: провайдер, который падает подряд, отключается до конца
// прогона. Иначе сломанный сервис (неоплаченный аккаунт, протухший ключ)
// съедает по минуте на каждом человеке и растягивает прогон на часы.
const FAILS = new Map();
const FAIL_LIMIT = 2;

/** Исход вызова сервиса. Пишем в колонку model — для этих строк она пустая,
 *  а разбивка «кто сколько нашёл» нужна в отчёте и должна переживать
 *  перезапуск, поэтому храним в базе, а не в памяти процесса. */
const note = (db, provider, outcome) =>
  logUsage(db, { stage: 'email-waterfall', provider, model: outcome, units: 1, usd: 0 });
export const disabledProviders = () =>
  [...FAILS.entries()].filter(([, v]) => v.count >= FAIL_LIMIT).map(([k, v]) => `${k}: ${v.reason}`);

/**
 * Найти почту человека.
 *
 * Два уровня перебора. Внешний — сервисы по порядку из EMAIL_WATERFALL.
 * Внутренний — написания имени: сервисы ищут по точному совпадению, и на
 * «Evgenii» отвечают «не найдено», а на «Evgeniy» отдают адрес. Поэтому
 * прежде чем идти к следующему сервису, спрашиваем текущий про остальные
 * написания того же человека (см. personVariants).
 *
 * В сервисы уходит ТОЛЬКО латиница, всегда. Кириллическое «Казаков Игорь
 * Михайлович» для них не имя, а строка без совпадений: раньше ФИО уходило
 * как записано в базе, и по кириллическим строкам не находилось ничего.
 *
 * Итог: { email, source, variant } либо { email: null, tried: [...] }.
 */
export async function findEmail(db, person) {
  const chain = ordered();
  const tried = [];
  // если ФИО разобрать не удалось — идём с тем, что дали, но латиницей
  const variants = personVariants(person.full ?? '')
    .map((v) => ({ ...person, ...v }));
  const queue = variants.length ? variants : [{ ...person,
    first: translitName(person.first ?? ''), last: translitName(person.last ?? ''),
    full: translitName(person.full ?? '') }];

  for (const p of chain) {
    const f = FAILS.get(p.name);
    if (f && f.count >= FAIL_LIMIT) { tried.push(`${p.name}(отключён)`); continue; }
    const key = process.env[p.env];

    for (const [i, v] of queue.entries()) {
      try {
        const email = await withRetry(() => p.find(v, key), { tries: 3 });
        note(db, p.name, email ? 'found' : 'not_found');
        FAILS.delete(p.name);
        tried.push(i ? `${p.name}:${v.full}` : p.name);
        if (email) return { email, source: p.name, variant: v.full, tried };
      } catch (e) {
        const reason = e.providerIssue ? e.message : `ошибка ${e.status ?? e.message?.slice(0, 40)}`;
        const cur = FAILS.get(p.name) ?? { count: 0, reason };
        FAILS.set(p.name, { count: cur.count + 1, reason });
        tried.push(`${p.name}(${reason})`);
        note(db, p.name, e.timeout ? 'timeout' : 'error');
        break;                       // сервис сломан — другие написания не помогут
      }
    }
  }
  return { email: null, tried };
}

/**
 * Последняя попытка, когда ни один сервис почту не нашёл: собрать адрес
 * по частым шаблонам и проверить валидатором.
 *
 * Механика и её цена. Сначала проверяем первый шаблон. Если валидатор
 * отвечает catch-all — домен принимает любую почту, отличить настоящий
 * адрес от выдуманного невозможно, и мы сразу прекращаем: ни одного
 * лишнего кредита и ни одной догадки в выгрузке. Если домен не catch-all,
 * перебираем шаблоны, пока какой-нибудь не окажется valid; всё остальное
 * (invalid, unknown) отбрасываем. Тратится от одного до GUESS_MAX_CHECKS
 * кредитов валидатора на человека.
 *
 * Берём только явный valid: догадка, попавшая в выгрузку как настоящий
 * контакт, дороже ненайденного адреса.
 */
export async function guessEmail(db, { full, domain }) {
  if (!domain) return { email: null, reason: 'нет домена компании' };
  if (!(process.env.ZEROBOUNCE_API_KEY ?? '').trim())
    return { email: null, reason: 'подбор без валидатора выключен' };

  const limit = Number(process.env.GUESS_MAX_CHECKS ?? 6);
  const cands = guessPatterns(full).slice(0, limit).map((l) => `${l}@${domain}`);
  if (!cands.length) return { email: null, reason: 'не удалось разобрать ФИО' };

  for (const e of cands) {
    const v = await validateEmail(db, e);
    if (v.status === 'catch-all')
      return { email: null, reason: 'домен catch-all — подбор невозможен', catchAll: true };
    if (v.status === 'valid')
      return { email: e, reason: 'подобрана по шаблону, подтверждена валидатором' };
  }
  return { email: null, reason: `ни один из ${cands.length} шаблонов не подтвердился` };
}

// ─────────────────────────── Валидация ───────────────────────────

/**
 * ZeroBounce. Для России важно: catch-all и «не удалось проверить» — рабочие
 * статусы, отбрасываем только явный брак. Иначе теряется половина базы.
 */
const REJECT = new Set(['invalid', 'spamtrap', 'abuse']);

/**
 * do_not_mail разбираем по под-статусу. ZeroBounce относит сюда все ролевые
 * ящики: info@, office@, sales@ — а в российском B2B это ровно те адреса,
 * на которые и пишут. Отбраковываем только настоящий брак.
 */
const REJECT_SUB = new Set(['toxic', 'disposable', 'possible_trap', 'global_suppression']);
const rejectByStatus = (status, sub) =>
  REJECT.has(status) || (status === 'do_not_mail' && REJECT_SUB.has(sub));

export async function validateEmail(db, email) {
  const key = process.env.ZEROBOUNCE_API_KEY;
  if (!key || key.length < 5) return { status: 'не проверялась', ok: true };
  try {
    const r = await withRetry(async () => {
      const res = await fetch(`https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`);
      if (!res.ok) { const e = new Error(`ZeroBounce ${res.status}`); e.status = res.status; throw e; }
      return res.json();
    }, { tries: 3 });
    dbg('zerobounce', r);
    logUsage(db, { stage: 'validate', provider: 'zerobounce', units: 1, usd: 0 });
    const status = (r.status ?? 'unknown').toLowerCase();
    const sub = (r.sub_status ?? '').toLowerCase();
    return { status, sub, ok: !rejectByStatus(status, sub) };
  } catch (e) {
    return { status: `ошибка проверки (${e.status ?? e.message})`, ok: true };  // не выбрасываем из-за сбоя валидатора
  }
}
