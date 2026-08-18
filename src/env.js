// Загрузка .env — без зависимостей.
//
// Почему это отдельный модуль, а не десять строк в начале run.js.
// В ES-модулях все import выполняются раньше любого кода файла. Пока .env
// читался в теле run.js, модули успевали проинициализироваться до него,
// и всё, что они берут из process.env на верхнем уровне, получало undefined:
// OPENAI_MODEL, цены OpenAI, TITLE_QUERIES, SEARCH_PAGES, BUILTIN_MAX_QUERIES,
// WEB_SEARCH_UNIT_USD, KEEP_PERSONAL_EMAILS. Настройка в файле стояла,
// а скрипт работал по значениям по умолчанию и молчал об этом.
//
// Поэтому run.js импортирует этот модуль ПЕРВОЙ строкой: импорты выполняются
// по порядку, значит .env окажется в process.env раньше всех остальных.

import fs from 'node:fs';

/** Строки с ключом, закомментированные знаком #. Самая частая ошибка при
 *  настройке: сервис молча не подключается, и это никак не проявляется. */
export const commentedOut = [];

if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    // переменная окружения важнее файла: так работают все команды с VAR=x перед вызовом
    if (m) { if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); continue; }
    const c = line.match(/^\s*#\s*([A-Z0-9_]*(?:KEY|TOKEN|ID|PROVIDER)[A-Z0-9_]*)\s*=\s*(\S.+)$/);
    if (c && !/^#/.test(c[2])) commentedOut.push(c[1]);
  }
}
