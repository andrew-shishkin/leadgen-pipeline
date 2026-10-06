// Адаптер DeepSeek. Интерфейс тот же, что у anthropic.js и openai.js —
// вызывающий код о различиях не знает.
//
// Главное отличие от двух других провайдеров: DeepSeek умеет только
// response_format: {type: "json_object"} — «ответь каким-нибудь JSON».
// Схему ответа он не принимает и ничего не гарантирует. Поэтому схема
// описывается словами в системном промпте, а ответ проверяется здесь же,
// в коде: без этой проверки дальше по конвейеру поедут объекты без нужных
// полей, и ломаться будет далеко от места настоящей ошибки.
//
// Протокол OpenAI-совместимый, поэтому берём тот же SDK и только меняем
// адрес. Отдельный файл, а не ветка внутри openai.js: различий достаточно
// (JSON, max_tokens, цены по времени суток), и мешать их в одном адаптере
// значит ломать оба сразу при следующей правке.

import OpenAI from 'openai';

export const name = 'deepseek';
export const defaultModel = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
export const keyEnv = 'DEEPSEEK_API_KEY';
export const consoleUrl = 'platform.deepseek.com';
export const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

export const owns = (m) => /^deepseek/i.test(String(m));

// ─────────────────────────── Цены ───────────────────────────
// $ за миллион токенов. У DeepSeek цена зависит от времени суток:
// в часы пик дороже вдвое. Считаем по UTC на момент вызова.
// Китайские праздники (в них действует льготный тариф) не учитываем —
// календаря у нас нет, и ошибка здесь в сторону завышения, а не занижения.
const PRICING = {
  'deepseek-flash':  { in: 0.15, out: 0.60, cache: 0.003 },
  'deepseek-v4-pro': { in: 0.66, out: 1.98, cache: 0.022 },
};

/** Часы пик: 01:00-04:00 и 06:00-10:00 UTC, пн-пт. В них тариф вдвое выше. */
export function isPeak(d = new Date()) {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export function price(model, { tokens_in = 0, tokens_out = 0, cache_read = 0, batch = false }) {
  const p = PRICING[model] ?? PRICING['deepseek-flash'];
  const k = isPeak() ? 2 : 1;
  const usd = (tokens_in * p.in * k + tokens_out * p.out * k + cache_read * p.cache * k) / 1e6;
  // пакетного режима у DeepSeek нет, скидку не применяем
  return batch ? usd : usd;
}

export function makeClient(apiKey) {
  return new OpenAI({ apiKey, baseURL, maxRetries: 6 });
}

export function validateKey(k) {
  return !!k && k.startsWith('sk-') && !k.includes('...');
}

// ─────────────────── Схема: в промпт и обратно в проверку ───────────────────

/** Человекочитаемое описание схемы — его модель увидит в системном промпте. */
function describe(schema, indent = '') {
  if (!schema || typeof schema !== 'object') return '';
  if (schema.type === 'object') {
    const req = new Set(schema.required ?? []);
    return Object.entries(schema.properties ?? {})
      .map(([k, v]) => {
        const mark = req.has(k) ? ' (обязательное)' : '';
        if (v.type === 'array') return `${indent}"${k}": массив${mark}, каждый элемент:\n${describe(v.items, indent + '  ')}`;
        if (v.type === 'object') return `${indent}"${k}": объект${mark}:\n${describe(v, indent + '  ')}`;
        const enums = v.enum ? ` — одно из: ${v.enum.join(', ')}` : '';
        return `${indent}"${k}": ${v.type}${mark}${enums}`;
      }).join('\n');
  }
  return `${indent}${schema.type ?? ''}`;
}

/** Проверка ответа по той же схеме. Возвращает список несоответствий. */
function violations(data, schema, path = '') {
  const out = [];
  if (!schema || typeof schema !== 'object') return out;
  const at = path || 'корень';

  if (schema.type === 'object') {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return [`${at}: ожидался объект`];
    for (const k of schema.required ?? []) {
      if (!(k in data)) out.push(`${at}: нет обязательного поля "${k}"`);
    }
    for (const [k, v] of Object.entries(schema.properties ?? {})) {
      if (k in data) out.push(...violations(data[k], v, path ? `${path}.${k}` : k));
    }
    return out;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(data)) return [`${at}: ожидался массив`];
    data.forEach((item, i) => out.push(...violations(item, schema.items, `${at}[${i}]`)));
    return out;
  }
  const t = schema.type;
  if (t === 'string' && typeof data !== 'string') out.push(`${at}: ожидалась строка`);
  if (t === 'integer' && !Number.isInteger(data)) out.push(`${at}: ожидалось целое число`);
  if (t === 'number' && typeof data !== 'number') out.push(`${at}: ожидалось число`);
  if (t === 'boolean' && typeof data !== 'boolean') out.push(`${at}: ожидалось true или false`);
  if (schema.enum && !schema.enum.includes(data)) out.push(`${at}: значение "${data}" не из списка ${schema.enum.join(', ')}`);
  return out;
}

