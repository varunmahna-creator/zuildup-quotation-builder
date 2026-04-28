"""Generator for app/quote.js — Phase 2 P0.2 rebuild.

Single-file emitter so we don't hit the Write-tool ~17 KB ceiling and we can keep
the file under version control as a real generator (rerun it = same output).
"""
import textwrap, sys

OUT_PATH = "/tmp/_quote_v2.js"

QUOTE_JS = r"""/* ZuildUp Quotation Builder — quote.js (Phase 2 P0.2)
 *
 * Loaded by both index.html (form) and preview.html (right-pane / PDF body).
 * State persists in localStorage under key 'zuildup.quote.v2' (v1 keys ignored).
 *
 * Calculator port: from canonical
 *   https://github.com/varunmahna-creator/zuildup-cost-calculator/blob/master/zuildup-cost-calculator.html
 * Three calculation modes mirroring the canonical:
 *   - 'stilt'     -> Stilt + N floors, package mode
 *   - 'nostilt'   -> Ground + N, package mode
 *   - 'structure' -> Structure-only mode, custom rate, no Zone C
 *
 * Schema change vs Phase 1: catalog items now have a single rate + brands
 * (no more rate.{premium,platinum,royale}). The cost-per-sqft entered on the
 * form drives Zone A cost; constants from the canonical are used for B/C/D/E.
 */

(function(){
'use strict';

const STORE_KEY = 'zuildup.quote.v2';

// ============================================================================
// Calculator constants (verbatim from zuildup-cost-calculator.html)
// ============================================================================
const C_RATE             = 600;       // Zone C — Terrace + Ramp + Setback (₹/sqft)
const D_RATE             = 1000;      // Reserved (canonical defines but Zone D in canonical is water-tank)
const LIFT_COST          = 1200000;   // Lift machine fixed cost (₹12,00,000)
const STRUCT_B_RATE      = 500;       // Structure-only mode Zone B fixed rate (₹/sqft)
const BASEMENT_RATE      = 2700;      // Zone E — Basement (₹/sqft)
const WATER_TANK_RATE    = 15;        // Zone D — Underground water tank (₹/litre)
const WATER_TANK_PER_FLOOR = 2000;    // Litres per floor
const BALCONY_DEPTH      = 5;         // ft
const RAMP_DEPTH         = 6;         // ft
const STAIRCASE_PER_FLOOR = 125;      // sqft per level
const LIFT_PER_FLOOR     = 25;        // sqft per level

// ============================================================================
// State
// ============================================================================
const defaultState = () => ({
  customer: {
    salutation: '',
    name: '',
    address: '',
  },
  // build geometry — drives the calculator
  build: {
    plotSqYards: 240,
    breadth: 36,                 // ft (front)
    coverage: 75,                // %
    buildType: 'stilt',          // 'stilt' | 'nostilt' | 'structure'
    floors: 4,                   // count above stilt OR ground depending on mode
    hasBasement: false,
    hasLift: false,
  },
  // pricing — team enters per quote
  // GST and liaisoning are intentionally NOT in the quote calculator.
  // Per ZuildUp practice they're handled outside this document in the
  // sales/commercial conversation. Canonical total = Σ(zones) + lift cost.
  pricing: {
    costPerSqft: null,           // ₹/sqft for Zone A (full-build modes)
    structureRate: null,         // ₹/sqft for structure-only mode
  },
  scope: 'full',                 // 'full' | 'structure_only'
  rows: [],                      // [{id, override:{label?, rate?, rate_text?, brands?, description?, location?}, _custom?:bool}]
  notes: '',
  quoteId: 'ZB-' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '-' + Math.random().toString(36).slice(2,6).toUpperCase(),
  createdAt: new Date().toISOString().slice(0,10),
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    // shallow-merge so newly-added fields get defaults
    const d = defaultState();
    return {
      ...d, ...s,
      customer: { ...d.customer, ...(s.customer||{}) },
      build:    { ...d.build,    ...(s.build||{})    },
      pricing:  { ...d.pricing,  ...(s.pricing||{})  },
    };
  } catch(e) { return defaultState(); }
}
function saveState(s) {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
  window.dispatchEvent(new Event('quote-state-changed'));
}

// ============================================================================
// Catalog
// ============================================================================
let CATALOG = null;
async function loadCatalog() {
  if (CATALOG) return CATALOG;
  const r = await fetch('/catalog/catalog.json');
  CATALOG = await r.json();
  return CATALOG;
}
function catalogItem(id) { return (CATALOG?.items || []).find(it => it.id === id); }
function defaultRowsFor(scope) {
  // Catalog has scope: ["full"] or ["full","structure_only"]
  const cat = (CATALOG?.items || []).filter(it => it.scope.includes(scope === 'structure_only' ? 'structure_only' : 'full'));
  return cat.map(it => ({ id: it.id, override: {} }));
}

// ============================================================================
// Calculator — verbatim port from canonical zuildup-cost-calculator.html
// ============================================================================
function computeQuote(state) {
  const bt = state.build.buildType;
  return bt === 'structure' ? calcStructure(state) : calcPackage(state);
}

function calcPackage(state) {
  const b = state.build, p = state.pricing;
  const hasStilt = b.buildType === 'stilt';
  const baseRate = parseInt(p.costPerSqft) || 0;     // user-entered ₹/sqft
  const bRate    = Math.round(baseRate * 0.50);

  const plotSqFt   = b.plotSqYards * 9;
  const depth      = b.breadth ? Math.round(plotSqFt / b.breadth) : 0;
  const floorArea  = Math.round(plotSqFt * b.coverage / 100);
  const numFloors  = b.floors;

  const staircaseLevels = numFloors + (hasStilt ? 1 : 0) + (b.hasBasement ? 1 : 0);
  const waterTankFloors = numFloors;

  // Zone A — main floors + lift
  const fn = ['Ground Floor','First Floor','Second Floor','Third Floor','Fourth Floor'];
  const floorAdj = floorArea - (b.hasLift ? LIFT_PER_FLOOR : 0) - STAIRCASE_PER_FLOOR;
  const zoneAItems = [];
  for (let i = 0; i < numFloors; i++) {
    zoneAItems.push({
      name: fn[i] || `Floor ${i+1}`,
      desc: `Floor Area (${ni(floorArea)})${b.hasLift ? ' − Lift ('+LIFT_PER_FLOOR+')':''} − Staircase (${STAIRCASE_PER_FLOOR})`,
      area: floorAdj,
    });
  }
  const liftAreaTotal = b.hasLift ? LIFT_PER_FLOOR * staircaseLevels : 0;
  if (b.hasLift) zoneAItems.push({ name: 'Lift', desc: `${staircaseLevels} levels × ${LIFT_PER_FLOOR} sq.ft`, area: liftAreaTotal });
  const totalA = zoneAItems.reduce((s,f) => s + f.area, 0);

  // Zone B — stilt + balcony + staircase
  const stiltArea       = hasStilt ? floorAdj : 0;
  const balconyPerFloor = b.breadth * BALCONY_DEPTH;
  const balconyTotal    = balconyPerFloor * numFloors;
  const staircaseTotal  = STAIRCASE_PER_FLOOR * staircaseLevels;
  const zoneBItems = [];
  if (hasStilt) zoneBItems.push({ name: 'Stilt', desc: `Floor Area (${ni(floorArea)})${b.hasLift?' − Lift ('+LIFT_PER_FLOOR+')':''} − Staircase (${STAIRCASE_PER_FLOOR})`, area: stiltArea });
  zoneBItems.push({ name: 'Balcony', desc: `${b.breadth}ft × ${BALCONY_DEPTH}ft × ${numFloors} floors`, area: balconyTotal });
  zoneBItems.push({ name: 'Staircase', desc: `${staircaseLevels} levels × ${STAIRCASE_PER_FLOOR} sq.ft`, area: staircaseTotal });
  const totalB = zoneBItems.reduce((s,f) => s + f.area, 0);

  // Zone C — terrace + ramp + setback
  const terrace = floorArea + balconyPerFloor - STAIRCASE_PER_FLOOR - (b.hasLift ? LIFT_PER_FLOOR : 0);
  const ramp    = b.breadth * RAMP_DEPTH;
  const setback = plotSqFt - floorArea;
  const zoneCItems = [
    { name: 'Terrace', desc: `Floor (${ni(floorArea)}) + 1 balcony (${ni(balconyPerFloor)}) − Staircase (${STAIRCASE_PER_FLOOR})${b.hasLift?' − Lift ('+LIFT_PER_FLOOR+')':''}`, area: terrace },
    { name: 'Ramp',    desc: `${b.breadth}ft × ${RAMP_DEPTH}ft`, area: ramp },
    { name: 'Setback', desc: `Plot Area (${ni(plotSqFt)}) − Floor Area (${ni(floorArea)})`, area: setback },
  ];
  const totalC = zoneCItems.reduce((s,f) => s + f.area, 0);

  // Zone D — water tank
  const totalD = waterTankFloors * WATER_TANK_PER_FLOOR;
  const zoneDItems = [{ name: 'Underground Water Tank', desc: `${waterTankFloors} floors × ${ni(WATER_TANK_PER_FLOOR)} L`, area: totalD, unit: 'L' }];

  // Zone E — basement
  const totalE = b.hasBasement ? floorArea : 0;
  const zoneEItems = b.hasBasement ? [{ name: 'Basement', desc: 'Enclosed Area', area: totalE }] : [];

  // Costs
  const costA = totalA * baseRate;
  const costB = totalB * bRate;
  const costC = totalC * C_RATE;
  const costD = totalD * WATER_TANK_RATE;
  const costE = totalE * BASEMENT_RATE;
  const liftCost = b.hasLift ? LIFT_COST : 0;
  const zoneSubtotal = costA + costB + costC + costD + costE;
  // Canonical: zone subtotal + lift cost (GST/liaison handled outside the calculator).
  const grand = zoneSubtotal + liftCost;

  return {
    mode: hasStilt ? 'stilt' : 'nostilt',
    plotSqYards: b.plotSqYards, plotSqFt, depth, breadth: b.breadth, coverage: b.coverage,
    buildLabel: hasStilt ? `Stilt + ${numFloors} Floors` : `Ground + ${numFloors-1}`,
    floorArea,
    zones: {
      A: { items: zoneAItems, total: totalA, rate: baseRate, cost: costA, rateLabel: `100% (₹${ni(baseRate)}/sqft)` },
      B: { items: zoneBItems, total: totalB, rate: bRate,    cost: costB, rateLabel: `50% (₹${ni(bRate)}/sqft)` },
      C: { items: zoneCItems, total: totalC, rate: C_RATE,   cost: costC, rateLabel: `₹${ni(C_RATE)}/sqft` },
      D: { items: zoneDItems, total: totalD, rate: WATER_TANK_RATE, cost: costD, rateLabel: `₹${ni(WATER_TANK_RATE)}/L`, unit: 'L' },
      E: b.hasBasement ? { items: zoneEItems, total: totalE, rate: BASEMENT_RATE, cost: costE, rateLabel: `₹${ni(BASEMENT_RATE)}/sqft` } : null,
    },
    lift:    b.hasLift ? { cost: liftCost } : null,
    zoneSubtotal,
    grandTotal: grand,
  };
}

function calcStructure(state) {
  const b = state.build, p = state.pricing;
  const strRate = parseInt(p.structureRate) || 0;
  const numFloors = b.floors;

  const plotSqFt = b.plotSqYards * 9;
  const depth = b.breadth ? Math.round(plotSqFt / b.breadth) : 0;
  const floorArea = Math.round(plotSqFt * b.coverage / 100);

  // Levels: floors + stilt + basement(opt) + mumty access
  const staircaseLevels = numFloors + 1 + (b.hasBasement ? 1 : 0) + 1;
  const waterTankFloors = numFloors;

  // Zone A — main floors + stilt + lift (everything at structure rate)
  const fn = ['Ground Floor','First Floor','Second Floor','Third Floor','Fourth Floor'];
  const floorAdj = floorArea - (b.hasLift ? LIFT_PER_FLOOR : 0) - STAIRCASE_PER_FLOOR;
  const zoneAItems = [];
  for (let i = 0; i < numFloors; i++) {
    zoneAItems.push({
      name: fn[i] || `Floor ${i+1}`,
      desc: `Floor Area (${ni(floorArea)})${b.hasLift?' − Lift ('+LIFT_PER_FLOOR+')':''} − Staircase (${STAIRCASE_PER_FLOOR})`,
      area: floorAdj,
    });
  }
  zoneAItems.push({ name: 'Stilt', desc: 'Enclosed Area', area: floorArea });
  const liftAreaTotal = b.hasLift ? LIFT_PER_FLOOR * staircaseLevels : 0;
  if (b.hasLift) zoneAItems.push({ name: 'Lift', desc: `${staircaseLevels} levels × ${LIFT_PER_FLOOR} sq.ft`, area: liftAreaTotal });
  const totalA = zoneAItems.reduce((s,i) => s + i.area, 0);

  // Zone B — terrace + staircase (₹500 flat)
  const terrace = floorArea;
  const staircaseTotal = STAIRCASE_PER_FLOOR * staircaseLevels;
  const zoneBItems = [
    { name: 'Terrace',   desc: 'Pantry, Washroom, Parapet Walls', area: terrace },
    { name: 'Staircase', desc: `${staircaseLevels} levels × ${STAIRCASE_PER_FLOOR} sq.ft`, area: staircaseTotal },
  ];
  const totalB = zoneBItems.reduce((s,i) => s + i.area, 0);

  // Zone D — water tank
  const totalD = waterTankFloors * WATER_TANK_PER_FLOOR;
  const zoneDItems = [{ name: 'Underground Water Tank', desc: `${waterTankFloors} floors × ${ni(WATER_TANK_PER_FLOOR)} L`, area: totalD, unit: 'L' }];

  // Zone E — basement
  const totalE = b.hasBasement ? floorArea : 0;
  const zoneEItems = b.hasBasement ? [{ name: 'Basement', desc: 'Enclosed Area', area: totalE }] : [];

  // Costs (no Zone C in structure mode)
  const costA = totalA * strRate;
  const costB = totalB * STRUCT_B_RATE;
  const costD = totalD * WATER_TANK_RATE;
  const costE = totalE * BASEMENT_RATE;
  const liftCost = b.hasLift ? LIFT_COST : 0;
  const zoneSubtotal = costA + costB + costD + costE;
  // Canonical: zone subtotal + lift cost (GST/liaison handled outside the calculator).
  const grand = zoneSubtotal + liftCost;

  return {
    mode: 'structure',
    plotSqYards: b.plotSqYards, plotSqFt, depth, breadth: b.breadth, coverage: b.coverage,
    buildLabel: `Structure Only · Stilt + ${numFloors}`,
    floorArea,
    zones: {
      A: { items: zoneAItems, total: totalA, rate: strRate,        cost: costA, rateLabel: `100% (₹${ni(strRate)}/sqft)` },
      B: { items: zoneBItems, total: totalB, rate: STRUCT_B_RATE,  cost: costB, rateLabel: `₹${ni(STRUCT_B_RATE)}/sqft` },
      C: null,
      D: { items: zoneDItems, total: totalD, rate: WATER_TANK_RATE, cost: costD, rateLabel: `₹${ni(WATER_TANK_RATE)}/L`, unit: 'L' },
      E: b.hasBasement ? { items: zoneEItems, total: totalE, rate: BASEMENT_RATE, cost: costE, rateLabel: `₹${ni(BASEMENT_RATE)}/sqft` } : null,
    },
    lift:    b.hasLift ? { cost: liftCost } : null,
    zoneSubtotal,
    grandTotal: grand,
  };
}

// ============================================================================
// Format helpers
// ============================================================================
function fmtINR(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (n === 0) return '₹0';
  let s = Math.round(Math.abs(n)).toString();
  if (s.length <= 3) return (n < 0 ? '−' : '') + '₹' + s;
  let l = s.slice(-3), r = s.slice(0,-3), parts = [];
  while (r.length > 2) { parts.unshift(r.slice(-2)); r = r.slice(0,-2); }
  if (r) parts.unshift(r);
  return (n < 0 ? '−' : '') + '₹' + parts.join(',') + ',' + l;
}
function ni(n) { if (n === null || n === undefined || isNaN(n)) return '—'; return Math.round(n).toLocaleString('en-IN'); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function formatDate(iso) {
  if (!iso) return '';
  const [y,m,d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d,10)} ${months[parseInt(m,10)-1]} ${y}`;
}

// ============================================================================
// Page-mode bootstrap
// ============================================================================
const isFormPage    = !!document.getElementById('spec-list');
const isPreviewPage = !!document.getElementById('preview-root');

if (isFormPage)    bootForm();
if (isPreviewPage) bootPreview();

// ============================================================================
// FORM PAGE
// ============================================================================
async function bootForm() {
  await loadCatalog();
  let state = loadState();

  // First-load seed for rows when scope is set but rows empty
  if (!state.rows.length) {
    state.rows = defaultRowsFor(state.scope);
    saveState(state);
  }

  const $ = id => document.getElementById(id);

  // ---- Hydrate inputs ----
  $('f-salutation').value = state.customer.salutation;
  $('f-name').value       = state.customer.name;
  $('f-address').value    = state.customer.address;
  $('f-plot').value       = state.build.plotSqYards;
  $('f-breadth').value    = state.build.breadth;
  $('f-coverage').value   = state.build.coverage;
  $('f-floors').value     = state.build.floors;
  $('f-build-type').value = state.build.buildType;
  $('f-basement').checked = !!state.build.hasBasement;
  $('f-lift').checked     = !!state.build.hasLift;
  $('f-cost-sqft').value  = state.pricing.costPerSqft ?? '';
  $('f-struct-rate').value= state.pricing.structureRate ?? '';
  $('f-notes').value      = state.notes ?? '';
  for (const btn of $('f-scope').querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.v === state.scope);
  }
  reflectModeUi(state.build.buildType);

  function flush() { saveState(state); renderSpecList(); }

  // ---- Customer field listeners ----
  $('f-salutation').oninput = e => { state.customer.salutation = e.target.value; flush(); };
  $('f-name').oninput        = e => { state.customer.name = e.target.value; flush(); };
  $('f-address').oninput     = e => { state.customer.address = e.target.value; flush(); };

  // ---- Build geometry listeners ----
  $('f-plot').oninput     = e => { state.build.plotSqYards = +e.target.value || 0; flush(); };
  $('f-breadth').oninput  = e => { state.build.breadth = +e.target.value || 0; flush(); };
  $('f-coverage').oninput = e => { state.build.coverage = +e.target.value || 0; flush(); };
  $('f-floors').oninput   = e => { state.build.floors = +e.target.value || 1; flush(); };
  $('f-basement').onchange= e => { state.build.hasBasement = !!e.target.checked; flush(); };
  $('f-lift').onchange    = e => { state.build.hasLift = !!e.target.checked; flush(); };
  $('f-build-type').onchange = e => {
    state.build.buildType = e.target.value;
    reflectModeUi(state.build.buildType);
    // Auto-sync scope: structure mode forces structure_only scope
    if (state.build.buildType === 'structure' && state.scope !== 'structure_only') {
      state.scope = 'structure_only';
      state.rows  = defaultRowsFor('structure_only');
      for (const btn of $('f-scope').querySelectorAll('button')) btn.classList.toggle('active', btn.dataset.v === state.scope);
    } else if (state.build.buildType !== 'structure' && state.scope === 'structure_only') {
      // moving back from structure → keep structure_only scope (user can flip if they want full)
    }
    flush();
  };

  // ---- Pricing ----
  $('f-cost-sqft').oninput  = e => { state.pricing.costPerSqft = e.target.value === '' ? null : (+e.target.value || 0); flush(); };
  $('f-struct-rate').oninput= e => { state.pricing.structureRate = e.target.value === '' ? null : (+e.target.value || 0); flush(); };
  $('f-notes').oninput      = e => {
    let v = e.target.value;
    if (v.length > 2000) { v = v.slice(0, 2000); e.target.value = v; }
    state.notes = v;
    saveState(state);
    document.getElementById('notes-count').textContent = `${v.length}/2000`;
  };
  document.getElementById('notes-count').textContent = `${(state.notes||'').length}/2000`;

  // ---- Scope toggle ----
  for (const btn of $('f-scope').querySelectorAll('button')) {
    btn.onclick = () => {
      for (const b of $('f-scope').querySelectorAll('button')) b.classList.remove('active');
      btn.classList.add('active');
      state.scope = btn.dataset.v;
      state.rows = defaultRowsFor(state.scope);
      flush();
    };
  }

  $('reset-default').onclick = () => {
    if (!confirm('Reset specifications to scope defaults? Custom rows will be lost.')) return;
    state.rows = defaultRowsFor(state.scope);
    flush();
  };
  $('add-row').onclick = () => openPicker('catalog');
  $('add-custom').onclick = () => openPicker('custom');
  $('picker-close').onclick = () => closePicker();
  $('picker-search').oninput = () => renderPicker();
  $('dl').onclick = downloadPdf;

  function reflectModeUi(mode) {
    const isStruct = mode === 'structure';
    document.getElementById('cost-sqft-row').style.display    = isStruct ? 'none' : '';
    document.getElementById('struct-rate-row').style.display  = isStruct ? '' : 'none';
    document.getElementById('floors-label').textContent       = (mode === 'nostilt') ? 'Number of floors (incl. ground)' : 'Floors above stilt';
  }

  // ---- Spec list ----
  function renderSpecList() {
    const list = $('spec-list');
    list.innerHTML = '';
    state.rows.forEach((row, idx) => {
      const item = row._custom ? null : catalogItem(row.id);
      if (!row._custom && !item) return;
      const o = row.override || {};
      const label = o.label ?? (item ? item.label : (row.id || 'Untitled'));
      // P1.3: rate / brands are AUTHORITATIVE only when set in override. Catalog values
      // are templates/suggestions and must not surface as committed values in the spec list.
      const rate  = (o.rate !== undefined) ? o.rate : 0;
      const rateText = (o.rate_text !== undefined) ? o.rate_text : '';
      const overrideBrands = (o.brands !== undefined) ? o.brands : null;
      const brands = overrideBrands ?? [];
      const suggestedBrands = (item && Array.isArray(item.brands)) ? item.brands : [];
      const desc  = o.description ?? (item ? item.description : '');
      const cat   = item ? item.category_label : (o.category_label || 'Custom');
      const loc   = o.location || '';
      const brandMeta = brands.length
        ? escapeHtml(brands.join(' · '))
        : (suggestedBrands.length ? `<em class="suggest">suggested: ${escapeHtml(suggestedBrands.join(' · '))}</em>` : '<em class="suggest">brands — set in edit</em>');
      const rateMeta = (rateText && rateText.trim())
        ? escapeHtml(rateText)
        : (rate > 0 ? fmtINR(rate) : '<em class="set-rate">Set rate</em>');

      const el = document.createElement('div');
      el.className = 'spec' + (row._custom ? ' custom' : '');
      el.dataset.idx = idx;
      el.draggable = true;
      el.innerHTML = `
        <span class="grip" title="drag to reorder">≡</span>
        <span class="head">
          <span class="label">${escapeHtml(label)}${loc ? ' <span class="loc">— '+escapeHtml(loc)+'</span>' : ''}</span>
          <span class="meta">${escapeHtml(cat)} · ${brandMeta}</span>
        </span>
        <span class="rate">${rateMeta}</span>
        <span class="row-actions">
          <span class="dup" title="duplicate row" data-act="dup">⎘</span>
          <span class="x" title="remove row" data-act="remove">×</span>
        </span>
      `;
      el.onclick = (e) => {
        const act = e.target.dataset.act;
        if (act === 'remove') { state.rows.splice(idx,1); flush(); return; }
        if (act === 'dup') {
          const copy = JSON.parse(JSON.stringify(state.rows[idx]));
          copy.override = copy.override || {};
          state.rows.splice(idx+1, 0, copy);
          flush(); return;
        }
        toggleEdit(el, idx);
      };
      list.appendChild(el);
    });
    $('spec-count').textContent = state.rows.length + ' items';
    enableDragReorder(list);
  }

  function toggleEdit(el, idx) {
    if (el.classList.contains('editing')) return; // editor stays open until Done
    el.classList.add('editing');
    const row = state.rows[idx];
    const item = row._custom ? null : catalogItem(row.id);
    const o = row.override || {};
    const label = o.label ?? (item ? item.label : '');
    const rate  = (o.rate !== undefined) ? o.rate : (item ? item.rate : 0);
    const rateText = o.rate_text ?? (item ? item.rate_text : '') ?? '';
    const brands = o.brands ?? (item ? item.brands : []) ?? [];
    const desc  = o.description ?? (item ? item.description : '');
    const cat   = (o.category_label) ?? (item ? item.category_label : 'Custom');
    const loc   = o.location || '';

    const ed = document.createElement('div');
    ed.className = 'editor';
    ed.innerHTML = `
      <div><label>Label</label><input data-f="label" value="${escapeAttr(label)}"></div>
      <div><label>Location / Room (optional)</label><input data-f="location" placeholder="e.g. Drawing Room, Bedroom 1" value="${escapeAttr(loc)}"></div>
      <div><label>Rate (₹) — 0 if descriptive</label><input data-f="rate" type="number" value="${rate||0}"></div>
      <div><label>Rate text (display)</label><input data-f="rate_text" placeholder="e.g. ₹35,000 per bathroom" value="${escapeAttr(rateText)}"></div>
      <div class="full"><label>Brands (comma-separated)</label><input data-f="brands" value="${escapeAttr(brands.join(', '))}"></div>
      <div class="full"><label>Description</label><textarea data-f="description" rows="3">${escapeHtml(desc)}</textarea></div>
      ${row._custom ? `<div><label>Category</label><select data-f="category_label">
        <option>Custom</option><option>Bathroom & Toilet</option><option>Kitchen</option><option>Doors, Windows & Wardrobe</option>
        <option>Flooring</option><option>Electrical Work</option><option>Water Management</option><option>Ceiling & Elevation</option>
        <option>Safety & Security</option><option>Paint & Polish</option><option>Structure</option><option>Design & Drawings</option>
        <option>General Aspects</option>
      </select></div>` : ''}
      <div class="ed-actions"><button data-act="done" class="btn-primary">Done</button>${row._custom ? '<button data-act="delete" class="btn-danger">Delete row</button>' : ''}</div>
    `;
    el.appendChild(ed);
    if (row._custom) ed.querySelector('select[data-f="category_label"]').value = cat;
    ed.addEventListener('input', e => {
      const f = e.target.dataset.f;
      if (!f) return;
      state.rows[idx].override ??= {};
      let v = e.target.value;
      if (f === 'rate') v = +v || 0;
      if (f === 'brands') v = v.split(',').map(s=>s.trim()).filter(Boolean);
      state.rows[idx].override[f] = v;
      saveState(state);
    });
    ed.addEventListener('change', e => {
      const f = e.target.dataset.f;
      if (!f) return;
      state.rows[idx].override ??= {};
      state.rows[idx].override[f] = e.target.value;
      saveState(state);
    });
    ed.addEventListener('click', e => {
      if (e.target.dataset.act === 'done') {
        e.stopPropagation();
        el.classList.remove('editing');
        ed.remove();
        renderSpecList();
      } else if (e.target.dataset.act === 'delete') {
        e.stopPropagation();
        if (!confirm('Delete this row?')) return;
        state.rows.splice(idx,1); flush();
      }
    });
    document.addEventListener('keydown', function escClose(ev) {
      if (ev.key === 'Escape' && el.classList.contains('editing')) {
        el.classList.remove('editing');
        ed.remove(); renderSpecList();
        document.removeEventListener('keydown', escClose);
      }
    });
  }

  function enableDragReorder(container) {
    let dragging = null;
    container.querySelectorAll('.spec').forEach(s => {
      s.addEventListener('dragstart', () => { dragging = s; s.style.opacity = '0.4'; });
      s.addEventListener('dragend',   () => { s.style.opacity = '1'; dragging = null; });
      s.addEventListener('dragover',  e => { e.preventDefault(); });
      s.addEventListener('drop',      e => {
        e.preventDefault();
        if (!dragging || dragging === s) return;
        const from = +dragging.dataset.idx, to = +s.dataset.idx;
        const moved = state.rows.splice(from,1)[0];
        state.rows.splice(to, 0, moved);
        flush();
      });
    });
  }

  // ---- Picker ----
  let pickerMode = 'catalog';
  function openPicker(mode='catalog') {
    pickerMode = mode;
    document.getElementById('picker').classList.add('open');
    document.getElementById('picker-search').value = '';
    document.getElementById('picker').querySelector('h3').textContent = (mode === 'custom') ? 'Add custom row (not from catalog)' : 'Add line item from catalog';
    renderPicker();
  }
  function closePicker() { document.getElementById('picker').classList.remove('open'); }
  document.getElementById('picker').addEventListener('click', e => { if (e.target.id === 'picker') closePicker(); });

  function renderPicker() {
    const body = document.getElementById('picker-body');
    body.innerHTML = '';
    if (pickerMode === 'custom') {
      const el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = `
        <span class="l">
          <span class="lab">Add a blank custom row</span><br>
          <span class="cat">Examples: bathtub, walk-in wardrobe, lawn, swimming pool</span>
        </span>
        <span class="r">+ Custom</span>
      `;
      el.onclick = () => {
        const id = 'custom.' + Math.random().toString(36).slice(2,8);
        state.rows.push({
          id, _custom: true,
          override: { label: 'New custom item', rate: 0, brands: [], description: '', category_label: 'Custom' },
        });
        flush(); closePicker();
        // open the new row's editor
        setTimeout(() => {
          const last = document.querySelectorAll('.spec');
          if (last.length) toggleEdit(last[last.length-1], state.rows.length-1);
        }, 50);
      };
      body.appendChild(el);
      return;
    }
    const q = document.getElementById('picker-search').value.toLowerCase().trim();
    for (const it of (CATALOG?.items || [])) {
      if (state.scope === 'structure_only' && !it.scope.includes('structure_only')) continue;
      if (q && !(it.label.toLowerCase().includes(q) || it.category_label.toLowerCase().includes(q))) continue;
      const el = document.createElement('div'); el.className = 'item';
      el.innerHTML = `
        <span class="l">
          <span class="lab">${escapeHtml(it.label)}</span><br>
          <span class="cat">${escapeHtml(it.category_label)}</span>
        </span>
        <span class="r">${it.rate_text || (it.rate>0 ? fmtINR(it.rate) : 'descriptive')}</span>
      `;
      el.onclick = () => {
        state.rows.push({ id: it.id, override: {} });
        flush(); closePicker();
      };
      body.appendChild(el);
    }
    if (!body.children.length) {
      body.innerHTML = '<div class="item" style="color:var(--muted);"><span class="l">No matches</span><span class="r"></span></div>';
    }
  }

  // ---- Download PDF ----
  async function downloadPdf() {
    const btn = document.getElementById('dl');
    btn.disabled = true; btn.textContent = 'Building PDF…';
    try {
      const iframe = document.getElementById('preview');
      const doc = iframe.contentDocument;
      const html = '<!doctype html>' + doc.documentElement.outerHTML;
      const fname = ['zuildup-quote', state.quoteId, (state.customer.name||'unnamed').replace(/\s+/g,'_')].join('-');
      const r = await fetch('/pdf?filename=' + encodeURIComponent(fname), {
        method: 'POST', headers: { 'Content-Type': 'text/html' }, body: html,
      });
      if (!r.ok) {
        const t = await r.text();
        alert('PDF render failed:\n' + t.slice(0,400));
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname + '.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('PDF render error: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Download PDF';
    }
  }

  renderSpecList();
}
"""


