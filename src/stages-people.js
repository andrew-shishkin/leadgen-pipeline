// Этапы 5–10: страницы победителей, поиск ЛПР, проверка, почты, склонения.
// Каждый идемпотентен и продолжает с места остановки.

import fs from 'node:fs';
import { j, unj } from './db.js';
import { fetchPage, mapLimit } from './http.js';
import { fetchWithBrowser, browserAvailable } from './browser.js';
import { htmlToText, extractEmails, cutPeopleFragments } from './extract.js';
import { askJson, modelName, modelFor } from './llm.js';
import { search, buildQueries, searchProviderName, builtinQueries, builtinAvailable } from './search.js';
import { findEmail, validateEmail, activeProviders, guessEmail } from './enrich.js';
import { matchEmailToPerson, parseFio, looksPersonal, orderedFio } from './emails.js';
import { superviseDecline } from './names.js';
import { loadPrompt } from './stages.js';

const fill = (t, v) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '');
// дешёвая модель для массовых мелких задач; CHEAP_MODEL тоже проверяется
// на принадлежность текущему провайдеру — см. modelFor
const cheap = () => modelFor('CHEAP_MODEL',
  modelName().startsWith('claude') ? 'claude-haiku-4-5' : modelName());

/** Справочник должностей из prompts/titles.md.
 *  Списки люди пишут по-разному: голыми строками, через дефис, звёздочкой,
 *  нумерацией. Раньше строки с дефисом молча выбрасывались, и из десяти
 *  должностей читались две — а поисковые запросы строятся именно отсюда. */
