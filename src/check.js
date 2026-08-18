// Проверка готовности проекта. Запускается агентом в начале сессии:
// показывает, каких ключей не хватает и настроены ли критерии под пользователя.

import fs from 'node:fs';
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16);
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
  const searchProvider = (process.env.SEARCH_PROVIDER || 'builtin').toLowerCase();
  const mailProviders = [
    ['prospeo', 'PROSPEO_API_KEY'], ['findymail', 'FINDYMAIL_API_KEY'],
    ['wiza', 'WIZA_API_KEY'], ['fullenrich', 'FULLENRICH_API_KEY'],
  ];
  return {
    llm: { provider, ok: has(provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'),
           env: provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY' },
    search: { provider: searchProvider, yandexOk: has('YANDEX_API_KEY') && has('YANDEX_FOLDER_ID') },
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
  const todo = [];
  L.push('', '─'.repeat(64), '  ПРОВЕРКА НАСТРОЙКИ', '─'.repeat(64), '');

  L.push('  НЕЙРОСЕТЬ — без неё не работает ничего');
  if (s.llm.ok) L.push(`    ✅ ${s.llm.provider} — ключ на месте`);
  else { L.push(`    ❌ ${s.llm.provider}: не заполнен ${s.llm.env} в файле .env`); todo.push('ключ нейросети'); }

  L.push('', '  ПОИСК ЛПР В ИНТЕРНЕТЕ');
  if (s.search.provider === 'none') { L.push('    ⚪ выключен (SEARCH_PROVIDER=none)'); todo.push('поиск ЛПР выключен'); }
  else if (s.search.provider === 'yandex') {
    if (s.search.yandexOk) L.push('    ✅ Яндекс — ключ и folder id на месте');
    else { L.push('    ❌ выбран yandex, но нет YANDEX_API_KEY / YANDEX_FOLDER_ID'); todo.push('ключи Яндекса'); }
  } else {
    L.push('    ✅ встроенный поиск — работает сразу, ключей не нужно');
    L.push(`    ${s.search.yandexOk ? '💡' : '⚪'} Яндекс ${s.search.yandexOk ? 'настроен — можно переключиться: SEARCH_PROVIDER=yandex' : 'не подключён'}`);
    if (!s.search.yandexOk) todo.push('Яндекс-поиск (по желанию)');
  }

  const onMail = s.mail.filter((m) => m.ok).map((m) => m.name);
  const offMail = s.mail.filter((m) => !m.ok).map((m) => m.name);
  L.push('', '  ПОКУПКА ПОЧТ — необязательно');
  if (onMail.length) L.push(`    ✅ подключены: ${onMail.join(', ')}`);
  if (offMail.length) L.push(`    ⚪ без ключей: ${offMail.join(', ')}`);
  if (!onMail.length) {
    L.push('       Конвейер работает и так: почты собираются со страниц сайтов.');
    todo.push('сервисы покупки почт (по желанию)');
  }

  L.push('', '  ПРОВЕРКА ПОЧТ');
  if (s.validate.ok) L.push('    ✅ ZeroBounce подключён');
  else { L.push('    ⚪ ZeroBounce не подключён — шаг пропускается'); todo.push('ZeroBounce (по желанию)'); }

  L.push('', '  НАСТРОЙКА ПОД ВАШ БИЗНЕС');
  for (const p of s.prompts) {
    const name = p.file.replace('prompts/', '');
    if (p.missing) { L.push(`    ❌ ${name} — файл отсутствует`); todo.push(name); }
    else if (p.untouched === true) {
      L.push(`    ⚠️  ${name} — стоит пример из шаблона, под вас не настроено`);
      todo.push(name === 'qualify.md' ? 'критерии отбора компаний' : 'список должностей');
    } else if (p.untouched === false) L.push(`    ✅ ${name} — отредактирован`);
    else L.push(`    ❔ ${name} — не с чем сверить`);
  }

  L.push('', '  ДАННЫЕ');
  if (s.dataFiles.length) for (const f of s.dataFiles) L.push(`    • data/${f}`);
  else { L.push('    ⚪ в папке data/ нет ни одного CSV'); todo.push('список компаний'); }

  if (db) {
    const c = db.prepare('SELECT COUNT(*) n FROM companies').get().n;
    if (c) L.push('', `  В БАЗЕ УЖЕ ЕСТЬ ${c} компаний — прогон продолжится с места остановки`);
  }

  L.push('', '─'.repeat(64));
  if (todo.length) L.push('  НЕ ХВАТАЕТ: ' + todo.join(', '));
  else L.push('  Всё настроено, можно запускать: node run.js all');
  L.push('─'.repeat(64), '');
  console.log(L.join('\n'));
  return { status: s, todo };
}