QUOTE_JS_PART3 = r"""
// ============================================================================
// PREVIEW PAGE
// ============================================================================
async function bootPreview() {
  await loadCatalog();
  let aboutContent = null;
  try {
    const r = await fetch('/assets/about/about-content.json');
    if (r.ok) aboutContent = await r.json();
  } catch(_){}

  function paint() {
    const state = loadState();
    if (!state.rows.length) {
      state.rows = defaultRowsFor(state.scope);
    }
    document.getElementById('preview-root').innerHTML = renderQuote(state, aboutContent);
  }
  paint();
  window.addEventListener('storage', paint);
  window.addEventListener('quote-state-changed', paint);
  setInterval(paint, 700);
}

function renderQuote(state, about) {
  const c = computeQuote(state);
  const customer = state.customer;
  const showCustomer = (customer.name || customer.address);

  // Group rows by category
  const byCat = {};
  for (const row of state.rows) {
    const it = row._custom ? null : catalogItem(row.id);
    const cat = (row.override?.category_label) ?? (it ? it.category_label : 'Custom');
    (byCat[cat] ||= []).push({ row, item: it });
  }
  const catOrder = [
    'Design & Drawings','Structure','Bathroom & Toilet','Kitchen','Doors, Windows & Wardrobe',
    'Flooring','Electrical Work','Water Management','Ceiling & Elevation','Safety & Security',
    'Paint & Polish','General Aspects','Custom',
  ];
  const sortedCats = catOrder.filter(c => byCat[c]).concat(Object.keys(byCat).filter(c => !catOrder.includes(c)));

  return `
${quoteCss()}

${renderCover(state, customer, showCustomer)}
${about ? renderAboutPage(state, about) : ''}
${renderAreaPage(state, c)}
${renderCostPage(state, c)}
${renderSpecPages(state, sortedCats, byCat)}
${state.notes && state.notes.trim() ? renderNotesPage(state) : ''}
`;
}

function quoteCss() {
  return `
<style>
  @page { size: A4; margin: 0; }
  :root { --navy:#0A1F44; --gold:#C9A24D; --offwhite:#F9FAF7; --ink:#1B1F2A; --muted:#5C6373; --rule:rgba(10,31,68,0.10); }
  body { margin: 0; font-family: 'Inter', system-ui, sans-serif; color: var(--ink); background: var(--offwhite); -webkit-font-smoothing: antialiased; }

  .pg { width: 210mm; min-height: 297mm; padding: 22mm 20mm; box-sizing: border-box; background: var(--offwhite); page-break-after: always; position: relative; }
  .pg:last-child { page-break-after: auto; }

  /* Cover */
  .pg.cover { padding: 0; height: 297mm; overflow: hidden; background: var(--navy); }
  .cover-grad { position: absolute; inset:0; background: linear-gradient(135deg, #0A1F44 0%, #142D5C 50%, #1B3B73 100%); }
  .cover-pattern { position: absolute; inset:0; background-image: radial-gradient(rgba(201,162,77,0.10) 1px, transparent 1px); background-size: 32px 32px; }
  .cover-vignette { position: absolute; inset:0; background: radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.45) 100%); }
  .cover-content { position: absolute; inset:0; display: flex; flex-direction: column; padding: 22mm 20mm; }
  .cover-top { display:flex; justify-content: space-between; align-items: flex-start; }
  .cover-mid { flex:1; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; color:white; }
  .cover-rule { width: 56px; height: 1px; background: var(--gold); margin: 22px 0 28px; opacity:.9; }
  .cover-eyebrow { color: var(--gold); font-size: 11px; letter-spacing:.34em; text-transform:uppercase; font-weight: 500; margin-bottom: 18px; }
  .cover-tagline { font-family: 'Fraunces', serif; font-weight: 500; font-size: 28px; line-height: 1.15; letter-spacing:-.005em; color: rgba(255,255,255,0.92); margin: 0 0 24px; max-width: 300px; }
  .cover-name-block { margin-top: 12mm; }
  .cover-name { font-family: 'Fraunces', serif; font-weight: 500; font-size: 44px; line-height: 1.1; letter-spacing:-.01em; margin: 0 0 8px; color: white; }
  .cover-address { font-size: 13px; color: rgba(255,255,255,0.72); line-height: 1.55; max-width: 380px; margin: 0 auto 6px; }
  .cover-date { font-size: 11px; color: rgba(255,255,255,0.6); letter-spacing:.18em; text-transform: uppercase; margin-top: 14px; }
  .cover-bot { display:flex; justify-content: space-between; align-items: flex-end; margin-top: 8mm; }
  .cover-pill { display: inline-block; background: var(--gold); color: var(--navy); padding: 7px 16px; border-radius: 999px; font-size: 10.5px; letter-spacing:.22em; font-weight: 700; }
  .cover-qid { color: rgba(255,255,255,0.65); font-size: 9px; letter-spacing:.22em; text-transform: uppercase; line-height:1.5; text-align:right; }
  .cover-qid-num { display:block; color: white; font-size: 14px; letter-spacing:.04em; font-weight: 500; margin-top: 3px; }
  .cover-trust { display:flex; gap: 14px; flex-wrap: wrap; justify-content: center; color: rgba(255,255,255,0.55); font-size: 10px; letter-spacing:.18em; text-transform:uppercase; margin-top: 18mm; }
  .cover-trust span { padding: 0 4px; }
  .cover-trust span + span:before { content: '·'; padding-right: 14px; }
  .cover-meta-tag { color: rgba(255,255,255,0.65); font-size: 10px; letter-spacing:.2em; text-transform: uppercase; font-weight: 500; }
  .pg.cover svg { display: block; }

  /* Inner pages */
  .pg-head { display:flex; justify-content: space-between; align-items: center; padding-bottom: 8mm; border-bottom: 1px solid var(--rule); margin-bottom: 9mm; }
  .pg-head .breadcrumb { color: var(--muted); font-size: 10px; letter-spacing:.22em; text-transform: uppercase; font-weight: 500; text-align: right; }
  .pg-head .breadcrumb .current { color: var(--navy); font-weight: 600; }
  .eyebrow { color: var(--gold); font-size: 10px; letter-spacing:.32em; text-transform: uppercase; font-weight: 600; margin-bottom: 4px; }
  h1.section { font-family: 'Fraunces', serif; font-weight: 500; font-size: 30px; line-height: 1.18; margin: 4px 0 6mm; color: var(--navy); letter-spacing:-.005em; }
  p.lede { color: var(--muted); font-size: 12.5px; line-height: 1.65; max-width: 440px; margin: 0 0 7mm; }
  .pg-foot { position: absolute; bottom: 12mm; left: 20mm; right: 20mm; display:flex; justify-content: space-between; color: var(--muted); font-size: 8.5px; letter-spacing:.16em; text-transform: uppercase; font-weight: 500; padding-top: 4mm; border-top: 1px solid var(--rule); }

  /* About page — compact single-page layout */
  .about-page h1.section { font-size: 22px; margin-bottom: 5mm; max-width: 480px; }
  .about-page p.lede { display: none; }
  .about-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm 8mm; margin-bottom: 5mm; }
  .about-block { break-inside: avoid; }
  .about-block h3 { font-family: 'Fraunces', serif; font-weight: 500; font-size: 14px; color: var(--navy); margin: 0 0 3px; }
  .about-block p { font-size: 10.5px; color: var(--ink); line-height: 1.5; margin: 0; }
  .about-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-bottom: 4mm; }
  .about-col { break-inside: avoid; }
  .about-list, .why-list { list-style: none; padding: 0; margin: 4px 0 0; }
  .about-list li, .why-list li { padding: 5px 0; border-bottom: 1px dashed var(--rule); font-size: 10.5px; }
  .about-list li:last-child, .why-list li:last-child { border: none; }
  .about-list .num { color: var(--gold); font-family: 'Fraunces', serif; font-size: 12px; font-weight: 600; margin-right: 6px; }
  .about-list .lab, .why-list .lab { color: var(--navy); font-weight: 600; font-size: 11px; }
  .about-list .body, .why-list .body { color: var(--muted); font-size: 10px; line-height: 1.4; margin-top: 2px; display: block; }
  .warranty-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px 6px; margin-top: 3mm; }
  .warranty-grid .w { padding: 6px 9px; background: white; border-radius: 5px; border: 1px solid var(--rule); }
  .warranty-grid .w .lab { font-size: 10.5px; font-weight: 600; color: var(--navy); display: block; line-height: 1.25; }
  .warranty-grid .w .term { font-size: 9.5px; color: var(--gold); font-weight: 700; letter-spacing: .04em; margin-top: 2px; display: block; }
  .warranty-grid .w .desc { font-size: 9.5px; color: var(--muted); margin-top: 2px; display: block; line-height: 1.35; }
  .hero-subline { color: var(--muted); font-size: 12px; line-height: 1.55; margin: 4px 0 8mm; max-width: 165mm; }
  /* P1.1: heading repeat across page breaks now handled by <thead>; keep-together remains as legacy guard */
  .cat-section .keep-together { break-inside: avoid; page-break-inside: avoid; }

  /* Area / Cost tables */
  .calc-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 6mm; }
  .calc-table thead th, .calc-table tbody td { padding: 7px 10px; }
  .calc-table thead th { background: var(--navy); color: white; text-align: left; font-weight: 500; font-size: 11px; letter-spacing: .04em; }
  .calc-table thead th.r, .calc-table td.r { text-align: right; font-variant-numeric: tabular-nums; }
  .calc-table .zone-hdr td { background: rgba(10,31,68,0.05); color: var(--navy); font-weight: 600; padding: 9px 10px; }
  .calc-table .zone-tag { display: inline-block; width: 18px; height: 18px; line-height: 18px; text-align: center; color: white; font-size: 10px; font-weight: 700; border-radius: 4px; margin-right: 6px; }
  .calc-table .za { background:#0A1F44; }
  .calc-table .zb { background:#3B5998; }
  .calc-table .zc { background:#C9A24D; color:#0A1F44; }
  .calc-table .zd { background:#5C6373; }
  .calc-table .ze { background:#8B4513; }
  .calc-table tbody tr { border-bottom: 1px solid var(--rule); }
  .calc-table tbody tr.zone-total td { font-weight: 600; color: var(--navy); }
  .calc-table tbody tr.zone-total { border-bottom: 2px solid var(--rule); }
  .calc-table .small { color: var(--muted); font-size: 10.5px; }
  .calc-table .desc { color: var(--muted); font-size: 11px; }
  .calc-table tfoot td { padding: 10px; }
  .calc-table tfoot .sub { background: rgba(10,31,68,0.04); font-weight: 600; }
  .calc-table tfoot .grand { background: var(--navy); color: white; font-weight: 700; font-size: 13.5px; }

  .params-row { display:flex; flex-wrap:wrap; gap: 4mm 8mm; padding: 6px 0 9mm; border-bottom: 1px solid var(--rule); margin-bottom: 6mm; font-size: 11.5px; color: var(--muted); }
  .params-row b { color: var(--ink); font-weight: 600; margin-right: 4px; }

  /* Spec cards */
  /* Spec category — uses <table><thead> so the heading repeats on every page Chrome paginates onto. */
  table.cat-section { width: 100%; margin-bottom: 7mm; border-collapse: collapse; }
  table.cat-section thead { display: table-header-group; }
  table.cat-section thead th { padding: 0 0 4mm; text-align: left; font-weight: normal; }
  table.cat-section tbody td { padding: 0; }
  .cat-section h2 { font-family: 'Fraunces', serif; font-weight: 500; font-size: 18px; color: var(--navy); margin: 0 0 4mm; padding-bottom: 6px; border-bottom: 1px solid var(--rule); break-after: avoid; }
  .cat-section h2 .count { font-size: 11px; color: var(--muted); font-weight: 400; font-family: 'Inter', sans-serif; margin-left: 8px; }
  .spec-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .spec-card { background: white; border-radius: 8px; padding: 10px 12px; border: 1px solid var(--rule); display: flex; flex-direction: column; gap: 5px; break-inside: avoid; }
  .spec-card .lab { font-family: 'Fraunces', serif; font-weight: 500; font-size: 13px; color: var(--navy); margin: 0; line-height: 1.25; }
  .spec-card .lab .loc { color: var(--gold); font-weight: 500; font-size: 11.5px; }
  .spec-card .badges { display:flex; flex-wrap: wrap; gap: 4px; }
  .spec-card .badge { background: rgba(10,31,68,0.05); color: var(--navy); padding: 2px 8px; border-radius: 999px; font-size: 9.5px; font-weight: 500; }
  .spec-card .rate-pill { align-self: flex-start; background: var(--navy); color: white; padding: 3px 10px; border-radius: 999px; font-size: 10px; font-weight: 600; }
  .spec-card .rate-pill.descr { background: rgba(10,31,68,0.06); color: var(--navy); }
  /* P1.3: open-field placeholder for rows where sales has not entered a rate yet. */
  .spec-card .rate-pill.set { background: rgba(10,31,68,0.04); color: rgba(10,31,68,0.55); font-style: italic; font-weight: 500; border: 1px dashed rgba(10,31,68,0.20); }
  .spec-card.unedited { background: rgba(10,31,68,0.015); border-style: dashed; }
  .spec-card.unedited .desc { color: rgba(10,31,68,0.55); font-style: italic; }
  .spec-card .desc { color: var(--ink); font-size: 10.5px; line-height: 1.5; margin: 2px 0 0; white-space: pre-line; }

  /* Notes page */
  .notes-block { background: white; border: 1px solid var(--rule); border-radius: 8px; padding: 10mm; font-size: 12px; line-height: 1.65; white-space: pre-wrap; color: var(--ink); }
</style>
`;
}

function logoSvg({ accent='#C9A24D', text='#0A1F44', size='large' }={}) {
  // Bigger logo on cover (size=large), small on inner pages
  const w = (size==='cover') ? 220 : (size==='large' ? 160 : 110);
  return `
<svg width="${w}" viewBox="0 0 114 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M15 21V13C15 12.7348 14.8946 12.4804 14.7071 12.2929C14.5196 12.1054 14.2652 12 14 12H10C9.73478 12 9.48043 12.1054 9.29289 12.2929C9.10536 12.4804 9 12.7348 9 13V21" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M3 10C2.99993 9.71 3.063 9.422 3.186 9.158C3.308 8.894 3.487 8.66 3.709 8.472L10.709 2.472C11.07 2.167 11.527 2 12 2C12.473 2 12.93 2.167 13.291 2.472L20.291 8.472C20.513 8.66 20.692 8.894 20.814 9.158C20.937 9.422 21 9.71 21 10V19C21 19.531 20.789 20.04 20.414 20.415C20.039 20.79 19.53 21 19 21H5C4.47 21 3.961 20.79 3.586 20.415C3.211 20.04 3 19.531 3 19V10Z" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="28" y="17" font-family="Inter, sans-serif" font-size="12" font-weight="600" fill="${text}" letter-spacing="0.5">ZuildUp</text>
</svg>`;
}
"""


