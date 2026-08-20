// Работа с почтами. Всё детерминированно — нейросеть подключается только там,
// где код честно не справился (см. stages: подбор именной почты).

import { isFirstName } from './names.js';

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
export function pickGenericEmail(emails, companyDomain, companyName = '') {
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

  // Сначала ищем ТОЛЬКО на домене самой компании. Иначе «ВИЗ-Стали» достаётся
  // info@nlmk.com — почта головного холдинга, а письмо должно уйти на завод.
  const ownDomain = allowed.filter((e) => rank(e) === 0);
  for (const want of GENERIC_PRIORITY) {
    const hit = ownDomain.find((e) => localPart(e) === want);
    if (hit) return { email: hit, reason: `приоритетная общая почта ${want}@` };
  }
  if (ownDomain.length) return { email: ownDomain[0], reason: 'общей почты нет, взята корпоративная' };

  // Компания внутри холдинга: свой домен — поддомен корпоративного, почты общие
  // (ВИЗ-Сталь на viz-steel.nlmk.com, почты @nlmk.com). Тогда info@ уйдёт в
  // головной офис, а нам нужен ящик самого завода — ищем его по названию.
  const nameHit = allowed.find((e) => {
    const lp = localPart(e).replace(/[^a-z0-9]/g, '');
    if (lp.length < 4 || GENERIC_PRIORITY.includes(localPart(e))) return false;
    const core = (companyDomain ?? '').split('.')[0].replace(/[^a-z0-9]/g, '');
    return core.length >= 4 && (lp.includes(core) || core.includes(lp));
  });
  if (nameHit) return { email: nameHit, reason: 'адресная почта этого юрлица внутри общего домена' };

  // На своём домене ничего. Берём с чужого, но помечаем: это может быть
  // холдинг, дилер или другая площадка — такие строки надо смотреть глазами.
  const mark = (e) => {
    const alien = !relatedToCompany(e, companyName, companyDomain);
    return {
      email: e,
      reason: alien ? `⚠ домен ${domainPart(e)} не связан с компанией — проверьте` : `почта на домене ${domainPart(e)}`,
      foreign: alien,
    };
  };
  for (const want of GENERIC_PRIORITY) {
    const hit = allowed.find((e) => localPart(e) === want);
    if (hit) return mark(hit);
  }
  if (allowed.length) return mark(allowed[0]);

  return { email: null, reason: 'подходящей общей почты нет' };
}

/** Транслитерация ФИО для сервисов поиска почт и для сопоставления с локалпартами. */
const TRANSLIT = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',
  ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
};
export const translit = (s) => (s ?? '').toLowerCase().split('').map((c) => TRANSLIT[c] ?? c).join('');

/** Регистрируемый домен компании: «php.i-neti.ru» → «i-neti.ru».
 *
 *  Сервисы поиска почт ждут домен компании, а из исходного файла к нам
 *  приходит адрес страницы: agency.sape.ru, spb.lanit.ru, php.i-neti.ru.
 *  По поддомену человек не находится, хотя по самой компании нашёлся бы.
 *  Двухсоставные зоны (co.uk, com.br) учтены отдельно, а «pride.marketing»
 *  трогать нельзя — там marketing и есть зона верхнего уровня. */
const TWO_PART_TLD = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'co.nz', 'com.br', 'co.jp', 'com.tr', 'co.il']);
export function rootDomain(host) {
  const h = String(host ?? '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  const p = h.split('.').filter(Boolean);
  if (p.length <= 2) return h;
  const keep = TWO_PART_TLD.has(p.slice(-2).join('.')) ? 3 : 2;
  return p.slice(-keep).join('.');
}

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);
const hasCyrillic = (s) => /[а-яё]/i.test(s ?? '');

/** Транслитерация с подменой отдельных букв — для альтернативных написаний. */
const translitWith = (s, alt) => (s ?? '').toLowerCase().split('')
  .map((c) => alt[c] ?? TRANSLIT[c] ?? c).join('');

