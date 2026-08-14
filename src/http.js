// Загрузка страниц. Каскад: обычный fetch → ослабленный TLS → (позже) Playwright → платный парсер.
// На тестовой выборке 92 сайтов первые две ступени дали 89% успеха, платный парсер нужен был 1 сайту.

import https from 'node:https';
import http from 'node:http';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
};

export function normalizeUrl(raw) {
  let u = (raw ?? '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).href; } catch { return null; }
}

export function domainOf(raw) {
  const u = normalizeUrl(raw);
  if (!u) return null;
  return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
}

/** Ступень 2: Node-клиент с отключённой проверкой сертификата.
 *  У российских сайтов сплошь и рядом просроченные или самоподписанные сертификаты —
 *  на тесте это вернуло 2 сайта из 3 «упавших по TLS» бесплатно. */
function rawGet(target, { timeout = 20000, insecure = true } = {}) {
  return new Promise((resolve) => {
    const url = new URL(target);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get({
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
      path: url.pathname + url.search, headers: HEADERS, timeout,
      ...(url.protocol === 'https:' ? { rejectUnauthorized: !insecure } : {}),
    }, (res) => {
      // редирект — до 5 переходов
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, target).href;
        return resolve({ redirect: next });
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 4e6) req.destroy(); });
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, html: body }));
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'TIMEOUT' }); });
  });
}

async function rawGetFollow(target, opts) {
  let url = target;
  for (let i = 0; i < 5; i++) {
    const r = await rawGet(url, opts);
    if (!r.redirect) return { ...r, finalUrl: url };
    url = r.redirect;
  }
  return { ok: false, status: 0, error: 'TOO_MANY_REDIRECTS' };
}

/**
 * Достать страницу. Возвращает { ok, html, status, via, error }.
 * via показывает, какая ступень каскада сработала — это метрика для отчёта.
 */
export async function fetchPage(rawUrl, { timeout = 20000 } = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, error: 'BAD_URL', via: null };

  // Ступень 1: обычный fetch по https, затем по http
  for (const scheme of ['https:', 'http:']) {
    const target = url.replace(/^https?:/, scheme);
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      const res = await fetch(target, { redirect: 'follow', signal: ctl.signal, headers: HEADERS });
      clearTimeout(timer);
      const html = await res.text();
      if (res.ok && html.length > 0) return { ok: true, status: res.status, html, finalUrl: res.url, via: 'fetch' };
      if (res.status >= 400 && res.status !== 403) return { ok: false, status: res.status, error: `HTTP ${res.status}`, via: 'fetch' };
    } catch { /* пробуем следующую схему / ступень */ }
  }

  // Ступень 2: ослабленная проверка TLS
  const r = await rawGetFollow(url, { timeout, insecure: true });
  if (r.ok && r.html?.length) return { ok: true, status: r.status, html: r.html, finalUrl: r.finalUrl, via: 'insecure-tls' };

  return { ok: false, status: r.status ?? 0, error: r.error || `HTTP ${r.status}`, via: null };
}

/** Пул конкурентности + прогресс. Заменяет «Clay сам делит на пакеты». */
export async function mapLimit(items, limit, worker, onProgress, onError) {
  const out = new Array(items.length);
  let idx = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); }
      catch (e) {
        out[i] = { __failed: true, error: e.message };
        // Молча глотать нельзя: иначе сотня упавших вызовов выглядит как «0 ошибок»
        if (onError) onError(e, items[i], i);
        else process.stderr.write(`\n  ! ${e.message?.slice(0, 200)}\n`);
      }
      onProgress?.(++done, items.length);
    }
  }));
  return out;
}

/** Экспоненциальный backoff для платных API (Wiza, ZeroBounce, поиск). */
export async function withRetry(fn, { tries = 5, base = 800 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const status = e.status ?? e.response?.status;
      if (e.noRetry || e.providerIssue) throw e;              // проблема на стороне сервиса
      if (status && status < 500 && status !== 429) throw e;  // клиентская ошибка — ретрай не поможет
      await new Promise((r) => setTimeout(r, base * 2 ** i + Math.random() * 300));
    }
  }
  throw last;
}
