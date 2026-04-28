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

function renderPdf(html, cb) {
  // Drop the supplied HTML into a temp file, run Chrome headless --print-to-pdf, return the bytes.
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'zu-quote-'));
  const tmpHtml = path.join(tmpDir, 'render.html');
  const tmpPdf  = path.join(tmpDir, 'render.pdf');

  // P1.1: inline all local assets as data-URLs so the temp HTML is self-contained.
  const { html: inlined, stats } = inlineLocalAssets(html, ROOT);
  const final = injectImageLoadWait(inlined);
  console.log(`[pdf] inlined assets=${stats.inlinedCount} stylesheets=${stats.inlinedStylesheets} stripped_scripts=${stats.strippedScripts}` + (stats.skipped.length ? ` skipped=${JSON.stringify(stats.skipped)}` : ''));

  fs.writeFileSync(tmpHtml, final);
  const args = [
    '--headless','--no-sandbox','--disable-gpu','--hide-scrollbars',
    '--print-to-pdf-no-header',
    `--print-to-pdf=${tmpPdf}`,
    '--virtual-time-budget=15000',
    `file://${tmpHtml}`,
  ];
  const p = spawn('google-chrome', args, { stdio: ['ignore','ignore','pipe'] });
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

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const pathname = decodeURIComponent(u.pathname);

  // POST /pdf  ->  body is HTML, return PDF
  if (req.method === 'POST' && pathname === '/pdf') {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const html = Buffer.concat(chunks).toString('utf8');
      renderPdf(html, (err, pdf) => {
        if (err) {
          console.error('PDF FAIL:', err.message);
          return send(res, 500, err.message);
        }
        const fname = (u.query.filename || 'zuildup-quote') + '.pdf';
        res.writeHead(200, {
          'Content-Type':'application/pdf',
          'Content-Disposition':`attachment; filename="${fname}"`,
          'Content-Length': pdf.length,
          'Cache-Control':'no-store',
        });
        res.end(pdf);
      });
    });
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ZuildUp Quotation Builder listening on http://127.0.0.1:${PORT}`);
  console.log(`  ROOT = ${ROOT}`);
  console.log(`  open  http://127.0.0.1:${PORT}/`);
});
