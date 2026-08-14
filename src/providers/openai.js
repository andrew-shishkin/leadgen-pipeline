// Адаптер для тех, у кого подписка OpenAI (Codex) и уже есть ключ там.
// Интерфейс тот же, что у anthropic.js — вызывающий код о различиях не знает.
//
// ВАЖНО: имя модели и цены задаются в .env, потому что и то и другое у OpenAI
// меняется чаще, чем выходит этот шаблон. Значения по умолчанию — ориентир,
// сверьтесь с platform.openai.com/docs/pricing перед большим прогоном.

import OpenAI from 'openai';

export const name = 'openai';
export const defaultModel = process.env.OPENAI_MODEL || 'gpt-5';
export const keyEnv = 'OPENAI_API_KEY';
export const consoleUrl = 'platform.openai.com';

// $ за миллион токенов; переопределяется через OPENAI_PRICE_IN / OPENAI_PRICE_OUT
const PRICE_IN = Number(process.env.OPENAI_PRICE_IN ?? 1.25);
const PRICE_OUT = Number(process.env.OPENAI_PRICE_OUT ?? 10);

export function price(model, { tokens_in = 0, tokens_out = 0, cache_read = 0, batch = false }) {
  const usd = (tokens_in * PRICE_IN + tokens_out * PRICE_OUT + cache_read * PRICE_IN * 0.1) / 1e6;
  return batch ? usd / 2 : usd;   // Batch API у OpenAI тоже даёт −50%
}

export function makeClient(apiKey) {
  return new OpenAI({ apiKey, maxRetries: 6 });
}

export function validateKey(k) {
  return !!k && k.startsWith('sk-') && !k.includes('...');
}

const body = (model, system, user, schema, maxTokens) => ({
  model,
  max_completion_tokens: maxTokens,
  messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'result', strict: true, schema },
  },
});

function parse(choice) {
  if (choice?.finish_reason === 'content_filter') return { ok: false, error: 'refusal' };
  const text = choice?.message?.content ?? '';
  if (choice?.message?.refusal) return { ok: false, error: 'refusal' };
  if (!text) return { ok: false, error: choice?.finish_reason === 'length' ? 'обрезано по лимиту токенов' : 'пустой ответ' };
  try { return { ok: true, data: JSON.parse(text) }; }
  catch { return { ok: false, error: 'некорректный JSON' }; }
}

const usageOf = (u = {}) => ({
  tokens_in: (u.prompt_tokens ?? 0) - (u.prompt_tokens_details?.cached_tokens ?? 0),
  tokens_out: u.completion_tokens ?? 0,
  cache_read: u.prompt_tokens_details?.cached_tokens ?? 0,
});

export async function ask(client, { model, system, user, schema, maxTokens = 2000 }) {
  const res = await client.chat.completions.create(body(model, system, user, schema, maxTokens));
  return { ...parse(res.choices?.[0]), usage: usageOf(res.usage) };
}

/** У OpenAI пачка — это загруженный JSONL-файл, а не массив в теле запроса. */
export async function batchSubmit(client, { model, system, schema, requests, maxTokens = 2000 }) {
  const jsonl = requests.map((r) => JSON.stringify({
    custom_id: r.id, method: 'POST', url: '/v1/chat/completions',
    body: body(model, system, r.user, schema, maxTokens),
  })).join('\n');

  const file = await client.files.create({
    file: new File([jsonl], 'batch.jsonl', { type: 'application/jsonl' }),
    purpose: 'batch',
  });
  const b = await client.batches.create({
    input_file_id: file.id,
    endpoint: '/v1/chat/completions',
    completion_window: '24h',
  });
  return b.id;
}

export async function batchStatus(client, id) {
  const b = await client.batches.retrieve(id);
  const c = b.request_counts ?? {};
  return {
    done: ['completed', 'failed', 'expired', 'cancelled'].includes(b.status),
    succeeded: (c.completed ?? 0) - (c.failed ?? 0),
    processing: (c.total ?? 0) - (c.completed ?? 0),
    errored: c.failed ?? 0,
  };
}

export async function batchResults(client, id) {
  const b = await client.batches.retrieve(id);
  const out = new Map();
  if (!b.output_file_id) return out;
  const text = await (await client.files.content(b.output_file_id)).text();
  for (const line of text.split('\n').filter(Boolean)) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.error || row.response?.status_code !== 200) { out.set(row.custom_id, { ok: false, error: 'errored' }); continue; }
    const r = row.response.body;
    out.set(row.custom_id, { ...parse(r.choices?.[0]), usage: usageOf(r.usage) });
  }
  return out;
}