const withSchema = (system, schema) =>
  `${system}\n\n` +
  'ФОРМАТ ОТВЕТА. Верни один объект JSON и ничего кроме него — ' +
  'без пояснений до или после, без markdown-ограждения.\n' +
  'Поля (лишних не добавляй, обязательные пропускать нельзя):\n' +
  describe(schema);

const body = (model, system, user, schema, maxTokens) => ({
  model,
  // у DeepSeek параметр называется max_tokens, max_completion_tokens он не знает
  max_tokens: maxTokens,
  messages: [
    { role: 'system', content: withSchema(system, schema) },
    { role: 'user', content: user },
  ],
  response_format: { type: 'json_object' },
});

function parse(choice, schema) {
  if (choice?.finish_reason === 'content_filter') return { ok: false, error: 'отказ модели' };
  let text = choice?.message?.content ?? '';
  if (!text) return { ok: false, error: choice?.finish_reason === 'length' ? 'обрезано по лимиту токенов' : 'пустой ответ' };

  // json_object не гарантирует чистый JSON: модель иногда оборачивает ответ
  // в ```json. Снимаем ограждение, прежде чем разбирать.
  text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();

  let data;
  try { data = JSON.parse(text); }
  catch { return { ok: false, error: 'некорректный JSON' }; }

  const bad = violations(data, schema);
  if (bad.length) return { ok: false, error: `ответ не по схеме — ${bad.slice(0, 3).join('; ')}` };
  return { ok: true, data };
}

const usageOf = (u = {}) => ({
  // кэш у DeepSeek считается отдельными полями; попадание в кэш дешевле в 50 раз
  tokens_in: (u.prompt_tokens ?? 0) - (u.prompt_cache_hit_tokens ?? 0),
  tokens_out: u.completion_tokens ?? 0,
  cache_read: u.prompt_cache_hit_tokens ?? 0,
});

export async function ask(client, { model, system, user, schema, maxTokens = 2000 }) {
  const res = await client.chat.completions.create(body(model, system, user, schema, maxTokens));
  return { ...parse(res.choices?.[0], schema), usage: usageOf(res.usage) };
}

// ─────────────────────────── Пакетный режим ───────────────────────────
// У DeepSeek его нет. Ошибку бросаем внятную: иначе пользователь выберет
// «вдвое дешевле» и упрётся в невразумительный сбой посреди прогона.

const NO_BATCH = () => {
  throw new Error(
    '\n  Пакетный режим у DeepSeek не поддерживается.\n' +
    '  Запустите обычный режим: node run.js qualify --now\n' +
    '  Скидки за пакет не будет, но цена DeepSeek и так в разы ниже.\n');
};

export const supportsBatch = false;
export async function batchSubmit() { NO_BATCH(); }
export async function batchStatus() { NO_BATCH(); }
export async function batchResults() { NO_BATCH(); }
