// Извлечение данных из HTML. Всё здесь — чистый код, ноль токенов LLM.

/** HTML → читаемый текст. На реальных сайтах даёт сокращение ~24x. */
export function htmlToText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&[a-z]+;/gi, ' ');
  return s.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** <title> и meta description — дешёвый контекст для промпта. */
export function htmlMeta(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1]
            ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1] ?? '';
  const h1 = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => htmlToText(m[1])).filter(Boolean);
  return { title: htmlToText(title), description: desc.trim(), h1 };
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico|mp4|pdf)$/i;
// мусор, который regex ловит на сайтах: примеры в плейсхолдерах, почты разработчиков
const NOISE_RE = /^(example|test|your|name|email|user|domain|sentry|wixpress|sitemap)@|@(example|test|domain|sentry\.io|wixpress\.com|2x|3x)\b/i;

/** Все почты со страницы: и из текста, и из mailto:. Полнее любого LLM и бесплатно. */
export function extractEmails(html) {
  const set = new Set();
  for (const m of html.match(EMAIL_RE) ?? []) {
    const e = m.toLowerCase();
    if (!ASSET_RE.test(e) && !NOISE_RE.test(e) && e.length < 64) set.add(e);
  }
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    try {
      const e = decodeURIComponent(m[1]).toLowerCase().trim();
      if (EMAIL_RE.test(e) && !NOISE_RE.test(e)) set.add(e);
    } catch { /* битый URL-encoding — пропускаем */ }
    EMAIL_RE.lastIndex = 0;
  }
  return [...set];
}

const PHONE_RE = /(?:\+7|8)[\s\-(]*\d{3}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;

export function extractPhones(html) {
  const text = htmlToText(html);
  const set = new Set();
  for (const m of text.match(PHONE_RE) ?? []) {
    const d = m.replace(/\D/g, '').replace(/^8/, '7');
    if (d.length === 11) set.add('+' + d);
  }
  return [...set];
}

/** Публичные почтовые домены — в РФ это личные, а не корпоративные почты. */
export const FREE_MAIL_DOMAINS = new Set([
  'mail.ru', 'ya.ru', 'yandex.ru', 'yandex.com', 'bk.ru', 'inbox.ru', 'list.ru',
  'rambler.ru', 'gmail.com', 'hotmail.com', 'outlook.com', 'internet.ru', 'mail.com', 'icloud.com',
]);

export const isFreeMail = (email) => FREE_MAIL_DOMAINS.has(email.split('@')[1] ?? '');

/** Ссылки на внутренние страницы, сгруппированные по типу. Нужно, чтобы догрузить
 *  «Контакты» и «О компании» только тем компаниям, что прошли ICP. */
const PAGE_HINTS = {
  contacts: /контакт|contact|связ|обратн/i,
  about:    /о[-\s]?(?:нас|компании|предприятии|производстве|фабрике|заводе)|about|company|history|истори/i,
  team:     /команда|сотрудник|руководств|персонал|team|staff|управлен/i,
  products: /продукц|производств|каталог|услуги|catalog|product/i,
};

export function extractInternalLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const found = { contacts: [], about: [], team: [], products: [] };
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    let url;
    try { url = new URL(m[1], base); } catch { continue; }
    if (url.hostname !== base.hostname) continue;
    if (ASSET_RE.test(url.pathname)) continue;
    const probe = decodeURIComponent(url.pathname) + ' ' + htmlToText(m[2]);
    for (const [kind, re] of Object.entries(PAGE_HINTS)) {
      if (re.test(probe) && !found[kind].includes(url.href) && found[kind].length < 3) found[kind].push(url.href);
    }
  }
  return found;
}

/** Грубая оценка токенов для русского текста (~3 байта UTF-8 на токен).
 *  Для точных цифр после прогона берём usage из ответа API. */
export const estimateTokens = (s) => Math.ceil(Buffer.byteLength(s, 'utf8') / 3);
