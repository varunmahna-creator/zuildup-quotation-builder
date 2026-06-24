#!/usr/bin/env node
/**
 * Phase 9I verification harness.
 * Loads app/quote.js inside a vm sandbox with a minimal DOM/localStorage stub
 * (no #spec-list / #preview-root so bootForm/bootPreview do NOT run), then
 * asserts the four Phase-9I invariants:
 *   (a) save() injects savedTotals
 *   (b) drift logic: live recompute != savedTotals.grandTotal when inputs change
 *   (c) save() throws CUSTOMER_MISMATCH on differing names without the opt
 *   (d) saveAsNewVersion() sets version = max+1 and SAME clientKey
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const QUOTE_JS = path.join(__dirname, '..', 'app', 'quote.js');
const code = fs.readFileSync(QUOTE_JS, 'utf8');

// ---- Minimal localStorage ----
function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    key: i => Array.from(m.keys())[i] || null,
    get length() { return m.size; },
    _dump: () => Object.fromEntries(m),
  };
}

// ---- Minimal document stub: getElementById returns null for everything so
//      neither bootForm() nor bootPreview() executes. ----
const documentStub = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style:{}, classList:{add(){},remove(){},toggle(){}}, appendChild(){}, setAttribute(){}, querySelector(){return null;}, querySelectorAll(){return [];}, addEventListener(){} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { firstElementChild: null, appendChild(){} },
};

const windowStub = {};
const sandbox = {
  document: documentStub,
  window: windowStub,
  localStorage: makeLocalStorage(),
  sessionStorage: makeLocalStorage(),
  location: { search: '', pathname: '/', hash: '', reload(){}, href: '' },
  history: { replaceState(){}, pushState(){} },
  fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  CustomEvent: function(){ return {}; },
  navigator: { userAgent: 'node' },
  URLSearchParams: URLSearchParams,
};
sandbox.globalThis = sandbox;
windowStub.QuoteStorage = undefined;
windowStub.dispatchEvent = () => {};
windowStub.addEventListener = () => {};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'quote.js' });

// Pull what we need off window (quote.js exposes these).
const QuoteStorage = sandbox.window.QuoteStorage;
const clientKeySlug = sandbox.window.clientKeySlug;
const computeFrozenTotals = sandbox.window.computeFrozenTotals;

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log('  PASS  ' + label); pass++; }
  else { console.log('  FAIL  ' + label); fail++; }
}

// Disable cloud sync so _apiPush is a no-op (fetch stub already returns !ok).
QuoteStorage._syncEnabled = false;

// Build a realistic-ish state. We don't need exact rupee values; the calc just
// needs to run and produce a number.
function mkState(name, plotSqYards) {
  return {
    customer: { salutation: 'Mr.', name: name, address: 'Test' },
    build: { plotSqYards: plotSqYards, breadth: 30, coverage: 65, buildType: 'stilt', floors: 4, hasBasement: false, hasLift: true, hasWaterTank: true },
    pricing: { costPerSqft: 2500, structureRate: 1500, zoneARate: null, zoneBRate: null, zoneCRate: null, zoneDRate: null, basementRate: null, liftCost: 500000, liftSqftPerLevel: null, staircaseSqftPerLevel: null, zoneLineItems: {}, itemNameOverrides: {}, itemDescOverrides: {}, floorSummaryOverrides: {}, itemRates: {} },
    scope: 'full',
    rows: [{ id: 'x', override: {}, _isFresh: true }],
    areaOverrides: {},
    notes: '', draft: false,
    quoteId: '',
  };
}

console.log('=== Phase 9I verify_fixes.js ===\n');

// (a) save() injects savedTotals
console.log('(a) save() injects savedTotals snapshot');
const sA = mkState('Alpha Client', 200);
const idA = QuoteStorage.save(sA, 'Alpha Client');
const loadedA = QuoteStorage.load(idA);
assert(loadedA && loadedA.savedTotals && typeof loadedA.savedTotals.grandTotal === 'number' && loadedA.savedTotals.grandTotal > 0, 'savedTotals.grandTotal is a positive number');
assert(loadedA.savedTotals.schemaVer === 1, 'savedTotals.schemaVer === 1');
assert(typeof loadedA.savedTotals.computedAt === 'string', 'savedTotals.computedAt is set');

// (b) drift logic: change inputs after save -> live recompute differs from frozen
console.log('\n(b) drift detection: frozen total != recompute after spec change');
const frozen = loadedA.savedTotals.grandTotal;
const drifted = JSON.parse(JSON.stringify(loadedA));
drifted.build.plotSqYards = 400; // double the plot
const liveAfter = computeFrozenTotals(drifted).grandTotal;
assert(Math.abs(frozen - liveAfter) > 1, 'recompute (' + liveAfter + ') differs from frozen (' + frozen + ') by > 1');
// and when unchanged, no drift
const liveSame = computeFrozenTotals(loadedA).grandTotal;
assert(Math.abs(frozen - liveSame) <= 1, 'recompute with unchanged inputs matches frozen (<=1)');

// (c) save() throws CUSTOMER_MISMATCH on differing names without opt
console.log('\n(c) save() throws CUSTOMER_MISMATCH on cross-client overwrite');
// Re-load and mutate customer name, then attempt overwrite (same quoteId).
const sC = QuoteStorage.load(idA);
sC.quoteId = idA;
sC.customer = Object.assign({}, sC.customer, { name: 'Beta Different Client' });
let threw = false, code2 = '';
try { QuoteStorage.save(sC, undefined); }
catch (e) { threw = true; code2 = e.code; }
assert(threw && code2 === 'CUSTOMER_MISMATCH', 'overwrite with different customer throws CUSTOMER_MISMATCH');
// with allowCustomerChange it proceeds
let proceeded = false;
try { const r = QuoteStorage.save(sC, undefined, { allowCustomerChange: true }); proceeded = (r === idA); }
catch (e) { proceeded = false; }
assert(proceeded, 'overwrite proceeds with allowCustomerChange:true');

// (d) saveAsNewVersion sets version=max+1 and same clientKey
console.log('\n(d) saveAsNewVersion: version = max+1, same clientKey');
// Fresh client to avoid the rename above polluting the group.
const sD1 = mkState('Gamma Verma', 150);
const idD1 = QuoteStorage.save(sD1, 'Gamma Verma');
const d1 = QuoteStorage.load(idD1);
assert(d1.version === 1, 'first save is version 1 (got ' + d1.version + ')');
const ckExpected = clientKeySlug('Gamma Verma');
assert(d1.clientKey === ckExpected, 'clientKey === "' + ckExpected + '" (got "' + d1.clientKey + '")');
const idD2 = QuoteStorage.saveAsNewVersion(idD1);
const d2 = QuoteStorage.load(idD2);
assert(d2.version === 2, 'saveAsNewVersion -> version 2 (got ' + d2.version + ')');
assert(d2.clientKey === ckExpected, 'new version keeps same clientKey (got "' + d2.clientKey + '")');
assert(idD2 !== idD1, 'new version has a distinct slot id');
const idD3 = QuoteStorage.saveAsNewVersion(idD2);
const d3 = QuoteStorage.load(idD3);
assert(d3.version === 3, 'second saveAsNewVersion -> version 3 (got ' + d3.version + ')');
assert(QuoteStorage.maxVersionFor(ckExpected) === 3, 'maxVersionFor === 3');

// bonus: clientKeySlug correctness
console.log('\n(e) clientKeySlug sanity');
assert(clientKeySlug('  Sohail & Vicky Dhir Ji ') === 'sohail-vicky-dhir-ji', 'slug strips punctuation + collapses spaces');
assert(clientKeySlug('') === '', 'empty name -> empty slug');

console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
