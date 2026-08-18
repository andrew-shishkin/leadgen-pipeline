#!/usr/bin/env node
// CLI пайплайна. Каждая команда идемпотентна — перезапуск продолжает с места остановки.

import fs from 'node:fs';
import { openDb, costReport, unj } from './src/db.js';
import { importCsv, fetchHomepages, qualify, collectQualify, toCSV } from './src/stages.js';
import { makeClient, modelName, getProvider } from './src/llm.js';
import readline from 'node:readline/promises';
import { finalReport } from './src/report.js';
import { enrichPages, retryWithBrowser, peopleFromPages, peopleFromSearch,
         matchTitles, verifyPeople, findEmails, validateEmails, declineNames, loadTitles } from './src/stages-people.js';
import { browserAvailable, installHint, closeBrowser } from './src/browser.js';
import { searchProviderName, buildQueries } from './src/search.js';
import { activeProviders } from './src/enrich.js';
import { exportAll } from './src/export.js';
import { printCheck } from './src/check.js';
import { titlesReport, suggestTitles } from './src/titles.js';

// .env без зависимостей
if (fs.existsSync('.env')) {
  const commented = [];
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) { if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); continue; }
    // Ключ вписан, но строка закомментирована — самая частая ошибка при настройке:
    // сервис молча не подключается, и это никак не проявляется.
    const c = line.match(/^\s*#\s*([A-Z0-9_]*(?:KEY|TOKEN|ID|PROVIDER)[A-Z0-9_]*)\s*=\s*(\S.+)$/);
    if (c && !/^#/.test(c[2])) commented.push(c[1]);
  }
  if (commented.length) {
    console.log('\n  ⚠️  В файле .env есть заполненные строки, закомментированные знаком #:');
    for (const k of commented) console.log(`        # ${k}=...`);
    console.log('      Скрипт их НЕ ВИДИТ. Уберите # в начале этих строк.\n');
  }
}

const [cmd, ...args] = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i === -1 ? d : (args[i + 1] ?? true); };
const has = (n) => args.includes('--' + n);
const db = openDb(process.env.DB_PATH || 'out/leadgen.db');
const MODEL = modelName();
const bar = (d, t) => process.stdout.write(`\r  ${d}/${t} (${Math.round(100 * d / t)}%)   `);
const money = (u) => '$' + u.toFixed(u < 1 ? 4 : 2);


