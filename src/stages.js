// Этапы пайплайна. Каждый идемпотентен: перезапуск не переделывает уже сделанное.

import fs from 'node:fs';
import { j, unj, logUsage } from './db.js';
import { fetchPage, domainOf, normalizeUrl, mapLimit } from './http.js';
import { htmlToText, htmlMeta, extractEmails, extractPhones, extractInternalLinks, estimateTokens } from './extract.js';
import { askJson, batchSubmit, batchWait, batchCollect, pendingBatch, batchStatus } from './llm.js';

// ─────────────────────────── 1. Импорт ───────────────────────────

export function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift().map((h) => h.replace(/^﻿/, ''));
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

export function toCSV(rows, columns) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [columns.map(esc).join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}

/** Гибкое сопоставление колонок: файлы у всех разные (Компас, Datanewton, Навигатор). */
const COLUMN_ALIASES = {
  // Бренд и юрлицо — разные вещи. В интернете людей упоминают рядом
  // с «Bang Bang Education», а не с «ООО Сила Знания», поэтому в поиск
  // и в таблицы идёт бренд, а юрлицо сохраняется отдельным полем.
  brand:     [/бренд/i, /brand/i, /торгов\w*\s*марк/i, /^тм$/i,
              /коммерческ\w*\s*(?:назв|наимен)/i, /^trade\s*mark$/i],
  legal_name:[/^(?:ооо|оао|зао|пао|ао|ип)$/i, /юр\w*[\s.-]*(?:лиц|наимен|назв)/i,
              /legal\s*(?:name|entity)?/i, /полное\s*наимен/i,
              /наименован/i, /^компан/i, /название/i, /^name$/i, /organization/i],
  inn:       [/инн/i, /^inn$/i, /tax/i],
  site:      [/сайт/i, /site/i, /website/i, /url/i, /домен/i],
  ceo_name:  [/фио.*(руковод|директор)/i, /руководител/i, /директор/i, /ceo/i],
  ceo_title: [/должность.*руковод/i, /должность/i],
  phones:    [/телефон/i, /phone/i],
  emails:    [/^все почты/i, /почт/i, /e-?mail/i],
};

export function detectColumns(sample) {
  const cols = Object.keys(sample);
  const map = {};
  for (const [field, patterns] of Object.entries(COLUMN_ALIASES)) {
    for (const p of patterns) {
      const hit = cols.find((c) => p.test(c) && (sample[c] ?? '').trim() !== '');
      if (hit && !Object.values(map).includes(hit)) { map[field] = hit; break; }
    }
  }
  // рабочее название компании: бренд, если он есть, иначе юрлицо
  map.name = map.brand ?? map.legal_name;
  return map;
}

/** Строка может быть пустой в колонке бренда — тогда падаем на юрлицо. */
const pickName = (r, map) =>
  (map.brand && (r[map.brand] ?? '').trim()) || (map.legal_name && (r[map.legal_name] ?? '').trim()) || '';

