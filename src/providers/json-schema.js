// Схема ответа для провайдеров, которые её не гарантируют.
//
// Anthropic и OpenAI принимают JSON Schema и обещают, что ответ ей
// соответствует. DeepSeek и часть моделей в OpenRouter такого не умеют —
// там максимум «ответь каким-нибудь JSON». Для них схема разворачивается
// в текстовое описание для промпта, а ответ проверяется здесь же.
//
// Проверка нужна и тем провайдерам, которые схему принимают: гарантия
// есть не у всех моделей, а объект без обязательного поля ломается далеко
// от места настоящей ошибки — в конвейере, через два этапа.

/** Человекочитаемое описание схемы — его модель увидит в системном промпте. */
export function describe(schema, indent = '') {
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

/** Несоответствия ответа схеме. Пустой массив — всё в порядке. */
export function violations(data, schema, path = '') {
  const out = [];
  if (!schema || typeof schema !== 'object') return out;
  const at = path || 'корень';

  if (schema.type === 'object') {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return [`${at}: ожидался объект`];
    for (const k of schema.required ?? []) if (!(k in data)) out.push(`${at}: нет обязательного поля "${k}"`);
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

/** Системный промпт с описанием формата — для провайдеров без строгой схемы. */
export const withSchema = (system, schema) =>
  `${system}\n\n` +
  'ФОРМАТ ОТВЕТА. Верни один объект JSON и ничего кроме него — ' +
  'без пояснений до или после, без markdown-ограждения.\n' +
  'Поля (лишних не добавляй, обязательные пропускать нельзя):\n' +
  describe(schema);

/** Разбор текста ответа с проверкой по схеме. */
export function parseChecked(text, schema) {
  if (!text) return { ok: false, error: 'пустой ответ' };
  // модель иногда оборачивает ответ в ```json — снимаем ограждение
  const clean = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let data;
  try { data = JSON.parse(clean); }
  catch { return { ok: false, error: 'некорректный JSON' }; }
  const bad = violations(data, schema);
  if (bad.length) return { ok: false, error: `ответ не по схеме — ${bad.slice(0, 3).join('; ')}` };
  return { ok: true, data };
}