// Спросить пользователя, как запускать: быстро или вдвое дешевле.
// Ничего платного не стартует без явного ответа.
async function chooseMode(n, perRow) {
  if (has('batch')) return 'batch';
  if (has('now')) return 'now';
  const est = perRow ? perRow * n : null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n  Компаний к обработке: ${n}`);
  if (est) console.log(`  Ориентировочная стоимость: ${money(est)} обычным способом, ${money(est / 2)} пакетом\n`);
  console.log('  1 — обычный режим: ответ сразу, примерно ' + Math.max(1, Math.round(n / 60)) + ' мин. Ноутбук держим открытым.');
  console.log('  2 — пакетный режим: ВДВОЕ ДЕШЕВЛЕ, но ответ в течение часа (максимум 24 ч).');
  console.log('      Считает сервер провайдера, не ваш компьютер — ноутбук можно закрыть');
  console.log('      и выключить. Результат заберёте командой: node run.js collect\n');
  const a = (await rl.question('  Ваш выбор (1 или 2): ')).trim();
  rl.close();
  return a === '2' ? 'batch' : 'now';
}

switch (cmd) {

  case 'import': {
    const file = flag('file', 'data/companies.csv');
    const s = importCsv(db, file);
    console.log(`\nИмпорт из ${file}`);
    console.log(`  строк в файле:      ${s.total}`);
    console.log(`  новых компаний:     ${s.imported}   ← только они пойдут в обработку`);
    console.log(`  уже были в базе:    ${s.already}   ← повторно не оплачиваются`);
    console.log(`  без сайта:          ${s.no_site}`);
    console.log(`  дублей внутри файла:${s.duplicates}`);
    console.log(`  ЛПР из импорта:     ${s.people_from_import}`);
    console.log(`\n  распознанные колонки:`);
    const LBL = { brand: 'бренд', legal_name: 'юрлицо', name: '→ в поиск идёт', inn: 'ИНН',
                  site: 'сайт', ceo_name: 'ФИО руковод.', ceo_title: 'должность', phones: 'телефоны', emails: 'почты' };
    for (const [k, v] of Object.entries(s.column_map)) console.log(`    ${(LBL[k] ?? k).padEnd(16)} ← "${v}"`);
    if (!s.column_map.brand) console.log('    (колонки с брендом нет — в поиск пойдёт юрлицо)');
    finalReport(db, { title: 'ИТОГИ ИМПОРТА' });
    break;
  }

  case 'fetch': {
    const only = flag('only', null);
    console.log(`\nЗагрузка главных страниц${only ? ` (первые ${only})` : ''}...`);
    const s = await fetchHomepages(db, { limit: Number(flag('concurrency', 12)), only, onProgress: bar });
    console.log(`\n  успешно:      ${s.ok}`);
    console.log(`  не открылись: ${s.failed}`);
    if (s.thin) console.log(`  «тонких» (<400 символов текста, вероятно JS-сайт): ${s.thin}`);
    if (Object.keys(s.via ?? {}).length) {
      console.log(`\n  как достали:`);
      for (const [k, v] of Object.entries(s.via)) console.log(`    ${String(v).padStart(4)}  ${k}`);
    }
    if (Object.keys(s.errors ?? {}).length) {
      console.log(`\n  причины отказов:`);
      for (const [k, v] of Object.entries(s.errors).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
    }
    finalReport(db, { title: 'ИТОГИ ЗАГРУЗКИ САЙТОВ' });
    break;
  }

  case 'qualify': {
    const only = flag('only', null);
    const client = makeClient();
    const n = db.prepare(`SELECT COUNT(*) n FROM companies WHERE fetch_status='ok' AND icp_status='pending'`).get().n;
    if (!n) { console.log('\n  Нечего квалифицировать — все обработаны.'); break; }

    // средняя цена строки по уже сделанным вызовам; на первом запуске её ещё нет
    const seen = db.prepare(`SELECT SUM(usd) usd, COUNT(*) n FROM usage WHERE stage LIKE 'qualify%'`).get();
    const perRow = seen?.n ? seen.usd / seen.n : null;
    const todo = only ? Math.min(Number(only), n) : n;
    const mode = await chooseMode(todo, perRow);

    console.log(`\nКвалификация · ${getProvider().name} · ${MODEL}` +
                (mode === 'batch' ? ' · пакетный режим (−50%)' : '') + (only ? ` · первые ${only}` : ''));
    const before = costReport(db).total;
    const s = await qualify(db, client, {
      model: MODEL, batch: mode === 'batch', wait: false, only,
      onProgress: bar,
    });

    if (s.submitted) {
      console.log(`\n  Пачка отправлена: ${s.n} компаний.`);
      console.log('  Ноутбук можно закрыть — считает сервер провайдера.');
      console.log('  Когда вернётесь:  node run.js collect');
      break;
    }
    const spent = costReport(db).total - before;
    const done = (s.pass ?? 0) + (s.fail ?? 0) + (s.unclear ?? 0) + (s.error ?? 0);
    if (done) console.log(`\n  потрачено ${money(spent)} · ${money(spent / done)} за компанию · на 5 000 будет ${money(spent / done * 5000)}`);
    finalReport(db, { title: 'ИТОГИ КВАЛИФИКАЦИИ' });
    break;
  }

  case 'collect': {
    const r = await collectQualify(db, makeClient(), { model: MODEL });
    if (r.none) { console.log('\n  Отправленных пачек нет.'); break; }
    if (r.waiting) {
      console.log(`\n  Пачка ещё считается: готово ${r.succeeded}, в работе ${r.processing}.`);
      console.log('  Обычно занимает до часа. Зайдите позже той же командой.');
      break;
    }
    console.log(`\n  Пачка забрана.`);
    finalReport(db, { title: 'ИТОГИ КВАЛИФИКАЦИИ' });
    break;
  }


  case 'browser': {
    if (!(await browserAvailable())) { console.log('\n' + installHint); break; }
    console.log('\nПовторная загрузка «пустых» сайтов настоящим браузером...');
    const r = await retryWithBrowser(db, { onProgress: bar });
    console.log(`\n  получилось: ${r.ok ?? 0}   не вышло: ${r.failed ?? 0}`);
    if (r.ok) console.log('  Эти компании вернулись в очередь на квалификацию: node run.js qualify');
    await closeBrowser();
    break;
  }

  case 'pages': {
    console.log('\nДогрузка страниц «Контакты», «О компании», «Команда» — только прошедшим ICP...');
    const r = await enrichPages(db, { onProgress: bar });
    console.log(`\n  загружено страниц: ${r.ok ?? 0}   не открылись: ${r.failed ?? 0}   новых почт: ${r.newEmails ?? 0}`);
    finalReport(db, { title: 'ИТОГИ ДОГРУЗКИ СТРАНИЦ' });
    break;
  }

  case 'people': {
    const client = makeClient();
    // Молчаливый ноль здесь дороже всего: если ICP отсеял почти всех,
    // искать некого, и это надо сказать до того, как этап отчитается «0 людей».
    {
      const pass = db.prepare(`SELECT COUNT(*) n FROM companies WHERE icp_status='pass'`).get().n;
      const all  = db.prepare('SELECT COUNT(*) n FROM companies').get().n;
      const share = all ? Math.round(100 * pass / all) : 0;
      console.log(`\nЛПР ищем только по компаниям, прошедшим ICP: ${pass} из ${all} (${share}%)`);
      if (!pass) {
        console.log('  Прошедших нет — искать не по кому. Дело не в должностях, а в критериях');
        console.log('  отбора: посмотрите prompts/qualify.md и колонку «Обоснование» в out/1-компании.csv.');
        break;
      }
      if (share < 15) console.log('  ⚠️  Прошло меньше 15% — проверьте критерии, иначе большая часть списка не дойдёт до поиска.');
      const t = loadTitles();
      const qn = buildQueries({ name: 'x', domain: 'x.ru' }, [...t.targets, ...t.accept]).length;
      console.log(`  Должностей в поиске: ${t.targets.length + t.accept.length} → ${qn} запросов на компанию (${qn * pass} всего).`);
      console.log('  Подробнее и чем дополнить список: node run.js titles --suggest');
    }
    console.log('\nПоиск ЛПР на страницах компаний...');
    const a = await peopleFromPages(db, client, { model: MODEL, onProgress: bar });
    console.log(`\n  компаний обработано: ${a.companies ?? 0}   найдено людей: ${a.found ?? 0}`);

    if (searchProviderName() !== 'none') {
      console.log(`\nПоиск ЛПР в интернете (${searchProviderName()})...`);
      const b = await peopleFromSearch(db, client, { model: MODEL, onProgress: bar });
      if (b.skipped) console.log('  этап отключён (SEARCH_PROVIDER=none)');
      else console.log(`\n  результатов поиска: ${b.snippets ?? 0}   найдено людей: ${b.found ?? 0}`);
    } else {
      console.log('\n  Поиск в интернете отключён (SEARCH_PROVIDER=none).');
      console.log('  Это самый результативный этап: включите builtin или yandex в .env.');
    }

    console.log('\nОтбор по должностям (классифицируем уникальные формулировки)...');
    const t = await matchTitles(db, client, {});
    console.log(`  уникальных должностей: ${t.unique ?? 0}   подошли: ${t.target ?? 0}   отсеяны: ${t.reject ?? 0}`);

    console.log('\nПроверка найденных по первоисточнику...');
    const v = await verifyPeople(db, client, { onProgress: bar });
    console.log(`\n  отсеяны по дате: ${v.byDate ?? 0}   с сайта компании (проверка не нужна): ${v.fromSite ?? 0}`);
    console.log(`  проверено: ${v.checked ?? 0}   подтвердились: ${v.confirmed ?? 0}   опровергнуты: ${v.rejected ?? 0}   неясно: ${v.unknown ?? 0}`);
    finalReport(db, { title: 'ИТОГИ ПОИСКА ЛПР' });
    break;
  }

  case 'emails': {
    const client = makeClient();
    const provs = activeProviders().map((p) => p.name);
    console.log('\nПодбор почт...');
    console.log(provs.length ? `  платные сервисы подключены: ${provs.join(', ')}`
                             : '  платные сервисы не подключены — ищем только среди уже собранных почт');
    const r = await findEmails(db, client, { onProgress: bar });
    console.log(`\n  найдено шаблонами (бесплатно): ${r.matched ?? 0}`);
    console.log(`  подобрано нейросетью:          ${r.byLlm ?? 0}`);
    console.log(`  куплено у провайдеров:         ${r.bought ?? 0}`);
    console.log(`  не нашлось:                    ${r.notFound ?? 0}`);

    const v = await validateEmails(db, { onProgress: bar });
    if (v.skipped) console.log('\n  Валидация пропущена: не задан ZEROBOUNCE_API_KEY');
    else console.log(`\n  проверено почт: ${v.checked ?? 0}   годных: ${v.ok ?? 0}   отбраковано: ${v.dropped ?? 0}`);

    console.log('\nСклонение имён для писем...');
    const d = await declineNames(db, client, {});
    console.log(`  обработано имён: ${d.done ?? 0}`);
    finalReport(db, { title: 'ИТОГИ ПОИСКА ПОЧТ' });
    break;
  }

  case 'all': {
    const steps = [
      ['import',  'загрузка списка'],
      ['fetch',   'открытие сайтов'],
      ['qualify', 'отбор по ICP'],
      ['pages',   'догрузка страниц победителям'],
      ['people',  'поиск ЛПР'],
      ['emails',  'подбор и проверка почт'],
      ['export',  'выгрузка таблиц'],
    ];
    console.log('\n  Полный прогон. Последовательность:');
    steps.forEach(([c, d], i) => console.log(`    ${i + 1}. ${c.padEnd(9)} ${d}`));
    console.log('\n  Каждый этап можно запустить и отдельно — командой из списка.');
    console.log('  Платные этапы (3, 5, 6) спросят подтверждение.\n');
    for (const [c] of steps) {
      console.log(`\n${'━'.repeat(64)}\n  ЭТАП: ${c}\n${'━'.repeat(64)}`);
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(process.execPath, ['run.js', c], { stdio: 'inherit' });
      if (r.status !== 0) { console.log(`\n  Этап ${c} прервался. Продолжить: node run.js ${c}`); break; }
    }
    break;
  }

  case 'check': {
    printCheck(db);
    break;
  }

  case 'titles': {
    titlesReport(db);
    if (has('suggest')) await suggestTitles(db, makeClient(), { model: MODEL });
    break;
  }

  case 'report': {
    finalReport(db, { title: 'ТЕКУЩЕЕ СОСТОЯНИЕ' });
    break;
  }

  case 'export': {
    const keepPersonal = (process.env.KEEP_PERSONAL_EMAILS ?? 'true') !== 'false';
    const r = exportAll(db, { keepPersonal });
    console.log(`
  out/1-компании.csv        ${r.companies} строк`);
    console.log(`  out/2-ЛПР-с-почтами.csv   ${r.people} строк`);
    console.log(`  out/3-общие-почты.csv     ${r.generic} строк  (с найденной общей почтой: ${r.withGeneric})`);
    finalReport(db, { title: 'ИТОГИ ВЫГРУЗКИ' });
    break;
  }

  default:
    console.log(`
  node run.js import   [--file data/companies.csv]   импорт и дедупликация
  node run.js fetch    [--only 20] [--concurrency 12] загрузка главных страниц
  node run.js qualify  [--only 20] [--batch|--now]    квалификация по ICP
  node run.js collect                                 забрать отправленную пачку
  node run.js pages                                   догрузить страницы победителям ICP
  node run.js people                                  найти ЛПР: сайт + поиск + проверка
  node run.js emails                                  подобрать, купить и проверить почты
  node run.js browser                                 добрать сайты на JS (нужен Playwright)
  node run.js check                                   что настроено, чего не хватает
  node run.js titles [--suggest]                      список должностей: отчёт и чем дополнить
  node run.js report                                  статус и расходы
  node run.js export                                  три CSV в out/

  node run.js all                                     весь конвейер по порядку

  Первый раз проще всего так:
    node run.js all
`);
}
