// ZuildUp Quotation Builder — local Node server.
// Responsibilities:
//   1. Serve index.html and assets (catalog, lookbook, css, js).
//   2. Receive a POST /pdf with the rendered preview HTML, return an A4 PDF blob.
//
// Run with:  node server.js   (listens on http://127.0.0.1:8124)
//
// PDF rendering pipeline (P1.1 / phase2-step-6):
//   - Client posts the iframe.contentDocument.outerHTML to /pdf
//   - Server walks the HTML and inlines every relative asset URL as a data-URL,
//     so the rendered HTML is fully self-contained when written to /tmp/.
//   - Strips <script src> tags (scripts already executed in the iframe; the
//     serialized DOM already reflects post-script state).
//   - Injects an image-load wait helper so Chrome --print-to-pdf doesn't
//     fire before all <img> have natural dimensions.
//   - Bumped --virtual-time-budget from 8s to 15s to accommodate larger fixtures.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');
const { spawn } = require('child_process');
const os   = require('os');
let sharp;
try { sharp = require('sharp'); }
catch (_) { sharp = null; console.warn('[server] sharp not available — image compression disabled'); }

const PORT  = process.env.PORT || 8124;
const ROOT  = path.resolve(__dirname, '..');           // workspace root for assets
const APP   = path.resolve(__dirname);                 // app/ dir

const MIME = {
  '.html':'text/html; charset=utf-8',
  '.js':  'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg':'image/jpeg',
  '.pdf': 'application/pdf',
  '.woff':'font/woff',
  '.woff2':'font/woff2',
  '.ttf': 'font/ttf',
};
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control':'no-store', ...headers });
  res.end(body);
}

function serveStatic(req, res, p) {
  // resolve relative to ROOT so /catalog/catalog.json, /assets/lookbook/... work
  const fp = path.normalize(path.join(ROOT, p));
  if (!fp.startsWith(ROOT)) return send(res, 403, 'Forbidden');
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found: '+p);
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(fp).pipe(res);
  });
}

// --- P1.1 architectural fix: data-URL inlining helpers ----------------------

