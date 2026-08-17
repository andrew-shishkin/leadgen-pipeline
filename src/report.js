// Единый отчёт в конце каждого прогона — и для вас, и для ученика.
// Показывает не только «сколько сделано», но и почему часть строк отвалилась.

import { costReport, unj } from './db.js';

const money = (u) => '$' + (u < 1 ? u.toFixed(4) : u.toFixed(2));
const pct = (n, t) => (t ? Math.round((100 * n) / t) + '%' : '—');
const pad = (s, n) => String(s).padStart(n);

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

  const ppl = db.prepare(`SELECT origin, COUNT(*) n FROM people GROUP BY origin`).all();
  if (ppl.length) {
    L.push('');
    L.push('  ЛПР');
    const labels = { import: 'из исходного файла', site: 'с сайтов компаний', search: 'из поиска в Яндексе' };
    for (const r of ppl) L.push(`    ${(labels[r.origin] ?? r.origin).padEnd(28)}${pad(r.n, 6)}`);
    const withMail = db.prepare(`SELECT COUNT(*) n FROM people WHERE email IS NOT NULL`).get().n;
    if (withMail) L.push(`    ${'с найденной почтой'.padEnd(28)}${pad(withMail, 6)}`);
    // фильтр по году — самая незаметная причина потерь, показываем её явно
    const byDate = db.prepare(
      `SELECT COUNT(*) n FROM people WHERE verified='false' AND verify_reason LIKE '%старше%'`).get().n;
    if (byDate) {
      L.push(`    ${'отсеяно по дате публикации'.padEnd(28)}${pad(byDate, 6)}`);
      L.push(`       если это много — сдвиньте FRESH_SINCE_YEAR в .env (сейчас ${process.env.FRESH_SINCE_YEAR || 2022})`);
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
  }

  const next = [];
  if (c.pend) next.push(`node run.js fetch          — загрузить ${c.pend} оставшихся сайтов`);
  if (c.icppend && !c.pend) next.push(`node run.js qualify --batch — квалифицировать ${c.icppend} компаний вдвое дешевле`);
  if (c.unclear) next.push(`node run.js export         — выгрузить, в т.ч. ${c.unclear} спорных на проверку`);
  if (next.length) { L.push('', '  ЧТО ДАЛЬШЕ'); for (const n of next) L.push('    ' + n); }

  L.push('', '─'.repeat(64), '');
  console.log(L.join('\n'));
}
