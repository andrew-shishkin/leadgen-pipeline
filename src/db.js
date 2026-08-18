// Состояние пайплайна. Даёт resume после падения, дедупликацию и учёт расходов.
// Используется встроенный node:sqlite — никаких нативных сборок, работает сразу после npm install.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file = 'out/leadgen.db') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id           INTEGER PRIMARY KEY,
      domain       TEXT UNIQUE,          -- ключ дедупликации
      inn          TEXT,
      name         TEXT,
      site         TEXT,
      ceo_name     TEXT,
      ceo_title    TEXT,
      phones       TEXT,                 -- JSON-массив
      emails_import TEXT,                -- JSON-массив, почты из исходного файла

      fetch_status TEXT DEFAULT 'pending', -- pending | ok | failed | dead
      fetch_via    TEXT,                   -- какая ступень каскада сработала
      fetch_error  TEXT,
      text_len     INTEGER,

      emails_site  TEXT,                 -- JSON-массив, найдено regex-ом
      phones_site  TEXT,

      icp_status   TEXT DEFAULT 'pending', -- pending | pass | fail | unclear | error
      icp_json     TEXT,                   -- полный ответ модели
      icp_reason   TEXT,

      people_status TEXT DEFAULT 'pending',
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pages (
      id         INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      kind       TEXT NOT NULL,          -- home | contacts | about | team | products
      url        TEXT NOT NULL,
      text       TEXT,
      fetched_at TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, url)
    );

    CREATE TABLE IF NOT EXISTS people (
      id            INTEGER PRIMARY KEY,
      company_id    INTEGER NOT NULL REFERENCES companies(id),
      full_name     TEXT NOT NULL,
      title         TEXT,
      origin        TEXT,                -- import | site | search
      source_url    TEXT,
      published_at  TEXT,
      title_match   TEXT DEFAULT 'pending', -- pending | pass | fail
      verified      TEXT DEFAULT 'pending', -- pending | true | false | unknown | skipped
      verify_reason TEXT,
      email         TEXT,
      email_source  TEXT,                -- matched | wiza | prospeo | fullenrich | findymail
      email_status  TEXT,                -- результат валидатора
      created_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, full_name)
    );

    -- каждый вызов LLM и платного API: сколько токенов, сколько денег, на каком этапе
    CREATE TABLE IF NOT EXISTS usage (
      id         INTEGER PRIMARY KEY,
      stage      TEXT,
      provider   TEXT,
      model      TEXT,
      company_id INTEGER,
      tokens_in  INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0,
      units      REAL DEFAULT 0,         -- для непоточных API: 1 запрос = 1 единица
      usd        REAL DEFAULT 0,
      at         TEXT DEFAULT (datetime('now'))
    );

    -- отправленные пачки: позволяют закрыть ноутбук и забрать результат позже
    CREATE TABLE IF NOT EXISTS batches (
      id        TEXT PRIMARY KEY,        -- id пачки у провайдера
      stage     TEXT,
      provider  TEXT,
      model     TEXT,
      n         INTEGER,
      ids       TEXT,                    -- JSON: какие строки в неё вошли
      status    TEXT DEFAULT 'submitted',-- submitted | collected
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS ix_comp_fetch  ON companies(fetch_status);
    CREATE INDEX IF NOT EXISTS ix_comp_icp    ON companies(icp_status);
    CREATE INDEX IF NOT EXISTS ix_people_comp ON people(company_id);
  `);
  migrate(db);
  return db;
}

/** Добавить колонки, появившиеся позже, не ломая уже существующую базу. */
function migrate(db) {
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));
  const add = (t, name, decl) => { if (!cols(t).has(name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${decl}`); };
  add('companies', 'search_status', 'TEXT');
  add('companies', 'legal_name', 'TEXT');
  add('people', 'name_nominative', 'TEXT');
  add('people', 'name_dative', 'TEXT');
}

export const j = (v) => JSON.stringify(v ?? null);
export const unj = (s) => { try { return JSON.parse(s); } catch { return null; } };

export function logUsage(db, row) {
  db.prepare(`INSERT INTO usage (stage,provider,model,company_id,tokens_in,tokens_out,cache_read,units,usd)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(
    row.stage, row.provider ?? 'anthropic', row.model ?? null, row.company_id ?? null,
    row.tokens_in ?? 0, row.tokens_out ?? 0, row.cache_read ?? 0, row.units ?? 0, row.usd ?? 0);
}

/** Сводка расходов по этапам — то, что скрипт показывает после первых 20 строк. */
export function costReport(db) {
  const rows = db.prepare(`
    SELECT stage, provider, model,
           COUNT(*) n, SUM(tokens_in) ti, SUM(tokens_out) to_, SUM(units) u, SUM(usd) usd
    FROM usage GROUP BY stage, provider, model ORDER BY usd DESC`).all();
  const total = rows.reduce((s, r) => s + (r.usd ?? 0), 0);
  return { rows, total };
}
