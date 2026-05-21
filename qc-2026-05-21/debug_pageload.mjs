// Just load the page and capture full error info (no wizard interaction)
import puppeteer from '/opt/openclaw/workspace/zuildup/quotation-builder/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const LIVE = 'https://zuildup-quotes-zim2owjloq-el.a.run.app';
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.authenticate({ username: 'zuildup-sales', password: 'zuildup' });
await page.setViewport({ width: 1600, height: 1000 });
page.on('console', m => console.log(`[console:${m.type()}]`, m.text().slice(0,400)));
page.on('pageerror', e => console.log('[pageerror]', e.message, '\n', (e.stack||'').slice(0,800)));
page.on('requestfailed', r => console.log('[reqfail]', r.url(), r.failure()?.errorText));
await page.goto(LIVE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
console.log('--- 5s wait ---');
await new Promise(r=>setTimeout(r,5000));
// Check what's on the page
const probe = await page.evaluate(() => {
  return {
    hasQuickBuild: !!document.getElementById('qb-quick-build'),
    hasWizardOpen: !!document.getElementById('wizard-open'),
    qbState: !!window.__qbState,
    qbStateRows: window.__qbState ? (window.__qbState.rows||[]).length : null,
    title: document.title,
    bodyFirst200: (document.body.innerText||'').slice(0,200),
    btnIds: Array.from(document.querySelectorAll('button[id]')).map(b=>b.id).slice(0,30),
  };
});
console.log('PROBE:', JSON.stringify(probe, null, 2));
await browser.close();
