// Провайдер для тех, у кого подписка ChatGPT (Plus/Pro) с Codex, а ключа API нет.
// Каждый вызов — `codex exec` в режиме только чтения со схемой ответа.
// Нужен Codex CLI, в котором выполнен вход: codex login.
//
// Расходует лимиты подписки. Учитывайте их при больших прогонах.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installed, run, noBatch, batchSubmit, batchStatus, batchResults, price } from './cli.js';

export { noBatch, batchSubmit, batchStatus, batchResults, price };

const BIN = process.env.CODEX_BIN || 'codex';

export const name = 'codex-cli';
// «default» — модель из настроек Codex (~/.codex/config.toml)
export const defaultModel = process.env.CODEX_MODEL || 'default';
export const keyEnv = null;
export const consoleUrl = 'подписки ChatGPT (codex login)';
export const owns = (m) => /^(default|gpt|o[1-9]|codex)/i.test(String(m));

export const validateKey = () => installed(BIN);
export const makeClient = () => ({});

export async function ask(_client, { model, system, user, schema }) {
  // у codex exec нет отдельного системного промпта и схема передаётся файлом
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leadgen-codex-'));
  const schemaFile = path.join(dir, 'schema.json');
  const outFile = path.join(dir, 'out.txt');
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  try {
    await run(BIN, [
      'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only',
      ...(model && model !== 'default' ? ['-m', model] : []),
      '--output-schema', schemaFile, '-o', outFile, '-',
    ], `${system}\n\n---\n\n${user}`);
    const text = fs.readFileSync(outFile, 'utf8').trim();
    if (!text) return { ok: false, error: 'пустой ответ', usage: {} };
    try { return { ok: true, data: JSON.parse(text), usage: {} }; }
    catch { return { ok: false, error: 'некорректный JSON', usage: {} }; }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