/** ФИО латиницей для сервисов поиска почт: «Казаков» → «Kazakov».
 *
 *  Prospeo, Wiza, FullEnrich и остальные ищут по латинице. Кириллическое
 *  «Казаков Игорь Михайлович» для них — не имя, а строка без совпадений,
 *  поэтому в сервисы уходит только транслитерированный вариант, всегда,
 *  независимо от того, как ФИО записано в исходном файле. */
export const translitName = (s) => (s ?? '')
  .split(/([\s-]+)/)
  .map((part) => (/^[\s-]+$/.test(part) ? part : cap(translit(part))))
  .join('');

/** Целые системы транслитерации, а не отдельные буквы.
 *
 *  Одно и то же имя в разных базах записано по разной системе, и сервисы
 *  ищут по точному совпадению. Проверено на выгрузке из Clay: из двадцати
 *  ФИО девять писались не так, как у нас, и почти все расхождения —
 *  это не опечатки, а другая система.
 *
 *  Порядок важен: каждая система — отдельный платный запрос к сервису. */
const ALT_MAPS = [
  // загранпаспорт (ИКАО): Паймышев → Paimyshev, Гайдаенко → Gaidaenko
  { й: 'i', ю: 'iu', я: 'ia' },
  { х: 'h' },                 // Михаил: Mikhail → Mihail
  { ё: 'yo' },                // Семёнов: Semenov → Semyonov
  { щ: 'sch' },               // Щербаков: Shcherbakov → Scherbakov
];

/** Окончания, которые в англоязычных базах пишут короче. */
const ALT_ENDINGS = [
  [/skiy$/i, 'sky'],          // Вознесенский: Voznesenskiy → Voznesensky
  [/iy$/i, 'ii'],             // Евгений: Evgeniy → Evgenii
  [/iy$/i, 'i'],              // Юрий: Yuriy → Yuri
];

/**
 * Другие написания того же имени латиницей. Первым идёт основное.
 *
 * Зачем: сервисы поиска почт ищут по точному совпадению. На «Evgenii»
 * отвечают «не найдено», на «Evgeniy» отдают адрес — и наоборот. Проверено
 * на живых прогонах в Clay, работает в обе стороны, поэтому одного
 * написания мало.
 *
 * Варианты строятся от кириллицы подменой букв, а не регулярками по готовой
 * латинице: правило «h → kh» по латинице портит всё подряд, превращая
 * Merkulovich в Merkulovickh, а Shcherbakova в Skhckherbakova.
 */
export function spellingVariants(word, { max = 5 } = {}) {
  const out = [];
  const push = (v) => { v = cap(v); if (v && !out.includes(v)) out.push(v); };
  const src = (word ?? '').trim();
  if (!src) return out;

  if (hasCyrillic(src)) {
    const base = translit(src);
    push(base);
    for (const alt of ALT_MAPS) push(translitWith(src, alt));
    for (const [re, to] of ALT_ENDINGS) if (re.test(base)) push(base.replace(re, to));
    // «и» перед гласной часто пишут со скользящей y: Кафиатуллин → Kafiyatullin
    if (/i[aeou]/.test(base)) push(base.replace(/i([aeou])/g, 'iy$1'));
  } else {
    push(src);
    for (const [re, to] of ALT_ENDINGS) if (re.test(src)) push(src.replace(re, to));
    if (/ii$/i.test(src)) push(src.replace(/ii$/i, 'iy'));
    push(src.replace(/kh/gi, 'h'));
    // h → kh только между гласными: иначе под замену попадают ch, sh, zh
    push(src.replace(/([aeiou])h([aeiou])/gi, '$1kh$2'));
  }
  return out.slice(0, max);
}

const PATRONYMIC_RE = /(ович|евич|ьич|ич|овна|евна|ична|инична|кызы|оглы)$/i;
const looksPatronymic = (w) => PATRONYMIC_RE.test(w ?? '') && (w ?? '').length > 4;

