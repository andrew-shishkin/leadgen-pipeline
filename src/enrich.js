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

/** Опрос асинхронной задачи, пока не появится результат. */
async function poll(fn, { tries = 14, delay = 2500 } = {}) {
  for (let i = 0; i < tries; i++) {
    await sleep(delay);
    const r = await fn();
    if (r !== undefined) return r;      // undefined = ещё считается
  }
  return null;
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
      });
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
      });
    },
  },
];

export const activeProviders = () =>
  PROVIDERS.filter((p) => (process.env[p.env] ?? '').trim().length > 5);

/** Порядок из .env: EMAIL_WATERFALL=prospeo,findymail,wiza,fullenrich */
function ordered() {
  const want = (process.env.EMAIL_WATERFALL || 'prospeo,findymail,wiza,fullenrich')
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
export const disabledProviders = () =>
  [...FAILS.entries()].filter(([, v]) => v.count >= FAIL_LIMIT).map(([k, v]) => `${k}: ${v.reason}`);

export async function findEmail(db, person) {
  const chain = ordered();
  const tried = [];
  for (const p of chain) {
    const f = FAILS.get(p.name);
    if (f && f.count >= FAIL_LIMIT) { tried.push(`${p.name}(отключён)`); continue; }

    const key = process.env[p.env];
    try {
      const email = await withRetry(() => p.find(person, key), { tries: 3 });
      logUsage(db, { stage: 'email-waterfall', provider: p.name, units: 1, usd: 0 });
      FAILS.delete(p.name);
      tried.push(p.name);
      if (email) return { email, source: p.name, tried };
    } catch (e) {
      const reason = e.providerIssue ? e.message : `ошибка ${e.status ?? e.message?.slice(0, 40)}`;
      const cur = FAILS.get(p.name) ?? { count: 0, reason };
      FAILS.set(p.name, { count: cur.count + 1, reason });
      tried.push(`${p.name}(${reason})`);
      logUsage(db, { stage: 'email-waterfall', provider: p.name, units: 1, usd: 0 });
    }
  }
  return { email: null, tried };
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
