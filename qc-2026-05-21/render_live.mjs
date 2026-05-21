// Render live PDFs for 3 tiers via Quick Build wizard on production
import puppeteer from '/opt/openclaw/workspace/zuildup/quotation-builder/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import fs from 'fs';
import path from 'path';

const LIVE = 'https://zuildup-quotes-zim2owjloq-el.a.run.app';
const USER = 'zuildup-sales';
const PASS = 'zuildup';
const OUT = '/opt/ocplatform/workspace/zuildup/quotation-builder/qc-2026-05-21';

const tiers = [
  { id: 'basic',       file: 'live_basic.pdf' },
  { id: 'mid_luxury',  file: 'live_mid_luxury.pdf' },
  { id: 'luxury',      file: 'live_luxury.pdf' },
];

(async () => {
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
      // Capture console logs
      page.on('console', m => {
        const txt = m.text();
        if (txt.length < 400) console.log(`[console:${m.type()}]`, txt);
      });
      page.on('pageerror', e => console.log('[pageerror]', e.message));

      // Step 1: Open the app
      await page.goto(LIVE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
      await page.waitForSelector('#qb-quick-build', { timeout: 30000 });
      console.log('  ✓ App loaded');

      // Step 2: Clear any prior state, navigate fresh
      await page.evaluate(() => {
        try {
          localStorage.removeItem('zuildup.active_quote_id');
          localStorage.removeItem('zuildup.quote.v2');
        } catch(_) {}
      });
      await page.reload({ waitUntil: 'networkidle2' });
      await page.waitForSelector('#qb-quick-build', { timeout: 30000 });

      // Step 3: Open Quick Build wizard
      await page.click('#qb-quick-build');
      await page.waitForSelector('#wiz-name', { visible: true, timeout: 10000 });
      console.log('  ✓ Wizard opened');

      // Step 4: Fill step 1 (Customer)
      await page.evaluate(() => {
        document.getElementById('wiz-salutation').value = 'Mr.';
        document.getElementById('wiz-name').value = 'QC Test ' + new Date().toISOString().slice(0,10);
        document.getElementById('wiz-address').value = 'QC Plot 27x57, Sector QC, Gurgaon';
      });
      // Click next
      await page.click('#wiz-next');
      await new Promise(r => setTimeout(r, 400));

      // Step 5: Fill step 2 (Plot)
      // 170 sq.yd, breadth 27, depth 57, stilt+3 floors, with lift, with water tank
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
      await new Promise(r => setTimeout(r, 400));

      // Step 6: Pick tier
      await page.evaluate((tierId) => {
        const radios = document.querySelectorAll('input[name="wiz-tier"]');
        radios.forEach(r => {
          if (r.value === tierId) {
            r.checked = true;
            r.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            r.checked = false;
          }
        });
      }, t.id);
      await new Promise(r => setTimeout(r, 600));

      // Step 7: Apply — override the confirm() dialog to auto-accept
      await page.evaluate(() => {
        window.confirm = () => true;
      });
      await page.click('#wiz-apply');
      // Wait for reload
      await new Promise(r => setTimeout(r, 3000));
      // The page reloads. Wait for the form to reappear.
      await page.waitForSelector('#qb-quick-build', { timeout: 30000 });
      console.log('  ✓ Wizard applied, page reloaded');

      // Step 8: Trigger PDF download. Find the PDF button (likely "#btn-pdf" or similar)
      // Easier: directly POST the rendered HTML to /pdf endpoint from inside the page.
      const pdfBase64 = await page.evaluate(async () => {
        // The preview is rendered into #preview-root. The /pdf endpoint accepts an HTML body.
        // Let's reuse the same code path the UI uses. We need to find the PDF button.
        const findBtn = (selectors) => {
          for (const s of selectors) {
            const el = document.querySelector(s);
            if (el) return el;
          }
          return null;
        };
        // Try common button IDs/classes
        const candidates = ['#btn-pdf', '#qb-pdf', '#btn-download-pdf', 'button[data-action="pdf"]'];
        let btn = findBtn(candidates);
        if (!btn) {
          // Scan all buttons for "PDF" text
          for (const b of document.querySelectorAll('button')) {
            if (/pdf/i.test(b.textContent)) { btn = b; break; }
          }
        }
        if (!btn) return { error: 'pdf button not found', buttons: Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim()).slice(0,30) };

        // Hook fetch to capture the PDF response
        return await new Promise((resolve) => {
          const origFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const url = (args[0] && args[0].url) || args[0];
            const resp = await origFetch(...args);
            if (typeof url === 'string' && url.includes('/pdf') && (args[1]||{}).method === 'POST') {
              try {
                const clone = resp.clone();
                const buf = await clone.arrayBuffer();
                // Convert to base64
                const bytes = new Uint8Array(buf);
                let bin = '';
                for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
                const b64 = btoa(bin);
                window.fetch = origFetch; // restore
                resolve({ b64, bytes: bytes.length });
              } catch(e) {
                resolve({ error: 'capture failed: ' + e.message });
              }
            }
            return resp;
          };
          btn.click();
          // Timeout in case nothing happens
          setTimeout(() => resolve({ error: 'pdf request did not fire within 60s' }), 60000);
        });
      });

      if (pdfBase64.error) {
        console.error('  ✗ PDF capture failed:', pdfBase64.error, JSON.stringify(pdfBase64).slice(0,500));
        await page.close();
        continue;
      }
      const pdfBuf = Buffer.from(pdfBase64.b64, 'base64');
      const outPath = path.join(OUT, t.file);
      fs.writeFileSync(outPath, pdfBuf);
      console.log(`  ✓ Wrote ${outPath} (${pdfBuf.length} bytes)`);

      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
