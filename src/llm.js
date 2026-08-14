// Диспетчер провайдеров. Вызывающий код не знает, Anthropic это или OpenAI.
// Провайдер выбирается в .env: LLM_PROVIDER=anthropic|openai

import { logUsage, j, unj } from './db.js';
import * as anthropic from './providers/anthropic.js';
import * as openai from './providers/openai.js';

const PROVIDERS = { anthropic, openai };

export function getProvider() {
  const key = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  const p = PROVIDERS[key];
  if (!p) throw new Error(`Неизвестный LLM_PROVIDER="${key}". Допустимо: anthropic, openai`);
  return p;
}

export const modelName = () => process.env.QUALIFY_MODEL || getProvider().defaultModel;
export const priceOf = (model, u) => getProvider().price(model, u);

export function makeClient() {
  const p = getProvider();
  const apiKey = process.env[p.keyEnv];
  if (!p.validateKey(apiKey)) {
    throw new Error(
      `\n  Не найден ключ доступа к нейросети (провайдер: ${p.name}).\n` +
      `  1. Скопируйте шаблон:  cp .env.example .env\n` +
      `  2. Откройте файл .env в любом редакторе\n` +
      `  3. Вставьте ключ из ${p.consoleUrl} в строку ${p.keyEnv}=\n\n` +
      `  Ключ вставляется в файл, а не в переписку с Клодом или Codex:\n` +
      `  всё, что попадает в чат, остаётся в истории.\n`);
  }
  return p.makeClient(apiKey);
}

function record(db, { stage, model, companyId, usage, batch }) {
  const p = getProvider();
  logUsage(db, {
    stage, provider: p.name, model, company_id: companyId, ...usage,
    usd: p.price(model, { ...usage, batch }),
  });
}

/** Один синхронный вызов со структурированным ответом. */
export async function askJson(client, db, { stage, model, system, user, schema, companyId, maxTokens = 2000 }) {
  const p = getProvider();
  const r = await p.ask(client, { model, system, user, schema, maxTokens });
  record(db, { stage, model, companyId, usage: r.usage, batch: false });
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
}

// ─────────────────────────── Пакетный режим ───────────────────────────
// Пачка обрабатывается на стороне провайдера. Ноутбук можно закрыть:
// результаты хранятся и забираются следующим запуском.

export async function batchSubmit(client, db, { stage, model, system, schema, requests, maxTokens = 2000 }) {
  const p = getProvider();
  const id = await p.batchSubmit(client, { model, system, schema, requests, maxTokens });
  db.prepare(`INSERT INTO batches (id, stage, provider, model, n, ids) VALUES (?,?,?,?,?,?)`)
    .run(id, stage, p.name, model, requests.length, j(requests.map((r) => r.id)));
  return id;
}

export const pendingBatch = (db, stage) =>
  db.prepare(`SELECT * FROM batches WHERE stage=? AND status='submitted' ORDER BY created_at DESC LIMIT 1`).get(stage);

export const batchStatus = (client, id) => getProvider().batchStatus(client, id);

export async function batchCollect(client, db, { id, stage, model }) {
  const p = getProvider();
  const res = await p.batchResults(client, id);
  for (const [, r] of res) if (r.usage) record(db, { stage, model, companyId: null, usage: r.usage, batch: true });
  db.prepare(`UPDATE batches SET status='collected' WHERE id=?`).run(id);
  return res;
}

/** Ждать пачку в этом же запуске (для тех, кто готов не закрывать ноутбук). */
export async function batchWait(client, db, { id, stage, model, onProgress }) {
  for (;;) {
    const st = await batchStatus(client, id);
    onProgress?.(st);
    if (st.done) break;
    await new Promise((r) => setTimeout(r, 20000));
  }
  return batchCollect(client, db, { id, stage, model });
}

export { unj };
