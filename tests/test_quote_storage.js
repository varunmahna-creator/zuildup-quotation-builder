/* P1.5 — QuoteStorage unit tests (Node, no browser).
 *
 * Loads app/quote.js in a stubbed-browser vm sandbox. The renderer/IIFE detects
 * "is this the form page" via document.getElementById('spec-list'); we stub
 * everything to return null so neither bootForm nor bootPreview fires.
 * QuoteStorage is exposed on window via the test hook.
 *
 * Run: node tests/test_quote_storage.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const QUOTE_JS = fs.readFileSync(path.join(__dirname, '..', 'app', 'quote.js'), 'utf8');

// ----------------------------------------------------------------------------
// localStorage shim
// ----------------------------------------------------------------------------
function makeLocalStorage() {
  const data = new Map();
  return {
    getItem(k)        { return data.has(k) ? data.get(k) : null; },
    setItem(k, v)     { data.set(String(k), String(v)); },
    removeItem(k)     { data.delete(k); },
    clear()           { data.clear(); },
    key(i)            { return Array.from(data.keys())[i] ?? null; },
    get length()      { return data.size; },
    _dump()           { return Object.fromEntries(data); },
  };
}

function makeSandbox() {
  const localStorage = makeLocalStorage();
  const document = {
    // Force IIFE to skip both bootForm and bootPreview
    getElementById() { return null; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const window = {
    addEventListener() {},
    dispatchEvent() {},
  };
  const sandbox = {
    window, document, localStorage,
    fetch: () => Promise.reject(new Error('fetch not available in test')),
    setInterval: () => 0,
    setTimeout: (fn, ms) => 0,
    Event: class Event { constructor(name) { this.name = name; } },
    console,
  };
  // Self-reference for `window.foo = ...` patterns the IIFE uses
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(QUOTE_JS, sandbox);
  return sandbox;
}

// ----------------------------------------------------------------------------
// Test utilities
// ----------------------------------------------------------------------------
let passes = 0, fails = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passes++;
  } catch (e) {
    console.log(`  [FAIL] ${name} — ${e.message}`);
    failures.push({ name, err: e });
    fails++;
  }
}
function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label || 'assertEqual'}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}
function assert(cond, label) {
  if (!cond) throw new Error(`assert failed: ${label || ''}`);
}

// ----------------------------------------------------------------------------
// Fixture state
// ----------------------------------------------------------------------------
function fixtureState(name = 'Aanya Kapoor', rowCount = 3) {
  return {
    customer: { salutation: 'Ms.', name, address: 'Plot 14, Sector 47, Gurugram', phone: '' },
    build: {
      plotSqYards: 240, breadth: 36, coverage: 75,
      buildType: 'stilt', floors: 4, hasBasement: false, hasLift: false,
    },
    pricing: { costPerSqft: 2850, structureRate: null },
    scope: 'full',
    rows: Array.from({length: rowCount}, (_, i) => ({
      id: 'cat.item' + i,
      override: { rate: 1000 * (i + 1), rate_text: '₹' + (1000 * (i + 1)) + '/sqft' },
    })),
    notes: 'Fixture quote for tests.',
    quoteId: 'ZB-FIXTURE',
    createdAt: '2026-04-29',
  };
}

// ----------------------------------------------------------------------------
// Run tests
// ----------------------------------------------------------------------------
console.log('P1.5 QuoteStorage unit tests');
console.log('============================');

let env;

function freshEnv() {
  env = makeSandbox();
  if (!env.window.QuoteStorage) {
    throw new Error('QuoteStorage not exposed on window — quote.js may have wedged on bootForm/bootPreview');
  }
}

// T1 — save → list shows it
test('T1. save → list shows new entry', () => {
  freshEnv();
  const QS = env.window.QuoteStorage;
  const id = QS.save(fixtureState('Test One'));
  assert(id && id.startsWith('q_'), 'save returned valid id');
  const list = QS.list();
  assertEqual(list.length, 1, 'list length');
  assertEqual(list[0].customer_name, 'Test One', 'list entry customer_name');
  assertEqual(list[0].row_count, 3, 'list entry row_count');
  assert(list[0].id === id, 'list entry id matches');
});

// T2 — save → load → state byte-identical (after normalising volatile fields)
test('T2. save → load → state byte-identical', () => {
  freshEnv();
  const QS = env.window.QuoteStorage;
  const orig = fixtureState('Roundtrip');
  const id = QS.save(orig);
  const loaded = QS.load(id);
  assert(loaded, 'load returns object');
  // The saved copy gets quoteId, createdAt, modifiedAt assigned. Strip those for byte-compare.
  const stripVolatile = (s) => {
    const c = JSON.parse(JSON.stringify(s));
    delete c.quoteId; delete c.createdAt; delete c.modifiedAt;
    return c;
  };
  const a = JSON.stringify(stripVolatile(orig));
  const b = JSON.stringify(stripVolatile(loaded));
  if (a !== b) {
    throw new Error(`roundtrip mismatch:\n  orig: ${a}\n  load: ${b}`);
  }
  // And the saved id is what we got back
  assertEqual(loaded.quoteId, id, 'loaded quoteId == id');
});

// T3 — save A, save B, list returns both newest-first
test('T3. multi-save list ordering newest-first', () => {
  freshEnv();
  const QS = env.window.QuoteStorage;
  const idA = QS.save(fixtureState('Alpha'));
  // Force a tick so modified_at differs
  const realDateNow = Date.now;
  let off = 0;
  Date.now = () => realDateNow() + (++off * 100);
  const idB = QS.save(fixtureState('Bravo'));
  Date.now = realDateNow;
  const list = QS.list();
  assertEqual(list.length, 2, 'two entries');
  assertEqual(list[0].id, idB, 'newest first (Bravo)');
  assertEqual(list[1].id, idA, 'older second (Alpha)');
});

// T4 — delete → no longer in list, load returns null
test('T4. delete removes from list and storage', () => {
  freshEnv();
  const QS = env.window.QuoteStorage;
  const id = QS.save(fixtureState('Doomed'));
  assertEqual(QS.list().length, 1);
  QS.delete(id);
  assertEqual(QS.list().length, 0, 'list empty after delete');
  assert(QS.load(id) === null, 'load returns null after delete');
});

// T5 — duplicate → new id, same content (but different created_at)
test('T5. duplicate creates new slot with cloned content', () => {
  freshEnv();
  const QS = env.window.QuoteStorage;
  const idA = QS.save(fixtureState('Original'));
  const idB = QS.duplicate(idA);
  assert(idA !== idB, 'new id differs');
  const a = QS.load(idA), b = QS.load(idB);
  // Compare row counts + customer name (the duplicate keeps content)
  assertEqual(a.rows.length, b.rows.length, 'rows preserved');
  assertEqual(a.customer.name, b.customer.name, 'customer name preserved');
  // List should have both, with the dup name suffixed
  const list = QS.list();
  assertEqual(list.length, 2);
  const dupEntry = list.find(e => e.id === idB);
  assert(dupEntry.name.includes('(copy)'), 'dup name has (copy) suffix: ' + dupEntry.name);
});

// T6 — exportJSON → importJSON roundtrip preserves state
test('T6. export → import roundtrip preserves state', () => {
  freshEnv();
  const QS = env.window.QuoteStorage;
  const idA = QS.save(fixtureState('Exportable'));
  const json = QS.exportJSON(idA);
  // Now wipe and re-import into a clean env
  freshEnv();
  const QS2 = env.window.QuoteStorage;
  const idB = QS2.importJSON(json);
  assert(idB && idB.startsWith('q_'), 'import returned new id');
  const reimported = QS2.load(idB);
  assertEqual(reimported.customer.name, 'Exportable', 'customer survived roundtrip');
  assertEqual(reimported.rows.length, 3, 'rows survived roundtrip');
  assertEqual(reimported.rows[1].override.rate, 2000, 'override rate survived');
});

// T7 — importJSON with invalid shape throws
test('T7. importJSON rejects invalid shapes', () => {
  freshEnv();
  const QS = env.window.QuoteStorage;
  const cases = [
    { input: 'not json',                     reason: 'not JSON' },
    { input: 'null',                         reason: 'null' },
    { input: '{}',                           reason: 'empty object' },
    { input: '{"customer":{},"build":{}}',   reason: 'missing pricing+rows' },
    { input: '{"customer":{},"build":{},"pricing":{},"rows":"nope"}', reason: 'rows not array' },
  ];
  for (const c of cases) {
    let threw = false;
    try { QS.importJSON(c.input); } catch (_) { threw = true; }
    if (!threw) throw new Error('expected throw for: ' + c.reason);
  }
});

// T8 — size returns reasonable byte count
test('T8. size returns reasonable byte count', () => {
  freshEnv();
  const QS = env.window.QuoteStorage;
  const before = QS.size();
  assert(typeof before === 'number' && before >= 0, 'size is non-negative number');
  QS.save(fixtureState('Sized'));
  const after = QS.size();
  assert(after > before, `size grew after save: ${before} -> ${after}`);
  // Sanity: a 3-row quote should be at least a few hundred bytes
  assert(after > 200, 'size > 200 bytes after a real save');
});

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------
console.log('');
console.log(`=== ${passes} PASS, ${fails} FAIL ===`);
if (fails > 0) {
  for (const f of failures) console.log(`  ! ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}
process.exit(0);
