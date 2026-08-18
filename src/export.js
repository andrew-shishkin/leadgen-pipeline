// Три таблицы на выход. Во вторую и третью выводим ВСЕ поля компании —
// они нужны как переменные в письмах и при импорте в CRM.

import fs from 'node:fs';
import { unj, getMeta } from './db.js';
import { toCSV, normalizeVerdict } from './stages.js';
import { pickGenericEmail, matchEmailToPerson, parseFio, domainPart, relatedToCompany, classifyMailbox } from './emails.js';
import { isFreeMail } from './extract.js';

const list = (s) => unj(s) ?? [];
const allEmails = (c) => [...new Set([...list(c.emails_import), ...list(c.emails_site)].map((e) => e.toLowerCase()))];

/** Поля компании, которые дублируются в каждую строку ЛПР и generic-таблицы. */
const companyFields = (c, d) => ({
  'Компания': c.name,
  'Юрлицо': c.legal_name ?? '',
  'ИНН': c.inn,
  'Сайт': c.site,
  'Домен': c.domain,
  'Телефоны': list(c.phones).join(', '),
  'Чем занимается': d.category ?? '',
  'Руководитель': c.ceo_name ?? '',
  'Должность руководителя': c.ceo_title ?? '',
});

export function exportAll(db, { dir = 'out', keepPersonal = true, generic, departments } = {}) {
  // Что забирать с сайтов, кроме именных почт, — решает пользователь.
  const wantGeneric = generic ?? getMeta(db, 'export_generic', 'true') !== 'false';
  const wantDept    = departments ?? getMeta(db, 'export_departments', 'false') === 'true';
  // В списке ЛПР третья таблица — это люди без личной почты, а не компании:
  // писать на info@ всё равно придётся конкретному человеку.
  const perPerson = getMeta(db, 'list_kind', 'companies') === 'people';
  fs.mkdirSync(dir, { recursive: true });
  const companies = db.prepare(`SELECT * FROM companies ORDER BY icp_status, name`).all();
  const people = db.prepare(`SELECT * FROM people`).all();
  const byCompany = new Map();
  for (const p of people) {
    if (!byCompany.has(p.company_id)) byCompany.set(p.company_id, []);
    byCompany.get(p.company_id).push(p);
  }

  // ── 1. Компании ──
  const t1 = companies.map((c) => {
    const d = normalizeVerdict(unj(c.icp_json) ?? {});
    return {
      'Компания': c.name, 'Юрлицо': c.legal_name ?? '', 'ИНН': c.inn, 'Сайт': c.site, 'Домен': c.domain,
      'Подходит под ICP': { pass: 'да', fail: 'нет', unclear: 'под вопросом',
                            error: 'ошибка', pending: 'не проверяли' }[c.icp_status] ?? c.icp_status,
      'Главный критерий': { yes: 'да', no: 'нет', unknown: 'непонятно' }[d.fits] ?? '',
      'Второй критерий': { yes: 'да', no: 'нет', unclear: 'непонятно', not_applicable: '—' }[d.extra] ?? '',
      'Чем занимается': d.category ?? '',
      'Обоснование': c.icp_reason ?? '',
      'Цитаты с сайта': (d.evidence ?? []).join(' // '),
      'Руководитель': c.ceo_name ?? '', 'Должность руководителя': c.ceo_title ?? '',
      'Телефоны': list(c.phones).join(', '),
      'Все почты': allEmails(c).join(', '),
      'Сайт открылся': c.fetch_status === 'ok' ? 'да' : 'нет',
      'Причина отказа': c.fetch_error ?? '',
    };
  });

  // ── 2. ЛПР с именными почтами / 3. Generic ──
  const t2 = [], t3 = [];
  for (const c of companies) {
    if (c.icp_status !== 'pass') continue;          // ищем только по подходящим
    const d = normalizeVerdict(unj(c.icp_json) ?? {});
    const emails = allEmails(c);
    const staff = byCompany.get(c.id) ?? [];

    // в письмо идут только подходящие по должности и не опровергнутые проверкой
    const relevant = staff.filter((p) => p.title_match === 'pass' && p.verified !== 'false');
    const withEmail = [];
    for (const p of relevant) {
      let email = p.email ?? matchEmailToPerson(p.full_name, emails, c.domain);
      if (email && !keepPersonal && isFreeMail(email)) email = null;
      if (email) withEmail.push({ p, email });
    }

    if (withEmail.length) {
      for (const { p, email } of withEmail) {
        const f = parseFio(p.full_name);
        const nom = p.name_nominative || [f?.first, f?.patronymic].filter(Boolean).join(' ');
        t2.push({
          'ФИО': p.full_name,
          'Имя Отчество (кто)': nom,
          'Имя Отчество (кому)': p.name_dative ?? '',
          'Должность': p.title ?? '',
          'Почта': email,
          'Тип почты': isFreeMail(email) ? 'личная' : 'корпоративная',
          'Откуда почта': p.email_source ?? 'найдена в собранных',
          'Статус почты': p.email_status ?? 'не проверялась',
          'Источник ЛПР': { import: 'исходный файл', site: 'сайт компании', search: 'поиск' }[p.origin] ?? p.origin,
          'Ссылка на источник': p.source_url ?? '',
          'Проверка': { true: 'подтверждён', unknown: 'не удалось проверить', trusted: 'из вашего файла' }[p.verified] ?? p.verified,
          'Внимание': relatedToCompany(email, c.name, c.domain) ? ''
            : `домен ${domainPart(email)} не связан с компанией — проверьте, то ли это юрлицо`,
          ...companyFields(c, d),
        });
      }
    }
    if (!wantGeneric && !wantDept) continue;

    const g = wantGeneric ? pickGenericEmail(emails, c.domain, c.name) : { email: null, reason: 'общие почты не запрашивались' };
    const dept = wantDept ? emails.filter((e) => classifyMailbox(e) === 'department') : [];
    // без личной почты остались вот эти — им и писать на общий ящик
    const withoutEmail = perPerson ? relevant.filter((p) => !withEmail.some((w) => w.p.id === p.id)) : [];
    const fallback = relevant[0] ?? staff.find((p) => p.origin === 'import') ?? staff[0];
    const targets = perPerson ? withoutEmail : (withEmail.length ? [] : [fallback]);

    for (const best of targets) {
      if (!best && perPerson) continue;
      const f = best ? parseFio(best.full_name) : null;
      const nom = best?.name_nominative || [f?.first, f?.patronymic].filter(Boolean).join(' ');
      const row = {};
      if (wantGeneric) { row['Общая почта'] = g.email ?? ''; row['Почему такая'] = g.reason; }
      if (wantDept) row['Почты отделов'] = dept.join(', ');
      Object.assign(row, {
        'Внимание': g.foreign ? 'домен не связан с компанией — возможно холдинг или дилер' : '',
        'ФИО для письма': best?.full_name ?? '',
        'Имя Отчество (кто)': nom,
        'Имя Отчество (кому)': best?.name_dative ?? '',
        'Должность': best?.title ?? '',
        ...companyFields(c, d),
        'Все почты': emails.join(', '),
      });
      t3.push(row);
    }
  }

  const write = (name, rows) => {
    if (!rows.length) { fs.writeFileSync(`${dir}/${name}`, '﻿', 'utf8'); return 0; }
    fs.writeFileSync(`${dir}/${name}`, '﻿' + toCSV(rows, Object.keys(rows[0])), 'utf8');
    return rows.length;
  };

  return {
    companies: write('1-компании.csv', t1),
    people:    write('2-ЛПР-с-почтами.csv', t2),
    generic:   write(perPerson ? '3-ЛПР-без-личной-почты.csv' : '3-общие-почты.csv', t3),
    withGeneric: t3.filter((r) => r['Общая почта'] || r['Почты отделов']).length,
    perPerson, wantGeneric, wantDept,
  };
}
