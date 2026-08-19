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

const warned = new Set();

/** Имя модели из .env — но только если оно принадлежит текущему провайдеру.
 *
 *  QUALIFY_MODEL и CHEAP_MODEL остаются в .env при переключении LLM_PROVIDER,
 *  и имя модели одного провайдера уходило в API другого: при
 *  LLM_PROVIDER=openai запрос уезжал с моделью claude-sonnet-5 и падал
 *  с «404 The model does not exist». Пользователь меняет одну строку
 *  и получает ошибку, из которой причина не видна, — поэтому не только
 *  подставляем правильную модель, но и говорим об этом вслух. */
export function modelFor(envName, fallback) {
  const p = getProvider();
  const set = (process.env[envName] || '').trim();
  if (!set) return fallback ?? p.defaultModel;
  if (p.owns(set)) return set;
  if (!warned.has(envName)) {
    warned.add(envName);
    process.stderr.write(
      `\n  ⚠️  В .env ${envName}=${set} — это модель другого провайдера, ` +
      `а сейчас выбран ${p.name}.\n      Использую ${fallback ?? p.defaultModel}. ` +
      `Уберите строку ${envName} или впишите модель ${p.name}.\n\n`);
  }
  return fallback ?? p.defaultModel;
}

export const modelName = () => modelFor('QUALIFY_MODEL');
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

/** Модель недоступна аккаунту: дальше все вызовы упадут так же.
 *
 *  Отдельный случай, потому что выглядит он безобидно. Прогон идёт, строки
 *  бегут, в конце ноль результатов и ноль расходов — а причина одна и та же
 *  ошибка на каждой строке. Ловим её один раз, объясняем и перестаём ходить
 *  в API: молчаливый прогон вхолостую дороже остановки. */
let unavailable = null;
export const modelUnavailable = () => unavailable;

const isUnavailable = (e) => {
  const m = String(e?.message ?? '');
  return e?.status === 404 && /does not exist|must be verified|model_not_found/i.test(m);
};

/** Один синхронный вызов со структурированным ответом. */
export async function askJson(client, db, { stage, model, system, user, schema, companyId, maxTokens = 2000 }) {
  if (unavailable) return { ok: false, error: unavailable.short };
  const p = getProvider();
  let r;
  try {
    r = await p.ask(client, { model, system, user, schema, maxTokens });
  } catch (e) {
    if (!isUnavailable(e)) throw e;
    const verify = /must be verified/i.test(String(e.message));
    unavailable = { model, short: `модель ${model} недоступна аккаунту` };
    process.stderr.write(
      `\n\n  ⛔  Модель ${model} недоступна вашему аккаунту ${p.name}.\n`
    + (verify
        ? '      Аккаунт не верифицирован для этой модели. Верификация разовая\n'
        + '      и бесплатная: platform.openai.com/settings/organization/general,\n'
        + '      кнопка Verify Organization.\n'
        : `      ${String(e.message).slice(0, 160)}\n`)
    + '      Либо укажите другую модель в .env и перезапустите этап.\n'
    + '      Дальнейшие вызовы прекращены, чтобы не гонять прогон вхолостую.\n\n');
    return { ok: false, error: unavailable.short };
  }
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
