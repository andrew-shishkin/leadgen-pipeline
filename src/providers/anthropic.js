import Anthropic from '@anthropic-ai/sdk';

// $ за миллион токенов. Sonnet 5 до 31.08.2026 идёт по интро-цене $2/$10.
const PRICING = {
  'claude-opus-5':    { in: 5, out: 25 },
  'claude-sonnet-5':  { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

export const name = 'anthropic';
export const defaultModel = 'claude-sonnet-5';
export const keyEnv = 'ANTHROPIC_API_KEY';
export const consoleUrl = 'console.anthropic.com';

/** Это имя модели наше? Нужно, чтобы QUALIFY_MODEL от другого провайдера
 *  не уходил в наш API — см. modelFor в src/llm.js. */
export const owns = (m) => /^claude/i.test(String(m));

export function price(model, { tokens_in = 0, tokens_out = 0, cache_read = 0, batch = false }) {
  // API иногда возвращает датированный снимок модели (claude-haiku-4-5-20251001)
  // вместо алиаса, которым её запросили. Без этой строки такой ответ молча
  // попадал в ветку ?? и тарифицировался по цене Sonnet — дороже, чем на самом деле.
  const key = PRICING[model] ? model : model.replace(/-\d{8}$/, '');
  const p = PRICING[key] ?? PRICING['claude-sonnet-5'];
  const usd = (tokens_in * p.in + tokens_out * p.out + cache_read * p.in * 0.1) / 1e6;
  return batch ? usd / 2 : usd;
}

export function makeClient(apiKey) {
  return new Anthropic({ apiKey, maxRetries: 6 });
}

export function validateKey(k) {
  return !!k && k.startsWith('sk-ant-') && !k.includes('...');
}

const params = (model, system, user, schema, maxTokens) => ({
  model,
  max_tokens: maxTokens,
  system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: user }],
  output_config: { format: { type: 'json_schema', schema } },
});

function parse(msg) {
  if (msg.stop_reason === 'refusal') return { ok: false, error: 'refusal' };
  const text = msg.content.find((b) => b.type === 'text')?.text ?? '';
  if (!text) return { ok: false, error: msg.stop_reason === 'max_tokens' ? 'обрезано по max_tokens' : 'пустой ответ' };
  try { return { ok: true, data: JSON.parse(text) }; }
  catch { return { ok: false, error: 'некорректный JSON' }; }
}

const usageOf = (u = {}) => ({
  tokens_in: u.input_tokens ?? 0,
  tokens_out: u.output_tokens ?? 0,
  cache_read: u.cache_read_input_tokens ?? 0,
});

export async function ask(client, { model, system, user, schema, maxTokens = 2000 }) {
  const msg = await client.messages.create(params(model, system, user, schema, maxTokens));
  return { ...parse(msg), usage: usageOf(msg.usage) };
}

/** Отправить пачку. Возвращает id — по нему результаты можно забрать позже. */
export async function batchSubmit(client, { model, system, schema, requests, maxTokens = 2000 }) {
  const b = await client.messages.batches.create({
    requests: requests.map((r) => ({ custom_id: r.id, params: params(model, system, r.user, schema, maxTokens) })),
  });
  return b.id;
}

export async function batchStatus(client, id) {
  const b = await client.messages.batches.retrieve(id);
  const c = b.request_counts ?? {};
  return {
    done: b.processing_status === 'ended',
    succeeded: c.succeeded ?? 0,
    processing: c.processing ?? 0,
    errored: c.errored ?? 0,
  };
}

export async function batchResults(client, id) {
  const out = new Map();
  for await (const item of await client.messages.batches.results(id)) {
    if (item.result.type !== 'succeeded') { out.set(item.custom_id, { ok: false, error: item.result.type }); continue; }
    const msg = item.result.message;
    out.set(item.custom_id, { ...parse(msg), usage: usageOf(msg.usage) });
  }
  return out;
}
