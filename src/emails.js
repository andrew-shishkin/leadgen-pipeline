// Работа с почтами. Всё детерминированно — нейросеть подключается только там,
// где код честно не справился (см. stages: подбор именной почты).

import { FREE_MAIL_DOMAINS } from './extract.js';

/** Общие почты в порядке предпочтения. Первая найденная и выигрывает. */
const GENERIC_PRIORITY = [
  'info', 'office', 'mail', 'contact', 'contacts', 'company', 'secretary',
  'reception', 'priemnaya', 'priem', 'kancelyariya', 'general',
];

/** Никогда не пишем на эти ящики: там либо не читают, либо читает не тот. */
const GENERIC_BLOCKLIST = new Set([
  'sales', 'sale', 'order', 'orders', 'tender', 'tenders', 'trade', 'zakaz', 'zakazy',
  'zakupki', 'opt', 'pr', 'policy', 'corruption', 'admin', 'hr', 'job', 'jobs',
  'vacancy', 'rabota', 'spam', 'abuse', 'noreply', 'no-reply', 'postmaster',
  'webmaster', 'support', 'help', 'service', 'buh', 'buhgalteria', 'account',
  'billing', 'legal', 'complaint', 'sklad', 'logistic', 'logistics',
]);

export const localPart = (e) => (e ?? '').split('@')[0].toLowerCase();
export const domainPart = (e) => (e ?? '').split('@')[1]?.toLowerCase() ?? '';

/**
 * Выбрать общую почту компании для письма.
 * Возвращает { email, reason } либо { email: null, reason } — почему не нашлось.
 */
export function pickGenericEmail(emails, companyDomain) {
  const list = [...new Set((emails ?? []).map((e) => e.toLowerCase().trim()).filter(Boolean))];
  if (!list.length) return { email: null, reason: 'почт нет вообще' };

  const allowed = list.filter((e) => {
    const lp = localPart(e).replace(/[._-]?\d+$/, '');
    return !GENERIC_BLOCKLIST.has(lp);
  });
  if (!allowed.length) return { email: null, reason: 'все почты из стоп-листа (zakaz@, tender@ и подобные)' };

  // корпоративный домен предпочтительнее публичного
  const rank = (e) => {
    const d = domainPart(e);
    const own = companyDomain && (d === companyDomain || d.endsWith('.' + companyDomain));
    return (own ? 0 : FREE_MAIL_DOMAINS.has(d) ? 2 : 1);
  };

  for (const want of GENERIC_PRIORITY) {
    const hits = allowed.filter((e) => localPart(e) === want).sort((a, b) => rank(a) - rank(b));
    if (hits.length) return { email: hits[0], reason: `приоритетная общая почта ${want}@` };
  }

  // ничего из приоритетного списка — берём любую на корпоративном домене
  const own = allowed.filter((e) => rank(e) === 0);
  if (own.length) return { email: own[0], reason: 'общей почты нет, взята корпоративная' };

  return { email: null, reason: 'подходящей общей почты нет' };
}

/** Транслитерация ФИО для сервисов поиска почт и для сопоставления с локалпартами. */
const TRANSLIT = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',
  ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
};
export const translit = (s) => (s ?? '').toLowerCase().split('').map((c) => TRANSLIT[c] ?? c).join('');

