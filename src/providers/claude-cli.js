// Провайдер для тех, у кого подписка Claude (Pro/Max), а ключа API нет.
// Каждый вызов — `claude -p` без инструментов и со схемой ответа.
// Нужен Claude Code, в котором выполнен вход: claude, затем /login.
//
// Расходует лимиты подписки. Учитывайте их при больших прогонах
// и правила использования подписки Anthropic.

import { installed, run, noBatch, batchSubmit, batchStatus, batchResults, price } from './cli.js';

export { noBatch, batchSubmit, batchStatus, batchResults, price };

const BIN = process.env.CLAUDE_BIN || 'claude';

export const name = 'claude-cli';
export const defaultModel = 'claude-sonnet-5';
export const keyEnv = null;
export const consoleUrl = 'подписки Claude (claude → /login)';
export const owns = (m) => /^(claude|sonnet|haiku|opus)/i.test(String(m));

export const validateKey = () => installed(BIN);
export const makeClient = () => ({});

export async function ask(_client, { model, system, user, schema }) {
  const out = await run(BIN, [
    '-p', '--output-format', 'json',
    '--model', model,
    '--tools', '',
    '--no-session-persistence',
    '--strict-mcp-config',   // без MCP-серверов из настроек пользователя: только ответ по схеме
    '--system-prompt', system,
    '--json-schema', JSON.stringify(schema),
  ], user);

  let res;
  try { res = JSON.parse(out); } catch { return { ok: false, error: 'некорректный ответ CLI', usage: {} }; }
  const u = res.usage ?? {};
  const usage = {
    tokens_in: u.input_tokens ?? 0,
    tokens_out: u.output_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0,
  };
  if (res.is_error) throw new Error(`claude: ${String(res.result ?? 'ошибка').slice(0, 300)}`);
  if (res.structured_output) return { ok: true, data: res.structured_output, usage };
  try { return { ok: true, data: JSON.parse(res.result), usage }; }
  catch { return { ok: false, error: 'некорректный JSON', usage }; }
}
