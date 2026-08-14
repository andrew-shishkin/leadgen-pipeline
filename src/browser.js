// Playwright — третья ступень каскада загрузки, для сайтов на JS.
// Ставится отдельно и только тем, кому нужен: браузер весит ~300 МБ.
//   npm install playwright && npx playwright install chromium
// Если не установлен, пайплайн работает без него — просто такие сайты
// останутся в статусе «под вопросом».

let chromium = null;
let state = 'unknown';   // unknown | ready | absent

export async function browserAvailable() {
  if (state !== 'unknown') return state === 'ready';
  try {
    ({ chromium } = await import('playwright'));
    state = 'ready';
  } catch {
    state = 'absent';
  }
  return state === 'ready';
}

export const installHint =
  '  Браузерный режим не установлен. Он нужен сайтам, которые не отдают\n' +
  '  текст без JavaScript. Установка (около 300 МБ, один раз):\n\n' +
  '    npm install playwright && npx playwright install chromium\n';

let browser = null;

async function getBrowser() {
  if (!browser) browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
  return browser;
}

/** Открыть страницу настоящим браузером и вернуть HTML после отрисовки. */
export async function fetchWithBrowser(url, { timeout = 30000 } = {}) {
  if (!(await browserAvailable())) return { ok: false, error: 'NO_BROWSER' };
  let ctx;
  try {
    ctx = await (await getBrowser()).newContext({
      locale: 'ru-RU',
      ignoreHTTPSErrors: true,        // просроченные сертификаты — норма для рунета
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                 '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);   // дать дорисоваться клиентскому рендеру
    const html = await page.content();
    return { ok: true, status: res?.status() ?? 200, html, finalUrl: page.url(), via: 'browser' };
  } catch (e) {
    return { ok: false, error: 'BROWSER_' + (e.name === 'TimeoutError' ? 'TIMEOUT' : 'FAIL') };
  } finally {
    await ctx?.close().catch(() => {});
  }
}

export async function closeBrowser() {
  await browser?.close().catch(() => {});
  browser = null;
}
