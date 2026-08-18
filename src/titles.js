// Работа со списком должностей: отчёт и предложения по расширению.
//
// Список должностей — самое узкое место конвейера. Из него собираются
// поисковые запросы: чего в нём нет, того поиск не найдёт никогда,
// и никакие последующие этапы этого не исправят.

import fs from 'node:fs';
import { loadTitles } from './stages-people.js';
import { buildQueries, topicWords, searchProviderName } from './search.js';
import { askJson } from './llm.js';
import { matchTitles } from './stages-people.js';

const SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          group: { type: 'string', enum: ['target', 'accept', 'reject'] },
          why:   { type: 'string' },
        },
        required: ['title', 'group', 'why'], additionalProperties: false,
      },
    },
  },
  required: ['suggestions'], additionalProperties: false,
};

/** Должности, которые реально встретились, но были отбракованы фильтром.
 *  Лучший источник для расширения списка: это не догадки, а живые данные. */
export function rejectedTitles(db, limit = 25) {
  try {
    return db.prepare(`
      SELECT title, COUNT(*) n FROM people
      WHERE title_match='fail' AND title IS NOT NULL AND TRIM(title) <> ''
      GROUP BY LOWER(TRIM(title)) ORDER BY n DESC LIMIT ?`).all(limit);
  } catch { return []; }
}

export function titlesReport(db) {
  const t = loadTitles();
  const search = [...t.targets, ...t.accept];
  const demo = { name: 'Компания', domain: 'example.ru' };
  const qs = buildQueries(demo, search);
  const L = [];

  L.push('', '─'.repeat(64), '  СПИСОК ДОЛЖНОСТЕЙ', '─'.repeat(64), '');
  L.push(`  ищем (TARGETS):        ${t.targets.length}`);
  L.push(`  тоже засчитываем:      ${t.accept.length}`);
  L.push(`  отсекаем (REJECT):     ${t.reject.length}`);
  L.push('');
  L.push(`  в поиск уходит ${search.length} формулировок → ${qs.length} запросов на компанию`);
  L.push(`  провайдер поиска: ${searchProviderName()}`);
  const topics = topicWords(search);
  if (topics.length) L.push(`  широкий запрос ищет по темам: ${topics.join(', ')}`);
  L.push('');
  for (const q of qs) L.push(`    [${q.kind.padEnd(7)}] ${q.q.slice(0, 110)}${q.q.length > 110 ? ' …' : ''}`);

  if (t.targets.length + t.accept.length < 12) {
    L.push('', '  ⚠️  Список короткий. Формулировок у одной и той же роли обычно',
               '      в 2-3 раза больше: "Директор по маркетингу", "Руководитель',
               '      отдела маркетинга", "Начальник отдела маркетинга", "Head of',
               '      Marketing", "CMO" — это один человек, но четыре разных строки',
               '      в источниках. Расширить: node run.js titles --suggest');
  }

  const rej = rejectedTitles(db);
  if (rej.length) {
    L.push('', '─'.repeat(64), '  НАШЛИ, НО ОТСЕЯЛИ ПО ДОЛЖНОСТИ', '─'.repeat(64), '');
    L.push('  Эти люди уже найдены. Если кто-то из них вам подходит —');
    L.push('  допишите формулировку в TARGETS или ALSO_ACCEPT и запустите заново.', '');
    for (const r of rej) L.push(`    ${String(r.n).padStart(4)}  ${r.title}`);
  }
  L.push('', '─'.repeat(64), '');
  console.log(L.join('\n'));
  return { targets: t.targets.length, accept: t.accept.length, queries: qs.length };
}

