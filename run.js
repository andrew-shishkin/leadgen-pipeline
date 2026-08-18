#!/usr/bin/env node
// CLI пайплайна. Каждая команда идемпотентна — перезапуск продолжает с места остановки.

// ПЕРВЫМ импортом: .env должен попасть в process.env раньше, чем остальные
// модули прочитают из него свои настройки на верхнем уровне. См. src/env.js.
import { commentedOut } from './src/env.js';

import fs from 'node:fs';
import { openDb, costReport, unj, setMeta, getMeta } from './src/db.js';
import { importCsv, fetchHomepages, qualify, collectQualify, toCSV } from './src/stages.js';
import { j } from './src/db.js';
import { makeClient, modelName, getProvider } from './src/llm.js';
import readline from 'node:readline/promises';
import { finalReport } from './src/report.js';
import { enrichPages, retryWithBrowser, peopleFromPages, peopleFromSearch,
         matchTitles, verifyPeople, findEmails, validateEmails, declineNames, loadTitles } from './src/stages-people.js';
import { browserAvailable, installHint, closeBrowser } from './src/browser.js';
import { searchProviderName, buildQueries, builtinQueries, yandexKeysPresent } from './src/search.js';
import { activeProviders } from './src/enrich.js';
import { exportAll } from './src/export.js';
import { printCheck, collectStatus } from './src/check.js';
import { titlesReport, suggestTitles, importedTitles, filterImported } from './src/titles.js';

if (commentedOut.length) {
  console.log('\n  ⚠️  В файле .env есть заполненные строки, закомментированные знаком #:');
  for (const k of commentedOut) console.log(`        # ${k}=...`);
  console.log('      Скрипт их НЕ ВИДИТ. Уберите # в начале этих строк.\n');
}

const [cmd, ...args] = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i === -1 ? d : (args[i + 1] ?? true); };
const has = (n) => args.includes('--' + n);
const db = openDb(process.env.DB_PATH || 'out/leadgen.db');
const MODEL = modelName();
const bar = (d, t) => process.stdout.write(`\r  ${d}/${t} (${Math.round(100 * d / t)}%)   `);
const money = (u) => '$' + u.toFixed(u < 1 ? 4 : 2);


/** Вопрос с пронумерованными вариантами. Возвращает value выбранного.
 *  Если ввода нет (запуск не из терминала) — берём первый вариант и говорим
 *  об этом вслух, иначе прогон повисает на невидимом вопросе. */
async function ask(title, options, note) {
  console.log(`\n  ${title}`);
  if (note) console.log(`  ${note}`);
  options.forEach((o, i) => {
    console.log(`    ${i + 1} — ${o.label}`);
    if (o.hint) console.log(`        ${o.hint}`);
  });
  if (!process.stdin.isTTY) {
    console.log(`\n  Запуск не из терминала — беру вариант 1: ${options[0].label}`);
    return options[0].value;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`\n  Ваш выбор (1-${options.length}): `)).trim();
  rl.close();
  const i = Number(a) - 1;
  return options[Number.isInteger(i) && options[i] ? i : 0].value;
}

// Спросить пользователя, как запускать: быстро или вдвое дешевле.
// Ничего платного не стартует без явного ответа.
async function chooseMode(n, perRow) {
  if (has('batch')) return 'batch';
  if (has('now')) return 'now';
  const est = perRow ? perRow * n : null;
  console.log(`\n  Компаний к обработке: ${n}`);
  if (est) console.log(`  Ориентировочная стоимость: ${money(est)} обычным способом, ${money(est / 2)} пакетом\n`);
  console.log('  1 — обычный режим: ответ сразу, примерно ' + Math.max(1, Math.round(n / 60)) + ' мин. Ноутбук держим открытым.');
  console.log('  2 — пакетный режим: ВДВОЕ ДЕШЕВЛЕ, но ответ в течение часа (максимум 24 ч).');
  console.log('      Считает сервер провайдера, не ваш компьютер — ноутбук можно закрыть');
  console.log('      и выключить. Результат заберёте командой: node run.js collect\n');
  if (!process.stdin.isTTY) {
    console.log('  Запуск не из терминала — беру обычный режим. Пакетный: --batch\n');
    return 'now';
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question('  Ваш выбор (1 или 2): ')).trim();
  rl.close();
  return a === '2' ? 'batch' : 'now';
}

