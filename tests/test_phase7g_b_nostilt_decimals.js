// Headless unit test — open IIFE, expose globals, run tests
const fs = require('fs');
let src = fs.readFileSync('/opt/openclaw/workspace/zuildup/quotation-builder/app/quote.js', 'utf8');

// Stubs
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

// Inject an export hook just before the closing })();
const injectionPoint = '\n})();\n';
const hook = `\nglobalThis.__quoteExports__ = {
  defaultState, calcPackage, calcStructure, buildFloorSummary,
  ni, niA, fmtINR, BALCONY_DEPTH, RAMP_DEPTH, C_RATE, LIFT_COST,
  STAIRCASE_PER_FLOOR, LIFT_PER_FLOOR, WATER_TANK_PER_FLOOR
};\n`;

const idx = src.lastIndexOf('})();');
if (idx < 0) { console.error('Could not find IIFE close'); process.exit(1); }
src = src.substring(0, idx) + hook + src.substring(idx);

// Strip bootForm() if present (might be inside IIFE)
src = src.replace(/^bootForm\(\)\.catch[^\n]*$/m, '');

// Run via Function() to get global scope
new Function(src)();
const Q = global.__quoteExports__;
if (!Q || !Q.calcPackage) {
  console.error('Failed to extract exports from IIFE');
  process.exit(1);
}

function makeState(overrides = {}) {
  const s = Q.defaultState();
  s.build = {
    ...s.build,
    buildType: 'nostilt',
    plotSqYards: 227.78,
    breadth: 25,
    coverage: 75,
    floors: 4,
    hasLift: true,
    hasBasement: false,
    hasWaterTank: true,
    ...overrides.build,
  };
  s.pricing = {
    ...s.pricing,
    costPerSqft: 2300,
    ...overrides.pricing,
  };
  return s;
}

let pass = 0, fail = 0;
const test = (name, ok, info = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}` + (info ? ` — ${info}` : ''));
  ok ? pass++ : fail++;
};

// T1
{
  const s = makeState();
  const c = Q.calcPackage(s);
  const balconyPerFloor = s.build.breadth * Q.BALCONY_DEPTH;
  const expected = (s.build.floors - 1) * balconyPerFloor;
  const balconyItem = c.zones.B.items.find(it => it.name === 'Balcony');
  test('T1 nostilt Zone B Balcony skips ground', balconyItem?.area === expected, `got ${balconyItem?.area} expected ${expected}`);
}

// T2
{
  const s = makeState();
  const c = Q.calcPackage(s);
  const summary = Q.buildFloorSummary(s, c);
  const gf = summary.find(r => r.label && r.label.toLowerCase().includes('ground'));
  const plotSqFt = s.build.plotSqYards * 9;
  const floorArea = plotSqFt * s.build.coverage / 100;
  const expectedOpen = (plotSqFt - floorArea) + (s.build.breadth * Q.RAMP_DEPTH);
  test('T2 nostilt Ground row semiCovered=0', gf?.semiCovered === 0, `got ${gf?.semiCovered}`);
  test('T2 nostilt Ground row open = setback+ramp', Math.abs((gf?.open || 0) - expectedOpen) < 0.001, `got ${gf?.open} expected ${expectedOpen}`);
}

// T3
{
  const s = makeState({ build: { buildType: 'stilt' } });
  const c = Q.calcPackage(s);
  const balconyPerFloor = s.build.breadth * Q.BALCONY_DEPTH;
  const expected = s.build.floors * balconyPerFloor;
  const balconyItem = c.zones.B.items.find(it => it.name === 'Balcony');
  test('T3 stilt mode Balcony unchanged', balconyItem?.area === expected, `got ${balconyItem?.area} expected ${expected}`);
}

// T4
{
  const s = makeState({ build: { buildType: 'structure' } });
  const c = Q.calcStructure(s);
  const summ = Q.buildFloorSummary(s, c);
  const gf = summ.find(r => r.label && r.label.toLowerCase().includes('ground'));
  test('T4 structure mode Ground row semiCovered=0', gf?.semiCovered === 0);
  test('T4 structure mode Ground row open=0', gf?.open === 0);
}

// T5
{
  const cases = [1556.5, 1736, 12345.678, 0];
  for (const n of cases) {
    const got = Q.niA(n);
    test(`T5 niA(${n}) has 2dp`, /\.\d{2}$/.test(got), `got "${got}"`);
  }
}

// T6
{
  const s = makeState({ pricing: { balconyPerFloor: { enabled: true, rates: [null, null, null, null] } } });
  const c = Q.calcPackage(s);
  const balcRows = c.zones.B.items.filter(it => /^Balcony/.test(it.name));
  test('T6 nostilt+per-floor-balcony skips ground', balcRows.length === s.build.floors - 1, `got ${balcRows.length} expected ${s.build.floors - 1}`);
}

// T7: non-integer floorArea preserved
{
  const s = makeState({ build: { plotSqYards: 220.5, breadth: 25, coverage: 73.5 } });
  const c = Q.calcPackage(s);
  const plotSqFt = 220.5 * 9;
  const floorArea = plotSqFt * 0.735;
  const expectedFirstFloorArea = floorArea - 25 - 125; // − lift − staircase
  test('T7 calcPackage preserves non-integer floorArea',
    Math.abs(c.zones.A.items[0].area - expectedFirstFloorArea) < 0.01,
    `got ${c.zones.A.items[0].area}, expected ~${expectedFirstFloorArea}`);
}

console.log(`\n${pass}/${pass+fail} unit checks passed`);
process.exit(fail > 0 ? 1 : 0);