/** Один вызов модели: предложить формулировки, которых в списке нет. */
export async function suggestTitles(db, client, { model } = {}) {
  const t = loadTitles();
  const icp = fs.existsSync('prompts/qualify.md')
    ? fs.readFileSync('prompts/qualify.md', 'utf8').slice(0, 2500) : '';
  const rej = rejectedTitles(db, 30).map((r) => `${r.title} (${r.n})`);

  const system =
    'Ты помогаешь собрать список должностей для поиска ЛПР через поисковые системы.\n' +
    'Задача: предложить формулировки, которых в текущем списке НЕТ, но под которыми\n' +
    'тот же самый человек встречается в интернете.\n\n' +
    'Учитывай, что одну роль в источниках называют по-разному:\n' +
    '— русский и английский вариант ("Директор по маркетингу" / "Head of Marketing");\n' +
    '— через отдел ("Руководитель отдела маркетинга", "Начальник отдела маркетинга");\n' +
    '— аббревиатуры (CMO, CTO, CDO);\n' +
    '— смежные уровни (заместитель, исполняющий обязанности).\n\n' +
    'group: target — та же роль другими словами; accept — смежная роль, тоже подойдёт;\n' +
    'reject — похоже на цель, но это другой человек (частое ложное срабатывание).\n' +
    'why — одна короткая строка, зачем это в списке. Пиши только по-русски.\n' +
    'Не повторяй то, что уже есть. Не предлагай больше 25 штук.';

  const user =
    (icp ? `Кого отбираем (критерии ICP):\n${icp}\n\n` : '') +
    `Сейчас в списке.\nTARGETS:\n${t.targets.join('\n') || '(пусто)'}\n\n` +
    `ALSO_ACCEPT:\n${t.accept.join('\n') || '(пусто)'}\n\n` +
    `REJECT:\n${t.reject.join('\n') || '(пусто)'}\n\n` +
    (rej.length ? `Реально встретились в выдаче, но были отсеяны:\n${rej.join('\n')}\n\n` : '') +
    'Что добавить?';

  const r = await askJson(client, db, {
    stage: 'titles-suggest', model, system, user, schema: SUGGEST_SCHEMA, maxTokens: 2500,
  });
  if (!r.ok) { console.log(`\n  Не получилось: ${r.error}\n`); return null; }

  const have = new Set([...t.targets, ...t.accept, ...t.reject].map((x) => x.toLowerCase().trim()));
  const fresh = (r.data.suggestions ?? []).filter((x) => !have.has(x.title.toLowerCase().trim()));
  const L = ['', '─'.repeat(64), '  ЧТО МОЖНО ДОБАВИТЬ', '─'.repeat(64), ''];
  const GROUP = { target: 'в TARGETS', accept: 'в ALSO_ACCEPT', reject: 'в REJECT' };
  let i = 0;
  for (const g of ['target', 'accept', 'reject']) {
    const items = fresh.filter((x) => x.group === g);
    if (!items.length) continue;
    L.push(`  ${GROUP[g]}:`);
    for (const x of items) L.push(`    ${String(++i).padStart(2)}. ${x.title.padEnd(38)} ${x.why}`);
    L.push('');
  }
  L.push('  Выберите номера, которые вам подходят, — остальные не добавляйте.',
         '  Лишняя должность в TARGETS стоит лишнего поискового запроса на компанию.',
         '─'.repeat(64), '');
  console.log(L.join('\n'));
  return fresh;
}


/** Какие должности лежат в загруженном файле — до всякой фильтрации. */
export function importedTitles(db, limit = 40) {
  return db.prepare(`
    SELECT title, COUNT(*) n FROM people
    WHERE origin='import' AND TRIM(COALESCE(title,'')) <> ''
    GROUP BY LOWER(TRIM(title)) ORDER BY n DESC LIMIT ?`).all(limit);
}

/**
 * Отфильтровать уже загруженных людей по prompts/titles.md.
 *
 * Нужно, когда выгрузка сделана широким запросом и в ней есть лишние роли.
 * Запускается только по явной просьбе: людей отбирал пользователь, и молча
 * выбрасывать их нельзя.
 */
export async function filterImported(db, client, { model } = {}) {
  const before = db.prepare(`SELECT COUNT(*) n FROM people WHERE origin='import'`).get().n;
  db.prepare(`UPDATE people SET title_match='pending' WHERE origin='import'`).run();
  const stat = await matchTitles(db, client, { model });
  const kept = db.prepare(`SELECT COUNT(*) n FROM people WHERE origin='import' AND title_match='pass'`).get().n;
  const cut = db.prepare(`
    SELECT title, COUNT(*) n FROM people
    WHERE origin='import' AND title_match='fail' AND TRIM(COALESCE(title,'')) <> ''
    GROUP BY LOWER(TRIM(title)) ORDER BY n DESC LIMIT 20`).all();
  return { before, kept, dropped: before - kept, unique: stat.unique ?? 0, cut };
}