export function loadTitles(file = 'prompts/titles.md') {
  const md = fs.readFileSync(file, 'utf8');
  const clean = (l) => l
    .replace(/[\u2010-\u2015\u2212]/g, '-')   // неразрывный дефис и тире → обычный дефис
    .replace(/^\s*(?:[-*•–—]|\d+[.)])\s+/, '') // маркер списка
    .replace(/^\s*\[[ xX]?\]\s*/, '')          // чекбокс
    .replace(/[`*_]/g, '')                      // markdown-разметка
    .trim();
  const sect = (n) => (md.split('## ' + n)[1] ?? '').split('\n##')[0]
    .split('\n').map(clean)
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('>') && !/^[А-ЯЁ].*:$/.test(l));
  return { targets: sect('TARGETS'), accept: sect('ALSO_ACCEPT'), reject: sect('REJECT') };
}

// ───────────────────── 5. Страницы победителям ─────────────────────

export async function enrichPages(db, { limit = 6, onProgress } = {}) {
  const rows = db.prepare(`
    SELECT p.id, p.company_id, p.url, p.kind
    FROM pages p JOIN companies c ON c.id = p.company_id
    WHERE c.icp_status='pass' AND p.kind LIKE '%:candidate' AND p.text IS NULL`).all();
  if (!rows.length) return { fetched: 0, note: 'нечего догружать' };

  // Группируем по компаниям: страницы одной компании обрабатываем последовательно,
  // иначе параллельные записи в emails_site затирают друг друга.
  const byCompany = new Map();
  for (const p of rows) {
    if (!byCompany.has(p.company_id)) byCompany.set(p.company_id, []);
    byCompany.get(p.company_id).push(p);
  }

  const upd = db.prepare(`UPDATE pages SET kind=?, text=? WHERE id=?`);
  const addMail = db.prepare(`UPDATE companies SET emails_site=? WHERE id=?`);
  const stat = { ok: 0, failed: 0, newEmails: 0 };

  await mapLimit([...byCompany.entries()], limit, async ([companyId, pages]) => {
    const row = db.prepare(`SELECT emails_site FROM companies WHERE id=?`).get(companyId);
    const have = new Set(unj(row.emails_site) ?? []);
    const before = have.size;
    for (const p of pages) {
      const r = await fetchPage(p.url);
      if (!r.ok) { upd.run(p.kind.replace(':candidate', ':failed'), '', p.id); stat.failed++; continue; }
      upd.run(p.kind.replace(':candidate', ''), htmlToText(r.html), p.id);
      for (const e of extractEmails(r.html)) have.add(e);   // regex, без токенов
      stat.ok++;
    }
    if (have.size > before) { addMail.run(j([...have]), companyId); stat.newEmails += have.size - before; }
  }, onProgress);
  return stat;
}

/** Догрузить браузером сайты, отдавшие пустую страницу. */
export async function retryWithBrowser(db, { onProgress } = {}) {
  if (!(await browserAvailable())) return { skipped: true };
  const rows = db.prepare(`
    SELECT c.id, c.site FROM companies c
    WHERE c.fetch_status='ok' AND c.text_len < 400`).all();
  if (!rows.length) return { fetched: 0 };
  const insPage = db.prepare(`INSERT OR REPLACE INTO pages (company_id, kind, url, text) VALUES (?,'home',?,?)`);
  const upd = db.prepare(`UPDATE companies SET text_len=?, fetch_via='browser', emails_site=?, icp_status='pending' WHERE id=?`);
  const stat = { ok: 0, failed: 0 };
  await mapLimit(rows, 3, async (c) => {
    const r = await fetchWithBrowser(c.site);
    if (!r.ok || !r.html) { stat.failed++; return; }
    const text = htmlToText(r.html);
    if (text.length < 400) { stat.failed++; return; }
    insPage.run(c.id, r.finalUrl ?? c.site, text);
    upd.run(text.length, j(extractEmails(r.html)), c.id);   // вернуть в очередь на квалификацию
    stat.ok++;
  }, onProgress);
  return stat;
}

// ───────────────────── 6. ЛПР со страниц и из поиска ─────────────────────

const PEOPLE_SCHEMA = {
  type: 'object',
  properties: {
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          full_name: { type: 'string' }, title: { type: 'string' },
          evidence: { type: 'string' }, source_url: { type: 'string' },
          published_year: { type: 'integer' },
        },
        required: ['full_name', 'title', 'evidence', 'source_url', 'published_year'],
        additionalProperties: false,
      },
    },
  },
  required: ['people'], additionalProperties: false,
};

const savePerson = (db) => db.prepare(`
  INSERT OR IGNORE INTO people (company_id, full_name, title, origin, source_url, published_at)
  VALUES (?,?,?,?,?,?)`);

export async function peopleFromPages(db, client, { model, onProgress } = {}) {
  const { system, user: tpl } = loadPrompt('prompts/people.md');
  const titles = loadTitles();
  const titleList = [...titles.targets, ...titles.accept].join(', ');
  const rows = db.prepare(`
    SELECT id, name, site FROM companies WHERE icp_status='pass' AND people_status='pending'`).all();
  if (!rows.length) return { done: 0 };

  const ins = savePerson(db);
  const mark = db.prepare(`UPDATE companies SET people_status='done' WHERE id=?`);
  const stat = { companies: 0, found: 0 };

  await mapLimit(rows, 5, async (c) => {
    const pages = db.prepare(
      `SELECT kind, text FROM pages WHERE company_id=? AND text IS NOT NULL AND LENGTH(text)>50`).all(c.id);
    const text = pages.map((p) => `[${p.kind}]\n${p.text}`).join('\n\n').slice(0, 25000);
    if (!text) { mark.run(c.id); return; }
    const r = await askJson(client, db, {
      stage: 'people-pages', model, system, schema: PEOPLE_SCHEMA, companyId: c.id, maxTokens: 3000,
      user: fill(tpl, { name: c.name, site: c.site, titles: titleList, text }),
    });
    if (r.ok) for (const p of r.data.people ?? []) {
      if (!p.full_name?.trim()) continue;
      ins.run(c.id, p.full_name.trim(), p.title ?? '', 'site', c.site, p.published_year ? String(p.published_year) : null);
      stat.found++;
    }
    mark.run(c.id);
    stat.companies++;
  }, onProgress);
  return stat;
}

/** Сколько найденных страниц скачивать и читать на одну компанию.
 *  Скачивание и обрезка регуляркой бесплатны, а в модель всё равно уходит
 *  не больше PAGE_BUDGET символов — поэтому предел щедрый. */
const PAGE_LIMIT = Number(process.env.SEARCH_PAGES ?? 10);

// Сколько символов каждому блоку в тексте для модели.
// Раньше был один общий лимит на всё: выписки встроенного поиска клеились
// в конец общей строки и резались по 6000 символов вместе со сниппетами
// Яндекса. Восемь яндексовых запросов дают 20-50 тысяч символов, так что
// выписка Google не доезжала до модели ни разу — оплаченный поиск
// выбрасывался вызовом .slice(). Теперь у каждого блока свой бюджет.
const PAGE_BUDGET = 14000;
const SERP_BUDGET = 4000;
const NOTE_BUDGET = 5000;

/** Адреса из выдачи — поровну от каждого движка, по очереди.
 *
 *  Раньше брались первые PAGE_LIMIT адресов подряд, а в списке первым всегда
 *  шёл Яндекс со своими 40-60 результатами. Страницы, найденные встроенным
 *  поиском, не читались никогда. */
function pickUrls(hits, { limit, skipDomain }) {
  const bad = (u) => !u || (skipDomain && u.includes(skipDomain))
    || /\.(pdf|docx?|xlsx?|pptx?|zip|rar)(\?|$)/i.test(u);
  const queues = new Map();
  for (const h of hits) {
    const q = queues.get(h.engine) ?? [];
    for (const u of [h.url, ...(h.urls ?? []).map((x) => x.url)]) if (!bad(u)) q.push(u);
    queues.set(h.engine, q);
  }
  const lists = [...queues.values()];
  const seen = new Set(), out = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < limit; i++) {
    for (const l of lists) {
      if (i >= l.length || seen.has(l[i])) continue;
      seen.add(l[i]); out.push(l[i]);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export async function peopleFromSearch(db, client, { model, onProgress } = {}) {
  if (searchProviderName() === 'none') return { skipped: true };
  // Сказать один раз в начале, а не падать на каждой компании по очереди.
  if (['both', 'builtin'].includes(searchProviderName()) && !builtinAvailable()) {
    process.stdout.write(
      '\n  Встроенный поиск (Google) доступен только на Anthropic, а сейчас выбран OpenAI.\n'
    + '  Ищем через Яндекс. Чтобы вернуть Google, поставьте LLM_PROVIDER=anthropic в .env.\n');
    if (searchProviderName() === 'builtin') return { skipped: true, reason: 'builtin недоступен на OpenAI' };
  }
  const { system, user: tpl } = loadPrompt('prompts/people.md');
  const titles = loadTitles();
  const titleList = [...titles.targets, ...titles.accept].join(', ');
  const rows = db.prepare(`
    SELECT id, name, site, domain FROM companies
    WHERE icp_status='pass' AND search_status IS NULL`).all();
  if (!rows.length) return { done: 0 };

  const ins = savePerson(db);
  const mark = db.prepare(`UPDATE companies SET search_status='done' WHERE id=?`);
  const stat = { companies: 0, snippets: 0, found: 0 };

  await mapLimit(rows, 3, async (c) => {
    const hits = [];
    let failed = 0;
    // в поиск идут и TARGETS, и ALSO_ACCEPT: раз формулировка нам подходит,
    // странно её не искать. Раньше искались только TARGETS.
    const mode = searchProviderName();
    const engines = (mode === 'both' ? ['yandex', 'builtin'] : [mode])
      .filter((e) => e !== 'builtin' || builtinAvailable());
    // provider передаётся явно на каждый вызов search() — компании обрабатываются
    // параллельно (см. mapLimit ниже), и переключение через process.env здесь
    // раньше ломалось: одна компания успевала перетереть движок другой.
    for (const eng of engines) {
      // встроенный поиск получает один запрос на компанию — список буквальных
      // поисковых фраз («должность компания»), по одной на каждую нужную
      // должность; Яндексу нужны отдельные точные запросы
      if (eng === 'builtin') {
        // по одному вызову на должность: и внимание модели не размазывается
        // по восьми поискам сразу, и контекст не оплачивается по кругу
        const bs = builtinQueries(c, [...titles.targets, ...titles.accept]);
        const res = await mapLimit(bs, 3, async (b) => {
          try { return await search(client, db, b.text, { limit: 8, provider: eng, maxUses: 1 }); }
          catch (e) {
            failed++; process.stderr.write(`\n  ! поиск(${eng}): ${e.message.slice(0, 160)}\n`);
            return [];
          }
        });
        for (const r of res) if (Array.isArray(r)) hits.push(...r);
        continue;
      }
      const qs = buildQueries(c, [...titles.targets, ...titles.accept]);
      for (const q of qs) {
        try { hits.push(...await search(client, db, q.q, { limit: 8, provider: eng })); }
        catch (e) { failed++; process.stderr.write(`\n  ! поиск(${eng}): ${e.message.slice(0, 160)}\n`); }
      }
    }
    // какой движок отдал какой адрес — по этому потом считаем, кто сколько нашёл
    const engineOf = new Map();
    for (const h of hits) {
      if (h.url) engineOf.set(h.url, h.engine);
      for (const u of h.urls ?? []) engineOf.set(u.url, h.engine);
    }
    // если поиск сломан — НЕ помечаем компанию обработанной, иначе потеряем её молча
    if (failed && !hits.length) { stat.searchErrors = (stat.searchErrors ?? 0) + 1; return; }
    stat.snippets += hits.length;
    if (hits.length) {
      // Сниппет Яндекса — сотня символов, имён в нём обычно нет. Страница
      // компании на TAdviser: 124 КБ текста и 74 строки вида «должность + ФИО».
      // Поэтому найденные страницы скачиваем и режем регуляркой — качать
      // бесплатно, резать бесплатно, нейросеть видит только нужные строки.
      const urls = pickUrls(hits, { limit: PAGE_LIMIT, skipDomain: c.domain });
      const pages = (await mapLimit(urls, 4, async (u) => {
        try {
          const r = await fetchPage(u, { timeout: 12000 });
          if (!r.ok || !r.html) return null;
          const cut = cutPeopleFragments(htmlToText(r.html));
          return cut ? `ИСТОЧНИК: ${u}\n${cut}` : null;
        } catch { return null; }
      })).filter(Boolean);
      stat.pagesRead = (stat.pagesRead ?? 0) + pages.length;

      // выписки встроенного поиска и сниппеты обычной выдачи — разные блоки
      // с разными бюджетами, иначе один вытесняет другой (см. NOTE_BUDGET)
      const notes = hits.filter((h) => h.engine === 'builtin')
        .map((h) => h.snippet).filter(Boolean).join('\n\n').slice(0, NOTE_BUDGET);
      const snippets = hits.filter((h) => h.engine !== 'builtin').map((h, i) =>
        `${i + 1}. ${h.title}\n   ${h.url}${h.date ? `\n   дата: ${h.date}` : ''}\n   ${h.snippet}`)
        .join('\n\n').slice(0, SERP_BUDGET);

      const text = [
        pages.length && `ФРАГМЕНТЫ СО СТРАНИЦ (главное — здесь):\n\n${pages.join('\n\n').slice(0, PAGE_BUDGET)}`,
        notes && `НАЙДЕНО ПОИСКОМ (выписки по каждому запросу):\n\n${notes}`,
        snippets && `ЗАГОЛОВКИ ВЫДАЧИ:\n\n${snippets}`,
      ].filter(Boolean).join('\n\n');
      const r = await askJson(client, db, {
        stage: 'people-search', model, system, schema: PEOPLE_SCHEMA, companyId: c.id, maxTokens: 3000,
        user: fill(tpl, { name: c.name, site: c.site, titles: titleList, text }),
      });
      if (r.ok) for (const p of r.data.people ?? []) {
        if (!p.full_name?.trim()) continue;
        const eng = engineOf.get(p.source_url) ?? (engines.length === 1 ? engines[0] : 'unknown');
        ins.run(c.id, p.full_name.trim(), p.title ?? '', 'search', p.source_url || null,
                p.published_year ? String(p.published_year) : null);
        db.prepare(`UPDATE people SET engine=? WHERE company_id=? AND full_name=? AND engine IS NULL`)
          .run(eng, c.id, p.full_name.trim());
        stat[eng] = (stat[eng] ?? 0) + 1;
        stat.found++;
      }
    }
    mark.run(c.id);
    stat.companies++;
  }, onProgress);
  return stat;
}

// ───────────────────── 7. Фильтр должностей ─────────────────────
// Классифицируем УНИКАЛЬНЫЕ формулировки, а не каждую строку: на 10 000 ЛПР
// приходится две-три сотни разных должностей.

const TITLES_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, verdict: { type: 'string', enum: ['target', 'reject'] } },
        required: ['title', 'verdict'], additionalProperties: false,
      },
    },
  },
  required: ['verdicts'], additionalProperties: false,
};

export async function matchTitles(db, client, { model } = {}) {
  const t = loadTitles();
  const rows = db.prepare(`SELECT DISTINCT title FROM people WHERE title_match='pending' AND TRIM(COALESCE(title,''))<>''`).all();
  const empty = db.prepare(`UPDATE people SET title_match='fail' WHERE title_match='pending' AND TRIM(COALESCE(title,''))=''`).run();
  if (!rows.length) return { unique: 0, skippedEmpty: empty.changes };

  const upd = db.prepare(`UPDATE people SET title_match=? WHERE title=?`);
  const system =
    'Ты сопоставляешь должности по смыслу, а не дословно.\n\n' +
    `Целевые должности:\n${t.targets.join('\n')}\n\n` +
    `Также подходят:\n${t.accept.join('\n')}\n\n` +
    `Не подходят:\n${t.reject.join('\n')}\n\n` +
    'Для каждой присланной должности верни target, если она по смыслу совпадает ' +
    'с целевой или близка к ней, и reject в остальных случаях. Синонимы и ' +
    'региональные формулировки считаются совпадением: «технический директор» ' +
    'и «главный инженер» — это одна роль. Генеральный директор и учредитель — reject.';

  const stat = { unique: rows.length, target: 0, reject: 0, skippedEmpty: empty.changes };
  const CHUNK = 40;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => r.title);
    const r = await askJson(client, db, {
      stage: 'titles', model: model ?? cheap(), system, schema: TITLES_SCHEMA, maxTokens: 3000,
      user: 'Должности:\n' + chunk.map((x, k) => `${k + 1}. ${x}`).join('\n'),
    });
    if (!r.ok) continue;
    for (const v of r.data.verdicts ?? []) {
      upd.run(v.verdict === 'target' ? 'pass' : 'fail', v.title);
      stat[v.verdict === 'target' ? 'target' : 'reject']++;
    }
  }
  db.prepare(`UPDATE people SET title_match='fail' WHERE title_match='pending'`).run();
  return stat;
}

// ───────────────────── 8. Проверка по первоисточнику ─────────────────────

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    works_there: { type: 'string', enum: ['yes', 'no', 'unknown'] },
    reason: { type: 'string' },
    published_year: { type: 'integer' },
  },
  required: ['works_there', 'reason', 'published_year'], additionalProperties: false,
};

/** Окно вокруг имени: страницу целиком слать незачем. */
function nameWindow(text, fullName, radius = 700) {
  const parts = fullName.split(/\s+/).filter((p) => p.length > 3);
  for (const p of parts) {
    const i = text.toLowerCase().indexOf(p.toLowerCase());
    if (i >= 0) return text.slice(Math.max(0, i - radius), i + radius);
  }
  return text.slice(0, radius * 2);
}

export async function verifyPeople(db, client, { model, onProgress } = {}) {
  const freshSince = Number(process.env.FRESH_SINCE_YEAR || 2022);
  // сначала бесплатный отсев по дате
  const old = db.prepare(`
    UPDATE people SET verified='false', verify_reason='публикация старше ' || ?
    WHERE verified='pending' AND published_at IS NOT NULL AND CAST(published_at AS INTEGER) BETWEEN 1900 AND ?`)
    .run(String(freshSince), freshSince - 1);

  const rows = db.prepare(`
    SELECT p.id, p.full_name, p.title, p.source_url, c.name AS company
    FROM people p JOIN companies c ON c.id=p.company_id
    WHERE p.verified='pending' AND p.title_match='pass' AND p.origin='search'
      AND p.source_url IS NOT NULL AND p.source_url <> ''`).all();

  // люди с сайта самой компании в проверке не нуждаются
  const fromSite = db.prepare(`
    UPDATE people SET verified='true', verify_reason='найден на сайте самой компании'
    WHERE verified='pending' AND origin IN ('site','import')`).run();

  const stat = { byDate: old.changes, fromSite: fromSite.changes, checked: 0, confirmed: 0, rejected: 0, unknown: 0 };
  if (!rows.length) return stat;

  const upd = db.prepare(`UPDATE people SET verified=?, verify_reason=?, published_at=COALESCE(?,published_at) WHERE id=?`);
  const system =
    'Тебе дают фрагмент страницы и утверждение, что человек работает в компании. ' +
    'Ответь, подтверждается ли это фрагментом.\n' +
    'yes — в тексте прямо сказано, что он работает в этой компании.\n' +
    'no — в тексте он связан с другой компанией, либо сказано что работал раньше.\n' +
    'unknown — по фрагменту понять нельзя.\n' +
    'Также верни год публикации, если он виден в тексте, иначе 0. ' +
    'Обоснование — одно предложение на русском.';

  await mapLimit(rows, 5, async (p) => {
    const page = await fetchPage(p.source_url);
    if (!page.ok) { upd.run('unknown', 'страница недоступна', null, p.id); stat.unknown++; return; }
    const win = nameWindow(htmlToText(page.html), p.full_name);
    const r = await askJson(client, db, {
      stage: 'verify', model: model ?? cheap(), system, schema: VERIFY_SCHEMA, maxTokens: 700,
      user: `Компания: ${p.company}\nЧеловек: ${p.full_name}\nДолжность: ${p.title}\nИсточник: ${p.source_url}\n\nФрагмент:\n"""\n${win}\n"""`,
    });
    stat.checked++;
    if (!r.ok) { upd.run('unknown', 'ошибка проверки', null, p.id); stat.unknown++; return; }
    const d = r.data;
    const year = d.published_year && d.published_year > 1900 ? String(d.published_year) : null;
    if (year && Number(year) < freshSince) {
      upd.run('false', `публикация ${year} — старше ${freshSince}`, year, p.id); stat.rejected++; return;
    }
    upd.run(d.works_there === 'yes' ? 'true' : d.works_there === 'no' ? 'false' : 'unknown', d.reason ?? '', year, p.id);
    stat[d.works_there === 'yes' ? 'confirmed' : d.works_there === 'no' ? 'rejected' : 'unknown']++;
  }, onProgress);
  return stat;
}

// ───────────────────── 9. Почты ─────────────────────

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: { full_name: { type: 'string' }, email: { type: 'string' }, reason: { type: 'string' } },
        required: ['full_name', 'email', 'reason'], additionalProperties: false,
      },
    },
  },
  required: ['matches'], additionalProperties: false,
};

/**
 * Подбор почт. Источник выбирает пользователь:
 *   site      — только то, что нашлось на сайтах (бесплатно, находит меньше)
 *   providers — только платные сервисы (сайты не нужны)
 *   both      — сначала бесплатно, платно только за остаток (по умолчанию)
 */
export async function findEmails(db, client, { model, buy = true, source, limit, guess = false, onProgress } = {}) {
  const src = (source ?? process.env.EMAIL_SOURCES ?? 'both').toLowerCase();
  const useSite = src !== 'providers';
  const usePaid = buy && src !== 'site';
  const keep = (process.env.KEEP_PERSONAL_EMAILS ?? 'true') !== 'false';
  // email_status обязательно сбрасывается вместе с новой почтой.
  //
  // Без этого получалась тихая подмена: адрес отбраковывался валидацией
  // (email=NULL, email_status='отбракована: do_not_mail'), в следующем прогоне
  // сервис находил новый адрес, запись обновлялась — а старый статус
  // оставался. validateEmails() берёт только строки с email_status IS NULL,
  // поэтому новый адрес больше никогда не проверялся и уезжал в выгрузку
  // с чужой отметкой «отбракована», выглядя при этом годным.
  const setEmail = db.prepare(`UPDATE people SET email=?, email_source=?, email_status=NULL WHERE id=?`);
  // отдельный вариант для уже проверенных адресов: подбор по шаблону берёт
  // только те, что валидатор прямо назвал valid, — платить за них второй раз незачем
  const setEmailChecked = db.prepare(`UPDATE people SET email=?, email_source=?, email_status=? WHERE id=?`);
  const stat = { matched: 0, byLlm: 0, bought: 0, notFound: 0, source: src,
                 providers: activeProviders().map((p) => p.name) };

  const companies = db.prepare(`
    SELECT DISTINCT c.id, c.name, c.domain, c.emails_import, c.emails_site
    FROM companies c JOIN people p ON p.company_id=c.id
    WHERE c.icp_status='pass' AND p.verified IN ('true','unknown','trusted') AND p.title_match='pass' AND p.email IS NULL`).all();

  for (const c of useSite ? companies : []) {
    const emails = [...new Set([...(unj(c.emails_import) ?? []), ...(unj(c.emails_site) ?? [])].map((e) => e.toLowerCase()))];
    const staff = db.prepare(`
      SELECT id, full_name, title FROM people
      WHERE company_id=? AND email IS NULL AND title_match='pass' AND verified IN ('true','unknown','trusted')`).all(c.id);

    // 9.1 шаблоны — бесплатно
    const left = [];
    for (const p of staff) {
      const e = matchEmailToPerson(p.full_name, emails, c.domain);
      if (e) { setEmail.run(e, 'найдена в собранных', p.id); stat.matched++; }
      else left.push(p);
    }

    // 9.2 остаток — одним вызовом на компанию
    if (left.length && emails.length) {
      const r = await askJson(client, db, {
        stage: 'email-match', model: model ?? cheap(), schema: MATCH_SCHEMA, companyId: c.id, maxTokens: 1500,
        system: 'Тебе дают список почт компании и список сотрудников. Найди почты, ' +
                'построенные из ИМЕНИ ИЛИ ФАМИЛИИ конкретного человека: ivanov@, ' +
                'p.ivanov@, ivanovpetr@, ivanovceo@, psi@ (инициалы).\n\n' +
                'НЕ сопоставляй ящики отделов и функций, даже если должность человека ' +
                'совпадает с назначением ящика: sbyt@ (сбыт), omts@ (снабжение), pdo@, ' +
                'otk@, kom@ (коммерческий), tehnolog@, glavbuh@, buh@, snab@, sklad@, ' +
                'kadry@, info@, zakaz@, sales@ — это ящики подразделений, они не ' +
                'принадлежат никому лично.\n\n' +
                'Одна почта — не более чем один человек. Если непонятно, чья она, ' +
                'не отдавай её никому. Пустой ответ лучше неверного: письмо, ушедшее ' +
                'не тому адресату, дороже ненайденного контакта.',
        user: `Компания: ${c.name} (${c.domain})\n\nПочты:\n${emails.join('\n')}\n\n` +
              `Сотрудники:\n${left.map((p) => `${p.full_name} — ${p.title}`).join('\n')}`,
      });
      if (r.ok) {
        const taken = new Set(
          db.prepare(`SELECT email FROM people WHERE company_id=? AND email IS NOT NULL`)
            .all(c.id).map((x) => x.email));
        for (const m of r.data.matches ?? []) {
          const p = left.find((x) => x.full_name === m.full_name);
          const email = (m.email ?? '').toLowerCase();
          if (!p || !emails.includes(email)) continue;
          // почта должна быть выводима из имени человека, а не быть ящиком отдела
          if (!looksPersonal(p.full_name, email)) { stat.rejected = (stat.rejected ?? 0) + 1; continue; }
          // и не может достаться второму человеку
          if (taken.has(email)) { stat.rejected = (stat.rejected ?? 0) + 1; continue; }
          taken.add(email);
          setEmail.run(email, 'подобрана нейросетью', p.id);
          stat.byLlm++;
        }
      }
    }
    onProgress?.(companies.indexOf(c) + 1, companies.length);
  }

  // 9.3 waterfall — платно, только для оставшихся
  if (usePaid && activeProviders().length) {
    const rest = db.prepare(`
      SELECT p.id, p.full_name, c.domain, c.name AS company FROM people p JOIN companies c ON c.id=p.company_id
      WHERE c.icp_status='pass' AND p.email IS NULL AND p.title_match='pass' AND p.verified IN ('true','unknown','trusted')
      ${limit ? 'LIMIT ' + Number(limit) : ''}`).all();
    stat.paidQueue = rest.length;
    // асинхронные сервисы отвечают не сразу — без этой строки этап выглядит зависшим
    process.stdout.write(`\n  платный поиск: ${rest.length} человек, сервисы отвечают не мгновенно\n`);
    await mapLimit(rest, 3, async (p) => {
      const f = parseFio(p.full_name);
      const r = await findEmail(db, { first: f?.first ?? '', last: f?.last ?? '', full: p.full_name, domain: p.domain, company: p.company });
      if (r.email && (keep || !/(mail|ya|yandex|bk|inbox|list|rambler|gmail)\./.test(r.email.split('@')[1] ?? ''))) {
        setEmail.run(r.email, r.source, p.id); stat.bought++;
      } else stat.notFound++;
    }, onProgress);
  }

  // 9.4 подбор по шаблону — только если пользователь на него согласился
  if (guess) {
    const rest = db.prepare(`
      SELECT p.id, p.full_name, c.domain FROM people p JOIN companies c ON c.id=p.company_id
      WHERE c.icp_status='pass' AND p.email IS NULL AND p.title_match='pass'
        AND p.verified IN ('true','unknown','trusted') AND c.domain IS NOT NULL`).all();
    stat.guessQueue = rest.length;
    stat.guessed = 0; stat.catchAll = 0;
    if (rest.length) process.stdout.write(`\n  подбор по шаблону: ${rest.length} человек, каждая проверка — кредит валидатора\n`);
    await mapLimit(rest, 3, async (p) => {
      const g = await guessEmail(db, { full: p.full_name, domain: p.domain });
      if (g.email) { setEmailChecked.run(g.email, 'подобрана по шаблону', 'valid', p.id); stat.guessed++; }
      else if (g.catchAll) stat.catchAll++;
    }, onProgress);
  }
  return stat;
}

export async function validateEmails(db, { onProgress } = {}) {
  if (!(process.env.ZEROBOUNCE_API_KEY ?? '').trim()) return { skipped: true };
  // проверяем только купленные: найденные на сайте и так рабочие
  const rows = db.prepare(`
    SELECT id, email FROM people
    WHERE email IS NOT NULL AND email_status IS NULL
      AND email_source NOT IN ('найдена в собранных','подобрана нейросетью')`).all();
  if (!rows.length) return { checked: 0 };
  const upd = db.prepare(`UPDATE people SET email_status=? WHERE id=?`);
  const drop = db.prepare(`UPDATE people SET email=NULL, email_status=? WHERE id=?`);
  const stat = { checked: 0, ok: 0, dropped: 0 };
  await mapLimit(rows, 4, async (p) => {
    const v = await validateEmail(db, p.email);
    stat.checked++;
    if (v.ok) { upd.run(`${v.status}${v.sub ? ' / ' + v.sub : ''}`, p.id); stat.ok++; }
    else { drop.run(`отбракована: ${v.status}`, p.id); stat.dropped++; }
  }, onProgress);
  return stat;
}

// ───────────────────── 10. Склонения для писем ─────────────────────

const DECLINE_SCHEMA = {
  type: 'object',
  properties: {
    names: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          full_name: { type: 'string' }, nominative: { type: 'string' }, dative: { type: 'string' },
        },
        required: ['full_name', 'nominative', 'dative'], additionalProperties: false,
      },
    },
  },
  required: ['names'], additionalProperties: false,
};

/**
 * Обращение для письма: «Имя Отчество» в именительном и дательном падеже.
 *
 * Эти поля уходят в текст письма переменными, поэтому именительный падеж
 * считается кодом и нейросети не доверяется вовсе. Раньше ей отдавали
 * строку ФИО и обещали формат «Фамилия Имя Отчество» — на «Ирина Шамина»
 * она брала фамилию за имя, и в письме получалось обращение «Шамина»,
 * а дательный оставался пустым.
 *
 * Нейросеть отвечает только за дательный падеж: там встречаются беглые
 * гласные и нерусские имена, где правила ошибаются. Её ответ проверяет
 * superviseDecline, и что не прошло проверку — склоняется по правилам.
 */
export async function declineNames(db, client, { model } = {}) {
  const rows = db.prepare(`
    SELECT DISTINCT p.full_name FROM people p JOIN companies c ON c.id=p.company_id
    WHERE c.icp_status='pass' AND p.name_dative IS NULL AND TRIM(COALESCE(p.full_name,''))<>''`).all();
  if (!rows.length) return { done: 0 };

  const upd = db.prepare(`UPDATE people SET name_nominative=?, name_dative=? WHERE full_name=?`);
  const stat = { done: 0, fixed: 0, noName: 0, problems: [] };

  // именительный падеж — всегда наш, из разбора ФИО
  const want = new Map();
  for (const { full_name } of rows) {
    const p = orderedFio(full_name);
    const nom = [p?.first, p?.patronymic].filter(Boolean).join(' ').trim();
    if (nom) want.set(full_name, { nom, first: p.first, patronymic: p.patronymic });
    else { upd.run('', '', full_name); stat.noName++; }
  }
  if (!want.size) return stat;

  const system =
    'Тебе дают обращения к российским сотрудникам в именительном падеже: ' +
    'имя или имя с отчеством, без фамилии.\n' +
    'Для каждого верни то же самое в ДАТЕЛЬНОМ падеже — это обращение ' +
    'в письме, «письмо кому».\n' +
    '  «Пётр Сергеевич» → «Петру Сергеевичу»\n' +
    '  «Ирина» → «Ирине»\n' +
    '  «Ксения» → «Ксении»\n' +
    'Поле nominative возвращай ровно тем, что дали, ничего в нём не меняя. ' +
    'Имена нерусского происхождения склоняй по правилам русского языка ' +
    'для таких имён; если имя не склоняется — верни его без изменений.';

  const CHUNK = 25;
  const list = [...want.entries()];
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const byNom = new Map(chunk.map(([full, w]) => [w.nom.toLowerCase(), full]));
    const r = await askJson(client, db, {
      stage: 'decline', model: model ?? cheap(), system, schema: DECLINE_SCHEMA, maxTokens: 2500,
      user: chunk.map(([, w], k) => `${k + 1}. ${w.nom}`).join('\n'),
    });

    const got = new Map();
    if (r.ok) for (const n of r.data.names ?? []) {
      const full = byNom.get(String(n.full_name ?? n.nominative ?? '').trim().toLowerCase());
      if (full) got.set(full, n);
    }

    // проверяем каждую строку, даже если нейросеть по ней вообще не ответила
    for (const [full, w] of chunk) {
      const n = got.get(full) ?? {};
      const v = superviseDecline({
        expectedFirst: w.first, expectedPatronymic: w.patronymic,
        nominative: n.nominative ?? '', dative: n.dative ?? '',
      });
      if (!v.ok) { stat.fixed++; if (stat.problems.length < 5) stat.problems.push(`${full}: ${v.problems.join(', ')}`); }
      upd.run(v.nominative, v.dative, full);
      stat.done++;
    }
  }
  return stat;
}
