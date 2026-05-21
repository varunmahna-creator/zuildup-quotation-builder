// Render live PDFs for 3 tiers via the actual Quick Build wizard ("wizard-open").
// Sidesteps the FAR-fetch pageerror (it's harmless — try/catches around it).
import puppeteer from '/opt/openclaw/workspace/zuildup/quotation-builder/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import fs from 'fs';
import path from 'path';

const LIVE = 'https://zuildup-quotes-zim2owjloq-el.a.run.app';
const USER = 'zuildup-sales';
const PASS = 'zuildup';
const OUT = '/opt/openclaw/workspace/zuildup/quotation-builder/qc-2026-05-21';

const tiers = [
  { id: 'basic',       file: 'live_basic.pdf' },
  { id: 'mid_luxury',  file: 'live_mid_luxury.pdf' },
  { id: 'luxury',      file: 'live_luxury.pdf' },
];

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
});

try {
  for (const t of tiers) {
    console.log(`\n=== Rendering tier: ${t.id} ===`);
    const page = await browser.newPage();
    await page.authenticate({ username: USER, password: PASS });
    await page.setViewport({ width: 1600, height: 1000 });
    page.on('console', m => {
      const tx = m.text();
      if (tx.length < 300) console.log(`  [console:${m.type()}]`, tx);
    });
    page.on('pageerror', e => console.log('  [pageerror]', e.message));

    await page.goto(LIVE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
    // Clear any leftover state from prior tier
    await page.evaluate(() => {
      try {
        localStorage.removeItem('zuildup.active_quote_id');
        localStorage.removeItem('zuildup.quote.v2');
      } catch(_) {}
    });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('#wizard-open', { timeout: 30000 });
    console.log('  ✓ App loaded');

    // Open wizard
    await page.click('#wizard-open');
    await page.waitForSelector('#wiz-name', { visible: true, timeout: 10000 });
    console.log('  ✓ Wizard opened');

    // Step 1: Customer
    await page.evaluate(() => {
      document.getElementById('wiz-salutation').value = 'Mr.';
      document.getElementById('wiz-name').value = 'QC Baseline ' + new Date().toISOString().slice(0,10);
      document.getElementById('wiz-address').value = 'QC Plot 27x57, Sector QC, Gurgaon';
    });
    await page.click('#wiz-next');
    await new Promise(r=>setTimeout(r,400));

    // Step 2: Plot
    await page.evaluate(() => {
      const set = (id, val, isCheck) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (isCheck) { el.checked = !!val; el.dispatchEvent(new Event('change',{bubbles:true})); }
        else { el.value = val; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
      };
      set('wiz-plot-sqyd', 170);
      set('wiz-breadth', 27);
      set('wiz-coverage', 75);
      set('wiz-build-type', 'stilt');
      set('wiz-floors', 3);
      set('wiz-has-lift', true, true);
      set('wiz-has-basement', false, true);
      set('wiz-has-watertank', true, true);
    });
    await page.click('#wiz-next');
    await new Promise(r=>setTimeout(r,400));

    // Step 3: Tier
    await page.evaluate((tierId) => {
      const radios = document.querySelectorAll('input[name="wiz-tier"]');
      radios.forEach(r => {
        r.checked = (r.value === tierId);
        if (r.checked) r.dispatchEvent(new Event('change',{bubbles:true}));
      });
    }, t.id);
    await new Promise(r=>setTimeout(r,800));

    // Override confirm, click Apply
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click('#wiz-apply');
    console.log('  ✓ Wizard applied (waiting for reload)');
    // Wait for the page to reload — i.e. the network goes idle again
    await new Promise(r => setTimeout(r, 4500));
    // After reload, dl button should be present
    await page.waitForSelector('#dl', { timeout: 30000 });
    console.log('  ✓ Page reloaded with quote');

    // Trigger PDF via the actual UI button, capture response
    const pdfBase64 = await page.evaluate(async () => {
      return await new Promise((resolve) => {
        const origFetch = window.fetch.bind(window);
        let resolved = false;
        window.fetch = async (...args) => {
          const url = (args[0] && args[0].url) || args[0];
          const method = (args[1]||{}).method;
          const resp = await origFetch(...args);
          if (typeof url === 'string' && url.startsWith('/pdf') && method === 'POST') {
            try {
              const clone = resp.clone();
              const buf = await clone.arrayBuffer();
              const bytes = new Uint8Array(buf);
              let bin = '';
              for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
              const b64 = btoa(bin);
              window.fetch = origFetch;
              if (!resolved) { resolved = true; resolve({ b64, bytes: bytes.length, status: resp.status }); }
            } catch(e) {
              if (!resolved) { resolved = true; resolve({ error: 'capture failed: '+e.message }); }
            }
          }
          return resp;
        };
        // Override the no-rate confirm modal — auto-continue
        const origQBConfirm = window.qbConfirmNoRate;
        // The function is enclosed but document.getElementById('qb-norate-continue') will be present if modal pops
        // simpler: poll for the modal and auto-click continue
        const modalPoll = setInterval(() => {
          const cont = document.getElementById('qb-norate-continue');
          if (cont) { cont.click(); clearInterval(modalPoll); }
        }, 200);
        document.getElementById('dl').click();
        setTimeout(() => {
          clearInterval(modalPoll);
          if (!resolved) { resolved = true; resolve({ error: 'pdf request did not fire within 90s' }); }
        }, 90000);
      });
    });

    if (pdfBase64.error) {
      console.error('  ✗ PDF capture failed:', pdfBase64.error);
      await page.close();
      continue;
    }
    const pdfBuf = Buffer.from(pdfBase64.b64, 'base64');
    const outPath = path.join(OUT, t.file);
    fs.writeFileSync(outPath, pdfBuf);
    console.log(`  ✓ Wrote ${outPath} (${pdfBuf.length} bytes, status ${pdfBase64.status})`);
    await page.close();
  }
} finally {
  await browser.close();
}