QUOTE_JS_PART4 = r"""
function renderCover(state, customer, showCustomer) {
  const trust = ['24+ Years Excellence', '450+ Quality Checks', 'Transparent Pricing', 'On-Time Delivery'];
  const addr = (customer.address || '').split(',').map(s => s.trim()).filter(Boolean);
  return `
<section class="pg cover">
  <div class="cover-grad"></div>
  <div class="cover-pattern"></div>
  <div class="cover-vignette"></div>
  <div class="cover-content">
    <div class="cover-top">
      ${logoSvg({ accent:'#F4D58A', text:'white', size:'cover' })}
      <span class="cover-meta-tag">Delhi NCR · Estd 2024</span>
    </div>
    <div class="cover-mid">
      <div class="cover-eyebrow">Custom Home Quotation</div>
      <p class="cover-tagline">Don't just build, Zuild.</p>
      <div class="cover-rule"></div>
      ${showCustomer ? `
      <div class="cover-name-block">
        <h1 class="cover-name">${escapeHtml((customer.salutation || '') + ' ' + (customer.name || '')).trim()}</h1>
        <p class="cover-address">${addr.map(escapeHtml).join('<br>')}</p>
        <p class="cover-date">${formatDate(state.createdAt)}</p>
      </div>` : ''}
      <div class="cover-trust">${trust.map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>
    </div>
    <div class="cover-bot">
      <span class="cover-pill">${escapeHtml(buildLabel(state).toUpperCase())}</span>
      <div class="cover-qid">Quote ID<span class="cover-qid-num">${escapeHtml(state.quoteId)}</span></div>
    </div>
  </div>
</section>`;
}

function buildLabel(state) {
  const bt = state.build.buildType;
  if (bt === 'structure') return 'Structure Only';
  if (bt === 'nostilt')   return 'Full Build · No Stilt';
  return 'Full Build';
}

function renderAboutPage(state, about) {
  const proc = (about.process || []).slice(0, 5);
  const warr = (about.warranty || []).slice(0, 9);
  const why  = (about.why_choose || []).slice(0, 6);
  const vm   = about.about?.vision_mission || [];
  return `
<section class="pg about-page">
  <div class="pg-head">
    ${logoSvg({ size:'large' })}
    <div class="breadcrumb"><span class="current">About ZuildUp</span></div>
  </div>
  <div class="eyebrow">Why ZuildUp</div>
  <h1 class="section">${escapeHtml(about.hero?.headline || 'Tech-Enabled Construction. Quality Assured.')}</h1>
  ${about.hero?.subline ? `<p class="hero-subline">${escapeHtml(about.hero.subline)}</p>` : ''}

  <div class="about-grid">
    ${vm.map(v => `<div class="about-block"><h3>${escapeHtml(v.title)}</h3><p>${escapeHtml(v.body)}</p></div>`).join('')}
  </div>

  <div class="about-cols">
    <div class="about-col">
      <div class="eyebrow">Our Process</div>
      <ul class="about-list">
        ${proc.map((p,i) => `<li><span class="num">0${i+1}</span><span class="lab">${escapeHtml(p.title)}</span><span class="body">${escapeHtml((p.body||'').slice(0, 130))}</span></li>`).join('')}
      </ul>
    </div>
    <div class="about-col">
      <div class="eyebrow">Why families choose us</div>
      <ul class="why-list">
        ${why.map(w => `<li><span class="lab">${escapeHtml(w.title)}</span><span class="body">${escapeHtml((w.body||'').slice(0, 90))}</span></li>`).join('')}
      </ul>
    </div>
  </div>

  <div class="eyebrow" style="margin-top:5mm;">Warranty Promise</div>
  <div class="warranty-grid">
    ${warr.map(w => `<div class="w"><span class="lab">${escapeHtml(w.title)}</span><span class="term">${escapeHtml(w.term || '')}</span>${w.description ? `<span class="desc">${escapeHtml(w.description)}</span>` : ''}</div>`).join('')}
  </div>

  <div class="pg-foot"><span>About ZuildUp</span><span>+91 92172 63051 · info@zuildup.com · www.zuildup.com</span></div>
</section>`;
}



function renderAreaPage(state, c) {
  const zoneRows = (key, zone) => {
    if (!zone) return '';
    const tag = `<span class="zone-tag z${key.toLowerCase()}">${key}</span>`;
    return `
      <tr class="zone-hdr"><td colspan="3">${tag} Zone ${key} — ${zone.rateLabel}</td></tr>
      ${zone.items.map(it => `<tr><td>${escapeHtml(it.name)}</td><td class="desc">${escapeHtml(it.desc)}</td><td class="r"><b>${ni(it.area)}${zone.unit ? ' '+zone.unit : ''}</b></td></tr>`).join('')}
      <tr class="zone-total"><td colspan="2">Total Zone ${key}</td><td class="r">${ni(zone.total)}${zone.unit ? ' '+zone.unit : ''}</td></tr>
    `;
  };
  const totalArea = (c.zones.A?.total || 0) + (c.zones.B?.total || 0) + (c.zones.C?.total || 0) + (c.zones.E?.total || 0);

  return `
<section class="pg">
  <div class="pg-head">
    ${logoSvg({ size:'large' })}
    <div class="breadcrumb"><span class="current">Area Calculation</span></div>
  </div>
  <div class="eyebrow">Step 1</div>
  <h1 class="section">Area Calculation</h1>
  <p class="lede">Built-up area derived from plot dimensions, coverage and the chosen build configuration. Each zone bills at a different rate (see Cost Calculation).</p>

  <div class="params-row">
    <span><b>Plot:</b> ${c.plotSqYards} sq.yd / ${ni(c.plotSqFt)} sq.ft</span>
    <span><b>Dims:</b> ${c.breadth}ft × ${c.depth}ft</span>
    <span><b>Coverage:</b> ${c.coverage}%</span>
    <span><b>Floor Area:</b> ${ni(c.floorArea)} sq.ft</span>
    <span><b>Build:</b> ${escapeHtml(c.buildLabel)}</span>
    ${state.build.hasBasement ? '<span><b>Basement:</b> Yes</span>' : ''}
    ${state.build.hasLift ? '<span><b>Lift:</b> Yes</span>' : ''}
  </div>

  <table class="calc-table">
    <thead><tr><th>Area</th><th>Description</th><th class="r">Est. Size</th></tr></thead>
    <tbody>
      ${zoneRows('A', c.zones.A)}
      ${zoneRows('B', c.zones.B)}
      ${c.zones.C ? zoneRows('C', c.zones.C) : ''}
      ${zoneRows('D', c.zones.D)}
      ${c.zones.E ? zoneRows('E', c.zones.E) : ''}
    </tbody>
    <tfoot>
      <tr class="sub"><td colspan="2">Total Built-up Area (excluding water tank capacity)</td><td class="r">${ni(totalArea)} sq.ft</td></tr>
    </tfoot>
  </table>

  <div class="pg-foot"><span>Area Calculation</span><span>+91 92172 63051 · info@zuildup.com</span></div>
</section>`;
}

function renderCostPage(state, c) {
  const costRow = (key, zone) => {
    if (!zone) return '';
    const tag = `<span class="zone-tag z${key.toLowerCase()}">${key}</span>`;
    return `<tr><td>${tag} Zone ${key}</td><td>${ni(zone.total)}${zone.unit ? ' '+zone.unit : ''}</td><td class="r">${fmtINR(zone.rate)}${zone.unit ? '/'+zone.unit : '/sqft'}</td><td class="r">${fmtINR(zone.cost)}</td></tr>`;
  };
  return `
<section class="pg">
  <div class="pg-head">
    ${logoSvg({ size:'large' })}
    <div class="breadcrumb"><span class="current">Cost Calculation</span></div>
  </div>
  <div class="eyebrow">Step 2</div>
  <h1 class="section">Cost Calculation</h1>
  <p class="lede">Each zone's area multiplied by its applicable rate. Lift cost added separately if enabled. Taxes and any liaisoning are quoted separately, outside this document.</p>

  <table class="calc-table">
    <thead><tr><th>Zone</th><th>Area</th><th class="r">Rate</th><th class="r">Total</th></tr></thead>
    <tbody>
      ${costRow('A', c.zones.A)}
      ${costRow('B', c.zones.B)}
      ${c.zones.C ? costRow('C', c.zones.C) : ''}
      ${costRow('D', c.zones.D)}
      ${c.zones.E ? costRow('E', c.zones.E) : ''}
    </tbody>
    <tfoot>
      <tr class="sub"><td colspan="3">Sub-total (zones)</td><td class="r">${fmtINR(c.zoneSubtotal)}</td></tr>
      ${c.lift ? `<tr class="sub"><td colspan="3">Lift Machine</td><td class="r">${fmtINR(c.lift.cost)}</td></tr>` : ''}
      <tr class="grand"><td colspan="3">Construction Total</td><td class="r">${fmtINR(c.grandTotal)}</td></tr>
    </tfoot>
  </table>

  <p class="lede" style="margin-top:8mm; color: var(--muted); font-size: 11px;">Final billed at actual brand and finish selection. GST and any liaisoning fees are quoted separately outside this document.</p>

  <div class="pg-foot"><span>Cost Calculation</span><span>+91 92172 63051 · info@zuildup.com</span></div>
</section>`;
}

function renderSpecPages(state, sortedCats, byCat) {
  if (!sortedCats.length) {
    return `
<section class="pg">
  <div class="pg-head">${logoSvg({ size:'large' })}<div class="breadcrumb"><span class="current">Specifications</span></div></div>
  <p class="lede" style="margin-top:30mm;text-align:center;">No specifications selected. Add rows from the catalog or create custom items.</p>
</section>`;
  }
  // Group all categories into a single continuous flow page (cards flow naturally with break-inside:avoid)
  const sectionsHtml = sortedCats.map(cat => {
    const cardArr = byCat[cat].map(({row, item: it}) => {
      const o = row.override || {};
      const lab = o.label ?? (it ? it.label : '');
      // P1.3: pricing/brand authoritative ONLY when set in per-row override.
      // Catalog values are template hints — they do not surface on the rendered PDF unless sales has accepted them.
      const rate = (o.rate !== undefined) ? o.rate : 0;
      const rateText = (o.rate_text !== undefined) ? o.rate_text : '';
      const brands = (o.brands !== undefined) ? (o.brands || []) : [];
      const desc = o.description ?? (it ? it.description : '');
      const loc = o.location || '';
      const ratePill = (rateText && rateText.trim())
        ? `<span class="rate-pill">${escapeHtml(rateText)}</span>`
        : (rate > 0 ? `<span class="rate-pill">${fmtINR(rate)}</span>` : `<span class="rate-pill set">Set rate</span>`);
      return `
        <div class="spec-card${(rateText || rate > 0) ? '' : ' unedited'}">
          <h3 class="lab">${escapeHtml(lab)}${loc ? ' <span class="loc">— '+escapeHtml(loc)+'</span>' : ''}</h3>
          ${brands.length ? `<div class="badges">${brands.map(b => `<span class="badge">${escapeHtml(b)}</span>`).join('')}</div>` : ''}
          ${ratePill}
          <p class="desc">${escapeHtml(desc)}</p>
        </div>`;
    });
    return `
      <table class="cat-section">
        <thead>
          <tr><th>
            <h2>${escapeHtml(cat)}<span class="count">${byCat[cat].length} items</span></h2>
          </th></tr>
        </thead>
        <tbody>
          <tr><td>
            <div class="spec-grid">${cardArr.join('')}</div>
          </td></tr>
        </tbody>
      </table>`;
  }).join('');
  return `
<section class="pg">
  <div class="pg-head">
    ${logoSvg({ size:'large' })}
    <div class="breadcrumb"><span class="current">Detailed Specifications</span></div>
  </div>
  <div class="eyebrow">Step 3</div>
  <h1 class="section">Detailed Specifications</h1>
  <p class="lede">Every line item, every brand, every rate. Brand options shown are indicative; final selection confirmed at the brand-picker stage.</p>
  ${sectionsHtml}
  <div class="pg-foot"><span>Specifications</span><span>+91 92172 63051 · info@zuildup.com</span></div>
</section>`;
}

function renderNotesPage(state) {
  return `
<section class="pg">
  <div class="pg-head">
    ${logoSvg({ size:'large' })}
    <div class="breadcrumb"><span class="current">Notes</span></div>
  </div>
  <div class="eyebrow">Internal team notes</div>
  <h1 class="section">Notes &amp; Caveats</h1>
  <div class="notes-block">${escapeHtml(state.notes)}</div>
  <div class="pg-foot"><span>Notes</span><span>+91 92172 63051 · info@zuildup.com</span></div>
</section>`;
}

})();
"""

# ============================================================================
# Emitter — concatenate the parts and write quote.js
# ============================================================================
parts = [QUOTE_JS, QUOTE_JS_PART3, QUOTE_JS_PART4]
# strip the leading-newline glue between parts so the emitted file has no double-blank lines mid-IIFE
out = parts[0].rstrip() + "\n"
for p in parts[1:]:
    # Each PART variable starts with a literal newline; collapse to one
    out += p.lstrip("\n").rstrip() + "\n"

with open(OUT_PATH, "w") as f:
    f.write(out)

print(f"WROTE {OUT_PATH}")
print(f"  size: {len(out)} bytes  ({sum(1 for _ in out.splitlines())} lines)")