/** Разбор «Иванов Пётр Сергеевич» на части. Отчество узнаётся по окончанию. */
export function parseFio(fio) {
  const parts = (fio ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const patronymicRe = /(ович|евич|ьич|ич|овна|евна|ична|инична|кызы|оглы)$/i;
  const patronymic = parts.find((p) => patronymicRe.test(p) && p.length > 4) ?? null;
  const rest = parts.filter((p) => p !== patronymic);
  // в российских выгрузках почти всегда «Фамилия Имя Отчество»
  const [last, first] = rest.length >= 2 ? rest : [rest[0], null];
  return { last: last ?? null, first: first ?? null, patronymic, full: parts.join(' ') };
}

/** Кандидаты локалпартов для человека: покрывают массовые шаблоны российских компаний. */
export function emailPatterns(fio) {
  const p = parseFio(fio);
  if (!p?.last) return [];
  const L = translit(p.last), F = translit(p.first ?? ''), M = translit(p.patronymic ?? '');
  const f = F[0] ?? '', m = M[0] ?? '';
  const out = new Set([
    L, `${f}${L}`, `${f}.${L}`, `${f}_${L}`, `${f}-${L}`, `${L}${f}`, `${L}.${f}`,
    `${f}${m}${L}`, `${f}.${m}.${L}`, `${L}${f}${m}`, `${L}.${f}.${m}`,
    `${F}`, `${F}.${L}`, `${F}_${L}`, `${F}${L}`, `${L}.${F}`, `${L}_${F}`, `${L}${F}`,
    `${f}${m}${L[0] ?? ''}`, `${L[0] ?? ''}${f}${m}`,
  ].filter((x) => x && x.length > 1));
  return [...out];
}

/** Варианты транслитерации: у одной фамилии их несколько (bakhmutov / bahmutov). */
function translitVariants(s) {
  const base = translit(s);
  return new Set([
    base,
    base.replace(/kh/g, 'h'), base.replace(/zh/g, 'j'),
    base.replace(/ya/g, 'ia'), base.replace(/yu/g, 'iu'),
    base.replace(/ts/g, 'c'), base.replace(/y/g, 'i'),
  ]);
}

/** Функциональные ящики: в России их принимают за именные чаще всего. */
const DEPARTMENT_WORDS = [
  'sbyt', 'omts', 'otk', 'pdo', 'oks', 'ohrana', 'okhrana', 'kom', 'komm',
  'tehnolog', 'technolog', 'glavbuh', 'buh', 'buhgalter', 'glav', 'snab',
  'sekretar', 'secretar', 'priem', 'priemnaya', 'kadry', 'kadr', 'sklad',
  'servis', 'service', 'remont', 'proizvodstvo', 'plan', 'finans', 'ekonom',
  'econom', 'yur', 'ur', 'torg', 'market', 'reklama', 'zakup', 'ved', 'vet',
  'tender', 'opt', 'shop', 'magazin', 'dogovor', 'arenda', 'logist', 'tnp',
];

/**
 * Похожа ли почта на личную почту ИМЕННО этого человека.
 * Нейросеть охотно раздаёт отделы за именные ящики и может назначить один
 * адрес нескольким людям — это последний рубеж, который такое не пропускает.
 */
export function looksPersonal(fio, email) {
  const lp = localPart(email).replace(/[._-]/g, '').replace(/\d+$/, '');
  if (!lp) return false;
  if (DEPARTMENT_WORDS.includes(lp)) return false;

  const p = parseFio(fio);
  if (!p?.last) return false;

  const tokens = new Set();
  for (const v of translitVariants(p.last)) {
    const min = Math.min(4, v.length);
    for (let n = min; n <= v.length; n++) tokens.add(v.slice(0, n));
  }
  // имя тоже сокращают: Наталья → nata@, Александр → alex@
  if (p.first) for (const v of translitVariants(p.first)) {
    for (let n = Math.min(4, v.length); n <= v.length; n++) tokens.add(v.slice(0, n));
  }

  for (const t of tokens) if (t.length >= 3 && lp.includes(t)) return true;
  return false;
}

/**
 * Найти в собранных почтах ту, что принадлежит человеку.
 * Точное совпадение по шаблону — бесплатно и надёжно. Что не совпало,
 * уходит нейросети отдельным шагом (ivanovceo@, gendir@ и прочая экзотика).
 */
export function matchEmailToPerson(fio, emails, companyDomain) {
  const pats = new Set(emailPatterns(fio));
  if (!pats.size) return null;
  const scored = (emails ?? [])
    .map((e) => ({ e: e.toLowerCase(), lp: localPart(e), d: domainPart(e) }))
    .filter((x) => pats.has(x.lp))
    .sort((a, b) => {
      const own = (x) => (companyDomain && x.d === companyDomain ? 0 : FREE_MAIL_DOMAINS.has(x.d) ? 2 : 1);
      return own(a) - own(b) || b.lp.length - a.lp.length;
    });
  return scored[0]?.e ?? null;
}
