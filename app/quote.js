/* ZuildUp Quotation Builder — shared client logic.
 * Loaded by both index.html (form) and preview.html (right pane / PDF body).
 * State persists in localStorage under key 'zuildup.quote.v1'.
 *
 * Cost calculation logic ported from src_calc/CALCULATOR.html (PACKAGE_RATES + ZONE_RATES + EXACT_AREAS).
 * See bugs.md B4.4 for note on calculator-vs-PPT zone-percentage discrepancy.
 */

(function(){
'use strict';

const STORE_KEY = 'zuildup.quote.v1';

// ---- Calculator constants (ported from CALCULATOR.html) ----
const PACKAGE_RATES = { premium: 1950, platinum: 2850, royale: 4100, custom: 2850 };
const ZONE_RATES    = { A: 1.00, B: 0.50, C: 0.30, D: 0.30 };
const EXACT_AREAS   = {
    "150_premium":   { A: 3330, B: 1665, C: 999,  D: 666  },
    "300_platinum":  { A: 6706, B: 3353, C: 1676, D: 1676 },
    "400_royale":    { A: 9522, B: 6348, C: 3174, D: 3174 },
};

function getAreas(plotSqYards, pkg) {
  const key = plotSqYards + "_" + pkg;
  if (EXACT_AREAS[key]) return EXACT_AREAS[key];
  let baseConfig, scaleFactor;
  if (plotSqYards <= 200) { baseConfig = EXACT_AREAS["150_premium"];  scaleFactor = plotSqYards / 150; }
  else if (plotSqYards <= 350) { baseConfig = EXACT_AREAS["300_platinum"]; scaleFactor = plotSqYards / 300; }
  else { baseConfig = EXACT_AREAS["400_royale"]; scaleFactor = plotSqYards / 400; }
  return {
    A: Math.floor(baseConfig.A * scaleFactor),
    B: Math.floor(baseConfig.B * scaleFactor),
    C: Math.floor(baseConfig.C * scaleFactor),
    D: Math.floor(baseConfig.D * scaleFactor),
  };
}

function calculateAreaCost(plotSqYards, pkg) {
  const baseRate = PACKAGE_RATES[pkg] || PACKAGE_RATES.platinum;
  const areas = getAreas(plotSqYards, pkg);
  let totalCost = 0;
  const breakdown = [];
  const zoneNames = { A:'Main Construction', B:'Secondary Areas', C:'Terrace Areas', D:'Service Areas' };
  for (const z of ['A','B','C','D']) {
    const ratePerSqFt = Math.floor(baseRate * ZONE_RATES[z]);
    const cost = areas[z] * ratePerSqFt;
    totalCost += cost;
    breakdown.push({ zone: z, name: zoneNames[z], area: areas[z], rate: ratePerSqFt, mult: Math.round(ZONE_RATES[z]*100), cost });
  }
  return {
    plotSqYards,
    package: pkg,
    baseRate,
    totalCost,
    perSqFt: Math.floor(totalCost / (areas.A + areas.B + areas.C + areas.D)),
    breakdown,
  };
}

// ---- State ----
const defaultState = () => ({
  customer: { salutation: 'Mr. & Mrs.', name: 'Aanya Kapoor', address: 'Plot 14, Sector 47, Gurugram, Haryana 122001' },
  build:    { plotSqYards: 300, floors: 4, floorSqFt: 1573 },
  scope: 'full',
  package: 'platinum',
  rows: [],          // ordered list of selected catalog item ids + per-row overrides
  quoteId: 'ZB-' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '-' + Math.random().toString(36).slice(2,6).toUpperCase(),
  createdAt: new Date().toISOString().slice(0,10),
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    return Object.assign(defaultState(), s);
  } catch(e) { return defaultState(); }
}
function saveState(s) {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
  // notify other tabs/iframes
  window.dispatchEvent(new Event('quote-state-changed'));
}

// ---- Catalog loader ----
let CATALOG = null;
async function loadCatalog() {
  if (CATALOG) return CATALOG;
  const r = await fetch('/catalog/catalog.json');
  CATALOG = await r.json();
  return CATALOG;
}
function catalogItem(id) { return (CATALOG?.items || []).find(it => it.id === id); }
function defaultRowsFor(pkg, scope) {
  const cat = CATALOG.items.filter(it => {
    if (pkg === 'custom') return false; // custom starts empty
    if (scope === 'structure_only') return it.scope.includes('structure_only');
    return it.scope.includes('full');
  });
  return cat.map(it => ({ id: it.id, override: {} }));
}

// ---- Format helpers ----
function fmtINR(n) {
  if (n === 0 || n === undefined || n === null) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}
function fmtRate(item, pkg) {
  const r = item.rate?.[pkg] || 0;
  if (!r) return '';
  const unitLabel = {
    per_mt: '/MT', per_brick: '/brick', per_bag: '/bag', per_cubic_metre: '/cu.m.',
    per_floor: '/floor', per_fan: '/fan', per_door: '/door',
    per_kitchen: '/kitchen', per_bathroom: '/bathroom', per_sqft: '/sq.ft.',
    per_light: '/light', fixed: '', cap: '',
  }[item.unit] || '';
  return fmtINR(r) + unitLabel;
}
function fmtBrands(item, pkg) {
  const b = item.brands?.[pkg] || [];
  return b.length ? b.join(' · ') : '';
}

// ---- DOM bootstrap differs by page ----
const isFormPage = !!document.getElementById('spec-list');
const isPreviewPage = !!document.getElementById('preview-root');

if (isFormPage) bootForm();
if (isPreviewPage) bootPreview();

// =====================================================================
// FORM PAGE
// =====================================================================
async function bootForm() {
  await loadCatalog();
  let state = loadState();

  // If first load and no rows, seed with defaults for the current package.
  if (!state.rows.length && state.package !== 'custom') {
    state.rows = defaultRowsFor(state.package, state.scope);
    saveState(state);
  }

  // ---- Hydrate inputs ----
  const $ = id => document.getElementById(id);
  $('f-salutation').value = state.customer.salutation;
  $('f-name').value      = state.customer.name;
  $('f-address').value   = state.customer.address;
  $('f-plot').value      = state.build.plotSqYards;
  $('f-floors').value    = state.build.floors;
  $('f-floor-sqft').value= state.build.floorSqFt;
  $('f-package').value   = state.package;
  for (const btn of $('f-scope').querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.v === state.scope);
  }

  function flush() { saveState(state); renderSpecList(); }

  // ---- Field listeners ----
  $('f-salutation').onchange = e => { state.customer.salutation = e.target.value; flush(); };
  $('f-name').oninput        = e => { state.customer.name = e.target.value; flush(); };
  $('f-address').oninput     = e => { state.customer.address = e.target.value; flush(); };
  $('f-plot').oninput        = e => { state.build.plotSqYards = +e.target.value || 0; flush(); };
  $('f-floors').oninput      = e => { state.build.floors = +e.target.value || 1; flush(); };
  $('f-floor-sqft').oninput  = e => { state.build.floorSqFt = +e.target.value || 0; flush(); };
  $('f-package').onchange    = e => {
    state.package = e.target.value;
    state.rows = defaultRowsFor(state.package, state.scope);
    flush();
  };
  for (const btn of $('f-scope').querySelectorAll('button')) {
    btn.onclick = () => {
      for (const b of $('f-scope').querySelectorAll('button')) b.classList.remove('active');
      btn.classList.add('active');
      state.scope = btn.dataset.v;
      // Re-seed rows for the new scope (custom keeps its rows)
      if (state.package !== 'custom') state.rows = defaultRowsFor(state.package, state.scope);
      flush();
    };
  }

  $('reset-default').onclick = () => {
    if (!confirm('Reset specifications to package defaults? Custom rows will be lost.')) return;
    state.rows = defaultRowsFor(state.package, state.scope);
    flush();
  };
  $('add-row').onclick = () => openPicker();
  $('picker-close').onclick = () => closePicker();
  $('picker-search').oninput = () => renderPicker();

  $('dl').onclick = downloadPdf;

  // ---- Spec list ----
  function renderSpecList() {
    const list = $('spec-list');
    list.innerHTML = '';
    state.rows.forEach((row, idx) => {
      const item = catalogItem(row.id);
      if (!item) return;
      const overridden = row.override || {};
      const label = overridden.label ?? item.label;
      const rate  = overridden.rate  ?? item.rate[state.package] ?? 0;
      const brands = overridden.brands ?? item.brands[state.package] ?? [];
      const desc  = overridden.description ?? item.description;

      const el = document.createElement('div');
      el.className = 'spec';
      el.dataset.idx = idx;
      el.innerHTML = `
        <span class="grip" title="drag to reorder">≡</span>
        <span class="head">
          <span class="label">${escapeHtml(label)}</span>
          <span class="meta">${escapeHtml(item.category.toUpperCase())} · ${escapeHtml(brands.join(' · ')) || '—'}</span>
        </span>
        <span class="rate">${rate ? fmtINR(rate) + (item.unit !== 'fixed' ? ' ' + item.unit.replace(/_/g,' ') : '') : '—'}</span>
        <span class="x" data-act="remove" data-idx="${idx}" title="remove">×</span>
      `;
      el.onclick = (e) => {
        if (e.target.dataset.act === 'remove') {
          state.rows.splice(idx, 1);
          flush();
          return;
        }
        toggleEdit(el, idx);
      };
      list.appendChild(el);
    });
    $('spec-count').textContent = state.rows.length + ' items';
    enableDragReorder(list);
  }

  function toggleEdit(el, idx) {
    if (el.classList.contains('editing')) {
      el.classList.remove('editing');
      const ed = el.querySelector('.editor'); if (ed) ed.remove();
      renderSpecList();
      return;
    }
    el.classList.add('editing');
    const item = catalogItem(state.rows[idx].id);
    const o = state.rows[idx].override || {};
    const ed = document.createElement('div');
    ed.className = 'editor';
    ed.innerHTML = `
      <div><label>Label</label><input data-f="label" value="${escapeAttr(o.label ?? item.label)}"></div>
      <div><label>Rate (₹)</label><input data-f="rate" type="number" value="${o.rate ?? item.rate[state.package] ?? 0}"></div>
      <div class="full"><label>Brands (comma-separated)</label><input data-f="brands" value="${escapeAttr((o.brands ?? item.brands[state.package] ?? []).join(', '))}"></div>
      <div class="full"><label>Description</label><textarea data-f="description" rows="2">${escapeHtml(o.description ?? item.description)}</textarea></div>
    `;
    el.appendChild(ed);
    ed.addEventListener('input', (e) => {
      const f = e.target.dataset.f;
      if (!f) return;
      state.rows[idx].override ??= {};
      let v = e.target.value;
      if (f === 'rate') v = +v || 0;
      if (f === 'brands') v = v.split(',').map(s=>s.trim()).filter(Boolean);
      state.rows[idx].override[f] = v;
      saveState(state);
    });
  }

  // ---- Drag-reorder (no library) ----
  function enableDragReorder(container) {
    let dragging = null;
    container.querySelectorAll('.spec').forEach(s => {
      s.draggable = true;
      s.addEventListener('dragstart', e => { dragging = s; s.style.opacity = '0.4'; });
      s.addEventListener('dragend',   e => { s.style.opacity = '1'; dragging = null; });
      s.addEventListener('dragover',  e => { e.preventDefault(); });
      s.addEventListener('drop',      e => {
        e.preventDefault();
        if (!dragging || dragging === s) return;
        const from = +dragging.dataset.idx;
        const to   = +s.dataset.idx;
        const moved = state.rows.splice(from, 1)[0];
        state.rows.splice(to, 0, moved);
        flush();
      });
    });
  }

  // ---- Picker ----
  function openPicker() { document.getElementById('picker').classList.add('open'); document.getElementById('picker-search').value=''; renderPicker(); }
  function closePicker(){ document.getElementById('picker').classList.remove('open'); }
  document.getElementById('picker').addEventListener('click', e => {
    if (e.target.id === 'picker') closePicker();
  });
  function renderPicker() {
    const q = document.getElementById('picker-search').value.toLowerCase().trim();
    const body = document.getElementById('picker-body');
    body.innerHTML = '';
    const present = new Set(state.rows.map(r => r.id));
    for (const it of CATALOG.items) {
      if (q && !(it.label.toLowerCase().includes(q) || it.category.toLowerCase().includes(q))) continue;
      if (state.scope === 'structure_only' && !it.scope.includes('structure_only')) continue;
      const el = document.createElement('div');
      el.className = 'item' + (present.has(it.id) ? ' added' : '');
      const r = it.rate?.[state.package] || 0;
      el.innerHTML = `
        <span class="l">
          <span class="lab">${escapeHtml(it.label)}</span><br>
          <span class="cat">${escapeHtml(it.category)}</span>
        </span>
        <span class="r">${r ? fmtINR(r) + ' ' + it.unit.replace(/_/g,' ') : 'fixed'}</span>
      `;
      el.onclick = () => {
        if (present.has(it.id)) return;
        state.rows.push({ id: it.id, override: {} });
        flush();
        closePicker();
      };
      body.appendChild(el);
    }
  }

  // ---- Download PDF: gather preview-iframe HTML, POST it, save returned blob ----
  async function downloadPdf() {
    const btn = document.getElementById('dl');
    btn.disabled = true; btn.textContent = 'Building PDF…';
    try {
      // Pull the preview iframe's HTML in full
      const iframe = document.getElementById('preview');
      const doc = iframe.contentDocument;
      const html = '<!doctype html>' + doc.documentElement.outerHTML;
      const fname = ['zuildup-quote', state.quoteId, state.customer.name.replace(/\s+/g,'_')].join('-');
      const r = await fetch('/pdf?filename=' + encodeURIComponent(fname), {
        method: 'POST',
        headers: { 'Content-Type': 'text/html' },
        body: html,
      });
      if (!r.ok) {
        const t = await r.text();
        alert('PDF render failed:\n' + t.slice(0, 400));
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

  // ---- Initial render ----
  renderSpecList();
}

// =====================================================================
// PREVIEW PAGE — renders the quote document
// =====================================================================
async function bootPreview() {
  await loadCatalog();
  function paint() {
    const state = loadState();
    // If no rows yet (preview opened standalone before the form ever ran), seed defaults
    if (!state.rows.length && state.package !== 'custom') {
      state.rows = defaultRowsFor(state.package, state.scope);
      // Don't saveState here — that would race with the form page; just render with seeded rows
    }
    document.getElementById('preview-root').innerHTML = renderQuote(state);
  }
  paint();
  window.addEventListener('storage', paint);
  window.addEventListener('quote-state-changed', paint);
  // Also poll every 500 ms in case of cross-iframe localStorage update without storage event in same window
  setInterval(paint, 500);
}

function renderQuote(state) {
  const pkg = state.package;
  const item = id => catalogItem(id);
  const cost = calculateAreaCost(state.build.plotSqYards, pkg);
  const heroPath = '/assets/lookbook/' + (pkg === 'custom' ? 'platinum' : pkg) + '/slide-01.png';

  // Group rows by category for the spec section
  const byCat = {};
  for (const row of state.rows) {
    const it = item(row.id); if (!it) continue;
    (byCat[it.category] ||= []).push({ row, item: it });
  }
  const catOrder = ['structure','steel','cement','waterproofing','water','ceiling','flooring','electrical','kitchen','bathroom','paint','doors_windows','parapet','general'];
  const sortedCats = catOrder.filter(c => byCat[c]).concat(Object.keys(byCat).filter(c=>!catOrder.includes(c)));

  return `
  <style>
    @page { size: A4; margin: 0; }
    .pg { width: 210mm; min-height: 297mm; padding: 24mm 22mm; box-sizing: border-box; background: var(--offwhite, #F9FAF7); page-break-after: always; }
    .pg.cover { padding: 0; position: relative; overflow: hidden; background: var(--navy, #0A1F44); height: 297mm; }
    .pg.cover .hero { position: absolute; inset:0; background: url('${heroPath}') center 30% / cover; }
    .pg.cover .vignette { position:absolute; inset:0; background: linear-gradient(180deg, rgba(10,31,68,.42) 0%, rgba(10,31,68,.10) 35%, rgba(10,31,68,.78) 100%); }
    .pg.cover .top, .pg.cover .footer-bar { position: absolute; left: 18mm; right: 18mm; display:flex; justify-content:space-between; align-items:center; }
    .pg.cover .top { top: 18mm; }
    .pg.cover .footer-bar { bottom: 14mm; align-items: flex-end; }
    .pg.cover .customer { position:absolute; left: 18mm; right:18mm; bottom: 64mm; color:white; text-align:center; }
    .pg.cover .rule { position:absolute; left:50%; transform:translateX(-50%); bottom:132mm; width:56px; height:1px; background: var(--gold,#C9A24D); opacity:.9; }
    .pg.cover .eyebrow { color: var(--gold,#C9A24D); font-size: 11px; letter-spacing:.32em; text-transform:uppercase; font-weight:500; margin-bottom: 18px; }
    .pg.cover .name-h { font-family: 'Fraunces', serif; font-weight: 500; font-size: 56px; line-height: 1.05; letter-spacing:-.01em; margin: 0 0 12px; }
    .pg.cover .address { font-size:15px; color: rgba(255,255,255,.72); line-height:1.5; max-width:400px; margin: 0 auto;}
    .pg.cover .pill { color: var(--navy,#0A1F44); background: var(--gold,#C9A24D); padding: 6px 14px; border-radius: 999px; font-size: 10px; letter-spacing: .22em; font-weight: 600; }
    .pg.cover .qid  { color: rgba(255,255,255,.72); text-align:right; font-size: 9.5px; letter-spacing:.2em; text-transform:uppercase; line-height: 1.55; }
    .pg.cover .qid .qid-num { display:block; color: white; font-size: 13px; letter-spacing:.06em; font-weight: 500; margin-top: 2px; }
    .pg.cover .meta-tag { color: rgba(255,255,255,.72); font-size: 10px; letter-spacing:.18em; text-transform:uppercase; font-weight:500; }

    .head { display:flex; justify-content: space-between; align-items: flex-end; padding-bottom: 10mm; border-bottom: 1px solid rgba(10,31,68,.10); margin-bottom: 8mm; }
    .head .breadcrumb { color: var(--muted,#5C6373); font-size: 10px; letter-spacing:.22em; text-transform:uppercase; font-weight:500; text-align:right; }
    .head .breadcrumb .current { color: var(--navy,#0A1F44); font-weight: 600; }

    .eyebrow { color: var(--gold,#C9A24D); font-size: 11px; letter-spacing:.32em; text-transform:uppercase; font-weight: 600; margin-bottom: 4px; }
    h1.section { font-family:'Fraunces',serif; font-weight:500; font-size: 32px; line-height:1.15; margin: 4px 0 4mm; color: var(--navy,#0A1F44); letter-spacing:-.01em; }
    p.lede   { color: var(--muted,#5C6373); font-size: 13px; line-height:1.65; max-width: 420px; margin: 0 0 8mm; }

    /* About / Process / Warranty / Timeline / CTA */
    .about-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 10mm; }
    .stat    .row.cost-tot { font-weight: 700; color: var(--navy,#0A1F44); border-top: 2px solid var(--navy,#0A1F44); }

    /* Spec cards */
    .cat-section { margin-bottom: 14mm; page-break-inside: avoid; }
    .cat-eyebrow { color: var(--gold,#C9A24D); font-size: 10px; letter-spacing:.30em; text-transform:uppercase; font-weight: 600; margin-bottom: 6px; }
    .cat-title { font-family:'Fraunces',serif; font-size: 22px; color: var(--navy,#0A1F44); font-weight:500; margin: 0 0 8px; letter-spacing:-.005em; }
    .spec-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .spec-card { background: white; border-radius: 10px; padding: 12px 14px; box-shadow: 0 1px 0 rgba(10,31,68,.04); border: 1px solid rgba(10,31,68,.06); display:flex; flex-direction:column; gap: 6px; }
    .spec-card .lab { font-family:'Fraunces',serif; font-size: 14.5px; font-weight: 500; color: var(--navy,#0A1F44); margin: 0; line-height: 1.25; }
    .spec-card .badges { display:flex; flex-wrap: wrap; gap: 4px; }
    .spec-card .badge { background: rgba(10,31,68,.06); color: var(--navy,#0A1F44); padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 500; }
    .spec-card .rate-pill { align-self: flex-start; background: var(--navy,#0A1F44); color: white; padding: 4px 10px; border-radius: 999px; font-size: 10.5px; font-weight: 600; }
    .spec-card .rate-pill .u { font-weight: 400; color: rgba(255,255,255,.7); margin-left: 3px; font-size:10px; }
    .spec-card .desc { color: var(--ink,#1B1F2A); font-size: 11px; line-height: 1.5; margin: 2px 0 0; }

    .pg.specs { padding-top: 18mm; }

    /* Footer */
    .pg-foot { position: absolute; bottom: 12mm; left: 22mm; right: 22mm; display:flex; justify-content: space-between; color: var(--muted,#5C6373); font-size: 9px; letter-spacing:.18em; text-transform:uppercase; font-weight:500; padding-top: 5mm; border-top: 1px solid rgba(10,31,68,.10); }

    body { margin: 0; font-family: 'Inter', system-ui, sans-serif; color: var(--ink,#1B1F2A); background: var(--offwhite,#F9FAF7); -webkit-font-smoothing: antialiased; }
    :root { --navy:#0A1F44; --gold:#C9A24D; --offwhite:#F9FAF7; --ink:#1B1F2A; --muted:#5C6373; }
  </style>

  <!-- =========================== COVER =========================== -->
  <section class="pg cover">
    <div class="hero"></div>
    <div class="vignette"></div>
    <div class="top">
      ${zuildupLogo({fill:'#F4D58A', textFill:'white'})}
      <div class="meta-tag">DELHI&nbsp;NCR · Estd 2024</div>
    </div>
    <div class="rule"></div>
    <div class="customer">
      <div class="eyebrow">Custom Home Quotation</div>
      <h1 class="name-h">${escapeHtml(state.customer.salutation + ' ' + state.customer.name)}</h1>
      <div class="address">${escapeHtml(state.customer.address).split(',').slice(0,2).join(',')}<br>${escapeHtml(state.customer.address).split(',').slice(2).join(', ').trim()}<br>${state.build.floors}-floor independent residence · ${state.build.floorSqFt.toLocaleString('en-IN')}&nbsp;sq&nbsp;ft per floor</div>
    </div>
    <div class="footer-bar">
      <div><span class="pill">${(pkg === 'custom' ? 'Custom' : pkg).toUpperCase()} PACKAGE</span></div>
      <div class="qid">Quote ID<span class="qid-num">${state.quoteId}</span>${formatDate(state.createdAt)}</div>
    </div>
  </section>

  <!-- =========================== AREA & COST =========================== -->
  <section class="pg">
    <div class="head">
      ${zuildupLogo({fill:'#C9A24D', textFill:'#0A1F44', small:true})}
      <div class="breadcrumb">Quote · ${escapeHtml(state.quoteId)} · <span class="current">Area &amp; Cost</span></div>
    </div>
    <div class="eyebrow">Investment Summary</div>
    <h1 class="section">Area &amp; Build Cost</h1>
    <p class="lede">Computed from a ${state.build.plotSqYards}-sq-yd plot for the ${pkg.toUpperCase()} package, using zoned area multipliers (A: full, B: 50%, C/D: 30%) on a base rate of ${fmtINR(cost.baseRate)}/sq&nbsp;ft.</p>

    <div class="cost-table">
      <div class="row head-row" style="font-weight:600;color:var(--navy);border-bottom:1px solid rgba(10,31,68,.15);"><span>Zone</span><span>Area (sq ft)</span><span>Rate/sq ft</span><span>Total</span></div>
      ${cost.breakdown.map(b => `
        <div class="row" style="display:grid;grid-template-columns: 2fr 1fr 1fr 1.4fr;padding: 8px 0;border-bottom: 1px solid rgba(10,31,68,.06);font-size:13px;">
          <span><strong>${b.zone}</strong> · ${b.name} <span style="color:var(--muted);font-size:11px;">(${b.mult}%)</span></span>
          <span style="text-align:right;font-variant-numeric:tabular-nums;">${b.area.toLocaleString('en-IN')}</span>
          <span style="text-align:right;font-variant-numeric:tabular-nums;">${fmtINR(b.rate)}</span>
          <span style="text-align:right;font-variant-numeric:tabular-nums;">${fmtINR(b.cost)}</span>
        </div>
      `).join('')}
      <div class="row cost-tot" style="display:grid;grid-template-columns: 2fr 1fr 1fr 1.4fr;padding: 12px 0 4px;font-size:14px;">
        <span>Total Build Cost</span><span></span><span></span>
        <span style="text-align:right;font-variant-numeric:tabular-nums;">${fmtINR(cost.totalCost)}</span>
      </div>
    </div>

    <p class="lede" style="margin-top:8mm;">Approx. <strong>${fmtINR(cost.perSqFt)}/sq&nbsp;ft</strong> blended cost across all zones. Final billed at actual brand and finish selection.</p>

    <div class="pg-foot">
      <span>Page 2 · Area &amp; Cost</span>
      <span>+91 92172 63051 · info@zuildup.com</span>
    </div>
  </section>

  <!-- =========================== DETAILED SPECS =========================== -->
  ${sortedCats.length === 0 ? `
    <section class="pg specs">
      <div class="head">${zuildupLogo({fill:'#C9A24D', textFill:'#0A1F44', small:true})}<div class="breadcrumb">Quote · ${escapeHtml(state.quoteId)} · <span class="current">Specifications</span></div></div>
      <p class="lede" style="margin-top:30mm;text-align:center;color:var(--muted);">No line items selected. ${pkg === 'custom' ? 'Add rows from the catalog to start building this Custom quote.' : 'Reset to Package defaults to populate.'}</p>
    </section>
  ` : sortedCats.map((cat, ci) => {
    const cards = byCat[cat].map(({row, item: it}) => {
      const o = row.override || {};
      const lab = o.label ?? it.label;
      const r = o.rate ?? it.rate[pkg] ?? 0;
      const brands = o.brands ?? it.brands[pkg] ?? [];
      const desc = o.description ?? it.description;
      const unitLabel = {
        per_mt:'per MT', per_brick:'per brick', per_bag:'per bag', per_cubic_metre:'per cu.m.',
        per_floor:'per floor', per_fan:'per fan', per_door:'per door',
        per_kitchen:'per kitchen', per_bathroom:'per bathroom', per_sqft:'per sq.ft.',
        per_light:'per light', fixed:'', cap:''
      }[it.unit] || '';
      return `
        <div class="spec-card">
          <h3 class="lab">${escapeHtml(lab)}</h3>
          ${brands.length ? `<div class="badges">${brands.map(b=>`<span class="badge">${escapeHtml(b)}</span>`).join('')}</div>` : ''}
          ${r ? `<span class="rate-pill">${fmtINR(r)}<span class="u"> ${escapeHtml(unitLabel)}</span></span>` : `<span class="rate-pill" style="background:rgba(10,31,68,.08);color:var(--navy);">Included</span>`}
          <p class="desc">${escapeHtml(desc)}</p>
        </div>
      `;
    }).join('');
    const isFirstSpecPage = ci === 0;
    return `
      <section class="pg specs">
        ${isFirstSpecPage ? `
          <div class="head">${zuildupLogo({fill:'#C9A24D', textFill:'#0A1F44', small:true})}<div class="breadcrumb">Quote · ${escapeHtml(state.quoteId)} · <span class="current">Detailed Specifications</span></div></div>
          <div class="eyebrow">Per-Tier Specifications</div>
          <h1 class="section">Detailed Specifications</h1>
          <p class="lede">Every line item, every brand, every rate. Brand options shown are indicative; final selection is confirmed with you at the brand-picker stage.</p>
        ` : `
          <div class="head">${zuildupLogo({fill:'#C9A24D', textFill:'#0A1F44', small:true})}<div class="breadcrumb">Quote · ${escapeHtml(state.quoteId)} · <span class="current">Specifications (cont.)</span></div></div>
        `}
        <div class="cat-section">
          <div class="cat-eyebrow">${escapeHtml(prettifyCategory(cat))}</div>
          <div class="spec-grid">${cards}</div>
        </div>
        <div class="pg-foot"><span>Specifications</span><span>+91 92172 63051 · info@zuildup.com</span></div>
      </section>
    `;
  }).join('')}
  `;
}

function zuildupLogo({ fill = '#C9A24D', textFill = '#0A1F44', small = false } = {}) {
  const w = small ? 96 : 152;
  return `
    <svg width="${w}" viewBox="0 0 114 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M15 21V13C15 12.7348 14.8946 12.4804 14.7071 12.2929C14.5196 12.1054 14.2652 12 14 12H10C9.73478 12 9.48043 12.1054 9.29289 12.2929C9.10536 12.4804 9 12.7348 9 13V21" stroke="${fill}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M3 10C2.99993 9.71 3.063 9.422 3.186 9.158C3.308 8.894 3.487 8.66 3.709 8.472L10.709 2.472C11.07 2.167 11.527 2 12 2C12.473 2 12.93 2.167 13.291 2.472L20.291 8.472C20.513 8.66 20.692 8.894 20.814 9.158C20.937 9.422 21 9.71 21 10V19C21 19.531 20.789 20.04 20.414 20.415C20.039 20.79 19.53 21 19 21H5C4.47 21 3.961 20.79 3.586 20.415C3.211 20.04 3 19.531 3 19V10Z" stroke="${fill}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="28" y="17" font-family="Inter, sans-serif" font-size="12" font-weight="600" fill="${textFill}" letter-spacing="0.5">ZuildUp</text>
    </svg>
  `;
}

function prettifyCategory(cat) {
  const map = {
    structure:'Structure', steel:'Steel', cement:'Cement & Concrete',
    waterproofing:'Waterproofing', water:'Water Management', ceiling:'Ceiling',
    flooring:'Flooring', electrical:'Electrical', kitchen:'Kitchen',
    bathroom:'Bathroom & Toilet', paint:'Paint & Polish',
    doors_windows:'Doors, Windows & Wardrobe', parapet:'Compound Wall & Parapet',
    general:'General Aspects',
  };
  return map[cat] || cat;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function formatDate(iso) {
  const [y,m,d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d,10)} ${months[parseInt(m,10)-1]} ${y}`;
}

})();