const splitList = (s) => (s ?? '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

export function importCsv(db, file, { columns } = {}) {
  const rows = parseCSV(fs.readFileSync(file, 'utf8'));
  if (!rows.length) throw new Error('Файл пустой');
  const map = columns ?? detectColumns(rows[0]);
  if (!map.site && !map.name) throw new Error('Не нашёл ни колонки с сайтом, ни с названием компании');
  if (!map.name) throw new Error(
    'Не нашёл колонку с названием компании. Ожидаю что-то вроде «Наименование», ' +
    '«Компания», «Бренд», «Brand», «ООО». Колонки в файле: ' + Object.keys(rows[0]).join(', '));

  const ins = db.prepare(`
    INSERT INTO companies (domain, inn, name, legal_name, site, ceo_name, ceo_title, phones, emails_import)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(domain) DO UPDATE SET
      inn           = COALESCE(NULLIF(excluded.inn,''), companies.inn),
      name          = COALESCE(NULLIF(excluded.name,''), companies.name),
      legal_name    = COALESCE(NULLIF(excluded.legal_name,''), companies.legal_name),
      ceo_name      = COALESCE(NULLIF(excluded.ceo_name,''), companies.ceo_name),
      emails_import = excluded.emails_import`);

  // Отдельно считаем НОВЫЕ и УЖЕ ИЗВЕСТНЫЕ: при регулярной подгрузке по триггерам
  // именно это главная цифра — сколько компаний реально пойдёт в обработку.
  const known = new Set(db.prepare(`SELECT domain FROM companies`).all().map((r) => r.domain));
  const stat = { total: rows.length, imported: 0, already: 0, no_site: 0, duplicates: 0 };
  const seen = new Set();
  for (const r of rows) {
    const site = normalizeUrl(r[map.site] ?? '');
    const domain = site ? domainOf(site) : null;
    if (!domain) { stat.no_site++; continue; }
    if (seen.has(domain)) { stat.duplicates++; continue; }
    seen.add(domain);
    ins.run(domain, r[map.inn] ?? '', pickName(r, map), (map.legal_name && r[map.legal_name]) || '', site,
      r[map.ceo_name] ?? '', r[map.ceo_title] ?? '',
      j(splitList(r[map.phones])), j(splitList(r[map.emails])));
    if (known.has(domain)) stat.already++; else stat.imported++;
  }

  // ФИО директора из импорта — сразу в таблицу людей, это готовый контакт
  const people = db.prepare(`
    INSERT OR IGNORE INTO people (company_id, full_name, title, origin)
    SELECT id, ceo_name, COALESCE(NULLIF(ceo_title,''),'Руководитель'), 'import'
    FROM companies WHERE ceo_name IS NOT NULL AND TRIM(ceo_name) <> ''`).run();
  stat.people_from_import = people.changes;
  stat.column_map = map;
  return stat;
}

// ─────────────────────── 2. Загрузка главных страниц ───────────────────────

export async function fetchHomepages(db, { limit = 12, only = null, onProgress } = {}) {
  const rows = db.prepare(
    `SELECT id, site, domain, name FROM companies WHERE fetch_status = 'pending' ${only ? 'LIMIT ' + Number(only) : ''}`
  ).all();
  if (!rows.length) return { fetched: 0, note: 'нечего загружать — все уже обработаны' };

  const upd = db.prepare(`UPDATE companies SET fetch_status=?, fetch_via=?, fetch_error=?, text_len=?,
                          emails_site=?, phones_site=? WHERE id=?`);
  const insPage  = db.prepare(`INSERT OR REPLACE INTO pages (company_id, kind, url, text) VALUES (?,?,?,?)`);
  const insCand  = db.prepare(`INSERT OR IGNORE  INTO pages (company_id, kind, url, text) VALUES (?,?,?,NULL)`);
  const stat = { ok: 0, failed: 0, via: {}, errors: {}, thin: 0 };

  await mapLimit(rows, limit, async (c) => {
    const res = await fetchPage(c.site);
    if (!res.ok) {
      upd.run('failed', null, res.error, 0, j([]), j([]), c.id);
      stat.failed++; stat.errors[res.error] = (stat.errors[res.error] ?? 0) + 1;
      return;
    }
    const text = htmlToText(res.html);
    const emails = extractEmails(res.html);
    const phones = extractPhones(res.html);
    insPage.run(c.id, 'home', res.finalUrl ?? c.site, text);

    // сохраняем найденные внутренние ссылки — догрузим их только победителям ICP
    const links = extractInternalLinks(res.html, res.finalUrl ?? c.site);
    for (const [kind, urls] of Object.entries(links))
      for (const u of urls) insCand.run(c.id, kind + ':candidate', u);

    upd.run('ok', res.via, null, text.length, j(emails), j(phones), c.id);
    stat.ok++; stat.via[res.via] = (stat.via[res.via] ?? 0) + 1;
    if (text.length < 400) stat.thin++;      // вероятно JS-сайт — нужен Playwright
  }, onProgress);

  return stat;
}

// ─────────────────────────── 3. Квалификация ───────────────────────────

// Никаких null и union-типов: структурированный вывод их не принимает
// (enum со значением null → 400 invalid_request_error). Вместо этого —
// строковые перечисления с явным значением «непонятно».
// Схема нарочно НЕ привязана к отрасли: что значит «подходит», описано словами
// в prompts/qualify.md. Раньше поля назывались is_manufacturer/equipment_level,
// и под каждый новый ICP приходилось лезть в код — обещание «код трогать не надо»
// не работало.
//
//   fits  — главный критерий: подходит / не подходит / по тексту не понять
//   extra — второй критерий, если он у вас есть. Если критерий один,
//           модель ставит not_applicable, и он ни на что не влияет.
export const QUALIFY_SCHEMA = {
  type: 'object',
  properties: {
    fits:         { type: 'string', enum: ['yes', 'no', 'unknown'] },
    fits_reason:  { type: 'string' },
    extra:        { type: 'string', enum: ['yes', 'no', 'unclear', 'not_applicable'] },
    extra_reason: { type: 'string' },
    category:     { type: 'string' },
    evidence:     { type: 'array', items: { type: 'string' } },
    needs_review: { type: 'boolean' },
  },
  required: ['fits', 'fits_reason', 'extra', 'extra_reason', 'category', 'evidence', 'needs_review'],
  additionalProperties: false,
};

export function loadPrompt(file = 'prompts/qualify.md') {
  const md = fs.readFileSync(file, 'utf8');
  const system = md.split('## SYSTEM')[1]?.split('## USER')[0]?.trim();
  const user = md.split('## USER')[1]?.trim();
  if (!system || !user) throw new Error(`В ${file} должны быть секции "## SYSTEM" и "## USER"`);
  return { system, user };
}

const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');

/** Собираем один компактный вход на компанию. Текст режем — на реальных сайтах
 *  первые ~12k символов содержат всё нужное, а хвост это меню и футер. */
function qualifyInput(db, c, userTpl, maxChars = 12000) {
  const page = db.prepare(`SELECT text FROM pages WHERE company_id=? AND kind='home'`).get(c.id);
  const text = (page?.text ?? '').slice(0, maxChars);
  return fill(userTpl, {
    name: c.name, inn: c.inn, site: c.site,
    title: c.title ?? '', description: c.description ?? '', h1: '',
    text,
  });
}

export async function qualify(db, client, { model, batch = false, wait = true, only = null, onProgress } = {}) {
  const { system, user: userTpl } = loadPrompt();
  const rows = db.prepare(
    `SELECT id, name, inn, site FROM companies
     WHERE fetch_status='ok' AND icp_status='pending' ${only ? 'LIMIT ' + Number(only) : ''}`
  ).all();
  if (!rows.length) return { done: 0, note: 'нечего квалифицировать' };

  const stat = { pass: 0, fail: 0, unclear: 0, error: 0 };
  const bump = (s) => { stat[s] = (stat[s] ?? 0) + 1; };
  const applyAll = (res) => { for (const c of rows) bump(applyQualify(db, c.id, res.get('c' + c.id))); };

  if (batch) {
    const reqs = rows.map((c) => ({ id: 'c' + c.id, user: qualifyInput(db, c, userTpl) }));
    const id = await batchSubmit(client, db, { stage: 'qualify', model, system, schema: QUALIFY_SCHEMA, requests: reqs });
    if (!wait) return { submitted: id, n: rows.length };
    applyAll(await batchWait(client, db, { id, stage: 'qualify', model, onProgress }));
    return { ...stat, batchId: id };
  }

  await mapLimit(rows, 6, async (c) => {
    const r = await askJson(client, db, {
      stage: 'qualify', model, system, user: qualifyInput(db, c, userTpl),
      schema: QUALIFY_SCHEMA, companyId: c.id,
    });
    bump(applyQualify(db, c.id, r));
  }, onProgress);
  return stat;
}

/** Понять и новый формат ответа, и старый (is_manufacturer/equipment_level),
 *  чтобы базы, собранные до переименования полей, продолжали читаться. */
export function normalizeVerdict(d) {
  if (!d || d.fits !== undefined) return d ?? {};
  const LVL = { high: 'yes', low: 'no', unclear: 'unclear', not_applicable: 'not_applicable' };
  return {
    fits: d.is_manufacturer ?? 'unknown',
    fits_reason: d.manufacturer_reason ?? '',
    extra: LVL[d.equipment_level] ?? 'not_applicable',
    extra_reason: d.equipment_reason ?? '',
    category: d.production_type ?? '',
    evidence: d.evidence ?? [],
    needs_review: d.needs_review ?? false,
  };
}

/** Записать вердикт по одной компании. «Под вопросом» — отдельный статус, не отбраковка. */
function applyQualify(db, id, r) {
  const upd = db.prepare(`UPDATE companies SET icp_status=?, icp_json=?, icp_reason=? WHERE id=?`);
  if (!r?.ok) { upd.run('error', j(r ?? null), r?.error ?? 'unknown', id); return 'error'; }
  const d = normalizeVerdict(r.data);
  // «Под вопросом» — отдельная корзина, а не отбраковка: по таким компаниям
  // судить нельзя, и терять их молча дороже, чем просмотреть глазами.
  const status =
    d.fits === 'yes'
      ? (d.extra === 'no' ? 'fail' : d.extra === 'unclear' ? 'unclear' : 'pass')
      : d.fits === 'unknown' ? 'unclear' : 'fail';
  upd.run(status, j(d), [d.fits_reason, d.extra_reason].filter(Boolean).join(' | '), id);
  return status;
}

/** Забрать ранее отправленную пачку. Позволяет закрыть ноутбук и вернуться позже. */
export async function collectQualify(db, client, { model } = {}) {
  const b = pendingBatch(db, 'qualify');
  if (!b) return { none: true };
  const st = await batchStatus(client, b.id);
  if (!st.done) return { waiting: true, ...st, id: b.id };
  const res = await batchCollect(client, db, { id: b.id, stage: 'qualify', model: b.model ?? model });
  const stat = { pass: 0, fail: 0, unclear: 0, error: 0 };
  for (const key of (unj(b.ids) ?? [])) {
    const s = applyQualify(db, Number(key.slice(1)), res.get(key));
    stat[s] = (stat[s] ?? 0) + 1;
  }
  return { ...stat, id: b.id };
}
