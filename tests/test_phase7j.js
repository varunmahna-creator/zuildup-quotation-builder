// Phase 7J — static-scan generalisation of the _isFresh invariant.
//
// Phase 7I patched defaultRowsFor() (the only catalog-seed helper that
// returns rows without _isFresh:true). The phase 7I unit test was too
// narrow — it only tested defaultRowsFor by name, with a regex that
// failed on nested {} in `override:{}`. This test:
//
//   (a) statically scans app/quote.js for EVERY function whose name matches
//       /default.*Rows?|seed.*Rows?|build.*Rows?|.*SpecRows.*/ — and asserts
//       that the function body contains `_isFresh: true` literally.
//   (b) statically scans for every `state.rows.push({...})` and every
//       `cat.map(it => ({...}))` literal that produces a row, and asserts
//       the object has `_isFresh: true` set.
//   (c) confirms the _canDefault gate semantics are still in place
//       (row._isFresh === true || state._isFreshQuote === true).
//
// This generalisation guarantees that ANY future tier/scope seed helper
// added to the codebase will fail this test unless it carries the marker.
//
// Run: node tests/test_phase7j.js

const fs = require('fs');
const src = fs.readFileSync('/opt/openclaw/workspace/zuildup/quotation-builder/app/quote.js', 'utf8');

let pass = 0, fail = 0;
const test = (name, ok, info = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}` + (info ? ` — ${info}` : ''));
  ok ? pass++ : fail++;
};

// ----------------------------------------------------------------------------
// Helper: extract the body of a top-level `function NAME(...) { ... }` by
// brace-matching from the opening brace forwards.
// ----------------------------------------------------------------------------
function extractFunctionBody(source, fnName) {
  const re = new RegExp('function\\s+' + fnName + '\\s*\\([^)]*\\)\\s*\\{');
  const m = source.match(re);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return source.slice(m.index, i);
}

// ----------------------------------------------------------------------------
// (a) Static scan: every catalog-seed helper function must contain _isFresh:true
// ----------------------------------------------------------------------------
{
  // Find every top-level function whose name matches our seed-helper patterns.
  const fnPattern = /function\s+((?:default|seed|build)[A-Za-z]*Rows[A-Za-z]*|[A-Za-z]*SpecRows[A-Za-z]*)\s*\(/g;
  const found = new Set();
  let mm;
  while ((mm = fnPattern.exec(src)) !== null) {
    found.add(mm[1]);
  }
  test('7J: at least one seed-helper function exists in app/quote.js',
       found.size > 0, `found=[${[...found].join(', ')}]`);

  for (const name of found) {
    const body = extractFunctionBody(src, name);
    test(`7J: helper "${name}" body extractable`, !!body);
    if (body) {
      const hasFresh = /_isFresh\s*:\s*true/.test(body);
      test(`7J: helper "${name}" stamps _isFresh: true on returned/pushed rows`,
           hasFresh, hasFresh ? '' : `body head=${body.substring(0, 300)}`);
    }
  }
}

// ----------------------------------------------------------------------------
// (b) Static scan: every `state.rows.push({ ... })` literal where the pushed
//     row references `it.id` (catalog seed) must contain _isFresh: true.
//
//     We intentionally DO NOT require it on `state.rows.push({ id, _custom: true, ...})`
//     — custom blank rows have no catalog entry to fall back to, so the
//     _canDefault gate never fires for them.
// ----------------------------------------------------------------------------
{
  const pushRe = /state\.rows\.push\s*\(\s*\{/g;
  let mm;
  let catalogPushes = 0;
  let stamped = 0;
  let unstamped = [];
  while ((mm = pushRe.exec(src)) !== null) {
    let i = mm.index + mm[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    const obj = src.substring(mm.index + mm[0].length - 1, i);
    // Catalog seed signature: references `it.id` (loop var)
    const isCatalogSeed = /\bit\.id\b/.test(obj);
    if (!isCatalogSeed) continue;
    catalogPushes++;
    if (/_isFresh\s*:\s*true/.test(obj)) {
      stamped++;
    } else {
      const lineNo = src.substring(0, mm.index).split('\n').length;
      unstamped.push(`line ${lineNo}: ${obj.replace(/\s+/g, ' ').substring(0, 120)}`);
    }
  }
  test('7J: catalog-seed state.rows.push sites found',
       catalogPushes > 0, `count=${catalogPushes}`);
  test('7J: every catalog-seed state.rows.push stamps _isFresh: true',
       stamped === catalogPushes,
       stamped === catalogPushes
         ? `${stamped}/${catalogPushes} stamped`
         : `unstamped=${unstamped.join(' | ')}`);
}

// ----------------------------------------------------------------------------
// (c) Static scan: every `cat.map(it => ({ ... }))` that returns a row must
//     stamp _isFresh: true. This catches the original 7I bug class.
// ----------------------------------------------------------------------------
{
  const mapRe = /cat\.map\(\s*it\s*=>\s*\(\s*\{/g;
  let mm;
  let count = 0;
  let stamped = 0;
  let unstamped = [];
  while ((mm = mapRe.exec(src)) !== null) {
    let i = mm.index + mm[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    const obj = src.substring(mm.index + mm[0].length - 1, i);
    count++;
    if (/_isFresh\s*:\s*true/.test(obj)) stamped++;
    else {
      const lineNo = src.substring(0, mm.index).split('\n').length;
      unstamped.push(`line ${lineNo}: ${obj.replace(/\s+/g, ' ').substring(0, 120)}`);
    }
  }
  test('7J: cat.map(it => ({...})) catalog-seed expressions found',
       count > 0, `count=${count}`);
  test('7J: every cat.map(it => ({...})) stamps _isFresh: true',
       stamped === count,
       stamped === count
         ? `${stamped}/${count} stamped`
         : `unstamped=${unstamped.join(' | ')}`);
}

// ----------------------------------------------------------------------------
// (d) Render gate semantics
// ----------------------------------------------------------------------------
{
  const hasRowFlag = /row\._isFresh\s*===\s*true/.test(src);
  const hasQuoteFlag = /state\._isFreshQuote\s*===\s*true/.test(src);
  test('7J: render _canDefault gate still checks row._isFresh === true', hasRowFlag);
  test('7J: render _canDefault gate still checks state._isFreshQuote === true', hasQuoteFlag);
}

// ----------------------------------------------------------------------------
// (e) Document presence/absence of named helpers (per QC findings doc).
// ----------------------------------------------------------------------------
{
  const expected = ['defaultRowsFor'];
  const forbidden = ['defaultSpecRowsForStructure', 'seedStructureRows', 'buildStructureSpecs',
                     'defaultRowsForSilver', 'defaultRowsForGold', 'defaultRowsForPlatinum'];
  for (const name of expected) {
    test(`7J: expected helper "${name}" exists`,
         new RegExp('function\\s+' + name + '\\s*\\(').test(src));
  }
  for (const name of forbidden) {
    test(`7J: no phantom helper "${name}" (would silently bypass invariant)`,
         !new RegExp('function\\s+' + name + '\\s*\\(').test(src));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
