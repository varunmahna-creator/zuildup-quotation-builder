import puppeteer from '../node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import fs from 'fs';
import path from 'path';
const OUT = '/opt/openclaw/workspace/zuildup/quotation-builder/qc-2026-05-21';
const inp = { pdf: '/opt/openclaw/workspace/zuildup/quotation-builder/reference_quotes/2026-05-21_canonical/03_luxury.pdf', prefix: 'ref_lux_p' };
const browser = await puppeteer.launch({ executablePath:'/usr/bin/google-chrome', headless:'new', args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--allow-file-access-from-files']});
const pdfBytes = fs.readFileSync(inp.pdf);
const pdfB64 = pdfBytes.toString('base64');
const page = await browser.newPage();
page.on('console', m => { const t=m.text(); if (t.length<300) console.log('[c]',t);});
page.on('pageerror', e => console.log('[err]',e.message));
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
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const dataUrl = canvas.toDataURL('image/png');
      window.__pages.push({ page: p, dataUrl });
      document.body.removeChild(canvas);
    }
    document.getElementById('status').textContent = 'DONE ' + n;
  } catch (e) { document.getElementById('status').textContent = 'ERROR: '+e.message; }
})();
</script></body></html>`;
await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => {
  const s = document.getElementById('status');
  return s && (s.textContent.startsWith('DONE') || s.textContent.startsWith('ERROR'));
}, { timeout: 120000 });
const status = await page.evaluate(() => document.getElementById('status').textContent);
console.log('Status:', status);
if (status.startsWith('DONE')) {
  const n = await page.evaluate(() => window.__pageCount);
  for (let p=1; p<=n; p++) {
    const dataUrl = await page.evaluate((p) => window.__pages[p-1].dataUrl, p);
    const b64 = dataUrl.split(',')[1];
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(path.join(OUT, `${inp.prefix}-${String(p).padStart(2,'0')}.png`), buf);
    console.log(`→ ${inp.prefix}-${String(p).padStart(2,'0')}.png (${buf.length})`);
  }
}
await browser.close();
