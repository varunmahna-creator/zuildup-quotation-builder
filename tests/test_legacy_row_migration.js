// Phase 7I migration unit test — _migrateLegacyRows heals legacy localStorage
// rows that lack the _isFresh flag.
//
// Run: node tests/test_legacy_row_migration.js

const fs = require('fs');

const QUOTE_JS = '/opt/openclaw/workspace/zuildup/quotation-builder/app/quote.js';
const CATALOG  = '/opt/ocplatform/workspace/zuildup/quotation-builder/catalog/catalog.json';

let src = fs.readFileSync(QUOTE_JS, 'utf8');
const CATALOG_JSON = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));

global.window = global;
global.document = {
  getElementById: () => null,
  addEventListener: () => {},
  createElement: () => ({ style: {}, addEventListener: () => {}, appendChild: () => {} }),
  body: { appendChild: () => {} },
};
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.fetch = () => Promise.reject(new Error('no fetch'));
global.crypto = { randomUUID: () => 'uuid-test' };
global.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };

const hook = `\nCATALOG = ${JSON.stringify(CATALOG_JSON)};\nglobalThis.__exp = { _migrateLegacyRows };\n`;
const idx = src.lastIndexOf('})();');
if (idx < 0) { console.error('IIFE close not found'); process.exit(1); }
src = src.substring(0, idx) + hook + src.substring(idx);
src = src.replace(/^\s*bootForm\(\);\s*$/m, '// bootForm() stripped for test');

try { new Function(src)(); } catch (e) {
  console.error('SRC EVAL ERROR:', e.message);
  process.exit(1);
}

const { _migrateLegacyRows } = globalThis.__exp;
if (typeof _migrateLegacyRows !== 'function') {
  console.error('_migrateLegacyRows not exported'); process.exit(1);
}

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log('OK  ', label, detail ? '- ' + detail : ''); pass++; }
  else    { console.log('FAIL', label, detail ? '- ' + detail : ''); fail++; }
}

// 1: legacy row gets _isFresh:true
{
  const out = _migrateLegacyRows([{ id: 'a', override: {} }]);
  check('legacy empty-override row stamped', out[0]._isFresh === true);
}
// 2: already-fresh left alone
{
  const out = _migrateLegacyRows([{ id: 'a', override: {}, _isFresh: true }]);
  check('already-fresh row left alone', out[0]._isFresh === true);
}
// 3: user-edited description preserved, no stamp
{
  const out = _migrateLegacyRows([{ id: 'a', override: { description: 'custom' } }]);
  check('edited row preserved (no _isFresh)', out[0]._isFresh === undefined && out[0].override.description === 'custom');
}
// 4: edited brand preserved
{
  const out = _migrateLegacyRows([{ id: 'a', override: { brand: '<b>X</b>' } }]);
  check('edited brand row preserved', out[0]._isFresh === undefined);
}
// 5: explicit empty-string description preserved (rep deliberately cleared)
{
  const out = _migrateLegacyRows([{ id: 'a', override: { description: '' } }]);
  check('explicit empty desc preserved', out[0]._isFresh === undefined && out[0].override.description === '');
}
// 6: undefined / null override values do NOT block migration
{
  const out = _migrateLegacyRows([
    { id: 'a', override: { description: undefined } },
    { id: 'b', override: { brand: null } },
  ]);
  check('undefined override migrated', out[0]._isFresh === true);
  check('null override migrated', out[1]._isFresh === true);
}
// 7: mixed batch
{
  const out = _migrateLegacyRows([
    { id: 'a', override: {} },
    { id: 'b', override: {}, _isFresh: true },
    { id: 'c', override: { description: 'edited' } },
    { id: 'd', override: { brand: 'X' } },
    { id: 'e', override: {} },
  ]);
  check('mixed: legacy a stamped', out[0]._isFresh === true);
  check('mixed: fresh b unchanged', out[1]._isFresh === true);
  check('mixed: edited c not stamped', out[2]._isFresh === undefined);
  check('mixed: edited d not stamped', out[3]._isFresh === undefined);
  check('mixed: legacy e stamped', out[4]._isFresh === true);
}
// 8: non-array input
{
  check('null rows returns null', _migrateLegacyRows(null) === null);
  check('undefined rows returns undefined', _migrateLegacyRows(undefined) === undefined);
}
// 9: row missing override key
{
  const out = _migrateLegacyRows([{ id: 'a' }]);
  check('missing override defensively migrated', out[0]._isFresh === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
