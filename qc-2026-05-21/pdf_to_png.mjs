// Use puppeteer to render PDF pages to PNGs using pdf.js (via CDN).
// Chrome ships PDF rendering but it's hard to screenshot per-page.
// Easier: use pdfjs-dist (in node_modules if installed) OR fall back to
// rendering each page via the file:// URL and Chrome's PDF viewer is unreliable.
// Use pdfjs-dist + node-canvas? not installed.
//
// SIMPLEST approach: use Chrome's PDF viewer by opening file:// then screenshotting.
// But headless Chrome doesn't ship PDF viewer in --headless=new without plugin flags.
//
// FALLBACK: Use the same puppeteer browser. Render each page by serving the PDF
// over HTTP via file://, then screenshot. Use --enable-features=NewPdfViewer doesn't apply.
//
// Best path: install pdfjs-dist via npm — but no network needed if we use a CDN
// inside an HTML wrapper.
import puppeteer from '../node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import fs from 'fs';
import path from 'path';

const OUT = '/opt/openclaw/workspace/zuildup/quotation-builder/qc-2026-05-21';

const inputs = [
  // live
  { pdf: 'live_basic.pdf',      prefix: 'live_basic_p' },
  { pdf: 'live_mid_luxury.pdf', prefix: 'live_mid_p' },
  { pdf: 'live_luxury.pdf',     prefix: 'live_lux_p' },
  // reference
  { pdf: '/opt/openclaw/workspace/zuildup/quotation-builder/reference_quotes/2026-05-21_canonical/01_basic.pdf',      prefix: 'ref_basic_p',  abs: true },
  { pdf: '/opt/openclaw/workspace/zuildup/quotation-builder/reference_quotes/2026-05-21_canonical/02_mid_luxury.pdf', prefix: 'ref_mid_p',    abs: true },
  { pdf: '/opt/ocplatform/workspace/zuildup/quotation-builder/reference_quotes/2026-05-21_canonical/03_luxury.pdf',     prefix: 'ref_lux_p',    abs: true },
];

// Inline pdf.js via the version bundled in pdfjs-dist
// Check if pdfjs-dist exists
const pdfjsPath = '/opt/ocplatform/workspace/zuildup/quotation-builder/node_modules/pdfjs-dist';
const hasPdfjs = fs.existsSync(pdfjsPath);
console.log('pdfjs-dist present:', hasPdfjs);

let browser;

(async () => {
  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--allow-file-access-from-files'],
  });

  for (const inp of inputs) {
    const pdfAbsPath = inp.abs ? inp.pdf : path.join(OUT, inp.pdf);
    if (!fs.existsSync(pdfAbsPath)) {
      console.log(`✗ Missing: ${pdfAbsPath}`);
      continue;
    }
    console.log(`\n=== ${path.basename(pdfAbsPath)} → ${inp.prefix}-*.png ===`);
    const pdfBytes = fs.readFileSync(pdfAbsPath);
    const pdfB64 = pdfBytes.toString('base64');

    const page = await browser.newPage();
    page.on('console', m => { const t = m.text(); if (t.length<300) console.log('  [c]', t); });
    page.on('pageerror', e => console.log('  [err]', e.message));

    // Load a minimal page that bootstraps pdf.js from CDN and renders each page to canvas
    // Use cdnjs because it's reliable
    const html = `<!doctype html><html><body style="margin:0">
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<div id="status">loading</div>
<script>
(async () => {
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const raw = atob('${pdfB64}');
    const bytes = new Uint8Array(raw.length);
    for (let i=0;i<raw.length;i++) bytes[i] = raw.charCodeAt(i);
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const n = pdf.numPages;
    window.__pageCount = n;
    window.__pages = [];
    for (let p=1; p<=n; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 2.0 }); // ~150 DPI
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const dataUrl = canvas.toDataURL('image/png');
      window.__pages.push({ page: p, dataUrl, w: canvas.width, h: canvas.height });
      document.body.removeChild(canvas);
    }
    document.getElementById('status').textContent = 'DONE ' + n + ' pages';
  } catch (e) {
    document.getElementById('status').textContent = 'ERROR: ' + e.message;
    console.error('PDFJS ERROR:', e.message);
  }
})();
</script>
</body></html>`;
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    // Wait for done
    await page.waitForFunction(() => {
      const s = document.getElementById('status');
      return s && (s.textContent.startsWith('DONE') || s.textContent.startsWith('ERROR'));
    }, { timeout: 120000 });
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    if (status.startsWith('ERROR')) {
      console.log(`  ✗ ${status}`);
      await page.close();
      continue;
    }
    const pageCount = await page.evaluate(() => window.__pageCount);
    console.log(`  ✓ pdfjs rendered ${pageCount} pages`);
    for (let p=1; p<=pageCount; p++) {
      const dataUrl = await page.evaluate((p) => window.__pages[p-1].dataUrl, p);
      const b64 = dataUrl.split(',')[1];
      const buf = Buffer.from(b64, 'base64');
      const fname = `${inp.prefix}-${String(p).padStart(2,'0')}.png`;
      fs.writeFileSync(path.join(OUT, fname), buf);
      console.log(`    → ${fname} (${buf.length} bytes)`);
    }
    await page.close();
  }
  await browser.close();
})().catch(e => { console.error('FATAL:', e); if (browser) browser.close(); process.exit(1); });
