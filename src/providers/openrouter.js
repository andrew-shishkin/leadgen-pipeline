// Адаптер OpenRouter — один ключ на 460+ моделей: Gemini, Claude, GPT,
// DeepSeek, Llama и остальные. Нужен, когда модель хочется выбирать
// строкой в .env, не заводя аккаунт у каждого поставщика.
//
// Протокол OpenAI-совместимый, поэтому тот же SDK с другим адресом.
// Отличия, из-за которых это отдельный файл:
//
//   1. Имя модели всегда с поставщиком через косую черту:
//      google/gemini-2.5-pro, anthropic/claude-sonnet-4.5. По этому
//      признаку и отличаем свои модели от чужих.
//   2. Цены не зашиты в код: у каждой из 460 моделей своя, и поддерживать
//      такую таблицу вручную невозможно. Берём их из каталога самого
//      OpenRouter — он отдаёт цену за токен по каждой модели.
//   3. Строгую схему ответа поддерживают не все модели (на момент
//      написания 380 из 464). Пробуем строгую, а если модель её не примет —
//      переходим на описание схемы словами и проверку в коде, и запоминаем
//      это на остаток прогона, чтобы не платить за отказ повторно.

import OpenAI from 'openai';
import { withSchema, parseChecked } from './json-schema.js';

export const name = 'openrouter';
export const defaultModel = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
export const keyEnv = 'OPENROUTER_API_KEY';
export const consoleUrl = 'openrouter.ai/keys';
export const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
export const supportsBatch = false;

/** Модели OpenRouter всегда пишутся как «поставщик/модель». */
export const owns = (m) => /^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(String(m ?? ''));

export function validateKey(k) {
  return !!k && k.startsWith('sk-') && !k.includes('...');
}

export function makeClient(apiKey) {
  return new OpenAI({
    apiKey, baseURL, maxRetries: 6,
    // OpenRouter просит эти заголовки для статистики по приложениям;
    // они необязательные и никакой информации о пользователе не несут
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/andrew-shishkin/leadgen-pipeline',
      'X-Title': 'leadgen-pipeline',
    },
  });
}

// ─────────────────────────── Цены из каталога ───────────────────────────
// $ за миллион токенов. Каталог тянем один раз за прогон и держим в памяти.

let PRICES = null;
let priceWarned = false;

async function loadPrices() {
  if (PRICES) return PRICES;
  try {
    const r = await fetch(`${baseURL}/models`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    PRICES = {};
    for (const m of j.data ?? []) {
      PRICES[m.id] = {
        in: Number(m.pricing?.prompt ?? 0) * 1e6,
        out: Number(m.pricing?.completion ?? 0) * 1e6,
      };
    }
  } catch (e) {
    // Без каталога расход покажется нулевым. Молчать нельзя: пользователь
    // решит, что прогон бесплатный, и узнает правду только из счёта.
    PRICES = {};
    if (!priceWarned) {
      priceWarned = true;
      process.stderr.write(
        `\n  ⚠️  Не удалось получить цены OpenRouter (${e.message}).\n` +
        '      Расход в отчёте будет показан нулевым — смотрите его\n' +
        '      на openrouter.ai/activity.\n\n');
    }
  }
  return PRICES;
}

export function price(model, { tokens_in = 0, tokens_out = 0, cache_read = 0 }) {
  const p = PRICES?.[model];
  if (!p) return 0;
  // кэш у разных поставщиков считается по-разному; берём по цене входа,
  // это завышает оценку, а не занижает
  return (tokens_in * p.in + tokens_out * p.out + cache_read * p.in) / 1e6;
}

// ───────────────────────────── Запросы ─────────────────────────────

/** Модели, которые отказались от строгой схемы — на остаток прогона. */
const looseJson = new Set();

const strictBody = (model, system, user, schema, maxTokens) => ({
  model, max_tokens: maxTokens,
  messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } },
});

const looseBody = (model, system, user, schema, maxTokens) => ({
  model, max_tokens: maxTokens,
  messages: [{ role: 'system', content: withSchema(system, schema) }, { role: 'user', content: user }],
  response_format: { type: 'json_object' },
});

const usageOf = (u = {}) => ({
  tokens_in: (u.prompt_tokens ?? 0) - (u.prompt_tokens_details?.cached_tokens ?? 0),
  tokens_out: u.completion_tokens ?? 0,
  cache_read: u.prompt_tokens_details?.cached_tokens ?? 0,
});

function parse(choice, schema) {
  if (choice?.finish_reason === 'content_filter') return { ok: false, error: 'отказ модели' };
  const text = choice?.message?.content ?? '';
  if (!text) return { ok: false, error: choice?.finish_reason === 'length' ? 'обрезано по лимиту токенов' : 'пустой ответ' };
  // проверяем по схеме в любом случае: строгий режим гарантирует её не везде
  return parseChecked(text, schema);
}

/** Ошибка именно про формат ответа, а не про что-то другое. */
const isFormatRefusal = (e) => {
  const m = `${e?.status ?? ''} ${e?.message ?? ''}`.toLowerCase();
  return (e?.status === 400 || e?.status === 404 || e?.status === 422)
    && /response_format|json_schema|structured|schema/.test(m);
};

export async function ask(client, { model, system, user, schema, maxTokens = 2000 }) {
  await loadPrices();
  const loose = looseJson.has(model) || (process.env.OPENROUTER_STRICT_JSON ?? 'true') === 'false';
  const build = loose ? looseBody : strictBody;
  try {
    const res = await client.chat.completions.create(build(model, system, user, schema, maxTokens));
    return { ...parse(res.choices?.[0], schema), usage: usageOf(res.usage) };
  } catch (e) {
    if (loose || !isFormatRefusal(e)) throw e;
    // модель не умеет строгую схему — повторяем с описанием словами
    looseJson.add(model);
    process.stderr.write(
      `\n  Модель ${model} не принимает строгую схему ответа.\n` +
      '  Перехожу на описание формата в промпте с проверкой в коде.\n\n');
    const res = await client.chat.completions.create(looseBody(model, system, user, schema, maxTokens));
    return { ...parse(res.choices?.[0], schema), usage: usageOf(res.usage) };
  }
}

// ─────────────────────────── Пакетный режим ───────────────────────────

const NO_BATCH = () => {
  throw new Error(
    '\n  Пакетный режим через OpenRouter не поддерживается.\n' +
    '  Запустите обычный: node run.js qualify --now\n');
};
export async function batchSubmit() { NO_BATCH(); }
export async function batchStatus() { NO_BATCH(); }
export async function batchResults() { NO_BATCH(); }
