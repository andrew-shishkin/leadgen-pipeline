// Общее для провайдеров, которые работают через подписку: вместо ключа API
// скрипт запускает установленный CLI агента (claude или codex) в режиме
// «один вопрос — один ответ». Авторизация та же, что у вас в терминале.

import { spawn, spawnSync } from 'node:child_process';

/** CLI установлен и запускается? */
export function installed(bin) {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

/** Запустить CLI, передать текст в stdin, вернуть stdout. */
export function run(bin, args, input, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} завершился с кодом ${code}: ${(err || out).trim().slice(-400)}`));
    });
    p.stdin.end(input);
  });
}

/** Пакетного API у подписки нет — пакетный режим просто не предлагаем. */
export const noBatch = true;
const unsupported = async () => {
  throw new Error('Пакетный режим работает только с ключом API (anthropic или openai). На подписке запускайте с --now.');
};
export const batchSubmit = unsupported;
export const batchStatus = unsupported;
export const batchResults = unsupported;

/** Подписка оплачена заранее: в отчёте расходов вызовы стоят $0,
 *  токены при этом пишутся — видно, сколько лимита ушло. */
export const price = () => 0;
