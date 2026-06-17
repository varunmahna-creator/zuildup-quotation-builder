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

// Phase 4: Firestore-backed cross-device quote library.
// Falls back to no-op behavior if creds aren't available (dev / local).
let Firestore = null;
let firestore = null;
try {
  ({ Firestore } = require('@google-cloud/firestore'));
  // Project picked up from GOOGLE_CLOUD_PROJECT or metadata server on Cloud Run.
  // Locally needs GOOGLE_APPLICATION_CREDENTIALS or `gcloud auth application-default login`.
  firestore = new Firestore({
    projectId: process.env.FIRESTORE_PROJECT_ID || 'zuildup-quotes',
    databaseId: '(default)',
    ignoreUndefinedProperties: true,
  });
  console.log('[firestore] client initialized for project=' + (process.env.FIRESTORE_PROJECT_ID || 'zuildup-quotes'));
} catch (e) {
  console.warn('[firestore] not available:', e.message);
}
const QUOTES_COLLECTION = process.env.FIRESTORE_COLLECTION || 'quotes';

// Phase 9G (2026-06-03): GCS-backed PDF attachments per quote.
// Bucket created out-of-band: gs://zuildup-quotes-uploads (asia-south1, UBLA, PAP enforced).
// IAM: Cloud Run default compute SA granted roles/storage.objectAdmin on the bucket.
let gcsStorage = null;
let gcsBucket = null;
const PDF_BUCKET = process.env.PDF_BUCKET || 'zuildup-quotes-uploads';
try {
  const { Storage } = require('@google-cloud/storage');
  gcsStorage = new Storage();
  gcsBucket = gcsStorage.bucket(PDF_BUCKET);
  console.log('[gcs] client initialized for bucket=' + PDF_BUCKET);
} catch (e) { console.warn('[gcs] init failed:', e.message); }

let Busboy = null;
try { Busboy = require('busboy'); }
catch (e) { console.warn('[busboy] not available:', e.message); }

// FieldValue helper for arrayUnion (loaded lazily to tolerate missing firestore).
let FieldValue = null;
try { ({ FieldValue } = require('@google-cloud/firestore')); }
catch (_) { /* already warned above */ }

// Phase 9H (2026-06-03): bcryptjs for password hashing.
// Pure-JS implementation (no native bindings) — safer for Cloud Run image.
let bcrypt = null;
try { bcrypt = require('bcryptjs'); console.log('[auth] bcryptjs loaded'); }
catch (e) { console.warn('[auth] bcryptjs not available:', e.message); }
const USERS_COLLECTION = process.env.USERS_COLLECTION || 'users';

// Safe filename helper: lowercase, strip to [a-z0-9_.-], max 80 chars,
// trim leading/trailing dots/underscores, fallback 'file'.
function safePdfFilename(s) {
  let v = String(s || '').toLowerCase();
  v = v.replace(/[^a-z0-9_.-]+/g, '_').replace(/_+/g, '_');
  v = v.replace(/^[._-]+|[._-]+$/g, '');
  if (v.length > 80) v = v.slice(0, 80);
  if (!v) v = 'file';
  if (!/\.pdf$/i.test(v)) v += '.pdf';
  return v;
}

// Base64url decode helper.
function b64urlDecode(s) {
  if (!s) return '';
  let str = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  try { return Buffer.from(str, 'base64').toString('utf8'); }
  catch (_) { return ''; }
}

// Parse a single-PDF multipart upload using busboy. Returns
// { fields:{...}, file:{ filename, mimeType, buffer } } or rejects on error.
function readSinglePdfMultipart(req, { maxBytes = 25 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (!Busboy) return reject(new Error('busboy unavailable'));
    let bb;
    try { bb = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1 } }); }
    catch (e) { return reject(new Error('bad multipart: ' + e.message)); }
    const fields = {};
    let fileObj = null;
    let aborted = false;
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      if (name !== 'pdf') { stream.resume(); return; }
      const chunks = [];
      let total = 0;
      let truncated = false;
      stream.on('data', c => { chunks.push(c); total += c.length; });
      stream.on('limit', () => { truncated = true; });
      stream.on('end', () => {
        if (aborted) return;
        if (truncated) { aborted = true; reject(new Error('file too large (max ' + maxBytes + ' bytes)')); return; }
        fileObj = { filename: info.filename || 'upload.pdf', mimeType: info.mimeType || info.mediaType || 'application/octet-stream', buffer: Buffer.concat(chunks) };
      });
      stream.on('error', e => { if (!aborted) { aborted = true; reject(e); } });
    });
    bb.on('error', e => { if (!aborted) { aborted = true; reject(e); } });
    bb.on('close', () => { if (!aborted) resolve({ fields, file: fileObj }); });
    req.pipe(bb);
  });
}


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

// Phase 7N (2026-05-15): switched from Chrome `--print-to-pdf` CLI to puppeteer-core.
// Why: `--print-to-pdf` captures at virtual-time-budget expiry but font decoding
// from inline base64 happens in REAL time, not virtual time. With font-display:swap,
// Chrome prints the system fallback (LiberationSans) before Inter is parsed,
// so the PDF embeds the wrong font. Puppeteer lets us explicitly await
// `document.fonts.ready` before capture — guaranteeing Inter is the active glyph
// source when the PDF is rendered.
async function renderPdf(html, cb) {
  // P1.1: inline all local assets as data-URLs so the temp HTML is self-contained.
  // P1.6: async variant compresses raster images > 200KB to JPEG q70 to keep PDF < 1MB.
  const { html: inlined, stats } = await inlineLocalAssetsAsync(html, ROOT);
  let final = injectImageLoadWait(inlined);
  // Phase 7O (2026-05-15): inject <base href="http://127.0.0.1:PORT/"> so relative
  // URLs like /fonts/Inter.var.woff2 resolve when the page is loaded via page.setContent
  // (whose default base is about:blank). The font endpoints (added below) are mounted
  // before basic-auth, so puppeteer can fetch them without credentials.
  const baseTag = `<base href="http://127.0.0.1:${PORT}/">`;
  if (/<head[^>]*>/i.test(final)) {
    final = final.replace(/<head[^>]*>/i, m => m + baseTag);
  } else if (/<html[^>]*>/i.test(final)) {
    final = final.replace(/<html[^>]*>/i, m => m + '<head>' + baseTag + '</head>');
  } else {
    final = '<head>' + baseTag + '</head>' + final;
  }
  console.log(`[pdf] inlined assets=${stats.inlinedCount} compressed=${stats.compressedCount} bytes_saved=${stats.bytesSaved} stylesheets=${stats.inlinedStylesheets} stripped_scripts=${stats.strippedScripts} base_href=http://127.0.0.1:${PORT}/` + (stats.skipped.length ? ` skipped=${JSON.stringify(stats.skipped)}` : ''));

  const puppeteer = require('puppeteer-core');
  const CHROME = process.env.CHROME_BIN || 'google-chrome';
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--hide-scrollbars']
    });
    const page = await browser.newPage();
    await page.setContent(final, { waitUntil: 'networkidle0', timeout: 30000 });
    // Wait for fonts to actually be parsed and applied (CRITICAL — Phase 7N fix)
    try {
      await page.evaluate(() => document.fonts && document.fonts.ready);
    } catch(e) { /* non-fatal */ }
    // Wait for boot-script readiness marker (max 12s — boot self-times-out at 6s img + 4s font)
    try {
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-print-ready') === '1' ||
              document.documentElement.getAttribute('data-print-ready') === 'error',
        { timeout: 12000 }
      );
    } catch(e) {
      console.warn('[pdf] data-print-ready timeout, proceeding anyway');
    }
    const buf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });
    await browser.close();
    cb(null, buf);
  } catch (e) {
    if (browser) try { await browser.close(); } catch(_){}
    cb(new Error(`PDF render fail: ${e.message}`));
  }
}