/** Разбор «Иванов Пётр Сергеевич» на части.
 *
 *  Отчество ищется только когда частей три и больше, и никогда — в первом
 *  слове. Раньше оно искалось в любой позиции при любом числе частей,
 *  и фамилия «Меркулович» становилась отчеством: у «Татьяна Меркулович»
 *  оставалось одно имя, в сервисы поиска почт уходило «Tatyana» без фамилии,
 *  а по такому запросу не находится ничего. Под тот же разбор попадали все
 *  Абрамовичи, Петровичи и Миркевичи.
 *
 *  Позиция отчества заодно говорит и порядок слов: «Фамилия Имя Отчество»
 *  против «Имя Отчество Фамилия». */
export function parseFio(fio) {
  const parts = (fio ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const full = parts.join(' ');

  if (parts.length >= 3) {
    if (looksPatronymic(parts[2])) return { last: parts[0], first: parts[1], patronymic: parts[2], full };
    if (looksPatronymic(parts[1])) return { first: parts[0], patronymic: parts[1], last: parts[2], full };
  }
  // Отчества нет: «Фамилия Имя» либо «Имя Фамилия». Какой из двух — решает
  // SURNAME_RE в personVariants, а обратный порядок уходит в сервисы
  // отдельным вариантом.
  const [last, first] = parts.length >= 2 ? [parts[0], parts[1]] : [parts[0], null];
  return { last: last ?? null, first: first ?? null, patronymic: null, full };
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

/**
 * Шаблоны для подбора почты «вслепую» — в порядке убывания частоты
 * в российском B2B. Порядок важен: каждая проверка стоит кредит
 * валидатора, а берём мы первую подтвердившуюся.
 */
export function guessPatterns(fio) {
  const p = parseFio(fio);
  if (!p?.last) return [];
  const L = translit(p.last), F = translit(p.first ?? ''), M = translit(p.patronymic ?? '');
  const f = F[0] ?? '', m = M[0] ?? '';
  return [...new Set([
    f && `${f}.${L}`, L, F && `${F}.${L}`, f && `${f}${L}`, `${L}.${f}`, F,
    `${L}${f}`, f && `${f}_${L}`, F && `${F}${L}`, m && `${f}.${m}.${L}`,
    m && `${L}.${f}.${m}`,
  ].filter((x) => x && x.length > 1))];
}

/** Похоже на фамилию, а не на имя. Нужно, чтобы различить «Дарья Снедкова»
 *  и «Ильин Евгений»: сервису важно, что из двух слов имя, а что фамилия. */
const SURNAME_RE = new RegExp(
  '(ов|ова|ев|ева|ёв|ёва|ин|ина|ын|ына|ский|ская|цкий|цкая|ич|ук|юк|ко|швили|дзе|ян|енко|ых|их' +
  '|ov|ova|ev|eva|in|ina|sky|skiy|skaya|tsky|ich|enko|shvili|dze|yan)$', 'i');

/**
 * Варианты запроса о человеке для сервисов поиска почт — в порядке
 * убывания вероятности. Первый основной, остальные пробуются, только если
 * сервис ответил «не найдено».
 */
/**
 * ФИО с разобранным порядком слов.
 *
 * parseFio считает первое слово фамилией — так записаны российские выгрузки.
 * Но «Ирина Шамина» и «Дарья Снедкова» записаны наоборот, и по одной строке
 * это не отличить. Смотрим на окончание: «Шамина» похожа на фамилию,
 * «Ирина» — нет, значит порядок «Имя Фамилия».
 *
 * Одно место на весь проект: тем же порядком пользуются и сервисы поиска
 * почт, и склонение имён для писем. Пока эта логика жила только внутри
 * personVariants, обращение в письме получалось по фамилии — «Шамина»
 * вместо «Ирина», и в дательном падеже пустота.
 */
export function orderedFio(fio) {
  const p = parseFio(fio);
  if (!p?.last) return null;
  let { first, last } = p;

  // Одно слово: если это известное имя — значит имя, а не фамилия.
  if (!first) return isFirstName(last)
    ? { first: last, last: null, patronymic: p.patronymic, full: p.full }
    : { first: null, last, patronymic: p.patronymic, full: p.full };

  if (!p.patronymic) {
    // 1. Словарь имён — самый надёжный признак. Окончаний не хватает:
    //    «Ирина» оканчивается на -ина ровно как фамилия «Шамина»,
    //    а «Цыкун» не похож на фамилию ни по одному правилу.
    const a = isFirstName(first), b = isFirstName(last);
    if (b && !a) [first, last] = [last, first];
    // 2. Имени в словаре нет — пробуем по окончанию фамилии.
    else if (!a && !b && SURNAME_RE.test(first) && !SURNAME_RE.test(last)) [first, last] = [last, first];
  }
  return { first: first ?? null, last, patronymic: p.patronymic, full: p.full };
}

export function personVariants(fio, { max = Number(process.env.ENRICH_NAME_VARIANTS ?? 4) } = {}) {
  const p = orderedFio(fio);
  if (!p?.last) return [];
  const { first, last } = p;

  const out = [], seen = new Set();
  const push = (f, l) => {
    const full = [f, l].filter(Boolean).join(' ');
    const k = full.toLowerCase();
    if (l && !seen.has(k)) { seen.add(k); out.push({ first: f || '', last: l, full }); }
  };

  const F = spellingVariants(first ?? ''), L = spellingVariants(last);
  push(F[0], L[0]);
  for (const f of F.slice(1)) push(f, L[0]);
  for (const l of L.slice(1)) push(F[0], l);
  if (!p.patronymic && F[0] && L[0]) push(L[0], F[0]);   // порядок мог быть обратным
  return out.slice(0, Math.max(1, max));
}

/**
 * Связана ли почта с компанией.
 *
 * Чужой домен сам по себе ни о чём не говорит: российские компании
 * сплошь и рядом сидят на mail.ru, держат сайт на .pro, а почту на .ru,
 * или пишутся то «Монтаж», то «montage». Настоящая проблема одна —
 * когда почта принадлежит другому юрлицу: холдингу, дилеру, заводу-соседу.
 * Её и ловим, всё остальное пропускаем без шума.
 */
export function relatedToCompany(email, companyName, companyDomain) {
  const d = domainPart(email);
  if (!d) return true;
  if (companyDomain && (d === companyDomain || d.endsWith('.' + companyDomain) || companyDomain.endsWith('.' + d))) return true;
  if (FREE_MAIL_DOMAINS.has(d)) return true;      // бесплатная почта — не признак чужого юрлица

  // слова из названия компании и из её домена
  const tokens = new Set();
  const add = (w) => { const t = translit(w).replace(/[^a-z0-9]/g, ''); if (t.length >= 3) tokens.add(t); };
  for (const w of (companyName ?? '')
    .replace(/^(ООО|АО|ПАО|ЗАО|ОАО|НПО|НПФ|ТД|ПО)\b/gi, '')
    .split(/[^А-Яа-яЁёA-Za-z0-9]+/)) if (w) add(w);
  for (const part of (companyDomain ?? '').split('.')[0].split(/[-_]/)) if (part) add(part);

  const hay = (d.split('.')[0] + ' ' + localPart(email)).replace(/[^a-z0-9]/g, '');
  for (const t of tokens) {
    const probe = t.length > 6 ? t.slice(0, 6) : t;   // «montazh» ↔ «montage»
    if (probe.length >= 4 && hay.includes(probe)) return true;
  }
  return false;
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

/** Ящики отделов и функций, которые в выгрузке считаются «почтой отдела». */
const DEPARTMENT_EXTRA = [
  'sales', 'sale', 'marketing', 'market', 'pr', 'hr', 'jobs', 'job', 'vacancy',
  'rabota', 'support', 'help', 'service', 'order', 'orders', 'zakaz', 'zakupki',
  'tender', 'tenders', 'billing', 'legal', 'account', 'partners', 'partner',
];

/**
 * Что это за ящик: общий (info@), отдела (marketing@) или именной.
 * Нужно, чтобы пользователь мог решить, какие типы забирать в выгрузку.
 */
export function classifyMailbox(email) {
  const lp = localPart(email).replace(/[._-]/g, '').replace(/\d+$/, '');
  if (!lp) return 'other';
  if (GENERIC_PRIORITY.includes(lp)) return 'generic';
  if (DEPARTMENT_WORDS.includes(lp) || DEPARTMENT_EXTRA.includes(lp)) return 'department';
  return 'other';
}

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