switch (cmd) {

  case 'import': {
    const file = flag('file', 'data/companies.csv');
    const forced = String(flag('as', '')).toLowerCase();
    const s = importCsv(db, file, forced === 'people' || forced === 'companies' ? { kind: forced } : {});
    setMeta(db, 'list_kind', s.list_kind);
    console.log(`\nИмпорт из ${file}`);

    // Тип списка меняет весь дальнейший конвейер, поэтому говорим о нём первым делом
    const st = s.list_stats;
    if (s.list_kind === 'people') {
      console.log(`\n  ЭТО СПИСОК ЛПР, а не список компаний (${s.list_reason}).`);
      console.log(`    строк: ${st.rows}, из них с ФИО: ${st.withName}`);
      console.log(`    разных должностей: ${st.distinctTitles}, первых лиц среди них: ${st.topShare}%`);
      console.log(`    компаний, где больше одного человека: ${st.multiPersonDomains}`);
      console.log('    Люди берутся из файла как есть — заново их не ищем и по должностям не фильтруем.');
      console.log('    Если это всё-таки список компаний: node run.js import --as companies');
    } else if (st.withName) {
      console.log(`\n  Список компаний (${s.list_reason}).`);
      console.log('    Если это на самом деле выгрузка ЛПР: node run.js import --as people');
    }

    console.log(`\n  строк в файле:      ${s.total}`);
    console.log(`  новых компаний:     ${s.imported}   ← только они пойдут в обработку`);
    console.log(`  уже были в базе:    ${s.already}   ← повторно не оплачиваются`);
    console.log(`  без сайта:          ${s.no_site}`);
    if (s.list_kind === 'people') console.log(`  ещё людей в тех же компаниях: ${s.extra_people ?? 0}`);
    else console.log(`  дублей внутри файла:${s.duplicates}`);
    console.log(`  ЛПР из импорта:     ${s.people_from_import}`);
    console.log(`\n  распознанные колонки:`);
    const person = s.list_kind === 'people';
    const LBL = { brand: 'бренд', legal_name: 'юрлицо', name: '→ в поиск идёт', inn: 'ИНН',
                  site: 'сайт', ceo_name: person ? 'ФИО человека' : 'ФИО руковод.',
                  ceo_title: 'должность', phones: 'телефоны', emails: 'почты' };
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
    // Список уже отобран вручную или выгружен по фильтру — тогда отбор не нужен,
    // и платить за него незачем. Компании просто помечаются подходящими.
    if (has('skip')) {
      const r = db.prepare(`UPDATE companies SET icp_status='pass', icp_reason='квалификация пропущена по решению пользователя'
                            WHERE icp_status='pending'`).run();
      setMeta(db, 'qualify_skipped', 'true');
      console.log(`\n  Отбор пропущен: ${r.changes} компаний помечены подходящими, ни одного платного вызова.`);
      console.log('  Передумали — верните отбор: node run.js reset --stage qualify\n');
      break;
    }
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
      // Цены — измеренные, а не придуманные: рубль за запрос Яндекса взят
      // по факту счёта, стоимость разбора — по таблице usage.
      const RUB = Number(process.env.YANDEX_PRICE_RUB ?? 0.93);
      const USD_RUB = Number(process.env.USD_RUB ?? 86);

      const t = loadTitles();
      const nTitles = t.targets.length + t.accept.length;
      const qn = buildQueries({ name: 'x', domain: 'x.ru' }, [...t.targets, ...t.accept]).length;
      console.log(`  Должностей в поиске: ${nTitles} → ${qn} запросов на компанию.`);
      // Длина списка должностей — это прямая статья расходов, а не настройка
      // качества: одна должность = один поисковый запрос на КАЖДУЮ компанию.
      // Пользователь дописывает пять формулировок «на всякий случай» и узнаёт
      // о цене только из счёта, поэтому говорим до прогона, а не после.
      if (nTitles) {
        const perTitle = RUB / USD_RUB;
        console.log(`  Чем больше должностей — тем дороже обработка: каждая добавляет`);
        console.log(`  по одному запросу на компанию, это $${perTitle.toFixed(3)} за строку`);
        console.log(`  и $${(perTitle * pass).toFixed(2)} на ваши ${pass} компаний.`);
      }
      console.log('  Подробнее и чем дополнить список: node run.js titles --suggest');
      const seen = db.prepare(`SELECT SUM(usd) usd, COUNT(*) n FROM usage WHERE stage='people-search'`).get();
      const parse = seen?.n ? seen.usd / seen.n : 0.015;          // разбор страниц нейросетью
      const yandex = qn * RUB / USD_RUB;                           // запросы в Яндекс
      // Встроенный поиск (Google) — это отдельные вызовы web_search ($0.01 за штуку)
      // плюс токены модели, и то и другое уже попадает в usage.stage='search'.
      // Раньше здесь стояла угаданная константа; теперь берём фактический расход
      // на компанию, если он уже накоплен, и грубый ориентир — если нет.
      // usage пишется по одному вызову, а вызов теперь = один поисковый запрос,
      // а не вся компания. Поэтому цену за вызов умножаем на число запросов:
      // без этого встроенный поиск выглядел бы в пятнадцать раз дешевле, чем есть.
      const gSeen = db.prepare(`SELECT SUM(usd) usd, COUNT(*) n FROM usage WHERE stage='search' AND provider='anthropic'`).get();
      const bn = builtinQueries({ name: 'x', domain: 'x.ru' }, [...t.targets, ...t.accept]).length;
      const google = (gSeen?.n ? gSeen.usd / gSeen.n : Number(process.env.BUILTIN_PRICE_USD ?? 0.02)) * bn;
      const money2 = (u) => '$' + u.toFixed(3) + ' (' + Math.round(u * USD_RUB) + ' ₽)';
      const line = (v) => `${money2(v)} за строку · ${money2(v * pass)} за все ${pass}`;

      let mode = getMeta(db, 'search_mode', null) ?? String(flag('search', '') || '');
      if (!['yandex', 'builtin', 'both'].includes(mode)) {
        const opts = [];
        if (yandexKeysPresent()) opts.push({ value: 'both', label: 'Яндекс + Google — максимум находок',
          hint: line(yandex + google + parse) + '  · российские площадки и LinkedIn' });
        opts.push({ value: 'builtin', label: 'только Google (встроенный поиск)',
          hint: line(google + parse) + '  · видит LinkedIn, ключей не нужно' });
        if (yandexKeysPresent()) opts.push({ value: 'yandex', label: 'только Яндекс',
          hint: line(yandex + parse) + '  · российские площадки, LinkedIn не видит' });
        mode = await ask('Как искать людей?', opts,
          'Цены посчитаны по вашим фактическим расходам, но зависят от сайтов — считайте их ориентиром.');
        setMeta(db, 'search_mode', mode);
      }
      process.env.SEARCH_PROVIDER = mode;
      console.log(`  Поиск: ${{ both: 'Яндекс + Google', yandex: 'только Яндекс', builtin: 'только Google' }[mode]}`);
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
    const source = String(flag('source', getMeta(db, 'email_sources', process.env.EMAIL_SOURCES ?? 'both'))).toLowerCase();
    if (!['site', 'providers', 'both'].includes(source)) {
      console.log('\n  --source принимает: site | providers | both\n');
      console.log('    site      только почты со страниц сайтов — бесплатно, находит меньше');
      console.log('    providers только платные сервисы — сайты для этого не нужны');
      console.log('    both      сначала бесплатно, платно только за остаток (по умолчанию)\n');
      break;
    }
    setMeta(db, 'email_sources', source);
    const SRC = { site: 'только сайты (бесплатно)', providers: 'только платные сервисы',
                  both: 'сайты + платные сервисы за остаток' };
    console.log(`\nПодбор почт · источник: ${SRC[source]}`);
    if (source !== 'site') {
      console.log(provs.length ? `  платные сервисы подключены: ${provs.join(', ')}`
                               : '  ⚠️  платные сервисы не подключены — платная часть пропустится');
    }
    const only = flag('only', null);
    if (only) {
      console.log(`  платная часть ограничена: не больше ${only} человек`);
      console.log('  Это проверка, что интеграция работает. Судить по такой выборке,');
      console.log('  много ли найдётся на всём списке, нельзя — и не нужно: запрос');
      console.log('  без результата кредит обычно не списывает.');
    }
    const r = await findEmails(db, client, { source, limit: only ? Number(only) : undefined, onProgress: bar });
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
    const { spawnSync: sp0 } = await import('node:child_process');
    // Импорт делаем сразу: пока не увидим файл, неизвестно даже, что за список.
    if (sp0(process.execPath, ['run.js', 'import', ...args], { stdio: 'inherit' }).status !== 0) break;

    const kind = getMeta(db, 'list_kind', 'companies');
    let steps;

    if (kind === 'people') {
      console.log(`\n${'━'.repeat(64)}\n  У ВАС СПИСОК ЛПР — конвейер собирается под него\n${'━'.repeat(64)}`);
      console.log('  Людей искать не нужно: они уже есть в файле. Осталось решить,');
      console.log('  отбирать ли компании и откуда брать почты.');

      // Прежде чем что-то спрашивать — показать, что настроено и что в файле.
      // Без этого вопрос «фильтровать ли должности» задаётся вслепую.
      const st = collectStatus();
      const tt = loadTitles();
      const tpl = (f) => st.prompts.find((x) => x.file === f)?.untouched === true;
      console.log('\n  ЧТО СЕЙЧАС НАСТРОЕНО ПОД ВАС');
      console.log(`    критерии отбора (prompts/qualify.md): ${tpl('prompts/qualify.md') ? '⚠️  пример из шаблона, под вас не настроено' : 'отредактированы'}`);
      console.log(`    должности (prompts/titles.md): ${tt.targets.length} целевых + ${tt.accept.length} смежных` +
                  `${tpl('prompts/titles.md') ? '  ⚠️  пример из шаблона' : ''}`);

      const inFile = importedTitles(db, 15);
      const totalPeople = db.prepare(`SELECT COUNT(*) n FROM people WHERE origin='import'`).get().n;
      if (inFile.length) {
        console.log(`\n  ДОЛЖНОСТИ В ВАШЕМ ФАЙЛЕ (${totalPeople} человек, показаны частые)`);
        for (const r of inFile) console.log(`    ${String(r.n).padStart(4)}  ${r.title}`);
      }

      const doFilter = await ask(
        'Должности в файле уже почищены под ваш ICP?',
        [{ value: false, label: 'да, берём всех из файла',
           hint: 'ничего не отсекаем — так и задумано, если выгрузка делалась по фильтру' },
         { value: true,  label: 'нет, отфильтровать по prompts/titles.md',
           hint: 'нейросеть сверит каждую формулировку со списком целевых должностей' }],
        'Посмотрите на список выше: если там есть лишние роли — их стоит отсечь.');

      if (doFilter && tpl('prompts/titles.md')) {
        console.log('\n  ⚠️  Внимание: prompts/titles.md — это пример из шаблона, под вас он не настроен.');
        console.log('      Фильтрация по нему выбросит почти весь ваш список.');
        console.log('      Сначала настройте должности: node run.js titles --suggest\n');
      }

      const doQualify = await ask(
        'Отбирать компании по критериям или в списке все подходящие?',
        [{ value: false, label: 'все подходят — отбор не нужен',
           hint: 'ни одного платного вызова, сразу переходим к почтам' },
         { value: true,  label: 'отобрать по критериям из prompts/qualify.md',
           hint: 'нужно открыть сайты и оценить каждую компанию, это платный этап' }]);

      const source = await ask(
        'Откуда искать почты?',
        [{ value: 'both',      label: 'сайты + платные сервисы — максимальный результат',
           hint: 'сначала бесплатно со страниц, платно только за тех, кто остался' },
         { value: 'site',      label: 'только сайты — бесплатно',
           hint: 'найдётся заметно меньше: на сайте есть не каждый сотрудник' },
         { value: 'providers', label: 'только платные сервисы',
           hint: 'сайты открывать не нужно, прогон будет быстрее' }]);

      const mailboxes = await ask(
        'Забирать ли с сайтов общие почты и почты отделов?',
        [{ value: 'none',  label: 'нет, только именные почты ЛПР' },
         { value: 'both',  label: 'да, и общие (info@), и отделов (marketing@)' },
         { value: 'gen',   label: 'только общие (info@, office@)' },
         { value: 'dept',  label: 'только отделов (marketing@, sales@)' }],
        'Пригодятся, когда именная почта человека не нашлась.');

      setMeta(db, 'email_sources', source);
      setMeta(db, 'export_generic', String(mailboxes === 'both' || mailboxes === 'gen'));
      setMeta(db, 'export_departments', String(mailboxes === 'both' || mailboxes === 'dept'));

      // сайты нужны, только если с них что-то берут: почты людей или общие ящики
      const needSites = source !== 'providers' || mailboxes !== 'none' || doQualify;
      steps = [
        ...(doFilter ? [['titles --filter', 'отсев должностей, не попадающих в ICP']] : []),
        ...(needSites ? [['fetch', 'открытие сайтов']] : []),
        [doQualify ? 'qualify' : 'qualify --skip', doQualify ? 'отбор по ICP' : 'отбор пропускаем'],
        ...(needSites ? [['pages', 'догрузка страниц — оттуда берутся почты']] : []),
        ['emails', 'подбор и проверка почт'],
        ['export', 'выгрузка таблиц'],
      ];
      console.log('\n  Поиск ЛПР пропускаем — они уже в файле.');
    } else {
      steps = [
        ['fetch',   'открытие сайтов'],
        ['qualify', 'отбор по ICP'],
        ['pages',   'догрузка страниц победителям'],
        ['people',  'поиск ЛПР'],
        ['emails',  'подбор и проверка почт'],
        ['export',  'выгрузка таблиц'],
      ];
    }

    console.log('\n  Дальнейшая последовательность:');
    steps.forEach(([c, d], i) => console.log(`    ${i + 1}. ${c.padEnd(15)} ${d}`));
    console.log('\n  Каждый этап можно запустить и отдельно — командой из списка.');
    console.log('  Платные этапы спросят подтверждение.\n');
    for (const [c] of steps) {
      console.log(`\n${'━'.repeat(64)}\n  ЭТАП: ${c}\n${'━'.repeat(64)}`);
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(process.execPath, ['run.js', ...c.split(' ')], { stdio: 'inherit' });
      if (r.status !== 0) { console.log(`\n  Этап ${c} прервался. Продолжить: node run.js ${c}`); break; }
    }
    break;
  }

  case 'check': {
    printCheck(db);
    break;
  }

  case 'titles': {
    if (has('filter')) {
      const n = db.prepare(`SELECT COUNT(*) n FROM people WHERE origin='import'`).get().n;
      if (!n) { console.log('\n  В базе нет людей из импорта — фильтровать нечего.\n'); break; }
      const t = loadTitles();
      console.log(`\nФильтрую ${n} человек из файла по prompts/titles.md`);
      console.log(`  целевых должностей: ${t.targets.length}, также подходят: ${t.accept.length}, отсекаем: ${t.reject.length}`);
      const r = await filterImported(db, makeClient(), {});
      console.log(`\n  осталось:  ${r.kept}`);
      console.log(`  отсеяно:   ${r.dropped}`);
      if (r.cut.length) {
        console.log('\n  что отсеклось:');
        for (const c of r.cut) console.log(`    ${String(c.n).padStart(4)}  ${c.title}`);
      }
      console.log('\n  Отсекли лишнего — верните всех: node run.js reset --stage titles-import\n');
      break;
    }
    titlesReport(db);
    if (has('suggest')) await suggestTitles(db, makeClient(), { model: MODEL });
    break;
  }

  // Поменяли критерий отбора или список должностей — прошлые вердикты
  // надо пересчитать. Скачанные страницы при этом сохраняются: качать
  // сайты заново незачем, и это единственный бесплатный этап.
  case 'reset': {
    const stage = String(flag('stage', ''));
    const R = {
      qualify: [`UPDATE companies SET icp_status='pending', icp_json=NULL, icp_reason=NULL`,
                'вердикты ICP сброшены — запустите node run.js qualify'],
      people:  [`UPDATE companies SET people_status='pending', search_status=NULL; DELETE FROM people WHERE origin<>'import'`,
                'найденные ЛПР удалены (кроме пришедших из файла) — запустите node run.js people'],
      titles:  [`UPDATE people SET title_match='pending', verified='pending'`,
                'отбор по должностям сброшен — запустите node run.js people'],
      'titles-import': [`UPDATE people SET title_match='pass' WHERE origin='import'`,
                'все люди из файла снова считаются подходящими'],
    };
    if (!R[stage]) {
      console.log('\n  Укажите этап: --stage qualify | people | titles | titles-import\n');
      console.log('    qualify — пересчитать отбор компаний (после правки prompts/qualify.md)');
      console.log('    people  — искать ЛПР заново (после правки prompts/titles.md)');
      console.log('    titles  — только перепроверить должности у уже найденных людей');
      console.log('    titles-import — вернуть всех людей из загруженного файла\n');
      console.log('  Скачанные страницы сайтов сохраняются в любом случае.\n');
      break;
    }
    for (const sql of R[stage][0].split(';')) if (sql.trim()) db.exec(sql);
    console.log(`\n  ${R[stage][1]}\n`);
    break;
  }

  case 'report': {
    finalReport(db, { title: 'ТЕКУЩЕЕ СОСТОЯНИЕ' });
    break;
  }

  case 'export': {
    const keepPersonal = (process.env.KEEP_PERSONAL_EMAILS ?? 'true') !== 'false';
    const onoff = (name) => {
      const v = flag(name, null);
      if (v === null) return undefined;
      return v === true || /^(on|true|да|yes|1)$/i.test(String(v));
    };
    const generic = onoff('generic'), departments = onoff('departments');
    if (generic !== undefined) setMeta(db, 'export_generic', String(generic));
    if (departments !== undefined) setMeta(db, 'export_departments', String(departments));
    const r = exportAll(db, { keepPersonal, generic, departments });
    const third = r.perPerson ? 'out/3-ЛПР-без-личной-почты.csv' : 'out/3-общие-почты.csv';
    console.log(`
  out/1-компании.csv        ${r.companies} строк`);
    console.log(`  out/2-ЛПР-с-почтами.csv   ${r.people} строк   ← главная таблица`);
    if (r.wantGeneric || r.wantDept) {
      console.log(`  ${third.padEnd(25)} ${r.generic} строк  (с общей почтой или почтой отдела: ${r.withGeneric})`);
    } else {
      console.log('  третья таблица не создавалась: общие почты и почты отделов не запрашивались');
      console.log('    забрать их: node run.js export --generic on --departments on');
    }
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
  node run.js reset  --stage qualify|people|titles     пересчитать этап после правки промпта
  node run.js report                                  статус и расходы
  node run.js export                                  три CSV в out/

  node run.js all                                     весь конвейер по порядку

  Первый раз проще всего так:
    node run.js all
`);
}