// --- Production basic auth gate ---------------------------------------------
// Phase 4 (per-rep logins): supports multiple credential pairs.
// Priority of credential sources:
//   1. AUTH_USERS_JSON  — JSON dict of { username: password }
//   2. AUTH_USER + AUTH_PASS  — legacy single-user fallback
//   3. None set  — dev mode (no auth)
let _AUTH_USERS = null;
function _loadAuthUsers() {
  if (_AUTH_USERS !== null) return _AUTH_USERS;
  const j = process.env.AUTH_USERS_JSON;
  if (j) {
    try {
      const parsed = JSON.parse(j);
      if (parsed && typeof parsed === 'object') {
        _AUTH_USERS = parsed;
        console.log('[auth] loaded ' + Object.keys(parsed).length + ' user(s) from AUTH_USERS_JSON');
        return _AUTH_USERS;
      }
    } catch (e) {
      console.warn('[auth] AUTH_USERS_JSON parse failed:', e.message);
    }
  }
  if (process.env.AUTH_USER && process.env.AUTH_PASS) {
    _AUTH_USERS = { [process.env.AUTH_USER]: process.env.AUTH_PASS };
    return _AUTH_USERS;
  }
  _AUTH_USERS = {};
  return _AUTH_USERS;
}

// Phase 9H (2026-06-03): Firestore-backed user store with env-var fallback.
// Cache layer: per-username, TTL 60s, prevents hammering Firestore on every request.
// Cache shape: { username: { doc: {password_hash, role, ...} | null, ts: ms } }.
const _USER_CACHE = new Map();
const USER_CACHE_TTL_MS = 60 * 1000;
function _invalidateUserCache(username) {
  if (username) _USER_CACHE.delete(username);
  else _USER_CACHE.clear();
}
async function _getUserDoc(username) {
  if (!username) return null;
  const cached = _USER_CACHE.get(username);
  if (cached && (Date.now() - cached.ts) < USER_CACHE_TTL_MS) return cached.doc;
  if (!firestore) return null;
  try {
    const snap = await firestore.collection(USERS_COLLECTION).doc(username).get();
    const doc = snap.exists ? snap.data() : null;
    _USER_CACHE.set(username, { doc, ts: Date.now() });
    return doc;
  } catch (e) {
    console.warn('[auth] getUserDoc failed for', username, ':', e.message);
    return null;
  }
}
// Default-admin fallback: if no Firestore doc exists for varun, treat as admin.
// This keeps admin endpoints usable during cold boot / Firestore outage.
function _isHardcodedAdmin(username) { return username === 'varun'; }
async function _resolveUserRole(username) {
  const doc = await _getUserDoc(username);
  if (doc && doc.role) return doc.role;
  if (_isHardcodedAdmin(username)) return 'admin';
  return 'rep';
}
// Verify supplied password against (1) Firestore hash if doc exists, else (2) env plaintext.
async function _verifyPassword(username, password) {
  if (!username || password == null) return false;
  const doc = await _getUserDoc(username);
  if (doc && doc.password_hash && bcrypt) {
    if (doc.active === false) return false;
    try { return await bcrypt.compare(password, doc.password_hash); }
    catch (e) { console.warn('[auth] bcrypt.compare fail:', e.message); return false; }
  }
  // Fallback: env-var plaintext (legacy / pre-migration).
  const users = _loadAuthUsers();
  if (!users || Object.keys(users).length === 0) {
    // No auth configured at all → allow (dev mode).
    return true;
  }
  const expected = users[username];
  return !!(expected && expected === password);
}
// Phase 9H: async auth wrapper. Returns a Promise<boolean>; callers must `await`.
async function requireAuth(req, res) {
  const users = _loadAuthUsers();
  // Dev mode: no users configured AND no firestore → wide open.
  if ((!users || Object.keys(users).length === 0) && !firestore) return true;
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
  const ok = await _verifyPassword(u, p);
  if (!ok) {
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


// Phase 4: extract Basic Auth username for quote authoring.
// Returns the username from the Authorization header (no auth check — caller must
// have already passed requireAuth). Returns 'anonymous' if header is missing/invalid.
function getAuthUser(req) {
  try {
    const header = req.headers['authorization'] || '';
    if (!header.startsWith('Basic ')) return 'anonymous';
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return 'anonymous';
    return decoded.slice(0, idx) || 'anonymous';
  } catch (_) {
    return 'anonymous';
  }
}

// Phase 4: helper to read JSON body from a request. Returns parsed object.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let total = 0;
    const MAX = 10 * 1024 * 1024; // 10 MB cap (a quote is typically ~50 KB)
    req.on('data', c => {
      total += c.length;
      if (total > MAX) {
        req.destroy(new Error('body too large'));
        return reject(new Error('body too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (total === 0) return resolve(null);
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error('invalid JSON: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

// Phase 4: server-side id generator (matches client format q_<ts36>_<rand6>).
function genQuoteId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return 'q_' + t + '_' + r;
}

// Phase 4: build the index entry shape returned by the API.
function indexEntryFromDoc(doc) {
  return {
    id: doc.id,
    name: doc.name || '',
    customer_name: doc.customer_name || '',
    author: doc.author || 'anonymous',
    created_at: doc.created_at || '',
    modified_at: doc.modified_at || '',
    row_count: doc.row_count || 0,
    // Phase 9G: surface uploaded PDF count + flags on the index so the Load
    // modal can render the 📎 chip without an extra round-trip per row.
    uploaded_pdfs: Array.isArray(doc.uploaded_pdfs) ? doc.uploaded_pdfs : [],
    pdf_is_authoritative: !!doc.pdf_is_authoritative,
  };
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const earlyPath = decodeURIComponent(u.pathname);
  // Public health endpoint — no auth, used by Cloud Run startup probe
  if (req.method === 'GET' && earlyPath === '/healthz') {
    return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  // Phase 7O (2026-05-15): public font endpoints — NO auth, so puppeteer can fetch
  // them during PDF rendering (page.setContent with <base href="http://127.0.0.1:PORT/">).
  // Strict whitelist: only the two known variable woff2 files. Mounted BEFORE requireAuth.
  if (req.method === 'GET' && /^\/fonts\/[^/]+$/.test(earlyPath)) {
    const fname = earlyPath.slice('/fonts/'.length);
    const ALLOWED = new Set(['Inter.var.woff2', 'Fraunces.var.woff2']);
    if (!ALLOWED.has(fname)) return send(res, 404, 'font not found');
    const fp = path.join(APP, 'fonts', fname);
    fs.stat(fp, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'font missing on disk');
      res.writeHead(200, {
        'Content-Type': 'font/woff2',
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(fp).pipe(res);
    });
    return;
  }
  // Phase 9H: requireAuth is now async (Firestore-backed). Wrap the rest
  // of the handler in an async IIFE so we can await it without changing
  // every existing branch.
  (async () => {
  // Production auth gate (no-op in dev when AUTH_USER/AUTH_PASS unset).
  if (!(await requireAuth(req, res))) return;
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
  // ============================================================================
  // Phase 4: /api/quotes — cross-device quote library backed by Firestore.
  // ============================================================================
  // GET    /api/quotes        -> list of index entries, newest-modified first
  // GET    /api/quotes/:id    -> full quote slot { ...indexEntry, state: {...} }
  // POST   /api/quotes        -> { name?, state }; creates new slot. Returns full slot.
  // PUT    /api/quotes/:id    -> { name?, state }; overwrites slot. Returns full slot.
  // DELETE /api/quotes/:id    -> removes slot. Returns { ok: true }.
  //
  // All endpoints behind Basic Auth. Author = Basic Auth username, stored on the doc.
  // Quotes are TEAM-SHARED: any authenticated user sees & can edit all quotes.

  // GET /api/quotes
  if (req.method === 'GET' && pathname === '/api/quotes') {
    if (!firestore) return send(res, 503, JSON.stringify({ error: 'firestore unavailable' }), { 'Content-Type': 'application/json' });
    (async () => {
      try {
        const snap = await firestore.collection(QUOTES_COLLECTION)
          .orderBy('modified_at', 'desc').limit(500).get();
        const items = snap.docs.map(d => indexEntryFromDoc(d.data()));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ items }));
      } catch (e) {
        console.error('[api/quotes][LIST] FAIL:', e.message);
        send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
      }
    })();
    return;
  }

  // GET /api/quotes/:id
  {
    const m = pathname.match(/^\/api\/quotes\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && m) {
      const id = m[1];
      if (!firestore) return send(res, 503, JSON.stringify({ error: 'firestore unavailable' }), { 'Content-Type': 'application/json' });
      (async () => {
        try {
          const doc = await firestore.collection(QUOTES_COLLECTION).doc(id).get();
          if (!doc.exists) return send(res, 404, JSON.stringify({ error: 'not found' }), { 'Content-Type': 'application/json' });
          const data = doc.data();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(data));
        } catch (e) {
          console.error('[api/quotes][GET] FAIL:', e.message);
          send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
        }
      })();
      return;
    }
    // DELETE /api/quotes/:id
    // 2026-06-17 (Varun directive): COMPLETE backend delete. Admin-only
    // (varun + karan). Purges the Firestore doc AND every attached PDF in
    // GCS so nothing is left behind. Reps can no longer delete quotes.
    if (req.method === 'DELETE' && m) {
      const id = m[1];
      if (!firestore) return send(res, 503, JSON.stringify({ error: 'firestore unavailable' }), { 'Content-Type': 'application/json' });
      (async () => {
        try {
          // --- Authorization: admins only ---
          const caller = getAuthUser(req);
          const callerRole = await _resolveUserRole(caller);
          if (callerRole !== 'admin') {
            console.warn('[api/quotes][DELETE] denied for non-admin ' + caller + ' on ' + id);
            return send(res, 403, JSON.stringify({ error: 'admin required to delete quotes' }), { 'Content-Type': 'application/json' });
          }
          const ref = firestore.collection(QUOTES_COLLECTION).doc(id);
          const snap = await ref.get();
          if (!snap.exists) return send(res, 404, JSON.stringify({ error: 'not found' }), { 'Content-Type': 'application/json' });
          // --- Purge attached PDFs from GCS (complete delete) ---
          const pdfs = (snap.data() || {}).uploaded_pdfs || [];
          let pdfsDeleted = 0;
          if (gcsBucket && pdfs.length) {
            for (const p of pdfs) {
              const obj = p && p.gcs_object;
              if (!obj || obj.indexOf('..') !== -1 || !obj.startsWith(id + '/')) continue;
              try {
                await gcsBucket.file(obj).delete({ ignoreNotFound: true });
                pdfsDeleted++;
              } catch (ge) {
                console.warn('[api/quotes][DELETE] gcs purge failed for ' + obj + ': ' + ge.message);
              }
            }
          }
          // --- Delete the Firestore doc ---
          await ref.delete();
          console.log('[api/quotes][DELETE] quote ' + id + ' deleted by admin ' + caller + ' (pdfs purged: ' + pdfsDeleted + '/' + pdfs.length + ')');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, pdfs_deleted: pdfsDeleted }));
        } catch (e) {
          console.error('[api/quotes][DELETE] FAIL:', e.message);
          send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
        }
      })();
      return;
    }
    // PUT /api/quotes/:id
    if (req.method === 'PUT' && m) {
      const id = m[1];
      if (!firestore) return send(res, 503, JSON.stringify({ error: 'firestore unavailable' }), { 'Content-Type': 'application/json' });
      (async () => {
        try {
          const body = await readJsonBody(req);
          if (!body || typeof body !== 'object') return send(res, 400, JSON.stringify({ error: 'body required' }), { 'Content-Type': 'application/json' });
          const state = body.state;
          if (!state || typeof state !== 'object') return send(res, 400, JSON.stringify({ error: 'state required' }), { 'Content-Type': 'application/json' });
          const author = getAuthUser(req);
          const now = new Date().toISOString();
          const ref = firestore.collection(QUOTES_COLLECTION).doc(id);
          const existing = await ref.get();
          const existingData = existing.exists ? existing.data() : {};
          // Phase 9F (2026-06-03): anti-wipe guard.
          // The applyWizard cur.quoteId leak (and any future similar bug)
          // can cause a fresh-template state to be PUT against a saved
          // quote's id, wiping it. Reject any PUT whose incoming state is
          // a fresh template AND the existing doc has real content.
          // Force the caller to explicitly opt-in via { allowOverwriteEmpty:
          // true } in the body if they truly want this.
          const existingState = existingData.state || {};
          const existingHasContent = (function(){
            const c = existingState.customer || {};
            const p = existingState.pricing || {};
            const rows = existingState.rows || [];
            const hasCust = !!(c.name || c.address);
            const hasPrice = (p.costPerSqft != null) || (p.zoneARate != null);
            const hasOverrides = rows.some(r => r && r.override && Object.keys(r.override).length);
            return hasCust || hasPrice || hasOverrides;
          })();
          const incomingIsBlank = (function(){
            const c = state.customer || {};
            const p = state.pricing || {};
            const rows = state.rows || [];
            const noCust = !c.name && !c.address;
            const noPrice = (p.costPerSqft == null) && (p.zoneARate == null);
            const allFresh = rows.length === 0 || rows.every(r => r && r._isFresh === true && (!r.override || !Object.keys(r.override).length));
            return noCust && noPrice && allFresh;
          })();
          if (existingHasContent && incomingIsBlank && !body.allowOverwriteEmpty) {
            console.warn('[api/quotes][PUT] BLOCKED wipe of', id, 'by', author, '— existing had content, incoming is blank');
            return send(res, 409, JSON.stringify({ error: 'wipe_blocked', message: 'Refusing to overwrite a saved quote with a blank/fresh state. The existing quote has real content; the incoming state appears to be a fresh template. If this is intentional, retry with allowOverwriteEmpty: true.' }), { 'Content-Type': 'application/json' });
          }
          // Phase 9F: snapshot the previous state into a backup collection
          // BEFORE overwriting. Best-effort, fire-and-forget — never block
          // the write on backup failure.
          if (existing.exists && existingData.state) {
            try {
              const backupRef = firestore.collection('quote_backups').doc();
              backupRef.set({
                quote_id: id,
                prev_state: existingData.state,
                prev_customer_name: existingData.customer_name || '',
                prev_name: existingData.name || '',
                prev_modified_at: existingData.modified_at || null,
                replaced_by_author: author,
                replaced_at: now,
              }).catch(e => console.warn('[api/quotes][PUT] backup write failed:', e.message));
            } catch(e) { /* never block primary write */ }
          }
          const customer_name = (state.customer && state.customer.name) || existingData.customer_name || '';
          const name = (typeof body.name === 'string' && body.name.trim())
            ? body.name.trim()
            : (existingData.name || (customer_name || 'Untitled') + ' — ' + now.slice(0,10));
          const doc = {
            id,
            name,
            customer_name,
            author: existingData.author || author,
            last_edited_by: author,
            created_at: existingData.created_at || now,
            modified_at: now,
            row_count: Array.isArray(state.rows) ? state.rows.length : 0,
            state,
          };
          await ref.set(doc);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(doc));
        } catch (e) {
          console.error('[api/quotes][PUT] FAIL:', e.message);
          send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
        }
      })();
      return;
    }
  }

  // POST /api/quotes
  if (req.method === 'POST' && pathname === '/api/quotes') {
    if (!firestore) return send(res, 503, JSON.stringify({ error: 'firestore unavailable' }), { 'Content-Type': 'application/json' });
    (async () => {
      try {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') return send(res, 400, JSON.stringify({ error: 'body required' }), { 'Content-Type': 'application/json' });
        const state = body.state;
        if (!state || typeof state !== 'object') return send(res, 400, JSON.stringify({ error: 'state required' }), { 'Content-Type': 'application/json' });

        // Allow client to supply id (so localStorage and Firestore stay in sync on
        // first save), else generate one server-side.
        let id = (typeof body.id === 'string' && /^q_[A-Za-z0-9_-]+$/.test(body.id)) ? body.id : null;
        if (!id) id = genQuoteId();

        const author = getAuthUser(req);
        const now = new Date().toISOString();
        const customer_name = (state.customer && state.customer.name) || '';
        const name = (typeof body.name === 'string' && body.name.trim())
          ? body.name.trim()
          : ((customer_name || 'Untitled') + ' — ' + now.slice(0,10));
        const doc = {
          id,
          name,
          customer_name,
          author,
          last_edited_by: author,
          created_at: now,
          modified_at: now,
          row_count: Array.isArray(state.rows) ? state.rows.length : 0,
          state,
        };
        await firestore.collection(QUOTES_COLLECTION).doc(id).set(doc);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(doc));
      } catch (e) {
        console.error('[api/quotes][POST] FAIL:', e.message);
        send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
      }
    })();
    return;
  }

  // ==========================================================================
  // Phase 8D-2: POST /api/quote-edit — LLM-driven natural language quote edits
  // ==========================================================================
  // Body: { userText: string, state: object, history?: [{role,text}] }
  // Returns: { patches: [...], note?: string, source: 'llm' | 'error' }
  //
  // Patch shape (must be applicable by client's applyPatchToState):
  //   { op: "set",        path: "customer.name" | "build.floors" | "pricing.zoneARate" | "rows[<id>].override.brands" | ..., value: any, explanation?: string }
  //   { op: "add_row",    item_id: "bathroom.sanitary_ware_and_cp_fitting", explanation?: string }
  //   { op: "delete_row", row_id:  "<existing row id>", explanation?: string }
  //
  // Path whitelist (client also enforces — defense in depth):
  //   customer.{salutation,name,address}
  //   build.{plotSqYards,breadth,coverage,buildType,floors,hasBasement,hasLift,hasWaterTank}
  //   pricing.{costPerSqft,zoneARate,zoneBRate,zoneCRate,zoneDRate,basementRate,liftCost}
  //   rows[<id>].override.{label,rate,rate_text,brands,description,location,category_label}
  //   notes, scope
  //
  // Logging: every request/response appended to /tmp/quote-edit-log.jsonl AND
  // (when Firestore present) to the `quote_edit_logs` collection for Phase 9.
  if (req.method === 'POST' && pathname === '/api/quote-edit') {
    (async () => {
      const reqStartedAt = new Date().toISOString();
      const reqId = 'qedit_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      let body;
      try { body = await readJsonBody(req); } catch (e) {
        return send(res, 400, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
      }
      if (!body || !body.userText || typeof body.userText !== 'string') {
        return send(res, 400, JSON.stringify({ error: 'userText required' }), { 'Content-Type': 'application/json' });
      }
      const userText = body.userText.trim().slice(0, 4000);
      const clientState = body.state || {};
      const history = Array.isArray(body.history) ? body.history.slice(-6) : [];

      // Build compact state snapshot for the LLM context window.
      // Don't send full row catalog data — just IDs + labels + any overrides.
      const snapshot = {
        customer: clientState.customer || {},
        build: clientState.build || {},
        pricing: {
          costPerSqft: clientState.pricing?.costPerSqft,
          zoneARate:   clientState.pricing?.zoneARate,
          zoneBRate:   clientState.pricing?.zoneBRate,
          zoneCRate:   clientState.pricing?.zoneCRate,
          zoneDRate:   clientState.pricing?.zoneDRate,
          basementRate:clientState.pricing?.basementRate,
          liftCost:    clientState.pricing?.liftCost,
        },
        scope: clientState.scope,
        notes: clientState.notes,
        row_count: Array.isArray(clientState.rows) ? clientState.rows.length : 0,
        rows: Array.isArray(clientState.rows) ? clientState.rows.slice(0, 200).map(r => ({
          id: r.id,
          label: r.override?.label || null,
          brands: r.override?.brands || null,
          rate: r.override?.rate ?? null,
          rate_text: r.override?.rate_text || null,
          location: r.override?.location || null,
        })) : [],
      };

      const apiKey  = process.env.ANTHROPIC_API_KEY || '';
      const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
      const model   = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

      if (!apiKey) {
        const logRec = { reqId, ts: reqStartedAt, userText, error: 'no_api_key' };
        try { fs.appendFileSync('/tmp/quote-edit-log.jsonl', JSON.stringify(logRec) + '\n'); } catch (_) {}
        return send(res, 503, JSON.stringify({
          error: 'LLM backend not configured (no ANTHROPIC_API_KEY). Client will fall back to local parser.',
          patches: [],
        }), { 'Content-Type': 'application/json' });
      }

      const systemPrompt =
        "You are Iraaj, an AI assistant embedded in ZuildUp's construction-quotation builder. " +
        "Your job: turn a sales rep's natural-language edit request into ONE OR MORE JSON patches. " +
        "ZuildUp is a premium home-construction brand (Basic / Mid-Luxury / Luxury tiers, NCR India). " +
        "\n\n" +
        "OUTPUT FORMAT — return ONLY a JSON object, no prose, no markdown fence:\n" +
        '  { "patches": [ {patch...}, ... ], "note": "optional 1-line explanation" }\n' +
        "\n" +
        "ALLOWED PATCH SHAPES:\n" +
        '  { "op": "set",            "path": "<allowed>", "value": <any>, "explanation": "human-readable" }\n' +
        '  { "op": "add_row",        "item_id": "<catalog id>",            "explanation": "..." }\n' +
        '  { "op": "delete_row",     "row_id":  "<existing row id>",       "explanation": "..." }\n' +
        '  { "op": "add_zone_line",  "zone": "<A|B|C|D>", "name": "<string>", "area": <number>, "rate": <number>, "rate_text": "<optional>", "explanation": "..." }\n' +
        "\n" +
        "ALLOWED `set` PATHS (anything else will be rejected by the validator):\n" +
        "  customer.salutation | customer.name | customer.address\n" +
        "  build.plotSqYards (number) | build.breadth (number) | build.coverage (number 0..1)\n" +
        "  build.buildType (string) | build.floors (int 1..6)\n" +
        "  build.hasBasement | build.hasLift | build.hasWaterTank (bool)\n" +
        "  pricing.costPerSqft | pricing.zoneARate | pricing.zoneBRate | pricing.zoneCRate | pricing.zoneDRate\n" +
        "  pricing.basementRate | pricing.liftCost (all numbers, INR)\n" +
        "  rows[<row.id>].override.label  | .brands | .rate | .rate_text | .description | .location | .category_label\n" +
        "  notes | scope\n" +
        "\n" +
        "RULES:\n" +
        "1. Match rows by their `id` (the snapshot below lists every row.id + label + overrides). Be precise — use the EXACT id.\n" +
        "2. Numeric values: send as JSON numbers, NOT strings. INR amounts are plain numbers (1500 not '₹1,500').\n" +
        "3. For brand/spec swaps, set `rows[<id>].override.brands`. To also change the description text, also set `.description`.\n" +
        "4. If the rep asks something you can't safely translate to patches (vague, ambiguous, or out of scope), return `{ patches: [], note: '<ask a 1-sentence clarification>' }`.\n" +
        "5. NEVER invent row ids. NEVER write to paths outside the whitelist. NEVER include _meta, _internal, or fields not listed.\n" +
        "6. Multi-edit is EXPECTED, not optional — emit as many patches as the user's intent requires in one response.\n" +
        "7. Each patch MUST include a short `explanation` string the rep will see on the diff card.\n" +
        "\n" +
        "8. MULTI-PLACE EDITS (CRITICAL — do NOT stop at the first match):\n" +
        "   A single concept often lives in MULTIPLE state paths. When that happens, emit ONE patch per location — do not pick just one.\n" +
        "   Examples:\n" +
        "   - 'Change lift price to 15 Lakhs' → emit BOTH:\n" +
        "       (a) { op:'set', path:'pricing.liftCost', value: 1500000 }\n" +
        "       (b) for EVERY row whose id/label contains 'lift', 'staircase', 'mumty', or whose current rate equals the old liftCost: also emit { op:'set', path:'rows[<id>].override.rate', value: 1500000 } (and `.rate_text` if appropriate)\n" +
        "   - 'Change Hindware to Kohler' (brand swap) → scan EVERY row in the snapshot's `rows[]`. For each row whose `brands` or `label` mentions 'Hindware' (case-insensitive), emit { op:'set', path:'rows[<id>].override.brands', value:'Kohler' }. Do NOT stop at one — if 3 rows match, emit 3 patches. If 8 rows match, emit 8.\n" +
        "   - 'Make all flooring Italian marble' → find every row with 'floor' in the id/label and emit one brand-set patch per row.\n" +
        "   If you are unsure whether two locations are linked, emit BOTH as separate patches — the rep can accept or reject each card individually. Better to over-propose than to silently miss a stale field.\n" +
        "\n" +
        "9. FREE-FORM CUSTOM ROWS (not in catalog):\n" +
        "   If the rep asks to add a line item that is NOT in the existing rows (e.g. 'add a room on the terrace of 150 sqft at ₹5000 per sqft', 'add a 200 sqft mumty', 'add a custom pergola'), use `add_zone_line` — do NOT refuse.\n" +
        "   Zone allocation guide:\n" +
        "     A = covered indoor area (rooms, halls, kitchens, indoor extensions)\n" +
        "     B = stilt, balcony, staircase, mumty, semi-covered\n" +
        "     C = terrace, ramp, setback (open / on top)\n" +
        "     D = underground water tank (per-litre items only — DO NOT use for sqft items)\n" +
        "   Example: 'Add a 150 sqft room on the terrace at ₹5000 per sqft' →\n" +
        '     { "op":"add_zone_line", "zone":"C", "name":"Extra Room on Terrace", "area":150, "rate":5000, "explanation":"Add 150 sqft terrace room at ₹5000/sqft" }\n' +
        "   Example: 'Add a 200 sqft mumty at 3000 per sqft' →\n" +
        '     { "op":"add_zone_line", "zone":"B", "name":"Mumty", "area":200, "rate":3000, "explanation":"Add mumty as a stilt/staircase-zone line item" }\n' +
        "   Pick the zone yourself — the rep usually omits it. Only ask for clarification if truly ambiguous (e.g. 'add a 100 sqft room' with no location).\n" +
        "\n" +
        "CURRENT QUOTE SNAPSHOT (read-only context):\n" +
        JSON.stringify(snapshot, null, 0);

      const messages = [];
      for (const h of history) {
        if (!h || !h.text) continue;
        if (h.role === 'user')      messages.push({ role: 'user',      content: String(h.text).slice(0, 2000) });
        if (h.role === 'assistant') messages.push({ role: 'assistant', content: String(h.text).slice(0, 2000) });
      }
      messages.push({ role: 'user', content: userText });

      // Call Anthropic Messages API.
      const llmPayload = {
        model,
        max_tokens: 1500,
        system: systemPrompt,
        messages,
      };
      const llmReqBody = Buffer.from(JSON.stringify(llmPayload));
      const apiUrlObj = url.parse(baseUrl + '/v1/messages');
      const isHttps = apiUrlObj.protocol === 'https:';
      const lib = isHttps ? require('https') : require('http');

      const httpReq = lib.request({
        method: 'POST',
        hostname: apiUrlObj.hostname,
        port: apiUrlObj.port || (isHttps ? 443 : 80),
        path: apiUrlObj.path,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': llmReqBody.length,
        },
        timeout: 45000,
      }, (apiRes) => {
        let chunks = [];
        apiRes.on('data', c => chunks.push(c));
        apiRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = JSON.parse(raw); } catch (e) {
            console.error('[quote-edit] non-JSON from Anthropic:', raw.slice(0, 400));
            const logRec = { reqId, ts: reqStartedAt, userText, error: 'llm_non_json', raw: raw.slice(0, 800) };
            try { fs.appendFileSync('/tmp/quote-edit-log.jsonl', JSON.stringify(logRec) + '\n'); } catch (_) {}
            return send(res, 502, JSON.stringify({ error: 'LLM returned non-JSON', patches: [] }), { 'Content-Type': 'application/json' });
          }
          if (apiRes.statusCode !== 200) {
            console.error('[quote-edit] LLM HTTP', apiRes.statusCode, raw.slice(0, 400));
            const logRec = { reqId, ts: reqStartedAt, userText, error: 'llm_http_' + apiRes.statusCode, body: parsed };
            try { fs.appendFileSync('/tmp/quote-edit-log.jsonl', JSON.stringify(logRec) + '\n'); } catch (_) {}
            return send(res, 502, JSON.stringify({ error: 'LLM error (' + apiRes.statusCode + ')', patches: [], detail: parsed?.error?.message || null }), { 'Content-Type': 'application/json' });
          }
          // Extract text from Anthropic Messages response
          const textPieces = (parsed.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
          // Strip code fences if Claude wrapped it
          let jsonStr = textPieces;
          const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (fence) jsonStr = fence[1].trim();
          // If response has prose before/after, try to find the JSON object boundary
          if (!jsonStr.startsWith('{')) {
            const firstBrace = jsonStr.indexOf('{');
            const lastBrace = jsonStr.lastIndexOf('}');
            if (firstBrace >= 0 && lastBrace > firstBrace) jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
          }
          let payload;
          try { payload = JSON.parse(jsonStr); } catch (e) {
            console.error('[quote-edit] could not parse LLM JSON:', textPieces.slice(0, 400));
            const logRec = { reqId, ts: reqStartedAt, userText, error: 'parse_fail', llm_text: textPieces.slice(0, 1500) };
            try { fs.appendFileSync('/tmp/quote-edit-log.jsonl', JSON.stringify(logRec) + '\n'); } catch (_) {}
            return send(res, 502, JSON.stringify({ error: 'Could not parse LLM JSON', patches: [], note: 'LLM did not return valid JSON.', raw: textPieces.slice(0, 600) }), { 'Content-Type': 'application/json' });
          }
          const patches = Array.isArray(payload.patches) ? payload.patches : [];
          const note    = typeof payload.note === 'string' ? payload.note : undefined;
          // JSONL log + Firestore log (best effort, fire-and-forget)
          const logRec = {
            reqId, ts: reqStartedAt, userText, source: 'llm', model,
            usage: parsed.usage || null,
            patches, note,
            stop_reason: parsed.stop_reason,
          };
          try { fs.appendFileSync('/tmp/quote-edit-log.jsonl', JSON.stringify(logRec) + '\n'); } catch (_) {}
          if (firestore) {
            firestore.collection('quote_edit_logs').doc(reqId).set(logRec).catch(e => {
              console.warn('[quote-edit] firestore log fail:', e.message);
            });
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ patches, note, source: 'llm', reqId }));
        });
      });
      httpReq.on('timeout', () => {
        console.error('[quote-edit] LLM timeout');
        httpReq.destroy(new Error('timeout'));
      });
      httpReq.on('error', (e) => {
        console.error('[quote-edit] LLM request error:', e.message);
        const logRec = { reqId, ts: reqStartedAt, userText, error: 'llm_request_error', detail: e.message };
        try { fs.appendFileSync('/tmp/quote-edit-log.jsonl', JSON.stringify(logRec) + '\n'); } catch (_) {}
        if (!res.headersSent) {
          send(res, 502, JSON.stringify({ error: 'LLM request failed: ' + e.message, patches: [] }), { 'Content-Type': 'application/json' });
        }
      });
      httpReq.write(llmReqBody);
      httpReq.end();
    })();
    return;
  }

  // ==========================================================================
  // Phase 8E: POST /api/quote-edit-feedback — log apply/reject outcomes
  // ==========================================================================
  // Body: { reqId?, action: 'apply'|'reject'|'apply_fail', patch, explanation?, error?, userText? }
  // Returns: { ok: true }
  // Purpose: server-side learning loop log for Phase 9 (mining accepted vs
  // rejected patches to refine prompts / patch ops over time).
  if (req.method === 'POST' && pathname === '/api/quote-edit-feedback') {
    (async () => {
      let body;
      try { body = await readJsonBody(req); } catch (e) {
        return send(res, 400, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
      }
      if (!body || !body.action) {
        return send(res, 400, JSON.stringify({ error: 'action required' }), { 'Content-Type': 'application/json' });
      }
      const rec = {
        ts: new Date().toISOString(),
        kind: 'feedback',
        reqId: body.reqId || null,
        action: String(body.action).slice(0, 32),
        userText: body.userText ? String(body.userText).slice(0, 2000) : null,
        patch: body.patch || null,
        explanation: body.explanation ? String(body.explanation).slice(0, 500) : null,
        error: body.error ? String(body.error).slice(0, 500) : null,
      };
      try { fs.appendFileSync('/tmp/quote-edit-log.jsonl', JSON.stringify(rec) + '\n'); } catch (_) {}
      if (firestore) {
        firestore.collection('quote_edit_logs').add(rec).catch(e => {
          console.warn('[quote-edit-feedback] firestore log fail:', e.message);
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    })();
    return;
  }


  // ==========================================================================
  // Phase 9G (2026-06-03): PDF upload / attach / list / download / delete +
  // create-from-PDF endpoints. All multipart uploads via busboy, single-file,
  // max 25 MB, content sniffed for %PDF magic. Storage: gs://zuildup-quotes-uploads.
  // Object key shape: <quote_id>/<isoTS-no-colons>_<safe_filename>.pdf
  // Firestore doc field: uploaded_pdfs: [{filename, gcs_object, gcs_uri, uploaded_by, uploaded_at, size_bytes, content_type}]
  // Download endpoint streams through the server so existing Basic Auth gates access.
  // ==========================================================================

  // POST /api/quotes/:id/attach-pdf — multipart, field 'pdf'
  {
    const m = pathname.match(/^\/api\/quotes\/([A-Za-z0-9_-]+)\/attach-pdf$/);
    if (req.method === 'POST' && m) {
      const id = m[1];
      if (!firestore) return send(res, 503, JSON.stringify({ error: 'firestore unavailable' }), { 'Content-Type': 'application/json' });
      if (!gcsBucket) return send(res, 503, JSON.stringify({ error: 'gcs unavailable' }), { 'Content-Type': 'application/json' });
      (async () => {
        try {
          const author = getAuthUser(req);
          const ref = firestore.collection(QUOTES_COLLECTION).doc(id);
          const snap = await ref.get();
          if (!snap.exists) return send(res, 404, JSON.stringify({ error: 'quote not found' }), { 'Content-Type': 'application/json' });
          let parsed;
          try { parsed = await readSinglePdfMultipart(req); }
          catch (e) { return send(res, 400, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' }); }
          if (!parsed.file || !parsed.file.buffer || !parsed.file.buffer.length) {
            return send(res, 400, JSON.stringify({ error: 'no pdf field' }), { 'Content-Type': 'application/json' });
          }
          const buf = parsed.file.buffer;
          if (buf.length < 4 || buf.slice(0,4).toString('ascii') !== '%PDF') {
            return send(res, 400, JSON.stringify({ error: 'not a PDF (missing %PDF magic)' }), { 'Content-Type': 'application/json' });
          }
          const safe = safePdfFilename(parsed.file.filename);
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const gcs_object = id + '/' + ts + '_' + safe;
          const gcs_uri = 'gs://' + PDF_BUCKET + '/' + gcs_object;
          const file = gcsBucket.file(gcs_object);
          await file.save(buf, {
            resumable: false,
            contentType: 'application/pdf',
            metadata: { contentType: 'application/pdf', cacheControl: 'private, max-age=86400' },
          });
          const now = new Date().toISOString();
          const entry = {
            filename: parsed.file.filename || safe,
            gcs_object,
            gcs_uri,
            uploaded_by: author,
            uploaded_at: now,
            size_bytes: buf.length,
            content_type: 'application/pdf',
          };
          if (FieldValue && FieldValue.arrayUnion) {
            await ref.update({ uploaded_pdfs: FieldValue.arrayUnion(entry), modified_at: now });
          } else {
            const cur = (snap.data() || {}).uploaded_pdfs || [];
            await ref.update({ uploaded_pdfs: cur.concat([entry]), modified_at: now });
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, pdf: entry }));
        } catch (e) {
          console.error('[api/quotes][attach-pdf] FAIL:', e.message);
          send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
        }
      })();
      return;
    }
  }

  // GET /api/quotes/:id/pdfs — list pdf entries on a quote
  {
    const m = pathname.match(/^\/api\/quotes\/([A-Za-z0-9_-]+)\/pdfs$/);
    if (req.method === 'GET' && m) {
      const id = m[1];
      if (!firestore) return send(res, 503, JSON.stringify({ error: 'firestore unavailable' }), { 'Content-Type': 'application/json' });
      (async () => {
        try {
          const snap = await firestore.collection(QUOTES_COLLECTION).doc(id).get();
          if (!snap.exists) return send(res, 404, JSON.stringify({ error: 'not found' }), { 'Content-Type': 'application/json' });
          const pdfs = (snap.data() || {}).uploaded_pdfs || [];
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ pdfs }));
        } catch (e) {
          console.error('[api/quotes][list-pdfs] FAIL:', e.message);
          send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
        }
      })();
      return;
    }
  }

  // GET /api/quotes/:id/pdfs/:b64/download — stream a single PDF (auth-gated proxy)
  {
    const m = pathname.match(/^\/api\/quotes\/([A-Za-z0-9_-]+)\/pdfs\/([A-Za-z0-9_\-=]+)\/download$/);
    if (req.method === 'GET' && m) {
      const id = m[1];
      const b64 = m[2];
      if (!firestore) return send(res, 503, JSON.stringify({ error: 'firestore unavailable' }), { 'Content-Type': 'application/json' });
      if (!gcsBucket) return send(res, 503, JSON.stringify({ error: 'gcs unavailable' }), { 'Content-Type': 'application/json' });
      (async () => {
        try {
          const gcs_object = b64urlDecode(b64);
          if (!gcs_object || !gcs_object.startsWith(id + '/') || gcs_object.indexOf('..') !== -1) {
            return send(res, 400, JSON.stringify({ error: 'invalid object key' }), { 'Content-Type': 'application/json' });
          }
          const snap = await firestore.collection(QUOTES_COLLECTION).doc(id).get();
          if (!snap.exists) return send(res, 404, JSON.stringify({ error: 'not found' }), { 'Content-Type': 'application/json' });
          const pdfs = (snap.data() || {}).uploaded_pdfs || [];
          const entry = pdfs.find(p => p && p.gcs_object === gcs_object);
          if (!entry) return send(res, 404, JSON.stringify({ error: 'pdf not listed on this quote' }), { 'Content-Type': 'application/json' });
          const file = gcsBucket.file(gcs_object);
          const [exists] = await file.exists();
          if (!exists) return send(res, 404, JSON.stringify({ error: 'object missing in storage' }), { 'Content-Type': 'application/json' });
          const safeName = safePdfFilename(entry.filename || gcs_object.split('/').pop() || 'quote.pdf');
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'inline; filename="' + safeName + '"',
            'Cache-Control': 'private, max-age=300',
          });
          file.createReadStream().on('error', e => {
            console.error('[api/quotes][download-pdf] stream FAIL:', e.message);
            try { res.destroy(); } catch (_) {}
          }).pipe(res);
        } catch (e) {
          console.error('[api/quotes][download-pdf] FAIL:', e.message);
          send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
        }
      })();
      return;
    }
  }

  // DELETE /api/quotes/:id/pdfs/:b64
  {
    const m = pathname.match(/^\/api\/quotes\/([A-Za-z0-9_-]+)\/pdfs\/([A-Za-z0-9_\-=]+)$/);
    if (req.method === 'DELETE' && m) {
      const id = m[1];
      const b64 = m[2];
      if (!firestore) return send(res, 503, JSON.stringify({ error: 'firestore unavailable' }), { 'Content-Type': 'application/json' });
      if (!gcsBucket) return send(res, 503, JSON.stringify({ error: 'gcs unavailable' }), { 'Content-Type': 'application/json' });
      (async () => {
        try {
          const gcs_object = b64urlDecode(b64);
          if (!gcs_object || !gcs_object.startsWith(id + '/') || gcs_object.indexOf('..') !== -1) {
            return send(res, 400, JSON.stringify({ error: 'invalid object key' }), { 'Content-Type': 'application/json' });
          }
          const ref = firestore.collection(QUOTES_COLLECTION).doc(id);
          const snap = await ref.get();
          if (!snap.exists) return send(res, 404, JSON.stringify({ error: 'not found' }), { 'Content-Type': 'application/json' });
          const data = snap.data() || {};
          const pdfs = data.uploaded_pdfs || [];
          if (!pdfs.find(p => p && p.gcs_object === gcs_object)) {
            return send(res, 404, JSON.stringify({ error: 'pdf not listed' }), { 'Content-Type': 'application/json' });
          }
          await gcsBucket.file(gcs_object).delete({ ignoreNotFound: true });
          const remaining = pdfs.filter(p => !p || p.gcs_object !== gcs_object);
          await ref.update({ uploaded_pdfs: remaining, modified_at: new Date().toISOString() });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.error('[api/quotes][delete-pdf] FAIL:', e.message);
          send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
        }
      })();
      return;
    }
  }

  // POST /api/quotes/create-from-pdf — multipart: pdf + customer_name (+ optional label)
  if (req.method === 'POST' && pathname === '/api/quotes/create-from-pdf') {
    if (!firestore) return send(res, 503, JSON.stringify({ error: 'firestore unavailable' }), { 'Content-Type': 'application/json' });
    if (!gcsBucket) return send(res, 503, JSON.stringify({ error: 'gcs unavailable' }), { 'Content-Type': 'application/json' });
    (async () => {
      try {
        const author = getAuthUser(req);
        let parsed;
        try { parsed = await readSinglePdfMultipart(req); }
        catch (e) { return send(res, 400, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' }); }
        if (!parsed.file || !parsed.file.buffer || !parsed.file.buffer.length) {
          return send(res, 400, JSON.stringify({ error: 'no pdf field' }), { 'Content-Type': 'application/json' });
        }
        const buf = parsed.file.buffer;
        if (buf.length < 4 || buf.slice(0,4).toString('ascii') !== '%PDF') {
          return send(res, 400, JSON.stringify({ error: 'not a PDF (missing %PDF magic)' }), { 'Content-Type': 'application/json' });
        }
        const customer_name = String(parsed.fields.customer_name || '').trim();
        if (!customer_name) return send(res, 400, JSON.stringify({ error: 'customer_name required' }), { 'Content-Type': 'application/json' });
        const label = String(parsed.fields.label || '').trim();
        const id = genQuoteId();
        const now = new Date().toISOString();
        const safe = safePdfFilename(parsed.file.filename);
        const ts = now.replace(/[:.]/g, '-');
        const gcs_object = id + '/' + ts + '_' + safe;
        const gcs_uri = 'gs://' + PDF_BUCKET + '/' + gcs_object;
        await gcsBucket.file(gcs_object).save(buf, {
          resumable: false,
          contentType: 'application/pdf',
          metadata: { contentType: 'application/pdf', cacheControl: 'private, max-age=86400' },
        });
        const state = {
          customer: { name: customer_name, salutation: '', address: '' },
          build: {},
          pricing: {},
          rows: [],
          scope: 'full',
          _isFreshQuote: false,
          quoteId: id,
          notes: 'Created from uploaded PDF. See attachment for details.',
        };
        const name = label || (customer_name + ' — PDF — ' + now.slice(0,10));
        const doc = {
          id,
          name,
          customer_name,
          author,
          last_edited_by: author,
          created_at: now,
          modified_at: now,
          row_count: 0,
          state,
          pdf_is_authoritative: true,
          uploaded_pdfs: [{
            filename: parsed.file.filename || safe,
            gcs_object,
            gcs_uri,
            uploaded_by: author,
            uploaded_at: now,
            size_bytes: buf.length,
            content_type: 'application/pdf',
          }],
        };
        await firestore.collection(QUOTES_COLLECTION).doc(id).set(doc);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id, name }));
      } catch (e) {
        console.error('[api/quotes][create-from-pdf] FAIL:', e.message);
        send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
      }
    })();
    return;
  }

  // ============================================================================
  // Phase 9H (2026-06-03): self-serve password change + admin password reset.
  // ============================================================================
  // GET  /api/auth/me                      -> { username, role, password_changed_at }
  // POST /api/auth/change-password         -> { current_password, new_password }
  // POST /api/auth/admin/reset-password    -> admin-only: { username, new_password }
  // GET  /api/auth/users                   -> admin-only: list of users (firestore + env)
  //
  // Backed by Firestore `users` collection. Env-var fallback preserved for
  // legacy / unmigrated reps so the cutover is zero-downtime.

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    (async () => {
      try {
        const me = getAuthUser(req);
        const role = await _resolveUserRole(me);
        const doc = await _getUserDoc(me);
        const password_changed_at = doc && doc.password_changed_at ? doc.password_changed_at : null;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ username: me, role, password_changed_at }));
      } catch (e) {
        console.error('[api/auth/me] FAIL:', e.message);
        send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
      }
    })();
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/change-password') {
    (async () => {
      try {
        if (!firestore) return send(res, 503, JSON.stringify({ error: 'firestore unavailable' }), { 'Content-Type': 'application/json' });
        if (!bcrypt) return send(res, 503, JSON.stringify({ error: 'bcrypt unavailable' }), { 'Content-Type': 'application/json' });
        const me = getAuthUser(req);
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') return send(res, 400, JSON.stringify({ error: 'body required' }), { 'Content-Type': 'application/json' });
        const cur = (body.current_password || '').toString();
        const next = (body.new_password || '').toString();
        if (!cur) return send(res, 400, JSON.stringify({ error: 'current_password required' }), { 'Content-Type': 'application/json' });
        if (!next || next.length < 6) return send(res, 400, JSON.stringify({ error: 'new_password must be at least 6 characters' }), { 'Content-Type': 'application/json' });
        if (next.length > 100) return send(res, 400, JSON.stringify({ error: 'new_password too long (max 100)' }), { 'Content-Type': 'application/json' });
        if (cur === next) return send(res, 400, JSON.stringify({ error: 'new_password must differ from current' }), { 'Content-Type': 'application/json' });
        // Re-verify the current password (defense in depth — header already passed requireAuth,
        // but the request body might supply a different "current_password" than the header).
        const verified = await _verifyPassword(me, cur);
        if (!verified) return send(res, 400, JSON.stringify({ error: 'current_password incorrect' }), { 'Content-Type': 'application/json' });
        const hash = await bcrypt.hash(next, 10);
        const now = new Date().toISOString();
        const role = await _resolveUserRole(me);
        const ref = firestore.collection(USERS_COLLECTION).doc(me);
        const existing = await ref.get();
        const doc = {
          username: me,
          password_hash: hash,
          password_changed_at: now,
          password_changed_by: 'self',
          role: (existing.exists && existing.data().role) || role,
          active: true,
        };
        if (!existing.exists) doc.created_at = now;
        await ref.set(doc, { merge: true });
        _invalidateUserCache(me);
        console.log('[auth] password changed by self for', me);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('[api/auth/change-password] FAIL:', e.message);
        send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
      }
    })();
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/admin/reset-password') {
    (async () => {
      try {
        if (!firestore) return send(res, 503, JSON.stringify({ error: 'firestore unavailable' }), { 'Content-Type': 'application/json' });
        if (!bcrypt) return send(res, 503, JSON.stringify({ error: 'bcrypt unavailable' }), { 'Content-Type': 'application/json' });
        const caller = getAuthUser(req);
        const callerRole = await _resolveUserRole(caller);
        if (callerRole !== 'admin') return send(res, 403, JSON.stringify({ error: 'admin required' }), { 'Content-Type': 'application/json' });
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') return send(res, 400, JSON.stringify({ error: 'body required' }), { 'Content-Type': 'application/json' });
        const username = (body.username || '').toString().trim();
        const next = (body.new_password || '').toString();
        if (!username || !/^[a-z0-9_-]{2,40}$/i.test(username)) return send(res, 400, JSON.stringify({ error: 'invalid username (allowed: a-z, 0-9, _, -, 2-40 chars)' }), { 'Content-Type': 'application/json' });
        if (!next || next.length < 6) return send(res, 400, JSON.stringify({ error: 'new_password must be at least 6 characters' }), { 'Content-Type': 'application/json' });
        if (next.length > 100) return send(res, 400, JSON.stringify({ error: 'new_password too long (max 100)' }), { 'Content-Type': 'application/json' });
        const hash = await bcrypt.hash(next, 10);
        const now = new Date().toISOString();
        const ref = firestore.collection(USERS_COLLECTION).doc(username);
        const existing = await ref.get();
        const role = (existing.exists && existing.data().role) || (_isHardcodedAdmin(username) ? 'admin' : 'rep');
        const doc = {
          username,
          password_hash: hash,
          password_changed_at: now,
          password_changed_by: 'admin:' + caller,
          role,
          active: true,
        };
        if (!existing.exists) doc.created_at = now;
        await ref.set(doc, { merge: true });
        _invalidateUserCache(username);
        console.log('[auth] password reset by admin ' + caller + ' for ' + username);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, username }));
      } catch (e) {
        console.error('[api/auth/admin/reset-password] FAIL:', e.message);
        send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
      }
    })();
    return;
  }

  if (req.method === 'GET' && pathname === '/api/auth/users') {
    (async () => {
      try {
        const caller = getAuthUser(req);
        const callerRole = await _resolveUserRole(caller);
        if (callerRole !== 'admin') return send(res, 403, JSON.stringify({ error: 'admin required' }), { 'Content-Type': 'application/json' });
        const fsUsers = new Map();
        if (firestore) {
          try {
            const snap = await firestore.collection(USERS_COLLECTION).get();
            snap.docs.forEach(d => {
              const data = d.data() || {};
              fsUsers.set(d.id, {
                username: d.id,
                role: data.role || 'rep',
                password_changed_at: data.password_changed_at || null,
                password_changed_by: data.password_changed_by || null,
                active: data.active !== false,
                source: 'firestore',
              });
            });
          } catch (e) { console.warn('[api/auth/users] firestore list failed:', e.message); }
        }
        const envUsers = _loadAuthUsers() || {};
        Object.keys(envUsers).forEach(u => {
          if (!fsUsers.has(u)) {
            fsUsers.set(u, {
              username: u,
              role: _isHardcodedAdmin(u) ? 'admin' : 'rep',
              password_changed_at: null,
              password_changed_by: null,
              active: true,
              source: 'env',
            });
          }
        });
        const items = Array.from(fsUsers.values()).sort((a, b) => a.username.localeCompare(b.username));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ items }));
      } catch (e) {
        console.error('[api/auth/users] FAIL:', e.message);
        send(res, 500, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
      }
    })();
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
  })().catch(e => {
    // Phase 9H: top-level handler safety net — never leak an unhandled
    // rejection. Most async branches already have their own try/catch;
    // this is the last line of defense.
    console.error('[server] async handler error:', e && e.message);
    try { send(res, 500, 'internal error'); } catch (_) { /* res may already be ended */ }
  });
});

