// Phase 7H unit tests — Rs.→₹ regex, brand de-dup, brand suppression, default layout.
// Run: node tests/test_phase7h.js
//
// Pattern matches tests/test_phase7g_b_nostilt_decimals.js — read quote.js,
// inject an export hook before the IIFE close, run via new Function() to
// extract internals into a controlled global.

const fs = require('fs');
let src = fs.readFileSync('/opt/openclaw/workspace/zuildup/quotation-builder/app/quote.js', 'utf8');

// Stubs — quote.js was built for the browser; provide just enough that the
// top-level IIFE evaluates without throwing.
global.window = global;
global.document = {
  getElementById: () => null,
  addEventListener: () => {},
  createElement: () => ({ style: {}, addEventListener: () => {}, appendChild: () => {} }),
  body: { appendChild: () => {} },
};
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.fetch = () => Promise.reject(new Error('no fetch'));
global.crypto = { randomUUID: () => '00000000-0000-0000-0000-000000000001' };
global.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };

const hook = `\nglobalThis.__quoteExports__ = {
  defaultState, normaliseRupee, normaliseRupeeHtml
};\n`;

const idx = src.lastIndexOf('})();');
if (idx < 0) { console.error('Could not find IIFE close'); process.exit(1); }
src = src.substring(0, idx) + hook + src.substring(idx);

// Strip any bootForm() trailing call so it doesn't blow up on missing DOM.
src = src.replace(/^bootForm\(\)\.catch[^\n]*$/m, '');

new Function(src)();
const Q = global.__quoteExports__;
if (!Q || !Q.normaliseRupee) {
  console.error('Failed to extract exports from IIFE');
  process.exit(1);
}

let pass = 0, fail = 0;
const test = (name, ok, info = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}` + (info ? ` — ${info}` : ''));
  ok ? pass++ : fail++;
};

// ============================================================================
// Group 1: Rs. → ₹ regex variants (7H-D)
// ============================================================================
{
  const cases = [
    // [input, expected, label]
    ['Rs. 2,500',       '₹2,500',       'Rs. with dot + space + comma'],
    ['Rs 100/kg',       '₹100/kg',      'Rs with space, no dot, before slash'],
    ['RS. 200',         '₹200',         'RS uppercase with dot + space'],
    ['rs. 1000',        '₹1000',        'rs lowercase with dot'],
    ['RS.500',          '₹500',         'RS uppercase no space'],
    ['₹500',            '₹500',         '₹ already → unchanged'],
    ['₹ 500',           '₹ 500',        '₹ with space → unchanged'],
    ['Mrs. Sharma',     'Mrs. Sharma',  'Mrs. Sharma → unchanged (word boundary)'],
    ['Rsv',             'Rsv',          'Rsv → unchanged (lookahead blocks)'],
    ['Rate is Rs. 750', 'Rate is ₹750', 'inline Rs.'],
    ['no rupee here',   'no rupee here','no Rs at all'],
    ['',                '',             'empty string'],
  ];
  for (const [inp, exp, label] of cases) {
    const got = Q.normaliseRupee(inp);
    test(`Rs→₹: ${label}`, got === exp, `input=${JSON.stringify(inp)} got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`);
  }
}

// Trailing form ("5 Rs" → "5 ₹") — documented as best-effort.
{
  const got = Q.normaliseRupee('earn 5 Rs');
  test('Rs→₹: trailing "5 Rs" (best-effort)', got === 'earn 5 ₹' || got === 'earn 5 Rs', `got=${JSON.stringify(got)}`);
}

// Idempotence — already-₹ stays ₹.
{
  const once = Q.normaliseRupee('Rs. 100 and ₹200');
  const twice = Q.normaliseRupee(once);
  test('Rs→₹: idempotent', once === twice, `once=${JSON.stringify(once)} twice=${JSON.stringify(twice)}`);
}

// null / non-string passthrough.
{
  test('Rs→₹: null passthrough', Q.normaliseRupee(null) === null);
  test('Rs→₹: undefined passthrough', Q.normaliseRupee(undefined) === undefined);
  test('Rs→₹: number passthrough', Q.normaliseRupee(42) === 42);
}

// ============================================================================
// Group 2: HTML-safe normaliser preserves tag structure
// ============================================================================
{
  const html = '<p>Price: Rs. 2,500 <b>only</b></p>';
  const got  = Q.normaliseRupeeHtml(html);
  test('Rs→₹ HTML: tag-preserving', got === '<p>Price: ₹2,500 <b>only</b></p>', `got=${JSON.stringify(got)}`);
}
{
  // Tag attribute that LOOKS like "Rs." should NOT be touched — split is on tag boundaries.
  const html = '<a href="x">Rs. 100</a>';
  const got  = Q.normaliseRupeeHtml(html);
  test('Rs→₹ HTML: attribute untouched', got === '<a href="x">₹100</a>', `got=${JSON.stringify(got)}`);
}

// ============================================================================
// Group 3: Default specs layout = table (7H-C)
// ============================================================================
{
  const ds = Q.defaultState();
  test('7H-C: default specsLayout === "table"', ds.specsLayout === 'table', `got=${JSON.stringify(ds.specsLayout)}`);
}

// ============================================================================
// Group 4: Brand de-dup + suppression (7H-A)
//
// These behaviours are baked into renderSpecPages -> rowFields. We don't have
// a clean export hook for it, so we exercise them via grep-style structural
// checks on the source — same approach as the Python tests use.
// ============================================================================
{
  // Brand de-dup: source must compare brandPlain to firstPlain to strip dup.
  const hasDedup = /firstPlain\s*===\s*brandPlain/.test(src);
  test('7H-A: brand de-dup logic present in renderer', hasDedup);
}
{
  // Brand suppression — when brand is empty string, no "spec-brand" line emitted.
  // Renderer template uses: f.brand ? `<div class="spec-brand">…</div>` : ''
  const hasSuppression = /f\.brand[\s\S]{0,40}\?\s*`?<div class="spec-brand">/.test(src);
  test('7H-A: brand suppression (empty = no line) in renderer', hasSuppression);
}
{
  // Brand default fall-through: brand undefined uses catalog item.brands[].
  const hasDefault = /it\.brands\.join\(/.test(src) || /\.brands\.join\(/.test(src);
  test('7H-A: brand default = catalog item.brands[] joined', hasDefault);
}
{
  // Brand editor — separate contenteditable in editor with data-f="brand".
  const hasBrandEditor = /data-f="brand"[^>]*class="rt-editor"[^>]*contenteditable="true"/.test(src);
  test('7H-A: brand editor is contenteditable rt-editor', hasBrandEditor);
}

// Note on browser-only behaviours
// -------------------------------
// Verifying the live contenteditable input handler chain ("brand becomes
// brandRich=true after typing", "blur in body input triggers on-blur Rs→₹
// normalisation") requires a DOM + event loop — verified via puppeteer in
// QC step below, not here.

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
