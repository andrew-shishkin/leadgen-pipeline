// Единый отчёт в конце каждого прогона — и для вас, и для ученика.
// Показывает не только «сколько сделано», но и почему часть строк отвалилась.

import { costReport, unj } from './db.js';

const money = (u) => '$' + (u < 1 ? u.toFixed(4) : u.toFixed(2));
const pct = (n, t) => (t ? Math.round((100 * n) / t) + '%' : '—');
const pad = (s, n) => String(s).padStart(n);
const plural = (n, one, few, many) => {
  const a = n % 100, b = n % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};

const ERROR_LABELS = {
  ENOTFOUND: 'домен не существует — компании больше нет',
  TIMEOUT: 'сайт не отвечает',
  'HTTP 404': 'страница удалена',
  'HTTP 403': 'сайт блокирует роботов',
  'HTTP 500': 'сайт сломан',
  'HTTP 402': 'хостинг не оплачен',
  BAD_URL: 'битая ссылка в исходном файле',
  TOO_MANY_REDIRECTS: 'бесконечные редиректы',
};

export function finalReport(db, { title = 'ИТОГИ ПРОГОНА' } = {}) {
  const L = [];
  const c = db.prepare(`SELECT
      COUNT(*) total,
      SUM(fetch_status='ok') ok, SUM(fetch_status='failed') failed, SUM(fetch_status='pending') pend,
      SUM(icp_status='pass') pass, SUM(icp_status='fail') fail,
      SUM(icp_status='unclear') unclear, SUM(icp_status='error') icperr,
      SUM(icp_status='pending') icppend
    FROM companies`).get();

  L.push('', '─'.repeat(64), `  ${title}`, '─'.repeat(64), '');
  L.push('  СПИСОК КОМПАНИЙ');
  L.push(`    загружено:                  ${pad(c.total, 6)}`);

  if (c.ok + c.failed > 0) {
    L.push('');
    L.push('  САЙТЫ');
    L.push(`    открылись:                  ${pad(c.ok, 6)}   ${pct(c.ok, c.ok + c.failed)}`);
    L.push(`    не открылись:               ${pad(c.failed, 6)}   ${pct(c.failed, c.ok + c.failed)}`);
    const errs = db.prepare(
      `SELECT fetch_error e, COUNT(*) n FROM companies WHERE fetch_status='failed' GROUP BY e ORDER BY n DESC`).all();
    for (const r of errs) L.push(`       ${pad(r.n, 4)}  ${r.e} — ${ERROR_LABELS[r.e] ?? 'причина неизвестна'}`);
    const thin = db.prepare(`SELECT COUNT(*) n FROM companies WHERE fetch_status='ok' AND text_len < 400`).get().n;
    if (thin) L.push(`    пустых страниц (сайт на JS): ${pad(thin, 5)}   нужен браузерный режим`);
  }

  if (c.pass + c.fail + c.unclear + c.icperr > 0) {
    const judged = c.pass + c.fail + c.unclear;
    L.push('');
    L.push('  КВАЛИФИКАЦИЯ ПО ICP');
    L.push(`    подходят:                   ${pad(c.pass, 6)}   ${pct(c.pass, judged)}`);
    L.push(`    не подходят:                ${pad(c.fail, 6)}   ${pct(c.fail, judged)}`);
    L.push(`    под вопросом:               ${pad(c.unclear, 6)}   ${pct(c.unclear, judged)}  ← проверить глазами`);
    if (c.icperr) L.push(`    ошибок:                     ${pad(c.icperr, 6)}`);
    if (c.icppend) L.push(`    ещё не смотрели:            ${pad(c.icppend, 6)}`);
  }

  // почты
  const mail = db.prepare(`SELECT emails_import i, emails_site s FROM companies`).all();
  let imp = 0, site = 0, fresh = 0, withAny = 0;
  for (const r of mail) {
    const a = unj(r.i) ?? [], b = unj(r.s) ?? [];
    const set = new Set(a.map((x) => x.toLowerCase()));
    imp += a.length; site += b.length;
    fresh += b.filter((e) => !set.has(e)).length;
    if (a.length + b.length) withAny++;
  }
  if (imp + site) {
    L.push('');
    L.push('  ПОЧТЫ');
    L.push(`    было в исходном файле:      ${pad(imp, 6)}`);
    L.push(`    найдено на сайтах:          ${pad(site, 6)}   из них новых: ${fresh}`);
    L.push(`    компаний хотя бы с одной:   ${pad(withAny, 6)}   ${pct(withAny, c.total)}`);
  }

  // нужна и внутри блока ЛПР, и в РАСХОДАХ (цена под ключ) — считаем один раз здесь
  const withMail = db.prepare(`SELECT COUNT(*) n FROM people WHERE email IS NOT NULL`).get().n;

  const ppl = db.prepare(`SELECT origin, COUNT(*) n FROM people GROUP BY origin`).all();
  if (ppl.length) {
    L.push('');
    L.push('  ЛПР');
    // Главная цифра — целевые, а не «всего найдено». В списке компаний почти
    // все импортированные — генеральные директора, они по должности не проходят,
    // и общее число создаёт впечатление, что людей много.
    const labels = { import: 'из исходного файла', site: 'с сайтов компаний', search: 'из поиска в интернете' };
    const target = db.prepare(`SELECT origin, COUNT(*) n FROM people WHERE title_match='pass' GROUP BY origin`).all();
    const byOrigin = Object.fromEntries(target.map((r) => [r.origin, r.n]));
    for (const r of ppl) {
      const t = byOrigin[r.origin] ?? 0;
      L.push(`    ${(labels[r.origin] ?? r.origin).padEnd(28)}${pad(r.n, 6)}   из них целевых: ${t}`);
      // движок поиска (Яндекс/Google) видно только когда их несколько —
      // одним движком нарочно не раздуваем строку, она повторит соседнюю
      if (r.origin === 'search') {
        const ENGINE_LABEL = { yandex: 'из них через Яндекс', builtin: 'из них через Google' };
        const byEngine = db.prepare(`SELECT engine, COUNT(*) n FROM people WHERE origin='search' GROUP BY engine`).all();
        if (byEngine.length > 1) for (const e of byEngine)
          L.push(`       ${(ENGINE_LABEL[e.engine] ?? 'движок не определён').padEnd(25)}${pad(e.n, 6)}`);
      }
    }
    const all = ppl.reduce((a, r) => a + r.n, 0);
    const tgt = target.reduce((a, r) => a + r.n, 0);
    L.push(`    ${'ЦЕЛЕВЫХ ВСЕГО'.padEnd(28)}${pad(tgt, 6)}   из ${all} найденных`);
    L.push('       дальше по конвейеру идут только они — почты ищутся для целевых');
    if (withMail) L.push(`    ${'с найденной почтой'.padEnd(28)}${pad(withMail, 6)}   ${tgt ? Math.round(100 * withMail / tgt) + '% от целевых' : ''}`);
    // сколько компаний вообще не дали ни одного человека — это и есть узкое место
    const zero = db.prepare(`SELECT COUNT(*) n FROM companies c WHERE c.icp_status='pass'
      AND NOT EXISTS (SELECT 1 FROM people p WHERE p.company_id=c.id AND p.origin<>'import' AND p.title_match='pass')`).get().n;
    const pass = db.prepare(`SELECT COUNT(*) n FROM companies WHERE icp_status='pass'`).get().n;
    if (pass) {
      L.push(`    ${'компаний без единого ЛПР'.padEnd(28)}${pad(zero, 6)}   из ${pass} подходящих (${Math.round(100 * zero / pass)}%)`);
      if (zero / pass > 0.4) L.push('       больше 40% — расширьте список должностей: node run.js titles --suggest');
    }
    // фильтр по году — самая незаметная причина потерь, показываем её явно
    const byDate = db.prepare(
      `SELECT COUNT(*) n FROM people WHERE verified='false' AND verify_reason LIKE '%старше%'`).get().n;
    if (byDate) {
      L.push(`    ${'отсеяно по дате публикации'.padEnd(28)}${pad(byDate, 6)}`);
      L.push(`       если это много — сдвиньте FRESH_SINCE_YEAR в .env (сейчас ${process.env.FRESH_SINCE_YEAR || 2022})`);
    }
  }

  // Разбивка по сервисам поиска почт. Нужна, чтобы молчаливая поломка одного
  // провайдера была видна: FullEnrich отвечал за ~70 секунд, а его ждали 35,
  // и весь прогон он выглядел как сервис, который просто ничего не находит.
  const wf = db.prepare(`
    SELECT provider, model outcome, COUNT(*) n FROM usage
    WHERE stage='email-waterfall' GROUP BY provider, outcome`).all();
  if (wf.length) {
    const by = new Map();
    for (const r of wf) {
      const cur = by.get(r.provider) ?? { found: 0, not_found: 0, timeout: 0, error: 0 };
      cur[r.outcome ?? 'not_found'] = (cur[r.outcome ?? 'not_found'] ?? 0) + r.n;
      by.set(r.provider, cur);
    }
    L.push('');
    L.push('  СЕРВИСЫ ПОИСКА ПОЧТ');
    L.push(`    ${'сервис'.padEnd(14)}${'нашёл'.padStart(7)}${'запросов'.padStart(10)}${'таймаут'.padStart(9)}${'ошибок'.padStart(8)}`);
    for (const [name, c] of by) {
      const asked = c.found + c.not_found;
      L.push(`    ${name.padEnd(14)}${pad(c.found, 7)}${pad(asked, 10)}${pad(c.timeout, 9)}${pad(c.error, 8)}`);
    }
    for (const [name, c] of by) {
      const asked = c.found + c.not_found;
      if (c.timeout >= 2) {
        L.push('');
        L.push(`    ⚠️  ${name}: ${c.timeout} ${plural(c.timeout, 'раз', 'раза', 'раз')} не ответил вовремя — это НЕ «не нашёл».`);
        L.push('       Увеличьте ENRICH_POLL_SECONDS в .env (сейчас '
             + (process.env.ENRICH_POLL_SECONDS || 180) + ' с) и повторите этап.');
      } else if (asked >= 20 && c.found === 0) {
        L.push('');
        L.push(`    ⚠️  ${name}: ${asked} запросов и ни одной почты. На такой выборке это`);
        L.push('       подозрительно — обычно так выглядит не пустая база, а поломка на нашей');
        L.push('       стороне: не тот формат запроса, не то поле в ответе, слишком короткое');
        L.push('       ожидание. Проверьте: ENRICH_DEBUG=true node run.js emails --only 3');
        L.push(`       и сверьте сырой ответ ${name} с разбором в src/enrich.js.`);
      }
    }
  }

  const { rows, total } = costReport(db);
  L.push('');
  L.push('  РАСХОДЫ');
  if (!rows.length) {
    L.push('    пока ноль — платные шаги ещё не запускались');
  } else {
    for (const r of rows) {
      const what = r.provider === 'anthropic' ? `${r.stage} (${r.model})` : `${r.stage} (${r.provider})`;
      L.push(`    ${what.padEnd(38)}${money(r.usd ?? 0).padStart(10)}`);
    }
    L.push(`    ${'ИТОГО'.padEnd(38)}${money(total).padStart(10)}`);
    const judged = c.pass + c.fail + c.unclear + c.icperr;
    if (judged > 0) {
      L.push('');
      L.push(`    на одну компанию:           ${money(total / judged)}`);
      L.push(`    экстраполяция на 5 000:     ${money((total / judged) * 5000)}`);
    }
    // Главное число под ключ: не «сколько стоит компания», а «сколько стоит
    // один живой контакт с почтой» — весь расход прогона делится на них.
    if (withMail) {
      L.push('');
      L.push(`    цена под ключ (1 ЛПР с почтой): ${money(total / withMail)}`);
    }
  }

  const next = [];
  if (c.pend) next.push(`node run.js fetch          — загрузить ${c.pend} оставшихся сайтов`);
  if (c.icppend && !c.pend) next.push(`node run.js qualify --batch — квалифицировать ${c.icppend} компаний вдвое дешевле`);
  if (c.unclear) next.push(`node run.js export         — выгрузить, в т.ч. ${c.unclear} спорных на проверку`);
  if (next.length) { L.push('', '  ЧТО ДАЛЬШЕ'); for (const n of next) L.push('    ' + n); }

  L.push('', '─'.repeat(64), '');
  console.log(L.join('\n'));
}