// Turn /assets/foo.png or ../assets/foo.png or assets/foo.png into a workspace path.
function resolveLocalUrl(rawUrl, baseDir) {
  if (!rawUrl) return null;
  // Strip surrounding quotes that might come from url("...") or url('...')
  let u = rawUrl.trim().replace(/^['"]|['"]$/g, '');
  // Skip data:, http:, https:, blob:, mailto:, tel:, javascript:
  if (/^(data:|https?:|blob:|mailto:|tel:|javascript:)/i.test(u)) return null;
  // Strip query/hash for filesystem lookup
  const cleanU = u.split(/[?#]/)[0];
  if (!cleanU) return null;
  let abs;
  if (cleanU.startsWith('/')) {
    abs = path.normalize(path.join(ROOT, cleanU));
  } else {
    abs = path.normalize(path.join(baseDir || ROOT, cleanU));
  }
  // Sandbox: must stay inside ROOT
  if (!abs.startsWith(ROOT)) return null;
  return abs;
}

// P1.6: image compression — JPEG re-encode for inlined images > 200KB
//       (vector SVG kept as-is, already small / lossless).
const COMPRESS_BYTES_THRESHOLD = 200 * 1024;
const COMPRESS_JPEG_QUALITY    = 70;

function fileToDataUrl(absPath) {
  try {
    const ext = path.extname(absPath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const buf = fs.readFileSync(absPath);
    if (ext === '.svg') {
      // SVG is text — keep as utf8 data URL for smaller size and crispness.
      const text = buf.toString('utf8').replace(/\s+/g, ' ').trim();
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(text);
    }
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) {
    return null;
  }
}

// Async variant — used by the /pdf renderer pipeline. Compresses raster images > 200KB
// to JPEG q70 BEFORE inlining (target: total PDF < 1MB on standard fixture).
async function fileToDataUrlMaybeCompressed(absPath) {
  try {
    const ext = path.extname(absPath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const buf = fs.readFileSync(absPath);
    if (ext === '.svg') {
      const text = buf.toString('utf8').replace(/\s+/g, ' ').trim();
      return { dataUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(text), bytes: buf.length, compressed: false };
    }
    // Raster — consider compression
    if (sharp && buf.length > COMPRESS_BYTES_THRESHOLD && (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp')) {
      try {
        const out = await sharp(buf).jpeg({ quality: COMPRESS_JPEG_QUALITY, mozjpeg: true }).toBuffer();
        return {
          dataUrl: `data:image/jpeg;base64,${out.toString('base64')}`,
          bytes: out.length,
          compressed: true,
          origBytes: buf.length,
        };
      } catch (e) {
        // Fall through to uncompressed below.
      }
    }
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length, compressed: false };
  } catch (e) {
    return null;
  }
}

// Walk HTML and inline every local asset reference as a data: URL.
// Strips <script src> and <script>...</script> blocks (DOM already reflects
// post-script state; we don't want re-execution to mutate it again).
// Inlines linked stylesheets (<link rel="stylesheet" href="/...">) by replacing
// them with <style>...</style> blocks (and recursively rewriting url(...) inside).
function inlineLocalAssets(html, baseDir) {
  baseDir = baseDir || ROOT;
  let out = html;
  let inlinedCount = 0;
  let strippedScripts = 0;
  let inlinedStylesheets = 0;
  const skipped = [];

  // 1. Strip <script ...>...</script> blocks (executed scripts) and self-closing
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, () => {
    strippedScripts++; return '';
  });
  out = out.replace(/<script\b[^>]*\/?>/gi, () => {
    strippedScripts++; return '';
  });

  // 2. Inline <link rel="stylesheet" href="/..."> as <style> blocks.
  //    We DO want third-party (https) stylesheets to remain (e.g. Google Fonts).
  out = out.replace(/<link\b([^>]*?)href=(["'])([^"']+)\2([^>]*)>/gi,
    (m, before, q, href, after) => {
      // Only handle stylesheet links
      if (!/rel\s*=\s*["']?stylesheet/i.test(before + after)) return m;
      const absPath = resolveLocalUrl(href, baseDir);
      if (!absPath) return m; // third-party — leave alone
      try {
        const css = fs.readFileSync(absPath, 'utf8');
        const cssDir = path.dirname(absPath);
        const rewritten = inlineCssUrls(css, cssDir);
        inlinedStylesheets++;
        return `<style data-inlined-from="${href}">\n${rewritten}\n</style>`;
      } catch (e) {
        skipped.push({ href, reason: e.message });
        return m;
      }
    });

  // 3. Rewrite src="...", href="..." (non-link), and srcset on img/source/audio/video/iframe/etc.
  //    Pattern: attr="..." where attr is one of (src, href, poster, data-src) — but skip <a href> doc links.
  //    We're aggressive on src/poster (image-y) and conservative on href (only image/css/font extensions).
  out = out.replace(/\b(src|poster|data-src)=(["'])([^"']+)\2/gi,
    (m, attr, q, val) => {
      const abs = resolveLocalUrl(val, baseDir);
      if (!abs) return m;
      const dataUrl = fileToDataUrl(abs);
      if (!dataUrl) { skipped.push({ url: val, reason: 'read failed' }); return m; }
      inlinedCount++;
      return `${attr}=${q}${dataUrl}${q}`;
    });

  // 4. Rewrite url(...) inside any inline style blocks or attributes.
  out = inlineCssUrls(out, baseDir);

  return { html: out, stats: { inlinedCount, strippedScripts, inlinedStylesheets, skipped: skipped.slice(0,5) } };
}

// Rewrite url(...) tokens in CSS text. Used both for standalone CSS files
// (after reading them) and for any HTML that contains <style> blocks or style="...".
function inlineCssUrls(css, baseDir) {
  return css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (m, q, val) => {
    const abs = resolveLocalUrl(val, baseDir);
    if (!abs) return m;
    const dataUrl = fileToDataUrl(abs);
    if (!dataUrl) return m;
    return `url("${dataUrl}")`;
  });
}
// P1.6: async variant of inlineLocalAssets used by /pdf — compresses raster
// images > 200KB to JPEG q70 to keep final PDF under 1 MB. Same shape/output as
// the sync version, just awaits image conversion.
async function inlineLocalAssetsAsync(html, baseDir) {
  baseDir = baseDir || ROOT;
  let out = html;
  let inlinedCount = 0;
  let strippedScripts = 0;
  let inlinedStylesheets = 0;
  let compressedCount = 0;
  let bytesSaved = 0;
  const skipped = [];

  // 1. Strip <script>...</script> blocks (executed scripts).
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, () => { strippedScripts++; return ''; });
  out = out.replace(/<script\b[^>]*\/?>/gi, () => { strippedScripts++; return ''; });

  // 2. Inline <link rel="stylesheet"> as <style>.
  out = out.replace(/<link\b([^>]*?)href=(["'])([^"']+)\2([^>]*)>/gi,
    (m, before, q, href, after) => {
      if (!/rel\s*=\s*["']?stylesheet/i.test(before + after)) return m;
      const absPath = resolveLocalUrl(href, baseDir);
      if (!absPath) return m;
      try {
        const css = fs.readFileSync(absPath, 'utf8');
        const cssDir = path.dirname(absPath);
        const rewritten = inlineCssUrls(css, cssDir);
        inlinedStylesheets++;
        return `<style data-inlined-from="${href}">\n${rewritten}\n</style>`;
      } catch (e) {
        skipped.push({ href, reason: e.message });
        return m;
      }
    });

  // 3. Replace src/poster/data-src attributes with promised data-URLs.
  //    We have to run two passes: first capture all matches & kick off awaits,
  //    then substitute in the resolved URLs.
  const tasks = [];
  out = out.replace(/\b(src|poster|data-src)=(["'])([^"']+)\2/gi,
    (m, attr, q, val) => {
      const abs = resolveLocalUrl(val, baseDir);
      if (!abs) return m;
      const tok = `__PDFASSET_${tasks.length}__`;
      tasks.push({ tok, abs, attr, q, val });
      return `${attr}=${q}${tok}${q}`;
    });

  for (const t of tasks) {
    const r = await fileToDataUrlMaybeCompressed(t.abs);
    if (!r) {
      skipped.push({ url: t.val, reason: 'read failed' });
      out = out.replace(t.tok, t.val);
      continue;
    }
    inlinedCount++;
    if (r.compressed) {
      compressedCount++;
      bytesSaved += (r.origBytes - r.bytes);
    }
    out = out.replace(t.tok, r.dataUrl);
  }

  // 4. Rewrite url(...) inside any inline style blocks. Keep sync (CSS bg images
  //    are typically small SVGs / icons; not worth async there).
  out = inlineCssUrls(out, baseDir);

  return { html: out, stats: { inlinedCount, strippedScripts, inlinedStylesheets, compressedCount, bytesSaved, skipped: skipped.slice(0,5) } };
}


// Inject a tiny boot script into <head> that:
//  (a) waits for all <img> to settle before signaling readiness via document.title
//      — Chrome --virtual-time-budget will still fire after the timeout, but
//      this ensures images are actually painted when print kicks off.
//  (b) document.fonts.ready awaited so font-faces don't FOIT during print.
function injectImageLoadWait(html) {
  const boot = `<script>
(async function(){
  try {
    const imgs = Array.from(document.images);
    await Promise.all(imgs.map(img => {
      if (img.complete && img.naturalHeight !== 0) return Promise.resolve();
      return new Promise(r => {
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
        // Safety timeout — never hang the print
        setTimeout(r, 6000);
      });
    }));
    if (document.fonts && document.fonts.ready) {
      await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]);
    }
    document.documentElement.setAttribute('data-print-ready','1');
  } catch(_) {
    document.documentElement.setAttribute('data-print-ready','error');
  }
})();
</script>`;
  // Inject just before </head>; if no </head>, prepend to body.
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, boot + '\n</head>');
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, m => m + '\n' + boot);
  return boot + '\n' + html;
}

async function renderPdf(html, cb) {
  // Drop the supplied HTML into a temp file, run Chrome headless --print-to-pdf, return the bytes.
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'zu-quote-'));
  const tmpHtml = path.join(tmpDir, 'render.html');
  const tmpPdf  = path.join(tmpDir, 'render.pdf');

  // P1.1: inline all local assets as data-URLs so the temp HTML is self-contained.
  // P1.6: async variant compresses raster images > 200KB to JPEG q70 to keep PDF < 1MB.
  const { html: inlined, stats } = await inlineLocalAssetsAsync(html, ROOT);
  const final = injectImageLoadWait(inlined);
  console.log(`[pdf] inlined assets=${stats.inlinedCount} compressed=${stats.compressedCount} bytes_saved=${stats.bytesSaved} stylesheets=${stats.inlinedStylesheets} stripped_scripts=${stats.strippedScripts}` + (stats.skipped.length ? ` skipped=${JSON.stringify(stats.skipped)}` : ''));

  fs.writeFileSync(tmpHtml, final);
  const args = [
    '--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--hide-scrollbars',
    '--print-to-pdf-no-header',
    `--print-to-pdf=${tmpPdf}`,
    '--virtual-time-budget=15000',
    `file://${tmpHtml}`,
  ];
  const CHROME = process.env.CHROME_BIN || 'google-chrome';
  const p = spawn(CHROME, args, { stdio: ['ignore','ignore','pipe'] });
  let stderr = '';
  p.stderr.on('data', d => stderr += d.toString());
  p.on('close', code => {
    fs.readFile(tmpPdf, (err, buf) => {
      try {
        fs.unlinkSync(tmpHtml);
        if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
        fs.rmdirSync(tmpDir);
      } catch(_){}
      if (err) return cb(new Error(`PDF read fail: ${err.message}\nchrome rc=${code}\nstderr=${stderr.slice(-300)}`));
      cb(null, buf);
    });
  });
}

// --- Production basic auth gate ---------------------------------------------
// Activated only when AUTH_USER / AUTH_PASS env vars are both set.
// Single shared credential — sales team uses one login.
function requireAuth(req, res) {
  const user = process.env.AUTH_USER;
  const pass = process.env.AUTH_PASS;
  if (!user || !pass) return true; // dev mode
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="ZuildUp"',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end('Authentication required');
    return false;
  }
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); }
  catch (_) { decoded = ''; }
  const idx = decoded.indexOf(':');
  const u = idx >= 0 ? decoded.slice(0, idx) : '';
  const p = idx >= 0 ? decoded.slice(idx + 1) : '';
  if (u !== user || p !== pass) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="ZuildUp"',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end('Invalid credentials');
    return false;
  }
  return true;
}


const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const earlyPath = decodeURIComponent(u.pathname);
  // Public health endpoint — no auth, used by Cloud Run startup probe
  if (req.method === 'GET' && earlyPath === '/healthz') {
    return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  // Production auth gate (no-op in dev when AUTH_USER/AUTH_PASS unset).
  if (!requireAuth(req, res)) return;
  const pathname = earlyPath;

  // POST /pdf  ->  body is HTML, return PDF
  // P1.6: filename via Content-Disposition.
  //   Format: ZuildUp_Quote_<sanitized_lastname>_<YYYY-MM-DD>.pdf
  //   Source of truth: ?customer_last=...&date=YYYY-MM-DD query params (sent by client).
  //   Sanitization: keep [A-Za-z0-9_], replace others with _, collapse __+, trim, fall back to 'Untitled'.
  if (req.method === 'POST' && pathname === '/pdf') {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const html = Buffer.concat(chunks).toString('utf8');
      try {
        const pdf = await new Promise((resolve, reject) => {
          renderPdf(html, (err, buf) => err ? reject(err) : resolve(buf));
        });
        // P1.6: build filename
        const lastRaw = (u.query.customer_last || u.query.filename || '').toString().trim();
        const dateRaw = (u.query.date || new Date().toISOString().slice(0,10)).toString().trim();
        const sanitize = s => {
          let v = (s || '').replace(/[^A-Za-z0-9_]+/g, '_');
          v = v.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
          return v;
        };
        const last = sanitize(lastRaw) || 'Untitled';
        const dat  = sanitize(dateRaw) || new Date().toISOString().slice(0,10).replace(/-/g, '_');
        const fname = `ZuildUp_Quote_${last}_${dat}.pdf`;
        res.writeHead(200, {
          'Content-Type':'application/pdf',
          'Content-Disposition':`attachment; filename="${fname}"`,
          'Content-Length': pdf.length,
          'Cache-Control':'no-store',
        });
        res.end(pdf);
      } catch (err) {
        console.error('PDF FAIL:', err.message);
        return send(res, 500, err.message);
      }
    });
    return;
  }
  // POST /api/next-quote-id  -> { id: "ZUI-2026-1020" }
  // P3 #2: persistent counter on disk. Seed from QUOTE_COUNTER_SEED (default 1020).
  if (req.method === 'POST' && pathname === '/api/next-quote-id') {
    try {
      const ctrFile = process.env.QUOTE_COUNTER_FILE || '/tmp/zuildup_quote_counter';
      const seed = parseInt(process.env.QUOTE_COUNTER_SEED || '1020', 10);
      let n = seed;
      try {
        const raw = fs.readFileSync(ctrFile, 'utf8').trim();
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed >= seed) n = parsed + 1;
      } catch (_) { /* first run: use seed */ }
      fs.writeFileSync(ctrFile, String(n));
      const year = new Date().getFullYear();
      const id = 'ZUI-' + year + '-' + n;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ id }));
    } catch (e) {
      console.error('[quote-id] FAIL:', e.message);
      send(res, 500, 'counter error: ' + e.message);
    }
    return;
  }
  // GET /  ->  index.html
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveStatic(req, res, '/app/index.html');
  }
  // GET /preview  ->  preview.html (used in the iframe for live preview)
  if (req.method === 'GET' && pathname === '/preview') {
    return serveStatic(req, res, '/app/preview.html');
  }

  // GET anything else  ->  static under ROOT
  if (req.method === 'GET') return serveStatic(req, res, pathname);

  send(res, 405, 'Method not allowed');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ZuildUp Quotation Builder listening on http://0.0.0.0:${PORT}`);
  console.log(`  ROOT = ${ROOT}`);
  console.log(`  open  http://127.0.0.1:${PORT}/`);
});
