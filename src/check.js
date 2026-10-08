// Проверка готовности проекта. Запускается агентом в начале сессии:
// показывает, каких ключей не хватает и настроены ли критерии под пользователя.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { searchProviderName, yandexKeysPresent, searchProviderNote,
         serperKeyPresent, xmlriverKeysPresent, yandexDeferred } from './search.js';
import { loadTitles } from './stages-people.js';

const sha = (s) => crypto.createHash('sha256').update(s.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16);
/** 1 формулировка, 2 формулировки, 5 формулировок */
const plural = (n, one, few, many) => {
  const a = n % 100, b = n % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
const has = (k) => (process.env[k] ?? '').trim().length > 5;

/** Переменная с ключом у каждого провайдера своя. Раньше тут была развилка
 *  на два имени, и третий провайдер молча проверялся по ключу Anthropic. */
const LLM_KEYS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY',
                   deepseek: 'DEEPSEEK_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const llmKeyEnv = (p) => LLM_KEYS[p] ?? 'ANTHROPIC_API_KEY';
export const LLM_PROVIDERS = Object.keys(LLM_KEYS);

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
    llm: { provider, known: provider in LLM_KEYS,
           ok: (provider in LLM_KEYS) && has(llmKeyEnv(provider)), env: llmKeyEnv(provider) },
    search: { provider: searchProvider, yandexOk: yandexKeysPresent(),
              serperOk: serperKeyPresent(), xmlriverOk: xmlriverKeysPresent(),
              deferred: yandexDeferred(), note: searchProviderNote() },
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
  if (!s.llm.known) {
    // Опечатка в имени провайдера раньше роняла даже саму проверку —
    // то есть ровно ту команду, которая должна объяснять, что не так.
    L.push(`    ❌ в .env указан LLM_PROVIDER=${s.llm.provider} — такого провайдера нет`);
    L.push(`       допустимые значения: ${LLM_PROVIDERS.join(', ')}`);
    todo.push('исправить LLM_PROVIDER в .env');
  }
  else if (s.llm.ok) { L.push(`    ✅ ${s.llm.provider} — ключ на месте`); done.push(`нейросеть ${s.llm.provider}`); }
  else { L.push(`    ❌ ${s.llm.provider}: не заполнен ${s.llm.env} в файле .env`); todo.push('ключ нейросети'); }

  L.push('', '  ПОИСК ЛПР В ИНТЕРНЕТЕ');
  const P = s.search.provider;
  if (P === 'none') {
    // Раньше тут писалось «встроенный поиск — работает сразу, ключей не нужно»,
    // то есть самый дорогой движок конвейера подавался как удобный и бесплатный.
    L.push('    ❌ поискового ключа нет — этап поиска ЛПР будет пропущен');
    L.push('       YANDEX_API_KEY + YANDEX_FOLDER_ID — выдача по России');
    L.push('       SERPER_API_KEY                    — Google через API, вне России');
    L.push('       XMLRIVER_USER + XMLRIVER_KEY      — то же другим сервисом');
    todo.push('ключ для поиска ЛПР');
  } else if (P === 'yandex') {
    if (s.search.yandexOk) {
      const d = s.search.deferred;
      L.push(`    ✅ Яндекс — ключи на месте, запросы ${d ? 'отложенные' : 'обычные'}`);
      L.push(d ? '       отложенные дешевле обычных в 16 раз, ответ приходит не сразу'
                : '       отложенные запросы дешевле в 16 раз: YANDEX_DEFERRED=true');
      done.push('Яндекс-поиск');
    } else { L.push('    ❌ выбран yandex, но нет YANDEX_API_KEY / YANDEX_FOLDER_ID'); todo.push('ключи Яндекса'); }
  } else if (P === 'serper' || P === 'xmlriver') {
    const ok = P === 'serper' ? s.search.serperOk : s.search.xmlriverOk;
    if (ok) { L.push(`    ✅ Google через ${P} — ключ на месте`); done.push(`поиск через ${P}`); }
    else { L.push(`    ❌ выбран ${P}, но ключи не заполнены`); todo.push(`ключи ${P}`); }
  } else if (P === 'builtin' || P === 'both') {
    L.push(`    ⚠️  выбран встроенный поиск (SEARCH_PROVIDER=${P}) — он самый дорогой`);
    L.push('       около 15 ₽ на компанию против 0.27 ₽ у отложенных запросов Яндекса');
    if (s.search.yandexOk) L.push('       ключи Яндекса у вас есть: поставьте SEARCH_PROVIDER=yandex');
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
      // У длины списка две стороны, и обе стоят денег. Слишком короткий —
      // поиск не найдёт того, чего в нём нет. Слишком длинный — каждая
      // формулировка это отдельный платный запрос на КАЖДУЮ компанию.
      // Поэтому предупреждаем с обоих концов, а в середине молчим.
      if (name === 'titles.md') {
        try {
          const t = loadTitles();
          const n = t.targets.length + t.accept.length;
          const word = (k) => plural(k, 'формулировка', 'формулировки', 'формулировок');
          if (n < 5) {
            L.push(`    ⚠️  в поиск уходит всего ${n} ${word(n)} — этого мало: одну роль`);
            L.push('        в источниках называют 3-5 способами, и чего нет в списке, того поиск');
            L.push('        не найдёт. Дополнить: node run.js titles --suggest');
            todo.push('расширить список должностей');
          } else if (n > 12) {
            L.push(`    ⚠️  ${n} ${word(n)} — это ${n} поисковых запросов на каждую компанию.`);
            L.push('        Держите 5-10 самых ходовых: остальные добавляют считанные проценты');
            L.push('        находок при том же росте цены. Что уходит в поиск: node run.js titles');
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