// Phase 9H (2026-06-03): one-shot idempotent migration of env-var users into
// Firestore. Runs once per cold boot; safe to run repeatedly because we only
// write a doc if it doesn't already exist.
async function _migrateEnvUsersToFirestore() {
  if (!firestore || !bcrypt) {
    console.warn('[migration] skipped — firestore or bcrypt unavailable');
    return;
  }
  const users = _loadAuthUsers() || {};
  const names = Object.keys(users);
  if (names.length === 0) { console.log('[migration] no env users to migrate'); return; }
  let migrated = 0, skipped = 0, failed = 0;
  for (const u of names) {
    try {
      const ref = firestore.collection(USERS_COLLECTION).doc(u);
      const snap = await ref.get();
      if (snap.exists) { skipped++; continue; }
      const hash = await bcrypt.hash(users[u], 10);
      const now = new Date().toISOString();
      await ref.set({
        username: u,
        password_hash: hash,
        password_changed_at: now,
        password_changed_by: 'system:migration',
        role: _isHardcodedAdmin(u) ? 'admin' : 'rep',
        active: true,
        created_at: now,
      });
      migrated++;
    } catch (e) {
      failed++;
      console.warn('[migration] user', u, 'FAILED:', e.message);
    }
  }
  console.log('[migration] users — migrated:', migrated, 'skipped:', skipped, 'failed:', failed);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ZuildUp Quotation Builder listening on http://0.0.0.0:${PORT}`);
  console.log(`  ROOT = ${ROOT}`);
  console.log(`  open  http://127.0.0.1:${PORT}/`);
  // Kick off the migration in the background — don't block startup probe.
  _migrateEnvUsersToFirestore().catch(e => console.warn('[migration] FAIL:', e.message));
});
