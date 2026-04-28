// ZuildUp Quotation Builder — local Node server.
// Responsibilities:
//   1. Serve index.html and assets (catalog, lookbook, css, js).
//   2. Receive a POST /pdf with the rendered preview HTML, return an A4 PDF blob.
//
// Run with:  node server.js   (listens on http://127.0.0.1:8124)

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');
const { spawn } = require('child_process');
const os   = require('os');

const PORT  = process.env.PORT || 8124;
const ROOT  = path.resolve(__dirname, '..');           // /tmp/qb (or canonical workspace)
const APP   = path.resolve(__dirname);                 // /tmp/qb/app

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

function renderPdf(html, cb) {
  // Drop the supplied HTML into a temp file, run Chrome headless --print-to-pdf, return the bytes.
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'zu-quote-'));
  const tmpHtml = path.join(tmpDir, 'render.html');
  const tmpPdf  = path.join(tmpDir, 'render.pdf');
  fs.writeFileSync(tmpHtml, html);
  const args = [
    '--headless','--no-sandbox','--disable-gpu','--hide-scrollbars',
    '--print-to-pdf-no-header',
    `--print-to-pdf=${tmpPdf}`,
    '--virtual-time-budget=8000',
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
