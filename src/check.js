// Проверка готовности проекта. Запускается агентом в начале сессии:
// показывает, каких ключей не хватает и настроены ли критерии под пользователя.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { searchProviderName, yandexKeysPresent, searchProviderNote } from './search.js';
import { loadTitles } from './stages-people.js';

const sha = (s) => crypto.createHash('sha256').update(s.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16);
/** 1 формулировка, 2 формулировки, 5 формулировок */
const plural = (n, one, few, many) => {
  const a = n % 100, b = n % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
const has = (k) => (process.env[k] ?? '').trim().length > 5;

/** Промпт ещё в исходном виде? Сверяем с отпечатками, снятыми при сборке шаблона. */
function promptState(file) {
  if (!fs.existsSync(file)) return { file, missing: true };
  let marks = {};
  try { marks = JSON.parse(fs.readFileSync('prompts/.template.json', 'utf8')); } catch { /* нет отпечатков */ }
  const now = sha(fs.readFileSync(file, 'utf8'));
  return { file, missing: false, untouched: marks[file] ? marks[file] === now : null };
}

export function collectStatus() {
  const provider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  const searchProvider = searchProviderName();
  const mailProviders = [
    ['prospeo', 'PROSPEO_API_KEY'], ['findymail', 'FINDYMAIL_API_KEY'],
    ['wiza', 'WIZA_API_KEY'], ['fullenrich', 'FULLENRICH_API_KEY'],
  ];
  return {
    llm: { provider, ok: has(provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'),
           env: provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY' },
    search: { provider: searchProvider, yandexOk: yandexKeysPresent(), note: searchProviderNote() },
    mail: mailProviders.map(([name, env]) => ({ name, env, ok: has(env) })),
    validate: { ok: has('ZEROBOUNCE_API_KEY') },
    prompts: [promptState('prompts/qualify.md'), promptState('prompts/titles.md')],
    dataFiles: fs.existsSync('data') ? fs.readdirSync('data').filter((f) => f.endsWith('.csv')) : [],
    keepPersonal: (process.env.KEEP_PERSONAL_EMAILS ?? 'true') !== 'false',
    freshSince: process.env.FRESH_SINCE_YEAR || '2022',
  };
}

export function printCheck(db) {
  const s = collectStatus();
  const L = [];
  const todo = [];   // о чём спросить пользователя
  const done = [];   // что уже подключено — про это спрашивать нельзя
  L.push('', '─'.repeat(64), '  ПРОВЕРКА НАСТРОЙКИ', '─'.repeat(64), '');

  L.push('  НЕЙРОСЕТЬ — без неё не работает ничего');
  if (s.llm.ok) { L.push(`    ✅ ${s.llm.provider} — ключ на месте`); done.push(`нейросеть ${s.llm.provider}`); }
  else { L.push(`    ❌ ${s.llm.provider}: не заполнен ${s.llm.env} в файле .env`); todo.push('ключ нейросети'); }

  L.push('', '  ПОИСК ЛПР В ИНТЕРНЕТЕ');
  if (s.search.provider === 'none') { L.push('    ⚪ выключен (SEARCH_PROVIDER=none)'); todo.push('поиск ЛПР выключен'); }
  else if (s.search.provider === 'yandex') {
    if (s.search.yandexOk) { L.push('    ✅ Яндекс — ключ и folder id на месте, поиск идёт через него'); done.push('Яндекс-поиск'); }
    else { L.push('    ❌ выбран yandex, но нет YANDEX_API_KEY / YANDEX_FOLDER_ID'); todo.push('ключи Яндекса'); }
  } else {
    L.push('    ✅ встроенный поиск — работает сразу, ключей не нужно');
    // «не подключён» пишем только когда ключей действительно нет: если они
    // заполнены, а провайдер переключён вручную — это другая ситуация, о ней ниже
    if (!s.search.yandexOk) {
      L.push('    ⚪ Яндекс не подключён — по России находит заметно больше');
      todo.push('Яндекс-поиск (по желанию)');
    }
  }
  if (s.search.note) L.push(`    ⚠️  ${s.search.note}`);

  const onMail = s.mail.filter((m) => m.ok).map((m) => m.name);
  const offMail = s.mail.filter((m) => !m.ok).map((m) => m.name);
  L.push('', '  ПОКУПКА ПОЧТ — необязательно');
  if (onMail.length) { L.push(`    ✅ подключены: ${onMail.join(', ')}`); done.push(`покупка почт (${onMail.join(', ')})`); }
  if (offMail.length) L.push(`    ⚪ без ключей: ${offMail.join(', ')}`);
  if (!onMail.length) {
    L.push('       Конвейер работает и так: почты собираются со страниц сайтов.');
    todo.push('сервисы покупки почт (по желанию)');
  }

  L.push('', '  ПРОВЕРКА ПОЧТ');
  if (s.validate.ok) { L.push('    ✅ ZeroBounce подключён'); done.push('проверка почт ZeroBounce'); }
  else { L.push('    ⚪ ZeroBounce не подключён — шаг пропускается'); todo.push('ZeroBounce (по желанию)'); }

  L.push('', '  НАСТРОЙКА ПОД ВАШ БИЗНЕС');
  for (const p of s.prompts) {
    const name = p.file.replace('prompts/', '');
    if (p.missing) { L.push(`    ❌ ${name} — файл отсутствует`); todo.push(name); }
    else if (p.untouched === true) {
      L.push(`    ⚠️  ${name} — стоит пример из шаблона, под вас не настроено`);
      todo.push(name === 'qualify.md' ? 'критерии отбора компаний' : 'список должностей');
    } else if (p.untouched === false) {
      L.push(`    ✅ ${name} — отредактирован`);
      done.push(name === 'qualify.md' ? 'критерии отбора' : 'список должностей');
      // Короткий список должностей — самая частая причина «нашли мало людей»:
      // чего в нём нет, того поиск не найдёт вообще.
      if (name === 'titles.md') {
        try {
          const t = loadTitles();
          const n = t.targets.length + t.accept.length;
          if (n < 12) {
            L.push(`    ⚠️  в поиск уходит всего ${n} ${plural(n, 'формулировка', 'формулировки', 'формулировок')} — этого мало, одну роль`);
            L.push('        в источниках называют 3-5 способами. Расширить: node run.js titles --suggest');
            todo.push('расширить список должностей');
          }
        } catch { /* файл ещё не читается — скажет отдельная проверка */ }
      }
    }
    else L.push(`    ❔ ${name} — не с чем сверить`);
  }

  L.push('', '  ДАННЫЕ');
  if (s.dataFiles.length) { for (const f of s.dataFiles) L.push(`    • data/${f}`); done.push('список компаний'); }
  else { L.push('    ⚪ в папке data/ нет ни одного CSV'); todo.push('список компаний'); }

  if (db) {
    const c = db.prepare('SELECT COUNT(*) n FROM companies').get().n;
    if (c) L.push('', `  В БАЗЕ УЖЕ ЕСТЬ ${c} компаний — прогон продолжится с места остановки`);
  }

  // Ниже — готовый список для агента. Он существует, чтобы агент не предлагал
  // подключить то, что уже подключено: спрашивать можно только про то, чего не хватает.
  L.push('', '─'.repeat(64));
  if (todo.length) {
    L.push('  НЕ ХВАТАЕТ — спрашивать можно ТОЛЬКО про эти пункты:');
    for (const t of todo) L.push(`    • ${t}`);
  } else {
    L.push('  Всё настроено, можно запускать: node run.js all');
  }
  if (done.length) {
    L.push('', '  УЖЕ ПОДКЛЮЧЕНО — не предлагать настроить заново и не спрашивать про это:');
    L.push('    ' + done.join(', '));
  }
  L.push('─'.repeat(64), '');
  console.log(L.join('\n'));
  return { status: s, todo, done };
}
