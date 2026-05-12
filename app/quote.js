/* ZuildUp Quotation Builder — quote.js (Phase 2 P0.2)
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
const C_RATE             = 500;       // 7G-B: Zone C — Terrace + Ramp + Setback (₹/sqft) — Hardik baseline
const D_RATE             = 1000;      // Reserved (canonical defines but Zone D in canonical is water-tank)
const LIFT_COST          = 1000000;   // 7G-B: Lift machine fixed cost (₹10,00,000) — Hardik baseline
const STRUCT_B_RATE      = 500;       // Structure-only mode Zone B fixed rate (₹/sqft)
const BASEMENT_RATE      = 2700;      // Zone E — Basement (₹/sqft)
const WATER_TANK_RATE    = 15;        // Zone D — Underground water tank (₹/litre)
const WATER_TANK_PER_FLOOR = 2000;    // Litres per floor
const BALCONY_DEPTH      = 5;         // ft
const RAMP_DEPTH         = 6;         // ft
const STAIRCASE_PER_FLOOR = 125;      // sqft per level
const LIFT_PER_FLOOR     = 25;        // sqft per level
// Phase 7E-A Item 1 — single source of truth for floor display labels.
// Used by calcPackage, calcStructure AND buildFloorSummary so the
// floor-area summary table matches the cost-sheet zone-A item names.
const FLOOR_DISPLAY_NAMES = ['Ground Floor','First Floor','Second Floor','Third Floor','Fourth Floor'];

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
    // Phase 7B Item 3: opt-in Underground Water Tank (Zone D). Default TRUE
    // so existing quotes (and new ones) keep the historical behavior.
    // Saved-quote migration (loadState): if the field is absent, treat as TRUE.
    hasWaterTank: true,
  },
  // pricing — team enters per quote
  // GST and liaisoning are intentionally NOT in the quote calculator.
  // Per ZuildUp practice they're handled outside this document in the
  // sales/commercial conversation. Canonical total = Σ(zones) + lift cost.
  pricing: {
    costPerSqft: null,           // ₹/sqft for Zone A (full-build modes)
    structureRate: null,         // ₹/sqft for structure-only mode
    // P3 #3 + #4: per-zone rate overrides (null/'' => formula default).
    zoneARate:    null,          // override Zone A (default = costPerSqft)
    zoneBRate:    null,          // override Zone B (default = 50% of A)
    zoneCRate:    null,          // 7G-B: override Zone C (default = 500 ₹/sqft, Hardik baseline)
    zoneDRate:    null,          // override Zone D (default = 15 ₹/L)
    basementRate: null,          // override Zone E basement (default = 2700 ₹/sqft)
    // P3 v2 (A): per-line-item rate overrides. Key '<zone>:<item.name>' -> ₹/sqft (or ₹/L for Zone D).
    // null/missing => use zone default. Lets sales charge Terrace ₹650 while keeping Ramp/Setback at ₹600.
    itemRates: {},
    // 7G-B: editable lift machine cost (default ₹10,00,000, Hardik baseline). null = default.
    liftCost: null,
    // Phase 6.3: opt-in additional charge zones, appended to the cost sheet
    // AFTER the static A/B/C/D/E zones. Each disabled by default → omitted
    // entirely from the customer artifact when off. Letters assigned dynamically
    // (next available after the live zones list).
    additionalZones: {
      elevation: { enabled: false, desc: '', cost: 0 },
      gst:       { enabled: false, desc: '', cost: 0 },
      // Phase 7B Item 16: `custom` is now an array — rep can stack multiple
      // ad-hoc charges. Migration: legacy `custom: {…}` is wrapped in an
      // array on load (see loadState). New shape: [{enabled, name, desc, cost, id}].
      custom:    [],
    },
    // Phase 6.2 — Per-floor balcony pricing. Opt-in. When OFF, balcony renders
    // as a single combined Zone B row using the Zone B default rate (unchanged
    // from pre-6.2). When ON, balcony expands to N rows (one per floor) each
    // with its own independent rate (NOT an override on top of Zone B default).
    // `rates` is parallel to floors: rates[i] is the rate for floor i+1; null
    // means "fall back to Zone B default" so calc never breaks if rep leaves a
    // cell blank. PDF collapse rule (renderCostPage): when enabled AND all
    // entered per-floor rates are numerically equal, collapse back to a single
    // "Balcony" row in the customer PDF — keeps the artifact clean if the rep
    // just used the toggle to enter one rate. Editor always shows N rows.
    balconyPerFloor: {
      enabled: false,
      rates: [],   // length === build.floors when enabled; null entry → Zone B default
    },
    // Phase 7B Item 14: per-quote editable lift / staircase sqft (defaults
    // 25 / 125). null/'' → use the canonical constant.
    liftSqftPerLevel:      null,
    staircaseSqftPerLevel: null,
    // Phase 7B Item 15: ad-hoc line items added by the rep, bucketed per zone.
    // Schema: { 'A': [{name, desc, area, rate, id}, ...], 'B': [...], ... }
    // These flow into the relevant zone's items array at calc time and roll
    // into zone.cost. Persist on save/load like everything else.
    zoneLineItems: {},
    // Phase 7B Item 17: per-line-item name + description overrides for the
    // STATIC items emitted by the calc engine (Ground Floor, Stilt, Terrace,
    // Basement, etc). Key '<zone>:<originalName>' -> string. Renderers fall
    // back to the calc-engine-generated default if no override is set.
    itemNameOverrides: {},
    itemDescOverrides: {},
    // Phase 7E-C Item 11: per-row floor-summary overrides. Keyed by row label.
    floorSummaryOverrides: {},
  },
  scope: 'full',                 // 'full' | 'structure_only'
  rows: [],                      // [{id, override:{label?, rate?, rate_text?, brands?, description?, location?}, _custom?:bool}]
  notes: '',
  // P1.6: DRAFT watermark toggle. When true, every PDF page gets a diagonal "DRAFT" overlay.
  draft: false,
  // P3 #6: specs layout — 'grid' (cards) or 'table' (compact table form).
  // 7H-C: default flipped to 'table' (was 'grid'). Sales reps requested.
  specsLayout: 'table',
  // P3 v2 (C): per-category open/close state in left-rail spec list.
  // Default: all collapsed. Lives in state but excluded from PDF render.
  _uiCatOpen: {},
  // Picker UI: which category sections are open (default all collapsed).
  _uiPickerOpen: {},
  // P3 #7: per-line area overrides. Key '<zone>:<item.name>' -> integer sq.ft (or L for Zone D).
  areaOverrides: {},
  quoteId: '',  // P3 #2: assigned by server (/api/next-quote-id) on first save
  createdAt: new Date().toISOString().slice(0,10),
});

function loadState() {
  // P1.5: prefer the active named slot. Falls back to scratch state (zuildup.quote.v2)
  // when no active id is set, or the active id points to a missing slot.
  try {
    const aid = localStorage.getItem('zuildup.active_quote_id');
    if (aid) {
      const slotRaw = localStorage.getItem('zuildup.quotes.' + aid);
      if (slotRaw) {
        const s = JSON.parse(slotRaw);
        const d = defaultState();
        return {
          ...d, ...s,
          customer: { ...d.customer, ...(s.customer||{}) },
          build:    (function(sb){
            // Phase 7B Item 3: legacy quotes had no `hasWaterTank`. Treat absence
            // as TRUE so historical totals don't suddenly drop Zone D.
            const merged = { ...d.build, ...(sb||{}) };
            if (sb && !('hasWaterTank' in sb)) merged.hasWaterTank = true;
            return merged;
          })(s.build),
          pricing:  {
            ...d.pricing, ...(s.pricing||{}),
            itemRates: { ...(d.pricing.itemRates||{}), ...((s.pricing&&s.pricing.itemRates)||{}) },
            // Phase 6.3 + Phase 7B Item 16: `custom` was upgraded from object → array of
            // charges. Migration: legacy object is wrapped in [obj]. Each custom row
            // has its own toggle / fields.
            additionalZones: {
              elevation: { ...d.pricing.additionalZones.elevation, ...((s.pricing&&s.pricing.additionalZones&&s.pricing.additionalZones.elevation)||{}) },
              gst:       { ...d.pricing.additionalZones.gst,       ...((s.pricing&&s.pricing.additionalZones&&s.pricing.additionalZones.gst)||{}) },
              custom:    (function(rawCustom){
                if (Array.isArray(rawCustom)) return rawCustom.slice();
                if (rawCustom && typeof rawCustom === 'object' && (rawCustom.enabled || rawCustom.name || rawCustom.cost)) {
                  return [{ ...rawCustom }];
                }
                return [];
              })(s.pricing && s.pricing.additionalZones && s.pricing.additionalZones.custom),
            },
            // Phase 7B Items 14/15/17: defaults when absent on legacy quotes.
            zoneLineItems:     { ...(d.pricing.zoneLineItems||{}),     ...((s.pricing&&s.pricing.zoneLineItems)||{}) },
            floorSummaryOverrides: { ...(d.pricing.floorSummaryOverrides||{}), ...((s.pricing&&s.pricing.floorSummaryOverrides)||{}) },
            itemNameOverrides: { ...(d.pricing.itemNameOverrides||{}), ...((s.pricing&&s.pricing.itemNameOverrides)||{}) },
            itemDescOverrides: { ...(d.pricing.itemDescOverrides||{}), ...((s.pricing&&s.pricing.itemDescOverrides)||{}) },
            // Phase 6.2: per-floor balcony pricing — preserve rep entries.
            balconyPerFloor: {
              ...d.pricing.balconyPerFloor,
              ...((s.pricing&&s.pricing.balconyPerFloor)||{}),
              rates: Array.isArray(s.pricing&&s.pricing.balconyPerFloor&&s.pricing.balconyPerFloor.rates)
                ? s.pricing.balconyPerFloor.rates.slice() : [],
            },
          },
        };
      }
      // Stale active id — clear it.
      localStorage.removeItem('zuildup.active_quote_id');
    }
  } catch (_) {}

  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    // shallow-merge so newly-added fields get defaults
    const d = defaultState();
    return {
      ...d, ...s,
      customer: { ...d.customer, ...(s.customer||{}) },
      build:    (function(sb){
            // Phase 7B Item 3: legacy quotes had no `hasWaterTank`. Treat absence
            // as TRUE so historical totals don't suddenly drop Zone D.
            const merged = { ...d.build, ...(sb||{}) };
            if (sb && !('hasWaterTank' in sb)) merged.hasWaterTank = true;
            return merged;
          })(s.build),
      pricing:  {
        ...d.pricing, ...(s.pricing||{}),
        itemRates: { ...(d.pricing.itemRates||{}), ...((s.pricing&&s.pricing.itemRates)||{}) },
        // Phase 6.3 + Phase 7B Item 16: `custom` was upgraded from object → array of
        // charges. Migration: legacy object is wrapped in [obj]. Each custom row
        // has its own toggle / fields.
        additionalZones: {
          elevation: { ...d.pricing.additionalZones.elevation, ...((s.pricing&&s.pricing.additionalZones&&s.pricing.additionalZones.elevation)||{}) },
          gst:       { ...d.pricing.additionalZones.gst,       ...((s.pricing&&s.pricing.additionalZones&&s.pricing.additionalZones.gst)||{}) },
          custom:    (function(rawCustom){
            if (Array.isArray(rawCustom)) return rawCustom.slice();
            if (rawCustom && typeof rawCustom === 'object' && (rawCustom.enabled || rawCustom.name || rawCustom.cost)) {
              return [{ ...rawCustom }];
            }
            return [];
          })(s.pricing && s.pricing.additionalZones && s.pricing.additionalZones.custom),
        },
        // Phase 7B Items 14/15/17: defaults when absent on legacy quotes.
        zoneLineItems:     { ...(d.pricing.zoneLineItems||{}),     ...((s.pricing&&s.pricing.zoneLineItems)||{}) },
        floorSummaryOverrides: { ...(d.pricing.floorSummaryOverrides||{}), ...((s.pricing&&s.pricing.floorSummaryOverrides)||{}) },
        itemNameOverrides: { ...(d.pricing.itemNameOverrides||{}), ...((s.pricing&&s.pricing.itemNameOverrides)||{}) },
        itemDescOverrides: { ...(d.pricing.itemDescOverrides||{}), ...((s.pricing&&s.pricing.itemDescOverrides)||{}) },
        // Phase 6.2: per-floor balcony pricing — preserve rep entries.
        balconyPerFloor: {
          ...d.pricing.balconyPerFloor,
          ...((s.pricing&&s.pricing.balconyPerFloor)||{}),
          rates: Array.isArray(s.pricing&&s.pricing.balconyPerFloor&&s.pricing.balconyPerFloor.rates)
            ? s.pricing.balconyPerFloor.rates.slice() : [],
        },
      },
    };
  } catch(e) { return defaultState(); }
}
// P3 #2: fetch a server-assigned ZUI-YYYY-NNNN quote id. Mutates state.quoteId.
async function ensureQuoteId(state) {
  if (state.quoteId && state.quoteId.startsWith('ZUI-')) return state.quoteId;
  try {
    const r = await fetch('/api/next-quote-id', { method: 'POST' });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    state.quoteId = j.id;
    return j.id;
  } catch (e) {
    const yr = new Date().getFullYear();
    state.quoteId = 'ZUI-' + yr + '-LOCAL';
    return state.quoteId;
  }
}

function saveState(s) {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
  // P1.5: if there's an active named quote, also persist into the named slot
  // and keep the index entry's modified_at fresh. This is what makes the
  // toolbar "Saved at HH:MM" indicator update on every keystroke once the
  // user has explicitly Saved (or Loaded) into a named slot. If they're in
  // scratch mode (no active id), we keep zuildup.quote.v2 as the only copy.
  try {
    const aid = QuoteStorage.activeId();
    if (aid) QuoteStorage._touch(aid, s);
  } catch(_){}
  window.dispatchEvent(new Event('quote-state-changed'));
}

// ============================================================================
// QuoteStorage — P1.5 named-slot persistence (multi-customer)
// ============================================================================
// localStorage layout:
//   zuildup.quotes.<id>     — full state object (id is q_<ts>_<6-rand>)
//   zuildup.quotes.index    — array [{id, name, customer_name, created_at, modified_at, row_count}]
//   zuildup.active_quote_id — string, currently-open quote (or empty for scratch)
//   zuildup.quote.v2        — kept for scratch state / backward-compat
//
// The storage layer is intentionally side-effect-free w.r.t. the global state:
// callers pass a full state object in, get it back out. The bootForm code is
// the only place that reconciles QuoteStorage with the in-memory `state` var.
const QuoteStorage = {
  IDX_KEY:    'zuildup.quotes.index',
  ACTIVE_KEY: 'zuildup.active_quote_id',
  PFX:        'zuildup.quotes.',

  // ---- Phase 4: cloud sync (Firestore via /api/quotes) ----
  _syncEnabled: true,        // toggle off if API repeatedly fails
  _pendingPushes: 0,         // count of in-flight pushes (for indicator)
  _failureCount: 0,          // consecutive API failures; >= 3 turns sync off
  _lastSyncedAt: null,

  _onSyncStateChange() {
    try { window.dispatchEvent(new CustomEvent('quote-sync-state-changed', { detail: { pending: this._pendingPushes, enabled: this._syncEnabled } })); } catch (_) {}
  },

  /** Fire-and-forget API push. Resolves after the request completes (success or fail). */
  async _apiPush(method, id, body) {
    if (!this._syncEnabled) return null;
    this._pendingPushes++;
    this._onSyncStateChange();
    try {
      const url = id ? ('/api/quotes/' + encodeURIComponent(id)) : '/api/quotes';
      const opts = { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const r = await fetch(url, opts);
      if (!r.ok) {
        this._failureCount++;
        if (this._failureCount >= 3) { this._syncEnabled = false; console.warn('[QuoteStorage] sync disabled after 3 failures'); }
        const txt = await r.text().catch(() => '');
        throw new Error('http ' + r.status + ' ' + txt.slice(0, 200));
      }
      this._failureCount = 0;
      this._lastSyncedAt = new Date().toISOString();
      const j = await r.json().catch(() => null);
      return j;
    } catch (e) {
      console.warn('[QuoteStorage] _apiPush failed', method, id, e.message);
      return null;
    } finally {
      this._pendingPushes--;
      this._onSyncStateChange();
    }
  },

  /** Fetch a single full slot from cloud and write it to local. */
  async _apiFetch(id) {
    if (!this._syncEnabled) return null;
    try {
      const r = await fetch('/api/quotes/' + encodeURIComponent(id), { credentials: 'same-origin' });
      if (!r.ok) return null;
      const doc = await r.json();
      // Persist the inner state into local slot, and merge index entry.
      if (doc && doc.id && doc.state) {
        localStorage.setItem(this._slotKey(doc.id), JSON.stringify(doc.state));
        const idx = this._readIndex().filter(e => e.id !== doc.id);
        const entry = {
          id: doc.id,
          name: doc.name || '',
          customer_name: doc.customer_name || '',
          author: doc.author || '',
          created_at: doc.created_at || '',
          modified_at: doc.modified_at || '',
          row_count: doc.row_count || 0,
        };
        this._writeIndex([entry, ...idx]);
      }
      return doc;
    } catch (_) { return null; }
  },

  /** Pull the full quote library from cloud and merge into localStorage.
   *  - Quotes that exist remotely but not locally → fetched and stored.
   *  - Quotes that exist remotely with newer modified_at → fetched and overwritten.
   *  - Quotes that exist locally but not remotely → pushed up (migration).
   *  Returns a summary { fetched, pushed, total }.
   */
  async syncFromCloud() {
    if (!this._syncEnabled) return { fetched: 0, pushed: 0, total: 0, skipped: true };
    let fetched = 0, pushed = 0;
    try {
      const r = await fetch('/api/quotes', { credentials: 'same-origin' });
      if (!r.ok) {
        this._failureCount++;
        if (this._failureCount >= 3) this._syncEnabled = false;
        return { fetched, pushed, total: 0, error: 'http ' + r.status };
      }
      this._failureCount = 0;
      const j = await r.json();
      const remote = (j && j.items) || [];
      const remoteById = {};
      for (const e of remote) remoteById[e.id] = e;

      const localIdx = this._readIndex();
      const localById = {};
      for (const e of localIdx) localById[e.id] = e;

      // 1) Fetch remote-only or remote-newer quotes
      for (const r of remote) {
        const local = localById[r.id];
        if (!local || (r.modified_at || '') > (local.modified_at || '')) {
          const got = await this._apiFetch(r.id);
          if (got) fetched++;
        } else {
          // Update author/etc on local index from remote without re-fetching state body.
          const merged = Object.assign({}, local, {
            name: r.name || local.name,
            customer_name: r.customer_name || local.customer_name,
            author: r.author || local.author,
            created_at: r.created_at || local.created_at,
            modified_at: r.modified_at || local.modified_at,
            row_count: (r.row_count !== undefined) ? r.row_count : local.row_count,
          });
          const others = this._readIndex().filter(e => e.id !== r.id);
          this._writeIndex([merged, ...others]);
        }
      }

      // 2) Push local-only quotes up to cloud (one-time migration of pre-Phase-4 data)
      for (const local of localIdx) {
        if (!remoteById[local.id]) {
          const slotRaw = localStorage.getItem(this._slotKey(local.id));
          if (!slotRaw) continue;
          let state;
          try { state = JSON.parse(slotRaw); } catch (_) { continue; }
          // Use POST with explicit id so the slot gets the SAME id in cloud.
          const doc = await this._apiPush('POST', null, {
            id: local.id,
            name: local.name,
            state,
          });
          if (doc) pushed++;
        }
      }

      this._lastSyncedAt = new Date().toISOString();
      this._onSyncStateChange();
      return { fetched, pushed, total: remote.length };
    } catch (e) {
      console.warn('[QuoteStorage] syncFromCloud failed', e.message);
      return { fetched, pushed, total: 0, error: e.message };
    }
  },

  _genId() {
    const t = Date.now().toString(36);
    const r = Math.random().toString(36).slice(2, 8);
    return 'q_' + t + '_' + r;
  },
  _readIndex() {
    try {
      const raw = localStorage.getItem(this.IDX_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  },
  _writeIndex(arr) {
    localStorage.setItem(this.IDX_KEY, JSON.stringify(arr));
  },
  _slotKey(id) { return this.PFX + id; },

  /** Save state into a named slot.
   *  - If state.quoteId already maps to an existing slot AND `name` is undefined,
   *    overwrites in place (same id, refresh modified_at).
   *  - Otherwise creates a new slot and returns its id.
   *  - `name` is the human-friendly label (e.g. "Aanya — Gurgaon"). If omitted on
   *    a brand-new save, we synthesize from customer_name + date.
   */
  save(state, name) {
    const idx = this._readIndex();
    const now = new Date().toISOString();
    let id = (state && state.quoteId && state.quoteId.startsWith('q_')) ? state.quoteId : null;
    let entry = id ? idx.find(e => e.id === id) : null;

    // Overwrite path. 7G-A Bug #4: when `name` is provided AND non-empty AND
    // differs from the current entry.name, update the entry name (rename).
    // When name is undefined OR empty/whitespace, leave entry.name as-is.
    if (entry) {
      const cloned = JSON.parse(JSON.stringify(state));
      cloned.quoteId = id;
      cloned.modifiedAt = now;
      localStorage.setItem(this._slotKey(id), JSON.stringify(cloned));
      entry.modified_at  = now;
      entry.customer_name = (cloned.customer && cloned.customer.name) || entry.customer_name || '';
      entry.row_count    = (cloned.rows || []).length;
      const trimmed = (typeof name === 'string') ? name.trim() : '';
      if (trimmed && trimmed !== entry.name) {
        entry.name = trimmed;
      }
      // bubble up to front
      const others = idx.filter(e => e.id !== id);
      this._writeIndex([entry, ...others]);
      // Phase 4: push to cloud (background)
      this._apiPush('PUT', id, { state: cloned, name: entry.name });
      return id;
    }

    // Create new slot
    id = this._genId();
    const cloned = JSON.parse(JSON.stringify(state));
    cloned.quoteId   = id;
    cloned.createdAt = cloned.createdAt || now;
    cloned.modifiedAt = now;
    const customer_name = (cloned.customer && cloned.customer.name) || '';
    const date_str = now.slice(0, 10);
    const finalName = (name && name.trim())
      ? name.trim()
      : ((customer_name || 'Untitled') + ' — ' + date_str);
    localStorage.setItem(this._slotKey(id), JSON.stringify(cloned));
    const newEntry = {
      id, name: finalName,
      customer_name,
      created_at: cloned.createdAt,
      modified_at: now,
      row_count: (cloned.rows || []).length,
    };
    this._writeIndex([newEntry, ...idx.filter(e => e.id !== id)]);
    // Phase 4: push to cloud (background, with explicit id so cloud matches local)
    this._apiPush('POST', null, { id, name: finalName, state: cloned });
    return id;
  },

  /** Internal — silent overwrite-only used by saveState() auto-persist.
   *
   * 7G-A Bug #8: Previously this also refreshed entry.customer_name on every
   * keystroke. That caused the load-modal subtitle to drift away from the
   * title between explicit saves: a rep could load quote "Hardik — 2026-05-07"
   * (entry.name = "Hardik..."), edit state.customer.name to "Davinder Juneja",
   * and the next auto-save would silently rewrite entry.customer_name to
   * "Davinder Juneja" while leaving entry.name as "Hardik...". Reps then saw
   *   title:    "Hardik — 2026-05-07"
   *   subtitle: "Davinder Juneja - by avish - …"
   * in the Load modal. Confusing AND data-integrity scary.
   *
   * Fix: _touch persists the slot blob and bumps modified_at + row_count, but
   * does NOT touch entry.customer_name (or entry.name). Those stay frozen
   * until the user explicitly clicks Save (overwrite path in save() above
   * captures customer_name from the live state at click time, paired with
   * the user-confirmed name). Title and subtitle now always reflect the
   * SAME save snapshot.
   */
  _touch(id, state) {
    const idx = this._readIndex();
    const entry = idx.find(e => e.id === id);
    if (!entry) return; // active id stale; ignore
    const now = new Date().toISOString();
    const cloned = JSON.parse(JSON.stringify(state));
    cloned.quoteId    = id;
    cloned.modifiedAt = now;
    localStorage.setItem(this._slotKey(id), JSON.stringify(cloned));
    entry.modified_at  = now;
    // Bug #8: customer_name intentionally NOT updated here — only explicit Save
    // (or Save As New) refreshes it, paired with the user-confirmed name.
    entry.row_count    = (cloned.rows || []).length;
    this._writeIndex(idx);
    // Phase 4: debounced push to cloud (background) — auto-save fires this on every keystroke,
    // so we coalesce by waiting 1.5s of idle before pushing.
    if (this._touchTimer) clearTimeout(this._touchTimer);
    this._touchTimer = setTimeout(() => {
      this._apiPush('PUT', id, { state: cloned, name: entry.name });
    }, 1500);
  },

  load(id) {
    try {
      const raw = localStorage.getItem(this._slotKey(id));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  },

  /** List all saved quotes, newest-modified first. */
  list() {
    const idx = this._readIndex();
    return idx.slice().sort((a, b) => (b.modified_at || '').localeCompare(a.modified_at || ''));
  },

  delete(id) {
    localStorage.removeItem(this._slotKey(id));
    const idx = this._readIndex().filter(e => e.id !== id);
    this._writeIndex(idx);
    if (this.activeId() === id) this.setActiveId('');
    // Phase 4: push deletion to cloud
    this._apiPush('DELETE', id);
  },

  /** Clone an existing slot's state into a brand-new slot. Returns the new id. */
  duplicate(id) {
    const src = this.load(id);
    if (!src) throw new Error('quote not found: ' + id);
    const idx = this._readIndex();
    const srcEntry = idx.find(e => e.id === id);
    const newName = (srcEntry ? srcEntry.name : 'Quote') + ' (copy)';
    // Reset id so save() takes the create-new path
    const cloned = JSON.parse(JSON.stringify(src));
    cloned.quoteId = null;
    return this.save(cloned, newName);
  },

  exportJSON(id) {
    const s = this.load(id);
    if (!s) throw new Error('quote not found: ' + id);
    return JSON.stringify(s, null, 2);
  },

  /** Validate + import. Returns the new id; throws on invalid shape. */
  importJSON(jsonStr) {
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (_) {
      throw new Error('Invalid JSON');
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid quote: not an object');
    const required = ['customer', 'build', 'pricing', 'rows'];
    for (const k of required) {
      if (!(k in parsed)) throw new Error('Invalid quote: missing field "' + k + '"');
    }
    if (!Array.isArray(parsed.rows)) throw new Error('Invalid quote: "rows" must be an array');
    // Force a new slot id even if the JSON carries one
    parsed.quoteId = null;
    return this.save(parsed);
  },

  activeId() {
    return localStorage.getItem(this.ACTIVE_KEY) || '';
  },
  setActiveId(id) {
    if (id) localStorage.setItem(this.ACTIVE_KEY, id);
    else    localStorage.removeItem(this.ACTIVE_KEY);
  },

  /** Total bytes used by zuildup.* keys (rough — counts UTF-16 code units × 2). */
  size() {
    let total = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('zuildup.')) continue;
        const v = localStorage.getItem(k) || '';
        // 2 bytes per JS string code unit is the typical browser storage accounting.
        total += (k.length + v.length) * 2;
      }
    } catch (_) {}
    return total;
  },
};

// Test hook: expose to window so unit tests + CDP tests can poke at storage.
try { if (typeof window !== 'undefined') window.QuoteStorage = QuoteStorage; } catch (_) {}

// ============================================================================
// 7G-C: FAR API integration (coverage % auto-populate)
// ============================================================================
// Live service: https://far-service-176777907104.asia-south1.run.app
// Endpoint: POST /api/v1/far/calculate
// CORS: open ('access-control-allow-origin: *') — direct browser → API call.
// Auth: none (public endpoint).
// Returns ground coverage % among many other fields (groundCoverage).
// We auto-populate state.build.coverage from the FAR response when:
//   (a) the field is empty, OR
//   (b) the field still equals the previous auto-populated value.
// If the user types a different value, state.far.manualOverride flips to
// true and we stop overwriting until they clear the field.
// ----------------------------------------------------------------------------
const FAR_API_URL = 'https://far-service-176777907104.asia-south1.run.app/api/v1/far/calculate';

function ensureFarState(s) {
  if (!s.far) s.far = { lastAuto: null, manualOverride: false, lastCity: null, lastError: null };
  return s.far;
}

// 7G-C: parse the customer.address string for a known FAR city. Default
// 'gurugram' (most common case in our pipeline — Hardik example was Gurugram).
function detectFarCity(addressStr) {
  const s = (addressStr || '').toLowerCase();
  if (/gurugram|gurgaon/.test(s)) return 'gurugram';
  if (/faridabad/.test(s)) return 'faridabad';
  if (/ghaziabad/.test(s)) return 'ghaziabad';
  if (/noida|greater noida/.test(s)) return 'noida';
  if (/delhi|new delhi/.test(s)) return 'delhi';
  return 'gurugram';
}

// 7G-C: build the FAR API request body from current state. Returns null if
// inputs are insufficient (e.g. plotSqYards == 0).
function buildFarRequest(s) {
  const b = s.build || {};
  if (!b.plotSqYards || b.plotSqYards <= 0) return null;
  const SQYD_TO_SQM = 0.836127;
  const FT_TO_M = 0.3048;
  const plotAreaSqm = +(b.plotSqYards * SQYD_TO_SQM).toFixed(2);
  const widthM = b.breadth ? +(b.breadth * FT_TO_M).toFixed(2) : undefined;
  const depthM = (b.breadth && b.plotSqYards)
    ? +((b.plotSqYards * 9 / b.breadth) * FT_TO_M).toFixed(2)
    : undefined;
  const city = detectFarCity(s.customer && s.customer.address);
  const desiredFloors = Math.max(1, b.floors || 1) + (b.buildType === 'stilt' ? 1 : 0);
  return {
    city,
    plotArea: plotAreaSqm,
    plotUnit: 'sqm',
    plotWidth: widthM,
    plotDepth: depthM,
    desiredFloors,
    wantBasement: !!b.hasBasement,
    wantStilt: b.buildType === 'stilt',
    wantTerrace: true,
    wantBalcony: true,
    wantLift: !!b.hasLift,
  };
}

// 7G-C: in-flight guard + debounce so rapid input changes don't stack fetches.
let _farInFlight = null;
let _farDebounceTimer = null;

function maybeFarFetch() {
  if (_farDebounceTimer) clearTimeout(_farDebounceTimer);
  _farDebounceTimer = setTimeout(() => { _farDebounceTimer = null; _doFarFetch(); }, 600);
}

async function _doFarFetch() {
  const req = buildFarRequest(state);
  if (!req) return;
  const farS = ensureFarState(state);
  if (farS.manualOverride) return;
  if (_farInFlight) return;
  _farInFlight = (async () => {
    const hint = document.getElementById('far-hint');
    try {
      const r = await fetch(FAR_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const cov = (typeof data.groundCoverage === 'number') ? data.groundCoverage : null;
      if (cov == null) throw new Error('no groundCoverage in response');
      farS.lastCity = req.city;
      farS.lastError = null;
      const cur = state.build.coverage;
      if (!farS.manualOverride && (cur === 0 || cur === farS.lastAuto || cur == null || cur === '')) {
        state.build.coverage = cov;
        const fc = document.getElementById('f-coverage');
        if (fc) fc.value = cov;
      }
      farS.lastAuto = cov;
      saveState(state);
      if (hint) {
        const cityName = ({ gurugram: 'Gurugram', faridabad: 'Faridabad', ghaziabad: 'Ghaziabad', noida: 'Noida', delhi: 'Delhi' })[req.city] || req.city;
        hint.textContent = `Auto-populated ${cov}% from FAR API (${cityName} bylaws). Edit to override.`;
        hint.style.color = 'var(--muted)';
      }
      try { renderAreaOverridesPanel(); applyValidation(); renderFloorSummaryEditor(); } catch (_) {}
    } catch (err) {
      farS.lastError = String(err && err.message || err);
      saveState(state);
      if (hint) {
        hint.textContent = 'FAR API unavailable — enter coverage manually.';
        hint.style.color = 'var(--gold)';
      }
    } finally {
      _farInFlight = null;
    }
  })();
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
// Phase 6.4 #9: derive the effective category for a row (shared by form-page
// renderSpecList and preview/PDF renderQuote). Precedence:
//   row.categoryGroup (rep-set, supports rename + clones with custom heading)
//   > row.override.category_label (legacy, only set on _custom rows)
//   > item.category_label (catalog default)
//   > 'Custom'.
// Backwards-compatible: rows with no categoryGroup keep their catalog category.
function rowCategoryGroup(row) {
  if (row && row.categoryGroup && String(row.categoryGroup).trim()) {
    return String(row.categoryGroup).trim();
  }
  const o = (row && row.override) || {};
  if (row && row._custom) {
    return (o.category_label && o.category_label.trim()) || 'Custom';
  }
  const item = catalogItem(row && row.id);
  return item ? item.category_label : ((o.category_label && o.category_label.trim()) || 'Custom');
}

// Phase 6.4 #11c: sanitise a rich-text description so only b/strong/i/em/u/br
// survive. Anything else (script, iframe, on*, style, etc.) is stripped, but
// the text content of disallowed elements is preserved. Used at render time
// (PDF / preview) and on save so localStorage never holds active script.
// Implementation note: regex-based — works in both Node (test shim, no DOM)
// and browsers.
const RT_ALLOWED = /^(b|strong|i|em|u|br)$/i;
function sanitizeRichText(html) {
  if (html == null) return '';
  let s = String(html);
  // Drop control chars except tab/newline/cr.
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  // Strip <script> and <style> blocks WITH their content (defense in depth).
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  // Strip HTML comments.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Walk all tags. Allowed tags: keep, attribute-less. Disallowed: drop the
  // tag itself but keep any text content between.
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, function (m, tag) {
    if (!RT_ALLOWED.test(tag)) return '';
    const isClose = m.startsWith('</');
    if (/^br$/i.test(tag)) return '<br>';
    return isClose ? ('</' + tag.toLowerCase() + '>') : ('<' + tag.toLowerCase() + '>');
  });
  return s;
}
function defaultRowsFor(scope, opts) {
  // Catalog has scope: ["full"] or ["full","structure_only"].
  // Phase 6.4 #11a: Basement category is conditional on opts.hasBasement.
  // Without an explicit opt, we exclude it (most quotes don't have a basement;
  // the rep flips the toggle and the rows auto-populate via syncBasementRows).
  const hasBasement = !!(opts && opts.hasBasement);
  const cat = (CATALOG?.items || []).filter(it => {
    if (!it.scope.includes(scope === 'structure_only' ? 'structure_only' : 'full')) return false;
    if (it.category === 'basement' && !hasBasement) return false;
    return true;
  });
  return cat.map(it => ({ id: it.id, override: {} }));
}

// ============================================================================
// Calculator — verbatim port from canonical zuildup-cost-calculator.html
// ============================================================================
function computeQuote(state) {
  const bt = state.build.buildType;
  const c = bt === 'structure' ? calcStructure(state) : calcPackage(state);
  // Phase 7B Item 15: inject ad-hoc zone line items BEFORE area overrides
  // (so the override panel sees them) and BEFORE additionalZones (so they
  // bucket into A/B/C/D/E rather than the appended zones). Mutates `c`.
  appendZoneLineItems(c, state);
  // P3 #7: apply per-line area overrides. Mutates `c` in place.
  applyAreaOverrides(c, state);
  // Phase 6.3: append opt-in extra zones (Elevation, GST, Custom). Mutates `c`.
  appendAdditionalZones(c, state);
  return c;
}

// Phase 7E-C Item 7: enumerate the floor-summary row labels available for
// Zone A line-item attribution. Returned in the same order as buildFloorSummary
// rows (Basement → Stilt → Ground/First/... → Terrace).
function floorOptionsForA(state) {
  const b = (state && state.build) || {};
  const numFloors = Math.max(0, b.floors || 0);
  const opts = [];
  if (b.hasBasement) opts.push('Basement');
  const isStilt = b.buildType === 'stilt';
  if (isStilt) opts.push('Stilt');
  for (let i = 0; i < numFloors; i++) {
    opts.push(FLOOR_DISPLAY_NAMES[i] || ('Floor ' + (i + 1)));
  }
  opts.push('Terrace');
  return opts;
}

// Phase 7B Item 15: append rep-added line items to their respective zones.
// State shape: state.pricing.zoneLineItems = { 'A': [{id,name,desc,area,rate}], ... }.
// Each row contributes area + cost to the zone subtotal. Triggers `varies=true`
// because the row's rate may differ from the zone default; cost sheet then
// expands the zone into per-item rows so the rep-added line is itemised.
function appendZoneLineItems(c, state) {
  const map = state && state.pricing && state.pricing.zoneLineItems;
  if (!map || !c || !c.zones) return;
  for (const k of ['A','B','C','D','E']) {
    const rows = Array.isArray(map[k]) ? map[k] : [];
    if (!rows.length) continue;
    const zone = c.zones[k];
    if (!zone) continue; // zone disabled (e.g. C in structure mode, D when water-tank off)
    let added = 0;
    for (const r of rows) {
      const area = (r.area != null && r.area !== '' && !isNaN(parseFloat(r.area))) ? parseFloat(r.area) : 0;
      const rate = (r.rate != null && r.rate !== '' && !isNaN(parseFloat(r.rate))) ? parseFloat(r.rate) : 0;
      if (area <= 0 || rate <= 0) continue; // skip incomplete rows
      const name = (r.name && r.name.trim()) || 'Custom Item';
      const desc = (r.desc || '').toString();
      const cost = Math.round(area * rate);
      const item = { name, desc, area, rate, cost, _zoneLineItem: true, _lineItemId: r.id || null };
      item.origName = name;
      // Phase 7E-C Item 7: thread the optional floor association through.
      if (r.floor && typeof r.floor === 'string' && r.floor.trim()) {
        item._floor = r.floor;
      }
      zone.items.push(item);
      added += cost;
      if (rate !== zone.rate) zone.varies = true;
    }
    if (added > 0) {
      // Recompute zone.total from items so the area-page total reflects the addition.
      zone.total = zone.items.reduce((s, it) => s + (it.area || 0), 0);
      zone.cost  = (zone.cost  || 0) + added;
      // Update zoneSubtotal + grandTotal at top level.
      c.zoneSubtotal = (c.zoneSubtotal || 0) + added;
      c.grandTotal   = (c.grandTotal   || 0) + added;
      if (zone.varies) zone.rateLabel = 'varies';
    }
  }
}

// Phase 7B Item 17: per-line-item name + description override resolvers.
// State key: '<zone>:<originalName>' -> string. Renderers fall back to the
// calc-engine-generated default when no override is set.
function _itemNameOverride(state, zoneKey, origName) {
  const ov = state && state.pricing && state.pricing.itemNameOverrides;
  if (!ov) return null;
  const v = ov[zoneKey + ':' + origName];
  return (typeof v === 'string' && v.trim() !== '') ? v : null;
}
function _itemDescOverride(state, zoneKey, origName) {
  const ov = state && state.pricing && state.pricing.itemDescOverrides;
  if (!ov) return null;
  const v = ov[zoneKey + ':' + origName];
  return (typeof v === 'string' && v.trim() !== '') ? v : null;
}
function resolveItemName(state, zoneKey, it) {
  if (!it) return '';
  // it.origName is set by the calc engine for items that may be renamed.
  const orig = it.origName || it.name;
  return _itemNameOverride(state, zoneKey, orig) || it.name;
}
function resolveItemDesc(state, zoneKey, it) {
  if (!it) return '';
  const orig = it.origName || it.name;
  return _itemDescOverride(state, zoneKey, orig) || it.desc || '';
}

// Phase 6.3 — Append sequential opt-in zones (Elevation, GST, Custom) to the
// computed quote. Each is rendered as a single-line zone, letter assigned
// dynamically (next available after the static A/B/C/D/E zones in use).
//
// Output: mutates `c.additionalZones` (Array<{id, letter, name, desc, cost,
// items: [{name, desc, area:1, rate:cost, cost}]}>), then updates
// `c.zoneSubtotal` and `c.grandTotal`.
//
// Invariants:
//  - All toggles off → c.additionalZones is empty array, totals unchanged.
//  - Each zone.cost is read directly from state (flat ₹), no per-sqft math.
//  - Internal id ('elevation' / 'gst' / 'custom') is stable across builds —
//    only the display letter shifts when the basement toggle changes.
//  - zone.cost == sum of items.cost (single line item) — Phase 5 zone-sum
//    invariant holds for these too.
function appendAdditionalZones(c, state) {
  c.additionalZones = [];
  const az = (state.pricing && state.pricing.additionalZones) || {};
  // Determine highest letter currently used by static zones.
  // c.zones is always present with at least A and B; C is null in structure
  // mode; D is always present; E only when basement enabled.
  let maxCode = 'A'.charCodeAt(0);
  if (c.zones) {
    for (const k of ['A','B','C','D','E']) {
      if (c.zones[k]) {
        const code = k.charCodeAt(0);
        if (code > maxCode) maxCode = code;
      }
    }
  }
  // Phase 7B Item 16: emit Elevation → GST → each Custom charge in order.
  // Custom is now an array (rep can stack multiple). We tolerate the legacy
  // single-object shape too — getCustomList wraps it in a 1-element array.
  const getCustomList = (raw) => {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object' && (raw.enabled || raw.name || raw.cost || raw.desc)) {
      return [raw];
    }
    return [];
  };
  const emit = (id, defaultName, cfg) => {
    if (!cfg || !cfg.enabled) return 0;
    const cost = (cfg.cost != null && cfg.cost !== '' && !isNaN(parseFloat(cfg.cost)))
      ? Math.round(parseFloat(cfg.cost)) : 0;
    const desc = (cfg.desc || '').toString();
    let displayName = defaultName;
    if (id === 'custom' || id.startsWith('custom-')) {
      const customName = (cfg.name || '').toString().trim();
      if (customName) displayName = customName;
    }
    maxCode += 1;
    const letter = String.fromCharCode(maxCode);
    const item = { name: displayName, desc, area: 1, rate: cost, cost };
    c.additionalZones.push({
      id,
      letter,
      name: displayName,
      desc,
      cost,
      items: [item],
      total: 1,
      rate: cost,
      rateLabel: '',
      isAdditional: true,
    });
    return cost;
  };
  let extraTotal = 0;
  extraTotal += emit('elevation', 'Elevation', az.elevation);
  extraTotal += emit('gst',       'GST',       az.gst);
  // Multiple custom charges, sequenced after Elevation+GST.
  const customList = getCustomList(az.custom);
  customList.forEach((cfg, i) => {
    extraTotal += emit('custom-' + i, 'Custom Charge', cfg);
  });
  if (extraTotal > 0) {
    c.zoneSubtotal = (c.zoneSubtotal || 0) + extraTotal;
    c.grandTotal   = (c.grandTotal   || 0) + extraTotal;
  }
}

// P3 #7 / Phase 5: replace any zone-item area with state.areaOverrides[<zone>:<name>] when present;
// recompute item costs (respecting per-item rate overrides), zone totals, zone costs,
// sub-totals, grand total. Also marks overridden items so the renderer can swap the
// description to a generic "as per design scope" string.
//
// Phase 5 fix history:
//   - `dirty` flag was previously declared OUTSIDE the zone loop, leaking across zones
//     and triggering `z.cost = z.total * z.rate` for every subsequent zone — wiping
//     per-item rate overrides. Now scoped per-zone.
//   - `it.cost` was not recomputed after area override, causing stale per-item costs
//     in the cost-page render. Now recomputed as `it.area * it.rate`.
//   - `z.cost` was previously `z.total * z.rate`, which discarded per-item rate
//     variations. Now `Σ(it.cost)` for correctness under any rate override permutation.
function applyAreaOverrides(c, state) {
  const ovrs = state.areaOverrides || {};
  if (!c.zones) return;
  // Phase 7B Item 17: snapshot original names BEFORE any rename so the
  // override-resolver can map renamed items back to their state keys.
  for (const k of ['A','B','C','D','E']) {
    const z = c.zones[k];
    if (z && Array.isArray(z.items)) {
      for (const it of z.items) {
        if (typeof it.origName !== 'string') it.origName = it.name;
      }
    }
  }
  let anyDirty = false;
  for (const k of ['A','B','C','D','E']) {
    const z = c.zones[k];
    if (!z || !z.items) continue;
    let zoneDirty = false;
    for (const it of z.items) {
      const key = k + ':' + it.name;
      const v = ovrs[key];
      if (v != null && v !== '' && !isNaN(parseInt(v))) {
        const newArea = parseInt(v);
        // Mark as overridden whenever the user has supplied an explicit value,
        // even if it numerically matches the computed area — the user
        // *intended* to take ownership of this row.
        it.areaOverridden = true;
        // Issue 4: replace formula description with generic scope phrase.
        it.desc = 'as per design scope';
        if (newArea !== it.area) {
          it.area = newArea;
          // Recompute item cost from new area × the item's own (possibly overridden) rate.
          it.cost = it.area * (it.rate || 0);
          zoneDirty = true;
        }
      }
    }
    if (zoneDirty) {
      z.total = z.items.reduce((s, x) => s + (x.area || 0), 0);
      // Sum item costs (respects per-item rate overrides). Do NOT use z.total * z.rate.
      z.cost  = z.items.reduce((s, x) => s + (x.cost  || 0), 0);
      anyDirty = true;
    }
  }
  if (anyDirty) {
    let zoneSubtotal = 0;
    for (const k of ['A','B','C','D','E']) {
      if (c.zones[k]) zoneSubtotal += c.zones[k].cost || 0;
    }
    c.zoneSubtotal = zoneSubtotal;
    c.grandTotal = zoneSubtotal + (c.lift ? c.lift.cost : 0);
  }
}

function calcPackage(state) {
  const b = state.build, p = state.pricing;
  const hasStilt = b.buildType === 'stilt';
  const baseFormula = parseInt(p.costPerSqft) || 0;
  // P3 #4: per-zone overrides — null/'' => formula default, otherwise direct ₹/sqft.
  const ovr = (v, fallback) => (v != null && v !== '' && !isNaN(parseInt(v))) ? parseInt(v) : fallback;
  const baseRate = ovr(p.zoneARate,    baseFormula);
  const bRate    = ovr(p.zoneBRate,    Math.round(baseFormula * 0.50));
  const cRate    = ovr(p.zoneCRate,    C_RATE);
  const dRate    = ovr(p.zoneDRate,    WATER_TANK_RATE);
  const eRate    = ovr(p.basementRate, BASEMENT_RATE);

  const plotSqFt   = b.plotSqYards * 9;
  const depth      = b.breadth ? Math.round(plotSqFt / b.breadth) : 0;
  const floorArea  = plotSqFt * b.coverage / 100; // 7G-B: keep precision; display via niA()
  const numFloors  = b.floors;

  // Phase 7B Item 14: lift / staircase per-floor sqft are now per-quote
  // editable. Defaults liftPerFloor=25 / staircasePerFloor=125. Resolved
  // here so all downstream calcs (floorAdj, terrace, basement, floor summary)
  // pick up the rep-supplied values.
  const liftPerFloor      = ovr(p.liftSqftPerLevel,      LIFT_PER_FLOOR);
  const staircasePerFloor = ovr(p.staircaseSqftPerLevel, STAIRCASE_PER_FLOOR);

  // Phase 5 (Issue 3): unified staircase/lift count formula across all 3 calculator modes.
  // Stops = each floor + stilt (if present) + basement (if present) + mumty (always — rooftop access).
  // Examples: Stilt+4 → 4+1+0+1 = 6; Basement+Stilt+4 → 4+1+1+1 = 7; Ground+3 (no stilt) → 4+0+0+1 = 5.
  const staircaseLevels = numFloors + (hasStilt ? 1 : 0) + (b.hasBasement ? 1 : 0) + 1;
  const waterTankFloors = numFloors;

  // Zone A — main floors + lift
  const fn = FLOOR_DISPLAY_NAMES;
  const floorAdj = floorArea - (b.hasLift ? liftPerFloor : 0) - staircasePerFloor;
  const zoneAItems = [];
  for (let i = 0; i < numFloors; i++) {
    zoneAItems.push({
      name: fn[i] || `Floor ${i+1}`,
      desc: `Floor Area (${niA(floorArea)})${b.hasLift ? ' − Lift ('+liftPerFloor+')':''} − Staircase (${staircasePerFloor})`,
      area: floorAdj,
    });
  }
  const liftAreaTotal = b.hasLift ? liftPerFloor * staircaseLevels : 0;
  if (b.hasLift) zoneAItems.push({ name: 'Lift', desc: `${staircaseLevels} levels × ${liftPerFloor} sq.ft`, area: liftAreaTotal });
  const totalA = zoneAItems.reduce((s,f) => s + f.area, 0);

  // Zone B — stilt + balcony + staircase
  const stiltArea       = hasStilt ? floorAdj : 0;
  const balconyPerFloor = b.breadth * BALCONY_DEPTH;
  // 7G-B: nostilt ground-floor logic — ground floor has NO balcony (it sits
  // directly on plot, no setback/ramp accounted via Zone C item, no balcony
  // jut over the stilt). For nostilt, balcony only applies to floors 2..N.
  const isNostilt = b.buildType === 'nostilt';
  const balconyFloorCount = isNostilt ? Math.max(0, numFloors - 1) : numFloors;
  const balconyTotal    = balconyPerFloor * balconyFloorCount;
  const staircaseTotal  = staircasePerFloor * staircaseLevels;
  const zoneBItems = [];
  if (hasStilt) zoneBItems.push({ name: 'Stilt', desc: `Floor Area (${niA(floorArea)})${b.hasLift?' − Lift ('+liftPerFloor+')':''} − Staircase (${staircasePerFloor})`, area: stiltArea });
  // Phase 6.2 — per-floor balcony pricing. When toggle OFF (default), one
  // combined Balcony row at the Zone B default rate (unchanged from pre-6.2).
  // When ON, expand to N rows (one per floor) each at the rep-supplied rate;
  // null/blank cells fall back to Zone B default so the calc never breaks.
  // PDF collapse-when-equal rule lives in renderCostPage, NOT here.
  // 7G-B: for nostilt, skip ground floor (i=0) — no balcony on ground.
  const balconyFloorNames = ['Floor 1','Floor 2','Floor 3','Floor 4','Floor 5','Floor 6'];
  const bpf = (state.pricing && state.pricing.balconyPerFloor) || { enabled: false, rates: [] };
  if (bpf.enabled) {
    for (let i = 0; i < numFloors; i++) {
      // 7G-B: nostilt ground-floor (i=0) has no balcony.
      if (isNostilt && i === 0) continue;
      const fname = balconyFloorNames[i] || ('Floor ' + (i+1));
      zoneBItems.push({
        name: `Balcony — ${fname}`,
        desc: `${b.breadth}ft × ${BALCONY_DEPTH}ft (${fname})`,
        area: balconyPerFloor,
        balconyFloor: i,           // 0-indexed; tag for renderer collapse logic
      });
    }
  } else {
    // 7G-B: nostilt → balcony spans (numFloors-1) floors (skip ground).
    const balconyFloorsLabel = isNostilt
      ? `${balconyFloorCount} floors (excl. ground)`
      : `${numFloors} floors`;
    zoneBItems.push({ name: 'Balcony', desc: `${b.breadth}ft × ${BALCONY_DEPTH}ft × ${balconyFloorsLabel}`, area: balconyTotal });
  }
  zoneBItems.push({ name: 'Staircase', desc: `${staircaseLevels} levels × ${staircasePerFloor} sq.ft`, area: staircaseTotal });
  const totalB = zoneBItems.reduce((s,f) => s + f.area, 0);

  // Zone C — terrace + ramp + setback
  const terrace = floorArea + balconyPerFloor - staircasePerFloor - (b.hasLift ? liftPerFloor : 0);
  const ramp    = b.breadth * RAMP_DEPTH;
  const setback = plotSqFt - floorArea;
  const zoneCItems = [
    { name: 'Terrace', desc: `Floor (${niA(floorArea)}) + 1 balcony (${niA(balconyPerFloor)}) − Staircase (${staircasePerFloor})${b.hasLift?' − Lift ('+liftPerFloor+')':''}`, area: terrace },
    { name: 'Ramp',    desc: `${b.breadth}ft × ${RAMP_DEPTH}ft`, area: ramp },
    { name: 'Setback', desc: `Plot Area (${niA(plotSqFt)}) − Floor Area (${niA(floorArea)})`, area: setback },
  ];
  const totalC = zoneCItems.reduce((s,f) => s + f.area, 0);

  // Zone D — water tank
  const totalD = waterTankFloors * WATER_TANK_PER_FLOOR;
  const zoneDItems = [{ name: 'Underground Water Tank', desc: `${waterTankFloors} floors × ${ni(WATER_TANK_PER_FLOOR)} L`, area: totalD, unit: 'L' }];

  // Zone E — basement
  // Phase 7B Item 13: basement area mirrors the ground floor footprint
  // (plot × coverage% − lift − staircase). Previously this was just floorArea
  // (the gross built-up before lift/staircase deductions), which made the
  // basement area inconsistent with what's actually buildable below grade.
  const totalE = b.hasBasement ? floorAdj : 0;
  const zoneEItems = b.hasBasement ? [{ name: 'Basement', desc: `Floor Area (${niA(floorArea)})${b.hasLift?' − Lift ('+liftPerFloor+')':''} − Staircase (${staircasePerFloor})`, area: totalE }] : [];

  // P3 v2 (A): per-line-item rates. Each item gets item.rate (override or zone default)
  // and item.cost (area * rate). Zone cost = sum(items.cost). Zone label shows "varies"
  // if any item rate differs from the zone default.
  // Phase 6.2: when an item has `balconyFloor` set (Zone B per-floor balcony
  // expansion), its rate comes from `state.pricing.balconyPerFloor.rates[i]`
  // — a fresh rep-entered rate, NOT an itemRates override. Null/blank cells
  // fall back to the Zone B default (`bRate` for calcPackage). This keeps the
  // grand total well-defined when the rep leaves a floor blank, and keeps the
  // Phase 5 zone-sum invariant (`zone.cost == Σ items.cost`).
  const itemRates = (state.pricing.itemRates) || {};
  const bpfRates = (bpf && Array.isArray(bpf.rates)) ? bpf.rates : [];
  // Phase 7B Item 4: when the rep explicitly sets a global zone rate via the
  // pricing inputs (e.g. basementRate=3000), the per-item rate override map
  // should NOT shadow that global. Without this, a stale itemRates['E:Basement']
  // left over from a previous edit makes the cost sheet show "varies" /
  // a different rate than the rep just entered. Per-item overrides remain
  // active for multi-item zones; single-item zones get the explicit global
  // rate when the rep set one.
  const explicitGlobalRate = (key) => {
    if (key === 'E') return p.basementRate != null && p.basementRate !== '';
    return false;
  };
  const enrichZone = (key, items, defaultRate) => {
    let varies = false;
    const skipItemRate = explicitGlobalRate(key) && items.length === 1;
    for (const it of items) {
      let r = defaultRate;
      if (it.balconyFloor != null) {
        const cellRaw = bpfRates[it.balconyFloor];
        const cell = (cellRaw != null && cellRaw !== '' && !isNaN(parseInt(cellRaw))) ? parseInt(cellRaw) : null;
        r = (cell != null) ? cell : defaultRate;
      } else if (!skipItemRate) {
        const ovr = itemRates[key + ':' + it.name];
        r = (ovr != null && ovr !== '' && !isNaN(parseInt(ovr))) ? parseInt(ovr) : defaultRate;
      }
      if (r !== defaultRate) varies = true;
      it.rate = r;
      it.cost = it.area * r;
    }
    return { cost: items.reduce((s, it) => s + it.cost, 0), varies };
  };
  const _zA = enrichZone('A', zoneAItems, baseRate);
  const _zB = enrichZone('B', zoneBItems, bRate);
  const _zC = enrichZone('C', zoneCItems, cRate);
  const _zD = enrichZone('D', zoneDItems, dRate);
  const _zE = enrichZone('E', zoneEItems, eRate);
  const costA = _zA.cost, costB = _zB.cost, costC = _zC.cost, costD = _zD.cost, costE = _zE.cost;
  // P3 v2.1: lift cost is editable via state.pricing.liftCost (null/'' = default LIFT_COST).
  const liftOvr = state.pricing.liftCost;
  const liftCost = b.hasLift ? ((liftOvr != null && liftOvr !== '' && !isNaN(parseInt(liftOvr))) ? parseInt(liftOvr) : LIFT_COST) : 0;
  // Phase 7B Item 3: drop costD when the water-tank toggle is off.
  const _costD = (b.hasWaterTank !== false) ? costD : 0;
  const zoneSubtotal = costA + costB + costC + _costD + costE;
  // Canonical: zone subtotal + lift cost (GST/liaison handled outside the calculator).
  const grand = zoneSubtotal + liftCost;

  return {
    mode: hasStilt ? 'stilt' : 'nostilt',
    plotSqYards: b.plotSqYards, plotSqFt, depth, breadth: b.breadth, coverage: b.coverage,
    buildLabel: hasStilt ? `Stilt + ${numFloors} Floors` : `Ground + ${numFloors-1}`,
    floorArea,
    zones: {
      A: { items: zoneAItems, total: totalA, rate: baseRate, cost: costA, varies: _zA.varies, rateLabel: _zA.varies ? 'varies' : `₹${ni(baseRate)}/sqft` },
      B: { items: zoneBItems, total: totalB, rate: bRate,    cost: costB, varies: _zB.varies, rateLabel: _zB.varies ? 'varies' : `₹${ni(bRate)}/sqft` },
      C: { items: zoneCItems, total: totalC, rate: cRate,    cost: costC, varies: _zC.varies, rateLabel: _zC.varies ? 'varies' : `₹${ni(cRate)}/sqft` },
      // Phase 7B Item 3: Zone D omitted entirely when the rep turns off the water-tank toggle.
      D: (b.hasWaterTank !== false) ? { items: zoneDItems, total: totalD, rate: dRate,    cost: costD, varies: _zD.varies, rateLabel: _zD.varies ? 'varies' : `₹${ni(dRate)}/L`, unit: 'L' } : null,
      E: b.hasBasement ? { items: zoneEItems, total: totalE, rate: eRate, cost: costE, varies: _zE.varies, rateLabel: _zE.varies ? 'varies' : `₹${ni(eRate)}/sqft` } : null,
    },
    lift:    b.hasLift ? { cost: liftCost } : null,
    zoneSubtotal,
    grandTotal: grand,
  };
}

function calcStructure(state) {
  const b = state.build, p = state.pricing;
  const strRate = parseInt(p.structureRate) || 0;
  // P3 #3/4: overrides apply in structure mode too (Zone D, basement).
  const ovr = (v, fallback) => (v != null && v !== '' && !isNaN(parseInt(v))) ? parseInt(v) : fallback;
  const dRate = ovr(p.zoneDRate,    WATER_TANK_RATE);
  const eRate = ovr(p.basementRate, BASEMENT_RATE);
  const numFloors = b.floors;

  // Phase 7B Item 14: lift / staircase per-floor sqft (state-resolved).
  const _p7b = state.pricing;
  const _ovr7b = (v, fb) => (v != null && v !== '' && !isNaN(parseInt(v))) ? parseInt(v) : fb;
  const liftPerFloor      = _ovr7b(_p7b.liftSqftPerLevel,      LIFT_PER_FLOOR);
  const staircasePerFloor = _ovr7b(_p7b.staircaseSqftPerLevel, STAIRCASE_PER_FLOOR);

  const plotSqFt = b.plotSqYards * 9;
  const depth = b.breadth ? Math.round(plotSqFt / b.breadth) : 0;
  const floorArea = plotSqFt * b.coverage / 100; // 7G-B: keep precision; display via niA()

  // Phase 5 (Issue 3): unified formula. Structure mode always has stilt; mumty (+1) always present.
  // Same formula as calcPackage with hasStilt=true: numFloors + 1 (stilt) + basement? + 1 (mumty).
  const hasStilt = true;
  const staircaseLevels = numFloors + (hasStilt ? 1 : 0) + (b.hasBasement ? 1 : 0) + 1;
  const waterTankFloors = numFloors;

  // Zone A — main floors + stilt + lift (everything at structure rate)
  const fn = FLOOR_DISPLAY_NAMES;
  const floorAdj = floorArea - (b.hasLift ? liftPerFloor : 0) - staircasePerFloor;
  const zoneAItems = [];
  for (let i = 0; i < numFloors; i++) {
    zoneAItems.push({
      name: fn[i] || `Floor ${i+1}`,
      desc: `Floor Area (${niA(floorArea)})${b.hasLift?' − Lift ('+liftPerFloor+')':''} − Staircase (${staircasePerFloor})`,
      area: floorAdj,
    });
  }
  zoneAItems.push({ name: 'Stilt', desc: 'Enclosed Area', area: floorArea });
  const liftAreaTotal = b.hasLift ? liftPerFloor * staircaseLevels : 0;
  if (b.hasLift) zoneAItems.push({ name: 'Lift', desc: `${staircaseLevels} levels × ${liftPerFloor} sq.ft`, area: liftAreaTotal });
  const totalA = zoneAItems.reduce((s,i) => s + i.area, 0);

  // Zone B — terrace + staircase (₹500 flat)
  const terrace = floorArea;
  const staircaseTotal = staircasePerFloor * staircaseLevels;
  const zoneBItems = [
    { name: 'Terrace',   desc: 'Pantry, Washroom, Parapet Walls', area: terrace },
    { name: 'Staircase', desc: `${staircaseLevels} levels × ${staircasePerFloor} sq.ft`, area: staircaseTotal },
  ];
  const totalB = zoneBItems.reduce((s,i) => s + i.area, 0);

  // Zone D — water tank
  const totalD = waterTankFloors * WATER_TANK_PER_FLOOR;
  const zoneDItems = [{ name: 'Underground Water Tank', desc: `${waterTankFloors} floors × ${ni(WATER_TANK_PER_FLOOR)} L`, area: totalD, unit: 'L' }];

  // Zone E — basement
  // Phase 7B Item 13: basement area mirrors the ground floor footprint
  // (plot × coverage% − lift − staircase). Previously this was just floorArea
  // (the gross built-up before lift/staircase deductions), which made the
  // basement area inconsistent with what's actually buildable below grade.
  const totalE = b.hasBasement ? floorAdj : 0;
  const zoneEItems = b.hasBasement ? [{ name: 'Basement', desc: `Floor Area (${niA(floorArea)})${b.hasLift?' − Lift ('+liftPerFloor+')':''} − Staircase (${staircasePerFloor})`, area: totalE }] : [];

  // P3 v2 (A): per-line-item rates in structure mode.
  const itemRates = (state.pricing.itemRates) || {};
  // Phase 7B Item 4: same explicit-global-rate guard as calcPackage. See there
  // for rationale (basementRate=3000 should win over a stale itemRates['E:Basement']).
  const p2 = state.pricing;
  const explicitGlobalRate = (key) => {
    if (key === 'E') return p2.basementRate != null && p2.basementRate !== '';
    return false;
  };
  const enrichZone = (key, items, defaultRate) => {
    let varies = false;
    const skipItemRate = explicitGlobalRate(key) && items.length === 1;
    for (const it of items) {
      let r = defaultRate;
      if (!skipItemRate) {
        const ovr = itemRates[key + ':' + it.name];
        r = (ovr != null && ovr !== '' && !isNaN(parseInt(ovr))) ? parseInt(ovr) : defaultRate;
      }
      if (r !== defaultRate) varies = true;
      it.rate = r;
      it.cost = it.area * r;
    }
    return { cost: items.reduce((s, it) => s + it.cost, 0), varies };
  };
  const _zA = enrichZone('A', zoneAItems, strRate);
  const _zB = enrichZone('B', zoneBItems, STRUCT_B_RATE);
  const _zD = enrichZone('D', zoneDItems, dRate);
  const _zE = enrichZone('E', zoneEItems, eRate);
  const costA = _zA.cost, costB = _zB.cost, costD = _zD.cost, costE = _zE.cost;
  // P3 v2.1: lift cost editable.
  const liftOvr = state.pricing.liftCost;
  const liftCost = b.hasLift ? ((liftOvr != null && liftOvr !== '' && !isNaN(parseInt(liftOvr))) ? parseInt(liftOvr) : LIFT_COST) : 0;
  // Phase 7B Item 3: drop costD when the water-tank toggle is off.
  const _costD = (b.hasWaterTank !== false) ? costD : 0;
  const zoneSubtotal = costA + costB + _costD + costE;
  // Canonical: zone subtotal + lift cost (GST/liaison handled outside the calculator).
  const grand = zoneSubtotal + liftCost;

  return {
    mode: 'structure',
    plotSqYards: b.plotSqYards, plotSqFt, depth, breadth: b.breadth, coverage: b.coverage,
    buildLabel: `Structure Only · Stilt + ${numFloors}`,
    floorArea,
    zones: {
      A: { items: zoneAItems, total: totalA, rate: strRate,       cost: costA, varies: _zA.varies, rateLabel: _zA.varies ? 'varies' : `₹${ni(strRate)}/sqft` },
      B: { items: zoneBItems, total: totalB, rate: STRUCT_B_RATE, cost: costB, varies: _zB.varies, rateLabel: _zB.varies ? 'varies' : `₹${ni(STRUCT_B_RATE)}/sqft` },
      C: null,
      // Phase 7B Item 3: Zone D omitted entirely when the rep turns off the water-tank toggle.
      D: (b.hasWaterTank !== false) ? { items: zoneDItems, total: totalD, rate: dRate, cost: costD, varies: _zD.varies, rateLabel: _zD.varies ? 'varies' : `₹${ni(dRate)}/L`, unit: 'L' } : null,
      E: b.hasBasement ? { items: zoneEItems, total: totalE, rate: eRate, cost: costE, varies: _zE.varies, rateLabel: _zE.varies ? 'varies' : `₹${ni(eRate)}/sqft` } : null,
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
// 7G-B: Area formatter — display areas with 2 decimal places (no rounding
// to whole numbers). Unlike ni() which is Math.round → toLocaleString, niA
// preserves up to 2 decimal places of precision so non-integer areas (e.g.
// 33.5ft × 72ft = 2412.0 sqft, or 1556.50 sqft) render faithfully. Used
// everywhere AREA values display (sqft, sqyd). Money still uses fmtINR /
// integer values (ni). Liter volumes (Zone D) still use ni (integer).
function niA(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
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
// Phase 6.1 #10: quote validity (60 days from createdAt). en-IN-flavoured
// "DD MMM YYYY" matching formatDate(). Returns '' on bad input.
function quoteValidUntil(createdIso, days = 60) {
  if (!createdIso) return '';
  const [y,m,d] = createdIso.split('-').map(n => parseInt(n,10));
  if (!y || !m || !d) return '';
  const dt = new Date(Date.UTC(y, m-1, d));
  if (isNaN(dt.getTime())) return '';
  dt.setUTCDate(dt.getUTCDate() + days);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dd} ${months[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
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
  // Phase 4: pull team's cloud-stored quotes into local cache before reading state.
  // Best-effort — if it fails (offline / API down), we fall through to localStorage only.
  try {
    const sum = await Promise.race([
      QuoteStorage.syncFromCloud(),
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 4000)),
    ]);
    if (sum && !sum.timeout) {
      console.log('[QuoteStorage] sync on boot:', sum);
    }
  } catch (e) { console.warn('[QuoteStorage] boot sync failed', e); }
  let state = loadState();

  // P3 #2: ensure a server-assigned quote id (ZUI-YYYY-NNNN)
  if (!state.quoteId || !state.quoteId.startsWith('ZUI-')) {
    await ensureQuoteId(state);
    saveState(state);
  }

  // First-load seed for rows when scope is set but rows empty
  if (!state.rows.length) {
    state.rows = defaultRowsFor(state.scope, { hasBasement: !!state.build.hasBasement });
    saveState(state);
  }
  // Phase 6.4 #11a: if a saved quote has basement on but pre-dates the basement
  // category, top up missing basement rows so the rep doesn't have to re-add.
  if (state.build.hasBasement) {
    const haveBasement = state.rows.some(r => {
      const it = catalogItem(r.id); return it && it.category === 'basement';
    });
    if (!haveBasement) {
      const basementItems = (CATALOG?.items || []).filter(it => it.category === 'basement'
        && it.scope.includes(state.scope === 'structure_only' ? 'structure_only' : 'full'));
      basementItems.forEach(it => state.rows.push({ id: it.id, override: {} }));
      saveState(state);
    }
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
  // Phase 7B Item 3: water-tank toggle. Default true (legacy + new quotes).
  if ($('f-water-tank')) $('f-water-tank').checked = (state.build.hasWaterTank !== false);
  // Phase 7B Item 14: editable lift / staircase per-level sqft.
  if ($('f-lift-sqft'))      $('f-lift-sqft').value      = state.pricing.liftSqftPerLevel      ?? '';
  if ($('f-staircase-sqft')) $('f-staircase-sqft').value = state.pricing.staircaseSqftPerLevel ?? '';
  $('f-cost-sqft').value   = state.pricing.costPerSqft ?? '';
  $('f-struct-rate').value = state.pricing.structureRate ?? '';
  // P3 #4: zone rate overrides (empty input = formula default)
  if ($('f-zone-a-rate'))   $('f-zone-a-rate').value   = state.pricing.zoneARate    ?? '';
  if ($('f-zone-b-rate'))   $('f-zone-b-rate').value   = state.pricing.zoneBRate    ?? '';
  if ($('f-zone-c-rate'))   $('f-zone-c-rate').value   = state.pricing.zoneCRate    ?? '';
  if ($('f-zone-d-rate'))   $('f-zone-d-rate').value   = state.pricing.zoneDRate    ?? '';
  if ($('f-basement-rate')) $('f-basement-rate').value = state.pricing.basementRate ?? '';
  if ($('f-lift-cost'))     $('f-lift-cost').value     = state.pricing.liftCost     ?? '';
  if ($('f-lift-cost'))     $('f-lift-cost').value     = state.pricing.liftCost     ?? '';
  // P3 #6: layout toggle
  if ($('f-specs-layout'))  $('f-specs-layout').value  = state.specsLayout || 'table';
  $('f-notes').value      = state.notes ?? '';
  for (const btn of $('f-scope').querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.v === state.scope);
  }
  reflectModeUi(state.build.buildType);
  // P3 v2.1: initial lift-cost-row visibility based on saved state.
  { const row = document.getElementById('lift-cost-row'); if (row) row.style.display = state.build.hasLift ? '' : 'none'; }
  // P3 v2.1: initial lift-cost-row visibility based on saved state.
  { const row = document.getElementById('lift-cost-row'); if (row) row.style.display = state.build.hasLift ? '' : 'none'; }
  // P1.7: applyValidation defined just below — call after first paint so initial state is reflected.
  setTimeout(() => { try { applyValidation(); } catch(_) {} }, 0);
  // 7G-C: initial FAR fetch on boot.
  setTimeout(() => { try { maybeFarFetch(state); } catch(_) {} }, 0);

  // ---- P1.7: field validation + business rules ----
  function applyValidation() {
    const rules = [];
    // Coverage: 0 < x ≤ 100
    const cov = state.build.coverage;
    rules.push({ id: 'f-coverage', valid: cov > 0 && cov <= 100,
      hint: cov <= 0 ? 'must be > 0%' : (cov > 100 ? 'max 100%' : '') });
    // costPerSqft (full-build modes only)
    const isStruct = state.build.buildType === 'structure' || state.scope === 'structure_only';
    if (!isStruct) {
      const v = state.pricing.costPerSqft;
      rules.push({ id: 'f-cost-sqft', valid: typeof v === 'number' && v > 0,
        hint: 'Required (₹ per sq ft)' });
    } else {
      rules.push({ id: 'f-cost-sqft', valid: true, hint: '' });
    }
    // structureRate (structure-only mode)
    if (isStruct) {
      const v = state.pricing.structureRate;
      rules.push({ id: 'f-struct-rate', valid: typeof v === 'number' && v > 0,
        hint: 'Required (₹ per sq ft)' });
    } else {
      rules.push({ id: 'f-struct-rate', valid: true, hint: '' });
    }
    for (const r of rules) {
      const el = document.getElementById(r.id);
      if (!el) continue;
      el.classList.toggle('invalid', !r.valid);
      // Manage hint span (insert/remove a sibling .qb-hint).
      let hint = el.parentElement.querySelector('.qb-hint');
      if (!r.valid && r.hint) {
        if (!hint) {
          hint = document.createElement('span');
          hint.className = 'qb-hint';
          el.parentElement.appendChild(hint);
        }
        hint.textContent = r.hint;
        hint.style.display = '';
      } else if (hint) {
        hint.style.display = 'none';
        hint.textContent = '';
      }
    }
    // Empty rows → disable Download PDF.
    const dlBtn = document.getElementById('dl');
    if (dlBtn) {
      dlBtn.disabled = state.rows.length === 0;
      dlBtn.title = state.rows.length === 0
        ? 'Add at least one spec line item to download'
        : 'Download PDF';
    }
    // Inline empty-state hint in spec-count area.
    const specCount = document.getElementById('spec-count');
    if (specCount && state.rows.length === 0) {
      specCount.innerHTML = '0 items <span class="empty-hint">· add at least one line item to download</span>';
    }
  }

  function flush() { saveState(state); renderSpecList(); applyValidation(); renderAreaOverridesPanel(); renderItemRatesPanel(); renderBpfPanel(); renderFloorSummaryEditor(); }

  // ---- Customer field listeners ----
  $('f-salutation').oninput = e => { state.customer.salutation = e.target.value; flush(); };
  // P3 #4: zone rate overrides
  ['f-zone-a-rate','f-zone-b-rate','f-zone-c-rate','f-zone-d-rate','f-basement-rate','f-lift-cost'].forEach(id => {
    const el = $(id);
    if (!el) return;
    const key = ({
      'f-zone-a-rate':    'zoneARate',
      'f-zone-b-rate':    'zoneBRate',
      'f-zone-c-rate':    'zoneCRate',
      'f-zone-d-rate':    'zoneDRate',
      'f-basement-rate':  'basementRate',
      'f-lift-cost':      'liftCost',
    })[id];
    el.oninput = e => {
      const v = e.target.value.trim();
      state.pricing[key] = (v === '') ? null : (parseInt(v) || 0);
      flush();
      renderAreaOverridesPanel();
  renderItemRatesPanel();
  // Phase 7E-C Item 11: render floor-summary editor on initial paint.
  renderFloorSummaryEditor();  // recompute since totals will change
    };
  });
  // P3 #6: layout toggle
  if ($('f-specs-layout')) $('f-specs-layout').onchange = e => { state.specsLayout = e.target.value; flush(); };
  $('f-name').oninput        = e => { state.customer.name = e.target.value; flush(); };
  // 7G-C: address change can flip FAR city (gurugram vs delhi vs noida etc).
  $('f-address').oninput     = e => { state.customer.address = e.target.value; flush(); maybeFarFetch(); };

  // ---- Build geometry listeners ----
  $('f-plot').oninput     = e => { state.build.plotSqYards = +e.target.value || 0; flush(); maybeFarFetch(state); };
  $('f-breadth').oninput  = e => { state.build.breadth = +e.target.value || 0; flush(); maybeFarFetch(state); };
  // 7G-C: coverage input — track whether the user has manually overridden the
  // auto-populated value. Empty field => unlock auto-populate (re-fetch).
  $('f-coverage').oninput = e => {
    const raw = e.target.value;
    const v = +raw || 0;
    state.build.coverage = v;
    const farS = ensureFarState(state);
    if (raw === '' || raw == null) {
      // User cleared the field — reset manual override and re-fetch.
      farS.manualOverride = false;
      farS.lastAuto = null;
      flush();
      maybeFarFetch(state);
      return;
    }
    if (farS.lastAuto != null && v !== farS.lastAuto) {
      farS.manualOverride = true;
      const hint = document.getElementById('far-hint');
      if (hint) { hint.textContent = 'Manual override active. Click ↻ to reset to FAR default, or clear field to re-enable auto-populate.'; hint.style.color = 'var(--gold)'; }
    }
    flush();
  };
  // 7G-C: Reset to FAR default button. Clears manual override and forces a
  // fresh fetch + override of the current field value.
  if ($('far-reset')) {
    $('far-reset').onclick = () => {
      const farS = ensureFarState(state);
      farS.manualOverride = false;
      farS.lastAuto = null;
      const fc = document.getElementById('f-coverage');
      if (fc) fc.value = '';
      state.build.coverage = 0;
      flush();
      const hint = document.getElementById('far-hint');
      if (hint) { hint.textContent = 'Fetching FAR default…'; hint.style.color = 'var(--muted)'; }
      maybeFarFetch(state);
    };
  }
  $('f-floors').oninput   = e => { state.build.floors = +e.target.value || 1; syncBpfRatesLength(); flush(); maybeFarFetch(state); };
  $('f-basement').onchange= e => { state.build.hasBasement = !!e.target.checked; syncBasementRows(); flush(); maybeFarFetch(state); };
  $('f-lift').onchange    = e => {
    state.build.hasLift = !!e.target.checked;
    const row = document.getElementById('lift-cost-row');
    if (row) row.style.display = state.build.hasLift ? '' : 'none';
    flush();
    maybeFarFetch(state);
  };
  // Phase 7B Item 3: water-tank toggle. Sets state.build.hasWaterTank;
  // calc engine omits Zone D entirely when false (zones.D = null).
  if ($('f-water-tank')) $('f-water-tank').onchange = e => {
    state.build.hasWaterTank = !!e.target.checked;
    flush();
  };
  // Phase 7B Item 14: editable lift / staircase per-floor sqft.
  if ($('f-lift-sqft')) $('f-lift-sqft').oninput = e => {
    const v = e.target.value.trim();
    state.pricing.liftSqftPerLevel = (v === '') ? null : (parseInt(v) || 0);
    flush();
  };
  if ($('f-staircase-sqft')) $('f-staircase-sqft').oninput = e => {
    const v = e.target.value.trim();
    state.pricing.staircaseSqftPerLevel = (v === '') ? null : (parseInt(v) || 0);
    flush();
  };
  $('f-build-type').onchange = e => {
    state.build.buildType = e.target.value;
    reflectModeUi(state.build.buildType);
    // Auto-sync scope: structure mode forces structure_only scope
    if (state.build.buildType === 'structure' && state.scope !== 'structure_only') {
      state.scope = 'structure_only';
      state.rows  = defaultRowsFor('structure_only', { hasBasement: !!state.build.hasBasement });
      for (const btn of $('f-scope').querySelectorAll('button')) btn.classList.toggle('active', btn.dataset.v === state.scope);
    } else if (state.build.buildType !== 'structure' && state.scope === 'structure_only') {
      // moving back from structure → keep structure_only scope (user can flip if they want full)
    }
    flush();
    // 7G-C: build type flips wantStilt — re-fetch FAR.
    maybeFarFetch(state);
  };

  // ---- Pricing ----
  $('f-cost-sqft').oninput  = e => { state.pricing.costPerSqft = e.target.value === '' ? null : (+e.target.value || 0); flush(); };
  $('f-struct-rate').oninput= e => { state.pricing.structureRate = e.target.value === '' ? null : (+e.target.value || 0); flush(); };

  // ---- Phase 6.3 — Additional Charges (Elevation / GST / Custom) ----
  // Defensive defaulting so old saved quotes don't blow up on .enabled access.
  state.pricing.additionalZones ||= { elevation:{enabled:false,desc:'',cost:0}, gst:{enabled:false,desc:'',cost:0}, custom:[] };
  state.pricing.additionalZones.elevation ||= { enabled:false, desc:'', cost:0 };
  state.pricing.additionalZones.gst       ||= { enabled:false, desc:'', cost:0 };
  // Phase 7B Item 16: custom is now an array. Migrate any object → [object].
  if (!Array.isArray(state.pricing.additionalZones.custom)) {
    const c = state.pricing.additionalZones.custom;
    if (c && typeof c === 'object' && (c.enabled || c.name || c.cost || c.desc)) {
      state.pricing.additionalZones.custom = [{ enabled: !!c.enabled, name: c.name || '', desc: c.desc || '', cost: c.cost || 0 }];
    } else {
      state.pricing.additionalZones.custom = [];
    }
  }

  function _bindAddlZone(id, hasName) {
    const az = state.pricing.additionalZones[id];
    const onCb   = document.getElementById(`f-addl-${id}-on`);
    const body   = document.getElementById(`addl-${id}-body`);
    const descIn = document.getElementById(`f-addl-${id}-desc`);
    const costIn = document.getElementById(`f-addl-${id}-cost`);
    const nameIn = hasName ? document.getElementById(`f-addl-${id}-name`) : null;
    if (!onCb || !body || !descIn || !costIn) return;
    // Hydrate from state.
    onCb.checked   = !!az.enabled;
    body.style.display = az.enabled ? '' : 'none';
    descIn.value   = az.desc ?? '';
    costIn.value   = (az.cost != null && az.cost !== 0) ? az.cost : '';
    if (nameIn) nameIn.value = az.name ?? '';
    onCb.onchange = e => {
      az.enabled = !!e.target.checked;
      body.style.display = az.enabled ? '' : 'none';
      flush();
    };
    descIn.oninput = e => { az.desc = e.target.value; flush(); };
    costIn.oninput = e => {
      const v = e.target.value.trim();
      az.cost = (v === '') ? 0 : (parseFloat(v) || 0);
      flush();
    };
    if (nameIn) nameIn.oninput = e => { az.name = e.target.value; flush(); };
  }
  _bindAddlZone('elevation', false);
  _bindAddlZone('gst', false);

  // Phase 7B Item 16: render the dynamic list of custom-charge blocks.
  // Each entry has its own toggle / name / desc / cost fields. "Remove" deletes
  // the block; "+ Add Custom Charge" appends a fresh disabled block.
  function renderCustomList() {
    const list = document.getElementById('addl-custom-list');
    if (!list) return;
    const customs = state.pricing.additionalZones.custom || [];
    if (customs.length === 0) {
      list.innerHTML = '<p style="font-size:11px;color:var(--muted);margin:0 0 4px;">No custom charges. Click below to add one.</p>';
      return;
    }
    const html = customs.map((cfg, i) => `
      <div class="addl-block" data-custom-idx="${i}" style="margin-top:10px;border:1px solid var(--rule);border-radius:6px;padding:8px 10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <label class="addl-toggle" style="margin:0;"><input type="checkbox" data-custom-on="${i}" ${cfg.enabled ? 'checked' : ''}> Custom Charge ${i+1}</label>
          <button type="button" data-custom-remove="${i}" style="font-size:11px;padding:3px 8px;background:white;color:#c0392b;border:1px solid var(--rule);border-radius:4px;cursor:pointer;">Remove</button>
        </div>
        <div class="addl-body" style="display:${cfg.enabled ? '' : 'none'};margin-top:6px;">
          <label>Header name</label>
          <input type="text" data-custom-name="${i}" value="${escapeAttr(cfg.name || '')}" placeholder="e.g. Site Logistics">
          <label style="margin-top:6px;">Description</label>
          <input type="text" data-custom-desc="${i}" value="${escapeAttr(cfg.desc || '')}" placeholder="What this charge covers">
          <label style="margin-top:6px;">Cost — ₹ (flat)</label>
          <input type="number" min="0" data-custom-cost="${i}" value="${(cfg.cost != null && cfg.cost !== 0) ? cfg.cost : ''}" placeholder="e.g. 1,50,000">
        </div>
      </div>
    `).join('');
    list.innerHTML = html;
    list.querySelectorAll('input[data-custom-on]').forEach(el => {
      el.onchange = e => {
        const i = parseInt(el.dataset.customOn);
        state.pricing.additionalZones.custom[i].enabled = !!e.target.checked;
        renderCustomList(); flush();
      };
    });
    list.querySelectorAll('input[data-custom-name]').forEach(el => {
      el.oninput = e => {
        const i = parseInt(el.dataset.customName);
        state.pricing.additionalZones.custom[i].name = e.target.value;
        flush();
      };
    });
    list.querySelectorAll('input[data-custom-desc]').forEach(el => {
      el.oninput = e => {
        const i = parseInt(el.dataset.customDesc);
        state.pricing.additionalZones.custom[i].desc = e.target.value;
        flush();
      };
    });
    list.querySelectorAll('input[data-custom-cost]').forEach(el => {
      el.oninput = e => {
        const i = parseInt(el.dataset.customCost);
        const v = e.target.value.trim();
        state.pricing.additionalZones.custom[i].cost = (v === '') ? 0 : (parseFloat(v) || 0);
        flush();
      };
    });
    list.querySelectorAll('button[data-custom-remove]').forEach(el => {
      el.onclick = () => {
        const i = parseInt(el.dataset.customRemove);
        state.pricing.additionalZones.custom.splice(i, 1);
        renderCustomList(); flush();
      };
    });
  }
  renderCustomList();
  const addCustomBtn = document.getElementById('addl-custom-add');
  if (addCustomBtn) addCustomBtn.onclick = () => {
    state.pricing.additionalZones.custom.push({ enabled: true, name: '', desc: '', cost: 0 });
    renderCustomList(); flush();
  };

  // Phase 6.2 — per-floor balcony pricing toggle. The per-floor rate inputs
  // are rendered by renderBpfPanel() and re-bound on every flush() so they
  // always reflect the current numFloors and saved values.
  state.pricing.balconyPerFloor ||= { enabled: false, rates: [] };
  {
    const onCb = document.getElementById('f-bpf-on');
    if (onCb) {
      onCb.onchange = e => {
        state.pricing.balconyPerFloor.enabled = !!e.target.checked;
        // On first turn-on, rates default to all-null (rep enters them).
        if (state.pricing.balconyPerFloor.enabled
            && (!Array.isArray(state.pricing.balconyPerFloor.rates)
                || state.pricing.balconyPerFloor.rates.length === 0)) {
          state.pricing.balconyPerFloor.rates = new Array(state.build.floors || 0).fill(null);
        }
        flush();
      };
    }
  }
  $('f-notes').oninput      = e => {
    let v = e.target.value;
    if (v.length > 2000) { v = v.slice(0, 2000); e.target.value = v; }
    state.notes = v;
    saveState(state);
    document.getElementById('notes-count').textContent = `${v.length}/2000`;
  };
  document.getElementById('notes-count').textContent = `${(state.notes||'').length}/2000`;

  // ---- P1.6: DRAFT watermark toggle ----
  const draftCb = document.getElementById('f-draft');
  if (draftCb) {
    draftCb.checked = !!state.draft;
    draftCb.onchange = e => {
      state.draft = !!e.target.checked;
      saveState(state);
    };
  }


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

  // P1.4: New Quote — wipes current quote and reloads to empty state.
  // Foundation for P1.5 (named save/load). Sales hits this when starting a fresh customer.
  const newQuoteBtn = document.getElementById('new-quote');
  if (newQuoteBtn) {
    newQuoteBtn.onclick = () => {
      const total = state.rows.length;
      const customerName = (state.customer?.name || '').trim();
      const msg = total === 0 && !customerName
        ? 'Start a new quote? (Current state is already empty.)'
        : 'Clear current quote and start fresh?\n\n' +
          (customerName ? `Customer: ${customerName}\n` : '') +
          `Rows: ${total}\n\nThis cannot be undone. (P1.5 will add Save/Load.)`;
      if (!confirm(msg)) return;
      try {
        localStorage.removeItem(STORE_KEY);
        // P1.5: also drop the active named-slot pointer so we go to scratch mode.
        QuoteStorage.setActiveId('');
      } catch (e) {}
      location.reload();
    };
  }

  // ============================================================================
  // P1.5 — Save / Load / Export / Import + auto-save + storage warning
  // ============================================================================
  // Toast helper. Disappears after 2.4s (3.6s for warn/err).
  let _toastTimer = null;
  function toast(msg, kind) {
    const el = document.getElementById('qb-toast');
    if (!el) return;
    el.className = 'qb-toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    // Force reflow then add .show
    void el.offsetWidth;
    el.classList.add('show');
    if (_toastTimer) clearTimeout(_toastTimer);
    const dwell = (kind === 'warn' || kind === 'err') ? 3600 : 2400;
    _toastTimer = setTimeout(() => el.classList.remove('show'), dwell);
  }

  // Indicator helper: "Saving…" → "Saved at HH:MM" → muted.
  const savedIndicator = document.getElementById('saved-indicator');
  function setIndicator(state, text) {
    if (!savedIndicator) return;
    savedIndicator.className = 'saved-indicator' + (state ? ' ' + state : '');
    savedIndicator.textContent = text || '';
  }
  function refreshIndicatorIdle() {
    const aid = QuoteStorage.activeId();
    if (!aid) { setIndicator('', ''); return; }
    const entry = QuoteStorage.list().find(e => e.id === aid);
    if (!entry) { setIndicator('', ''); return; }
    const t = new Date(entry.modified_at);
    const hh = String(t.getHours()).padStart(2,'0');
    const mm = String(t.getMinutes()).padStart(2,'0');
    const pending = QuoteStorage._pendingPushes || 0;
    if (pending > 0) {
      setIndicator('saving', 'Syncing\u2026');
    } else if (!QuoteStorage._syncEnabled) {
      setIndicator('saved', 'Saved ' + hh + ':' + mm + ' (local only)');
    } else {
      setIndicator('saved', 'Saved ' + hh + ':' + mm);
    }
  }
  // Phase 4: refresh indicator on every cloud-sync state change.
  let __syncIndTimer = null;
  window.addEventListener('quote-sync-state-changed', () => {
    if (__syncIndTimer) clearTimeout(__syncIndTimer);
    __syncIndTimer = setTimeout(refreshIndicatorIdle, 50);
  });

  // Storage pressure check — call after any explicit save.
  // Browsers cap localStorage at ~5-10 MB. Warn at 4 MB.
  function checkStoragePressure() {
    try {
      const used = QuoteStorage.size();
      if (used > 4 * 1024 * 1024) {
        toast('Storage 80% full. Export old quotes and delete to free space.', 'warn');
      }
    } catch (_) {}
  }

  // Modal helpers
  const saveModal = document.getElementById('save-modal');
  const loadModal = document.getElementById('load-modal');
  function openModal(m) { if (m) m.classList.add('open'); }
  function closeModal(m) { if (m) m.classList.remove('open'); }
  // Click-outside-to-close
  if (saveModal) saveModal.addEventListener('click', e => { if (e.target === saveModal) closeModal(saveModal); });
  if (loadModal) loadModal.addEventListener('click', e => { if (e.target === loadModal) closeModal(loadModal); });

  // ---- Save Quote button + modal ----
  const saveBtn = document.getElementById('save-quote');
  if (saveBtn) saveBtn.onclick = () => {
    const aid = QuoteStorage.activeId();
    const promptDiv  = document.getElementById('save-modal-prompt');
    const existDiv   = document.getElementById('save-modal-existing');
    const saveAsNew  = document.getElementById('save-as-new');
    const nameInput  = document.getElementById('save-name-input');
    const titleEl    = document.getElementById('save-modal-title');
    const existName  = document.getElementById('save-existing-name');

    if (aid) {
      // 7G-A Bug #4: Existing slot now ALSO shows the name input pre-filled
      // with the current name so the rep can rename on resave. Save button
      // overwrites in place (same id) but with the (possibly edited) name.
      // Save As New still creates a fresh copy.
      const entry = QuoteStorage.list().find(e => e.id === aid);
      promptDiv.style.display  = '';
      existDiv.style.display   = '';
      saveAsNew.style.display  = '';
      titleEl.textContent      = 'Save quote';
      existName.textContent    = entry ? entry.name : '(unknown)';
      nameInput.value          = entry ? entry.name : '';
    } else {
      // No slot: prompt for name with sensible default.
      const cn = (state.customer.name || '').trim() || 'Untitled';
      const today = new Date().toISOString().slice(0,10);
      promptDiv.style.display = '';
      existDiv.style.display  = 'none';
      saveAsNew.style.display = 'none';
      titleEl.textContent     = 'Save quote';
      nameInput.value         = cn + ' — ' + today;
    }
    openModal(saveModal);
    // 7G-A Bug #4: focus & select name input on open in BOTH modes so the
    // rep can immediately type to rename.
    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 30);
  };

  document.getElementById('save-cancel').onclick = () => closeModal(saveModal);

  document.getElementById('save-confirm').onclick = () => {
    setIndicator('saving', 'Saving…');
    let id;
    try {
      const aid = QuoteStorage.activeId();
      const nameInputVal = (document.getElementById('save-name-input').value || '').trim();
      if (aid) {
        // 7G-A Bug #4: overwrite path now also accepts a (possibly renamed)
        // name. QuoteStorage.save() updates entry.name if the second arg is
        // non-undefined on an existing slot.
        id = QuoteStorage.save(state, nameInputVal || undefined);
      } else {
        id = QuoteStorage.save(state, nameInputVal);
      }
      QuoteStorage.setActiveId(id);
      state.quoteId = id; // mirror into in-memory state
      saveState(state);   // re-persist to scratch + named slot via _touch
      closeModal(saveModal);
      toast('Saved');
      refreshIndicatorIdle();
      checkStoragePressure();
    } catch (e) {
      toast('Save failed: ' + e.message, 'err');
      setIndicator('', '');
    }
  };

  document.getElementById('save-as-new').onclick = () => {
    setIndicator('saving', 'Saving…');
    try {
      // Force create-new path by clearing in-state quoteId
      const orig = state.quoteId;
      state.quoteId = null;
      const cn = (state.customer.name || '').trim() || 'Untitled';
      const today = new Date().toISOString().slice(0,10);
      const id = QuoteStorage.save(state, cn + ' — ' + today + ' (copy)');
      QuoteStorage.setActiveId(id);
      state.quoteId = id;
      saveState(state);
      closeModal(saveModal);
      toast('Saved as new copy');
      refreshIndicatorIdle();
      checkStoragePressure();
    } catch (e) {
      toast('Save failed: ' + e.message, 'err');
      setIndicator('', '');
    }
  };

  // Enter inside name input = save
  document.getElementById('save-name-input').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); document.getElementById('save-confirm').click(); }
  });

  // ---- Load Quote button + modal ----
  function renderLoadList() {
    const body = document.getElementById('load-modal-body');
    const list = QuoteStorage.list();
    if (!list.length) {
      body.innerHTML = '<div class="qm-empty">No saved quotes yet. Click <b>Save</b> to create one.</div>';
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'qm-list';
    for (const e of list) {
      const li = document.createElement('li');
      const cn = e.customer_name || '(no customer name)';
      const date = (e.modified_at || '').slice(0, 10);
      const author = e.author ? ('by ' + e.author + ' · ') : '';
      li.innerHTML = `
        <span class="meta">
          <span class="name">${escapeHtml(e.name || cn)}</span>
          <span class="sub">${escapeHtml(cn)} · ${escapeHtml(author)}saved ${escapeHtml(date)} · ${e.row_count || 0} rows</span>
        </span>
        <span class="row-acts">
          <button data-act="open" class="btn-primary">Open</button>
          <button data-act="dup" title="Duplicate">⎘</button>
          <button data-act="del" class="btn-danger" title="Delete">×</button>
        </span>
      `;
      li.querySelector('[data-act="open"]').onclick = () => openSavedQuote(e.id);
      li.querySelector('[data-act="dup"]').onclick  = () => {
        try { const newId = QuoteStorage.duplicate(e.id); toast('Duplicated'); renderLoadList(); }
        catch (err) { toast('Duplicate failed: ' + err.message, 'err'); }
      };
      li.querySelector('[data-act="del"]').onclick  = () => {
        if (!confirm('Delete "' + (e.name || cn) + '"? This cannot be undone.')) return;
        try { QuoteStorage.delete(e.id); toast('Deleted'); renderLoadList(); refreshIndicatorIdle(); }
        catch (err) { toast('Delete failed: ' + err.message, 'err'); }
      };
      ul.appendChild(li);
    }
    body.innerHTML = '';
    body.appendChild(ul);
  }

  function openSavedQuote(id) {
    // If current state has unsaved changes (no active id but state has any data), confirm first.
    const hasContent = (state.customer.name || (state.rows && state.rows.length));
    const aid = QuoteStorage.activeId();
    if (!aid && hasContent) {
      if (!confirm('Open saved quote? Your current scratch quote will be discarded.\n\nClick Cancel and use Save first if you want to keep it.')) return;
    }
    QuoteStorage.setActiveId(id);
    closeModal(loadModal);
    location.reload();
  }

  const loadBtn = document.getElementById('load-quote');
  if (loadBtn) loadBtn.onclick = async () => {
    // Phase 4: force a fresh cloud pull so the rep sees teammates' latest quotes.
    renderLoadList();
    openModal(loadModal);
    try {
      await Promise.race([
        QuoteStorage.syncFromCloud(),
        new Promise(r => setTimeout(r, 3000)),
      ]);
    } catch (_) {}
    renderLoadList();
  };
  document.getElementById('load-close').onclick = () => closeModal(loadModal);

  // ---- Export JSON ----
  function sanitizeFilename(s) {
    return (s || 'quote').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'quote';
  }
  const exportBtn = document.getElementById('export-quote');
  if (exportBtn) exportBtn.onclick = () => {
    try {
      // Export current in-memory state (works whether or not it's saved).
      const json = JSON.stringify(state, null, 2);
      const cn = sanitizeFilename(state.customer.name || 'unnamed');
      const date = new Date().toISOString().slice(0, 10);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = cn + '_' + date + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Exported');
    } catch (e) {
      toast('Export failed: ' + e.message, 'err');
    }
  };

  // ---- Import JSON ----
  const importBtn  = document.getElementById('import-quote');
  const importFile = document.getElementById('import-file');
  if (importBtn && importFile) {
    importBtn.onclick = () => {
      const hasContent = (state.customer.name || (state.rows && state.rows.length));
      const aid = QuoteStorage.activeId();
      if (!aid && hasContent) {
        if (!confirm('Import will replace the current scratch quote. Continue?\n\nClick Cancel and Save first to keep it.')) return;
      }
      importFile.value = '';
      importFile.click();
    };
    importFile.onchange = (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const id = QuoteStorage.importJSON(String(reader.result));
          QuoteStorage.setActiveId(id);
          const loaded = QuoteStorage.load(id);
          const cn = (loaded && loaded.customer && loaded.customer.name) || 'unknown';
          toast('Imported quote for ' + cn);
          location.reload();
        } catch (e) {
          toast('Import failed: ' + e.message, 'err');
        }
      };
      reader.onerror = () => toast('Could not read file', 'err');
      reader.readAsText(f);
    };
  }


  // ---- Auto-save (3-second debounce) ----
  // Only fires when there's an active named slot. In scratch mode user must explicitly Save.
  let _autoSaveTimer = null;
  function scheduleAutoSave() {
    const aid = QuoteStorage.activeId();
    if (!aid) return;
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
    setIndicator('saving', 'Saving…');
    _autoSaveTimer = setTimeout(() => {
      try {
        // saveState already calls _touch under the hood; we just need to refresh
        // the indicator AFTER the timestamp has been written.
        saveState(state);
        refreshIndicatorIdle();
        checkStoragePressure();
      } catch (e) {
        setIndicator('', '');
        toast('Auto-save failed: ' + e.message, 'err');
      }
    }, 3000);
  }
  window.addEventListener('quote-state-changed', scheduleAutoSave);
  // Initial indicator paint
  refreshIndicatorIdle();

  function reflectModeUi(mode) {
    const isStruct = mode === 'structure';
    document.getElementById('cost-sqft-row').style.display    = isStruct ? 'none' : '';
    document.getElementById('struct-rate-row').style.display  = isStruct ? '' : 'none';
    document.getElementById('floors-label').textContent       = (mode === 'nostilt') ? 'Number of floors (incl. ground)' : 'Floors above stilt';
    // P3 #3: show basement rate input only when basement checked
    const bRow = document.getElementById('basement-rate-row');
    if (bRow) bRow.style.display = state.build.hasBasement ? '' : 'none';
    // P3 #4: hide Zone A override in structure mode
    const zaRow = document.getElementById('f-zone-a-rate');
    if (zaRow && zaRow.parentElement) zaRow.parentElement.style.display = isStruct ? 'none' : '';
    const zbRow = document.getElementById('f-zone-b-rate');
    if (zbRow && zbRow.parentElement) zbRow.parentElement.style.display = isStruct ? 'none' : '';
    const zcRow = document.getElementById('f-zone-c-rate');
    if (zcRow && zcRow.parentElement) zcRow.parentElement.style.display = isStruct ? 'none' : '';
  }

  // ---- P3 #7: Area Overrides panel (left rail) ----
  // Phase 7B Item 17: inline ✎ rename for item name + 📝 for description.
  // Phase 7B Item 15: per-zone "+ Add line item" button. Rep-added rows
  // render as editable name/desc/area/rate fields with a Remove button.
  function renderAreaOverridesPanel() {
    const fs = document.getElementById('area-ovr-fs');
    const list = document.getElementById('area-ovr-list');
    if (!fs || !list) return;
    // Hide if no plot/coverage entered yet
    if (!state.build.plotSqYards || !state.build.coverage) { fs.style.display = 'none'; return; }
    fs.style.display = '';
    state.areaOverrides ||= {};
    state.pricing.itemNameOverrides ||= {};
    state.pricing.itemDescOverrides ||= {};
    state.pricing.zoneLineItems     ||= {};
    let c;
    try { c = computeQuote(state); }
    catch (_) { list.innerHTML = '<p style="font-size:11px;color:var(--muted);">Enter pricing to see line items.</p>'; return; }
    const html = [];
    for (const k of ['A','B','C','D','E']) {
      const z = c.zones?.[k];
      if (!z) continue; // zone disabled (D off, C in struct, E without basement)
      html.push(`<div class="aov-zone"><div class="aov-zone-hdr">Zone ${k} <span class="aov-rate">${escapeHtml(z.rateLabel || '')}</span></div>`);
      (z.items || []).forEach(it => {
        const origName = it.origName || it.name;
        const key = k + ':' + origName;
        const v = state.areaOverrides[key] ?? '';
        const unit = z.unit ? z.unit : 'sqft';
        const computed = (state.areaOverrides[key] != null && state.areaOverrides[key] !== '') ? null : it.area;
        const placeholder = `auto: ${niA(computed != null ? computed : it.area)}`; // 7G-B
        const nameOv = state.pricing.itemNameOverrides[key];
        const descOv = state.pricing.itemDescOverrides[key];
        const displayName = (nameOv && nameOv.trim()) ? nameOv : it.name;
        const isLineItem = !!it._zoneLineItem;
        if (isLineItem) {
          // Item 15 row: editable name + desc + area + rate inline, with Remove.
          // Phase 7E-C Item 7: Zone A line items also get a floor-attribution select.
          const rid = it._lineItemId || '';
          const floorOpts = (k === 'A') ? floorOptionsForA(state) : [];
          const liveFloor = (it._floor || '');
          const floorSelectHtml = (k === 'A')
            ? `<select data-li-field="floor" title="Add this item's area to a floor's covered total" style="flex:0 0 auto;font-size:11px;padding:4px 6px;background:#fff;color:var(--navy);border:1px solid var(--rule);border-radius:4px;"><option value="">— floor (optional) —</option>${floorOpts.map(f => `<option value="${escapeAttr(f)}"${f === liveFloor ? ' selected' : ''}>${escapeHtml(f)}</option>`).join('')}</select>`
            : '';
          html.push(`
            <div class="aov-row aov-lineitem" data-zone="${k}" data-lineitem-id="${escapeAttr(rid)}" style="flex-wrap:wrap;gap:4px;align-items:flex-start;">
              <input type="text" data-li-field="name" value="${escapeAttr(it.name)}" placeholder="Item name" style="flex:1 1 auto;min-width:120px;font-size:11.5px;font-weight:600;color:var(--navy);">
              <input type="number" min="0" data-li-field="area" value="${it.area || ''}" placeholder="area" style="width:70px;">
              <span class="aov-unit">${escapeHtml(unit)}</span>
              <input type="number" min="0" data-li-field="rate" value="${it.rate || ''}" placeholder="rate" style="width:70px;">
              <span class="aov-unit">₹/${escapeHtml(unit)}</span>
              <button type="button" data-li-remove="1" title="Remove" style="font-size:11px;padding:2px 6px;background:white;color:#c0392b;border:1px solid var(--rule);border-radius:4px;cursor:pointer;">✕</button>
              ${floorSelectHtml}
              <input type="text" data-li-field="desc" value="${escapeAttr(it.desc || '')}" placeholder="description (optional)" style="flex:1 1 100%;font-size:10.5px;color:var(--muted);">
            </div>
          `);
        } else {
          // Phase 7E-C Item 5: inline-editable description per row. The desc
          // input always renders below the rename/area row (flex:1 1 100%
          // wraps it). Default value comes from the calc-engine desc; rep
          // edits write to state.pricing.itemDescOverrides via data-desc-key.
          // Replaces the prompt()-based 📝 button from 7B-17 with a friendlier
          // always-visible UX.
          const descDefault = it.desc || '';
          const descCur = (descOv != null && descOv !== '') ? descOv : descDefault;
          const descIsOverride = (descOv != null && descOv !== '');
          html.push(`
            <div class="aov-row" style="flex-wrap:wrap;gap:4px;align-items:flex-start;">
              <span class="aov-name aov-name-with-edit" style="flex:1 1 auto;min-width:120px;display:inline-flex;align-items:center;gap:4px;">
                <span class="aov-display-name">${escapeHtml(displayName)}</span>
                <button type="button" data-rename-key="${escapeAttr(key)}" title="Rename item" style="font-size:11px;padding:1px 4px;background:transparent;color:var(--muted);border:none;cursor:pointer;">✎</button>
              </span>
              <input type="number" min="0" data-aov-key="${escapeAttr(key)}" value="${v === '' ? '' : escapeAttr(String(v))}" placeholder="${escapeAttr(placeholder)}" style="width:90px;">
              <span class="aov-unit">${escapeHtml(unit)}</span>
              <input type="text" data-desc-key="${escapeAttr(key)}" value="${escapeAttr(descCur)}" placeholder="${escapeAttr('description: ' + descDefault)}" title="${descIsOverride ? 'description (custom)' : 'description (auto)'}" style="flex:1 1 100%;font-size:10.5px;color:${descIsOverride ? 'var(--ink)' : 'var(--muted)'};${descIsOverride ? 'font-style:normal;' : 'font-style:italic;'}">
            </div>
          `);
        }
      });
      // 7G-A Bug #5: Render PENDING line items — those in state.pricing.zoneLineItems[k]
      // but NOT yet present in z.items. The calc engine (appendZoneLineItems) skips
      // rows where area<=0 OR rate<=0 because they can't contribute cost. That made
      // the "+ Add line" button appear to do nothing — clicks pushed an empty row
      // into state, but renderAreaOverridesPanel() couldn't show it because the row
      // was filtered out at calc time. Now we render incomplete rows here so reps
      // can fill area/rate inline. Once both are >0, the calc engine picks them up
      // on the next render and the row "promotes" to a full item (still rendered
      // by the loop above — we de-dupe by _lineItemId).
      const pendingRows = (state.pricing.zoneLineItems[k] || []).filter(r => {
        const areaVal = (r.area != null && r.area !== '' && !isNaN(parseFloat(r.area))) ? parseFloat(r.area) : 0;
        const rateVal = (r.rate != null && r.rate !== '' && !isNaN(parseFloat(r.rate))) ? parseFloat(r.rate) : 0;
        return areaVal <= 0 || rateVal <= 0;
      });
      pendingRows.forEach(r => {
        const rid = r.id || '';
        const unit = z.unit ? z.unit : 'sqft';
        const floorOpts = (k === 'A') ? floorOptionsForA(state) : [];
        const liveFloor = (r.floor || '');
        const floorSelectHtml = (k === 'A')
          ? `<select data-li-field="floor" title="Add this item's area to a floor's covered total" style="flex:0 0 auto;font-size:11px;padding:4px 6px;background:#fff;color:var(--navy);border:1px solid var(--rule);border-radius:4px;"><option value="">— floor (optional) —</option>${floorOpts.map(f => `<option value="${escapeAttr(f)}"${f === liveFloor ? ' selected' : ''}>${escapeHtml(f)}</option>`).join('')}</select>`
          : '';
        html.push(`
          <div class="aov-row aov-lineitem aov-lineitem-pending" data-zone="${k}" data-lineitem-id="${escapeAttr(rid)}" style="flex-wrap:wrap;gap:4px;align-items:flex-start;background:#fffbe6;">
            <input type="text" data-li-field="name" value="${escapeAttr(r.name || '')}" placeholder="Item name" style="flex:1 1 auto;min-width:120px;font-size:11.5px;font-weight:600;color:var(--navy);">
            <input type="number" min="0" data-li-field="area" value="${r.area || ''}" placeholder="area" style="width:70px;">
            <span class="aov-unit">${escapeHtml(unit)}</span>
            <input type="number" min="0" data-li-field="rate" value="${r.rate || ''}" placeholder="rate" style="width:70px;">
            <span class="aov-unit">₹/${escapeHtml(unit)}</span>
            <button type="button" data-li-remove="1" title="Remove" style="font-size:11px;padding:2px 6px;background:white;color:#c0392b;border:1px solid var(--rule);border-radius:4px;cursor:pointer;">✕</button>
            ${floorSelectHtml}
            <input type="text" data-li-field="desc" value="${escapeAttr(r.desc || '')}" placeholder="description (optional)" style="flex:1 1 100%;font-size:10.5px;color:var(--muted);">
          </div>
        `);
      });
      // Item 15: + Add line item button per zone.
      html.push(`<div class="aov-row" style="border-top:1px dashed var(--rule);padding-top:6px;margin-top:4px;"><button type="button" data-add-line-zone="${k}" style="font-size:11px;padding:4px 10px;background:white;color:var(--navy);border:1px dashed var(--rule);border-radius:4px;cursor:pointer;font-weight:600;">+ Add line item to Zone ${k}</button></div>`);
      html.push('</div>');
    }
    list.innerHTML = html.join('');

    // Bind area-override numeric inputs (existing behaviour).
    list.querySelectorAll('input[data-aov-key]').forEach(inp => {
      inp.oninput = e => {
        const key = inp.dataset.aovKey;
        const val = e.target.value.trim();
        if (val === '') delete state.areaOverrides[key];
        else state.areaOverrides[key] = parseInt(val) || 0;
        saveState(state);
      };
      inp.onblur = e => { renderAreaOverridesPanel(); };
    });

    // Phase 7E-C Item 5: inline desc editor for static items.
    list.querySelectorAll('input[data-desc-key]').forEach(inp => {
      inp.oninput = e => {
        const key = inp.dataset.descKey;
        const val = e.target.value;
        const ph = inp.placeholder || '';
        const def = ph.startsWith('description: ') ? ph.slice('description: '.length) : '';
        if (val.trim() === '' || val === def) {
          delete state.pricing.itemDescOverrides[key];
        } else {
          state.pricing.itemDescOverrides[key] = val;
        }
        saveState(state);
      };
      inp.onblur = () => { renderAreaOverridesPanel(); };
    });

    // Item 17: rename button → swap span for input, Enter / blur to commit.
    list.querySelectorAll('button[data-rename-key]').forEach(btn => {
      btn.onclick = () => {
        const key = btn.dataset.renameKey;
        const wrap = btn.closest('.aov-name-with-edit');
        const span = wrap.querySelector('.aov-display-name');
        const cur = span.textContent;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = cur;
        inp.style.cssText = 'flex:1 1 auto;font-size:11.5px;font-weight:600;color:var(--navy);min-width:100px;background:#fff;';
        const commit = () => {
          const val = inp.value.trim();
          // Resolve original name from key for comparison.
          const origName = key.split(':').slice(1).join(':');
          if (val === '' || val === origName) {
            delete state.pricing.itemNameOverrides[key];
          } else {
            state.pricing.itemNameOverrides[key] = val;
          }
          saveState(state);
          renderAreaOverridesPanel();
          renderItemRatesPanel();
        };
        inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { renderAreaOverridesPanel(); } };
        inp.onblur = commit;
        span.replaceWith(inp);
        inp.focus(); inp.select();
      };
    });

    // Phase 7E-C Item 5: replaced the prompt()-based 📝 button (7B-17)
    // with the inline data-desc-key input above. No-op kept defensively.
    list.querySelectorAll('button[data-redesc-key]').forEach(() => {});

    // Item 15: + Add line item to zone.
    list.querySelectorAll('button[data-add-line-zone]').forEach(btn => {
      btn.onclick = () => {
        const k = btn.dataset.addLineZone;
        state.pricing.zoneLineItems[k] = state.pricing.zoneLineItems[k] || [];
        const id = 'li_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7);
        state.pricing.zoneLineItems[k].push({ id, name: '', desc: '', area: 0, rate: 0 });
        saveState(state);
        renderAreaOverridesPanel();
        renderItemRatesPanel();
        // Auto-focus the newly added name field.
        setTimeout(() => {
          const newRow = list.querySelector(`.aov-lineitem[data-lineitem-id="${id}"] input[data-li-field="name"]`);
          if (newRow) newRow.focus();
        }, 0);
      };
    });

    // Item 15: line-item field bindings (name/desc/area/rate) + remove.
    list.querySelectorAll('.aov-lineitem').forEach(row => {
      const k = row.dataset.zone;
      const rid = row.dataset.lineitemId;
      const arr = state.pricing.zoneLineItems[k] || [];
      const idx = arr.findIndex(x => x.id === rid);
      if (idx < 0) return;
      const liveRow = arr[idx];
      const onField = (field) => (e) => {
        const v = e.target.value;
        if (field === 'area' || field === 'rate') {
          const t = v.trim();
          liveRow[field] = (t === '') ? 0 : (parseFloat(t) || 0);
        } else {
          liveRow[field] = v;
        }
        saveState(state);
      };
      // Phase 7E-C Item 7: include <select> elements (Zone-A floor picker).
      row.querySelectorAll('[data-li-field]').forEach(inp => {
        const f = inp.dataset.liField;
        inp.oninput = onField(f);
        inp.onchange = onField(f);
        inp.onblur = () => { renderAreaOverridesPanel(); renderItemRatesPanel(); renderFloorSummaryEditor(); };
      });
      const rm = row.querySelector('button[data-li-remove]');
      if (rm) rm.onclick = () => {
        arr.splice(idx, 1);
        saveState(state);
        renderAreaOverridesPanel();
        renderItemRatesPanel();
      };
    });
  }

  // ---- P3 v2 (A): Per-line-item rate overrides panel (inside Pricing fieldset) ----
  function renderItemRatesPanel() {
    const list = document.getElementById('item-rate-list');
    if (!list) return;
    state.pricing.itemRates ||= {};
    let c;
    try { c = computeQuote(state); }
    catch (_) {
      list.innerHTML = '<p style="font-size:11px;color:var(--muted);margin:0;">Enter pricing & build details to see line items.</p>';
      return;
    }
    if (!state.build.plotSqYards || !state.build.coverage) {
      list.innerHTML = '<p style="font-size:11px;color:var(--muted);margin:0;">Enter plot dimensions & coverage to see line items.</p>';
      return;
    }
    const html = [];
    let hasOverride = false;
    const zoneDefaults = {
      A: c.zones.A?.rate, B: c.zones.B?.rate, C: c.zones.C?.rate, D: c.zones.D?.rate, E: c.zones.E?.rate,
    };
    for (const k of ['A','B','C','D','E']) {
      const z = c.zones?.[k];
      if (!z || !z.items?.length) continue;
      // Get the *default* (zone) rate, not the per-item rate, so placeholder
      // shows the fallback, not the current override.
      let zoneDefault = zoneDefaults[k];
      // Re-compute zone default ignoring item overrides: read from pricing inputs.
      const p = state.pricing;
      const baseFormula = parseInt(p.costPerSqft) || 0;
      const ovr = (v, fb) => (v != null && v !== '' && !isNaN(parseInt(v))) ? parseInt(v) : fb;
      const isStruct = state.build.buildType === 'structure' || state.scope === 'structure_only';
      const strR = parseInt(p.structureRate) || 0;
      if (k === 'A') zoneDefault = isStruct ? strR : ovr(p.zoneARate, baseFormula);
      else if (k === 'B') zoneDefault = isStruct ? 500 : ovr(p.zoneBRate, Math.round(baseFormula * 0.5));
      else if (k === 'C') zoneDefault = ovr(p.zoneCRate, C_RATE); // 7G-B
      else if (k === 'D') zoneDefault = ovr(p.zoneDRate, 15);
      else if (k === 'E') zoneDefault = ovr(p.basementRate, 2700);
      const unit = z.unit ? '/' + z.unit : '/sqft';
      html.push(`<div class="aov-zone"><div class="aov-zone-hdr">Zone ${k} <span class="aov-rate">default ₹${ni(zoneDefault)}${unit}</span></div>`);
      z.items.forEach(it => {
        const key = k + ':' + it.name;
        const v = state.pricing.itemRates[key] ?? '';
        if (v !== '') hasOverride = true;
        html.push(`
          <div class="aov-row">
            <span class="aov-name">${escapeHtml(it.name)}</span>
            <input type="number" min="0" data-itemrate-key="${escapeAttr(key)}" value="${v === '' ? '' : escapeAttr(String(v))}" placeholder="${escapeAttr('₹' + ni(zoneDefault))}" style="width:90px;">
            <span class="aov-unit">${escapeHtml(unit.replace('/', ''))}</span>
          </div>
        `);
      });
      html.push('</div>');
    }
    list.innerHTML = html.join('');
    // Phase 6.1 #1: open by default so the rep sees all line items immediately;
    // they can still collapse via the chevron. (Previously this only auto-opened
    // when an override was already set — which was unhelpful on a fresh quote.)
    const details = document.getElementById('item-rate-overrides');
    if (details) details.open = true;
    void hasOverride; // (kept for any future "user-set" indicator)
    list.querySelectorAll('input[data-itemrate-key]').forEach(inp => {
      inp.oninput = e => {
        const key = inp.dataset.itemrateKey;
        const val = e.target.value.trim();
        if (val === '') delete state.pricing.itemRates[key];
        else state.pricing.itemRates[key] = parseInt(val) || 0;
        saveState(state);
      };
      inp.onblur = e => { renderItemRatesPanel(); };
    });
  }

  // ---- Phase 6.2: per-floor balcony pricing panel ----
  // Editor always shows N rows when toggle is ON (one per floor) so the rep
  // can see/edit each rate. The PDF collapses to a single Balcony row when
  // every per-floor rate is equal — that logic lives in renderCostPage.
  // Resizing: when state.build.floors changes (via the floors input handler),
  // we trim or pad state.pricing.balconyPerFloor.rates to match length.
  function syncBpfRatesLength() {
    const bpf = state.pricing.balconyPerFloor;
    if (!bpf) return;
    const n = state.build.floors || 0;
    const cur = Array.isArray(bpf.rates) ? bpf.rates : [];
    if (cur.length === n) return;
    if (cur.length > n) bpf.rates = cur.slice(0, n);
    else {
      bpf.rates = cur.slice();
      while (bpf.rates.length < n) bpf.rates.push(null);
    }
  }

  function renderBpfPanel() {
    const block = document.getElementById('bpf-block');
    const onCb  = document.getElementById('f-bpf-on');
    const body  = document.getElementById('bpf-body');
    const list  = document.getElementById('bpf-rate-list');
    if (!block || !onCb || !body || !list) return;
    state.pricing.balconyPerFloor ||= { enabled: false, rates: [] };
    syncBpfRatesLength();
    const bpf = state.pricing.balconyPerFloor;

    // Hide entire block when in structure mode (no balcony in structure calc).
    const isStruct = state.build.buildType === 'structure';
    block.style.display = isStruct ? 'none' : '';
    onCb.checked = !!bpf.enabled;
    body.style.display = bpf.enabled ? '' : 'none';
    if (!bpf.enabled) { list.innerHTML = ''; return; }

    // Compute zone B default rate label for the placeholder.
    const baseFormula = parseInt(state.pricing.costPerSqft) || 0;
    const ovr = (v, fb) => (v != null && v !== '' && !isNaN(parseInt(v))) ? parseInt(v) : fb;
    const bRate = ovr(state.pricing.zoneBRate, Math.round(baseFormula * 0.50));
    const placeholder = bRate ? `default ₹${ni(bRate)}/sqft` : 'rate ₹/sqft';
    const balconyFloorNames = ['Floor 1','Floor 2','Floor 3','Floor 4','Floor 5','Floor 6'];
    const html = [];
    html.push(`<div class="aov-zone"><div class="aov-zone-hdr">Balcony rates per floor <span class="aov-rate">${placeholder}</span></div>`);
    for (let i = 0; i < (state.build.floors || 0); i++) {
      const fname = balconyFloorNames[i] || ('Floor ' + (i+1));
      const v = (bpf.rates[i] != null && bpf.rates[i] !== '') ? bpf.rates[i] : '';
      html.push(`<div class="aov-row"><span class="aov-name">${escapeHtml(fname)}</span><input type="number" min="0" data-bpf-floor="${i}" placeholder="${escapeHtml(placeholder)}" value="${escapeAttr(String(v))}"><span class="aov-unit">₹/sqft</span></div>`);
    }
    html.push(`</div>`);
    list.innerHTML = html.join('');

    list.querySelectorAll('input[data-bpf-floor]').forEach(inp => {
      inp.oninput = e => {
        const idx = parseInt(inp.dataset.bpfFloor);
        const val = e.target.value.trim();
        bpf.rates[idx] = (val === '') ? null : (parseInt(val) || 0);
        saveState(state);
      };
    });
  }

  // ---- Phase 7E-C Item 11: Floor Summary editor (left rail) ----
  // Renders one editable row per floor-summary row + the Total row. Writes
  // go to state.pricing.floorSummaryOverrides[label]. Clearing a field
  // (whitespace) deletes the override so the row falls back to computed.
  function renderFloorSummaryEditor() {
    const fs = document.getElementById('floor-summary-fs');
    const list = document.getElementById('floor-summary-list');
    if (!fs || !list) return;
    state.pricing.floorSummaryOverrides ||= {};
    if (!state.build.plotSqYards || !state.build.coverage) {
      fs.style.display = 'none';
      return;
    }
    fs.style.display = '';
    let c, rows;
    try {
      c = computeQuote(state);
      rows = buildFloorSummary(state, c);
    } catch (_) {
      list.innerHTML = '<p style="font-size:11px;color:var(--muted);margin:0;">Enter pricing & build details to see floor summary.</p>';
      return;
    }
    if (!rows || !rows.length) {
      list.innerHTML = '<p style="font-size:11px;color:var(--muted);margin:0;">No floors configured.</p>';
      return;
    }
    const fsOv = state.pricing.floorSummaryOverrides;
    const html = [];
    html.push(`<div class="aov-zone"><div class="aov-zone-hdr">Floor &amp; Areas <span class="aov-rate">edit to override summary</span></div>`);
    for (const r of rows) {
      // Use _origLabel (set by buildFloorSummary when the label was overridden)
      // as the override key, otherwise current label.
      const key = r._origLabel || r.label;
      const ov  = fsOv[key] || {};
      const isTotal = !!r.isTotal;
      const hint = isTotal ? 'Total row — edits override the auto-sum' : (r.sublabel ? r.sublabel : '');
      // Each row: label input (full width) + 4 number inputs side-by-side.
      html.push(`
        <div class="fs-edit-row" data-fs-key="${escapeAttr(key)}" style="border-top:1px dashed var(--rule);padding:6px 0;${isTotal ? 'background:rgba(201,162,77,0.06);' : ''}">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <input type="text" data-fs-field="label" value="${escapeAttr(r.label)}" placeholder="${escapeAttr(key)}" title="Row label" style="flex:1 1 auto;font-size:11.5px;font-weight:600;color:var(--navy);background:#fff;">
            ${hint ? `<span style="font-size:10.5px;color:var(--muted);">${escapeHtml(hint)}</span>` : ''}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;">
            <label style="display:flex;flex-direction:column;font-size:10px;color:var(--muted);">Lift+Stair<input type="number" min="0" data-fs-field="liftStair" value="${(ov.liftStair != null && ov.liftStair !== '') ? escapeAttr(String(ov.liftStair)) : ''}" placeholder="${escapeAttr(String(r.liftStair || 0))}" style="font-size:11.5px;padding:4px 6px;"></label>
            <label style="display:flex;flex-direction:column;font-size:10px;color:var(--muted);">Covered<input type="number" min="0" data-fs-field="covered" value="${(ov.covered != null && ov.covered !== '') ? escapeAttr(String(ov.covered)) : ''}" placeholder="${escapeAttr(String(r.covered || 0))}" style="font-size:11.5px;padding:4px 6px;"></label>
            <label style="display:flex;flex-direction:column;font-size:10px;color:var(--muted);">Semi Cov<input type="number" min="0" data-fs-field="semiCovered" value="${(ov.semiCovered != null && ov.semiCovered !== '') ? escapeAttr(String(ov.semiCovered)) : ''}" placeholder="${escapeAttr(String(r.semiCovered || 0))}" style="font-size:11.5px;padding:4px 6px;"></label>
            <label style="display:flex;flex-direction:column;font-size:10px;color:var(--muted);">Open<input type="number" min="0" data-fs-field="open" value="${(ov.open != null && ov.open !== '') ? escapeAttr(String(ov.open)) : ''}" placeholder="${escapeAttr(String(r.open || 0))}" style="font-size:11.5px;padding:4px 6px;"></label>
          </div>
        </div>
      `);
    }
    html.push('</div>');
    list.innerHTML = html.join('');

    // Bind edits — both label (text) and the 4 numeric fields.
    list.querySelectorAll('.fs-edit-row').forEach(rowEl => {
      const key = rowEl.dataset.fsKey;
      const onField = (field) => (e) => {
        const v = e.target.value;
        const o = state.pricing.floorSummaryOverrides;
        o[key] ||= {};
        if (field === 'label') {
          // Empty / matches default → delete override.
          if (!v.trim() || v.trim() === key) delete o[key].label;
          else o[key].label = v;
        } else {
          const t = (typeof v === 'string') ? v.trim() : '';
          if (t === '') delete o[key][field];
          else o[key][field] = parseInt(t, 10) || 0;
        }
        // Garbage-collect empty entries so the override map stays tight.
        if (Object.keys(o[key]).length === 0) delete o[key];
        saveState(state);
      };
      rowEl.querySelectorAll('[data-fs-field]').forEach(inp => {
        const f = inp.dataset.fsField;
        inp.oninput = onField(f);
        inp.onchange = onField(f);
        // On blur, re-render so placeholders pick up new computed values
        // when overrides interact (e.g. label change updates the placeholder).
        inp.onblur = () => { renderFloorSummaryEditor(); };
      });
    });
  }

  // ---- Spec list (P3 #9: grouped by category; Phase 6.4 #9: per-row categoryGroup) ----
  // Grouping uses the top-level rowCategoryGroup() helper so form-list and
  // PDF render share the same rules.
  function renderSpecList() {
    const list = $('spec-list');
    list.innerHTML = '';
    const groups = {};
    // Phase 7C: order follows first-occurrence in state.rows, NOT a hardcoded
    // catOrder. Otherwise cloned categories ("Bathroom & Toilet (Copy)") fall
    // to the bottom — they aren't in catOrder so .concat() dumps them at the
    // end, defeating copyCategory's splice-after-source insertion. Position-
    // based ordering keeps clones contiguous with their source category.
    const sortedCats = [];
    state.rows.forEach((row, idx) => {
      const item = row._custom ? null : catalogItem(row.id);
      if (!row._custom && !item) return;
      const cat = rowCategoryGroup(row);
      if (!groups[cat]) {
        groups[cat] = [];
        sortedCats.push(cat);
      }
      groups[cat].push(idx);
    });
    state._uiCatOpen ||= {};
    for (const cat of sortedCats) {
      const isOpen = !!state._uiCatOpen[cat];
      const hdr = document.createElement('div');
      hdr.className = 'spec-cat-hdr collapsible' + (isOpen ? ' open' : '');
      // Phase 6.4 #9: inline-editable cat name + Copy button. Cat-name span
      // toggles collapse on click (data-act="toggle"); the rename ✎ button
      // enters edit mode (data-act="rename"); the ⎘ Copy button clones every
      // row in this group with catalog defaults (data-act="copy").
      // Phase 7D: ↑/↓ buttons reorder the category in state.rows. First
      // category gets ↑ disabled, last category gets ↓ disabled.
      const catIdx = sortedCats.indexOf(cat);
      const isFirst = catIdx === 0;
      const isLast = catIdx === sortedCats.length - 1;
      const upBtn = `<button type="button" class="cat-btn cat-move cat-move-up" title="Move category up" data-act="move-up"${isFirst ? ' disabled' : ''}>▲</button>`;
      const downBtn = `<button type="button" class="cat-btn cat-move cat-move-down" title="Move category down" data-act="move-down"${isLast ? ' disabled' : ''}>▼</button>`;
      hdr.innerHTML = `<span class="cat-name" data-act="toggle"><span class="chev">${isOpen ? '▾' : '▸'}</span> <span class="cat-label">${escapeHtml(cat)}</span></span><span class="cat-controls">${upBtn}${downBtn}<button type="button" class="cat-btn cat-rename" title="Rename category" data-act="rename">✎</button><button type="button" class="cat-btn cat-copy" title="Copy category — clones all items with catalog defaults" data-act="copy">⎘ Copy</button><span class="cat-count">${groups[cat].length}</span></span>`;
      hdr.style.cursor = 'pointer';
      list.appendChild(hdr);
      const body = document.createElement('div');
      body.className = 'spec-cat-body';
      body.style.display = isOpen ? '' : 'none';
      list.appendChild(body);
      hdr.addEventListener('click', (ev) => {
        const actEl = ev.target.closest('[data-act]');
        const act = actEl ? actEl.dataset.act : null;
        if (act === 'rename') {
          ev.stopPropagation();
          beginCategoryRename(hdr, cat);
          return;
        }
        if (act === 'copy') {
          ev.stopPropagation();
          copyCategory(cat, groups[cat]);
          return;
        }
        if (act === 'move-up') {
          ev.stopPropagation();
          moveCategory(cat, -1);
          return;
        }
        if (act === 'move-down') {
          ev.stopPropagation();
          moveCategory(cat, +1);
          return;
        }
        // Default (cat-name area or empty): toggle collapse.
        state._uiCatOpen[cat] = !state._uiCatOpen[cat];
        saveState(state);
        renderSpecList();
      });
      groups[cat].forEach(idx => buildSpecCard(body, idx));
    }
    const total = state.rows.length;
    let needRate = 0;
    state.rows.forEach(row => {
      const o = row.override || {};
      const hasRate = (o.brand_rate && o.brand_rate.trim())
        || (o.rate_text && o.rate_text.trim())
        || (typeof o.rate === 'number' && o.rate > 0);
      if (!hasRate) needRate++;
    });
    const counterEl = $('spec-count');
    if (total === 0) {
      counterEl.textContent = '0 items';
    } else if (needRate === 0) {
      counterEl.innerHTML = `${total} items <span class="ok">· all details set</span>`;
    } else {
      counterEl.innerHTML = `${total} items <span class="needs-rate">· ${needRate} ${needRate === 1 ? 'needs' : 'need'} details</span>`;
    }
    enableDragReorder(list);
  }

  // Phase 6.4 #9: inline-rename a category heading. Replaces the visible
  // .cat-label span with an <input>; on Enter or blur stamps `row.categoryGroup`
  // on every row in the group; on Esc reverts. The new name uniquely identifies
  // a group so two clones of "Bathroom & Toilet" can coexist with different
  // names ("Bathroom & Toilet (1st & 2nd Floor)" vs "(3rd & 4th Floor)").
  function beginCategoryRename(hdr, currentCat) {
    if (hdr.classList.contains('renaming')) return;
    hdr.classList.add('renaming');
    const labelSpan = hdr.querySelector('.cat-label');
    if (!labelSpan) { hdr.classList.remove('renaming'); return; }
    const original = labelSpan.textContent;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'cat-rename-input';
    inp.value = original;
    inp.maxLength = 80;
    labelSpan.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const next = save ? inp.value.trim() : '';
      if (save && next && next !== original) {
        // Stamp categoryGroup on every row that currently resolves to currentCat.
        state.rows.forEach((row) => {
          if (rowCategoryGroup(row) === currentCat) {
            row.categoryGroup = next;
          }
        });
        state._uiCatOpen ||= {};
        if (state._uiCatOpen[currentCat]) state._uiCatOpen[next] = true;
        delete state._uiCatOpen[currentCat];
        flush();
      } else {
        // No-op: just re-render to restore the static label.
        renderSpecList();
      }
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    inp.addEventListener('blur', () => commit(true));
    inp.addEventListener('click', (e) => e.stopPropagation());
  }

  // Phase 6.4 #9: clone every row in this category as a NEW category with
  // catalog defaults (override reset to {}). Per Varun: "Clone with default" —
  // we deliberately do NOT carry over the rep's per-row tweaks. Each cloned
  // row gets the same catalog `id` (so it pulls fresh defaults from the
  // catalog) but its own array slot, so it's independently editable.
  // The new group name auto-suffixes to avoid collisions: "X (Copy)",
  // "X (Copy 2)", etc. Rep can rename via the ✎ button.
  function copyCategory(currentCat, sourceIndices) {
    if (!sourceIndices || !sourceIndices.length) return;
    const existingGroups = new Set();
    state.rows.forEach(r => existingGroups.add(rowCategoryGroup(r)));
    let newCat = currentCat + ' (Copy)';
    let n = 2;
    while (existingGroups.has(newCat)) { newCat = currentCat + ' (Copy ' + n + ')'; n++; }
    const clones = sourceIndices.map(i => {
      const src = state.rows[i];
      const clone = { id: src.id, override: {}, categoryGroup: newCat };
      if (src._custom) {
        clone._custom = true;
        // For custom rows, label is part of the row's identity (not in
        // catalog), so preserve it. Drop everything else.
        const so = src.override || {};
        if (so.label) clone.override.label = so.label;
        clone.override.category_label = newCat;
      }
      return clone;
    });
    // Insert directly after the last source row so the new group lands next
    // to the original in scroll position.
    const insertAfter = Math.max.apply(null, sourceIndices);
    state.rows.splice(insertAfter + 1, 0, ...clones);
    state._uiCatOpen ||= {};
    state._uiCatOpen[newCat] = true;
    flush();
  }

  // Phase 6.4 #11a: sync basement-category catalog rows with the basement
  // toggle. Rep flips Basement ON => append every basement-category catalog
  // row not already present (in the default 'Basement' group, i.e. rows with
  // no categoryGroup). Rep flips OFF => remove default-group basement rows
  // only; cloned/renamed basement groups are preserved (rep created those
  // intentionally, and an automatic delete would surprise).
  function syncBasementRows() {
    const items = (CATALOG?.items || []).filter(it => it.category === 'basement'
      && it.scope.includes(state.scope === 'structure_only' ? 'structure_only' : 'full'));
    if (state.build.hasBasement) {
      const have = new Set(state.rows
        .filter(r => !r.categoryGroup || r.categoryGroup === 'Basement')
        .map(r => r.id));
      for (const it of items) {
        if (!have.has(it.id)) {
          state.rows.push({ id: it.id, override: {} });
        }
      }
    } else {
      state.rows = state.rows.filter(r => {
        const it = catalogItem(r.id);
        if (!it || it.category !== 'basement') return true;
        if (r.categoryGroup && r.categoryGroup !== 'Basement') return true; // preserve clones
        return false;
      });
    }
  }

  // Phase 7D: move a category up or down in the rendered order. Order is
  // derived from first-occurrence in state.rows (see renderSpecList / PDF
  // _byCatOrder). To swap category C with neighbor N, we re-collect both
  // groups' rows preserving their internal insertion order, then write them
  // back into the slice spanned by all (C ∪ N) indices in the new outer
  // order. This works correctly even when categories are interleaved in
  // state.rows (which can happen with custom rows or legacy quotes).
  // dir: -1 = up, +1 = down. No-op if already at boundary.
  function moveCategory(currentCat, dir) {
    if (!currentCat || (dir !== -1 && dir !== 1)) return;
    // Build the current first-occurrence order from state.rows.
    const order = [];
    const seen = new Set();
    state.rows.forEach((row) => {
      const item = row._custom ? null : catalogItem(row.id);
      if (!row._custom && !item) return;
      const cat = rowCategoryGroup(row);
      if (!seen.has(cat)) { seen.add(cat); order.push(cat); }
    });
    const idx = order.indexOf(currentCat);
    if (idx < 0) return;
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= order.length) return;
    const otherCat = order[targetIdx];
    // Collect indices for both categories, preserving insertion order.
    const idxA = [];
    const idxB = [];
    state.rows.forEach((row, i) => {
      const item = row._custom ? null : catalogItem(row.id);
      if (!row._custom && !item) return;
      const cat = rowCategoryGroup(row);
      if (cat === currentCat) idxA.push(i);
      else if (cat === otherCat) idxB.push(i);
    });
    if (!idxA.length || !idxB.length) return;
    const allIdx = idxA.concat(idxB).sort((a, b) => a - b);
    const start = allIdx[0];
    const end = allIdx[allIdx.length - 1];
    // The slice from start..end may include rows of OTHER categories
    // sandwiched between (interleaved). Preserve those intruders in their
    // original relative position so we don't accidentally reorder unrelated
    // categories. Build the new slice as: [intruders before block-1 in
    // original order] is impossible to define cleanly when sandwiched, so
    // simpler approach: collect the intruders in original order, then write
    // [block-first-in-new-order] + [block-second-in-new-order] + [intruders
    // appended at the end of the slice]. This may move intruder rows
    // slightly but preserves their relative order. The much more common
    // case is non-interleaved (after a copyCategory or normal flow), in
    // which case there are no intruders and behavior is exact.
    const blockA = idxA.map(i => state.rows[i]);
    const blockB = idxB.map(i => state.rows[i]);
    const aSet = new Set(idxA);
    const bSet = new Set(idxB);
    const intruders = [];
    for (let i = start; i <= end; i++) {
      if (!aSet.has(i) && !bSet.has(i)) intruders.push(state.rows[i]);
    }
    // dir=-1: currentCat moves up, so new order = [currentCat, otherCat]
    // dir=+1: currentCat moves down, so new order = [otherCat, currentCat]
    const newSlice = (dir === -1)
      ? blockA.concat(blockB, intruders)
      : blockB.concat(blockA, intruders);
    state.rows.splice(start, end - start + 1, ...newSlice);
    flush();
  }

  // P3 #9: build one row card and append to the list (used by renderSpecList).
  function buildSpecCard(list, idx) {
    const row = state.rows[idx];
    const item = row._custom ? null : catalogItem(row.id);
    if (!row._custom && !item) return;
    const o = row.override || {};
    const label = o.label ?? (item ? item.label : (row.id || 'Untitled'));
    const brandRate = (o.brand_rate !== undefined) ? o.brand_rate : '';
    const rate  = (o.rate !== undefined) ? o.rate : 0;
    const rateText = (o.rate_text !== undefined) ? o.rate_text : '';
    const overrideBrands = (o.brands !== undefined) ? o.brands : null;
    const brands = overrideBrands ?? [];
    const suggestedBrands = (item && Array.isArray(item.brands)) ? item.brands : [];
    const loc   = o.location || '';

    let metaHtml;
    if (brandRate && brandRate.trim()) {
      metaHtml = `<b>${escapeHtml(brandRate)}</b>`;
    } else {
      const brandMeta = brands.length
        ? escapeHtml(brands.join(' · '))
        : (suggestedBrands.length ? `<em class="suggest">suggested: ${escapeHtml(suggestedBrands.join(' · '))}</em>` : '<em class="suggest">set details</em>');
      const rateMeta = (rateText && rateText.trim())
        ? escapeHtml(rateText)
        : (rate > 0 ? fmtINR(rate) : '<em class="set-rate">Set details</em>');
      metaHtml = `${brandMeta} · ${rateMeta}`;
    }

    const isUnedited = !o || (Object.keys(o).length === 0);
    const el = document.createElement('div');
    el.className = 'spec' + (row._custom ? ' custom' : '') + (isUnedited ? ' unedited' : '');
    el.tabIndex = 0;
    el.dataset.idx = idx;
    el.draggable = true;
    el.innerHTML = `
      <span class="grip" title="drag to reorder">≡</span>
      <span class="head">
        <span class="label">${escapeHtml(label)}${loc ? ' <span class="loc">— '+escapeHtml(loc)+'</span>' : ''}</span>
        <span class="meta">${metaHtml}</span>
      </span>
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
    el.addEventListener('keydown', (ev) => {
      if (el.classList.contains('editing')) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        toggleEdit(el, idx);
      }
    });
    list.appendChild(el);
  }

  function toggleEdit(el, idx) {
    if (el.classList.contains('editing')) return;
    el.classList.add('editing');
    const row = state.rows[idx];
    const item = row._custom ? null : catalogItem(row.id);
    const o = row.override || {};
    const label = o.label ?? (item ? item.label : '');
    const desc  = o.description ?? (item ? item.description : '');
    // Phase 6.4 #11c: prepare the initial HTML for the contenteditable editor.
    // Rich descriptions are stored as sanitised HTML; legacy/plain descriptions
    // are escaped and have newlines converted to <br>.
    const descIsRich = !!(o.descriptionRich);
    const descRichInitial = descIsRich
      ? sanitizeRichText(desc)
      : escapeHtml(desc).replace(/\n/g, '<br>');
    const cat   = (o.category_label) ?? (item ? item.category_label : 'Custom');
    const loc   = o.location || '';

    // P3 #10: 3-field model — Label / Brand Name & Rate / Description.
    // Auto-populate brand_rate from catalog on first open if override has none.
    let brandRate = (o.brand_rate !== undefined) ? o.brand_rate : '';
    if (brandRate === '' && item) {
      // Compose from catalog: brands joined · rate_text or fmtINR(rate)
      const cBrands = (item.brands || []);
      const cRT = (item.rate_text || '');
      const parts = [];
      if (cBrands.length) parts.push(cBrands.join(' · '));
      if (cRT && cRT.trim()) parts.push(cRT);
      else if (item.rate > 0) parts.push(fmtINR(item.rate));
      brandRate = parts.join(' · ');
    }

    const ed = document.createElement('div');
    ed.className = 'editor';
    ed.innerHTML = `
      <div class="full"><label>Label</label><input data-f="label" value="${escapeAttr(label)}"></div>
      <div class="full"><label>Rate <span style="font-weight:400;color:var(--muted);">(rendered bold in PDF)</span></label><input data-f="brand_rate" placeholder="e.g. Rathi Steel 500FE @ ₹35,000 per bathroom" value="${escapeAttr(brandRate)}"></div>
      <div class="full">
        <label>Description</label>
        <div class="rt-toolbar" role="toolbar" aria-label="Description formatting">
          <button type="button" class="rt-btn" data-rt="bold" title="Bold (Ctrl+B)" tabindex="-1"><b>B</b></button>
          <button type="button" class="rt-btn" data-rt="italic" title="Italic (Ctrl+I)" tabindex="-1"><i>I</i></button>
          <button type="button" class="rt-btn" data-rt="underline" title="Underline (Ctrl+U)" tabindex="-1"><u>U</u></button>
        </div>
        <div data-f="description" class="rt-editor" contenteditable="true" role="textbox" aria-multiline="true" spellcheck="true">${descRichInitial}</div>
      </div>
      <div><label>Location / Room (optional)</label><input data-f="location" placeholder="e.g. Drawing Room" value="${escapeAttr(loc)}"></div>
      ${row._custom ? `<div><label>Category</label><select data-f="category_label">
        <option>Custom</option><option>Bathroom & Toilet</option><option>Kitchen</option><option>Doors, Windows & Wardrobe</option>
        <option>Flooring</option><option>Electrical Work</option><option>Water Management</option><option>Ceiling & Elevation</option>
        <option>Safety & Security</option><option>Paint & Polish</option><option>Structure</option><option>Design & Drawings</option>
        <option>General Aspects</option>
      </select></div>` : '<div></div>'}
      <div class="ed-actions"><button data-act="done" class="btn-primary">Done</button>${row._custom ? '<button data-act="delete" class="btn-danger">Delete row</button>' : ''}</div>
    `;
    el.appendChild(ed);
    if (row._custom) ed.querySelector('select[data-f="category_label"]').value = cat;
    // P3 #10: persist the auto-populated brand_rate immediately so the form preview reflects it.
    if ((o.brand_rate === undefined) && brandRate) {
      state.rows[idx].override ??= {};
      state.rows[idx].override.brand_rate = brandRate;
      saveState(state);
    }
    ed.addEventListener('input', e => {
      const f = e.target.dataset.f;
      if (!f) return;
      state.rows[idx].override ??= {};
      if (f === 'description' && e.target.classList.contains('rt-editor')) {
        // Phase 6.4 #11c: rich-text path — store sanitised HTML and flag.
        state.rows[idx].override.description = sanitizeRichText(e.target.innerHTML);
        state.rows[idx].override.descriptionRich = true;
      } else {
        state.rows[idx].override[f] = e.target.value;
      }
      saveState(state);
    });

    // Phase 6.4 #11c: B/I/U toolbar — wires document.execCommand to the active
    // rich-text editor. Mousedown (not click) so the editor doesn't lose
    // selection. Also handles Ctrl+B/I/U keyboard shortcuts inside the editor.
    const rtEditor = ed.querySelector('.rt-editor');
    const rtToolbar = ed.querySelector('.rt-toolbar');
    if (rtToolbar && rtEditor) {
      rtToolbar.addEventListener('mousedown', (ev) => {
        const btn = ev.target.closest('[data-rt]');
        if (!btn) return;
        ev.preventDefault();  // keep selection in the editor
        rtEditor.focus();
        try { document.execCommand(btn.dataset.rt, false, null); } catch (_) {}
        // Persist after the formatting tick.
        setTimeout(() => {
          state.rows[idx].override ??= {};
          state.rows[idx].override.description = sanitizeRichText(rtEditor.innerHTML);
          state.rows[idx].override.descriptionRich = true;
          saveState(state);
        }, 0);
      });
      rtEditor.addEventListener('keydown', (ev) => {
        if (!(ev.ctrlKey || ev.metaKey)) return;
        const k = ev.key.toLowerCase();
        if (k === 'b' || k === 'i' || k === 'u') {
          ev.preventDefault();
          const cmd = { b: 'bold', i: 'italic', u: 'underline' }[k];
          try { document.execCommand(cmd, false, null); } catch (_) {}
          setTimeout(() => {
            state.rows[idx].override ??= {};
            state.rows[idx].override.description = sanitizeRichText(rtEditor.innerHTML);
            state.rows[idx].override.descriptionRich = true;
            saveState(state);
          }, 0);
        }
      });
      // Block Enter from inserting <div>/<p> — keep it as <br> so output stays
      // clean and matches the legacy textarea UX.
      rtEditor.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          try { document.execCommand('insertLineBreak', false, null); } catch (_) {
            try { document.execCommand('insertHTML', false, '<br>'); } catch (_) {}
          }
        }
      });
    }
    ed.addEventListener('change', e => {
      const f = e.target.dataset.f;
      if (!f) return;
      state.rows[idx].override ??= {};
      state.rows[idx].override[f] = e.target.value;
      saveState(state);
    });

    // P1.4: helper — close current editor cleanly. Returns the saved-row idx so
    // caller can reopen an adjacent row. `restoreFocus` controls whether we re-focus
    // the spec card on close (true for Esc/Done, false when chaining to next row).
    const closeEditor = (restoreFocus) => {
      el.classList.remove('editing');
      ed.remove();
      document.removeEventListener('keydown', onEscClose);
      renderSpecList();
      if (restoreFocus) {
        // After re-render, find the same idx by data-idx and focus it.
        const card = document.querySelector('.spec[data-idx="'+idx+'"]');
        if (card) card.focus({preventScroll: true});
      }
    };

    ed.addEventListener('click', e => {
      if (e.target.dataset.act === 'done') {
        e.stopPropagation();
        closeEditor(true);
      } else if (e.target.dataset.act === 'delete') {
        e.stopPropagation();
        if (!confirm('Delete this row?')) return;
        state.rows.splice(idx,1); flush();
      }
    });

    function onEscClose(ev) {
      if (ev.key === 'Escape' && el.classList.contains('editing')) {
        ev.preventDefault();
        closeEditor(true);
      }
    }
    document.addEventListener('keydown', onEscClose);

    // P1.4: Tab nav across rows. Tab from the LAST input → save + open row N+1.
    // Shift+Tab from the FIRST input → save + open row N-1. Other Tabs do native nav.
    const tabbables = Array.from(ed.querySelectorAll('input, textarea, select, button'));
    const firstField = tabbables[0];
    const lastField  = tabbables[tabbables.length - 1];
    ed.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Tab') return;
      const goNext = !ev.shiftKey && ev.target === lastField;
      const goPrev = ev.shiftKey && ev.target === firstField;
      if (!goNext && !goPrev) return;  // let native tab handle within-panel nav
      const nextIdx = goNext ? idx + 1 : idx - 1;
      if (nextIdx < 0 || nextIdx >= state.rows.length) return; // at boundary, fall through
      ev.preventDefault();
      closeEditor(false);
      // After re-render, open the adjacent row's editor.
      const adj = document.querySelector('.spec[data-idx="'+nextIdx+'"]');
      if (adj) {
        adj.scrollIntoView({block: 'nearest', behavior: 'smooth'});
        toggleEdit(adj, nextIdx);
      }
    });

    // P3 #10: auto-focus the most-edited field. Custom rows → label first;
    // catalog rows → brand_rate first (the only thing sales typically tweaks).
    setTimeout(() => {
      const focusField = row._custom ? 'label' : 'brand_rate';
      const target = ed.querySelector('input[data-f="' + focusField + '"]');
      if (target) {
        target.focus();
        if (target.type !== 'number') target.select();
      }
      // Ensure the editor is visible on screen without snapping the page.
      el.scrollIntoView({block: 'nearest', behavior: 'smooth'});
    }, 0);
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
          override: { label: '', category_label: 'Custom' },
        });
        flush(); closePicker();
        setTimeout(() => {
          const newIdx = state.rows.length - 1;
          const card = document.querySelector('.spec[data-idx="'+newIdx+'"]');
          if (card) {
            card.scrollIntoView({block: 'nearest', behavior: 'smooth'});
            toggleEdit(card, newIdx);
          }
        }, 50);
      };
      body.appendChild(el);
      return;
    }
    // P3 #9: group catalog results by category in the picker too.
    const q = document.getElementById('picker-search').value.toLowerCase().trim();
    const filtered = (CATALOG?.items || []).filter(it => {
      if (state.scope === 'structure_only' && !it.scope.includes('structure_only')) return false;
      // Phase 6.4 #11a: Basement category items only show in picker when basement is enabled.
      if (it.category === 'basement' && !state.build.hasBasement) return false;
      if (q && !(it.label.toLowerCase().includes(q) || it.category_label.toLowerCase().includes(q))) return false;
      return true;
    });
    if (!filtered.length) {
      body.innerHTML = '<div class="item" style="color:var(--muted);"><span class="l">No matches</span><span class="r"></span></div>';
      return;
    }
    const groups = {};
    filtered.forEach(it => { (groups[it.category_label] ||= []).push(it); });
    const catOrder = [
      'Design & Drawings','Structure','Basement','Bathroom & Toilet','Kitchen','Doors, Windows & Wardrobe',
      'Flooring','Electrical Work','Water Management','Ceiling & Elevation','Safety & Security',
      'Paint & Polish','General Aspects','Custom',
    ];
    const sortedCats = catOrder.filter(c => groups[c]).concat(Object.keys(groups).filter(c => !catOrder.includes(c)));
    state._uiPickerOpen ||= {};
    // If user is searching, force-open all cats so they can see matches.
    const forceOpen = !!q;
    for (const cat of sortedCats) {
      const isOpen = forceOpen || !!state._uiPickerOpen[cat];
      const hdr = document.createElement('div');
      hdr.className = 'picker-cat-hdr collapsible' + (isOpen ? ' open' : '');
      hdr.innerHTML = `<span><span class="chev">${isOpen ? '▾' : '▸'}</span> ${escapeHtml(cat)}</span><span class="cat-count">${groups[cat].length}</span>`;
      hdr.style.cursor = 'pointer';
      body.appendChild(hdr);
      const inner = document.createElement('div');
      inner.className = 'picker-cat-body';
      inner.style.display = isOpen ? '' : 'none';
      body.appendChild(inner);
      hdr.onclick = () => {
        state._uiPickerOpen[cat] = !state._uiPickerOpen[cat];
        saveState(state);
        renderPicker();
      };
      for (const it of groups[cat]) {
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
        inner.appendChild(el);
      }
    }
  }

  // ---- Download PDF ----
  // P1.6: filename via Content-Disposition (server computes from customer_last + date).
  // P1.7: empty-row guard + no-rate confirmation modal.
  async function downloadPdf() {
    // P1.7: refuse if zero rows (button should already be disabled, but defense in depth).
    if (!state.rows.length) {
      toast('Add at least one spec line item to download.', 'warn');
      return;
    }
    // P3 #10: warn if any row has no brand_rate (or legacy rate) set.
    const noRate = state.rows.filter(r => {
      const o = r.override || {};
      const has = (o.brand_rate && o.brand_rate.trim())
        || (o.rate_text && o.rate_text.trim())
        || (typeof o.rate === 'number' && o.rate > 0);
      return !has;
    }).length;
    if (noRate > 0) {
      const proceed = await qbConfirmNoRate(noRate);
      if (!proceed) return;
    }
    const btn = document.getElementById('dl');
    btn.disabled = true; btn.textContent = 'Building PDF…';
    try {
      const iframe = document.getElementById('preview');
      const doc = iframe.contentDocument;
      const html = '<!doctype html>' + doc.documentElement.outerHTML;
      // Derive last name (final whitespace-separated token of customer.name) for filename.
      const fullName = (state.customer.name || '').trim();
      const lastName = fullName ? fullName.split(/\s+/).pop() : '';
      const dateStr  = (state.createdAt || new Date().toISOString().slice(0,10));
      const qs = new URLSearchParams({
        customer_last: lastName,
        date: dateStr,
      }).toString();
      const r = await fetch('/pdf?' + qs, {
        method: 'POST', headers: { 'Content-Type': 'text/html' }, body: html,
      });
      if (!r.ok) {
        const t = await r.text();
        alert('PDF render failed:\n' + t.slice(0,400));
        return;
      }
      // Read filename from Content-Disposition (P1.6).
      const cd = r.headers.get('Content-Disposition') || '';
      const m = /filename="([^"]+)"/i.exec(cd);
      const fname = m ? m[1] : ('ZuildUp_Quote_' + (lastName || 'Untitled') + '_' + dateStr + '.pdf');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('PDF render error: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Download PDF';
      // P1.7: re-evaluate disabled state (rows may have changed mid-render).
      try { applyValidation(); } catch(_) {}
    }
  }

  // P1.7: confirmation modal — resolves true if user clicks Continue.
  function qbConfirmNoRate(n) {
    return new Promise(resolve => {
      let modal = document.getElementById('qb-norate-modal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'qb-norate-modal';
        modal.className = 'qb-modal';
        modal.innerHTML = `
          <div class="panel">
            <header><h3>Some rows have no rate set</h3></header>
            <div class="body">
              <p style="margin:0 0 6px;font-size:13px;"><span id="qb-norate-n"></span> have no rate set.</p>
              <p style="margin:0;font-size:12px;color:var(--muted);">The PDF will show "Set rate" placeholders for those rows. Continue anyway?</p>
            </div>
            <footer>
              <button id="qb-norate-cancel">Cancel</button>
              <button id="qb-norate-continue" class="btn-primary">Continue</button>
            </footer>
          </div>`;
        document.body.appendChild(modal);
      }
      modal.querySelector('#qb-norate-n').textContent =
        n === 1 ? '1 row has no rate set' : (n + ' rows have no rate set');
      const cleanup = (val) => {
        modal.classList.remove('open');
        modal.querySelector('#qb-norate-cancel').onclick = null;
        modal.querySelector('#qb-norate-continue').onclick = null;
        resolve(val);
      };
      modal.querySelector('#qb-norate-cancel').onclick   = () => cleanup(false);
      modal.querySelector('#qb-norate-continue').onclick = () => cleanup(true);
      modal.classList.add('open');
    });
  }

  renderSpecList();
  renderAreaOverridesPanel();
  renderItemRatesPanel();
  // Phase 7E-C Item 11: render floor-summary editor on initial paint.
  renderFloorSummaryEditor();
  renderBpfPanel();
}
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

  // Phase 6.4 #9: group rows via the shared rowCategoryGroup() helper so the
  // PDF respects rep-set categoryGroup (Copy Category + inline rename).
  // Falls back to override.category_label / item.category_label / 'Custom'.
  const byCat = {};
  const _byCatOrder = [];  // Phase 7C: first-occurrence cat order so clones stay next to source.
  for (const row of state.rows) {
    const it = row._custom ? null : catalogItem(row.id);
    const cat = rowCategoryGroup(row);
    if (!byCat[cat]) { byCat[cat] = []; _byCatOrder.push(cat); }
    byCat[cat].push({ row, item: it });
  }
  // Phase 7C: order follows first-occurrence in state.rows so clones stay
  // contiguous with their source category in the PDF too. _byCatOrder is
  // built when byCat is assembled; if absent (defensive), fall back to key
  // order which still respects insertion order in modern JS.
  const sortedCats = (typeof _byCatOrder !== 'undefined' && _byCatOrder.length)
    ? _byCatOrder.slice()
    : Object.keys(byCat);

  // P3 #8: notes/caveats now render at the bottom of the cost page (10-12 lines max);
  // the standalone notes page is removed.
  let html = `
${quoteCss()}
${renderCover(state, customer, showCustomer)}
${about ? renderAboutPage(state, about) : ''}
${renderAreaPage(state, c)}
${renderCostPage(state, c)}
${renderSpecPages(state, sortedCats, byCat)}
`;
  // P1.6: inject DRAFT watermark <div> as a real DOM node into every .pg
  // when state.draft === true. Real DOM nodes (not CSS ::after) so the text
  // appears in the printed PDF's text layer and QC tools can detect it via
  // pdftotext/PyMuPDF extraction.
  if (state.draft) {
    html = html.replace(/<\/section>/g, '<div class="draft-watermark">DRAFT</div></section>');
  }
  return html;
}

function quoteCss() {
  return `
<style>
  /* P3 #5 + P3 v2.2: fonts embedded directly as base64 woff2 so the PDF
     never depends on network. Variable-font woff2 ~85KB total. The @import
     stays as a fallback for the form-page preview when on a fast network. */
@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url(data:font/woff2;base64,d09GMgABAAAAAOf8ABQAAAAB1aQAAOeIAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGoItG59yHIFUP0hWQVKLaQZgP1NUQVSCRCdQAIgkLzgRCAqB7niBxhYLhgwAMITCcAE2AiQDjA4EIAWHBAegDwwHW9u8cUK2OaVDwd02gKn6ft6y8Qpl265YoNsgOixVzKKIAm4MvduBEuj/3lT2//9vSDZizAP1AP5N0zTNtqrVBCmMqkeW2p+GAYkczxMykWkFsyEvCEagEAW+jCv667bLola2P1Jbml7FCuK237ZMeMaGAOHHVcwGn08VxBrzipGIKQIVFGec7ywehqF4v1129ENFvafyI37FrDwUF8QkXISrXLXSZGxhYTduT7zeb+kOo3Ra05e8KJPB2ll3OQgegrCnwyXdjIIyTBA0SppXR4jjhvQjRyVP2l/9gB/hWLRgU+vEt7l1j03/Yd3jV6W+6Y9DPFtcBThOPsSGyHbU8+f5bf65L4gSnopRqAhWYuVQrAJn9WQzcn8Wuu3rMl126iqNtQywzf6xCEWEVkoQkTDArIXb3Xa5u3sZPyLv+BGVVy8uetvNDQfzer4kTZoUnBQDPfDDC/LMy2k9C+lsfkFPo3KmygDNrbvFbc2gN8bGYMCoEOkdoFj1bXyk9ssH+j4xFLCISpNUKpWo3qBHjBE36JYlHZMXO/MAd1ATCVBRz9u0/Wg61XVCvp3kCc2FrRwrd9MCSkrwY/L88//7he5z/8wESSXCxKUoy7aOHKJC1NU1osuXhQE2vhYfz/Pcu09Q97zG3ILL80AiDIga4N31z3FjISVaWigqhMSurbZKhDYlI2OfFWXsc9wd5zY39vz//m1/3fjnxvzr1hzATftPfernvjNpgMrm771vZkDw4AkQISSBECC4lSItVGy1zTs70387H3g3q0+pT8duduRMpHN3z1z+VnKqs+PSOq0DBYJYRElCiDgJGsRapq/Nvkf+ELHRJAwxJWJAgNBAtwMtiGvEJlvFit5Ej6J6+6a6vEHdCjhHX3w2ke3uk6YtJyaFLOlKV1QCPRP9R4b5h/+u7P8Uu9pDhEtl17O6IL+e0ekFmIUwISeTUVslnqo6BxmbRldOCAJYc7c55vVDIi/iCWLnJjFjmibeEBcTTyqPI5GCTSIDm0S08sIvLxDRiJ48WOQkXCk8D7Vpk5rbyeiqXM1uu4c7U3OLOQS1BAaPQERbf3/eud7elz2j/kCR/uCmmNT8LJHf822PcuOEjyDtMaXJCOR4/uHa9wboA9VWcOJaYiRlAH+cAKIFvgd6ae2dZLNHvwDoyqoS0Mp7XavqTcPDl02j6R7UyLJsy5bXi+gDpCC7uiieXh0ARcwRUUbE+x/Pf43xe99DdkRUt5MIJTKdtvcM6NQqp+X0CpzWoQI5YQOxLMuybJHF/AQ8/Qg8/rADThzfBRCAMrgvoAA5kRoQQRG6FWv6DMJFqAgXo4BYZXKhbfluKkyFqXA/3dRZQWBzer/sP+4KADCAg5HbIz2TVNvWZQC4nR4srJt639IGZ+cMWHN8A7fhcX4NVIn6//1Us32Xmz4oefJhZXlf2R7smZNHK8unWTSS7OzVtlXZixLAJ0X8/0kbAqUxFmnyAZGZD0KyHwBx8gFI3ijJKzWLZtuWhw9x/AhI9hNpeWApCy3Nwuz7rtLpJt2kS5l0nhTVsixdnaJMqi5l6nT5eZ3m+mXFjnKETjEpw24f4tapnTss0n9f/pa+ARvZTi50BD4E5VsGCh3yVN6AYOvUm9abyuOc2zJeO13XtX7/+/2+st/GbMCbnoiFxiIS0zVk3mB2kC5m39Nf/bfglkyupild/d7+3P+7azxygtyV0gC0aOoCHGiAIq3k+6Jzk2tlKa0jJ+jHKAQHtcIqJCGAxf//pSZ99/35b/THTdLWMVoHhiDJ+WlVyxIEVF0kebylFNko6Uqpz+6TVq10mG6Aku4TtBiEA5stDPTm1GiHHP+gRDJFOclN0tbptOu7oh9jwZYljxwCH8H3bflWehKEfPojl9tNEoVgDLIvp5nbnLYWoo3q/a021zHvXB6DDCIiRkQ6pjFmk3+fw36tPgxsd61mr6Nu8QCUW6HUJL/eb86DKsit7lkOA4YxxEPAEv792LsyDzInPtf2q1+nhiwQGAir1aXmioC50vO6Vjn3ituAxVFHGGFKIIFHAQQ4bJgSANwPg/kUsBmWFQxZgDQ5BFjmRKyAxWnWJ6mAXfEC5llVboazclmTXOKDjJXKuPYK6my3XNB1y6lI56amxiIpXEUeQptlhuf0lX7vvwfWB/za7kGekMIB9M6rAQDTFlQAWoxmYjcid9h6yNVrcEWRTSC5Lg18Vyjt9fH40MWzhWNTDrshzkMAPT/W84rp1tdj3Lm4CAIOEDKtCXAcIMrQbiJkWSDmbhJxH+cEPPWjzTLgAXFa/zG0pOLJehkwHgxGiEYdHXtRLvjvzWoWAbgHTzYxw9ninJrnRdRHc1woQXkcR/NyQ1+ckb4jNVflbPHLtb9FuXZtLIz/3QJs0GZAJnVanOGcK/1x7McKkrFcWNsTjxaOJNaxzs3c32TZZ7jsO7SrUXMpTk6VaWOEUnmgh7S8eeM32LZ/9oDl6dYv+7OtaZ85GmN+WHn2VieLvdI941SnNr0cxn7cD/uuReYRJ+/GZ1+3QctFLlp7Hjr932EfJUeQvV+sl++mnWODXLfNnNXdxF5rYwtlYWXidNyrwjpnphXLWx6LWBTGcepTF2HPKS0fuZ9pgN1VtANLPS7TlmatHQ0Ksyo/U3kG7XZjDthFsD6K1YhbWC7HWJuTcP+qsO4uvW9y2BGbaVslZPTPlq+Sky4KuXRCDh++Y35QDoHnWot522qE8w7r/ugGtjEU25Nt5QumhTvzBZAehI5sbZB3uIVYpv3ya0Xn723rOdbc85dZ20f4wzh5vSbWBWTUrg5LnNQj1J8rsFe/l6N+NmeFzwLA+ljHfste24+70ZUwjPWc5lQej4ce4tHbZcbV+1jnJY91Eoev2RYxYAEeHwUw2hgIqtTK5noN6NCERSb853P/e7/KfMpPa1/whxhdITTeVAg47QC/EwC8HAHLdA7AygEIQ0kGQhta0ppGxoUCWoBRjgGQIM+k0JySDB3VaizUA3MWAUiSQSFNaGz6UGzIgV8OwKIB+AOosunuwGcBGEK6mQFyAMXJJi3BkDPqjjhNEwCzCBgYHbIoMsMQuWaLUcBqALQ3phhNjIQYyAG0p2gx9Rh4CXkauEzCetw8DmMssFgNQQ2E7ymCoF5waFhkQKNxlW/Wcexwp//h0GUO/FyLTBZbo2unRX0ftQt+txMtOen837ngGg5cdxvfnz3DgOd6CZz0Hhc++IxykdsT+CaCoV8QDIgCg2LBkCjwUxD8Egp/hNsWBP8Ew7AooH0YgXDEBBKxkEnnIcg0SxiySkq1yDbnPhdsQsc1WSXehfnwEl0+KaX8vKpiLFRSBR2krgEdNdaOjTSNpysI/upFigkO1cRp0E9pFU8RDAMGvt6MhBbdhAuTSYIbAPiz1zH1MVtQPmMX1CW/owGNKKAhUDBJ12WxoN809ajT76gR0kLnsBg6CCEMdPjLGEBHTMQDAukggRiiMhHWEPRxMQzZJIUqyQASD3MlxC2ZGPKewr745ON9C7TSoMIuKkx9MikkIutdxgKgZwEACfGsnAaKL9nquRde6kVD49bzSNJ8xxa2si3VPia0UmpYqNFsUJrgWP7HcWxmC1vZlmoPP0FXNG3M0WQikNCiTTHUywBgD1szDCVhcAAXDhaVCkpZGELfhvDAQEQ86arm1fgcyv/DQAKPTZKk+RRUcCGFFlZueeVXUGFFFcOAGJcBA0mHRhHbey4Hs/I0bkqL9WwUpsNy+vEhMYDHy4twD/65QmvPpLAEIkDF2ksKBCE+DHSQVZYZiSJZVKQ+OCgtIjpiIN3yk4WQa4aZJck0NjIvyHsxkQdAPCkYhfVi07I30ddqdJiRTfLs4qGOArzD//l6tXYLzQKmP1qTQ25eZbbF5uQ3LTHZJNNz8Bbzdb/WBYy5r+nKnWemHktzYmT1xOvEBRaOQoORRRzTDyPoAXpkICPgQ+I1Oy9y4Q5FYrdQqtkB3C0QBHJKqOckcbGeyUtGFDhb0DDEnxlm1/kZgJyzTS9RxjkWgQY40s8/v5Ylnv1VTMRFNFB3OwBZ2oxmLbogB3mLlCh0DUn65GcNgI24A5NQcQjnRIgRdjLhbuhu5iqZvKmd7WquB82FE1uDkDCvOFoz5X7D+mNsAl5UbLA6vMD3SpGS+EZhSYW3ss6x6o5UxptfH2m79OM/f/4DNfOn3M3//w+SXPzQ9ie+5Md4CX/soFi6/of2itF3jhZ4tuJokc9rj5YF+ytKC3z0f5yPK4/KQl336+wt+nELVS0jiNO1MxFliSHqDMcUO4wilhgn/9nI2EAWotnHwDXW32ILU//Eary8EZm28F+s2rzPbI73L0g+7tF5Jfx97CrxN6QO/z72jv/dhmhc+i9uG/7sKEDH9Rnm+YcR3IsPIWQYfgchI3IKwrjzVFh29fTMZPMbo2jqJxBLuG9B7LHelYy4Ph/xefYkCMkcI2GNPyO3a/0R5zn4zahU/KejMtAf8Kho+wdv8Ss8BvsDXBXt/xLd/+moSvPruIr7SmSf+g3cFBKInwn4Jm6C/B15LuJLuO1O/njkPEauAw8AENAAAgCghg+qp6WfwUJWnpP2439/RCP185tG/72obhT8ElvE/hJbxPZKysGnJ//Qs1fZIO5X6R8snn4GMb9BD2HfUfjT9nuIB6uPCj/2P92N9H+4F+l/FIsMP0ZAxh/fRbqf7eL7PxtEUp/r4OEXT89EXzVHDl8/wjd+vTuy/+YQ3//dhSMH+AAAAEAH4Pv+N8Vog68Xfhp/gTyykxdHvrclyK7nL49iDksQ/pXTo/gPbyM3P2MVueVV10HPfP1TtJkdFT4756fc2w+QZ7y54Kfj938edbznM+Rlb5wdTf6ZPJryvC+RV/9MHM167D/uef3XyHv+2SrL/tbxTdUshrSkzwF9QrB64feBkfDzo6IOA0fJr1yjRPDoQalf7nPqK1Ff921c6o8oTBAHf98LztbQpyfdLHX1jU9GNvaTCJD97PyKYOUrjWMRAPxNVBYkwgA1Pp1tihBgyvsFVoQD/gtRvUREBsIw4AmX7bfaDM3KpArhKCkIBGDI8DPkbdC2JHt9DSSE2lMYYLcgDx+fFgHOQ0eVgx0OYJOWiVQWptqIBkIGIQwx0Awrh+EUlYYcE3CeYRckoMguYuh7Gm6HdG22kesLAIjyOlAvmxEUWFZsf8vUQT5klOnOQV8xWz86hlrOlavFaUHqB3r1+nfzO70Vh8en59N83z+HXx+3RU+61usu/5AHHnxu8fopWXzT0Icq2Pg4MiFA52CY4P/50CwECQEUY8tzLaqkWpverFa0vcs97E0fxmScxmO8J2MOzuE5N082hBM4w/yY+RnzK8oqGnpGVnZuBJSy6eUpUa8NwsHlmyj5hYsvgQQTTiLpFFL+j4DKqwNyL7rU1svb1uke9Lr3/R69cT11HwgCjoenE3PS/KKSqOsaWtq64hHLomNSpJaDlc7PX80THuJqPqWpRLiiPaktqLZ3+2CfD5VvTBxs8/iHB921e/Q/Ctif6Sfr5DNZldngFuX52ryiZ48ZcuaUS2HQlTboheqs++pEj1zEqvVm+69UR/jTuLO+DLXrk0bNWrXr1K1Xv1GLlq0yeSOBk8aw46JeHDYcHth5hLP/d7eDtD6jA14novFIJqKYgKyLjCpiCykzUIBgQKnSk2fD5MCCYSOoI2n4BxvW0OdmgKbLywjXf9i3njEfE5/ZyJTAXICZIAv/ZMtO1pLsxdn4W+uOOKnQUfmcVbug3pdqXfLZN5p8p9U1zS7rdF2739y36Xf3DLmvzx2j/tbjljH/mPTAjEfmy/JK4B1P0L+QqLaj9gn4a8GThtU/RetRfwmnZsw5XnCaX3DCef8/re1Zk8kxUeLCw9CTdkQRFzUuqvOFXrf1u6vFVR3+UO6MD06ocNYcdycc44uqG42OLCs6CxVGinAcFC4nTR6GQg4JsxRxWIKtKDt5xxQ7rsxppU5p8JVPvtbmikbf6nJDt5sG/WmYqwluxv1rykPLHlf3HxHPOjzM+p+1l71JzN5rROx0AeDrhtEDAG9d03WUnBF4jFd2lF9WKtwoCGfqXFie/smdhB/X0Emy+Eyy/VrifRpjnPzQU2Usgk3EIc+RPtAbjQBcQZKGw44JqIs9ita2DIEnM0LIlZ9+YFicFjc57hEqcoO0ORJftsBOxym1Nvw6x1xXUMaRgjJpDBQXcHqmGuRGB07uANT0cEARcDlsBRDL6av6uYacYEe2sHlcqzxnNW7gaLrHrmh3yQYu283zeU3OFygcy2WzOROtoDmOM3OZ7NNIaBfHWWvZaCFaJlPjii1BsROGEUfgCkmadXPJG4PFMR0EZvEeDKmSLdJA4woWnyBhGAcOK/GmhsQFOb6IEKczchzLyhgaT8kpleHZl6HwrRkmmRQl5UyYalaPDMqJeNg0sS7WwGia4Ztgf4gPz/Fmmc2sSHdJhzrH6a4gx+PZNGoihMngOCUpLdN1+Dy/OOSiRTyzPMWk1YdQ6j8OnzY1GrC+zgD1HJEo4ACCCDfmOioee5sZ4xANHIsPCCU04TElWtwMA9wdCeWU1/xGCKa3Mq5FESNK+Yj/3kJ8M00soX5R6hucqodzNcn42JuEilglAPGWTmeN2lfPcWBVPPNCJtAG5p/v0ir9o98A8vmOQmxqJG1CZJL2rOcKk07aqIE6lm3ORwnti4Pz5liw2sYnF1+JVgK6/fg4Npk+/DUPY6qeCTeRdbPBJuLxOUoqfnGKjZ4SiXh+vY14+mYb6Gz9jwL4Mln++gGqmc+LBTKKQxLb0SdCUHdakRQEcc92BGUmRVOGTz6F1TDhTIumXTD5jfgvhPDbgMIqsI3wtoI6OP9dnRTTUAl1y6Wqf+ZP6vXztvDXwHQrvNRou7GqZqDKRfVtE6tiiwnizlhlBH9vzuRrYCs0NEmZYKhMI5vxFGBnDIc2ZzylNJ7rQ9yzChgvZHHbGQnxKeL+fuKfiHdlfgFgwEjsInd8OJLjn6O0aCih3LQxOllbfNKZG3MdaCIVy/TW9zNGMSaQJeYqr+/W/2NPXp1ugnRvInAgWeQnR5DKNaNM0qq4tvPUQHtod7Zy9Ir41TbAvHWzPUTo+sf7aiMT9Yx0sGU5BBz5ZQI3/6NPl3E96DKhvEvcdlGOOxss5Xsr6kV7dvPybiFMjWIIQZm6ouUCtLz7+AHOl0kWRYg1GTcNEKUxw47AyVVGGwypUu9nO1B3+Xkf2j/kJ3M+Y6ThTu/pjA+3U8tgIKpdZPLVbRXgQoWCPOSw6ztTLfLg1OfJFDXxfZ9SaM8PKswsRtswKDjTQGdyXB3zmv18SzMocEPaYwLYLg1ydTocR/AmctSFcSFuhOFEIGmL6MzrrTZWbB7cLLhu+sqnhpgaUDdktvq3Rs5RuRvfrlO1NYME5phurNgfcCZoOaxvrBYShloh6Q+RENg2UZzacNqU8rqJwNlRAQqWoCqoDaig0EZsDmfRvLMYoUkFLOVArKQrGWMnLuhj2QwVGoGlCzXq+sjiZ/mo4iPsgiHp16WRImnIL64B2ZKWBhKuoHTD4CkqA6OgHpmQAbQiUkNBmQL56V2P64ntQlzZFrryyTpq4BSGycc//4yzrROOdfwptnVlrJjosbRCJL6rObsVyglVPG7JX2UOWDbxLNdmLGIHXLvhHN8BIF/Ny3l3atLE+fjD7WWn/RuOuJcPr7fxcNf1RQOVsVBH5UWUerH03BRnkjpTdIxhkqg5L0v07jlhKPhgDc9cwshYAFC5uCJBUN2Vraq5t6ltFGuv41COdqXF64qWV9W4fAitaF3cdlQsj23BEqek7MzXwWbJUsyu1pU16Of6GIbpWNRzVoC1Ck8TZbk6TDIQ/x3q/L8yZfx5KnlcuWz/kstQnYD0ixHdkocqglJgcWVE5LGXj7CpjkAidV4KiFl5z+YI+dq5eTAMpQmtxSqQMUpqI9fO7zUKfBz2MuF3glw1mGXJqeRZyXUVzgw/kbuRG685y0OEGKuYXCsn2yS0NLkkfZDpZIzG35/BjnAdoj1KW5ZfT0BKdSspTHdqJScvaqtNp/Qm9+bK+3Teap5Y6MdW0lAu3C12kjlQBPP71dWROlaBGI55StMtqbd8Hof/CRma71WMNQ/Wztpj77j7DTOf1IvGdOpzMp3TS1rdU1Z10C7f8/mg02TVTDfJ0PrSL46AgLMSgWicy8fVQRcZzwcrXD7GfUZPHcsIx/MDA5JhfsKr0fGx0y3SUhqD6FTOQiQZewHdmojKqkV8D82oem/8B1DIZvZr7W1mMkvgM5az/3vK9ss5pi9/Rf8P8sG9SS1DDmxa8cQYIkmeNx8gnjQUv+n63Hsr20SC4zZ0OrDa2gQEtfdUD6M77kHxxwogc5VzZlp24KSoCIYUhod8xMZs3h5zIbxjcFHP5RVS31A58jI3/oxv8BjqJiLcQH8FQ0yzh7aMtCv7hS7VkwBLKCrWQUoYBiYRBjJkpeBg62BCuebVPT2wP4hIV7F5fH3+U2TIOWVAUNkYZCemiYSf9ulgINTbJUF58NEhuVQazPvjUF8kuA6B5Smzr597qFYfOJJs1dLwIbgLnTKdVl5nfTmqGGCwE8Ripml74Ycc9YjSUzOo/tCEt0ShX0c76iO5KPYK2pTilCSujqE8FmVQu9IhQmoE+7TYkkAcv/gdcPA/8aDeU5XjpiLhSgxlcjlb8qX6YopXHFRKQTPKJz17q4UWXy5lCUMaYp2VZQ+7kzTPxco6y8Hz0LCmJhKcK3lJxlsK90EkKxEHQ3YFwmPuwU9iINsDNxCwXHS4XCLQUot9L2EZ2IG0Y81Owo+L2x7PveYXgnf6R/NHwVlJ6zu9cWeBGge28mUWMKk72M3LUKvARgJaxrQsqhmkE3p0vyGo66R7WyAs/bmJUtFqDPXXr62n/V+U9ow24lB9/79yKkkisQ95T+CpcKuzA4Vwd1mNNFLdhfraiJ5+R2lb7AiOUBsfLqNAVZwaRNDZpLfmXTUsueikoalBUo/l3E4v9JrdRgtWLaznU8HDbj6K9LQ8I772vO24mxEq8tRSf+/ePnqW66559VjszTn7E6zpOaMU+YG0KaKUkb8/yB9UFNCS1Q5cB041FQZQNSocnXKVXRULHwpdyVfWAs8kdTCckkQuJdQz5BVBh3okp1pgQ0jVAyuK/XJYXdIzEBxA5AfniKfRbHfSEu1JuLS3S6yJCDcww7KIM/alZId+uBhLpmhIYsytK83/b4djKyGzqPz+MsZ94tJ8kXF8VTdGaeM6Kf3euws+i73qqEYosMwiivkVolrTfS3/8b8pYXqr5LwteDvVkDZTdfCdqlx1uChZV98AiRJBDx8QIEER9bHmbErhQFGBln9w+rtrTrcQtsxPCHusAYw8uKvu6HUT/PfB0lOtnBEEaLOYq+xRXLHx9Lrk+GSJMvtw/2aPnIrKPPP52bY1ZSo2Qrch9BO3WYYCXDZYHKANmp4P8rwDVCb2uJQ+hKlLDvYdQGR67aAuHYRmLoTw4Q4cAmfqJBSdPQv78BAQQ45lH06IYtiJ0HneVYDOBteNpVnbk5q9JgNqIR6Gj/bav9FnkvBYLgS6umOA+rbQoz4GOxMnt0/Eh3+SE+/eJRqcKsFkI/dht82+upIU7a70IMEnBP8EmF64Zbey6ln3Rf0kLGEadNaYwq6oeh2BWCVbDd1oF8vdcGdB3a3tCOGusarVbW4gtN32RlHSnIOA5N/UtVjKhh1lLuq9EpyF0b8d75TJGkQ9JVH4oPCrspwRAmx6EmJdHdi7P/fpuJJH2uRbhS7gfxoWpZwRq34/kmaA0Ozy39LrSB/4wuvrSPuEOgOoo/UuezTQWms+0J1tAJKxL67svDgr25I5uu5ffLZQbKrs2nA1VFOi+jo4Gi/mmLe0qw9R502RdxErm/L5gwSFZzOU6KAYG3/NmxtlHGYkYmU+LvxX49unG4rmDtsQLKWPaMZlUDM1CDHEERet0TNlvSgyXGc94apn9b3NvG53ke49o+SUSPOUGRTs7xhJaX6Z96FbVQEbdhsIvT2To2L3yUKYx81DRxygvyyHjwMi4pQJ1O/UDTzAGiKhvkWIhPZmXeyOnpV9NxCQ3lcuWmwJAqoyPdL3IXIs5TLeqLqCPF6uzc6eK58r6g9I4e45U0Iby7iEOfBRFY5n2JfSktNN0qaET8z5yE4TSxc3z0DwLkmsjMZyzNXcDBFXG+52ZWT/xENKXSPDnooPz1YBLdgl8FHe2EFmPVxNdN61q3TYKXmzbrXRRWfY5yIv+0DkHlM5OUKVu2dd0d7RFbMt6vtvZT2YqaU+VsH9/1z+56ciraDDMWsXoF1kBmkYDZU2id2j9VO93f2NhyOOmWGYIbKTPIRBtBb0dP4JirJCWAHHsGUI9DDZm+JCw1aOfR9zu+tjvrpc9s2ydc+b5x4rPAqo1wzKFGNjjj/Fk/7iHdwl/HXNda+jn7+XzNGWo7kYGEpaHADzWvObsR94alA7FVlT53JFcwXlXJkz5HDVibzve91r8rcVxFq9auvMyUAmOyZKO9oPOwrrH9VGxWCGyMUHycW/Xayj1h/ZFcjecOcXx+FntrQuq/yvfQHR9y2LB+Va6sv4CTqAKZxPDwqBcAe1MNofEj9X6KVDlFn/EkJA0fCtuzFD5NfOO5h4yo1ZKsNx/YvELlCoVJQrpqt8aR1/Jf0cFy4qD7M64ur+DX4n+b7mCvP9I1M09lQYkjyMZuZ7TyDjJIFoIWJNqNNQ/0VycgVOuW6addcprc6GBPv8sxeY9sV5DWgxBlHnpaltdQ1GCQtHFsinln/Wc9Y/KYYl2yag931pz47OY+EBi8jTnWahYCuX5dPrYMCG57K5svmjX2u6tFEx6GFyMguXlEmkDgxhni66VsLo4KNYby/Avic3IYsKHwBt//8ZZmOopazRoCquLMyKJkZHLY2KDMtKtoX1ml/D8/cdfXLa8siynMO8JTcqwWTCNEBE4McHF63FlpSfx7zg23Dopkb8vbtnamS2QsIdVrS75Up/+tEVH7wtH4YeJtPIwxh4RfAodHpTwlwjp6xj/zCM12YQymA6YuD9r2+vToaWBkloUhRXHihh9UyLYRodWW82vH97gTGVAQr7M/9cAOv6vZkKPnuISLEwju16/6sDcqJW+4JJufevVpB0aq0VcPQIOYwyjIbnXSp+yOB7rBppJcLEyQjRppCA+auvw/Z6N/p6nNrLd4s4NotigGknE8guNPq/nhP/nAnyCE8Wpn/RLhxCctSOZGFUgAwICkc7d9J3DqGjRzRnuX4vgn8bPG3RTdO1GMSlEUOHiRV9CTt1se+EijEqZohEJw9hokY1Z7j+z4hX/JNUg4vA6GF8O4vmMxVAHB/oyzTFTKcrFgLUweVvIQWnzpVQm0bzZh9r8C7Zsr1c8/RXB2LPj4mhgOC+doPFEBWTyg/syV8E6PyXIKA703c5fWRlfglYo/bLAMUlWbyVaDzQtHaEO9ep0dnaWyRb36PXEPz1sl+OGjZnflCN23FnB3K8fLfe/JeCyUb9/Vn0X3KE98XPB9UEF4FPmXHNCDbCz9/EV0DRFbZYVeKmFwhiYHJVVUt1ZIrSLOZHhPP72H3EMcqRZuWhlpbGi8+qlyrKEWnIAJj9Kg5z8GNm5PDIHLidV3DLwoWLErkytZpLJqV2i3oiRqIPOBSbK+tbLv5XDbA9tSvDGF5BxtTvb/jimlNB78mAX72yRRAdFuXeAO6Eo4auu4eTMLoT7jJu5JD+Cav7Y83T71TjZIYXiCKLAv/zVndfKMAtLBYHVxAWo9FU0cEWHDOG8BeHKPZuabjiVnPxMts+4aceWR+PDCLKCowspueneiehFxMa4k8lgZldbXYkFp7oVmK9yTVUpevgC1w5fA8VsHKZy329zeKx4SAihoHIRjIwRIhu0Ed5a6hymUNmIBTtJIWRnejwE3M60n72frgyzJLiOoQZIhHIToxfzpVjF6lMEMvzVPGhBlTmQC6iPkg/Dqq4dc1phnN5ItQH8JvGv3n0UM2RW9741Z1mUNTj6/rsRwsUSUDcix2ukf7jvrHHbVs0qmiRLW4+sREjL5bqz8hbwA9plIAFbwoMypuvhS7j8ypZ9DGEX7zxfvK1EDdyrIB47++U3A0vc/TD5ODUyJQcFB/Ju8EdCl5RKZDsxYrzRjvbB7HRPvNNnfbuCMtjJmVguUqceAgUOQ6ZV+oCWRcx8PdUppcTssnDgMKA0S6//yZq9+Hh+b7FqvLswuxMMZdV4/wvY9+tK4t87oGJEBCz0/J8DugtmJxiaGLrSnq1pkVdH1aOJ2R4HeWoRQIoNZaRxKCzwlChp/xk4bz9kvzezV0A88a20+U2gzbHJMEwaUIy/kxQgaJSOtYlzWRYAsiXrvMgUpSmetlN7ZTR17VTfxuM6Xzz+as5XecVFT1ARMiuvz5jWES6PATiP5Z0N936QQBlinCYuPOJpjwJgkwh/mCXGNk3kONtb5/6Bi/YY2HmFwkozLSYiHAeO3i4vpTYyUumxGYJiUoeW9U9ufpZzZG6oklg7rVBLhLz0/Lnens2xRVG4CswBYr94xv7WYWopOqcsXbZpHb66BteSsv/Hz//buyquXQb/R/4dpdtbiV/sY8n9Wpl4LT1VpzsmPgk+ThtKajec6rqOgzaZoRkr6jJkvmezQja67H4mxzt23wBU3pu2dfqkpOsrIdaWstVNPwNT3Nk8jRChVUjMS/torXMjCio3PDQun7bR3Pnnpq8prVvtduXPTd1bKPXPRBsnD2Is0srQYZEAWFwho0I5eY3APhXvcXEE0/jp4lDJEeIKUhIkk3zZCfvD2ndkGlsixN/9gou2NNaF+2a12dwlV4qvMM7KQkJnOb35scLfUjv5WHBgG8AYLMHn5nP1QJl+/jOgWtyHjmy/kLhBG+YsYOG5cMOAr+RfiRA6+0sLONyF/HWmhSlXvOPeP3u2b0Wa5amJa80J/M0WfY9DUgSxAcWhFkD82P7b24oatuRmlHDy8nNSlcYbGpRsBNPGKNQ6dlp2fIsui7yYWHPZtE1WPgU4fkudLXbGT2XwM+HUeOeGgpcI+uOfQZBlmDbcXY4fCpJqo1iRb9qVi+0Id9vYJashcCKsZOocARo8lPoT1H+IbhGpq/puv8whDKd+NY9mcDD9QGXYeX69JfbvkZ6xIrbA0Yel26v0yXJOn5FM92yhO5wNL3JDG/2GtW9ZLJ7s8Q9t20RoXZq877jxdNl/kOPPdpfGWo93JGgoUceLhnl6ExChvs6VQesnjEmYnelHz4eaxktsAXM5UIWALUclZ13fS8rKG1yOPPrVekqtSR0drQQMgWSshHpiGuPrRNjRJ53jqmiSoJDGO258Vl5K3lSKUfcByF/A7iCOCPe9+1S4SHWacuI3szxqYOj4pF+VihswwWEL2Jd1M43V3a/PPuDI8ucUUhKYLOoofB1ygCF50z6JoOgz5BbuPhwWq1Q5Z8Jh2fG+kPvW8w3t74+svi59YipTw5gU8wJLXjft0tEh1inLPIeTdm0/4cfbaPeiQO/vbPw5907nVimjCJS/IJWBCg9Z9A3X1u/Pq9o+GhanSzLvxOJSF0Epn76ucLR3BEpMMM97G9mJgRlR9PB7guTJ4ABY9R0sZWAKgoPbnPs84fU49KN3VvS7OO7lq96gBKEuk27jRbCggVR6QC16sp8r6vN8+KO5Ml/F6muG97kalabpLYKHA1T9EdO28QuoGqE9NT787pa+oQgDg5FluA+W1YioQVLN6gboezN7yzxz0ubxK9yXFho16JQBtHrU7oPz0TBP6kB0JyoA0oOhLHmfU781hCYTLxkQ8cCKLIE+wxXggQjR4Khr/w4t+3DXBEQmXf2aYPpnt3uyM1EuuHN628jGPATtNw3hmXzWVPmdPjnBdgnAx9xAysOxoiY4m0qP9TGyx3csqxalW5I5QtkSJbsGlcPPMMlCUjy8P/0wVTaJjCi09Ij5H7zng/XWRLjaToEMuBIsirBS6Qf6fz04mjc1gSFH4cppUh+XdOw9Lkh2ivbvLvyWFLyEgOgog57qTld311tLF+4qHdB+rnVvqXIl9hayx87jsN0IooC75OOBAIJuY82PCM5I5zKFGksRl4WNyIzrCzShcXGGsJanLAITmqW0SLWMAiFS+nDw+PDdUnKcEUYV8cz52eJmGEWT1HU0vGMJJ1ck1Qk42JbqAORO7APl1pw+DFLs0PdGTmAP3054sQCqSbRAMx86EcMqEu66lVaoJNLpaJmovhm/8szANNkmH6hhUllZ+cac0vYbaoS1yZv3fVN/bryFdrcIrvJWFdZUMyNYIfHJ9iaWD6NfjU+FbFAKs+Bd1NEVffz8uU9EAe8EcLMsUVfWv07FHIPMW3j1V8nfrWz7WGaYlz2u5V0r1lqbkle+WaqwGQoZT0EOcHPfdigYMJLiPIP8IR8z2xZqrtwxwaQe3T1uT9hAdn1bShRzLLOphOSmuvUjevot65uOSo/+kY9M6g6Yaf6wEr67VURCIZ7NUcdPlImS2MW82UDpMmBMvE/i+4VVA72YssOFq/wRnc1aN98/1DEXfDeXfjVrJMe4L+JXuvBrnUxTyIfnBO8Hv6Q4gN49RZ0H/MUxONPopMTfOuA9QeP50At7JdCYi+0DGqFCvEMCT4Pg+AQgtxVtFF0DbQMvf9WvscOaAnUSCvDlTZXXG5woEdaEaNX8bmo5qcpc+BV6uYNUT/9vvU4++A9aS5+2Bfa3j+JwFKDgEbsPfxO/DWQTdG3gC9XtFfKP15oTBhYeNtYOeFAFUxqDdGdmGmx0UMdNSd5QHM/U0DsgkagZtooXGWDz8PCOYRA93TaKHorbQF67w0bE2G7snIQrj6dzUPt1n6SM97B+3a0SixoWigSqjGBTCouOUaS/INyDOU/sKyW0InYJFMGXFp9AgqaGWlm9uP8FLxuFeXKvZ0nxfufaSpwTLyfX/vyJwgMM7AJew9PCbwGLdL29nIA7h2fTpAD0ulDprQSqfgLw5QbeTJIjNxWABnCTnMq0ObbgpmmuWaHO3hgaiR6mCxILjW2OH/L+2KhtuQXx1IxQ+Swm20UdgjhLhrg7fet9/4bAE1DQM5ttadbvpxAFQ8oIm0fltxdY9HwzXSZs8HkIUzdJPMICv+53e0+XDqS/HPwyYVuITsxiLWGuJ5kodCm5GyZvlx49oXk2EC9w6290pDRWZqbwL5dV9xVd8G1PuBq8MAtQqhPLWjT1aZ38hBc4wOpf1dlq9pGIPnUgGJvztpnxdA/PmMa+ab4FyT/THFpxm4YYiFOEEi+HfRwu85yXfxhvWB5BMZJptNusui7oGok4Rnx74+UVNaDoW/41xPrs+hM4J6l2Tjc+BGDZjkg6gL/Cv3H71ew769+/0IvuH1+bbZnbsYJ6AHXdn9SwJHOcVzNkZCPiYhtzF+OPIxakd8fTOH6Yzn+d2zF4M8df5ZOvMo8pIVkPmWWspIcOitrcZUcmP7mr9vtLZynraGu3T6QjoiouX+T2KJIFaavu+Xya/uGmkPRArJXdgkDJ/SJFlSL+MuqHLKD3eYsv8CALSNDWH1ZCRQ1Yl/m1hXbMmV9p+K6x9+oRO91u71l87QO6toNBndG5A9r7UGOKArwvI2dm6Y6SsjfdKLFYll9JKepfswTX+RPYxkoE1u1k1cXMv07UJjzyLzKxe25ycNFSv4Jkk+nj5shpdztjA0+fwyDdEC+2kFEVUOMNp5XRzjswIDhFP+/8X2Fj06tQlRzHRQJ8Q6mHRuJf4ZujmmhOXYRYk/PjFM5Fl6NjX3NaDNI3emnQmJ3T4+LWsWdqP4R16KDmRuNGSKhyUOYUMIxJo3tGcqzHhKmpe0JUzvmux/I9QLvWJtCXktc9pOXh/+s+8sdyqloJ+m9YyeavJtUp+zpeDcLK+w5Uo1fjPfs8wRfnDN7tuJCX97aBSFawYNGE3UopBYMqYZEMeZT6WvAap2c7FMLasapJwgmt8ny6X7gGjCJZF9NAneA8PPSDIlP/UPTu7HpQPSajAepA3umbA9hbobupK8iZSKvrH213tSyOqUsMT1FFIEdgU6iHIG+e49BNvoA0wX6GyHQTl9gusgOkIMrOorOXVZPK98dwQvxrI7XEEQxGm50X1Fp/FpLBst/rgFdVbAq/6n1x6mY68WzWTcpQBXfz/z/0rCgPyFICP5/hTufigf3pVxPF7qnjHSNiEzDo8PLP0JGfAXj3dfQIbAgPlUJNN/36wHjoWN+fmPQoFDW+fu/Cdd+U/gm+SLtWGisiht+Z4nRi8ZpkSsQAahIqOrysrM1Z9o8645UFdweSGl9/dA3sHJtRlx2VtZ3sSuFKmSHDNdXhw6KmOGRygTQLQ+/Hp9bvr1+/j2+k6FAuPWwh/O499WqHydvT1ix0KkXZuoEWKV8SDAlWIYhRHGohPusAAabkB5HjENX/fsaawtvCtr5N/zF/ObCwwcsvcvX1hlUWqkUc2UMteb1B6oIV0GJSFCJ02MMmvNzuzcJ7cEBecHArHe+VulmvXSOnC4vqm4QK4RBOy2ZD+5owSpgRpsBJE1s4gNMQCJ3Y/im/TnkShp68Rk4tPqcv0yh5bqFgkAF8k9RMIhLi0LX/vkVUwPA5sbxz49/8eOPl1J3WARBEkVDNS+XPzOOVZQL+NVHhR8vx3y9lGyztIhBTFH4gwQqJsBzS8oeUIccV2HnPBzXH6r4KT59FopLZAJ8QGwCPNad9Ej0t3PmhLAzwsuWknLYzu5X9UP+Se6Anjv3bGrvmSrux7kFp6fdaNMLXXzjLFbA/ogqPQOk55xvk7NV5i/nqW43FqO2IlTA+eBZ6pcD2FceTFUM7wAW9SJy3vzXI3W120eyx+wPFO6AIDtqi9d3wCE7UngAh/qTSqE3I7V129o2fYnCHuBn0gDMbmyYNJgVtR6JDljziBgr6LMsUodLKhRJY9ALH4bQUxsOAe7DRdG/hEBDrkT/lLgKJPYqa/J1ClW+XpNl1avS5mS9xlbeWmkzaHLaAEARfpZKU2Z6pdliKTenq8tzAXAf2L6kMPwKsKTAXj5UbDYP2Uv4QZ/9/b7YSK7EJlwG8FcxMqEokW1WCtUFudrG1rVLMB8KR7Dlv75SiD/oGmKAeRPO4PXokd31xWpnfk/FUF4qSU6y5OBQ92CoFfGcUDFnRm8qgA9QjWUIA1wrihOKep+68lQidb5Z39C6ZgnufWoEO23ya6r4E2WAAWbPL44f5XoV15MKS9Ilyg6To6CeWTB9k7xbz5xpBYytDKwiwuH31gFPffakhYmt/Ng9OL8O/J2xDY+J9mf9UmtLR74uVVl+zAgU/8FU0XgbcMrongdLFPyGiUgg9qsUO6I4vwBUHbhoMNdoEKrIPmDV6v7aUxiBrqDTq9EYekxMdLwuhKXnvNlhkHPvepwf23dVEs2yfOWK7cCcfQRilFXCmx/CDires12dKobvZ/POXLnWmQvMyv2HVKhULI9b/NQoPlfKxK1WwRx/3HExH9uJ5WvkrJnnWOm5FqGAjR6XER1H7spmAf5zZxt27HZevXJKvpctgmekbt+TnMeYK+eWxgF+4m+Kra36u0c8Y8dlbLRAUJ3LVl9g0VWJy/msnRXhdy4vp69SMXFcaQaer7rJIlJTgYC+w5WM9a8ljxI7T0z+YOxCeF5Hezvt/pS8XI8dDR1T+PikJ//UjO8npLUvGesBaNEthjLce+oMH3WJOqczra++nsO50vQS0mf8NS6Dstl/kKGKYb8el0MGu9IWxRYhjHZR3mem5MooAD3AKMYGMEJWIug+koeEGH6LuV0VJqoQUYn3ChBpx6kDcB+OijxOnGW3JTJye8gs26OA19B+Zml2msKak6nJy1HI8rRVcZ80qzYz2yJj0QIg/F9RjSFdWW7MtZQalar50zIAxn+VTzXpdH1GW1FPbnZ2T54tBK2k0dLR6JhoWhQwb9gYvD5g8fYqq9xh6iobNHBIOlKuBos4AkOO0lKIXPbMW6nArqplDGej3/RwmQjN5LGbR2FoFzmT7EIHXxFvj5c9Qd5MOI00HK2EYYbIN3+1BoZtvqEppwSaDrd588onsPARh1677Ej8MgcifCRGZaa65vdgFrEEtybRJo0kk0SR8aWYg203LJz9Xo3c+nBrThDXs7ZWJYE9g/swku45yLq9+Se/Y5c8izffDBofBQPR1z9ja73iMzjxI6WC5RFoF5lOdqGpYwL5ofgXJGKqpJTfC/PPwFMeBe/ZHNwrjN9cshicgkhRxzTXRQYC7259u35J3SgvtZKTrlNL5VqzXBA0zVzGVipYYVkSnpajTQeij0FfQq/4zS8gsBd+V6GX8abnef+16B71AVLrY5QDkC4IpANiLAWIdXcnxXaA90D/hHox/IT39jvc/GbiQMB927KW2levWOBY5CZ4nR9hQtIbxmTVN5HvRxsprrLJkzuOIBAl29lBZ0554m5/fPbzQ8DmalrZkhFo+EmSHwgMW8Frgbb5hYtiYiRSpUAoyKQ6HpcvJZqmtvjPZnT9BT6VgF4cPKX04grOQbGSfxA5h2qtUxeREvso6dPDnqocaXPj5TlVt0+ShRMu9DCnK2kZZmhP06UzFh2lvcoQBQMTlFqv613YoHNx+S1Z/Ol0kYQp5GE0vOqQAFOHK+HxfynLKAUiPUMQeuLArQAvK1Z3g7ViX1W1ddd+U10sB/xplRqq4pM7I/LHeWP2YeGjbavCuEsQNKbVOtSzq1FOYKL83qu/R6r/9goN+pieTo1cC4gjYnfLKcI8Dn0t1t8KvrNswyM3vPapOK/JZcnmpZUcNJzlP3EfK6MTDHLpa95n3J3uDfcG7+FyQH/3htF/c1GLRzd7206eKqEvzbTM3VteR5PgskUERRh9D8a/xqfcXxRR356XFZNk7s+pJc2/lWu0HWQ7eaaIv2HEPONI3Xy7yZmPrXrfop8ZNhYZY4jrg8XgUlE7GRDdN2woMEQRdhEEkCog87b+OyOtbIrwmhgnE9fIKQIrjz5eV3V47bP/rDY5rdm8tLKDxpTsp39/mo5Mz+mEk6M5DF68IJzEISfxZBTBzez/V2/tKmn7sGwiNs17RWJpabwomU/P+hDr6WDZSTg7ulB7dHxXj6SRFdqEu1ZhmFu96bZlxt63tS23On8LbsChmuFyebnRqlCn8lJKHH+mLy+YSIlj82aEhW4TWIeuFVbuBdqt7EhfSYjmt6vSuxj/96m2fEjo7Vk5S5ABqGjkL6S1vxb04/yZTWM13O8TJt1/PBdMM9zAEqT/dKNAA5VBf7X45oQW/q6Rm//Cd9H3/MWKoydJW8/rXJ39yk4ROaOU7xsyOSv7f0qNev5+JdxMw3B8vwRf+73r0S+W9MZlK/qmrbHDFVNsuMK4/p82vGvekKqo4WUYM2UKQ55SFOxuZi2iREbrJDkSbbQBSH338+OSF5h+adDrQ/FtKP3rfcNDppse+73j0VVLGovfxqYI939T+Cf4InW40wx/3JuRb9bqDzLtNCzH94vJ77rfrpbyiSUu4A4zuIJ4EEuD3oUvv1gnO/tr7DhfuAFN936rmjNacA6OX4+HCWnCqCDOjpTr1SSeltO5UmLZtGtk9RNsVagbNvU2RgQP4kcqAR//kxzO4Ilk2xs7yGta/03hvj6Wkvh4z2XMmdJnPd9VuJAm3b36MH4B+z/3D+6t1g2Ju7f6A+I//1d+e6Au31uiaQZ52dny3MbOl9Rx3O3/QQaatwadCsHRsGg+7/sJwGGKXZMlts6AlJds7lnqEfHRGl5ydJueWNgtDJstDhp/FY43zPfzgnD/N984iS/Sjju92uJ35wu6Q4AuSMQVk40VNZ2FEmhPplRLM0S9aAAXIIH463HDGB7Min81hvGQ6ex/SUprO+L/XjxqqmqcAn8Jsiez9OjRDo49FGPHFmqPTuzqETezQnW4vyoMDbYVJno2VbFAEr8P5z+8Mqr00mvpLEg3Hlh2VpbPUL/16XnVMP7eYEzzy/eud4O/FFbutceLknnAx9QuRY1iNTvRlgje94U0/9HsAeRp3fLsdb7B/c8yd1qePRmJGJlywEysWIhOC2cckp1BZkRbxQ+RwuxETu5SY0O0Mt5k9F7/2fH8yaj/wofT2mTAJVB8jtt6eg1sAWOUxyS8F2cAG4zq4QtSirsH8OI29fLr/noCbF9MsfCKi2f3T5R9dpKXJ51Jc5bY+HF7rSCx3t86SZPAs4VGR/Pl59mxpjeJ0cDND+SpgUQZ0d2hFqkhKtwQuBtdi4thJUbmPx66PURcFt6j0BIpK2GDmqYLWPGxunK2X9VjiOfH4UWtCRbz0uq6snvcegz7OVPYJV5QSbDQK68vleaEja6MjgMbSV7e0FnnK0cMcLNakoKNa0sNvDCpV1SCkkoV1CD4XHFcuhsROyWVvrYXbz4BL6+sqKPn15ToGjlTgIWUwBkEPeDxovZ75cOLGoGphi7VOK12hP2CflbvZ44RwFVOXYqoo1eugRcpCxbzEuleqcDTUo9cLTroAk3cLXfURttBOcZc1Uy1qDVqDmFEecxW56uaC6C8+f9XuLLm+SwfvTSOnhoAhRVqE6SWszbBWIkwBwnSIgZgoiW3YQPPj8eLOpYvFm3c+9vSUtqchweOmDN9ZUVseZJ1X6nIe4SYAMvrclTiUXXrHjX6AuxTNcHFFvdollkCBl7YXF7cEV81I4GvHP5qd7PqToniuu8JINVzWiZlOXQ84y0FBo0EC+tVzSo0r6wKSzYHWQZf1S+AZbQ3PJK/J4KJSLXkTrYRnt9oXjTmwWKvZDgojUcF/SbOS+sXkZHbVRIPDlfVFzaU5Y6a1Brt8ZxdDc/bNvKCTemWzW9keF5veEE7eUnneWnbeFm5vGJQl7LzwLLmgSQDLyyVl3fzB8pKVnssMN4x25nvZzaX6kAdezsAlOct5jhBVWVLzU4jOcmFL0UZutTFZNcch1unQfS9u7x6I95nr4MJPMlJNztTvOBGTr9KstbisVYE47yUxKk0RwRxTNXH7I4LUzYlRCup/S/lu8hdt3wN2GycF+82SmOe58XzCUmnI+sdSuNZ3X5HDQEvz7uoH3ABsELndqcXY89ilDbwlBQsLbXRHcVzBSt6rlPNzDG4yla/KCUFpQESgLN1l1z0F8Djf/T6DRrE/7VDgknpTNyB75+RV5KO5dxSIvnPd3n1rJN2H4xP92SxZ1IAs8oqwguonsuxoT6vL2bywVU0UL0FQMopzeb/T2xRPvxqPOtXC9jMsm0dBKzm4RvM8shx43E5esq2RbZybAVpFW9YvQDako7WpONa0q2FxOB5zC1GFYUY97mHgi3xISP5BJHF/b7YcPunTQqcvMy0lnpJ7oi7r1SE4eUNAZ6XcPmgbu6DrZUFJjb+XgD41DEijw5Jn+ktu5lS43iC41xlXbvSBBl27n9rFnamxQLSbMKiXsoLoBrbtJFgHFeGWdU6ciyHbicSF1WhuefJAo0hGMeUfodAU7TrYzYxfvLK5Lyv8g7wDGvblc6JArk7bN5KUGuER+vk8TkGE7zEjFEaX7aWmWhSnCUFkQh9yXbXUJUylBYHRLpSywJY4JFbIldMF4+dNDe5b1jkikp5bPY8sRCelISn1+wq5wGWeGSveJy7PKWMTaUPtp0+QOhoX+LgTatd/O7/u4P42P//4cgL/F9rMJvFO+75vZsAAAALajSQnaIFPhzid7em14dmIrWf6wvqzOXAywCAEsT/Dn7D39jPB87SzB/p22VEgRkErxdYd2DHGoMJ/WXRb2J/BD4EbahzG9grPsPdDdjhB8gbXX91olH6JXgxQ1ti1d+oHdUcj0sLYXbeiNskf+j6Q+gMPNiQw+Knz9DQOXaY7jXd9ayOTiZ2ukVx4A3Qe2hXXazZK7T/XMb8qqXW3QNOZTsIVRcugv8CAB2OQA/SM+reHZ1jgPZiQ/daaOZZwJzHiculNvvbflm9udrQX+a0wfWusa92ernWKcgZ33Q9hL4ypqgMldV5dAGN079VzopyyfpbBvc2foBGph+iDXVuI7uIHlD/2iJfwYMMvAh+lNGPaTSSBP0hnak902vuwmQswfj9T/gj0Tn9G8WSE5zVPUFPRpZiWXkMM1sHzkL77+m+iEa0hS7DbeVBaFL4MEiDDBWrYaY/ROyrIJr5R9Mw2AIA/ujAb0JOLWxAbhTb2UogJ8Vq6K80KXBZo69c1+cGdmr/T6KOJEJvh/P08GXSw989TdiHKoApfoZpHmkClui8yL+Ji+RujcFD5aG/4Z+skL4K4DcKkFAZajmr8Oomkdc3JRRNiYrx3gF9wAE/RxP0rQBmGNGE9tIuuDtDW2JgukKzB9djN/SV4W+Y59S20LNoHKlBu+CpBrRFHD2vJrZAIwh33g08hULkneJxqEpEQmPng+8+AigBAJvUdQq8gq6GaFL9ChIiGV0W4oLRYwBQM6Wig8p8CCFqr4TsM2llAJh3PZpWmv0lNIPv91VjzX+vr32JEHObBx67NfTTKQ4NvaInMPE1xO8lDW/r1bI+tj4+6XKVqNVJ8SekVSSWbpOi/55gZSkkw1cq77IQIaPZ7lXfFBStEhsG9Br7t+0HpxivGVCiuT/w9NP4G016C9MYIVSjXfC89t+Le0zAbXva4WfwqckVTRxKfFsNVGj0lSgl89+j7AKNL0VowiLx02pCrzPifOS4RFQUPHNJ/Rw6cPfOobDVcvXC2iTaAn0Ftw1OAz9DksnT9BP6lfrKJD1AdSblCPst3u7vP0FQQb+YOXQVfHwNnRfej0DV9IwYWHX9wfFawBA/QxC9CXQ5fFWjr1wmPQWAAPwuRZNo0e+MAY7/7QE5oAHMiG93bEdXT0DkAvBvurbSRe8Qcx9LxK7lzKFE8HJ1Gvl6UCV4rp4Q8l6ICXf67fDXw87DHyC+mB5CjQfcR9dgwbid+MuBD4NygzWEKuJASE6olXSQfJGyLgwWTglfEN4Tvjx8F5URWRt1ksaOEdF/jquMb0u4l3gyaTSFl/KcmcPayH7IHuCQEcmcx1xP7gUexavnPebL+etSUal5qTcFlKBU8ECYJOwR/iuqEN0WO4srJb4Sg+Sl1Ed6TmYpa5LdlwfJd8j/T1OmLU77X5GnClA9VbtmeGdgM/s1O7N2Z7fk6LXtekAP1ZP1LH2mvljfql+q36o/pb9rjDRmGYuNDuOwcZvxtPGe8aMJTBAT0cQyqU0Fpg7ThOmo6Zqpz/TTzCkUmaPNqWatudzcYV5u3mf+xdxr/pmrnxuah8+Ly5Pm5ebV5fXnjecdzLuS15v308IpEVloFqFFaymzuCxLLbstVyzvLf+sRlaaVWEtyS/Md+aP5G/LP51/L/+jDZULbaE2vi3bVmJzFnpUGBZGFHILswpLCl2FI4VbC08W3i58W0SoDYtoRYoiS/Ht4vfFWl7PTrEz7el2m73RPmhfZz9kv2J/YR8sYVUVlC4o21X+uZJbH14dWeNd86h2S90Pe269st5W31y/uH5L/an6e/WfGrBmgwZyA7NB3Xi48ZfG3safTdxWq6a4JmmTuam2qbdpddPepstNT5u+N3PaJM3xDs6zbfJ66Ktx2B1Ox8gf0dscpx19jsUWsEWphdTCaElvKWhpblneuq/1cutY64aT6GQ7o50Cp85Z4ex0rnDudl5wDjvXXJBL1RXh4rqyXHZXq2uJa7PrnGvCtddGawtt47QZ2urbDe2V7V3tK9t3t19oH25f64A6VDvoHeIOY0d1R08XsovaJekyddV09XZhaFn4mefO7Tft7VYAO+AQXPv2yrc/+A6g335h+sKl+6lz70IMd/yH+T/sb+N/bvhleDB0AR5jzjj7vevfuxMwNOBBAKgEPqwDAJ4OkIEEAFWC8LxXKZWSydjPez4wj+OWVQcEpAWgASygAAALgidWQXaMwId7fBPUQTsE8IC0Dym4b9t7YtZRlS/wU+UGhUDiXXcKk6KQQ+25xC+AHLqC0LgZ6xXL+UlYPkpft2vwCD4vMzPG52Ogy2CycoEhlJmCErZ2cE49SJtg9wu2Frq4539lsG8cWsd0ClAw47O/d1+sVW0Ix8Nyemvl2gEJ1FhznoPVyC2RUdQ/5wqiU8pFVFiz/fXfiIL3SdQKvT0K7VkN2Ce+qmQrs6WpzFU7Iwmi+GrhmNABxw59A/vT4Wj3M0/8YKam1pGE8VJWTZq3bcE4WDV399y+3ORDTgKg+FjngTd5/yYyi40B1DiqBEBXSl9F9XHerzSwfyqzxxGEQULSqxrE14elOLOj5mHVmrsThSYBTARSJdaqzUz+1os3nd31Eoh2hIurtPydKDu+UeFOvggdVV7QaF+o0vtndpjhKqornzFXooVYaQIi9plBk9c7gNiNbs4qplsjnindfUw4JksMTxWGebtxbxwdwlSUKoDS9J0wvcJ/kPdoquXBWjCTN5j/PLIW8I3BGjgwnQsEAjxuElURuP6ecKNDRyTHcIeHgqFosSSe+s1ToXzCbzd4HNwHP/ibc/jxQA1Mhstr1rSpFhXXbJitUDMYlwyBMN/g25udHBVhGIxauE5dC/W/+AsFfgyQ62UnGQ0JSYtLUrdlqIqYUaotbmT3D+YJeR5RxvdkoBNurebWyTKJ7uVpkhNcjxsZ6atJNXJU4UTkyG2NHeoCtZFxBP2sz1OY1k/z5M6J88do1qPAR3S4izKCPqt8vd6s2fJiQERPvq7RBiwoWPvQ0pWqS+E07mC4NIpkKlGa9BRoYJtbyKwPsbTh+gmDRD8imS8nofu2ZbELMQwW077r8GEBPoCiqx4+3cpqFg4tQSB3HZLXhiMxWkeKyeGRm8HMglhugzXXNuaESh8akLiqouqKaSucxI0739u/xEnlOuipTehym9VGppd2pP5drvca6IAFN/CEn4ppDT20RsLABLt/s3H46nGEBdQSR/wlUGMnulL/BgzrJBqthRSWRgXCJhhc0LWXFLJhDtqsYrChDI+zvI7jYfF0sWTTwa1j39RirdbsWukABoNpy3RQAe3StciRzgG4P7qi2zjG/4KrKFKTprW5YE1A/jinO4LlVP/jvcCLgX73onZYJHaigsXVg1oF2/zAZoUVIn4l7x7tlQsBBdPDoqjNEVBy6/RVYmZWRe0eSo+LQj6rflZAh+fMFlnrwBj4zwXtYxs6G7b5uPVwAG2yQ63PEOsGhLYxRC6eVIJld5isxXLlevMLAVaHKzqng33bOjNMRZNbVW/00rP4dmTFjwuW1G845OfQBMtQuiT6Uz/UTxNIG39INoOz1ph+Q7iasr/2lB6+dvaAh186dN7kRPhx9bx28e2tIjymFiJWSxCmOoS2Pr2/+BRJShfUPsphfLN52Ke/s8pmKQKFRY8SYR14oYNzeM5GAXmXHh/jFuo5ytkXgELYntyOeqCpyd/7x4j+7Gm9vQbBGfheWG6w91uDgdu468ZfJk/yIUknvePQTxXSETYKVHE4UCG1R4UWrNVd4IhQ2q4ehoMBumbkTulLVue1DqzBoIfRKhSzhlG0sqg18+SPWRad1s6NFz3nJhOifLavpFXqtKjOS8EKp6/BIeO26IUPHodH50runK6vsACMLcrFFWdTLpMVy73rYxtuXpQkEaomejhIk7vkzsQZBWj8pPBgRBv/lVP0xSAm6EgJRG+SsNBERu9MBZePsHAqvZgfdcYStegBwuRd0lOZsmuL/vS2Tyuzp5rR7982faw52LGgX/WLKV92ZbuQXNHL89/rLPk60paqvMMn7/8RUV2rsU2oLua7zSKSyi4r2EJr0uKqHof/3lKaPCgnnq6kPZm3vh4UTNFqZCv2IfPmV3aD/Mc2T+7SSWjEvLz9lo8+YMmX7vhE6tkroVIuYQTZrWhsi4O7yaEM91AsX6kfft7faqdDwQ7V0AOv2oDmO3JrdvI7Q/oaxnDS2i+hdNF2bF/hpUpumdQpU5eJAIuJONRzwW9mRszfp7bixQ5O3+yyXm/3hImQsPobPrdBdspbxXgSdjKrUu9wACCqmI+0B1QJAlcJktIhVt7M6I6rmKpi17jBwevS52kh8fTTkx+pCgxU4lYxG3MdCQKczO9dWEy0gROTl1C/Fhp25nHaHmk5wSEObka/WhnnVVqdesFyqrWKH9gsprff9NMI8WwiELKbbBZ/YemIE+dP/mgEEtJIPqsEPzIHrs0fBCrC6sweMLt1ggMjM7q6bn8fTYk7IBdjX8YzAQG9ONVgVcU1UW0h5inVTFa6jhn3Oyhi2D6ep7RhFhLsEY+e4+VikQmF7JL9QTiDPVj+RZqhGRIcVGKBhfMJs9tz2WzMotWEodX2KBWejTOsihUVrW7EjUXLrueJe32OXZARRF9vbH4CCodUYRgZ2BbIpPqDE2ovnCKncZ8FDpxFj8IB3H5MUOpWNQZFmtLiRZA7V4qbhyEXH6hP192AGj912hpvzpGy7B76QyYcSea0ZnCD/BCj6cqksggOAv6kjAbKXFCcdgZuaQRICUKIR+DPUYTdvvJDHnXfPu9PRGs3bj/4JCNw+TwnZKrVB7dvULXlROqYuRkIr+pz7L7msNWplUq1DmQmp/OY7sk0s8k7zJkzH0nzrzkaz85ShU3WHaaQDhGNWtE9xx8h7GMdu/dcEkhR7dlduvAGM9CzeA65djylfHox85xiZYytHp7VqYYPuj3cHeCGi3R/y9Xfh242297Bh9jdfNqSQFx5hCG3Cq4fVjOPOJzY4V7iT1WDX4fbum/eDFHXC9GDVgu6Jffxxgj6nQK22rxl37RTnhdi1m4plPdOseO9czeE8hvwdkfX7T6UMv1AySl6fqukuUOLxx2Pj5L+yO+c6WTRbbuAiZlSE+tKZs/YY5oe0MLJvaQ+QExiBydHJkkMUXdfC4DUwRa1v7P//7aSjzk3GZ5MYvp8O2+CO+fQBdpuNWrQMzDodfAruKJL9+UkD3hWTfsTmd4scunaxGjsfeGkX7v0YyTr9Qsg8xHG30t2P8tfeDrUg5EkdIZgn6DptU47JdeyM8Idrc3CDBNy1iET6v9o9SfDunPBwwFI7f+5WVJSUlGSKHjSBc4VCqPh7XTtTlmktX9GodWXFkCD2xSETZlLVpCjjTEw6oo5oii9fgWpyEBQhMMo4xOcVvUQmZMHPxfgtYROsm7XTVtYlofjnb04MKFHVt2P9zy7bA+j3nv88TkOFNigw6xsCrjnHHMwb8hC+/I7Tj379ATadZxxiAzByS6UqAuEZDQOXwPtWXTcy8WY4/W+EaY/I9jkn+tf/EI45xs2buaYVdf9DNdhlMGKz/yeYrnoV+OcpRPrChGskvf/1crFjGAcRIiThzCS2gYdsWrdGMCGXGU6c07VRC8Fx7FjPQbkqPqvLExN6CRnBlJInWL4VxvRgV/uW9UAXAodHKnRg3l17CBaw3nC+GJYIeqZUgdIHZwOu4P1FhdNcNss+pS1I0Y97Eo3sNwOi4BAIYf07WMz4TfYA2UbYCAp+WUSkD5GNZEGCVrGjYDk/4q6Ezi8JclEZfBwPqd2r8hS+UEqEcyUBSEandrwcRen6hIzKlk3X9pCFqbjLgCgUMFIS2+u/4YCWTys2hG2R1Xvr5VuHER1lN7fD2/5ulzE4NbaSENswL++WDZqVLIhGgmEYrVShTXakAQnKrUI20Oze485JUJS6IBrYHbDnQswLj2OlVrLyn/dmWhzjMzMw6xhoR5uqUSPdMS1vMCXWAqoZd/QqoBLXK+91LdtXjZYEMyFqFPHQZqWaKm80GRXf3hO16gUVkNFy+q0Ltspv156MKkqUHprusAgSZ1bIR9lfObELIeKlSMcIEyyHWo9CoVSr0YR1FmcUsGB6cyOCycxY134tO8VOqvNXUgQnMHh7FZw9rCZyJc0oteJvbmkpNGMvfjWj/F9hpF0hshOedxOnW9bbUfp9EIt2q0dl0SpqgC9wmsoHOJj/c2L/4QHRRaJgEOC+OJpxT/dwpjAGGaBm2eRkEDx+fVjpiNYmd0Rf7lTysZwOdOTpZdHgUgiXTs6rFfzMZchChkjPIFI+MvCO09Evh1zmkRc5q2Q6sIro/kgq7EgzHQvvtM/6HYXAkBmAf77gDcUZZ6zesq+eE37tBQdEMaRv0zUMbvtUIDa2Dqeqof5+8AG8v2K67HNgAMeNVe1Z9IiVINwIjyxtNFL/Wt8eYoeBBS0mTJDCHmRsEKdAP5cH2zZq9nA0tCrg8wMqERLJcFH+Nu1vPrZNmpqX2nOzqotIUas6SU8SzmPT2aHrUCvRz7x1G9c+ZhPSTbfq8LT4XsGyVTCVXkmgm7DOgGCgn74eGhYM7W+8pcEB0QWrUX4coxsAMOwNnCJzK4V0oF6KfegMLP/yLTUEszhZqMbSQgVblJNlOeiXzJS5zOp2WaAxNTShI/Nk05EIj5n1POLhKTaJc456vH+eHD/TRUAOlFeq06mXV32xrB7h/ZOaSBFjQp9lsncVqqAg2OF7mBu2aCQthVeibCPH/3ywlyaoIeXHjb7dDoEGdBIregdB35qkIG8RuqOvXUNGxfcdCLeoPa9LdhR88Ifn0nmficLnOBDrl/FAV4ljjAiKCSzslno0CAL1sT0ff/S7q887I/lHCf1XU+sXZ42vaGgGI1E1zPvGjrkaOrBKXU+AV7Sc0qHbKSOa9dYyp0bnYxVnsdHD2ZaFTkVjZzrK96yzJrLRNaiopLCnM7+RUPDI3sv/tWp8Ojn/dHDQ4M9bX5z34aKWDKW7wNsAuOHTu8IWbVi7eFLU524Rz/viR0cHXSwfmgwAS6yXJ1v5EU63ULVToL8v1mivCQluwJ+vi1JlZ8rFNJRjBQehAIqUyW2yeQVKthcBQtYA+Mw4GTlkme+vv3KLUeHea5MUkIS0AKKLx9DMiUA36otj7/+3naEpfl6aMozCGga95bSXX85ZZ9eO5y0csmSHddUhVabSc+NDnDOgbsytSZbvkmZQGACR6ELL+QlV8EERuAMC98vDbCVaBBjblTO9GgMd8GfalTQuZ2jR1GCLcyCXaN3pQz0QxnEph2ZVQFbn2dfTKqPdtkubJAKsPRP6h45+NLsrfLDVXwN1hd8bCAh5SxiLL3BTDg1p7VTNYmUSdGBjXHVW+mUaH1hsQk+PDPm40HmBKsVVK000jTI/05fkol43NFX//+b6Mr9EKdT90DFygju5Y/fvowBNVDxyGSw4/GocwxAKOwbHQzNHinN3PRlGhLYM4REr4FV8V//+/JUwPeSzAEdWlcjB5sj5dGIvVaa4Bqd+lgwibmxvYYy7CR3hnQMLCnHfeT59LBYqakPuQgJetxmQ3m0+TP1Q2hfM+cHrkS+84gfSjR55jJQTqCatZGmQ05evmfGTWKSQSXt79cPTlLmXbYHymzOtw/w66sglvpXpuqfVVsSZu3WaqZGASPB1GDJ/EbL5loy2DfCprf+/sARDvG1Hjdz0CCMLpGvzSBq26sjrQQlyoqs8zHe/K5T3PYnPtdotN3w5KXElNqyptJPmAPGHd7l0swr0ViT65n38vHvv0sPw6CobhM+kNgNTriH0kdNDXnnAsPcihYnVbBrLjVfwnD0nfo9aiI6b4K75tBFQm1oN//mJmJygDNYCB6JnVGrLyreZve0o7QjC8FX8BC+YnQ/e8u7GXVcZJzgVNupb8sZBIFzyfB+qZAjuUK5mYYxBHiuxxbduhtsIazBEWAsQIJ3ND5gHDNcCaJz0To9oH+O0/sr0N6NbEkypksUFwwfp1QuKmVjN4nejC3ODnCgOeyqavg5q/Hy0GYePcKXTZ59jmA2ZPtC4Lp7Nw1F6sHrJmKVUnVas6Q2bqzPWKKRqLjJInr/CNxFcY5Iow/B64KBrT2hEPMUnn6OJbNiqWFxHfbWHJ7XO4TiskjSGJPyESQHTPgYKUyB5A2RDUSAw7n2CKqdb0R5JIhuIhtBGqOtlU2kKujgE4xDWg7VpZEtSxEz93v6er4MRzNpKk/Bmd1UcNAXFkbCBeT6cS1sHphKptGBBrVJp1VLGEguTnAcNJ/tkHITfLSaA0BHhb7Jp2RR77Cd1NzUZzLt5OauzRzLW4NDmcJu5OPwaDr1lcnIg3UrfrE16bZylUlqNh6o3WEJEsM56Ofx5JeUN8/IoU9wuhm9oSAZeRhQkiBWiV9gdZrvsEyorWG/2JG6gqu2VIUL/zUbwfMSnvLV0PNvxYd4ivjEITBVgXH7rYps6zlBSgFw3BudjrGoxsih3Urzf0UaJcd5jVWvUUci7dvGU5j2IaF04+gS4SDZIlJyoBnyCz4nw0CDUkgFOmZVrXXim223eKrQ5g72XJ8mSbcyi45eERJrAT4pYvD0wVa0pavRgHhO/sK4BBHvC3YawDbBwcV9MSOhGNo2jLntME303PCif5c/fK3mY06DSZnxGuVs3GcrWnbIZ/vCAa9Y3BlnUp9wLG8lAxKSYRiSPLKfZTF8vJp/kwzUaB6n9hmZ2FCRfr/s4nQNLpUuTuz0Uu24ntHxh/2Rc42K8REe81cvDU+vT1PBPB2HSi9DeDjOSWUAiwaJoXEL1WZhbrT0/xWVoda8Af7kxfC5VgGgBQczPMyKLRTLUByPO7X6l94ZWQHsvu8RTZbMgxDXbclg51HzAcSadDU8knBQVMHVxBrZAtgboUBSMt6zKahF5zUTxqjlcplShRPM/WupntmPBaFThsrC+gHiIClbTFiGIOnkpwn2o0oZG2ONbv6yHrCL30kPAqBUoe77o+6oWRKUmMJ3LRImEcmYWTweO7wrc5wjBFDjgBlmw8PPjIMqp5Ri9qrHJnyGAAZs/+OPO/5bzuZc0qmJyNeGTAw0dTC1WrhymBxp3Nxtp3GKd3lJpWm9MfFVMWCBer6xyXEUWRJ5qNeN9WiHAU16UO9VJTQ0aC/IDBVEWzadbugpXkQi1biHmlcVJSkL2Cb4IDHlUPUOybXNL5QucioV6DkWhG9SciI+VTaTNekVRvEcxfW5zaJH5C+YYmWs6YGHg1SaxybGcSliVU1G0FcgAPLhkTRs4+YeNSeqHzxr1KuYMWFKYWPnSZwXc2zShNdfLl/Dgblsel6MsCvmgdA9EpsraQr1VPK/0PA1HU8wsQh271pyZyd3q9OqQW9e/bRzbLxVVez6HFucGRGfmLudeiW5ZMhQpcvLn8069JJ1b9GhUpw6TdZS8DiwryGIDByTtSuAZCfEekIQLbz5GI7ZGbE4NZ1oFav7OJ77HT8NmxyT2rEtxfitbNX6GOQvBXcE/Xg7krU7zhiAkafMOEW4oVD4HSKOkbbrNDwiMHpligGKAdM9mBqnbBeDdf9HFLS2B98iKWkKRtT7B8XWRNd086GAQe6/NquwCRYauwy+7exmAZf6RlceRhoX3enSaMYs16Q2JpbUIdhQfujAg5t9/ipn9n+HDf98n2GoS3Vbb/oYqf38668EHR+r9/vyYCVk32JLKIMqiPFSXqrKPsbWhJZvOzi5xJQqnEywllHQszAGGIMNjgs7YSw/+oJYMA29UZlE1ldD26g+NrNdLJZi0VgoF0rNKtGqpqSgMZcdOBBiSVlxW0o5HprTv3G/78eHkK5/S/dswpLm0j0iHFj+Wqdu3FReUBRIkbnrbQNHpECKHARuCZuk7c8QRb75Sgt7W32coGg7UzI18UX0DMeM5jJ8SIxMp2BRJMdS9p+8uzKcKlaqzVbNdRUVPN9yevr9LLDUWkBhcYmDzPOeIW/J3vKadOn3qN7SKuYpGigQMD1aGezdX5V63rrD8iBWY1+6WjvHAMPY0PfjKCV2Q5FsGm7lXGbnXz80a/W0kuUpsur7CrXVc3Aw8E255uCKIq44ncyBr9cehEdu305vQuYMoRlrK2vcXH5j2rBsQwFraamHtxyFbxdapqmnWYjWbzN6FGE7k3lxB45pBr8GxI2SRgICtu2NOQ5uaNG4wejsrA72zsDbbqzIrT7K7z1FBPt/ei7iIzo7XG7/xGZFMM/cOcL9M8i2C0dQxLBaOcGb57uNXleadbaoaDyA9mEoCfRNXe2Ao/O4MtFpkHrmxWvRR7NLXHnY/RAlR6GPoFt1mtf5AI3u/gYGGAjal5IkTS7DJlLAcEqDPA3qFOPdSCFLmeoVBpUZp83ueAP9KZjvONJXNhlP/HAUmJCv3GMb/g9N2IIomOBsJfqvwVeKrx8eSYN9M6lDvWr+YkXAUdRHJw2bTt3Dqvfv328cYoCiVNIuzaO9UHZvX7Z5fBzwf7/FuZe/1bBcrDC6zq3ZKIwIiq9V9iJ8/VGKQ8KlX7rY3KtmhRYQ+HEQHUQUrsAIdq+7FFZ9KNqzjUvxuFe7Vfwr62iFLxCs53/6C/DIJr7f84GDIeNIdDh+XSnKHCWLhI7+IQ+G4mASRlTlNOid6hWGcRksWKNf4ZnFY37LKVR+kauh+f3+cMrcxlY4fKjilkJmySY4k+rAGexrydUVoQr2rQg0ng6CZeo9qrlUjFSqeVhmdS0aSeJAiSXzOTYvdq2q9UkgmapjwEqohiUmHnYqhUNFrulExEcOcXDM2mIwGc+ck8vhZcPvIQJL3I1EvUSLn8sgB7CGzsT3Z2J6Q4mlRpFnCVKeqVeHAmkEHo2RHy/izmRseo4zJaNb9YrL4X12QvceqDk9iTiabkpFljRil19sfSIU6o982z+kAw16OFI9R+NAkwNI7EpyWp9NeFhZ7aRV8+ZovdJG0p7qjA72zSKrnNctElDq0d55E9wxj4SXeJLIlx7Ba/dJ62ar1tchrMcXGkOMsCWhgJtzq2eNdx79sLmQ9gjxRo6EHKiGCI7Wnpc7DC8bTbLpx7Yvp0f/HMHy9uYvDgCDy9VOqi2xdO6JBTxZG5yYvivDLInrujvFtDOiI5FzP8pdPIrtTiIWA2BGAa37cyCMDVX1OKgISE8f9x93ctxEhota68wr+ytHpwe13jAizXKgsLffjAnCC1pG7WiuRCL+BrY5/+swS82kuHRrw81fdDEEUiRV4HWieYmvzB++U16RYX+LsZIg3XhomBU1WYwW0nOytNmD0yF1E6xOLX+OeD/w0RMiwGRduj34+9Z8kPj2czHtSPMr+VSUmG/VXu9s6VAzenv+YrHQnEP9U+ko7Uaft/d4tnyGgXl0zIVsubKKB4G8jXLXINA49nKIbqg690ntVsGA7v/2i6ieRf44PGcqe3al4TMFC9FnCRSmirzg4CJrdUm+bHoB/fhSqDqCABSoixqMoNwrUJzzN1AL7J9DH9M0CYPE8VXl9/ErTrdvDDHBvbNwSOA8XChXfd36uc1KPmbfonu4qXdT86SNg5cQCz7tgg/Y+aqex76t08P1bCx/cEdjYkMXptVqK9Gft9Wz4KoLvvvF4DOV2ByCH5yppXqvhy/akMK7UHXYodwLuW0AZhe4HFvd30Rgy/9wmFpvZGpTvW9MzsInk56xyJoGxK40noFvdGpKPYpp9InAyFgwLWayt/pg70nLERutg4P2qKUicrdV2+X0YjqXu1CGFos+o0XD2ZgnwmvBwIe09n2zTaoRVfCwczCXPm5al9S2F3OH+XggebEJiGvg0gtPK2k3QcM8n3GEJTF6IhlZ6cDxkgNFNLLh3f4rNQUMSMHs9jyNRz54ZO1BDV05NNkjs1WYb4E19rztRs+Vr6DiXbSZPNDA5ecNicOeqiROyxhexjvNaafaXe5IJ316E9agGlOLcZTqb3A6C6ZfV1HoMsBn979W+VpgUeBKiFEXGqCFkVUSHDI5pGSXVwJvZ8HP3TqTT1I05y7/ulFhx0ay91reGwhoyIYmCHYUbvNB1TAGc2CufM3bJXdb+stYUyqfAQGQIr+8ImPPIoJqZmHnlM+YuFKO6hROHDUi2MjarXqtTqrhElMiADso/O7MznYShWStzEAlNY048JNi2suwmC8VkqTNuGN4PPVqNi2dvJDCfq7cTxVqsxjKqCLZz7p90479tS/jheEOt1140x3upB4AfyEZHhIYzFRNjBhyRR84fGTgCLGsvojd/NR+69Cgfba0utz7YFjn6rZc/hm+9zixqWsO9gNQtqBEemWeuF91suT2Jxcv3EzWUW7FmuZccCWYjevVOSIBz/gHfkmXZoKPu1k7CWU/bIVKHtwkxVzk+/RX+vwWEyc3LbpCtIYB8BjOsVgoVzpGxByJQTEjBpXzxPC3uYSzimLvr9b1fLrhkgHklESbQKeGTLegAMMOKmIj36lHIXyPTkiimqbGCM8dYLGgSjtLGAxI/3DflgOJR9yWSWPzfKNF4ef2eoeGI4xPwD14DJdtJ1GSl1dPQnEmvkSi2Gpz10dlJu5rjhFgenKydqgFKIOloSHBbDj0Iqz+BAsXvTGpDum9uqphUUlfrjtjPH30/jHPDYdmbQ4qKkapUIIZo0CR3pKfCV/aPhs1m6L7I7KuoV2Fnr1W1W8rR4gYcwN9FfORXdDPtnTS55L3/xWJfhMMLSBjNw7MihlOXVdKV5O5/tJnK1Ayx6aUe36QE4uERJtYnaOkxuu403UKo87jfb8eyMFEaNGqVmQaaq8Ym7H6PmsTLBPnjKaDjF5q8h0+EJsDss8+glLef5CAamotelTmBfygTZDXm52OC0VisB9VR5WvFgrgFfgmZe+MlLABjE/Nwkjv2dp9S34GqPNjI2Syy2iT9JHYxqX+Tu3n67lcTiUWJVGYa/loJBwansdukUsIUK8uXMLWOYspDQBbK2BuVlQC1snjuFH0MHJVbD1+DNRfRSHfq1AMdxenNRAQXki7Y0QwIdk4eVqhNSUbXFrUDMthDyZPb5ObpNLq1u1nQyQauUpXDkJMn/6BYyBpIlzywQiCyoaVIcLzh5YXjr5zUm1lQbzVbH6xq/f6CNLFOIXFE8yNc1Nhn/lV0nXcWguAtQu40JoreP9RrZgKszr9VKJCxEfGnXjOBEKhVJu0wb0FEd9v5M2QtdDi4Ooq8YIQ+64YAWZQO2LLM1IymgyK68Rw2qbSzx94ZWqT8QZIxAMQQ5zk/jv0trgSb5DQm4td3nf/jodMF8EmMFviQr9ily3fBCDybnv3pUG4yxsqT7K2V23r0zxV8WdnrAJPy3msx75w8jHyVO6pFAkUpFKLU5b3lEkwF56VbEI4W8JN8IYfko6kJ3b9bj6RwBdDXL5ovty4Wnx3umuTMg8JSGCNUUMEZ1S3MluE/O7eCQYVvcDmOdF/VOrd95BcJB9dxsBzEzFy/mRNHqaklRCLrTF+DDquPRTFpxGrKj8M5fBrbwzrvFbZY6s1E/c0IyPNOCjASAM2MvNaWOHMmYCGB2pPgEo7hnwmgy6MKZVFCj4Zme6562NvGUfGExNE4yhQsXIxFtzTRWwwPx689VCypop2O5E1iVNu+VAQH8tUJ5NQhjlpOsw3zEqn7QFe68lvd2igsUqDKMleOaE/wKcgjCMHCxNWlxLikjkIbRrMfbVoLoBandWMzL/8IljKbsFzq1JOw9eEYHdhI5t3SyiSbhtlvPLyr+iSuRgv/5kyDDIvYE4YwJVt+VoQiklmt7jpZrXRyBVWtea4IGfsYS8yte2QwQ6vP1asZKM8TQIgpPBHBdV26qbcSmgl26z7yBf9mR0fK2/jHJ2IMkCkaBR9IbdjBc2re1UkGcX+COehufy51/4imKMKE5Rcrh6DK8+Qw0TlkYch7Wj+g0nvYwKwmA3ycij1ZfzRr6WcVrtek5ly6hEyDF0M2bvBs7tq0LYUSv0JLLZ0GWY5OKunzQ78C6JWXQkHneDZIZK9CrbUvSeW5QgydN7VTleaYH6yIrl+3eUQ+2Z+9dVx8tavlmZln88p0hTESHOa9tuBiWd8ssazbDeIl965+yPlfMitUYmLe1QF5ekTdw5QAA+31oz1KYJ9p8UcOHLrIwXPovI1nNgzvXdjhZk95/VyEo+Gos2moqiSfOI5Ygc27kdjlVbw3GDI41/C9UehMCyJyEdyhQGdGOwOqNTssgSE49MmdpDhJoHR/c0hgBiUaqYZyAhAsLNrPC+zSSbumR7yFmSsgEXXIb6kEHDGRT3LAkIHpb/IkTgCQJZhMWQnXCFZPcWpLVvkDYlct1VrqSkqgV6WGk2jABJWJYDg8JafpFPRPhHjMKUoMrOTh8RjJ1JbY8OvHhO84eDa6qIno5oAfIKouN4DYpOB1uGZm+NSCAtjKEwYES6UbjS9+UvbW8U8s70BP9X8FlXNA1JbNmxap7/Yk5zSi5lVg7GGZCmHwoC6Db78WmHHAdDJAkwMpa0KwQhhchUwtefGMVR15XwOYQn61HE7stY7/2kslxT3fXpKYIiqdrqjGp4ykvFOWKHVGeMoOVc7xKxrGqpYa4EcKRYmtQoFCXpN/WvrTpgvvMdKUeI8DQuJlDnMMRrUsXBAxnXXNLOKWazPzfeq7JLhCresfi76SGQmNMGeFBzmq4w/FC7Og5uEZHI9GBJoHVjweV7JfQAaO1cOzbvx4NVAMJicJG1wU/teOOTnLPdfxoFDM3ZT480GBye9FgcHNq3wIcWxRYJQnK5L7bhjMLRvhuS3lDGZfC1rugB7syjROBJzwNPq8tn3xiD/01RdrBcFowdkNAPVf3bGJnDYqre+klldtgoWezjTpFNjQjFXdePjPzvnWI7KODyKwXBVsHkz331fnU3TlMd0V0L0rNh5DXjVZfl1S8ecV1Gikr0Ak2pmIk7x+kkWk/50cEvgBztwh7OATUwZvPxxG1rrXfMFxgdW9keSe8etJoCnkpcMv+uLcJGG2mR4YA8DswbAjEK7ONyvZm0sdZnNw3dPmmfvuVqP5PPRBNorssbQ2Bk/6L5yX4y3NV61ztU64CBJW4rhuHNOSTyIqIqT3JyrmmGprceazzNS62x0nDo7LzDl7ukx4TF8tt9z8HcXeF9QFQ3GyL78dyXDHnU26UP+Ag/gGdyyIYNPUgYxn++bm3GVdvdsbFTzzTXaKKbDi8yzDAOgZQG6bT9sXQSKTv9gVJpYmbjfcUFMbDP0tZcdHgrjnyhGeRzQSWMVCDEqvq94S4MhBZlpeul0/+j7esrF2SG0e8rOC6TzCLtS8ZLmEckPXbOJoAtXaOBgOhUoff0v7qyId+yiS1/o39U6RCKN4eAAmZJnrjdCVtnrRIioVaslXjv8OWYs68yJex1gocuRn4gNltzcVg6WaCmZlQXuExd8NZ4PJvIdymiDlb9A6GdO49dU0T1eaRh9zQA8gzwQ5FAzzKolSZbMzP3yZgH2eaMJMFRwwUPR94YiECs8hnVxOc9MXvvOYGYsm5V9IWu+oYgSwXokxJ/tUptxmrZp2OKKPuoYLQkHdcgxK/7DI6vv2jvniye/MwwMQD7wf+W9WZpzsowFbcNg15O3C3W/vnNyyj/I/sTUZbJvs03xEVu2MI0WelLWXuqe3fMMYRyqJmfzzLvkdi5/zmIDjGpjmwc7q+RHRrvigBDfcnO4G+65lWpXDYIuG4womV5O2FzUaubDn6aqsw4JSP7FEED/TObmfVs1Xy2oskpLoq7U0uDJ4ro5nuc0bGLr53iX+i5tSqQHln/383SWYAhG4M3VNombF4uuHgaWI3dQNtgGOhCXKOkomBZk+r5TSdr8kUnxcx6NGKmiGMj6EB03xaRbn/9Vdi23OAFQpnil1jsF9eNw/RcPJox1Z9MSG5QzRTq/tfKEpmOGVHhQx+sURoSuzOlbbH55CIU5t8sIcqt0O7g7mkh7zkybfh3orDQ452LcG7S/WhZWA6IKz1/DNClcTzi+4BWVrOEhG3UHj+CSW580uXzOWX4wxmP3A6DnxSvurnN3fXKu/+IB8LtWtYGhEKCa5e+f1EhebM/50yoYGn2ZY33pWc4BNwup7MF2MhqrnJorym5O7J0PvVis9rRv6EKLdskOARTeqS3wU49Wyj2ZujEKx5MUJBR6VAX8fMmkZbpWOAkUSPZAMl6fsBkvtrhoXU0oW0ek7gey6gk/cfmKncSrb4+47MwGl/EIiobTGWO4yyFL4XAVbsLXcd5TEtzhc2iIr/N4uhTiMzyXJ7KdN5q+5bI/WXfAV14FQK7YmyZmT39qJSblyypNP5EJRBRCFb+bebMTtx/4lJNtLav7qZmz4voR2zPj8j21ubkm351Jr7PdWAEIm2Ebhk39q2M1sbompm4H6woy6ualNG/pkJu/vGlVvhlrwYss0mKNxnl1DTmVGTeiko0T3Vg9482kWAisseF/pEile6sPFs1tc9weHfjV2LcP8Op1oUdPXIuvmzRjKhUPkxgyJh4lbIJTrO5Ksa3aYsfFE5pRPES5ArQ8ukKlcsVrBfKJwpUz/zFicsz7KohwG7OdPD96hHHUAmv68lA8TjHnBFxI+RJVhfE6M4qxDjB4ahm+WAN3T1aQ7+v6lV1fAPGJBGqcMhCGPQHHvlicqAbPbS2m/9/y6GHthUISgSXiyLLCQd7lPU0cpUBLGAytS8yQ1ha7PssRipP0cgUHl5/oROLh/7/OShnYDf1LmfrXPO1IX1zqxfxn7Kcwf4I2I5jZ+eqg61Zw2cn2hvpX8HKOZG1jo9IIVOthYXXkMcJyKZWDrROKKdVV9YnT/9HkqsHOhyfySos+I+YIeUizIa72WQuktyrji5ETc3xLiEsiqxuG2wa79u/4i9MOK4+teusqmpV5VrA4k99MylIB2oKfwnP65OKsXPT+zy0bb0ZXvdnbfO/P252OyB/qQ1PUX+Ls1pH/uGm18HR7Id83OmyBPzSEJhEhZOxnioPWK4Q0S7W94LLYspRg+X7ULg6w8lgyJ7pyBMtPjKPSGrkGtqKPo5OKibHao2UoumpVhxZWYmk82MJ89MT54detWLa0+QYlNcOCc8FqFehuPRBYcCSEbHFTM6Pe+cAT+9JSy2PvrsWwGd0Z+ZYj7OIndpDDQxoS04VGXbx7tfXCrIJq/P2JPmJiEN0bLFdTyLqurGdTVMX7rKRtptLYvXZanTBdOqOOTL9QX1OFhDxJWu9XXO25nDHH7yOJTX/raBH26oepd8qWYNAEfrseDDjQ1iKV1i3Xbb8HNlopgWWDxnzCa8QmQSHqnwiq+zlVW3H6a+do2pbKCrnlJM9zgrkoqlM+JgFCbVuGDmUVMNorqhSVaHPT8xFbUNlylgGW/vio5vM5IFkRmTZ7AyZGEVwCKV6Kd30ug9wCU8hOghHOCZcFlw5wiXxIdgP782DnR4/jchfcts3vGGCVxmh1hWLJXDYepq0AKFLYubnFWUHtchxrWfdl9xOw2padc58zC44KCAsPTFBXMToEU8ckO+faVcMtKvffze47BIiSZwwfV/71i8NuxTJH2YeHHzsBct33OYWI5eqQS1tg7TRGpB6HV4YeOypZ2emKL73qhh7YZSyPPigy+aQi6bqSUnLrLimriozFVAcSpxMguMbb9hE6iKVMeScvp/qNivVscd4L7O1yfniIhQ/wpASzIeCnkXX6bYTFKJq5bdCq1XqD0Wy1RpaEVV+cFz6iDlSMcyYmuaE0RMcIHCWckhVKEtT270wX5dwGAOoWZWmhOAFuMhUfWeky3zJpyVL74d1ynqXRhqN4ckrTop0bDkJ/2BWiRtFN7oaSnwJPuBIztJGVLVYdrLip9JGbU26Q+7az0guLrf0wIR8Ao93rNzxExvp6wUmL0LvbpYv7auKWJzjrif4DiUi65Z0rdgOGO2RX/Bv3IwaPvo7l79sV73r2kjTnD9eIhqwjIFKt/lvMRH20WpuKFpOBctbB19BU2kyVaoh0XYiquq4a5T6e1bQQi54fciTK919hQ7xmChjBGVOTZMqjEGLHVOu5AiDy/ipjAo8Gy7YWFAu6v2nqfOx3jlg5O6/Vbd8krdpEEKzO5BdDMIoLliY5u6FyjiNbibG7HiId7AIboQXXXq7U+lYkG+z9jEdEAIVjKuPjZZIz2Brrr5i6VgMjMymbhM/Y8i+mataEOUdGRsEZliUYs3fCMoRogw7QoeI0BtOpVVSMNiAnDQB6WOhpaf5YaVYqD5DG+9eiJFNmMovaxrzxsXdBtbNFLM/R5RMxIGxmoAhRqmGYFZopLGsbU5faEa//nw+gHbXyWagrn+6/8Gq91T+/+kcEiJmpodqKuUYTOgPPNpKYqblbcQLvdoxHixngvMYIcY5dioslwEWNg8jXpfE4Yo5RBrW2bqYgdbE0mABAGwV6H796XPdgAwNqNGf/OnZ2j6DkUCWX5grdvdlzYjYZmMylKZyPLcsln4y3ADzyTqzXA3YwRIUz+LBWE0qP4/FVaBATNaEG3ZVpNNFGe2wP+Hx+jVqmOFjUHUdXFNcbIwd7OUELVUiiE+XRIipYmKfw9erRGAVDQwnO+uHxiFdygaONb98ftByVCGnVeOkojqLKimrWEw+WHZhmkFL16hHiwxjf7heNggTTjYtCqgpcf64Fej+dHqhZRN7tby/CIHLbEZ73+DONVmyUjW7/MFlehNqN7MRmJauz3CbCZppw3uRDbhETPoNI1kcho4elIK8nq3NlQaf0LOrCcS7jDT4se1xZpQoqmxAvmkLjjNm0Ie8iB0WGiiI+lAuVWrA2U4XK0VuRu1j5cxPkKvTo1DIrPxAtLBjVtt10pvYSrIiGjqi6Os/t3W28mHxy6Zx3Bq19LtDI4MR3udzRR+0cvpJTTVCMUB6jDJ06IRE7LeNGIjceb20MFW+h7Q21dHi7fQC4mgBpKdnZcsEBUZ2SsMF4MnpRkg+6MaZHFqOuXD5wa1hgqqoC5J+L6ZsZhUAFU26cGT4TSIfz81vBBJM3jmvsO2xYHv3Bv/wWpZxWyebM7E2ojXd3wq6Iz/rOe3y7cklKDmrTnX4b2Z1eTJalwTAVdg1fcePbi67lA1mVKSjbqGRjnlRoXNkdSDb2PHpnIRjje36GypnnSbFd4FCC35hOIHmjQ3M9J8G2ikcotVMvNHxvjV5udbxnBsRvNwrEtV6Md0bEqKOgtUKZs4KFkbGHWRyM9wNHmwt4QRzccJXlgz7DutDj2qoD6l2AVkgF1Vhx5TGed43is0dByxVRvtEayM1zTl4qIL6O1pjmzMh5ABYvKirpZEBeK2IioGW3jngrGZ5MyERdXs86OrmyRldnpOPq5+s47rd456xpE9cjnVnRsqnEIOcxMxflMvUZCXGIlIMYiLzaRRIVVtkPFQIe2Qld55GwGW2vRKwGBhhFC4i7E+xU2aNj6gzsInUpdJk2dKq//stS6EN+4dAoceFJ2na4O3Im9K++elQ/P36IVz4cH2Mtc7GBt6k7Ypbs0vCPzrSC6lILiU5J2eq8xet1y8l0EjVGPl3INffaaGYO4CVMP+amarCHq0uqki1JYs65neXKYKUeCzKb6iE3aztvP0nTd9zeCIRoulIgHyog2CF3yC0Swm2hw4fAQVZ94PwOe5ajh/muNiTZGXhOEO+NWbE8ccwtGtEKo0Y5ymZIui6bqqwgyL61h284TSurduaP928Z6DLiNGwHRJfpzV86upcHgwt/2hlOPn9VKO33+tawDkddB27XtVqk2znfdEt5/2/QDfsAJ8JBazSwDi+UXqBHpFq+vfSum0NCwUtK0kEw+4kvadpSxsKGRcUt6bm8PaN0tZBj1l3yA9B2gQmpkZsv2f79TDzgxOScBHN/at872ej3yKa64q5211zvTJZ9+AldrPCkB9wztXt7ZqgT8D48tyYuILHlfq7xvuLz7owO4QlGkPSIPFfw9U/dH5Jy3fOsflT4xrdzfH9iUeySa7GAyhV2vSacBaTqynPE5d6eEoxlK3OcM2ASQudOjkmX7r2wbhh/1Ekmf/u4KTsj5llo1t+qvGwXwBhI4CNf7eno0idH1WxDrbQOJNmitX1CFKoKgh9DgqYRrym9BT0NHjk6BY3JQZL+tNv/hO4bdqMl2QiGedd3dUy5+IiZpcVmaWDNG1Nuiko9UVD4yEQttHR9DOxMcLpU+T1jW6PrEx6Ex8HdL7VI/P6fOy9C46JMmTdnyY4+dRrf++tUGokQ3YQ3nz3RHA6lG9U3ZRI0GrOFPJASBSAwScefuOAfPG+AChQkJdNJ3iBop357c1EZY8NF/57FAsAhoyUOs0/o7hcIGzHP6fTWZ93T+Z1SPmQ02yz/E2REcB1l78c1d/JrLueLZCHBC+LWXfpyEJ6FNMJb1YIIx+ICWvNoaJUVMtR4iwLmDUn8yGLrEv7nTCpuIUtFlCzNp8HyrF0oNsYobJ2NPv3350H3F1auv2NpgRvPpHzOtO323k1F7SjkyuGqgb1qqdhGnbE1O+8eKPx1wAUHF730s8B8NhZjBb6kRt/IN+S76ToGBnTqXdzKB03qKLr9cUlWDENGnWvrN9P0Sg+lgo05I3vhjKX9lkM93oooUMhYlLGbtVSw7noF6uaXvv8mEo2mm5jSpTnLjuhGLBp2qXPvtD8QLyuQT2nl86FuPpxqoD+UWaxcjYViuDr1HAyJVfjbSCx90pLxUBVn3B+JBrWgWR5aUDBZkAiDEObl3tfwBvK65jAlz8TxTVTI57lkJjwh7tb34hlffobaBdMptIaXWE+Ls09OYzox1b3U/I2zedFho+BOJxNQJgNnAdhm4bvN1ZlvV1J15jrJjpI2inOvbpmxD+GqWfmbHJy8ZFV6H+1yreDUY1J1JBTvZtU9vurCRyCY5UElR82KdWv7t86F2gk3a0l6mf3s5gsx+aZGzTFOA8ip5cbZ9SzNHGMwWBIkVUSEejQiY4mrhxfeY/rSnkOnq1buwWOkTAGF3WdDefYcBZVqS79aqT9qecReQ2Nt8L8/u6AxL5m1Q2BtFNtHihi84hFN02rVtdOGtqOHHjGk59K6MoA/N9vwZZbuhsPVycQQoVFoDwgbWGhritfzFw8SSLHI5iBqR+zD5DJkS2F0GdKMlps4rXzcIB8Df4s9TQeCwGdOfAbhjxdimbqyUHt4NSz4IlV/53COs+ebFfCHx3Li95OOmH9TqQZJ+7swGKpaNEpE0ezuLaOSqBvwhxT4txn5/8Zm/0yWVLxGsU8vjn3j8rfldG4m7/5o0suJqruvYCI4OyM2lQhDG/FkR+alQoi3qkFKmvihBIG2FqPqyMNPPRt+oFnolr1M4XDwhMfCnfRMJ7cRkHty8A3wOUC0jsscuexYT/sxmsixNOkDz8lR7KSrtzl85MenqD7s3ES5fyklszzzUH34qOBnu9OTJ4L/onLaOBYbf+mvzDOdSC9v8HxEq5XfHMbIeEiJpSmy0sGee/WtKbKPQu1fMl3VqhLwWfFh87bBIgy6C998f+o0DzdJoMCInSdVK384XvCdNO5/TzBoe6jlM51FusC6a0FDCGNruF4tO2U2vl0pvqV0rYvhs0fmf99cV9T3mFYUQrrtefGNopn/2thL3RLQ7d5EgjN8g3UrNMBRca3RG4fQT+5TsKu7XB8X8qOh+E0BZ8XDvnOmB9gTVVv0WasGa/gFbByGbvniinfFwfVXJqrnZR3rHbISbVFj0qsmCRK2dY+q01hNlg4KbmpaPj6c0dTfWA/mN/VZa/48QrcTOWzdFJf+nsQFtcRGrg1TYBkPh05wdhKbi8Edbu5IP/CovzfebwE+vguFgU2BiQAHdhigkwbeQYHj+jW33b0bcMRUYobzK9WFzYwjgas0HEjwzeQAPuqRI8MwOWq3X4mXY7vlaboJKVe1JZL0ZIcSyPBBb/HZZMdIuECIYaorXfYK84XjdcZySsqzSyYVWW2nYCIPhhYxSFUbraUnBEh9MMbZplkyJBfBdwdX2ogWRDkTAJsUfhuSiYXBuDGIqIokVGqm46rlDtfGMohRKWs8N4AWvhGqbsUoSo3YCGNVNS/0jeTDs5sclbQ+ptei4OONhYZjiKabCJrlpqPkzdteivXPdeEdv8U6udzFwqT13SQkTaOc7T1ygo21mDLFiIROYLOs3BmhMtkrGZ2v4MAAfvH1lWEgQt1D/Jo/j9UDdy9y/qPPHtUxKVFn147HFfOXJd/mc2/lDuWHm1vtOpxR5oRlp61vp71xSBijl+sGhkI0qyI7lRI7e+xcigK7LO9JDcayiDZIa6wymShtiHfgr4YhsTkG9OjX13/cUXnE3zeDrwQhIYFoOJhA46SpYh5zMt3OAlrR1asvsxpUYudh8t/gjAucHWBrmY21DCJHoAv2n9MBuTO5OibeYTbbQBLBIwdhiam5JkEUhYAEKVpozksloiAgMDguRy8ImDYHLLGiMOkTfX28BKaPIQxigOuD/8EdvgZIlu7i2mGeWFkmG8lNPACCCvXfA2GJSYCz2IqXcW44aOF6vTBtE7+/KoHZpeaqLVwTgGWKc9MPZSCiM/7D1R4Wa/oyAYx0WAhBk11K01rjz58TeNZwuH+EXgAMEtTCzJx+FnSZEurK55DNVgoQQIC1vP65+XiBTBx4ejPdT3vj3ZuL3f8CeMAjyItBiF4Fn0fy3gIIP9gGuj1N9OM/QssBdDEsuPzbB4pWsaFKRQrb9DjtVs0bz0zjTHineAIilMlotL5nH23otir5rCbATJUxbOC42ez0oVqJoJ3J2NefvsTtZhMVnrdVlUhR2QMxlaHVnTHoHf+IouoPLF9bwD7fn29S1CgqzogtQ7WSkLv1AKeYQyxjhlnDwhXH74s4/lCPpcB4niVFg2zcYiJRfHrAhf1Ajwkt5q/dszuyjWxJrNoc7BJdGiWyRoq7oEZHT8ab/qfAg8HbnpVJjNQd3nvqjs73s/dIzLuTO2bq5gfmAUxnMuZ3jkJi59ixLpJhnQ5kLEB0eTdtCpVy8TCDW0aYGEj3erESgh07W2wra6dH9SWNuqQLqOTkQu4BvM48l0aYcnBwbFV3zvL2mVdp1feGfW14v5hOR0Qz6k5lqUZzHjUgIc+EEfJHQoiYheOHua2fdoHncsl1269RYebG3q+qLYmnT4SOVqS6QhcIFclIEiThvnHlpKTYd5D060UCyKU44Qntv3dWm8GaHabhVM0zuaGqe6m4bH8yyUWtP8UFcSiWSFOtQpFKQtpGOOLChQ6007iVN0wTwrCQY4RscBdTZtAox37RbL4BK6osafY0I9ds1PPiZRTQcVF2xWLZ7HIoJo52UrEDwtg8fZFeRGIF41sSgF2Dk0y+VG5iZE/MsGEoiW1kZZ3w1MMaWbd6gYiFmNwoTG2RqnbTPJJmNdPm4PJAo09z8VefwAhWVT7wNK+TbQZ7TQKtn2EVNR9V7ej6iSQbDbVDKIdFyK+SeykWRZ1c3qexfZlIRELlPD5MZGoaWPKuxhRWL+pFqaiVm/nQlOqL5Qscale9O1wk3wz5ans5DtfLlCQoWD976Z7Ja0XY4JjoVpDhqoFAqAa80KA25ihH7hyAGLp5K8ZA7gb/fby5aWnYyczQfvQ6MLUaJp9x8U1B8iQzFbb3zdvk45rZZy5ifjYtn05EH4/G8/4zEsnw5e7F/+0HXM+Rx1qq6OKE8or+rBNy+glHWZVDVH1jMnvQEelpHElusccpNqLBXmrm4b0kaodmqzmBN80wkYM0Jj1TdyuKcVn0SpCfpBYJmoNzEbyFxU4RkC8SonFEb3SIaRxuhgFY+1OqrAFVSjOIArO6mmZ7k7mnkEALEz00qpVbVR8qvSa/A1uPlH4j+joAJBE+Wl0OoKvA5MOvivim7QS0c/87Jy8oCh49coJMahzYdok/nxEyHh/Dymq/LMF4hj299zrgJM1FNBl2Uht0cvaeGBcYknAJ82anb+uUCeaEBtlLMUlR4pJpNWeZIiebRtp3Lcg0DiQw01QRHhUINtzUDuedLpSmWgFDEWqkMFdNn3dEQSgMEsUcNOf0IKBNkXyaDTuecofq4fMfK2fTpiFkpXPnvzplhDiNr7uIlmBhGxGKagcwTEO/R26NxrPxg0DwWhmg12NxhPrMINIxWF6R8tv+ZmktnsWp1UZs7DFYWjNZQKGtOq8RuxRFktHp+rpiRdzoDNS1y6xAyGrcteCT8dVYgGX8gFODCgTKEQQQ9m7lcDsIYOi6Q5PHDEZip2mTMUeQSUUPyILtNwz811MIxgx6P5emmR/uE3sbb9sjZVaxIV7CZ1vJgP+4nSNgdtLrDcll0gOCQfm1bwjBcJCmXctpZgumV8blcw49veQQdGuwcaBQP7N7YUaNp68t3mN0EtIo5OaD2lnaqA6LD70jGFcinUX3Ze0tkex7ViG6Rhr1GkdqFYjVO5NbJtjd7g+IVppLCfvwFb05t3FhT1BYPWhF/I5FJcDgO0FumBxRFQOtLZWuFhOXsMVe9INlHOjBwuu/0WZKJ0U86Cgrii1UxBoyy7a4v1EaI2/ZIV6QVMMMllkSxRhJsxmOZQbpUrSoNr26KhcL08iGmmTZQe5UFEZckrVH2uEnM/+L3rAYs5fx8F4l/nE3jdmsVLZVKLmVpEwy2yrfj5eGLxESPdlskpVqJWSKq5cByftrTf3yE/x4p6FuHcvdUtJoV6yI/0lMXALnCfeWQtVkBNCNghrVgzZX8H04E6HxzuKyeAGK5Pii28dLZVxlCpXJFSr9poiGA2gI0pLDR1KxUJ7/LTMlezZuZWVqmmq4JCtSy5ypWZnKV5tJVbPLGmp6HR+sewIK7rcQuxtKNzZL03OM+P9fya12hFLFbmk9ql9MJGM7YSbSQkI+LQmowtXTIgcqIECKrSBKWA6kZm7ybgeufbmjyJkyW3INTTcdF337BMIAFisHWfCTsSX/RmTUnccoW/jWrf0YO7FElT5/GCJr72mKojDF7f5MnMJtynZvvWtP60SizqRC3m4iUt5cPXlu0aDZbFputlja8c6gR/NojbSVrco/K+F07M8rEL5/KTTPHVKiIO5iVTtb8WGciR6IjvxjO8NNebdVIc6PaTQV8n+9nliSeHLDdBwN9jb6NrfIgb6ylglXQ6YkBDz+UviSmev0+wWzEiJmH71mcdTKb7oh7VFAkp5HqDe4S46k3NMOA3lLLRr36TPfCFrPLnInheokZScapvToNKpYbKt5DgnpDhWylW5ELYrSuc2mr+iDZQi9N3/WWOxKZFsyKfKDC6KsUbqmFAU+I5cqPulss23ikWTePviBv4NniQrE/S32SSY/+M7cggC1eBuSrgo0ChN2n+MqpssVSxYlUVTNdtQwTbBYfuT0TBSBOoFdNwLcAGCNhMl2A0gDGupQ62vmAcNnIbAuoh1zctOYwjh9GoqHyWGMefMQKP+Ba9eOtcJ5qwXjI/vYndH36hq8dOU6Q2AE7d6+g8r6WjWHbr2bEJEA6oFxWu37nkP8H9FAZnyysAJ3EyABGiDSw3fdrnYohSN7WH73rU0cRDtwVs9ipQuNmXxw78vGcXCweHl34+UJjsBeHF+B4y7wE/T/Q/YX2iBbW8GkHGwSm6NH03Nx/r3W98Fac8CFA6NgcYlEVujIkaupAIMc6FQEJUo7R3Fa3x3/T05p6R5agYbI10HPIWzQYXhdLz/Hbzr0ozBZu1bFInnCdmqNBNuyq7/oyjc4/Uc5nANbaNvJonuHwxXDof1zsz2MqhehM1M8b2iWJFWqGqzDQXwUh7clmncWzwiAQeLEVj1OqymiCUVurdFbSQE93ajXsP0pbk3kdo7iNH8Ubj2+qXlem/HqbyN50qFNgI+VFP0AQaS77fTbrdhuxKhIf8ZqXhUbsNxCsM3HyYqG4rTBAatRqMje1z5mVvun9oGMtnLtZtDO4vgo/cDj5l6Id9XT6Wxz9q917PDv37V8gGd7RvuUclkJRlC85EXg1RuAjN6vfE+rGCPRfgDtQouL5uir7iIgIOnD447wOeRhf9+ubpqLRBKQFt6vPtcEkl+13TU5F6xc4GFjRjfzpLghCdgv+M1yqZ5eeMskVnePYv2Ph353EJVD+JlvxZcloc2pGEwDsHyRoVSNtPGJRsP+B1+OffK2PYYQqZWqlURdMdK22vcnH1eVIL5zz1jvumejQFYeZn6QVe+v1YvP5uBe4ocWZqX36pOdQx+yRI/WMWG3kA3Ovl8u/gX5QP9A296/wH8AAYUCCKb7jDkyoh94YjYD4ZPs7fdX9PtX/MVpIkYbj7nFPmO7jD8L8rK5hd+gGbIV2x9RvoUUS2kuUUzoY/POK5RSSBuPttnOWYwynz/fqmSv6d2V0gCAE6nu1OYpZjHoESO49C/k2jZ0em18V00JGl1iJMxh1IX2ylrOsS8kIwb8BR8kayts30bTuXxTSRUbkIZU8KyHegCOzcGgM1lRZ7SCdGabwSlMD9I3/KYMzf310weO/cnFW7Pq4KzrchSjbkwscFT2BsQKDCV/IPRM8nXqBUKH3fZOtk5WvvOH0UJ/Z53nHKUAilpvv933792781yayJr9UsgnFY5US/kkcHdCWexHDf3+fF57JZ+Hvl5P/f/TXCJqqdnRZMYtVmk7YtV0Oej/voMzUZ4dOSTkJajEynOjj4nvjJQyEWJL1cOz48gTzhT3m1EKsAX2rHGonYGM4kxVyJyas9V+eb68+DaoNOq1uckCtcntr+lLkFTMCYgCeZPMD4JrpWA/EZd9OqyBMDquNnTHH73JvJx2atiP4RNT74Hc1Lw5r84utcEfMP+aaT5wqGppDlzd92UqhdUDXxKREjWSXgeCJtijomnycFaNuGdcNY4fVpCzdECtOpCzv403iL0oj3F6HLqSSvto5lJf/f+vaI0fG+bVbA/EbY9gKafe/hYD0mTIkEaYsbU6rinr9Gv92YN7qKRfl4KwjYC6XlpYQ2yYWIa4c27Rsjpbv+2jrQ1W/aJWZgneMqP4Yy9/opeuxx/pD6tdu6ibJ5bMW0OBFLyxLWSVebKH1iFgibmSL6VlSZuYU2xNMPnLt9EoDiYCEy3tZr666AOVhTIzQ3fL1u5Wrub/v1d5qYdWLIfklSpYeQsrzh+TrrR2HX9sKOd5IXVk5R1MZx+acSTtsu567mQvzSpZp4P+PHxHNdXb4ENQfFdqWVe50336IB0P/a0q1wjyuXvOer08RFfvfKWkK1V+Yw73vCVQVuUZ/ZiF3tTvT/Nbvxg3Vq3Ud8RjNt0p9mh/tHy1Nr+iQvyD9U+fkbq42JZDVOzW+dcR1aQ4Gc9eyVyBleSqnTO49IsPwd6E5tY6VpExMlPDrqJ0SVrOOd0u2Y3n5L3oFIJChnsgfVTVkHeel4gHkcIMB+naWNOVfTj6zqcjaiLy8Noe9BJqE3dzJ0s0dD3/EsXq8V1WKIB6CNsVM2iU7N8b4lWS2Fv5t0ktCGuuBfeS1v/oeksYFy1mInMqruY7iRW1lSYUwo340gq1CnsZkyxaEc4UMJ6dQhBqT9ofASaZy6osiVnVxPJRH/bz9j300zUL6RdxCOO5jVR7stFHNszFy9GYUYTHaQbheBgipxDis5vKnE/bPWW06m6hVZKg9xWXhULG6NnIAuZ1IGTZMOyPeKy/AstRCWfcSal0BO8RNmt1cpwzp0QvU2LrqVD9l0Qjs5N0KGTSJXxPcpdpkQkxkwfz3Cm5cFalJxOANkXJVSy3ehF0Kg1fR8UIFjSwlQzu2TsyHWpV0T3k5gXIoKGc3m50HQEFCron+qhNFzeuEzWDpmsskOrgSQUwnxkkqWvi7feZnG7LkqO9Jn9W7+FFN99PaEwQzMCU2exflO8eQ0Ai9EGxnNlcJiX07Y8PA+I0GB9YkAbzmfUPs8GINBSSjr50aeXnbeaII2BOL5ir1FhgL6npHxpagkSjY/M6uGvLDoe6Cdo3hVyk6imTvQGTAKFsNuilgkEvu3VDXAtP2j3/LAWZoJQbFMml+TocSeUiaxzuCMa5lLeEdTFiFnqTqzHP3039pHYvm42nsznmkyqQN3pRhPqzb+4eq3U6hmsLgN0tOoqwphMw0ThPbzZsu9HUNyDAhmL61buZHDXOezOroYvVo7NPnCB50DfbHlKWScJqMyEXDQXJSLJHxkLVN5hexEvEEUCxuLWerDnLP4HLt7ZjIJ9FBxZmbcIlqTjptJZs860JnRKoRhVs380OuRBewnLlV39tD0Xzz7QtbFv+UGI9FTK4vSPmifm7b51hU5tzUrcF4JxsOoqo54fU2ot4SqmoqsWSYrrdUUJy3hXLoSIDOddbXV8Hz57Qtjxhwkon+iQJT8xa1TlMYTHG5d58mXjAF5LDMacsZlAwOCoR1gKRqCR9kqqao5UcsDStDsS1LkIqhs9nQI2bEkVkW2TBks3hJRTUruYUkQ8wubYAXJieW6hjX1EQvtRLMHlNyzPKachoS5neKM1wlG5xG6cqjLp61vyR7cX1nfUIIH4BYD+fyrOGwea1p8g7ADnwhOWbvWxZK4S2B2CK9RPdqaJzh4M/FZv0ammbV3WHqTRMTavux+Mu09VV72Myvu01nmvtygjwVDudx/FJycawWOQ/kjcjgPsms/98Xs5ChaBmfTM6bM4T0wqenII6T8FrOE0L8GyjkYe+4pZ+/g352MIDtVhgB6EyKPSVAKerX0uKh+QWdtQMjRHLJcOFJzVJCqjCwlAX4TlAPOeHwGC7WavXzcwEXgFdFKAh8bxVB9yXRcbkSiRx8jgjyXLwnfycAD41S//ZiS0mJoHa/WPbRtF1OQwHY4du8GYbrtn8qYauxW/Cs8FSjd4tdsxLrKDTX0wuOHchr/UdI8FT00D0GKGqTmUr37C2vNPdUnklUZaXiH2gjAFp2jlyAkmG5UpI67Wv7dSVPH268YniZbMRBnA/sd6MCJUmEUzE2qBTR9GGEMHgMQn8IBHcGNmnU2PprITSXoW36lQa4S2QsRddRDlcdj37tvyyUcguOiUh4QKOOdMKxRWYzuxR+mPCw/U/FjW40ATeqT8So4vfmPAeRskVIezVQ7vP0j2QURpB81Tk1pwt3pUtplWshSLSAF8XZqaU4kpo1aLgOeUdS5LXlhj7aoI/nxo+I5PqZfGa9+T3x3BR2ZD0Mxnh0M/BvEVv9axATuBjQ0D8RvZ83I11UOuWKmZ6EZ4JiJpUSCP1poYmAKdH7X8XmyydZGDJXlJAItSkZ9c8i/NYdPuj785joYpObbAz0fgtW3stHcSff0+qtJB/V97w7Bhi99MFpINNon0ZDaD/GFeGdgc+JgY3VRgQ+KRQLNcLWppDTNWjzm0scQ6DXNQDxdrpQiMa5yLZPL1E4QjbxF5N5P+pgPcuFn/l4HUNt3zKUnk8Dp0kOf8xmtaBmui+wC2iVBwkxOBNsL4T9ja5rB2/Jo6jKc6UFxeR76qF/0zdF07gLttQimcm7/RFOeR94rO9oTEkcKVk1/J16+325h7HY4F1SmaD/m5RYvem0rWXnmbr5PMv/tjAUpnYKkxcUOfhJIp5dto0HkPTZCcz2u7N2tKOov7U++oaagRRueoJ6TgK0C7t4dm9u5rHR0H/77z7xiL//+GPvWDX0Dp7MCZQxUh+g+/Zb54gV9GYyLyoMhO/jU/BYFr6bqc8dUbg+NuWcjU6omnNhdbpGSULdFrJv5qGnXSwx3XQ3yrqF1cvJX9QilNfGWTqPRIcBRYCHiaNRIqmmDR7uSHw/2C4eV7J519sHG0uXjJ9NkNTWzf8kndCR5ki2OQ5YTKJorSaHtIfZ6HiUt4iH5MlPQKeazqpVYelKlxpCBNLfHTNVuKXsKOPUqyLIuZIDciR6O1PRKZYapb5OdeRmTQTJNV8yuW0kxJB1SbY7QJ2POVVa4eSqRoGEELMZLpEhYsDRwKjgQVlbTKXuVgmpPV+LuWRM/mFT9sfjWaI6MWcbH/wmNZSb3S+jcwAY3Dv7e34c6NyYaQ169ljxAcbbgj0oJId0mIqm9UqQ3Scr59jToE7W2FzLCQywdHtRYq31Og6yLq3pXBV6qI8rJP564OjcjuW0t7Xu62BtxXMunhhSSqIEBVLscolLl//qkOr4YsLGHxRxWh7BxMzzG3fh/5Ad3H4l6gDw1s+7Co8J+zY0nzoHK76UqmvK6eoaa0/l4Bau9pNcNM8us6TZK70ijdW2fh66StsD2S0R1DrFAhJh+cMxuHX9HMcXTT7JQfYvQl+UPtiZcncN++xiYTj587L7ZOqx2Sm7gYsUII2KA5Cc9FxRBpB52fZi/LIf9aIgQa+U4DHqwBXTWlKI4SeG59GwGIokf8hqs6VAAF7oaGuccVx3vrHHr2kFxtM9AoOCppNbrb6xxf7uz5yRzYi731xyxT9EUnamr0+uw2A43i7UeJDLK5lof/MuAJ0p2+MUtRj9AjkbdYY59HvzxcJjFqRGmHYZsIkl5vgjKj9e178kgNPCuDWtVLUef1y/CYWRAHcPSv8xoK9eTKTcHzfei3Y7SeVZ1dxBKVQMLVttdxHE1AoHNOufyBQGkrCEQ0meV0GSFO/xBbDuTfRHok6/mn6YBOJWjrxek9WWf612tV1n0hdmvHSwFePJmg6gPahWcg/iSSimXQrUHltI5TCxKRUFjGXZ9fI6uGLNa6W4HkqzRegTw7nzhU4jTD+dEXQSbeB+rNM9BlKkkmeMEJt1uaG37d681A5r5pNYQ9gMQ4z2ft+n5mrIEvz6ZBU6luFVWqmetzy3v29ct7DGOLi55X+JIn4PywkidL/7Cam11kTudkC645otf7ZNqOFe8qdkdmjydYJDz85EYRpahEKETlgluodRcvP3zhpGmK8QEGSeIXPusGVeMCNxi/SFKYpqUkr8srfaXkR2O+JbeguWns8KGK2u3iYb3I2dv4mgjPrXeqf5ff7oYauDZrNQRf791EjfFyWL8XtXO+mwf4VCJj0f/EbjuFRBUamUCkpqH8r5KnqrMz2amoPz6YYGawzxt6SCO3FUCatj2JYeIcGPIRFb00at0ztxu74c6H//MPHjMautyRp7hx2texLSubM0ujFqTjJOxWdAWc2fDM4sp2sk4fwob2yVvFtC4kuXTOdw/Evlzh3UywgCCtdRFEuP37u8NFcjNsZW+Bly1L2cYz0EuUT3C3G5US+CVR096It5SGM/jqGp2T8aupFYHc7ZMwzyHuPXr0qKZVIWiRw4GnrFb3TaxMMFtmoTzvWO9dR+Oo2+OAJDDdytBIAIeSUoQ8VBXok9MaKUCSTcWKLZw1IVZTbmboE6COcQGZna8azvNUiE/FcCNkZoM2lkwfZZZxp45kJKkXhO+Yh5gHerCS111sRO+aYQeLF1Ioxq1MpxjbihTE9NJdoOT+eAsCMq9u16G3WhvTGXqs/RKBXaRXM6OC2+jvxR7BZuKpx6lpzrBvJzVNU3oiR4Q2y0rpplTalh5b9mFlTfT3r1IxOcDCbhz7NGawm8LqehBi1CCJducq2F2mgg4Msc6a8Gvzs+uCK9lLSk8jnp38yY41Y7yXqqMKWQx6khKlOKOnajnL90lJuyUI9xGgHzbUogeqtp5ej0rGvwOd77CsQm1jdHB0D8CZflPaliGrVw3A/94dv075wAgFVAh/tSLTmphflTYGRlKYL1SmKkdoo2chDpNO+Zrt0sWi90WU+PwdsGklIcr7T2Pks66HBKdVx35Wvk7z1sPomwsRiDkVvd/852r2pEE7XP1R2tR0YR8729d57qqGtSMhowyMSOQYbUzMZOpMr5BP4RG+5PiFb1FP4CyrASyjJjNukpRJMkjN/e9YeZyDQYbzDh1Z2JvozZnw0LYEvqSCQ8jyIKEJy52jFDpVcmDReC2i7Io/Q4k4EHWyOkA7r0OJ1eD7FE0jkOpR8tsDzbB6FNqLJSQeemN0Nh5PJaWfrMrwgg3sohgtnGBTHyzPMTTKSbZ633vnk1ykQxoMXCDGDmmRvE4AVCnA7B/yYHUHhNAN+f8Ur7dhQotC+uzxelkPUwC61o+tvh1ungrQaaOYqLb66pk6jhq/XtD/+JzvF7d8abLnkcqz86/x/z6jYO6mzLKrqLFDLW9cD+yfYSRapZFCKiBIFYVrd9S/OXZX6I1tDtNwsBrIYEThJ9yrKPIALasbFoBxUp1GamRh/lml4W0sjx/18kzBCycYfV8hFkKX3sasGvh3NoiR2s5ZRYYMYJeQZCsps4Dijw1N25ozfcPjt93zHoyytWq1CLQyDT5OQLOLBLnznGy6QjqMmkKKgHtaZEx12yW5PumnD5Jj4SG02J6K6oZ7AgvKmBpWELxAK1XkVNQUcpdo49wmnC7oZza1FmqJMrZK53wvNQD8MLnG83IHKxqUCDjKrU8seWAR90Es01llyq7lAz4y93DUwDC5WdWNttMjUDRzazfO7hv0vaOafIXFZzcbod/1fNdo1ah7z+L8/rk/Ddbu7GD9c6zbnwLqYsex97rMpnxPhMPhX4dCmE4uvS0V1hLlCuW3MMdvtzK7HNInhVW18FZcTO9q7/+QK2J8mWNz0Oolu2wCAPlgCT15OFKOPaSvhjsw8zF8r901eCdKONy71YW22k0PZ1Xw2dNpXIWzQ5uZDa5Jnq5qO0QzK5jrVLgl2wqU/3AH3O8ERA2puTF0+wT7bEFL5UAzas011y805xLKUuFlBgzAwgG2C1lGsd5JwsFiI3xIVpx3v3zC4Anfg5PzkTT4WD0bi2dLS08JlpwONz247mJODJubvZVaCXCCr04bzLSgAgOgik+c1oViwWBmHH8aSAVYJUrZDjMlBpRqJJHY3GHZjIi52gzHM+0uXxSg4fFQmxmC3BdDoh5YzYLs6YoEFTqBjnQoFxTBoxAlOmwoIHzwFWSkHc1vxk5lJ25K5+I5HwlRQkJ9LXY1W+DFN4bBAAnpIAsgWerlcsPG+QyJEhQv33x2M5tMx7+7PLo2pYZaAXxqnkXZts4DnUnsfG2alyfm/511DIVJQdPvzhZaW3y85gsDgHOuq+7Pk1QwK5xMXygm9Acms594A3AIirwTBgg5l8/F1NJfeIqxqFzTsEbeWupH5oLI7pno4/JXrIqTtCVYt5ORYdU0rN/jp8aLfKFGQolLZyDluWfcqZtg4O05WFqH0G4BegtbxuoTZS4jGaqFYmVXterH64Otu14XQPnsv+NNjWmsx2/KpXPLHvrT/P54qfRsypRrX4tny2IrfJAdkAkKvWO425g4H3QvJBOSnHCYmCQtTsoFkjJ+NBItBDDV5oWFHQvzph71ADxqHcGEMFL/q+QVRIl6kheNz4wxVAXECE7qSj+11+GiRl/Vg6tVtKYnyAqdoxbnN/RekEvl7rYk5F/ItTrZsZWZlz3YCTFJwhU9AG02Laqvjmqi/GcLXLRxem4+IJWIeYYt7QGXuON2RIwJON07H64gdQ8g2Pq+EUoRiuHz6PKyLDUZlr53DC6bt0tUHvB6L44qQ34qjCJoTnmZXNQ864JO79rVinaA3dYu5XymbcnwT6sGS+xaaXcuMBDXvoCx3Sh4i4cxvH7F4HngU2vvkdOvRKFB2DosspecJnty64sScJJMYCl9TZuNkjQAtQeuVm6oQRwkWewtPJqXyYIfACU6ChQ/+fuENUDoVKM0FnzVVZc8fnr/0nOPwkSU7kNb+QBg0ZDhIoyISsCsx0n5oMiURkNSgdDBMQidte05brGXDiH4xohUG2bman5XrJMy6xT4AdLlsfhtVFVCdiCwph/D6z6PWUzoyrugMWLyth9DEn1rVAYOTv7k4B5YWHTsRn2v1D4JezQF56kJRdtuDxo8VX3d9KvYOap2PF6s3Buy7Lzah3L8UueT2nObnq/azucwllbO5/XI7P83+F0QDxS7YQHBtcZ7bYLkxsfuN7q+k7hMG2FWAQNvja+X32wRaVuwP1cctpaxw4z4oziwLPN26IRmA+og/NQcLS406V6vYqVM03NSdClKQWDtHU1HtEPoHOnkY4cSrwlfGuEdK72BIKRlWu64Rr82jYSY69u4FJqYRwJpvq7QJHJ/c+gzM4DSYta285sVDYKa0nsl0aK1ru1Xzkt3TAN5of0iIN2YSJ+cOdlJjyLq1iLEI1BNNkvoRGvgs4vC37TqbE5lvQDKngzxmA0C7xUVjOm3hXbLuAHOrtRlPXYOHv1gs75LS2Chj69DahNSOqlQjDSmm/eacFx8HiJr9aOpYGIjTJSsWpoNrgy2FlvEKAatznXY+Dt27n7ujDGy77k9vZpIzOqAS18AMvI2y1mRpI0hp5FpTft/QGavmVmcU2hptw/jKSnUSXH96JrKTH7VtAw2m1for4yYwBLKepDtbsvBMLkZjdpCnZt+OJv0qMjmInZ7z4kuyUxwMRqOqkZWNaw1tx90eqjTMDwZUSSnlUwXsnoeSr4XAZXDisx8Nw3CCtCHOYKcXfqVdanGdUk3t1O7q4XCAUveUlVUqVdQEV1alarNqMhpU3G8WT8cC0EG/ACoQCYci+cmCj9YPbMc9DiuKWtTDTKgk1s1OsHShbJlqrwGK0y0c2nNaHm5T1tRd2ZKTUFL0/72nc0udEY4aeVKp6cuPF3JdKwgUxtnDdXASgJVQm5DpzAEqolHqjKSp1n1OXdc6Nu9yyY4aMAM9pFkKML+c1RKtWh27WRTJjbay3LtNlgoYrT3+G3m+h4lQU/VPoc14AGIQqRCjDTf+jN+8xTzBH7QGaaddREPU2G5MQQCQGUZTBXccTl1s00D0wZVGmW9xpMXtcDJTBIFdAWe4AIcd0iOnJ+7VZQL01Dy/MTot47ndKBvTy2cn2Lgol5XlIpwrD8JFsuWPTwa0mxYgEFVK/+tG/e+UXHARnvdcGeR5vMMfkaXy+sCB419iyCBn1NfOf9ZlopwHADpH7HIIZrnFiUmaxLSQ1XlZgJtQ7iJQkqF4EIbEiI9DzQpYYAIsh3JJ6wU3LOsMLwng2lpWzoU4Gh4XypQhENnEu6n60zDSWixgWswnS7BBjxL7n3tDWLvAKWbPxfMeRQVGgwOh4fAMwDBB6iJQmiGZYGicuFPhUBecjZtQAsAAgjpkHvVOlt6oqXVPohGxNVCEGUJTIbfaMuU1Knd5CgCgZR2f5TfdGiKKo1vdolCpGKX4UjQEyJsoyjtOz3jXJsc7YfUOVO9PYClqkMR+EwQOU7dbUiKymEiNM4Jik+IAG6eHIshnTBAUydxhk+e8wFyQrDxnIXMCV8HOYezqKogtp9LjjePra25Y6nbK7lCNAuc8VFqaSk/HISokinGWEIpTuuuVyrZOGdM/ZWpC5EZbw7iv1tVRipmm/T2LauBMtigV2zowZTsak4Q1NYYj+/Ce4vTm5IZliDuiCk9l0M9oor/ibhgKO2Jx2XMQL6fVOdUQ53/PdKk3BA4cWVTUiEUhqg4EuGRecCEypS2u0qj9qdODbRCc4BRyTgySFZIhElK3MfiGI7nXDtghpyfVo0qiOq9oWgtszywW4xTt8k9Qoph7IDn1nZ3CmIDez7W6dk/SS+KmDrJ7fAk+kfweJpPV9a2pjFyxKjhqg0YLRqMdd01ikq8s4oeUvyxMZZqx4BgMAvc5FiFnYTBDwj+VgEgFmF/pGT7CmFZ1z2ozSGZjOGBBM0qY3w3zOyZXx6iKXN40YIMWYk/T7K+TneYxFkIom+20R8DDdor+NP6nIWuvw9vP7QEezL1Pk8s/+wsAjZ2x7bb6w14feNhvd49C4Aj2CUaktqWlttJ5OmdCBjCMrNh8vj7Vc2DFQyhSJQ8FSWpgfZClQlranZUOWYQm/e+vHrP85utDCM+Rm160Cm0b9vx+u0G+AwC9KCp2PfrK8bOIOsxfWeXV1NuyJTHU8IiYRIgT/obE8XwS+8fbtJg78H1Rm+Gnp6hzFPgqLTU1ISV5pEEcM10rTlUbi1ljDd0eokYl/n3oJoAQlHCSg1cPCDfMi6lV3uOqKLdUDxV2yR5Z8XKJ3AzCUHqyYEpAhB6Q2NNUPADWg4zDkakAX67ZrtEl+BpnMXxY7UEj9+h56K7ciWT3SeCv80aGBIqaGhZdn/kOt67cCEq6DMCGhfOaNOWuuI4T56rEDAdxssIcRqku3QWfjCYfEr1udImec50ic6QxR/NRrKtataatX4WhxsQ5DegnOAdINj1SDBHY5VCym5ZFXlAMgtNueKPqtniwgXNgk1Nd2C4znYowTpeZ+G4I48Ln3KYTftsDROjw+CyVJplqOBiZgxJpC5A9h1ZczKlr4M/lHVshwfwGA1ZSM8OWHQ1Y92ygByhwwVfrmYc951mhj3aMhpbPyKHlAsUWD4ftFj4GGTR6W+9SVNL+BP5KMhbzVKs2p+RG0UOeH+SATYJOdXx60FwIR3e4PdJZyzEy5ZEI5vCMbbeW/dqB7kUXy4RaULwzt62PK3MLqNtt0hE4S70nwCj6+JAFVtwonjZT+H8g21xwqU7m1m51z6ft+1o7cMiNPm1S+MaAbGaN/s6CPhiCxu5aB1kKj9sRbdxsH0yqvdFJPZP62X5mzxDF5Gu2bmu+QXQnhfx1r2orR5sW9zfnbRmkNN15aOuaychouxXAD3AXfkzp1cqcEJIztTmcqtuDdVUS2pLGtyrObAIhhdZuZ90h1pJS666iomRE8LKrEElmNxRkyRyb0uZe4JtZ5RamtZHRSqlYYbwuRC0iwjZQ+pzP8tsfDnHUcMJJnK2P053buORiytbvk/v7qibZj+woCy77G5LhmBIAixU6Au1MQVJOeb2Fj7/EWZmgWmIJZUErho3jk5jXxMOJ9L9EBobWfND2PQ+JPQ9aDPT8rRP310ho7h11F2ynxmcs+LWoyjc6qfTY8W1IPBJID6c8Hke+oqDG1UO21ipuKiLOygxq5RAzuPSzK+M60u7io9VOt7TnUPMhRECiUYQjneVxo+4bvTvp01rVMwsdbFEwymbxXHQD00C9lsULIbPYDIGZUQth3PNoVAAYUYDAO0/LEDT3dtobS9tg77llD0F72sjytBwBY/jPV+fjdIWhiqDZhVw9VpMh03dVFhEjdAceXP6MW6g9xgQXVaoR2RDKy5WNSt/RMq4Qj2E0706Bm9JeG87WD7b2cCe0ZZ/lhbFkIptPYngywCEzQV80O5enaTGNY/Fd1gL1KsRSy5BE++JKpd/HOnQDkqg8FgdrT2+U+ZBCPiIUM7sYKCoa87M4NcEpVLsqMDEGi1sE2tU3lLfwtsGHsiFCTKKx57n1ozNb22D3peNPgw8tNpgwm0mn1OhlVpxpfPLc9oFkORsPhKhylNRbtkbgDxtnrhVlOFZkPjYFoFgtrfyAFxAb9bissBNIaMvPVb1q6rFu/f4AkiSKPsW/V0stAqapwmxB38DS9RyeZVGYij+jLUFoWFjDUrRPy08dbF7b5ICQ73vkl25H+dtbk7Oqs2bDA3vD2vrR6xJQn9GCvI2cTTCo46pge1UoBHY+yX6tqr5Y+rsn4wySI9c3qVAtUFn3/RNE2zmWJ8TSCdaJtmxjX04Z57m7qfFOf2rdelKIZfIpr16a3ZQ/ZAstDE+LNJ1HtqK+ysyPufIkjiXz2UTy4CnPlqBRSRZVxSXdJ6ZnW8DcCO8eWFD8XCNSKKaIAtEusdp2q9C15xCuJe3rjjLvVFfzbRUd2vZcsJey/EyemK04RnpBVKdZt+XhrQvTF1JPxDgspsI8AaQ0fAglCO0xZE4y4MsbpGxrDbkWnTqOnMUWslkMsb40+4BHBUPnIUUoEf6OIstaB0N/a63UqCgJoOduTdFoZqQZmIMzmCwarld9/1bGnhbnWQukpk6a7XnOtXnrFaDpvtzcppoKkaqN1ON+RLaVr5HVthoDTwh7WVspZZbUMBkFM2k0heeNOgW2d+4BoHuFMK0NBqfqqVLBPmq5qLcL1YXGyiIlx+14r3mrHdj65+joTvq+dec+hi7sAV87RiZOpxOUw/7vS8dzDSfY5/JxejrtDexy99H5k3svT7kdt/ntWmwt/GOQNVxJ59j+uScyTusela0Z/W0v1uRtur6dLd+iirMgqN/s7QsdgP7WdC6aeCTM6qctm067fBZKSB88E4CJWpC0rbUmm2x5tnWnbGzdqgVJScvIvL4zFwf2u74TXutN7k4+D23J+/j7jLPhjczeTxs+wm+460T1J/kOZv+vQ7clWC4GvTic1ZOAeKcyHkeL1a7t1qwBH85OAeU6WBNNIAfL4sUyS6fYMm7xMeSXDzjYm+R223XDNJSOBExpIWVrfYIsMtZtwTUlh+UYVunuv3jD2YtzCx6dik/l2SJyESNI3tAPCrn+VJtyRn9srtEoMe3TK0tOYhjYdTzEVgbVEl9KdXiRJcIXhAwAde58DzzvcuQe7itPawMbijEEikd5D6hsTl3JmF4a2mzScdaxTL2pTSwpC41ttmlwexLtFHLTbI2BxZ7L0mElF6Jlm+uu0OjsXu/Os8q6FrtBWMVTctGBw+fKp44S5oOWR9+bHTuZba2EiwN/94KFi8/cSfn95Vv/OSMq+WTgUjxYRPRU8FzKJgir7t714ABfgENS7YXEp/AQIx2Z7in1HmQSJm+bblAJwK67eoFSoMKr3eFDSokTXuFp8EBoFB9Np0LVWclHq4cD2SDrdHkQxRBJC7j6BOsUMsWwCVoFGiqcXD1Jg9NlIm7EeivOzrkT3veoZMudbnuf3jjtxy+SdsMkThzAQuV6ewFFc5dY6yZYlXpVPQu7Km34CkDd8qjtdZpBD3SQxs4A+8tZK7siF/c+TLZyfIy2fdA49SFgEi2Ym5TNxN8w0Q2gyMW6xcSa21PLYJr2wfDZ8Lpa7ftCkbnSK+JOWJnKnjrbGhZv0alGJnomNCqKz4x85Rkc7j4TpLfqjtIK0+LCg2gGx7w4YuFK4Jg+hspGw+aiWYL52A1N7wZBl6PLU2XnptCyfYdkP+Z5EFk8/w0+evWuzYY6re5z7bXzbqgZAKBDiIoh9EzsybKOpXaNdz0g8uCpMcM5cUk7Fiy63Yu7QHqMAg8chw/Fd5tsAXkm+hiO1XCysQzBcJBrUuivk5zNSNEGEcOvX+3Vzl3YlIqVwK2lmY/ffhfAgzSG997EAVlzUmjCS3Xhj+i/7QBMI+lyTsYMsCQgQuOt1zipO0qtzq1U2tJ18kQHlkmlkPHVE/ex8McAgNuy5KPk7kWF2AgnsiLoDMd2e2ewuJbEHpDwilXGc/BpKKBnQj3iTkqCehWWY6tCCQQOGzYC24bSw3XDhNg0dMXSb7G8xJYy+hhHL1W77z5olI5rZRztxpfMAzjCCXBivA5EmCq7yiw3HFCxIrY2eIv+6ovAee95XToHjh/spXE2l0vjcaXcal4rQmRaAwv1HoDNl4MfwXDr2qvsimMgWncdXzM/nGwjXPcZEV5hi1Has1sOUuJgdl7F27FcRxSJERiMieB9Y4JhRlFwQa+hXtfCfErOMl185jnQeuuVR6Cl1rKmIq67HoGXJyu2prZr07W8IXpiwhnwXliud9RtAZ/EaYRxwioXRycx64BCY3p9eNvZ5pB7SadV7S2Rnt0/ZZIbaf00+4J7Bg6aJDOgnvj3aC69a176MQqvfxvett2wLSmGgerG2lBBzSxJiydR0l5akiE7f8CtHVSo/7+xaxhJD5LagzSEmwKNlivMKBcB/OzufEB+bTbAAKhSPLfcLHwjRCUo8hgaErhzHLqvU8jx7O897NXyNoRzVKms7E1bhX7GZvPrCv1HD3cUQrexQ1Rng6ro2/26or6z/NAeHkqMN5Lli+0uoJMDHkk/X2m8sPgJEoAmxvjzdYr85LxX+WErPHr/cHEp44ZdImazYxhZ44x2T2Q9KXwy5AzFSM6TQEhGNXJ0QDjJgAMyMxqIDiUmrw0iOKfQe4Y36qCQ99BN7HL5HBJewcP1cXODv21Ndev8dbzAcTfp2eXawFRMJjr1o8EIqfIVAjNKIJooIbNBglYwjyplZe2RUwFoGTabX2m0Hz3CR9C/jVzojdMdh8olaf2UVyiJP3uKtsnz1dJ9D+Ok2HCOo5ovcXMHnSNfdN7zppc9mE1HbsNMZS73o6+3rw/ylbomCPW1S12hu+3dx4zNGfO1lNj5GPp7QqrhS656oRlCJnwqwKNucbcxPhDpeuhOAOWgR+mWnOAvzhNxv01Q1YKWg4m0Vf45EAiEa6j+4kGj0u9Q1YBWz2bz5Vbo0d3z3+eb7n5Dhhj+h5fwDx/1w3pNB1sFBvrHueq0qickschOOhEKp9BKx+wyabqHIVnFqdCMVrYyT0gBHe6obtMCfjrCD+0DvZmqrkr7Vmiaorjo+pSSz0PXQUKtsVn01zuH7vjX8CexpmE5/Ug7PLnkoa+FNyhfB8Fltf9PHOFYi6ZYOMjJHjcKNBBlC28hZv2RbqPcjsb1YqM1YRFGIH9Zgs9ERm8uXLywJww82lezalS5UiScxW4TDVbedk+6SAIrKWis2juxc8LCGbXG+WRo9NBWGDA1cS088KUx8XWHn2/5FsTREYk4bjdaIbnK6M8Vz97ndDoiR+BERFmtYSUegdM1ylZUBFqVHrZ/CmidkvzTV102Ol7NsAugWXz2CxgQgBS+CzcCcTSrp6bJ0i1ZSVNB4xyKSQcWYBBKo1MXj35NgxIyIfElRC/F6pp+2R4H1wPL/1F1z2d+fikwk1fxmgNrxe444aTGjd+Zmnm/aQhEDNdZ1WrjjMlGrd5RNEejZGdYTFGIlYIWl52RAjw+B9TFNCAT1bsZ7An4t9rK6wg98ogNOkwWL46VFLKQlYlVXgjFBFfHILFuRSdg84ISzzOeI89cVsAUc03jez3gcixuTVtKypzhLaKx4xsmlTuJkZqH1p09pbeem2aDnbmtOAQNLnoMAfxUMb/sYb7UCqz7KH1rmamhyXqI+UKgVzNErLz8euxkRztNXOat3I4Q6p20S4VHWPPm0IGl+ycLYVHxfTeWtCpLUgtl7j0xB8MIgjPEwSXoAf3IOR1/cOlhWBxTLGp6Z/USpONhPPEE71JrjjTTeMe+Zs6WuWORPVPpZItd8ooTyfR1gMSzOcvkGH57jtUEZ8CP7UrxCwdKL/dmgFa3zF+5HSp5yZDLW02hIFavJs+hwxBDm2PLG2T2bgls3SfV+JQxB7HcjzQ77faU745taMhLCIVYcPewOG4uKfiOT9BFRalzekKzsqCSh1YnuHlHoNWFeu51GOTVb7ynfEzxwkOGA5l+tZcRJMZNUmxubRaIPJnVGcFiqv3hXuCBgX57QD3sKLajvEo9qFHkqcRctTHqwNm3svJQz2O9tOGcYQ0bsORDGm3bHVpILepFJcOxjCQI5RMvHgHlJifS+Ry1aUFYFwcw/UkNVp2y1Ka1TIiT+1BWJTqtV1kH3KuBPgWAJoA6SaijksogMGcAc0t6ehnIfMwhL2R7co3InNsvT6elsh9TY2ilymnNk1D/Y6NIRntoAu+64gL9IYAkabcsqYLM0hSjrmghTymdzBIhPYO7KiZTPcj48C6cQ6V6IWcYxeyEXsFiTaCR2MmjHnKYXx6GIIULdkIiDKh7M08mk+/Op2C42bxXP1KWIml7WLO64eEdOSYnabL3tIYnGRNHhFOASP59buY2qclMylIsDEY1gz6ak34z46hOqkILozU63o+pMCKDYvP1EY5lK4VqlLKUD4CpBh9uRu8oH8Qp2QDCGtgHsV9VQp88vHO2ICWaEkzjbD50W8vgV+Wed67q3t2M360k260DnlfUrrLBF5Ei46HkzaEAR/ni77dDb2yvor3sp6M8Sb1fdSYXjNPIKEpXzKINRgPGiXimtuR6v1MtOSFITNAS42ri8k1uh40yuXE6+FWt7BdmtfnfCV4uj4inJUOyB309u/do5fUwREY7yjiyVCp3BDri8R2e3gip9vNV8KQf5M000RZf1vOZpwoJDTLkjpxMblfUKkeOiHtIjJPh2B/Ks9+IBhsu6Mjr5tkkhUPQPmrMyCMcrH74B+LhgS9xKknbzx6tqZPYUJfv/oXf9FQS95XNyy7YEvP3iUgKM+vX7LLoimvaE+0N+0RlxRzujWw04QJ4gPr7gWrjvip5wLqRFf6UyyCk5nykN9QeV9bjqDFvLhzIv7DiaPy7CgS/cm4UJPeVzcs1UYT+aLPTbhTMn0EheXLGBjwhGzw9Dnc/tzHuMamhPaJyUXn4pDec8L0j91JvbYVfeNBMyLn4ugdxOJ1xcfeNVEWWaPZ9Zjexy5niJDR74veZE+fqxCL4y2UrDU/mceLpCwxiaatxHUKXtsOLV3JHOVddnndacmTJN5cx5Byr+7Hp4UNH6zmQG/Mt0C0akjCneGFCxDU5ENruS1pZHjRCO6R4ZBuyuINS64b8yNWMfwwbUb9sD0g8JiWz9hgNZGJkeGVAsX9cPk0TnOp43rZKzdoUsplqiN/tX+PjqVQ6UCpjITGnR714LVAG2PK1ww1+P2xSX7mPa9rMeJLIFvjXGxRDY7qvdV9T1LWhtQ4VTBx/pDfhngXPqiOdQfBHc4b85PunrCeg1L2zFyoyC3OLwSbTGplYYS6W+dCCVf7iGMut1WuVSrWSyyIK4ixf485oPiWMd5UOixxg/mnICm35gVy5LNMbxxkcwYAngsC8Icz1RqqWUG5i1Kro9pfllmbwtnvIG8eAhcxuUw6jpBbFgcu6FeUN5z/fVEq1lC4w/p5stVSq19uLPmjPrMPWmIyewUaUODP/0mFDcvfdfRDGQmOpGyV23UofbcMplx0LLQUudDzb0lW1mx0jHW25cqfYHfU4VaLjFf9rmwgDmbEgs1R1OpcCVh2Aifcf1+LeOR18HC9OXvQQE7OPROea1z0jTaLFjmdpVps4OqDafeI0R8ugPrDkLkusHsx6azBWWHbPhGmJ5OUQgRbUuMrrP9xU1S52OIzHZvG1JvMA+R2oPRqUM50Z6ZypFroStLmJVd65kWNz1saonMquOohRI5o/wQG3Mjtk03mk7QjNL/GsG1OyzmoAeo2q04KM9mom2OdLmNqm7Nu+hbZApOalH8Rz8ahhRz+NXTEMwESfFgtvKKshdgKiGtottSAkyBn8IW6Dio3E9WWzhnCnNOeElHL5gqSWKcGNrbhSIxQkLX3pK6CVg7OUy4loi1j+z3HLFzGhhVzhf7fPMuAP+ZP+rH+d/7vcyerdz795mHv5Nmd85u82WzivKKeBHHIuWeEoO3hDJjFEUCoX1Jrbviz7zOdSNr3Z05ztybV7Qn6mbFhsh1IK1ziqB/NClQ9MZ3cp+6Cj3xBnoh+a0dpdQIHyksIWFK5UFYVUkydVGkfHFjlW1e3lVmrNOByenyfuqFZ4LgEys4YvVggCdbgnqBYFeqtSvjL49gzmcgba9ZhELzg0HF5pUquxbNYpMVfZsZTyMqfRzTkNV0aJ33E6ywIzYZ6i08wOZFJwRZhY/ZOeE1yZtfXZSCtwE+xmuMObX23gx6Jfz2xy0wZy7omjcwqgOKpYVzUxq1bqOomOzh0OURByY11ey+SuFCY92rU73AZ5bdBYQtgCDbIGBoEIRIQf5LAfh6Nfff/5ouVEQerLQJGU5V7VDJdVbYn/tbebFLivgsCdTLUX+K5DqpBgcFVWBRAAUsik3TGZ351ukgE+0VW3Z/OAcmI7Lee+CBBDYCU9DgDmc3Az2eAL1Jj0VVJLUSbfJ0u+cp8Odtscu3BnM+20PfB7yBH0FV4kn3QCk/Ycsql2BqjrrXa9EY+QqJYSrE0N0kaZNliLJ9laOwGB/V3syWNUMieC/konFw/WIKXHjdlmGJPWNOn9p7qC1A6YFk4vdDqdLRx0m1Rnwd2i4FR4S23dUrfkyrBA/677JgdOJ87D/gqjCAwvjYS3WmxDkwnbonT/zuBBQA7dEArj3MboSjaFqClkqnwEXSDq/02i2HUfyYREtzbKr2gPNfudhoCADbYLjixDSu8/oCXQNO3gvwF3j4GGAOj7GXAfgFs/A1MM4sSjsSShS36FMTT7BWkhngeXHYvIVXgEJJCIVHnr1tkCAkmBZ255xtZLIIIf4jcbwBq+0to05Wfh9Dixm61KDorPLyX4voue1gQMlT/KdxxB60I3HixDw5IN4ZhVlafY+loX75Q6i3Td3ikdh7OdgNWc3ydTWG74AaRpioxiaQy8oMdPdnNBmWQ/cSdewIEm8+28y9VxzLnWNDwJMmgtMv3IELnQxfuWdxw03az+h7Hl76gaLR95/3XeqvAfoyEhzkCGIMqQRRmiqC2ocSup8va3rNWYbT7OXh0tw2nxgM9xdQ0FZne1AU3AF0AzYGgExafAtB8DZ+bPEcc8Y/Y9UjtmQv1M7Ixp8NNhOTpK8YSi7x4L7qJdFEe0YuNCPBU3IxqmXV79AFjRYlDHESzzaukdIE3asUTdzKqUaZ3NYYe5toT3MTBF1jURalEw0pB7DfMSIOBbA3+rM9h6Reya7eYhHcvS7Hx4D9SEat0XfYtXwFB9ic0M/7OZSE52ST7kYfyzgDRNfUfslKWFA4hFOfnOAD8LJZUgpApaXUgSiR0+Wbzk2ZBELzwXqiEK/Gpf0gtud2O1WegTsxQ8J5KhRq0LNyp3A6M+pjidVDU5iHuuCXzqL7nvkptYyuYiUCYobZORuNji2hiW5mY1gfk+ov0nEOrerYmWQW+i8I7VYr6wDyXh7+6gsKFQI4xMKam7HRTkoFEJUhx3B9VWBG9T6JlJtlyyWxvHQg7qblOMEqmsfhwA8VMU/CTJuF0E+JFXwVK0jjjC4vz3AG7sBoo2i7ccou4oqbl94KCXmL/vMM6YqEYcC8771E3uVVCZ5H0YvvAuALJOq35BG8tskksE6EUI9HoC9qWjk0yu5O8E9f4yplCeYOSm6VcisZTz+DCXh6eLqBPFT19nMl1Bb9+Bl70bDm8Fln4Guh86BrQXQrSP2inw92jsthd1HCsyfriico3kVo0qpfjgJ/dACS9F+BytdtnvgINx0whL77VF/4Gj+qfv0yO5r7z7cCLXxdMKodZzJZmE1INrw2PJ63oVITmWjgPPTxhuJi0+HgTX3f7/xwtZYILBfd6sb83RZXQEu2Y7Xu/i1syuIduF0T9KgGO7QXL+GNWcBWy6DvdPTviw2twuB7N6LhtgGXUF/evwrdteeb5g0Fc0n9//Oi/PmufXDp6FfxltOZJSeMFxsJK+QncAWL5//C2XZrsWOw27FV0/dAl7NiEcSiCc4e8O5NJJIqBUJpstjieEBK9WXQWPb3sThYsN3cbHgOwF9MOcbDoZX8cpiiRxDIHTiRjfuqLRmZpEFqNoCkjQoFizfIDMyAbLeC25j0jeBAczWZxCxhUw1OBQWmupzCtqB2JwAlZ0R/P6qX7vKDjeVBt8frdhjYSgmlhh26oQ4kJ6Oh1e5gkTnfn4Ff174bnGx8dWXGdGyy1T5Br4ogiMrZ8PREE3Xnb87ePgWOLd7HunEoZFTyZ5vnUqk4HwlZ8CvnCFxNalZrdmISLpNUjcYafC4vCg2hyAZSlFp02AAsl4fc4a7STWe1aEE7VfVnUGLM/fanxwr3xuBJJtkAKWjwUoMrI+YzeE9SaNL6jVNqE3gi+dysBLpeG72VmSNWoWcxgmcUMyRwh2zaYUnb5VUQYzPoqlkkCHg3gOA5ABE7GT0L1081BURsjMSYnCGgUAg1UuDg/naeFGeiecWiqXJNtT4NX7uT2lNvLMDJC6SL5wdrPLEADQWrnaqimRgRx6HGjtpp11BkwrfDQc/BJ39+4zeim7aTl+S+yw7fSj2XFbDkI1tBjF0cmudYAqZDsAW/3PsRZt52N0nhbhj1pubSzXzFONrTO+fQtQPyLlqC4DGYroJG0dkKtt9UrHBBBkIJu9t/itV0Og+hup7NeVjVg7Dmx72BzxOoH8IEGc6nfp6mWsofE9DIqIxibUR0Qg06xDOzRtkgfmzhtXbvDR7XSsoo4+zkRDy7I3spVppEVu4bAEV+mpKrPvplU55noPdGjP8By8BFT1i1aiV8k16yC4hZHwhH9N+bgsGTTFOBEVysf7Sg9sXrYbil7t+8lk2woXP/kVbXNWT19ogPFeTtdGxIQl29Nph0vbRUXY5hYs1o5RDaF5O7zsUYD7HonintFZeAmQdA6txGzbq3xvvAMLoiVSD8RZQPDi/tG7nXEgpagaK7SwSJLI/awYTGqlZEkmzZAKzcV/T7ugVd1R91DRC6toUcUnCyF63mxaf9HrDYfl+gvbZKz9nthCc/zONbWN5kBIgTpN7tq7xhg3KTjb8xEF0o/w+rBcAGwXZguhKeGfNleK+0PqoBDBt1zLW8ctuCPiTS+xTtlqsG0N5we5f4Lez5XTiLtlc8zu0IY2HGJo71C3ES6qNyIkCq3oToAygdxDv8BkG0bYxAcrMsHXpzYygYdT7IRw+6JUXAoJCD/9eLTXVCtFL3HBCUkJOUFaiG7aLoCwn9nUn+3WCn2iNnx9RwYbcl1jTz23UY4Mak0d4pcGFSUxiGIjhU/0cRmrNqyoMRLgWv6xAArF34LRuL6pcj5JBg07dYLcbB6RFy8+F+fGiBtbxN4+KarmSD4YebMbpN0o1e+Spat5AwKACd1x2XoDdaDcYDKc0p29kwZOg8e8gw9I62Xsivnsd8PizC2/M1bbvPFba8kmyO+enTHnw1cgTOOOXRiDcaX7GvA6f1Cg/inqZDsa+MB9TumFrTCefmz72aQV/yvE89DjdgGOpcorotH7YBVC7FJxF5CXUU6CIOv0RU4SxVwiOGSU0xN5Kp6kBVgtdjc28GSTXH6KopGlWmpLZgiGa0bMksx4AiPnkEknNWY1ZQvrl6F6qsOFj/FFNZPFO74YNUoezEutUc2ZSRJVIc4gNW4XX89Uh0ibfn2UxatOJENS8dvzY+hylX3/3UQBJitQZW1ginDiAgV7BLCwB/D4WDwqrUvNtqSYRw82SYAnXOnZkgLUc259dHUYIKKF7/Itrb12cLcVvnSXZYOL2tnyLpPqxr0L+rSqsqAZ6Hbnl0d0PblxuA4t2aERsAlASVGce0YuTME+3rGvOkSwC+54x/r5gzaRC59OL4CcJkaHat+LkvamJsCpx6dKY+J7/LSaNCZs0iCORG+WBNMfTGmjK2qz7cOJK9v0+GQoB+RTX1jVOtjqzt++xtEHiKPt1Z8t+dfewswFItuzK3ZD16+DteYZKwUXHByQS9XBAMPI8S439ZHE2nb8avvDdcWyMlWG4VB2zbbUacu2wg/06Yv8f1S4llstkYSAkDexgUFNXMq7ZTg1jjYuXJ3BB2EOsjXYRxNg95WVIglYB+qOMIvFNvGpN20zUF+dgz8l2bXDAYtzrZIxDQmTPYhAilI7tfQrf5GGzVNoDWJxIsaSkZLNQvfGdbxhWcBnYM2EtZuBYlt1yaxqARYz3fVAhYDustALI5DtGG8rvdRQLoxhMMmLMFc64+bjxEpq3a7aOLN+Ak8Vobs2J28pZ0Dc8iUnlkFG8y1tNFU7zbuwXik9OzQ/xLdYq/oUCsyhlIJrF/TaiDskZue8BmZy4soCVqVg5zt8S08XEWe1Ao5ud8Oys3LtrRZ3MfGZFw8WjTXXpSV6ptekitl1DGC9+2dzBZwPwRa6LNLytbxuTOPs2+2vNVayI4hKoHkI6HvQhas7MG+ATNEyZhXgCeBZNl/J0yTVEsWvEl0aO2jkRyrjBIaB4GV8Qj6fqAhDeKqm4hhla8eMImXmuEKOfUVas5zXJhElJyvgdwk0O/cTQY+gMyZCC/FgbsiK+m1PJJEcp148QN/HaQwMGdNxUuqV2yNPmmfruYOyx+VNz4i01HaSAcHhy/rFiRl2FBEJZmzskmybNweMhaSll0XhuwZhQcm1O0n/wmdZQXbhQg0ZgSv36me/UToD2eLupflN8EYnDFPPAfmS3a9oSIcU2hzhr8QL8Ux1lm2TKxzx+iyav59kjfSuzlH2UBFdicfzLYGW11pxHjxwBSqd1UPXol4ns5lpI8wYMDbQBzvw7nLc+rS7TW49k+phSQxWJ9eo0lG74iQTYGcCxemrZo0yzi0pGkxX82I6WeY4bRvbyy3rBM5IEfpAlwrwfo26AtjwqId9i23qZlfaq+Xuuda0QJUmOPZUMbrBud5YKtuboBn3BATnqpggjvfh89JzOkHKDehayS9r0n3ax0w0v7VujrdvibR4eeuX0N6YRqp5Hdi3kYnkRUGaIfXQOg4eEdvvkj+ozdS/3h6FeQSsmpfZk76Q6hc6KwD0uuDq1Xngodq34b8+zyUWvTEZOilq0Wdl3iw9dAcOCPJMt7Rm0ehJrhlG+tLK8wocbJCqrU4vDz5wfVhl+urYgmteqTIKiV6t6qEWxG34TS05s1nsfhW1RsYMZfgmu8V2g4rLZwdTYiolZwwoJhTyaV7T8rUWdlOB+q6m2zAApBmYq29Zj69o/N/gog2SfCctmMiu5JqUu6T+lCsNPUPIR3qYcJ7BX2OVdI5iEYi4WI9Ih1LU9zTnusXYugKkdTId0wdVUA1Bo2eaWYKgeChDAYnn+pIxxsZioRtl8awYN9/mn5JKicuy+IyZkZ8ltMbkiiVh23HEm96SWQLRWDJtWsAsBqhhvYAFEiNKIhbI0szlesuyAMBeFWAWjMwpF/KBrEm0jITXjZ4IKkfcyRYjzA8LJIAVv0U9q10jbNGpNMbBNsUMawj7DfPgMyMoq5EtBMJ0c2cae9NgUDYnkJUJG2VadH5y4Gtz8yJMbxHDlKzEDt2kS7afW7HgCEJA5fbEOluamD85wcCiIcOvDmx2oz01bMWlCd/UVywzqhriKHlI6FTXpXrJAAy7eRILG0DogomR9Pm3a9fiZyBNcYoJq77/NPKzDrSAG7fwSpDPy+nDPoYyH10zT5i0o+hdzvnwVLns88KEuczgxgcqA/gkAdDjonhPD++N1tedDq60r2WVceHar8fu4fdaVwc1cttmT0CZXANrnOxt2bDVCXzkmi5qRRpPGxtr8B4t3Jb52SLShoE2DtFNkjIKpsUlXzWgd+n8c/hJ88OTFrb3gWvv5NCpLB82n0LGSwNKpS8P1ofuE8OG6Ih+6PYFg+lJqgRu6omsJyI+y0PX9lhoPKfTxC3bc9t3mDUxqpkhp1lv0hlO66mn+cmlgs5Q+pQSsPti2FrZdmoxWOtFHx1DEmJtT3bO7OHV6owl+Rx2aH5OHoAtp9WUYbNT8ncXLSxH1LoGijqdiZFzZX790TCd09qLnSt3aC151J61YiN18uJDdFAEnlMxQ2bJ8pIkNGMn4ZSgqS0f9Kguq/ST8BFSObtq1gUSlFk1wiHCAEbqliPqeYW11YI5bQAolYlbKCoX/dHcpgQvVyaj8st6pbwbQCfXbZJ4e4lGWih0QmyCIp2Xtq8IP7dKeFlwQZ/YBQ2jm6zF9uRkpzsvUR3GGvErmmLMrjlMQXf+Ek3evtGFzZnBlMGJG1Cqyqkd5Wui49Edp8QMOTuLo0UpsCkLN1B0tdxbkUtrcAyWo6rMeiHdJdHdGGYmNfuLCw6xmzSan/CJXaHZe+HU2dn6h28d1ZFkFqyMjCcdZvQG5tTckdQgz/YbhDyzSsNufrvJ6Ya3pDGDw6PV3hxrJueIoWeMMEew2vvsPzoEMBN29hNXEDHT+n4hJ1yY5OrEo5Z2mKxayzq7+ltsZkZlIACblPXKwwj22baKZw/DrB/wgRQQNMZ/6mituisRt2yIuaCGpz+Pcau0ZFW57jcCZVfUZCjTysUgmGv6YP2RkrLbCsMt5DNbX2NwyIYxsFY5zeMjNC8P+3XuFjDTfCyoBCFVk5u+UKrqWRIW+vR1TwLvNwKPNkahFH18ugRgeTrdvWDmNfHO0Yc3h9rT0jSwQ0LPX0ihqJAvn/D0d6nlvVPwfPVtUaEAKb3D8ttibm3K43tVb2yrHPNKEiHdvxpg1ZF+jYI7z8l1vj39I3IcN/Bf4GjiNZ/gBf+diU23KpI0ReM5J2mUreCbGInxLzXerDaQEwOrVgI+NoLV0yzpa9cmR4Nh9kWPtwK++hAtrcfueXfteejTGq9LOOoiZ/I7sIEvzXr7VVVJgojNOfYNJAUh2/q5V8Wczslv8KZ9KT9/LPZ+5Hxzxeb3eS0m8SPQ1A/XxE8aGxBAANyznW4uQ23bI5N6Q5GHdrPNmKj8/jdR14YpY5Hf6Xm6FKeg5WQyEfJRFigzc943KYmLE2tKL+zhVkKPjQosaWlYYB8wO3r1ZMq8tElxNsbWWsWG5mirZR87m5m1K8TzCjtNbdWs64YWHB+w8rAN2CBdGUgisdsJUrxkVg/juq5olhlq7oMEwBRsw0djhRP1FjKh/H7dbBR5KLa09uDvCkxPuF7Ly2VP3sAUSadxvXonFuAr8WZCitmzT5jLFG/tZCWFFlRARJSahI4pxUL+f3t0Cd471PUit0mZnMFnb6zURKgmctKJ4Kt/VFNL6M3iTLxy3VP09wZGjjRdfC1lNHv2asZIOIwUejTheN27ueBa+eAK3IAv4rzHhiBWzqHeb6DlmBjFcRwA8Y6E4fO3S77s2dnUsOIm8KRVHEyZyRSk6SGO8Qc9BFeSQmsaEX8nhKkO15UfPqffJMcwCT6BLSlk1bBJxX5m9sK4W/baGtAD1fpnrx/+Q3VJrzNgxM1zHaUrp3ewN5UGOGSfwl0IgT/OR8+zG1Vi6d2iqXY0rAa7QgrnSU7ar8C4Eo07bSYmjpQrNfpiMiVw9JazAn0hUWIluH9w5kKricvz0c2jxznjoOyFFOZeLpw64mxZ6yvGHXl3WhQHBxLdW7OdvhOPCh7FMqrhlgDL7wCrmX5aw0KYR1ZhNC8ktNqtTc/lFBf0GrN5zud7J9bFDW5QdzP1E/5uJ20qR4yyqO+GH+z4Wtynvs+2I16FKgLKBZ9DuV3LaM9D8WG/loDBXW5M54mo3q82oHTXSvxdPhT/s4MAtvSISmntjzjP6mQ8SrI/8lPVQOvwhpetRwFVsHY7UOZLgV0+wFHOrl0LDJeSFgHv3AkBheZTKNWCCltp1CEX9R2jPc9iif5LpZHJk6ntIKVzMK3iqM1NzsVXtTOX+SK+ANjQ1ruT8vVYh2f+CNZVDDI/ZTTWaP4MNgG0Wo8us9m2s9ac7BbaeXtxPGmY01vctCGzt2yeC+WfE8xsmEhF/JnqNCU5AuwPePx8BMnygnpSKjgOc5l+4wuwU8xSe1KysA7qIDHK+VTeAIjtLQ8QvKE4DHVG1y4Hvigl1fLlnSuRDvkrnAQRRMaf9qUgTvh8OXUJ6Mme8q7PFXaYcYF2ja1lL9m/tpz3/zkaeA0wt1tzpdRhbVp9wlraDgBMVP59NQteL6l3O1YZyrsD1Y58IKxWD0PtM2V85qU6sAlnQJzG3z2uGgY022OTBnwexTMC8HpB/pxWyFZwIixeRolbPe1bR55f8ALQdn/xRBfg84QuLl4AXuO8Ur7oqQKJXdJ2RVqCW2EnUtCEUIyrsACjz0p8QjRX3rVSvuok79q0Q85QxuBu2VllwsliK7LtIw0ga+0TkJ6hePTLyjtTj735c3KO2XEaO+rGFpmc/rDJXYHvC7Bm+ckKU0bZ8e67PVQCFn0XMLZUzccLiY10sjfbo8CeaNbOVRhmGujwyy+OSOj1VBjpCdXsTDINakeuzeiSIHaLagYAZdO1aRlm2zyuGbgjxhoTjX9/fufZqiRbOeN8w7x2bgce8to58pJZDWi01QaKuoIXpa88rxp3+zj/0tq7V5gfrEe5/NVGJ8nRe2KPngImigCKmFAlNbE5rtz1xzodTwaZzX8CsmYYdVei7v4hyLlPXGUkSVNwLFi4jZdh8XgKLWjV/3K12E4qp351IpRf5GW7TOl6Q+/GdOGnQFCD0Jmqe/V9Ut6YVM15LhebDL2I0Oc9OC+43zOgHgY7+cK5lhdKlzXpbeC5Y+LNpgKyE6Cdq0Nkrns/TvFeetCuj2jSVEo8H0t65TyfSooEG081MtSWPZleSnPZJynyraIE8dyNQV5y0nDzk9IdgExSXshFU67+Y2rmVZLw3n2gTuAdr4LAe6UXgKmkBMTWpx8U1sFitfQk0CNo0btjhnz6ZV1wPosiFjmzqUXCQoTuiHdkjL7pqI74lRiqQM/A1kG8RiclPQ7Ud2SEo92wWEuSaNzvJ9QoNc6rFh8jE1lXS0rGxGSLs+KWqoDdT3a1TitHUA7TTsjU6cmaN9HNFvxgfS7r1Jwawm7UdvwJTCoC5ZW7dPj7gWp4NowEYGL64ZZsiajWSph8BG5rTS8rn8LmQ0wX7zVoma8fG+B1AnK5L0przKH+7CC+/AmOFt/dg+XAHCCHM9jk5730AQWmgBbabsx3hMjcQt6w81zN8YHcOuQPpHurA9oiSRPXaDHRWiql/mv68GtBeh5wdHDn45wTfOu1C4EzTRFW2MUZJtJ1/7mmys2hEuvReTq86s9AflGKoc8ra08DuwUFR6mGFt8rPQwMoJFX0MGh0q0AAQm8kkClfA7kjZwxo+rNpr4dK8nOhlLfo56dBRdJQCHq2FYh6TLtIvHJTzJLiaHPshSJk0+/jIuiT+PokcVrIQ6ziFzqPgwIHpXOB+7IRnDLp13qA94duw3KNNludoM5RHB+L+caENRDHC4uqYDkNlV6BsoSmS0sQ/NPAx6YA4r5KS/M9Pu2Mv/I9rkUNBgwOdxRboZIA8vilpAkUqDGErQBkIaulv3eyJRfa9sa4Dr1ZdRTViG6MQGW3l+B3rUArWlueE8H3Lj8d1usYxqCIBM8p4Br9CO4kcoWzhmQnMvVrURwJhygDTJJZSFictzLMXnFWjgLNstGetFbuuiygGLQjjkcJB1MJaLxVFRw2WZ0+VKyKyioLhQlz/EIIN09cnsFJmrUo6cRNsdaNnzIwYZaaYzOVy6U3LIeaafv6KCuCmIIa4jvn0uQfAQSz0ERxKRVVrqWZnpKNcOuM1tG0qlCj35vA4OzlZROzVPHQ5sfEKDAOJ8JMNVf/fq3zstxnP3sYA8/ZQL0eqs5S8jlsueYoobh3QeaAu123TGoPdzI9SSTve2fbaHQbrts+ylvegGH3tnC0HzIFOe7fcKZ6H9Cu8XogcaBgiLIcBqc+32m4glpBa9kqywjqlYj7tKNh8hlX3rKsm9BLEG10WzuAYJx40Dr9QFWqClXoDdfR1wMNlj+oEOrOK0UBqLpmRq3tzfU3QyiaFMUIT2QDASPuUe6V5EYFiT6uEtVUdbTNDgcktFSolPcF0JB4ZT8CS/p3ZqxPyYg5lRI0ksJ5COVOtFNt+AWoeVsN+2ahFA9ntyHJyXU8EO08EZ2ExzVzJRL24+HdPRxIl51ZXYfG5M/Q4x8shqmNeWPS7KgjJZSavRIH2MpkRM+WEkXpihkiPUOcQxT0kDeq4a7soSZRhjhUDZGPn6PZ+cPgl5U46goZdBMfnJPRQn+gZwZ3WF+YQoztJ2/+aRZukJp38Atcvrg5sz6mbk2ufbltwPdYcUElwtF29/hvlLj42RBFha5MEPezNMn3TIYvBNne+hwppC3RiREDekNDAWS7lZzapCnAU8TCE0XyrCneAm4m8RavPAeLKVhhhYOA01rRxjjEHo4vHY/cMhMuOInJZTzq6s2/JiEPwVeRjaHQORwaSZwaOX8Uj5y0icXfOblg3AB1gHj4lIBuQQHJ8YRjzOpkrDkM6jY6loyvug09wKwCnmUqsi+kjNAdiEdWYfEHqca2IOVSuy7dRgOPfHIcy75UDVCeWT+d9lCnr0GYGlZN0Elthbkl/o2OmHN1pc0MUNt03ASLnrCO3zKPBRpaxmlIjLAGzWFMLlo2FLyOk+DsA+D3f9lUczwEC8Bd9O2ZRz2YOEUM3wXDsP0zF192u8FSftDOrOO9LPH7gt4xKtMuWo88WgwWi7elbwVe9WhArEcxyifytoDPA2kVD77GEmJKIU8fRepj9fJJs5tyljgEMS8XboU+DbZAeH5TEqTTN+5BBmTUYNWOmduDEeIzp/uHl391QbE6AJIUVL+uCAi9ukeQK4BvZv4633dDRxQthnYxLhxtxNv962vrN7aKamXsRAkoUMSWjraUROibhiyk1qaCdtdv+qcsatNtkaOXIPG+ujDk0QSpc4rtwkbtSq13nynAfhrFq7WmCb49amNzk3b5BKf7W6EsH5cbb563K2xOLCOjZq2hkeuR5ibLqB3Pfs6e/2j8Mh0XAyuN+ZPgpnxDR6WStiH6pvlgs/LJXCsdyJtiqHzHc+D/4HCpaS3n+YCpheD6crLTvW0CKx7Gk1GBuubwPa0oFHVKwkh5lTTJE806FmULuzwqTSqryZ9wJt4w0BpNWAteYMM+chIvVT7gDIrfT4TkiM1IKka1X7kg92cLPoIgLIq1BoRkcTN0tugO8l9JSIfFakSjA9OBuUcCzej579X5IO1an/89/vRW9c4id4B6LKh5eTb593/3DfvJAx+vqn/ktmMAiCZ/H9WhEh7OlJ04YNp2wHs6JlvLlDUIuCbz6HZErtawO2WsS+j0MHKpIcrbT332e3mcU9Je9kXHNnD+jIh4qAQeNvqKyOwe3+b9AIEvyexyGmoOkoQu3hvJvfaKW8eP/Y6h+aQNWvIHA8t4CEu/Lxi1Bdrdixtn3FfZ1b4h/TWzmSro1c5qzuwxDZ9GVGcCN7bxm/Y4HkathZXuApBlVncS9R7T8D+8/pDh8hDqPD9YbGHKXJ3D6n2Z0QdNSm/32wVR95J3peK39mth1fF9/hgo5FonvTc4Kx+ckPZhmHH6aZ5TBY+SDRP6FdSFaBWKS8j0+UUE3qFMjQPnOYJoV3OjfVTw0cor/Y4Zpo3N89lssavXnSstJMiiLR8oLYvfcUw8hG3DnjF7eZ16ni44KH9VpXpXwWCQ8MaGSf2SEcTpWPvY8fP5eIR8wTGbka1gYe535eBZXiAjTw4t55VktEVSMKxGhewn2BeyATsmD0EL5/MwlyotfkQy5tRZ8A66qx4oHPDh8yTiQ+g7Ra0NYLrAC0CH2Si3Dg8vAyB1TTiEvcZSmsmqzkIWdrXxovrJ9vJkF6z+3y2yDgy1HH0qYhZ5YJr4Bk2izrTHuZ2855vBo+9wKG+OYSibHQWoU3mnJ2rMJzULmPE6hh/cO1Smla657HXCU/cs+i6yR7s2pk5rqgMZcp6i7czUVcdD1h/1lHXpInZxzasUfXq6gUA0ARV6DADeaFg+AUlYRT3RwIRTBu/tN15OgT8rHYY8NA8h4NnChwBooQ5EtzDdzQQudjEA5lvNEMAhj7gEHBgnsOA7yUOBxY0OwIYUKe0VtaoOxitjCDWsayblePNSgYvK8rxgRCmgn6WH6gsV9VFlsQJ4VhnAAUWDF8FkKzSaPnGUKjLh9XKFYpXWZnybnOFsVKUtQ/XqOKmpiaNdbxVzFc07BDyteKhlaZF/vVio5X7Gsu+VJlPU5d7lZf2lUqaOsbva9ViqDgxnVA6aihuzIus2ex/isOoW6zlx5n0KV2t4SgxMHH2FFVnfUJDS3ub95GLJS+256s3RmEdcXJQSytTd6fpkq7Ji9vaLlJW4l4d77pFAW+NO3Wd6tm5923FOhFdzl44LFxqvrkGLsuVieFnXaUqY3v1WRapcG9MUVaL8zUt6f6qrtIoxXG6H6uXdJk6cWzZ9Ajlh4V6BZw5toW55KPIavTXWpkl+TpjVeHKXSpstROEdfn53Rv+HXcJNKGdIvTnl1iOwWTLKygqcbjKKuoamlo6evoWyEWKeth5WswzYp1x1jnnn5X0nGRf+uoKpW9854qrz+tA6HgnOtmpTnems77eHxkVHRMbV7JUfIIrxTGTkkunpJZJK/syb16cZlZ2+QoVK+XkVq5StVr1GjVr1a5Tt179136TELj6WRAh5/kFkx3msrS8srq2vrG5tb2zu2f/jyDlw6PAcfAkdBp+dTj/yin5l+RlKp3J5vKFYon0P1aqtXqj2Wp3ur3+4Lt4EfD22BM+fPl56pnnXnjJX4BAQYKFCBUmXITI6qJyPyVGrDjxEiRKkixFqjTpMmTKki3HK6+98dY77+U2L0++gpoKFfW8Dz4qBvaV0mpdVqa8lAqVqlSrUatOvQaffNaoSbOWuABAP2nXoVOXbj169ek3YNCQYSNGjfVm2YRJU6bNmDVnnpDIgkVLlq1YpVBpdAaTxeaAXB4fgjPAuvchyYqq6YZp2Y7r+QgkCo3B4iSl8ITQIJKChzSFKkOTpcsxmCy2vIKiEoerrKKqpq6hqaWto6unb2BoVNC46rQSzg9YDeq29DuaH52xM3U8Eh5mEyyzTvOsHG/Maa7GbPXCiaP7tn1L52l/fnAWwxgIdhV/i/VmvIhgZpf1Ado+r+H/rw0VzdfbGROkJN5fu8YKmDtk2876WGx8C7+4hX2+1n5iq8uIfz+nOMbVlOw04ha7AL/JVKjMNHUK6NiLbEijeV0YWY+hF0RCXOld1nnSDr8HZ0Msch35e8Fk699LDxlJp8tX9O9/iFh5su5c698vWjBuVXgvPo0m7xfH2H5g/cGketo+X47rCFlKx7ItUmprtug4znsrOlNmkfh7nPCLKmOiQs5SLqIJsy8Z82GZw7ESR7KWxxMjt23fC7VJfgln/W7qrxTsuFCJAnuiKYpcpvrHn/9M5kQ8fDDVCf9pxET2G0EakkoS+SMJg/YvkfOcCHAm4b8zl/Bm7hNOJiqR3ywCBj9wS/Ul3/7aP9SjdZIdRigr7H4WuBw4W0fcJ7+ZF13+Pk/7jXuXat184hvnk18PddhQ57FtCUdrssp1gzHr2TbRmJQ8m1wTuziPZrEb/NKApFzTprnRW22p29KPGpSnwMl/hWLwyG/ZMQBQu1+yKXakoGhQkcBgFPmanE5iHKP24ppuUYl90ucmZC3Ds4ePqIN1F5XEwWdEzZ7jQ94ptlaGKtBJ3UvcU4qvl1wtnN8h/2nXKVCS83h9p3B5qpKGlehKsVtmx9PwoyZvQMpjRxs7uyNbF/4VdQ1M0baoLcxNJJ6NY0K92DgwBfWB7mWr6+HafHVPm69uaJC6rl0+WPLcasEMr4s/S7qpvWpp3SKy62ne8AQ1phv1UMLT9ZKwFojqmOTsT2s2TiXV8VchuPxQ8UcYWqEarGeJzdOtOkpseqST2GO9NvqYxdP5Ajrn79aA4bwyZw8kXjnqswCml2KX5vI2Ek52WePDUZ34u3xb2wrMdvAc5sFrrAZ5bt8uWub/+qV1n+A+6U31erPrhdMgJgAKgYHBBngqgDxbsaWWPBYiSsCaCWsBAaFiECVEiCBRgjVorVOnl4F1E2yaCJvMNONV7rE0I4b0YBir3Iva1tRZnrDlM9Y0auvfDFZZ7IiHAIGEQdCBhCx2fKyop+8+CYyeejLanV0KzsPmpfNyCP9kZknO8mAvt+C2ac0agJL6uEmKC3ZHDq/GXggtfKYJIwoMSAtkEJEWEdhk5Og6V8sy1/4tzykGuZtb9IJMvVcggxC4BYotuBjBPLJtxUdn0SGh1YUaCsVVNdXQYVVhYfHqhcMHpw6dPnj02b/9RxnbHgAA) format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url(data:font/woff2;base64,d09GMgABAAAAAQboABQAAAABvIQAAQZ0AAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGoNPG7tAHIF8P0hWQVKLLwZgP1NUQVSCRCdQAIROLzgRCAqB2iCBsiYLg2wAMISsKAE2AiQDh1IEIAWHBAeGZQwHW0WlcUDcxHT0qNdtCABlm5o39ZKzEbWe20BEqzekBexWeLeDJ/rbGpD9/5+WIGOIu2eaPFAKtJu6iZw1aY0eEiWdGmTTdYwa2mghQx7u1WicPlQ11TtJazWskHspZFhqKHEXOcKReeUdBrVdjvnknOuR12ah3DbpoUtG0byC6PrpDVGHbiTkmqh6zjqZ2PmI+C3p2/1x99+Y+Vbho/f8xESljLMk9DX+xLYRLkmlf+OClouXYnLLEirk/To3bs14IlFd0zgI8ccwYy46edJ4/jAVzszkNjfSiyOZ4UR+26Rr1kyEMCuI9/Ucx9O03i664kZmpdpiIbK0i72oB3f4xP2F6wDb5UAJ0oyLHrknPI95//9r7yTtoe8D3bxPsR/WDB6JGgq9GcC1te1ql8lxQUQqN1CxA4z3fazAf/OVgYGRCCqhhEgqSIkoYoCBSJTQCkdE3QZw0/6DeBKiCiFEIKiWlvratRM/8b07f6a7vK/u91Q3/7fbvLq2wPBsq/8/szdqezZ6aqdSR8cmjMJKDFSUEhRBFIzd54uM+H8dwE37T23difkTPbMGqEzsie19cYEkmCUBEiSChAABDyptgZba2rUzP7eV56uxyPdnumcvhI4AbHQUgkSNUP5UpCEqH6NoZ4Dm1iEKNrWNRbGxsbEAtkEPlkEMWEJvRKVkGCiCYGBhBRZGv9kY+f++0a8DOF3/mbCNDYYcduePJ2Y7+yp60HtqJ3CG72DO5u1qHm2kkaYRa5KqJEPv1PohjaQRmihQwGVI7657j+kP8Juo9R4BLVK7hAVKmpRiJzHJIML5z7Nkr3naeR+FBuC/NNfmOiigsVdKyvPQe1//leS4Me6eC8Bfz6kHwr3XT/fzeJxPFs0/wVYnekjjz+PmgXX9yLfqI539u7IsGc6fAfpgi0UXnUNYJUUDTA/BZgHArrQz8P/8/2Xd8hCoZAR/Cu+0wYjqtefT6zvh9UYLd3ZTGvW1ayRe/3CiJQYfPr93LRdulyfZnHAlcH2+vhoAJGBMvp25CoPkz53q84DW/36/RRORnbnfSkFShaqRJp7UJHF+hCSeKJ03PM+31uet6u4B3A0wu+0JkLIxZt7voDAkLHogieBy4sIuNufX/+b9l5zZJQM9qO+jSfUFNO2Hx3xzR5s9wBWEYoQEvBLqQATb/lPbxDxFYn0XPLfdeIDppC+EQKziJ6bTF52HcB3WPe/vSzW79qM0dkMeVzXGs7W/5Q0Pow1fI4fmsHbPOd4OZIPUsNGkTYEjG0CLu01IcjWA4foDEF0NtOQY5RmnFF53i/YHIK0/wdEuSG3gjBxoZ7l82pTD4bT3e4iH+2X/f5u+te9JGltySIpDXrSD/iHof7TMNRYNzdzRm6cB0UiKBXaOLDt/ZTkwpjUFJB7JEH2CBeTxR/8s2V4k7BCq7QCrTZftUv6uXMCOuhRlt2zVfm82XR2UXRt0uAF+FWHibIT7QHN9W/7VqkNWiNaROqPPr9/v1e7ZfbsheD+ofpV7r7Pjd+bbKhGimzJrQhkCFVcyBiWBamWMKBlTmQprur93Rkio2LGXOWUlQE7sU+waU2P6dO/MooKAC19AJGhyhf8Y+2/3zKyyvwojY40lHwJPa3v7etXOHrdDCGEIEkREXHFFmkaaTJ57XJ+7UAG5ObPHi/a1YCrlKckiUwuZur3/rZurYyabEFbA4CFhO/Zl7/6rhzYjnu/Z9SsjCqRAi9aew39zYwy5cMEkTFAwWNYEEUMW0/23ezEEHI/xDR4AucoYgBwOsIHWyLCOdYQwEBBATLjVwT4UCKeY/d/YZ4CwjXvURu2ZADyAiRGgOHeADEX5E6UN/7stpmZWwjq22u2SbiKyYirXJZVOq2o1ratxISaCaCn3rKxgqRHLIqBByCXuw00cIgg0QDQWEBF2Ivp9GGEVETT+f+QnEJIRaEMKoObOfiqWohCIRoOIH3NclyNg0Sa4iMoFrWyB/I/ymMibYxQQ1VDgEqXS92xR0JhOOl9ZqITbTSNZ7fWuvw90JWnEPKeiGrGIfgSq6H/l/4BTiUCUm4OTOQoC0ao/6+pvoQ7CzXKRREos1tpnu6PJbL7a7FXNwldbI4/Q9DAYHe5OLHap4Wi+UTPbv1acn4ZIkmOEOQYOwO8WB/gpDGBPfkSxCyugp8i71jrBBDh50O4SD06CXwhWfsiBe4s8uD9lu4BvT4OhI0ABap8NzJiHf3Ahc5wNCo9ow/361KGlctcxmwJhjVVdlpLHDYWFOdqCW2z57YoEJ58Tm12CmdmgzCVNigMUGCRAUuGBZwhVY8ADb3Yo+/S51O4onAVuByic40BWS9erTA7uQBYW3pbNbpkVLr9lUe2ipuWyBkn1slymeQBHVyjphrPI7Zx+kV+Sp6hd5gPs5hzBdBxYzpCHZ1lpy8vVx3jp7Z3JaLk4r0AThLfKb9MZUgItWwHe1QTqVsCxsOThwJp0s6V26a+37rsULiXyjtsSM14YceAml5mmEAkuFRQmT54siVuT509InW3vjpj8BU9LX+WJnhCOziYerQ4eSjmfnQAWWpyMz+g72RXmtm26N9R9Hlt1W41c0o9VSY/WmXnnHwfALpdW+CU6X68wTejZ30Y9bcw//nx6letnsErZqOQFnKeQE/rKmsocfeWKThRSyfFDONP1iDTWQ9MribjtM30+gQCm7aBuNxOjUUN/Ujp1IpvD4vvYrRa0cLwrGpqUmfKRurWM+qj2hzYu3Ghpubof+ezt0Xi5FBuCQgDLU7Fu5teXMPI33XsuYKEhnF1q24Y0xAsEv98nQes7eILf3H3/cW6vWopcZQilO6Rijpec8IH2g+YSTsy3c5wLko1OF3n1upLxgJSoCyRSFnyT8NfelaXHdUq50LKa7N/hSnFbbgfOh6CXNfjPVXFMA3JIn/YNXSC5chDON+dDXtbqDhQ9AnDG0VIE+Xfqhpf2jACWlNfe+FSMHQBG7wpjS0cAAnsqrdsT2DuwItUkf2uPCk+Xg1kml0uAtCj4wHBzMiI5Fy3ugu08dpyIFmkVGwEWzMQ63ICv/IbvwZSlhrZeSlPGs2sZiBxv6vMJtIfMfEK4SPAzarWFR3S2FizpyZSra9YseVUG/OVxTZgyn37y6nF2Lrn6Qq5JDJtlJc+TZXxlvJfE9oR/y3VzOptbKt0DG4p131pXGe93aUeAq5A/9YCMPO0VhByAv/NkyWIS2fP3avHUGegOqze1S3uvTrEn7uLfLmkfkmZ5pvqTeYq1gD8q+vsh+aY8yAzkuuY1+JWkwt1Ptnm/bXKHlelnqfBzG64vy/KT1w5f9n6/OhiO/d6PjB7xTeuucSo/YOTKaaH1nHXeHnX4vnAmoP8b/isEgl55VrnvnhNImhNvq2+q9TVuxTJtz3O1beMllH9+A7fWF5aucJt188SuxmBGhc/ewE+F00yci3wXNKHsNj8tV8Xv3X4lI/7A4eGvMGcUIjjm+V+r+ZgtCUK1iVzeaMViXzPqoLswfR8ALPgVOAlANVB3c0AhtJPBnLq0oT1UVYFha4CSFCZJZvhgWcECLlkgg0BUBf5OGQAUctuK3CJUkiAGLylsF2EQJq50pRSSaiGADnSyASxMAzeEHmwbS9KAzDoQIMHzQQvOg7gqNBC0AmAXbcY9IF+kQ2RZ52DmbkNYCdJIp4uhBHAEnQRD1OvBgqQQLAfxBIArtApqIRM0CUSYVajFmu+jiM4oJIFOgfE04Momq7mgMcOwbyqZAnNAO+vDbJBMibUAt6TwBnySQSIcTWyCNsiF6sgb1AWcMQWZkmiIriwLXoMIfhMIoecEvIoMWRSoQbN7IhAsgo18cOSBKx88eeALRCAEfT6MCAvHgReEVARRAWTNCHIqLzrCJJswelIiGMiP4T2KwTzJRDYskBdLSfLyYt30Y6Mkip3i2DdDOKiJ4SRZQzFcRGqJ124KpricMavL5nTRvC5b0EWLvq4qPNNe9INonJfaQUpzhFRJQ6TdGyFdvqU3CsrR1Gdfn/3mB5giROenCBQLoqRJplQZiHJxfOEenko1pf2apik1a23Vurzt1s/vBgwjMWIUtfpxNXdUtnRImwjA0hFp6VAAroNk4EcccVgMOknEiVykyTFFlCxD8HZMfhSKoZQfHcmSImiC0ReIgTwYKo6RRKZimAjGVCBmgjF/EcRCjpdfGiQZIUUPozQZJU+daV7iPK9x3teY5aWXr/lDcWOk2o+P84gbLq8Y470m2HuL4SlR1mcNYMck9yWBVIvKL4HUmMomScDf6wDSiRh0/UhjlmBQ8l09M4D/RU4RjsADAL9m+X2+LDynQxAz/jYeGCYcFFsvt7S9iNey9SMAub6mvRyxd2sWovdfuHlx/5UjL+P387y6NWZeA5gUyJ+SrW0HBN1qMKYpQS/nwt4qkFMkBX6mAHgprq6c0nH7+SpOT7s36+02Vm5WH9rv1bGLEw4RJGxtVQAohYxVh4M0Ro0NbnCzM0EmJM0lcvtHNuqeUQknYcxA+0GQQk4Gox/pLRRAnV8E2UH19DoKeP0wUENMM1zvFAA9nywrmaoyD/JmsbghFUB/ILwh2LVemsZMQAft3yDAubeOEds0kyylO/QEne3zYMCX9vru9Vgyilrehg+4Dtt6CBiQMDAg1SCMfcmyBr6Y0/FVOM/0FaDOAzjFzBf6UMw5YsemNOg2fMAugOLn+8JGhhyJtAQeqZwUku8Oyy+E5IfD42zYzEKEWHwIcQ02UHjmycIsllYCFaZGKTYSS73ecbD04xKvQIKMexBAycm4oMLniWi8dNrTEY4EhSsqacx8KXInDH+SnnTHHt3Px0QmIX4LxafGMKBc0Hw6QSanKXYkhZb60ZKe7fYIBO+7GOPP5YlEWtlEGeKT8zAODwUKVChyrhzmdimS5RJ3+g5y90fI9VDS4G4/wxm5KMQ5Yulkd6/vFY6VWAG4QUJIjD9EvyrOyoGBhB6mX4EL6NeDg9ES4pGAeMbXdwd8+wxv0l8eid3fa3HZrZOfRAiijA4aGv34g1OXWWIkTW0IuBILvzyi6Z4fxG1lqIDinplzjOrGZHSydylAPnfx/RzJj7lsRcbiN/7fLMnhu/5/L8ugMuRP79Dc8CF3FJqf9N01/sGJ/+MhHi64Qrb1UAk+7WhxKZwO+AWHtI183xnbJrtUKU1Pkt7X9VrH3c9+Vkl/zR6mjwBAJNGoDpCdV8rBMlxyh4aIrxv/hCJP0/wUh6V3fEBu1fyFFj6ogfnpr3dydN//nH9K/B0HE/RXx4P+OGPcCP65FOH6fKcN2nEXQH0/5qGsyvxeeT92b557BAtRp1nU3JYYlL9/AEOUfuZKQG0mSJ4wvS7zN1dy+LeSm1vcVnPzCUyl/9esNp0/YKI5+Rcs5YML2473mF7n6b9hBTO/kA1+SfLyuknJ7M9kb/B9OeS/X+FSNH2/qTH/9yjWgPzXbfPuPOl47Zdyt/4OzJ0dge05Fy+f+tz8hrsyMRdi6xn2tD5T92Gnsv867GxSb8DOgn4ob/Du2GOwP2sz4T9qT5JeQqbvKuwF+B+0Py0t7it8/1As9wMd5bt02kqXX7rmP1lXfkqFvq4TGb0ee6/GL8l/pG/olPE/sA9kkjlO5ps6w3c2338WNsjuhkD9S7p4wfuOe9ZcCcD/m2RiH69vr7b7fbP9h20fbKsP52L9R8iw3+v+vqb+xZsx/LEdbmv/Wee/R3S7Kx4/4B56/A/nGyO9V7/62sXYiSehV69+o3m79xRXbP0proDnU3vdtc+kY8efZYp5nnM99p0LPXfZS02w1Gv63MS9FoBLim+7X6/APvRmGLt6WtpefOvgduttMgx8xyjWeRcBa31obvtjH3p69eI+wfX5+MkT9hMdt/pJ1vlmgovBr2qu+uUR7NDXZ21nvl7jWn+XdbV+HHYdfl5wLX+pOj3yYYBZFHlKDyADwP2tQ/P3bpP/On5/2v5P8+iSdme//ToN9sRdzZd/SHGh54e3HyyAqN94L4Z/8SMY9YWPYsyzW1ytE96HmR46yTZ/5pPY0vJbDHum2l31jonts498sV0vP0W/RrP9yuMitoWXPNlur9Tr1Csyt9UXAehv+f4G856obY/84ldqPaOzW/vobDAG4Fq1DcDVH161PubpweP/2VTY99pBkMrWTyQeTFRcTobGjyrLTxjxe+SK4+a5Pl2vzoO1iF0XANixgvfQwzrqjNtpjs3OZDB47L6UNGMFtO2mocCMNTia4y3NOPMz6rci2fws/gclAbKFOVVryNgHSHr81cmcul1QWt1bOlz3LNzZXjFnWs0Y2AjsJX3MpufXj7EXdDtVfvcRtECSk0vlXSDE2COZofISqHFY9sh7gfyC2YnSZOW+4WiWhh9mPYjvUjjq5q1T3q8/yFETUfI++uzBS+FO06iFr1/0xfYkqbNtTbvQ2Hn6L3SmFPsJ5P9H7xy+pTjqCZYq+p4Cak/+pP3VatDIHayTArLhI+4D3Bx+Xfa2u4LCj1ROQ19OGWVkKl6J0KlxatSNhgkaa3Jjzlc4RVISiq6UlKYyM+b31XEJLEFOQsEYeU1T8gi0F8cr4YkOAGf2O09hFOHqFZVGajEgPIM1PMat6PZR2bfZe1k7qx1d32U3fSW+J+mrR76Sv5oqQr46zN/hny6YC+nAzLO0VtsB7GHIAZ4OkK/fcW7ewIGsk9e+agWVN9wG03jF66Ji6hSIPFgaymloYMTmKXEZCbKS53hS+o4zbsncg4zPKygqq9xtvKHWNTQdk5XSdQzEo6hAEIc9nscfe6z9xnA1z6f1n54CRTAx+gMvYqF3wDPYObzuz6WJsnLCMbG0imVw7Rmp++iVpnyfFfjiq3PequubQn/nKZJqVZ1a9Ro0avJTsz9+a9GqjVq7DqU69ejWq0+/s75i0IAhw0aUGJViIApjF58AN4+gGQBqvEDwAFQGmwo3dingBQy3CmrD51o4AsKWDspZWPmPo/hLQnXr2DesM762Og2bmuxdayMEqEAnB4UCHgDU5V+SODPkwaeZIYzTQ48YxBCBEFSDBQJysEIcGDDwMg8ByIZBQZ2gOCb4wIUBhRT6JJQkRq6vXyqEdGtAH/W4XMuHghXyu8K5HAmfDG1Od7CckUS+6vIaNDD+7hmkmKoUp/olas2vxtmMQYmjzeqJZYJotHOT2tRSa6FjdjMUk6daNsdJdtIsaDmLI7CuaboBFkGdpg09oS04SiCIJVljypyfNyPJRCVRZpySUba+gtFFhrYQwrQJfHLUFCesGAmKglPcGoGVhpPLZG0NSRZkqPpATi5Us50KHKcTMASJRIFiBFicWxNF8xQYDhdBMJ2OhDUbAQ0uNXu5DGdQXoIgXVLbosJxNZ20BIPoTlyCpADGfrxWiRGcBUtxmCCDHoJYaUlBIBJeYY8bpz6MfvCVOMBr4gLOSGDKaaRkgMEqlapjk81EhVXAMKgWHaWcbA4lFhmL7fOoilELyEakpYen9bG75eVpGqTLs6utm7t3N47FCRh+p535OVpxUQodMizIXR/nF0J8DOyRPHaIroiQZZ2GV79hzHUiVbFsVW8byAmuwpS32hLrWeTKbqTH7gNqu1RmoW0x6a8onf4jn2fDPU9Gjqglmdg69Z4Gh7gaTjbXdW9fDJbbOfyd14tq5ZMlW+0clp6XzMBWddh2Ps7Rm+06269I5Yy/043nVPR0rkIrMj+MhyGp49lrSyPlqQ1pS4p6laUtWmWC++/u7eVuI8geuaT+Q4Jn0lMXjmCfbVsGaMpPye5DSqEDDVAxKc3aW1JQysDtNpqO49NcOg4dc6JbJryKocUEwojkiRaG4BACf9OpaMqIQn7wjv5/5HpJxW4TfZxU2TL1xjFn+P2DHpk1pSSiLp0jkdJsR5GSwGt7RG/LIdjXKd7mySS9bJHvgChDlJAfaUtx7nY1NGtXIHI3K46j8cL/LuH6o4KLqh71Ahn1I6JifydJTAV+50aznQSJ8YyjKG5bulf51sERIjnIWd5ttLIXQSQKHRWF5d/s7bJsE1lxDXrCLFnaUqRmCUc4q738+3ek1zh/sLJmiprFBm8mMR+kf3ZjC++vriwGQqEflYT5OEubLN3VE8xvf+c2G9AoDYWBGhJG3qzj5hX81VmBHa2BFk/ar7Dr9MZuroPeT0o+JhjKzAajo7KlW/KGhIHEU4rKbiubMYSnZHUyPRwI9M2IJlcEZp0/d4ued0inQKKQ539m9F7SxTNByiprYLqbfKeQ5JsMtbbmAs9ol8Q+oKkxWlFZE6ZzDUz5xmJpbNK3xSqm5A6msOh+bSkqLNArIFg+ivaIXCbRkgV9DOGHdQ81El3SCrxCMexPrC0VSywCsok7Kp4zABfkaRsCkv6OeSlnk5wClqEO5bAZGT1z01SWCqXvbsIVVR3mp7WJx/UlJWOzfQTnhmdzUf9pgvdjTu8v21vu1wTsOYqzdNP4QCoPJ59ziWTJy3AO0m04xCAY9uEKqvIjlJbSHuTNxAcOKGKP0CAR0/boXDUa7lz30qJBYJzupCaCgWkSpEZdzYbg7ghQJiWEDkpwk0CKpgQbWvMeRL8IBK3noJsBa6ULsdDYicEYLIKPJMAZSoKYOFuKh5TQTtQNITtvgBQAhwoUx0UseYeeLdLrYg8enprieJ2QQeLbi3LCAXsTkAiE8A5dUICEDpQKZAJibqF8ElJgcsoGKc+gUSqKn4+KOBwjDxTBjVFpMeoDPKIF8KISoL5kQsp9iIiwbCe5dZ+HU71KDoT9Dr1VtHruiIZyVFRP/9fH2AkYcKjol+72ZFjeLjR7qYrM0998iwQDm8x9z2LxDYhy/kC5PDPl7fdGcdICoY7aRmnjamoLXMmoK5XeoMQzjpewOv/31UeqEYeYuljQUhCWm6ZxGoYsWeMBBLdInRGvAWHQ3I9OxZjAy1iByGSpIj6kbmp64zBRIksB7UmkmfFc0xU0e/oHFe7VpSjccLBGDo90rGIqSngXfusbaliSMvft1Eb1cz5qqmIK13PJksIVvnTCwtVxGZrnD0K6/qd2ia+LF23B4ezWAUHbGpv8kE3SbcqlZhNUFbqd8W1birwP8vw2ahGsZ8xmOAftMBbi6GKYeRKqDsALq/yGMHFJ5FULawLul6yyF0LfQ0JDTDYrORzJfGWJ6uKr/wIcHYWRkDGp2ORxIBuiNPyy+W8Cl0OdJcHC8QTLSx1dkAyKsVsumTTwaacepMhpRowbV4ihoQzt08Hk7NZj/dxQK62TnnD9XnE0dxkPn1RduOfxkH7OkJYJFh3U4o8HlHKCC8RBso/pw+Cn06YpcMMMtgJRzj+k0I0C/9wN53BERhM8x10SvK5AuYehhmsgOEIsqN0iq+wO/MZ+WL3Vo++i8eCZ/uqoZpsX8DACyR8M3+Iyl38Y4VPMpTrLZ2gSzpJXqZ4ikw8wJiKGJsSbuOQO6dobmgMxIkFFp6iP0KHLhwEU1ksvI0IObHKJI9ROFnOHYcf014FEmluFJP+gK9Kimp8SlOZS9P/vGLMWu0oay19QGjyGrl+/PGlFMDO6Jd0DgN/QtfUTOpZUR+GmC5dq/BjNks3BvBziddQit9TBz8Cgo634F7go/MIyp3s9iJK91yrcquh9Fxm5o8jasYLD3jZ0Zngj1kEcIIZLtL3bStbQWLo371QNwyaJJrHuAwUFSKuBD6kai3gChXeDz3CcCXUCLrk2EhfoNcIgQ6TdUy319wTTq7RRIMjvbUeVRmu1VIbwoiOqgfZuK6LgisqxgTTV23WWG0d4axexdJJqOf02KTS5JFem/1i5nhmQyl9hVKVrKrASCvtL/uB/f+R8RXjxckU/wAY9B3iSmvPtwClwZ5H0Jb7SCE84bH85xb/B4gGsywDbbDyaH7ItZ22NVBi0MaEgCAGxMrCNRKmwfHNM4WpDT5G/DaLxR+yzHz4ePcsNO77iXB8JFm6+c1G0/QsS4cwzyUAQm3nrupX9KY1l2ThNdIgyvu5yUqZ30M+Bv1qRV3iTxIUyPzpPm6Rie8VkF9HICYNhi0FVBKwZlIddW1bH4qSKXbXyXrri6uw/84KadP+1D+u/fdjQLLGq/xGtQqNcdgATT0l3NrLlKlosACTNp+j/vr3wedza3b/2lBXkJ5Hy2mv00Du6b3JQvTCg2BRcpeQrxxeq2DMBy2v6vyMAIjShz84trwz47klOmFtNInRz5ChPp5yR5IFzB9Ld7vAGncDebk+wIjPZEFmKYYa/ilIkd5odmd5gkCTBhxkkoOG6uRJl8a1ZqrGgQZKYObijaYGSY8pL3CrEsM6g0koB/uaA0oD3flOLy1y+iFDhD5Snx1aaqAgL/FIbUArOJ8tplp4WCT7uLEpmlo2JdRGv093LJzGYECCalocPI1rYVwEirpGPlVebCIQWkRqvo7W1lqDNZp7/xw3exuZZfr9V18lA82rdbRJ6ZeaPaAPmKYRzOJcgyukX4WTwP6yWNNHeRFYBZ6jxl+TWTY5iV2xfgbBbhnArJwLAoIMT1A8wVBtV/saT1tqqZQx0yMopO57ETT1PX/EnpKdRf4jkh6Zj+mECS3Egd7jsgHSS8U0Rs29eTirdrqkQY/DOjmbQog+zLG7xHraxeP6TYBQeqeWC5EwL958OlXp0XcEvDqAfV9+U2SWRaoQIWC2+LsNxSOXhVGCFj/d24JCR34SqXQExHrJ5yyTMt8BvKa4Jkpo2/gRQKjxy1w2sr3bU9MP2KNb3sbOSIZ3K4cH3v9mXXZMy7IKwinVNi63g91kUhEv8cxJWizyQTtIPZH2Jx2ZImxx1F9Tj1XfvX2/SrUHM2huqtJEcHg/uNoXYPmlUKHgVAgwBEcBeyuwhIF/lpGN6AYz+fTXvamiOuDpjr26wY33OmTT+PZl1/FkT1Gk5+BrMG2mb2DNRapVPfgkqZ5Uou4JQA6plhFSXjAkc9qlDbIcaPh4t/v/ljpDUEeHm5MCLbT6+Tx2lN7SltJ5Qa0WvFIjU3NWKNIFEGRzE3THZhonNtILmMO1MYbgIQZCxHWoOYmAksiMNHrVOnHJCFVxau8hOF9bRuhxoJlCqbgccmbjKatX8RgNAxmLh/+POQzYGMBbaHTM2gc7GDygwteRMuGKyw1hC3c74/iJeBkuN1RuwreLvOPZLPNlGaKyMdf9PW0j/4YNcvm+FgZzjMuGYRUTFnrmr5Xdx0r/4Sb5HrmITUbTnaBCAu3bT/sO1He6WC1UqfaSR7TFpLfFNTlKsgmEcM9MonjlMLwBBlMJ4ZqEghY1iOF99SRuAezuULRuw0GGqNaIxulkjZAbrg/kz5Idzhl4a98+zSdOzaMhEoyY1BM9IO1dlnIPjtii38ZNsvr0fN6DATC/z8r4luApOvjoNTHt8NWRXc8SMuJlSJJ7xFnm1eLC+oEKkqjETRRYlZkwnRa3NhvJxVz3hoeoT7EZ6PZz8zsxpYjx7P5Gyru5obGgT3/Dp0Vk/HMEpxVeKHvFFOkavsLSVQ2DeUT7QZEJATni0LaMcWszx4c9WipJfbUnbp/W05+94AjjCGEvJe74MSY00fIBMPu6aegtFcgsHC72qbOD64H3EUgao04duHZIVaujBPDVCxOOiy7PLQZTF9ub5cHViDKsO10aohAqGsC2rO8Oa7Z0/0J6mA4URF+56WTzdEi9twnU1WAo2MFGqKH5jiT3FrZGYijwqsVGnWT7YdE0xSzj8a3DYDTsOcC6NG/qUYFCaPj8WmCvB1WiMwLG1vcTRM5dhJHYAQczSa0NZi+o8b59wN4tjDwcsNcOlo3dxLU0NAOgtMngQgSwaqawDBv2cn8VBGsE0srbhYNhLYkfHbY3mGykpWfqcDjhkYgmDlQ/EZA68X6EG5LSVAXX/EaBXuueAXiqvoKQS3k8AMUd/6OTVGa5UsqSQbBZOA6dn9ZjaPXEpbUIXc/vz1fNVv5qdPF1lkJxDabhWacwZycWJmPtjXbx0biTl6LA+jZRdYxjffnCSOnI0u/++Cj9WGKXUey66K9g1pgGD0zZ+evmzyNhTJETWppjFv3hBXjp2pttyLMFKjEwL6JqttxRM97TGw2MrNEwUHrcICzCDL8wMWszirnSN8MydyinWlyxRN8/WVffPKNqD2JqDwXvdLmtZOzuuj7cuQY1lMlRFW/je+RVgUNeK+3Wtp/EYtAvXnBFlVJk+bEXWn0+YFWGNxPiVe3M2q+o2Eeak7eGpuadCgYtucI6l6wtieyjrOJDscd1R1TWpTEmckZ4FPnN5b7HjTo8LkBLEgqqaUmF9eyD/J7ZdjCUmnt0gjDW3dt30SXwNkEqx3Opgohawhf8lM2m9BOjfcE0ZpoHKofRjIKoqhbWML7G3DoT3ex5KhGH7qPXUPiyiLq2t+Z4D0wLioQ+55CIw/VR7WgMGNjz0e6jkgWPipZUOH59+WKwPPpQ+BcTcUw/O2mdHovZjfJim5Z2wKVjnchPTB9tHLT3ubBnYX5lcsuJ59PiZ8S9RrSsne2Zll8kSfD0L9PHc1jJ5FOr/+Xz/EKZfKIOSIMoqKweionrU4UNDNfcUrY9FB7bLbo2m2h0++/tovykPI8TCUKpMNMxurTm+E3hJl8wwiksbGlhCaZ5QXU8+UHgk+feuquKULWl+Frv8k4nBgHaBRP7MfcMvcLfPnHRcd3C7K3/9/b/M+l+lRrZYQh/v7mI9Mg/1hJq83gaM+wLYvxfZunFAwh4TzPuuMqDB/ez+RXPn1BwHFnzzDmwf9YPFdi6ednWuRjQW+yaoxcFdJU9S+GrA3k2P2Rf8PeR5dEuNf+m/xM8GH2KN3C/PrDEux+jIBvpOBfjZl9D/rEg8f09s9uiUze5jWHmnJ+ekk3kZC2AJu6e+7HDB9FONzfqDYGz/4pAwqGyVLzTglJJdH718P2D8RuU6eBOB6A9uJDPJJQE1DYH2hlLzcRFrZ1nSj5nsJlZnLTp1mpwVllyBUWAR9fj9pqSuoYcpS19WFjqz8mzswg2NmbDg1HHII7D3q6lXLnB0L3UOrRcFG16R4lsKA9Z/pR5QL8oUD7eYmD6YfmqwhNzW1od9sGgZhvk6TaW6tgC7P38B8qzhXQ5b/3uF39Bvzq2M02QWpOtZJBZzKZNB1wen0tsTP8Djd0+9mFY+pN44z+uhsGysFqYDPOd/q12HV5hDLgzVwvN4/wsa8feOGzPbTOFKYX/4Eqskw/N/5lcRt6TAMP1Ub2o/Fp5PXA6ZU7J6AYymP/QPB56agruEMc/R7o+vVkfdcwhKbxVKGOqq5LXN8pkHO7QuMe7LJyu4F8eBfi//9gBe2cN7IMedJKRC5s9vuP3zATleYnrDdbT+OA5SNpss+XDMMiqd1o+BJ5/NvMuxnz32oG4+zDUYIZ8goxeNp8J22VeCZx/fFWIlyJtLc8YuobpRGzCY9+HSf467zeavk0X+NC3vQwqiaoJlTLQaICzA1G/z3daHYS3TnRAGvCHe7lGYY2Y5YXpwYST3flJ+R+C2GL/PAumQF7aP4kvtwzKX644LA1+RLkLZmp5eJ0w/fgnP23EGTRrr6tAm+MyxXfoY8BqLnASlHTvp4zixPHnekdP22Zu2xotPfz4QO/+o3AFps2nCHMf0kYhd21IWNl/x9waAMSC9oe2oTerr4n1MKW1x+Tahi8LOQ1bKkTQk5YetbdcZoAt7zCZo71cu2fIOsK4aEVyoIs6v4cb632+J7b8hA2/I+tNjhOLIoSRtmavcv1kLBxHAdr2DnsVfBHiBdljQ3l/4FtjxucMQuWw4JdtJF+Uc7eDPNttHYPBAVfQy4QJacX1de4Z6XVuszg2KpuUKouCcuV815ZP3J//U73lQjv4rrS0edb+P3q8T2J/5kY2SngGSRwoTEXyEMzRBHA7B5Kf6aYIm3iBIrsGFhbVFjJCIRIXY00Pcwe8gDdEOVkfsr62tPPPq+HB4HiIMiYZlXcJh933TivuXzYeT7UIqu7t7g4TqqCghlSJplbd5LmPtrQnfWFBee+b9fwAss2SYzrELhnv97lApio8RvhCsXAojaqUsOtO639YIoiBlzaTJWAW2qLGaMw4+ZlG/0bz8bQ0P5tgBcpsM1/eOGa2n06wxmAFivtsABuMl31eL4/q4PRbMTnasrbhoVVx4jpp1+Xybg+NsHV6i44TM9E2R2LMxA24V5y8vV21LYxbSBR5kZdadaOgrjGkSSxuM4tlaICSYha2nBlH7sM4dKy9yPXkQiYO1dOi0ti86DtUbcVx8HC61gZx2n9xReKda64nto4bQ6rGwjk2Lh678SXmeW5Xv9PQ0BOFCD7UNAbw93JVg+0TFUD+BhOUgDEgOlgSK6XGMuN53dEWw1hWCqafQqfUYjyPzm9ZesH86PGAOadiP7aO4UeuxzsaLh8K9uA68xcczD1agMtuSEDM7xI455F+/bG5DTw2C6DD8mYZWL99ffPC6PX6kOdGB+fwKn/+sTMoGIljvVFccSzdda/EF5VL7Magd9yVWI8EEZveJ9J2Sh3GW6+UWThNgEFaW+GJ84ZbX4xTGwAK9RurfB8cmulOjePBIHCNI4i/Tm8a85ePqpYdupplgmAIyjWKeCeduq3VPY28Azn8m8xnQMbDf4dRNOg0E20ft2wvx81z2ZinFJu6RmFypdJJ+THPOK0rCyPqhCpZ/I9tnbngUfJnsrp9VQJFxh5a0/q0RTA91kjBCjCgxUnRV+IU4WiBV7nJBwDNMdyfwMY6LkLRdk/RkLjvaRRiBU/Q5MMZACy2WoLWeFf+84drRrAhxWAc6sPxc5/dXiB14eAo4U5NnSDdoFUJecf376L3XL4YueehEAjlwm82v5zu8cqKGxFXxY7LbTQm9LV+HHwdG2x12iZJLIV5+HDbHl0dHuR9zVnuI9ihT2je2ADhCOzDHI9ZXg+DboXADrhXY+bM3eZJB0CH2g0jNZajnB/xOrogf2XZjdWvxwdKMmx1jjZ9eXu0t3WXmpmRIadwwH08PEZ84UJZDahYG030NMoBbvkWRlxpnMiYosVxvGRV/nJAWXqAaalFpOWY09ewVBsgNpStacc3UvvxDScftnqHmjz9ubGo5FZ7eBngi2x//kODJxj9B02bcDpC2vdClskHIENKfaZ94/lXk1eUp22nrLx8hCqb56WWkiLhb03pzROXnEPAYjhPJFeKwlAW+rCr/dE98PjYtfM/Yhk5eOoqtzsFLVtw0dS3/+BfLWO1/3y5vG7qUaNkClJa7CteYF16tdWZLs1yyELDhM0u/52M/cQMvcMKOgqF0wkQkBg3y/6yr8G2+s+509RaFtkoWboqUaRLjwsPJNgTKGg8GVc3j8gLP43wPvMXIYEQpM5ILeKYONC8q5h6bN08zp6951ooAjtHPj60YYy53KF/cAR9HY1LjQYZVxXo1aLwkawrUahYF64xPGOdk0SdXaPV5p3kHP+nnYNR3iITcv4+ZBsuNioj4aGXi1nrflkS9uWj0uWn95M/Exp3FyUVrXpjWbfsRtErLPKEvrGH37dqpcd5nJTnLIdpeO6twANBtaz9AOvIyYJYrR3mQFIIEsVN1L7aR7mriqZnFlx+51153Oiuyrnf7wg7qJd+clpnfUSXHdVbAyz93X/bF2jExHPh6ABZU+dCWXEqLXjK2reuyDpWDtx8VjpD6OZPeLmLYPuB20XcF6LY27+GhO5Ou+k3kGnRdz6m16HW1yTmnSLJOH77VADY7wDWNbnFN8eu8tn5v46QkulhkTNJHhselRsmJ9Xi3IZqXryHMEKr3jWE8ZfZwJl2Gecy4vd5OJr1EUp9bdV5FlTuLaXCdutXvFQiZ7bIElwWHz7BVJiaP9a46ozsV+SUBmb0GBMt0uYnyQDjc/G7yTRG/H66R/CV1fpevlXz15/ymiofrA5/DwwK9bustikU8fxa65l5prZ3ODtfxjofcNCiWLPN3GXpXMqEl6rKl5Fg8tmdz853Z+H9N+8sVnX3PZy/ZHFDdfJf19D2b3WAXcVjrFm29HlEDK+cMyfkt7ad+9jp4LayMu1LGA3AxzXrvuQio2/DRclnI2ajZ7+FeHxyCXHXN88+xer8q1voqYDIHqNta10FRNYQnVnSqHVb3mw2AKJerTzXEqtNyqmrqU8o1kZoopfs8mQA046DiIyIRl5/rBvnIF984hEBlE8lFe69W5H15M/VmhAjxyAF5GxDu9o/Hgz89eb0fPW0WtmvHZvY9VOidLRDY+tMIMGItc9vHizMzbbuovMTodEogn+flDl8bgQ5f3AObiJN2xCWlDxwIK5FpoFo4XOsHhTwyozfWfTj47oe/IKEjFHBZnxhYiwd/inizH33MLGrT8W4N/TohhrWPb/7T/Z6ZsTU0XkJ0BiVg0TocHbG4G7bxCXXGJmf0T4WVqvXQZiRCsrDNnH/NCZOWqQAbnMes1gBCZWF8nayXrxkHugaoOa44qZfcg9hYsxsKKsdFxrduCssa275y9ROU1N2qM9M3PCCA17GLi+yK3Umm47v/Py/OKO2faHADYUMS4jx0ZL5gG8e3Aytud79Lg6x/Ch2X+sMhyGwcXBIESVu6vhwM5Rz/I3a64OfMBaetbyqTnysXa1w20gm5jAhZCBe8z/LgY4DCR5SX9j/iTvhmTf5QZiPJUx1VCeFv/GxWvc4pUbwzevAwDb3uHJLd33RPaZD0H0kQxMjcGyEAcUa/GFWbyTC1YrCQulevgHfOghtZv4VYYGc7y3v9Q9R8QT/J3x+EzMGBcXFIkPEIJoMtWltxZtVD67cBL0VwRaA8Z/wi1xwUaK6No9hFseoJ+H5I/NHUFTQoqtsogLuIcrpzx+wHtTaDF6IhzT4BTqhqBz4W9bghqjBOKMDYdeLlf8idO6yRm8vEwM+5/AaCAz/infQxbvUi3s35TZ2KYtjbgaOigucP43jOiDbl7W8UJfVsWlGkiYyTiKVqJE99WQhysvEIA9i20O891qpGaTwmLNIz1Hnh4/6T5tAA7xgEEn0wWBNohwUz6r+/WaTcHBjuLOCqaMpbo6eXtsWx7EyyYuMhdvBfk4DwY4yzyN5Bp2OXnhYOdrc2NPXdnZdyf6/tjixLe0yYOV7l4STYFExSxlXckGw7aWwpKWpqaApb3x95pNuo5WQElfVqqiVpum3uIxFh9CQ8EhWv1BLqQsSk37cuqnK64vWm1vWq7M7TRWlnK9M8T8WdEqcFGQdLjgYQPDDcm8Lp5wGx6nS51JAqdflvygTvIuEL6hVhu2fFXNuYO3F/24WUIdcMHtIn4gkHRQ1PaE4Xoi0tgIc90cM/LynLa+Uo4yT0tT6pITKhvOdh2MBhIM/vWHFB4aYsio+Kzw8tOXpsAYJWS1qDxwY9xY37FJ6+vV6kpYWrEOLRlAjPzLJVB9fNfZZTOBFnSF/6l35w4K+i8OxIQZSJFhig4VILZF7QZDeh7qdYXdTNUYlFV5/6wHia+S6vUPYYyab/o0CSecCmGyHha3uIuNi3YO7IA7B44WHchq29B+yO40a/JbdPWJJyM2KyCmqKYwLaqH5e5rgmt747YtQ+oqDob146Lzibyw/OSOfyBGwPzuC7s7dzAsDBM/XlhYmo+cKEHtjRLDw+5vLJPRE9sLQTKwrnQoAsKyTS3vnj1kB+ujlPl7CkPjmrf8WwmTmeVNGviQPLe6J1cLoBniXwivBycHAGHNWrs3ISomJbi+LzuvvayiJPjjZlI996pprPHZHAYuS0MFfHSGTS3wnAe09Tv3NipK233T7SlLOfS4n57qQtHD/VpOROBhzVw8IuRYdSLVcaDMIO4b3LuoLPV3Uf2o2v7Mg3ZGhMImgv8+5dhzNrhOX61ey0AnaqfkRYNnbG5+5d216oSbSw+HR3KN34wMBut5tjn7+/4aFDV136NekRmfE6BLJyKMQ543Uw+PbzwwUdus3j+fvlHQRAZXwBOH3Kca+SUB4ywv2A9zYWMGfO+4j3AXcNkhda4nUMyNjThZhbHy7zZJh4RoaBrgnTKymhPPiAd2L/YYmxQhUlrDOYhZFk4hl319hqkleAwts7QOFFqo51dT9LIAsjC6m6KLWxXPka7k/0HoDzQinKML2GzjDwjAyTp7Q+IpcIqOYX+LUErggc9h9k1pjk0aDSUlKoPCakTNUe3qfuEdQ1NPje7cWqUe6l5JTPCvy/R253BTxjd1ESEiLkcPjDLcR//kq7bXY75q8O2vlUADBdN98QIi7X299uFXij3ZDPfrdP4OINX9V3eN9WgU33JhAs6EhgRn/7+TgBhi45mFBPpJPJWGI9wXMZjQsF2qi7B9EaEVSAlYBMJ9YS0WURM/269AAEZe+WvIa7bQ1k+3AoqKcJML6bYKM0tnm8Krn81cATv832DT6UUAYnjtBhuHHCRjV+ZSMs68L5I5ANb07sNEw/zVbkre5GB2EXr/URym8twWp2nFSVf30VqLi8ryn4y+C6Jef2stP+vXiZdHgk69PV6wOAAWidGCpU2+j0rXFILpofVqLXCFL4ClVm0R3eaPE+/9TyhCO43UAga8VxYdXfz/39Dx5kdmRDteOrRtMFD9SHp1S3br9TWoMH6+wzTp06uHjNGmaBDX8NYuIR7PwC05hfysg/tfWvh/ranv8d0BsoBn0WIbjvHeDL4xjfvK4NvNgzSizNifT15avQPcklPquSFSJ+UuC2k30FvS+A0s3HQPzbbea/O1otL6cm/vzuo6W/TQcmzC9bO5L/3r/td/yyhHW/u7t+Dq/qef87cHwcaLnyv6Hhnp/AZ19uD9HHKhatu+XhI4Z1zpJXbiYyxWxxkIHh/tjBNHBqX8xCPN3eEw9rtx1faX9s8XC9WysC7xm4c2qJEfpeottdebHh5vACpwHIe3O83Qp+gqMRcNQvLmfUwYncva6n7l1LVJ5GST1Vv5DzUjmP9nx3wTM5KRymC/71nn8dU+fB//FUYURn2PUNDemEU+u5BGRvhKNPvs3owyVa5jyXH0KQ78uAUx8gFy9w92n///V8ODkcJj7Mf+8VMD7WOOftaOFqF9y7qRe1YYvIIsSq8rsxaNh5/AbcPWeImNwwb2gRDnBKvelv4wdicOcz5GEAKeCRm4yVK4hnGVm900azTMxquPnlmntmehGkamG+bjoI00IL3IWMTBbzwRipUhoTo/n/eRKszKqIntoVUTicLWURi0q/J1DziFns3c8PZrMHduDE1/DKbAmrBmj5eWEqVCQqw2lFEJNGGiNVYlopgbsQGkIhH4JJB+XjqxYKBQCdP3LdbdMK+b9Pnsvou/66ZnT98Xvsgh6HfDEj6GtFnIgc0o/ixQVSAFbZycY/ZbBJr079DebZ+WHHabfcNFj/Si1k3RmSQh0GO7cl3K2JnKCnIHG4IWDO2gXMvaYM36U9quN1JfBOD1cGyRDWZszJTI7NKUw3F23/mnnsyMfUggMlacU7f42fDA/0K9rbPqluc2x0bnNU8cMZkO8Lwno2ey6cMP21wpSqqaBr0zGG91sg0F8eNhrnpDgKPyylCFBU2XvfYqG6bkWXrMltbT8/Oztz8mVEXl9sXGWZKTkpJTo9gBHm4cH1w1eYl8XURkjIBTi45c5U3YJyjvv9HCdVRgLB9aYvvjDgCovGZrtAbDlA585IEsbpSzzNwXkj2morZtjCd/4B1BUN1M4ogfd/m52LMjH/IypmOAlfschZ4hESnFDlG5fbkpFMQmij83Vqrs0qb8IFrEgTRb6HB21GAypRQnVVTGJiemQbnSVgBqt7RnaWrEpGd3XDX+6Ao466LvcqZjtrh9iV4OYF/JPVWH/pvufXWTyHjsKNf8mWaiZBqwjNSWWfd/TlBS9B6Fe9sdQdrhvo/2tRWsbE44jsbsCTMDJ0MyqrPTypJMtsybHEJnhf86BIxKwR5Pzpu+b/yI00eeTAWH/KYDhFRfAVbhXjbST/1h4NLW47F5O5Z0lX9+35pa/Pwzf1+l35HB/LngKY+QgFjkqR18Esmb14UjMEcRDKo+sCj5Nh83Yce7TaYCyiyk/AfT1UwVKPWElCZ39X87q+ZrFPR+veqkagftKpT17Zq5NCk6vvqSfn2uQ7tvIaFcsjZPwUnZCZX6srQL1lX757paT5BqbxyeZviU2TeZHJg08TDs25859NLLKQH0OsUnHZDC4DEx1gDGkZSKoh3Am5egotWT5FygD4hlU9REdYcmlm8iZZz+gB2jqGh/U92t/n2+4d6UzpDaeqXDpbxE5gaMjcWdfRfWN+yesLMNPK9+qn+Ligv0Ys0l2IWVS2dh2sydBdWBQ5gKjVT6yEAbatziR0KfuSXc7umFCVSl5NUlzr7DgOKDPe5YNv1CtBwNaYf+rReROxkOJBF1Hcxc/PnLYRvAcUvAbA99VnTqV/iSzf3ydYI17ED92CUOqUYY2tYZGaVv8CWYI/ha0JXj19VKLSh4XXtSqBlATCARQMtYJAWIaCI/cBh6be4gSa2za8fzsD/W9uv/O5QHpWZF24r3P//DMDNzJ7l/oB7m+xAaENrs6A3gTHR5JRgWsPuZEOrXUJggpQOLLeypmQD9jEzCWxcTc8RjwVmEVUKh0DSx7CuQPQl4NwC7IQXYosgJkHwEKhHbm9tg8dT8gjFRMKMCnr10NTYcWwcmghJLEOLBDa+XX0DCATcfn4YpcCZPIOG/cs6zJCMdGC4+iPAlbRocRU62J8KT4Dcu/OtqqQR0IZgNuaXgAf2WwvbXYZXEnKJUBd3LNnVUBud9CN6Cbe4+GYXQ5XkPLwFFbNUWFxqbPuzxJ8JqS8IZkF21ICK4MWzOokEtn7dY72I5Nc8vAlLvlGv65c8wQ61jszT1i3XzZv3/Zd5Tn70u7OE3yfvLARu51xrt9j6AHF3LPbdpZnxyPn88GnjXfm894EFlh0nxVn21+dPqmzjGVlW0a3atPTOGEZzc5C4y269HJBAoeVweOz0k8GAkEixyedz/PJMO/QADk2b+KlpmQgUaHLlEbmxqniQw3xET6R7l4R7ADfmFp1FmEycHqJapmuru3QXEvO7k9R5T1adWxShCwtSaMRpUZrY3ONyuj66snAYd/DNZrVycVtR61zinIlbQsf2u9c2BfivtnV5T41YGGX/a6FM0mfxO0LZ+x3L+wOlDS4C9SQhT2Kx7PoIeB0bzKG4TwGxuVOHcXA0MfK8m4atfG2igsUoyuDnSRPF3L99vlAlYpXcI/KDWeD91jTwLkbTX5eIyakvPwy73tVPgm/QE1Of4ObQFT6v+6eOZ8x0R9+Rbnd1OTfbC8So7+4A9o//XPlK1a0VJ9XNl1wn1zDu38zLUw3/WNNCyKLqq1v3ep7s3PDCOGT39x49yUWET/ILFP2Ux70HZN8as9PTl2+hJD22tRuj7oRNZoBKnb4xWsCUWi/jGetc2py3AVucqLQ95ABYGHvnG/HpLQQrckUYwkpkVQ0HLJPu7LpviVtoyUtozAhqbI6r0noyacF+5e0+NnkkLIJGRAQbte14LtCUtEpSwltA9UgKkFcY6r32RELxPMBctZW0/3xlCxeLsWYToj73Amzr0NZhdmmxHmJE+JyBH5Op1weLTbuCgLvOgiaFbYVZHF4cqYNnP+nG6+ZjZWuUeP5t5jWN+RxXo1NM41j7KUd7uqbJSZOlaO5b7Ktv5NGexU21hZrnzZ8i05lTA6NiM40+TM5vj50VbBHRUyhbGWNOlSV4v/paMUIICJbe/n2nols6H+b2XSuY7Dp1bfL6ztOy1NrAWjbckObMrTFEB1W3y7V6dsVoUuiNcrmdrWxTKo1y1WGeJHAFKcI1ScBthte+KSkX5WsnhivL26zf+6w6NHheY5EBxxLafFWmQpVQWMYLAEJgzsL+PERWrE0+OFFCRRMvOvja0uCDgw78cuHONqCznxtwfXGYx7ChUYApz/YeT2z6HhtWfnRe0d6Om5kDBdsKik/du/YhSeZSJVVFzgZnOJTu+HUAFoxqwOUCrF4160HRp+w0ayzMiwNpFH4lgA9covnydrQ0bjM9IlTcU18I+SLGFy63Bml+a3CbD1/c9lx39Sy8nJWEEcmCaCRBRrmp1jPfdWyZbrklHUnkuYrKFGLrHTLg7wCBIU+0cgx+r5a+Up9WvbEhfjOgAiHWkeE6y4QZlGuC+p45tKZQL/41PQ0d39BuDiQ/Hu5F9dpknGyWj0ck5w8cigWCCn9/39iLJ2a5FKJTaTSY7m3Y5FqBI689Ji7HZT/rAV980vj25by84+ODwag7F0QPf4+919oD6Ka93Obj6IIvUDN3OAKr70hbV45LLk5RqYyJ0TS3QqYvW47V2UdOdtQejY1orh/Vfti6qvMbkYHFYUGIdkcOh1z4q6CUtaRbp36S0p9XdnF6KCiUa7Ig04kJzv7y/NBKU7uQYZSDoDkD2y9fTplScqe3aa8o9cK83Y8ukFr30JvcvegtAzu9Wihw8IgtYDtZWsoxBU1ALGxXvkN5x64P8Adu/H/62MCpqffogFipAGmpKLmg8H7gQW60ZU5DCFaIyMk8k3OYhRG4Sb0kXGD2eIQ/7B1dTsnVpcnePvrqlQphPa9sgZpG8O0WMN0RS3fEbr5clj6vNbMEoNc54/lvdwzb0ESCn462I/LBpz1nGq9X2AKB9Nj0qYqxlcNmZXeocJANjeYEQwfhKIvKZTuXDTV+ZPA/jv13z3zJDxGX7/nOAz2xRB0C9qOe4KGg+2nrgHC1kmHvft2LqeVLsThrRSCT1XePvn27oGrAt2x5+6PEiAr5pD/UPfePNbx1ckMcj3Pj0CPjBR4f7Upgl8BUfw6kXfAC//vAogBcyWz7QHc8w9NjIwMZrZXkptyx8MIGGW+3eqmHUwhXy9PkMVy1f9s1qLK5bh7D42NjExmjleym2LHAw0U/p2l/mcHQyQw0Pzu4IQCc8f8cZGJsar5IpJoT1GFIlxG2GbWPrmPgRgAFuwvPjWm+fP9dMl2s5SgDK8oEiWJbZWUpJ0AJnjBCcnT48cWvVuQlj/raqO7+8DVE1Aa9R0q5zigyHChq4g85jokBj36jOQn7TD3RnkoiTzGOiQW0/2U7CvpMPcB1g/2sv4iQ8gXWe9zuAQwM5x1KTHhmpRYnd4SqwnjSLkuNd4/IjVOZ/x1DTipnbIG083mwbSsvL7MxMS+rGwx4YdrwE994kW/wHMAmf7PquVCu+R/KenZkcqIpoSatHJu2pxNTlYrXyaMwvgRroUkOPzhWmB+5jySxKIULeJQg5N3bo2SKOB7+KLjF0sCdgDQ4Hlxr3bUX7r42XMPXw6PlmzdGZzMWSCiW1YCaPWBo5wNH5T3gpqP3PyDjMkiu8M3m4PuKWcA+ShMU6A55GGEr6PyqZuPuDZxiYYuR3NIrTXAzkbyXlgTYBf0v9ZiCAu3GLW6ZGO4OtlUmCwSZjFpDeY3JrMJcMJ9T+1IiInpiE/NaEsyGNqSU8mYCG/vSAzGh+XNBPj/lnD6DZiP4a5chO7mofQpGKaBqqU2YIgXFdsC1C+Q1wKnkXFTBf/3G3ftli7QP/F/8L9uKsYXTrYX5Y27wF0Os2bFwfN7O+ATXOIpN/nbcZRtetiUx4P739wztkH3ntN/6c3S8HSC2K7y0E9jabbu1k8fVvpqAjCf357t3WSTFDy1pL5/p73xoKEKYqZUL7acFrtGgoL0uRVDXTVrlsxKpKNuByZl/wVH9lBZp/yMKZtQU6hNKZl+Xti+8+zdKPjFuKTA2yiAlQd5C7nonB5DYG+cL0HO4RN+ovAL5EeLsPBL/DnTkwIEInsrn3D8mB3uxrefi/qNtOwSYzOcyhJwRAFSD4qAyhapadJrhqaRzS3ZjV9XPPELs18VlJMTIA8W++q/+rFqeFkUXBYm3TQ1tr1NWclzr8JdzocmFU3cMHfv+lRSeb3ZTKzAoarhoaF58ZbwKIkoJLvmXuRI2niIP19kw3PfIrX0XU7P3gXsOQ6CN1ptgBXDyjjLRVy3L3o6YH2/HF4WUr2Era9ltZ9MJytJue0VxmGGcfx7TeuL5Z0dT79d1vR0BciDRRo9yJdVI8hyx2ZhK0FVDZUO/4dBwcRVc0fXrYqiB71DeW/vXxruOp+euQtwCb4AEGtJl146ByhAyFj8NC4bCTK6S289MgLmdGLdXkQ6W8Dk57bGCAoKxbB+ymtRlxxvrC49WJh2vXtN3ceZqz0Fa7R+er3+t9yT7iXlkwfKit27pVxPRkQgIN9tvNQNn9O9bfcffeP38dr8mxfRxogqljLRRmS5MH/P2+VTRop0EoXl0MS2ffb2Qze+nAs4u7Q06JyulOJyEBzNKw/ao0+mY5eCRK83XvhXc4Mear3/oQjTRv89BkyOue0YOYAv47+3Hvs1Qib7PxzZh3jv+tx5J6QBfF3+I9HfsrFg5uXyo+/3bcN2L7oQl77SYsxY8U/M9FO9/vbZ692Ygj58OxyR9+OywUmsLWYny7+KBc0iVHn1UUzHCi5kK3XZCXxUYYQ+DDXnKxTX8yvaoSZW3JdgCJRQSdsmcfzXiVgUGTsXU44DjW2MeGzP0rqKktfExm4H8AEjf7k9uu3srwQjs3DTuCwkWEnW3b5k+AAL/bLBTQx2vv8TNkQg0SimegEAVebX/qp46ml31Vg7BppkCiBeg7rk79TPcEIXDxs8ANroWjQ5NC6Hg13okVcdx+qh719lZXPM/XzcyfPiab+1E1/T+62fyDrdsnHq7ZnW60oXANAKcSzCS9bCTTJDPAl45vlyjtdzPh5x/KX53Rrf4biHR4U/MNM5/qNm/A94QHTf97ufcOOd7d6X/clecCrM9atPGf8ioIO07mEnXiStRoR4E7nwcIZT/F+Y1j4FAGf71Z1AH6C4vi8a/aEzZ9Py48kG9NyZhozbcPzwdTT/2Pg/O5zrxJz2/8A3uxyO9L2pz0QRXVOVTXzAaT1E7j/A3hDJHGWONseYn5ljzc+fdyAOQ+K7Ej96c8qJCTkXE1MRkzIak+Oav8hTCeyKy1FACmUXVw2JUUPL3ZAnOyKxGB92TPCvMRGYJ+++hNQoRxJaWPoVlQuKLh+kmJQteXIEic6w/CNCwqAMMvMFoykypjxNEklc0Zm9AJQNisbTk6OGPLUMDq5sTDotUozM+RgV6xhtthLjxIgYlr3nzZ8HnWTuxDqpuZdvd0KUNwZJAoaztT8NkC9cijSAIW9r1HrFOl76N+eTfbf6ir+2bYmOzWQqbAovZY34ixMj8zBGBRKjbcUY7+WxtFKJkWNejAo3Rmd2HiuTGinLPdAe69io/T69cW38/CnGb6by+E8xeod/n4X9+RJg/jHbttcK+49KleftH97icCgA2PTYg3TmT/lwtxyScsYal+rtzLdR2fuGMfinco9deqvv0NqMs/s08WZCeGmPH5+wsyOLIKvmYr3P4SzWReMTV9lmmMnipCmZYyKC8gTPd4vlvF8Wp7r8g1jBm6LqEwtWl+szsX/u7G33g/Nchbtp+Anns2ZjvT9bMT3i9za95L3aHyMQb8B/MfMxt9ILBc9HN8Be+MOizuU0PrlPLahxpq+3ROpPJ+l1nv1dAbvA7fkkHR3VA4wU4P6KfcB4MDJGHkGw3jFwaW7Ebzbbu5QLDA9hEoBZ03PBwWNFPAY0Y+B+Osh09keLplxg1hBgH61n7a5cYDxYWjCAO6O/CRC3ew8uGs3og6YXav4JF8Bx/znu7yq9/wUzzbQyFTPt8fTR0eLnDGvWZdn/gpk+ZgUGgD7dA/gys9AxjRh7pMt9XW5z1wq8SHz6zrqS+18w00yrvYJFf9N6uWB5hqVVcHOzPUHgOX+We/8dEu5dJ/AHwMQS/2BtSChGqd7js0mqfxY+lmSLuenkeeTRBUoaelEuo9eObj/fYYFjgFM4KACshvCc78Bc4FTEQiQU+UF7DXo1Ro0tc3mI+67n5HqNcJD41bCLTHE/Q5mh/jSvoHd5VHnme3UxJphFrFpvuc9Kv1n+jv7/Bm5iO7I/us0LHg3eG/xNlR3SFDISMsW5zj3GU/Iu8wX87YJuwUbBtFAvzBHeFX4QxYuKxV3icYlQopX8Le2V3pC+kFFlhbK9souyZ4oTKoi6M2xp+HQEJ+JlpE0UFM3TErX/6bbphwyxhrWGKeM8o8xYY7I1aZl0pjxTd8zCGP2YpTEbY61i+fGz4tsTkUkNyb3mbynIlOCUkdT2tDnp5zJKM1dmWWfdy07L4ee65D7K/T8PkeebJ8nT56XnVeR15A3nTeYdzV+U751/soBd0FjwsTCs8GIRtCi56Fgxo3hZ8afSHeVzK6gVPZUHKi9VPqv8VeVQRawKrFJVJVQVVbVWDVftrDpT9aDqQ7VNtbiaWh1SHV5tri6r7qxeU72n+lwtrk5eH9mQ0chZcqAptMnSVNnU17S16WzTw6aPzXObUc2MZnGzsTmnuaF5WfOW5unmW83vWqxaIC2UlpCWiBZLS3lLd8valgMtl1qetXwncH4FAJ6CDDMA0gHQoAJoNMiNA/Rmh2E4ivt98atfUF2fwYN8AiwBIPZGAEQQP518oIEdm4a3H+T/gwIohWEK2Hycw8BLJL8LS48/PMf1Sx6GQ6kr1pTfccZsonfiPwlngCEnSnA6rPZremhG97EbQEjwDDWmpuRcgpTRjPpDk2glLh5c5/C7DSC5R1yphPzIk8d8vMgz9jtyn9AhoPGUy/3+FVy7FbUqXYKyfYRvK06ghrZlR/QHkDU2qu3ouYbplJCEpDa44b5nPdY/p9AhBnscvnVwmnX1S0q2OihNpVfSu5AJwx93JDMd/TJmSCnH4/E7NRxAdY4/DCawYdQWWUqRToRYd3z0w1V6aoUECnA+6Xy4wh0/I1GfipXpSFwJgE7Usbzat4zekj07WtMHfqfTKNMWL233ZDjbrHgM2i5Bu7ZYZSUUmIWa0ZNDtYUpnLx96sx+wIlppw00i9bfM1vHD1SkmyvBTwtnTAb3KoT3wIHSkIqal25pa/FiojwH8v0jshrVXrPO638uR9SsKguz3U+XwptsimSIJPkOw2cq0Hn8FbECQOjYUt/v6z4kcVlahe4RvME4bP8ntBEK1kHZM67O+kIhjjRLSol+2FtNQUPnxZHke0fxQplr3tP/pbMKTDUXcwgOwuE5tJY9aJswWn8nrKHUDGIIuEhgfzjD1WlBBJmmxIESj5BK0NCieQR3NOArDuNsJENIDGQnkMHlY/tpAArwzaXg78iPEPk0TYdY/ByU5N151ip3hZhnTARNG5dr3UddrsLp7UnlYaYAy+7QxE5n4nj3QRd3QZ4vYpiFc3tmDU201+6wdg810qLDX3BvKoS5DarAIiAGHId7yzKTId89cm65WHZpelr+VB7hGLx2R4cunGz3HwJg8m2IwOtvpFs2VI9IjAo0Oy/zbF4vdYUEnROIKHNk/DHXTe4sy2rrUG4/aCpNzZykobaOubpuk12JOO/rYbaOYFuMSWM6NyE/dkT1JbJO/aJU7l5ISdn+6+VMWGkSBbkipYbt6mgZSVAfKfWcKckfJRieqjz6NmanhWXN8yhBuIkgEUSWGbBvvE1OF0AruS77H9eHVmzyiGuYEk5AINQRjg/vavSuaGVTd0SpIFpavW1nN4+O8Id8Ua7NtN9uqeMBToCmRmDWGmPtXzS4jScAKM95rLMiTD57MGnrlJke1eiVFjkx/Lx2HOciswdXNuCrKYvuHrRHofspOUbzeVfv0aNgo1gdVxS5GDp20JDlKR7fySce8mzQV1xQTkqwUXbmLrLFcNyn9b6tRbrT6mcfWkd2AgQQy3defJYHU3AwGbG60LVknZbJwVmLfqkhlN3ONEtK9GZP+v6kvgiCUUPAkr2pTEMu+KGJatTqSDAMZ/SWBnkcGIiE132cOJuRdTSyAoMGS0HpXTAUJRSUyCwaei2SXeHtNjBD7y/McuU+PJHoTGSyruo6LZJQ8AtPrylZvQme2IavdPOyK93uRPxbds2sJAIwnAY/qGhmtSn+zRwIw/Lei+nBK7vVVVRRmkRTcrDVoR+Ur+r1OlGjtbrCO6MC1XpEseLyX0AUUzSMUmHYKPuLQ8amdAkwP0XjFc91zV/TErOtx9c3FQR4CqGagw74ZmMT69vcYJ3+WeP02OgnnYTjyNTe0UsfwN87Z/an3qb1O8eCAFbXo6e0U0xjY1b0tfRA4UoYDSoEiNdpNNS+Tn3FuXiUUVtH6w2gKd+q9jvgezq01vhcE4ZAdwc/LqdTlN+nsX40gM+X+7Y+y95ugX0WnI5vH46Asd1odYSgeVF6zB3UQcWXFM/YRFOSs9H2dVonM+4luBda4wnAIq8HnJE5/IB+eBjWVPpvykl2pIfednUOB/qYXeU3yYRHgpb6wUONkAfxmWY3xjWlc7r3l/pL8NguPHK1TF1BlDBsTY/g9diUu8bnUzrLT4q00Un9IDgGAxwAN3NXx7C5phKkbr4ypmUqOp5bzcNZ5S5nqn6myz0/UDMWLU+u5q/SCIORayclI6NbHWb56pOj97bMcze+HRD3qWi4ptLK5ieI8Og4jflFu3oKqSgjpkQcKYPp2rLcscJEo+tocTtZ4wyGl1lWSulYozLS2v3NQqP3vA61jBia1Ha7rarrykWu9TeQJCroemzDpZD4UsmaM6UiAgiuCnMqz2UoM0rkr4zL6bwtiKIAVxZcElFq3PREdei6pzYqw8dE25/jSfeHpzXjkUsBM5hl+hgtytidiaw7PBz0rLv6HZqI73Qlrrt81b5RhTNSu0Gtwp7phL9zWRuXBtOoiu6OgWGVU5ZgsIk1A1T4+qnF2WOOxMTfzepqvu+sbVanNLNzha1ei0Sbb43Mu4XZnMQ2rej/u+Z+2F0c+X6uvFEN4h4jGhqv1+l9XnBZe/4WkL64vfcgMRYqGw+9S4LsBxZocyQrO2p/WSjnUyaQOpRcG8drp6cHZUMQe4BOOzskQ9XYrLLKIg/UrUa5Dg606BniyjWJHm7XxGAksOYN3mC/Zk+2fW7DJ/RRZ5Af321CVKDxDA01rSG/IxT4BFjCV/SWmU7IKzy/XjOPEv7e+c0Kv4TIFEcbDOWwlm8XLWlmei1d4I+FXeyxJaKm/8a2bgz2xPUzNO+bCVS0b9+ni+U0B+PJEFl5XU8TjNrIMvnT8ik38F5VaqBxXSB5ncXcXw9zsyxYHzwg+A3QbqS0PRYVz9ayojVQ6JzJTj/cI3wV3QHrVas8MXYDK0FcAg+j7k6Q/LSApqMxYkJxZ3pBnoxLF/iFymOHgo8T5gdnLKq9mmZmMwzruuMoR92Oja/3pjDfr9HYTdf66fnWEqRTf8y2NzjfbR22yEb8DPBrlV/oIM2+RI3tvJl/TM4LKg8BY6jdqxmGXG36oS4oSbnk/YPF/GT8x70CUym49yQu0xqCZe3SHRTlNlqoycXIA7NqESXXyR0ZZoIVfIIqOBiB+NCR3zQS35yUgMkitZcCn5ZPGKaji0yxnF116ZSZU5iPJSQ00lb3Xy665N8nd5KlHsr+mVWDwe6LYjiF8u2EN0BqU0CleJKOFKjS4HAAILraNrZPa6AoYqAYbol47DFSMS1dk3SjSo5kP/x8meDid9/f8xtd+RPVJCqlotcm/nfczO9fGPa5HcrYFCW+OitvTiPuWGnigUQ+3jU0eWPCKNablYyZK5WLfl812Na7T/EicCPuE+xmm5Uvrjkz2N3H708rZ3rSX/NzfKENnV04EahE1TV9iHJIQ4BJWPomv7QGT4s3BElxXyfUA6E801qf0si2xkbLkV5bSRWiAa1ihDEXOiYyW5RukaV16oyMH2GEQoH0C3bZ39PwJ/ZIZUWZJMicZ0JAAT0Vk8XHaIoiwpY9nwyHXkfDDI4mOLNoRsd6V87HlGiAvendmpMzUiRl/7g6jQ5KVS7TC+QPbDyivD0pvmsc2z9RpoCxhDgadhCN4ypOq5QkQU3SC5wsFC0RHHLH2UISy4sLBa/CNU8sRypSDzJstv98OhhKZOWmuE1JEcdC0skMhHoAOelN1+gd1zTHXgPeWvUgz0JI4hX40YNQ8L++4lHjZzo3U/HGq5dvvZfmaIqiuXSlcuvyq57GaipTo7sQSnA8v6cr5vnqDXVqpVKtA/Uat3uX2Cr6TeQnxNJkj6l59kX3YqS2csSmGA5G5JNASIJngXr+JQXJ2x9xDldPzX+OBdFiU47ASNgSdHV33vG+IldAxCrC6945mq6JdFtt1uoi6SAy+GUn12f+f0ln/xr3CF+FCqArJJi+zrvYq2kcjydYPLWmWq16f326ItwfASjvfzvyQKcr7mf2Ew796WiE6FFbwD/9rOMSpeUzLC8PYACdp0G0aybgtS5FMfphXOrzxSF8bo83raEXsE4c8Ngvf9acLoVe5QbhTBWnZzbEybX3wJaV6NT2bVQdGMEz911z+RKcis9dYFo51a78tXzQulEiMfw09dzUAS/RdtSkUbcanxYd/AO+2vqnscEBworUfjc+kMNOXp3xpp/9rHT15A+wXIAPg3r/aP/BZPYv9SffAD0wk0pUE+K38SQo+rniFv2Ev2+2KXSZQF0XJ5Wvt3LvCH6b9gmYViK/toKc9Gf0KA0/Q8CC6oTQcDLrurNqmdb+uQ4dSKnISX6uyx7FMUqjZFYWE80wGk82dziDDEpgMvTDiT0Sj6PY7qYJdNimj9MinWa91M1bXBeGD7qsIMDMQDFcUOW0We7iFe1X1DECEDZ0b1MweMRdEFuEN7Uy/OHrrr59dw/GGVydZJqmLS8ocQp0MRpHMEV7EJNjrMMWn/9TSDWPSd6meb/mo35I1hghYnHWrteeNWBIEaKc5j5ZqpT8dVzSFew+IlEr0Pxcm+caIe1oqLxhypRGbYPvdaqfzMPn3WvkBgnD517LThGqFQYQ1XxT2BMpaLQfyLn6MuPfypwOdHcicgQgBcldjdXJYcXSVBwt5tOo972wSbHzux0gaeJ22B1soLSqea5vh++ydsxk0FNiG0kDoRcwuCKoQ5vHsE2jPVQxhQC1G14hg/cXKDUuowwDNpt+L7ek26OJR2nL83Whpqervd+jd/60i3hSkWwlHI7H+1vR45GTO9hoWggD3qILFT/Ndz/5NwQU/dlWzCp3GYrOkeZIKdvow78YXPspSEIx6LSxNt98S1k1aVSKSbJ2RKn1v+0IGm93cfL2iwPUJaUO/gnMzI7kHogWFxPlRlno1+6OTpqc/OFIbHSIda+mSv7R73ETNW5E2oS7QRwD4at8eWyi/aDbTMgfcfodYrQSo6nnLiJNtf+k06nDMVxVwkv1JnlgnhlQfrQZAnUuanaaZcoeyVyc+QIn9BGAmXcTIPc8NG1jFzWO4e5SX/KMq9N7FOkiTDWE139BdKjNWwwQxERDZicyGG2KVLGuvMb3esWS2lTvOPs/uEWSYooUjornRjJt6O0gdce9U6fciShuIqnow32YSl9taPkXDzLrHgJuKOXm9/hffJ1gQnVE91zTDvnDHq6wNavzvTh/fORv/3jHZ6bE85jIegeYF8cQm2jOLS3Jy0mLjwzxQvkBGmEZzLhzrWdy/hjrM3GbJQZ6uwV9Yi9Q1g5ZjRVjFnonDDrrdndvAKhXgf85QQxNjaGtu2apZEP+jHY0z0+V3vsn531gLQqgw5Mlofog/xU4Bxv+21Z0O+TQzyD46cjS+jDCxpDI8rle6P8iz6zyQJmK05O3CHJ9KKJw04gmJBRRYzUbWhv6yICeASpORAF+yv5Y88RnD2Oc8yotuYHUsouwDYPMEAU1t+nscBSotnt/4eXfXJw12nVpbPUAmgreMMq2muQRdTqC4bxxMiCGGrg9NyLUzD7/VwSHPIZuePh2mARCMmQnGkxNNm5i17Mu66s5icMLCwSY9SKppCK8ouPanbOyFH5aWtCuIbU2IywltTZkfUF7oyei/SYDt4oVJaNEm05voV+fWvOaCgABO5SWiy/bNwLw8vZReeAGcmoqhsYTc1Qe0UfqrGdsYdW4gDTcJqyHK3/RM5c+aHXlcZs/eA7DRjzWKIjjzHeNCtBwIPcmXt0BDxuWEtYA0OCZCcI4+N6fnHGp41fTQ5YNjm8Q5TYebDjIyqk3GwYKNMQ2Egd+uX2q6uHkgkEux/6TH9G1pwsnWH1TKHw/e0VVQOeRzimFRoM3tXPO0ajTpmeV2cnR05oJzhuoPDBqkzgWxXd+M4AtLS81OE5g8UffRjGcyMwXPberM7tOHLPqlXdRe+9Zzo4h5/+8xbU/7Y4hjPZ4i13RM67ObLmtpFUuxbwMjNPg8g6lxIsY9VbuGfVuoe/nIkXZIYZ86JRUtiYlSSbzRXFCRCDNIVcTNCJXlB7OF4bzgFHG6JppEVJtX9xoszbGYF9HhEWAgRgpDUxjKQmBwP+lPxsGa0ty2Zlf+58uJgDeqHXt1PbH9Q4vL78bHR4cnLysSbSkJsQKWej6+XBPrikhNSUhItCNC0zRYtJ53+VzgWUcj+I/GgalZuuiOExkvT3cU6BPzs/muBprT6XG4062OPAMNV1PZaAGcmGh4q6XFYitBeq2UV9ivmQPn8My0Me4ZS3w9NbjxdVH2VW9oZhgAwlN3irF0R23Trdmv0g5wBY8hw7EJw0Eh/Jp0QajUnl8JFsiyIF6PSJQofyii2Zjl9IvKCSGBrNg6z+uhDZPFII2hQvyi/2prn3sNS8YqMHdxcYMRpwfwwCGlC22c0RvjJUXXwtm28UlqR4KXwVLtf7zsQVTAT1sFA747uH6xGT3nHVNdCXiRsRkWJmSzOHff2cIZhySumr6AkxUrozjVmpY2G9Kt/0xjPi8FmN7vPNs+QY0JuFazx2R3/m+HyIid3oYqKBQkeyiudi1pxsW0izVlizy+QlR0Ui/We6CzO3TdzT4IxZhHU42WrkK7I5Iy2dbjbYLmESayRLRaKBl87OCZ6wxn9r5h0Pdpyl8ZyAtfngCgdZo9yQimjuXLxYjjNmiYBnnfiK1V9jl2YePpj7A6PwLqb65qqnuQCEX1HLUQ/7qkeMjjcSoeR+fehdXHkdAKcNWnOfQLWA9f7Tel0y0F1ZI8vV4aV7yDHUkF0p4sejvX4apnfFlzXNzB7zsVBu7zb/91Gq1FnTY8S5VnlBLn8y5ft57+/X4LASb4CyUCMavUzgvo8Ufa2K0ZJjxhpCGIDCbCHrLxbzUipVOCkQg4Eae6rVqgxE3QpUiEpgCDFppBJnqbHYJx5J020yAms1+K1+Fbxuld6UTllRpRR1XncJRR4t94KkpDNjvEUCR/93Grz/udG4ynWZdLC80vtvdweC87BPAebttrJXG7e62C/IoMZlPpghJ6zn3AWC4Qve4PxhA9q+FIj0IkvP4wCBADSHANn2bF4trAeNMXcjzpXqHpPLPLEopnTFynkKRgDnHyoeywB97iirxYHIMepo+EvS3yVAgSdemoyPoEMtcJgTVzzstHXYanQ5CIAJqyh66LhttDMuJzKFxCAxuB0l7TGcwH24JBPRSMrzl0A/T+BX+DTSLkt564EpYL7m4s0fgFe6Qi+7L2nOTuU73GnGsK5x7yKubVGRawhgP5ZAmmCRq0fwqhcPieaCIshaFC87Vpy+uyKnmuCQOQ05XS83pidJc+fj6vuI2vrWPu8mo8rQjvoS47YFJtTsMs5WGnK1+OkfkXv7ySWl2tYGo6ILkuqtlZJgcYMDZHaCvgyVNl9HAIESZZmXz8qWticdxW5jtaWCUCWRfk0wq45O6BmCAytjRqAJn9z/nUGtz00bx/cOlff75Po6tFjx7Ypcpzh2Z0w3lyffeJCWsqJ4hkr7qCh9gom6el50WBS3WIZbhitIkyTzMMDQBxwKHUhcK5WYGo9b/ItX6cdKKWmqoT5lXOFPZduS+3+MNJjMSbdIYopjMcgl4lYkxcSWIkkA7XjpCjgX32Yz20dWuWLb4LP8qDVfmLm8HRTsdfmGWknuTmbNHPgtBGKcDuOPc3q0UlkxlTT+SLJSeIQUdcpghZFaWgv1kKEnp7aGRFN4Oj8N3PKFQfvNBIY6R7vRNQM4gfMmffPkpyNWolcZpQ+7DKOFI85DZGS19EwUSmsS4KhqaFHK14EQO5qp9TIoi4WMwBnH10cDt/iLhIOgvxSLBulXtPOjYXcZjC331tiRN6wmZ42u10L749pINgreZGJdXCjAX6KHN+FYs9WQI6TyKJOiA5WdhHKx47VO2027oLNPIByCjubEM3/MCSxb6tvHhG/yGzSoUqFFsgJCzB117sWyD4XQKp3AwvZ8JiwSj4blo7ndw+GLIEIRKodGBkp1Zp1XLKBrc3OiTIGL6hJLXycVreQBkrOIxq0zglc5U61Ke/cP4ABvkz87MMUaQqahDHRR+D+tZsL9/r2pgohU/2aoPhpDKXCSmj+fvsU4XQfrhn8SP31cwOiIcFU5KQjQ1SKBDQBae1iqpE+Doy0YMEX60RUTGOBge8Wo9Z+M/bykWN5Dr6dF3NF9CBUWOeeIQRAGnpF6qzNAf0BJZAMkFE4thiqEs5Ph8sXapQMB4zKguZ/IVIE37bfEVFxKokKz0XnA6XGz+pzheFNkMB90MA09M90VhCvbEuNrYb9Gpb9TDRmtYY8D7aJf2Z+D5l0uALwbQmACH73TbO85NqVFeNsn95CYKKKR7+3XgTlRJ0spCQgQzeN8pn34McaNdz39888380c0thkg4rPYE7EYTrsPRHPahbDGfKfNOJllVZoMBLOKcSyEaGmA1xH6dwHDJWmGnGGoQDIp7GYVUilv3oMQcsQGWSxUmH5llo1iNlpsR3IwdqQuH75AJvnZy+E77fTKLImJwqVWYjCaJTBawZoLCFusYFhUmTfSXS4zmydqJ6WtHoP2zLMAiFxJcmGZ76HWp0468fMV7q2dQPjh4/16JHUtbKQt7VRIM5pxQSnvo6x0ZDU0y3jHys6ADct0Qb/OHb9gQz6r5sKfHa9GjE06RLdLfXGmlvYkIvE+K1x4QILoQVsHC4k+qcaOD9hPoI772ugi3qGqoiPAU3Ww+B4AclTE3usiqhoYFFQzwulWmp6VBmVp9Pjvtp+fU4yhQP5ITkTnvYs5zHVQf4rrWU7jYE2ugwMjGQ788xVM0Ozr/J/TlSXlJIVFspw6fHnnOtqwtxtyIC0tmnIfWlepstgUDK88jB/aUOUUSBS407M5L2QQZdCdllXZJBNlcY2bdXIlY2NGTDimWu1Bgq0+7lrUEUdQAV1QFQoPWUDrjpG786btVWsJ9I4txaN+hMpBMzKil1Uqnix4HestJa8cT3HsaXx77v1s+zlLtzF6eCDmOTJEoglKBO5ABrcqIpV0PHSmjdmy6yaBi6twUsXM4meRkfjZtZlsvVs4y31ImVSG5/bkoGceMscRSSRbxu7LHDZIi5KhHtKr/0iV5lefXWh5Vpondz/07nmmsUjs5Yms/2y111nTimrrJM4aq+BB7dqtb79v2M1F0k/TsJwpzmYs7toBBiTGapjMa1AZD9xjnJy+l6aUPgXyz/YecytTVIEY+L1DDpuvF9ryekl5rw+MWQaOta67/WqRi+fGhBxAKKpruNS8PpB6ZqY+5Ybv42kED7X8tewAy4HgHyabLVUDM/i/pWR0tfL+syFtImnTwvfAGb2kW5Q8ZIf7sUWIXFlZ1j7D3zkxyrNRveeogVP/IrqRJN+YNKlFnNkz2wDmD7tYMIecbX1BORoEs+tJNhpn28t0CxMPUOY7fukAMRqge9Bd1s4vwGVNCLnyE+TC9RRK9BNvg2r7r8EMyBerQWidrnYH/a2RlZCGOd88qBxFqrCzPaqpSFy7BbTx7F7cmFndLpXIinsjlhcxAtOsRLRWHv2VNKaFKiu700qp0ccrOyW7DnobJz251P7CTYClP9LwQoL/7CeXOMy4Ah5BTVN9TM32nRA6C8W8INpVwD1MWXC63XDfvF82J8l5fIBJbxg/QlKiX4tEiiLo6OLTUOJ31l1NPDx8xL5Zq9XI+r6jBa40S+79IDyjbGL8IT4wDkpDesThROB13fmydLVA4AWQGWIgpWfbZSUFkIgaZS5RVV+ut9hgGjPqFH2MwzndnVUyVFPGszujffpXaYv1Q5vJllVW2/SekKCe+KB4JvKzMX1pIZD0v5QeCrvW3U9vgkso150dylcXrT8jTppVWgp1UsefuBWnQZNdPw8MMKPd1zm/B7+drLt1IEiSluAVYFbva8QgwgQbw/cP9kekDgs4NFM9oG7jrJfLT7k0yqk9EwdxcMRfRTn88sdf4oQ3FCN/SNdI72qBdisRwzHi0fNyYxnq9e0cwCTo9xEMaNKdDOUX7zwkepxoHl9fVa5csvlf6fOKqo+sJUtbcSo6WaAwjg9ncamVFg7etXb8q4/jisHv/xlRzOZ5c02OBIgB6sA61o7cub6/SktrPhD5doFtZxTPWljJUSXiqMMwU/elufq4RL8IaJ6sjGOC4RUnvM8u0gcTEJlC0V/MzNF7MIZ97wOPAlKRifkJR6PweRta8OdloKRN/myLi0DCq7v+ZlLKOXW2NIsxhvNiFt2YcHveTMP0d0guAPBWs825NuzqH18g2AlCppgxcxS5f8YwNsPHYSlCSFF0/nGSpTEX46GyepPJxZU9b8WPGIvtz9VrOM3GroapzdY3jHU/wqPM2/Zyl5aLR+3Uhi46Xck4qruKuXuek8KFgSNtSt+tYuRPASgpPATIULNU8N7aDgWXO5S7Pj2+3y6vYLp2d2G1H5R4TQfvLbO2WswaXApRboz34r8YjV9xcvJ5o6mAtA+6Fn1OBj2eFNHWTZhw2tAiWt7j5wq3x3BptD0snjmPP/07k9ZjOK1yIxm/ZMh0vE3P0nmXH1SxTfBVQKw0zfCizbu/l8ipFtCJGlYWkLd5kimGfmpeqL6HcxqSRRKIVCe3pG2xDViyqaBm/JWVciQz1v7Pz/CgpDEyOmtoxMoaEDOe1TtSmWBEUnee6nZ6rPMpd7Emb0qh7UfO5V/w0L0rumMefLFG62Wmpww4aceGI8Feh19/U0uLpyZ++UJJbVGgChJ52GIMyNe7ACGpta64YrYXyA9cXRUgrRfcKX2YYjrOH7Cz/O96f/2cMn7M+EU4VAzHIvCeSIiloKjThU5zpmu9Dn/UxK2M1Ky8zDGW0Emm/MFTKJf6M5ejcwHZYmlOas8H7Mp8GvVYSZUFyH01SWmx8JfyM6NoGZ49yjkBTh2Axzy+2aJJwHmof95OWjpRLNQQoWRvTJgSqa1XeZY0UYYAShuDU3HVX4GikybdeLWWdQwRJWh7itUpj7FzW1zo+Yg9Z+6OlcgadqNIkNJ7E3Ij/gE7MqohWpYpn8hjaM/8pDSXxWayoyn1tFTWP/Ly4xDUS4Z1W2aLR/faEBzX1hTUHmbKiFQt5rM/nnWjd4mGFM2r4/6LwiUEfqx0hUOCHjWOxHZh9+Vq2S2Anr+nV4dOSx0qbi/bVgkafdmjdH/BKjHW6mQddhHVCwZV7cRbKT8DWJRVFa9ViLRjrCwp1SJ20xR/y+r3qRb2TZ/5TtJ32hZPtcAjV0ADPCYQ4yu1xaaVE9taGvCu/VOCDxYLZzOeQOGFffrhp+4Pe8srE1m2OQYPPUep3IJirww4vP/oNxcj8lSltgzKEvVtXb/3jd80NFmzr60eHdSdebDkJV0WoC4rX1VSjAWJef7MsGRUzxlrDixUdIz24/78VtypcorJ9pK101fZ4ArFywrQ5daSKq33DQC6HRQjAW99wGHzn475Fb7B9Km3nEOs4olQocVhCpE4QW4ie1SODnyp11+ymWcUDSXCP576Zn8z89MFfeQ16FCn0VE/np51PGzZQ0jjAjpz/V2rPmocVzJ5/f0a2SW69LskUwr6k9CP9FMrgGyIHtk+WVWa3BNOWVyYBUdkZSWKYjSouSJ4dLaktjx1XN50qFlpw2NPlXne8hIWsd0KxJPEWszkxDemQX55pSY0XNW6B2V6C2MxSqYCBBbMang5BPV4PV1qQPWPqrI93aqSaiUz4Yazs7GohGM0MuqG8G6mqJsklAem2BvNnTbtUrpVUAbTK7Ms7COhse471uZ9EqNh5lCdVugoChxqlB1Tb5vEkKuV6sWwfty6wWycaBsFYu52z4yXAOfULWOBJdm7LFqtExm7FuURpaZivkG0YQHSLLN5JUsHqsur5djsSWPRzoaDnmDQkFrjpQHWgOAqO7rtNshdvYse6z/5kMR+H9iUuLMl31wr5Cl2TIiTBJ5gm9D++2CMZQW2OBy/untrFk/NOlrN3fqoB6nbUeglei7V3Q2rM9c7oJgyrOAKltVRwbRjtjukwduT7+RNb2O3Fo1EAoVTQuTMAUTaq4aIihKx7AFjnZU3to0BpnHL9wvyl/kBpC2uWurrGGit3JSIU+nVrGj82eDhFoh+GuDn39xdkaoKl5Ub9mz/lwdiQpMSxiBMjai0v/xyXT1KfQfLiId2+bVwTN1tNVpdvb9G2B7AvpEISO574ju371FGGCih4HA2tZ3+fwAfiem+fJx4qDmPIMjoTn+dj+1PNAQSenFfnruY58FW4T73s9ms/tTtWKH4Ig2cScinuL+8J0UDq1q0Y8CltjuWJ5ipz/y11u9hALn/mKfQaR+1DSFI/8xoUh9/cthJrBoNBvMBwJivk9S4uA9O34E8VtmJyHJCZIUalPxULgpN+vg3rnh0d8CJNu/Sg1vCC8rnYy25vsA5pntvaQX/Y7/ML+dpLzh+RBIaI7YtdUsR/WNKaR3ALwuHKqGBtfqHUrg1PaRHDRSq2FrimMbPC8WmxvFR+w5u1bFhDwOsf1W2qpAhlfOfOrNWGrZF3l264ws8wShfbkl0AoVZfHBdUfg2JrfCNI76tlKrN9t+2HIXm2iPNoQ0NiDvqvJ/E8nyr5KgSf9k3vUWZ1jINKLor2h7Mfkvx3I/cqs0Gpl5Z3vcb6tKzg3dqrRRWC+PO0LGK2FyMTBgGbys+/+9KilUYj/Y31+m6KkXWtA/gnSkjvBzCtZlkxtf/OkxFuxmeMvRUfZw2pTjTsY0ORDc9uZuAtgI3/EOEhYEcUQ4v64SgxUUqhpvEqoHtEeaOzPREPhsLVgb2IriGS5/sFtaZOn9hWS3SyF2VzGoFqRdwYM0ole6p2rI0bs0GHFoxcy3AeH9brjnje8vTOJY08D13vBBtloT1pEuQWjO0yNL0jlQIrn23wCos5f/WKBOg85dOmzI4Qefn31IocmLdExhi03wODYnwA8Z83pUruCbBEA7mr5xtnLJYKv85ToHaS3IyyrWFdh+YThrZukVpdLMrzfxaJa5D3CRuwohRtaMGrU6u8af6PIA4rKrK9N4NVB50tZpBHfUCLLCJJTHAsIwrF9PYJa2xMDMaUryZSpwXszGzd5MrNo76eYELPWHnxqkTjzeewdtDMPnw8bfs9KSjWs9P2TNEEYOJUx80EiYmnBGUOE+UvLGQuPjpNZHzdcYZi+WN6ltTov8+Ut7pKXnbEnTP2OgeBiCkQt1KeUFr/cf54rE3T5zfhjtQJMRVaMuza8Yl+wObWgS8MNoQGHVyJqzfpRPQn3u7Nduysu2SGqA2Fpc/ZnBXgtXu9VpczLoDBAYnSDSXLc1GCYEFmGUQZkWOWWTXi78tiob3aM1eU+oRqqCmxHsYPPUNzWJFoMEEHy7/4xcYZHrERshUVRKwqK/Jp7I1XUMSBtNn+l4vxBi+l04x7ZxDnUPuHIzWD+c4SQDXNyEMWuPBUKcks7i0iX9odhMUDEptbmy753f301j7ryxN3XxhRg0hAiJZmrb2dtLn93590wAjSpX9zC420QIQugqv+FXR4HeinnqyhKGri2qHS3t0WvBi/PDNpu9z3puS6+QZfThjWV4C8fMqG2fPX5kvdrzjE4+tkM2H13wcnjJdAkPYzLgam93s/ZU6yB6oN4hrHUqPRsHA3CzqOa3QJMvRYNhr0/CZz/07Cs4/bNaDDnqEu8L4P/m9I6IyzC0U/Z3nz1SbI4sBmykbv4LGQOuzyYMUl4GJQlvABR349SqXPd9SD3JGcCLjl4DtjOcF3BhDnFaUooo11p+qL0JeN4Wx6xuXx0lv1IPOHqxD16FVRS4VcJQwjOJWB3TywhWlt8GC0vnyd90jqYBQmc8bjfVqCJ56kT09wyFAgKGPFyjdaTcX3J7O3KbmguaCY3AJvFyPwqYmHi8/IA2DqVRpdsT9oCc7d1ND+y6CmjgUYl/dGZ2JtS1TJbcchr3rRKJH7FWT5mJN9Ds/62ByzLhqJEUpxe3+ZejhGWwswJmFQtyfqtZxj6QYr03DH79ylshe981piFM0qqJrvVO13lBOa2ERkhJ8iBm7opxx0pfvJG7+q9ZK6hHVCkoWEWBRwmL5ZYFcivfoxrO7ZLwjigo+jnpOCseC8Q5SEzicdi6aimFdd/e5kUFmQSHB65WySt30fcSi3k9kHaVISFBSlyGUUnNUS4il+EDh8BPQ7Oer7C2QW2ShIOVJRjqKPVLrQQvXI2Cuz+ZFd4BMSIarJfa1RyIbIrjMGoz8gfHAouYBOiBHtay0RnC9GLHhsdFn6Iw/pv3ww8Vmv0rKjPHinJaLx6LC/GH02a2QjKBqy/zQPUDEOrDkRgXTcu7RB3kTNF2GpvxYhROkN+YkgPCovaYZO0wFz80v6/VXad6Ty5qpkjpU49QdpnfKOWL/G1YVsFyaFStnQfevvk6TZCdlQAkYgarJsbspGx5fddz5uVePnMzQSG+qzx9V/cq0hgeD4PdVkJNz5uLttpvjnFy+XAcQkQr2tBac/tJxM4YpTH4fExKETDdneG7LfPj1x8tjxQ1hdfC5LuEeF/2WVF0JE7UjsT4jR1F7YkRG1Wy303H83BvPOmTjNAZigMJym/n5pL+NqMX1cbA0IM7MDS4vjBn+hugo7Ff4sEZIEPTxy0C33T8/P47GGvvu+/1zIiHMrTOiXPla7X/Y56oMi6HDo0Jmdar6ND+I08WlycOACQ4chAAos1c4Q+2l1M54HF0OUsF4oZJeK12Z/sK2xzJprE2iMtM4I4uSR8kdJ3R+fkHbN7lbNBftWcNz5b2oB9bCqwz4oSSG185uc8Mc9u2i6IbAE/BukYXT8RShewuP4Sryx6VTdp3qbFvrNHM3NNMj/ZqqMtIwtRmzLLsVS9zyaaicSA+ocmP9eH60e4tieUzB03OFZ8HSmymMI8dSc1j9VUaNI5G859YKbIu5evVHq8VNiTfaxfnRApf0Lvs/SWRr84lImjzpmEarWrmjpwIv8p2tBhbalOEGccydPm532fUIQmNgaU7vcmFxURvMHp4b/G6hHL7Drrt0C060IiHKxODg+Q2PX29NLry0Gd7EZv6V6lF+nwRxk5RRnAULVyo5dZ+L6akvgAEQiXngUFRCvFA6BjRrnEOhmf/nbdH8cMc8T1yPpNtAwkhNUaSr0I/BuW0X5rFLaI0Dz/GFaDG0J4tMxjpx06o348pyEe2xKMsjzB+wWHeaIuwIGbn87IA/zdefdnGytFCNyhThAIly0Liavq2dqwqJeYc7Q1es2kyLonuNhVS5e4aaVnYqOppl4uzMeQFGR25D0QMoiGu8KIuUoUIbU6i+mGYPTJ2NX3cF+Ui0g3ke7Saiq79pjtD/3T0CRWadBn2oVqps6yz6kLnxyPmeFSewqPe9/S9eeU6/2+0Q9/qzfEEUCnP+Qn5ZinWi0k+p2jCeZtv0UMyV+2KdjZZWwFOMb79jxAiKaZzJtE9zZoMqppgLcdihJcAKYdYjRt0Loy++HfCupB0RrxcLHhq7sMBorCR8WI50TbtFMjHSMdzjfmSiozUnFZXGNMfHUBTkqtATxa+QMIyQRm8CGGkrOhhYus9Ztm/NCEpry4AqpEWEuGNEujBcKpLucWJVzW2Ep5BAb2ILXpF2eY+oK7WaNupwAtOZwHqRMtwlbJJX0NS7s5Fnp1832l4zaYaJzZnGI67LHV7MRV6SaCot+lyhAGtxuOxW3MFywNhX1/2ZypKi3a5q+YJuKGarXZpx/qjLptrG0QiBo+YxjesW98sMnLEHdCJGIrDHAk6rjbNG5/czea44hwt2ZR0m/QCzC24brVh4nlInSXfJjyVcpPoZJkxUX9V639ZwQbO1o5DVd5awqTkmz+KXzW++L7iSLjt27ln5qJEogu5w+WowSun2HBrskmSGhgUpMstTTe3IM+mHEKjrw+PmaZsJyVduSRWcXNmx0F/derro/PBzGNvBWadFTlo+2iOgipC3C3iS75Dto9i9//etqvWUJonOcTYC8xyiiTxwcqB2oC199E3w22tS48p6MNcNrHs0wtV+19enpNxMl0I4u+WTYhCC5fCiqiqyIo8/zP73jZAGJZprrTKAZdVVHRWYNlwmvegOYQ5JjUgcodLEJ2ejL1THKuZB6EhVrB+eKQiF1I0VXc+t7kpE05hYGAHFUOh+M862GwXOKVGjiS2zclyQM+WCk4BAk4mx0wmBjiGoaapIJG7M5ZQZITctg0Suq2rV3uSajh9jhWk4sUa+KxpMEFldMXTeZkRBIfwc0wlc0M8qMv+RrAq3aXteouqJQzlQtT/lgM/wDWYXTO7KzEZaxxZfaxZzSBCBQSR5kC1tmtj+2e7jhS0Wexu8q/ktScBVnIKcPEc3uTKXu54s7uuYXiFx6FDAG+BNRh1iJ60yU4FIo3WowghneH7fKHfgJQlc9fD5lEQkm+JXjNBGH3v7WmrSPPbtrpPAVGd/9HQSSRtGukvdRweSRENoIC/jF2rmiuaRPI0cO6efaYihn6h/td3a2Zi9UFzFstV0IKJIgjQKMh30SGARvZAxt7A1N3+pCjf1loIbijvhOxIlCz1ivpLwn2B4IVpa9uzsyiXuR4QwrQOL/to0pfpBUvVOTjR0/XvzQ5FIej5neHaWHkQF3m992AsBjl4oB00BcnCYbdabzLdzgHmOomnwUb/irkEZs+JY3CNqNQuQ6wsigUTUnGxfvBP7yxj45xpZEVXwnNoDNHT80++fEw0F4a0AU4FRmo+EwrFi4lIpG7tZ0HW9ufjnFwQDQVcCQ9HNesuhaKbx/Fe1ObyAB775D4KBuTUJIW1wnbL+GuWIazUVw+DqcIbNhHGTj+DQDX093QeD3fwD9Q7S4iTgZmkamHvFiGx0RT4alUDj+F6mNHZ1EvDdgPWaP+NGBpCDQ56PadJCCiSsUbQW3ui3qb7OoqXZTSzfi0jpbK1OJvWF6j3FtgxVb8mA8d6A5WGTqJzu3RXjmaBaaBGKmmcjQiLiGbOZ60bNss7sl5mhyGLr3fwE7RqFgVa7RT12czacldOBP78Ak4LBN5vSYrd5+9trBfVlFM/IBc7Adah2iRqve4xSI35ado34YPbQLqPiVkuDUMuI4DLzZqMAiKrAsOmvNa4Gyjbf5T20MhNQYiRHyOh2+LMvOnwegnuVhMfngPdqy53epGnz03QIpTENwZKQTX/05Njmtt+Tm8S4rNx3Jdx3J8+UHverHxl0uS9VxZOIXgcJLid95c//4TWbI74hfPmj7/41sadi2qLoQSN3ekrJ6XbDyEderlRKVHvuElPPmHMbZjMsbO0lr6Ihhl1Tkl+06AuM4kzwFy55+hMukir0cLUNTE5Mh++eZG3Vo5Rj5Xrr7CAP1yEd2jSooNrCUhBZOCi9HZBbjMmHwxpbpeLEU8AxyAgvZeeR4hYLheeXH2brmYwwHgysygKMnH4nnHyLy13SbHar0hQPO05jMy3pgQvDolwnXzz67lXznffMf3MKhAxxw+1kn8La3MAwVXhScdxOOhX4n3++50X/vxO9guPsnkPzQssK5hoDuo2ycXm4/cA3iWVQfT46l72S280Xjuh5H6OK755jqUBXaO1hB6SpSnlaKvqHVrmyd3CUQ2UDs/wemjtSkKv6Y36e2sCPgUmNjBE650gf4de07FJGlVRCjEaV+jqVRA94YFjQJEf39o91J4JoXWpKZtx3I50MQT00wtEjbeU378u7hkhQCF3D2UhTdKBm45HPKFK95xUa7FpOax81Iz8xJGt5KltN5DxaNsd1HKb101+idpDVDYDgiobW00FTPxx/6a6nzd3H5SLlneZ3xOE27clkzvCZ/f9GDUeICaOrS8otPP1y8Ef9XsoEGhRxumvmfCC91YEHGH591Wl5WJ5ivIe0v6wbp9MHlYdvIIEzELeXPQTqEAyhAa8LCYeZf7xD5yeeZwYXJPBnANB6Rf3ul3jxweAcf+lO8HcjR2ZpBQ2atP31pDrOyzYGuboRmSrjip8NigPa9FzThWcCu+l4orrvYXz27sS+68j78tWh7qs6YdUoGUGA9yKfpZN3NuxeVfweBmMJHPQLT4qCPy0FPKNyuHkgM4pHgvHBgC2g8pFC3HpyuRZU7H4ftdTgm1Sw1Is/tKOUjHl29UiXzE/nmlMwkoyvh3DYDgehdMEoVCQdQYcGg73FhdJzY9IM3cJ9DQDQoAK1pQfWal5o8cPAd8P0q+hB9UquCj2Q8+Yu1H3kl1xqbHV6I/qxWfHgwOzZpvAkJXZNjeeBmfR2NeV3pcBO2Am/jum7j5pZXYv9N5z18lw4oIopRtfPbf98V9feaiFmwWUW24dm5QMbSmoSweN8rSkHSiiGU/n69Bob+cfcJF27YuCo5KiZGFgFVDeKA2WRYsqqmSVLUEIzhUESLFQx1SPJsadW3FBttZPJk9am+5ztCIjaxNsVyvVYy1DxxunTTWo0HQu7T8sGA4vddb39ipG4VW92V90NLeDkNRkron883FUzHFlwgrWA6bcF4282jyckxafvX9IvTt0AMAkhEpdbgLgS/PWF1cma8Or6sPL/P9dcN9pCKmIzBEKTI8YKSfqk4NAEM3P8UMBkF458kPOMLtEvFJHgqTd1EtaMPh0F16OkGde/P1P/F33c6aZUZqp3D/iIUFx+ho7cwNTuZgeWQ45Z32zw79iZEZK5vKE2Tjjs318/MYMwFpmdlLOgfjzuw/Mys18+2dQkVNT8QhiMEltkhM1FPCbpISFJqAFie8L5aORFc2zbEIp8XlFVqw0iobIRjg+NCFVyqfVkMInBl6vUmqRlo7OU7WYn3u9tf054Ny9dHPlvbJhSxqHWY+4WVYZrImL3nPKfv3HJ/GLo9PGYULVSVF6wLy0RYYY9p0NnLiF8lRjc6zLmuuIzBI211l2irHZQbMy+OJqWAakPsbeHmprGGYXezl8K0uhR/M1h91I0K3B0kClxT9/ZcrwgL+OQHnIxXeewLJvFGJhTUdcbOXfw0yVguPRAYMXdRMgUo8VMxtmZb5htUSUPk8+NbuMIZtnxpnOEj17mrDox5BBp3SB14YEzbeKOEmrka28aYradhy53RWdTqOTOrK9AQTL/TCG7pIK8iCfjPmESUfuex+81Vc1QZCdGKP2MqzObVefMAGe7ye653chD79Bk2joXITD08VSwkvGSEmli43jd9H9moRUPBQJOk/0mXyHmhE7e/Cp+audM231Wf+55dem9NKkFu3R6bVlwJRSkS2EMifUlBVpUseAHJm+aHgfa8rR8zC2okllLicNf6TGd6zUgVnP50qUrv4/KxJ0Qs44KTZ87g9ACHZQmwODV2At7JsEIaDLt5llL3L0UkT9u9elm9ox6lcaEUkIinc8lozQKgExVnpZWGnBSV+BZjQw8403p1bbckvWAkcmpQNeXt8zwUA4+qSaINDf6uxXNvRDpi9vDR1AQV1B3pQo/dWnK+WDOW87LTowvzUB56HsS4u3KtLQ7ngkwZBSx5GJ0YxjLC46p7efw1LoXfmTmiH5zHzCtAkmMc7SsoliyalGPMpGSbN8mvnIlmWaS4IH/FFKQeUH8PUzHSMzQ/VxpucHvWUisPH6D8/GjBBzqVHmiEsYoJTRPg7Lw/IYt8Z25WKQ5i0fQ4pOWWfrdg0EjfKX0YdXlXSIwVhkpTVv5PPbkuDD1Z7YZPYKWNhE+3bSkNrrjAGiuQtB0Z+Cr/snOuWiRGi/RjTNnZveYHuDktzhB2pT2pX2c7e0SsZs7pjDo1Zv8WJrLQkaXXPT99tTizH/1bzB8VBBPzuTQ4VJ3ZwgPDb6s+GcThjGJhCrNtxmLhAQ1j/HPqFBLUQwlaXPeiDjV9KXj+U+GVfvmnPd4Z+fSobFDfIpjI13/9UoWFrHYXSet2/NZgIFONJG+w6cHvV6HRRLdR/WcpDMd8AWw7MvuEYuNRF5uITWdlMGNr02Yn+UQIAGTFQ73zzsDvPO++26DS9QcXalCAkQDKiAaG31IdOqcpKP+XP+65yCb9AzWMlLqwfXA5C/jMTaFwbUIC7UqzLd9SikT2rtGTSAWFSJUvTaLgur11VVmb7+ixSAo62xkM4+1Vi8o9Uug7lVb40ZcTafji0wGt3JVlQ6i8KXXCm/+O7cPCrIQzDgaLUVZPD6jfDDReGB1OcbSUQDhHEqRJLeEKM/oQYPtpVymbZrz8dkhoSI8fOluE40HTo9DCxX4Op66NDBs3RA7fkH4S3AR3dIxmHYitU5PfjY/+V9aEmKNAV8xm3eFmcmIXqqjnM5FBdCWV6b7Z2tO3+vDovWLHT1kMMz98Tn+fR/e1UXWSx+N+Xe4tvKlJkOe7xF+rnj6kT7BnN5ou7hDNlxuwSeEeBqzKHbLKK9i9DZGrVptMJosKBpbiqjhBL3xWKKcELSHYdFtsTkiiqEw0mKGK/XHd393q14huwWAYrU7zfkO4BJZHhf9Ignsui4U21/g83izJhuJk+m+fIIu2x2Io3bHPB911mhuX0it79njxLKaQMPSG4sVCl4tsYtpV3Ne20FQjekm3zmhOQDmw3qOz5XkLNWeFSH0AJ2dPCHAyuqRDCuR2ngo1fbO7YuA8bmsHWEkDwUH/CJsd97J6636hov289EGdtD3UO1PcY1y1n1kgEcvJkRseV7EYceSS9XKiiLkJUWRVLufTTou6JHJSEBzOX0vn2NkjUMWUZLWQcV2+1qZqbWyLNCdhz+qk2FNGDmFLM8qyQ1A0xQm+qunRIIxzGKswlE0y7OhUCRRe2wQ4fFHyvO0Ua8P2bp7cBj40jmCGZ/wyOZMQT/8ErSHwY2iKQeHDLXU5XqP5ec9oS43JVdbj9XptFKUlsnYZEYUwiBbb7FMuKdH5nODrDuQpa4OjgvH24SPFkoLCEgk13EpRpLYaADQtSqOjeUT5UHRHjh5kLFRPZ1x0lnWVRdkdw/IrPV2nOtzrDQaA11p6UgIK1XdMJdLqjSSnhA/0PMbp+pvwTfmC2fgNrZHHn9Iv/iNL7HibryspCAlwCxDEow72Y6RGHZzm+4FURWPYQFhLWleeXIRyf87gFnv3vDoRbkZgzSQMWiu3EgZbMg87I+kANBSJb5KnjlmrndgoKa55lTcMJNEz8J6NkVy3ZfMs4LGeBq6TONudBWSrZmwS+5uQGSrxjsmaLx0DI46Cb/YRGPr8MTszV7EgJMFyl2srUYQc8MNOp3eH4WjBQvZEg4F/KWNHaxSqALhqNCFcC/ONrLQiwOJZyNVcqp4OHRm4rgvLfaVFQ0YxjG/063nVNRnrQslR0NnVGdqXNZLcakcJpY2k6JBhGnnhHRGDJM0QkdMh8FPGt/8r+mvVT3oDaY7PTFoEDP28XXuYVYLaa3Jy08ROZlw1MdXhyekawN6G2OzHZDSGL9Xooecwi426MFq1ctBw7GrttTv0C0/iFaWAdvBue5md1ZrWU1e2zCzMXAnbFqqPJkbn8SjqZWd9ZdnQXmmOk/ttUhOc18cRIxqfcX1VVY6FC+uqJV210pKHqS4PC6cV+3ogsHY20ULiTdPng1YiREZDkjr+bCXKemiGI5ybIekTxhOcvYYNJ+roCI60g5vpfLNWOut4aAtuH3Rbtn/nP1nd7rrcGEe+/fccPpgwIsqjGPqekLbozTSE1XFK5SH0SVTxgr8fHJGNzN5HPZrZnQO6oQnrdmJ6z4xWljeiaSoXziWWO0VrJDhslPYPv1ySj2TdTIfUnniix0pLyCT2Naual7BkZO81hXNzgjayCwKQnFQwv1RydP2rJ3D5IammiUinJ4uarFYabxYXMzXOnLaviCEE9gDhyCd9DoluQHYo6rCVByi1A4ppnQx7Kt3gp7QuPH8L31W7FY/d7orulHNoFtmkTFd/0xGR4EuqmuCnnH8OIUEtZbnreICKETAgUA4GMNVYyOLjXUHPNoTWXMhiqCkcpehW9r8bprsrMPs1ICG8st2orBSxGT6bYqeETsGIKxVJJIZz/SkFwzjFa8OA9Us5yoqJGqv0CU0urpJVGbkLe3H91Pm/546ok/n8y515aa+RSccDkvk5JhOWr2GEUiE1RCBiO4WYueKc8Z5BTpcwM05PLQGP+qdoi4ug3bJNgwIsdUjjtVbDY0UGZ4mCXB4lTZ2Nd/6GQ6z7f6GAS+QhxhFH9g3ng7/1peeNrWnvkvZo9oUPJk/0sIDYi80HMvpfcGcJtS8BogEK2ql6XAmk9LRCFG/kNzE67UV0xY7ACPU+k1apgE6ugQ9hnVRjAV3NOc7cUEkcM+ewjfd1NAfrxPp6xWT9NP0ToEMyIP7Ps0fsg46vVY6eg4S1G/uvLvHHqSJy1pMRDm4MLw1ZZO0u+rGN6dGpmKHSaOcoVK8GMQ+pIleDG4evpPp6zuWkr9z/L5ZSooEZjaAqU2++knnyR69n3XtrmDpu/PD5flAcBPpCNxrnhuMzTq2mnebUWtA/KKu1DjA8fTgJE7sOiMXExUMCWqrfrn27tPBAn5aIJ4F9r/9AlmEg5AuDIV1z41Qd4ba5MaKrbkcAK1oOiqFdnahKC490ajkE7BOGefOJb057Vx/VKY8FHGm+0XP7kq0PfK0LguGnutIX3//8sxwA89DsBBgSyQqHZdP/3LOMWsmjRxK8qI1Mn3a6W/cff/baNfirh4nVn8sZYnp17fFcvImBYicrUqZvw1MK9Hiu0KP/pmYSCJXXaLNAWcLMqf1c9M6TyY74P3drl7pV0735WSrrRaaH192z3UL4CLcA19aPzyy0cDdcsPWq4lsedj/loxOeQiHCg1X0lwI5woUCCf/Bi9qF9vbVvmYTAC9ilkr+70zX6r+P2rYmdnHIJngfKul39X7uLoiJ6e4/bIvpJKy8k+JW1VQU6hKvvOPHc/fYw11a+Yk6ZhfthGU6spI+2n3VjKcTnBPuSZ91FW9e1qBoEMump8VWi/YpQelG5B2GnvPBq76kEni0zNE7umdWGTj21alfEbDA7O5ZFOEZmUK/QA0Ld8NXX7UyVlr2RM011/j9KRl59fY93xseZ5vl8Bb5CaBZEUh+FW8MT8yCgQiUn4grqVKYsOXBrssrjuSJml3cvFbrD1gPXczid0785gLfXwk3ULEroY8HNqMCz4ViL3361M/Ex0Q4pkWLKgzakhsMxoOmbEJRdwc0AyT8IbWDgstv+esm3VTLQ+Cc++m15kq1MJhnsAi5mnbv/HyELZTjcEd1pgdLhcvZuVPdb0wlXfbaZs951pjogoG+KnieHaX44kBOxS+qHFj1xMOFdiOFX4+DuZ6JBWXoAead2b20teou0VkovRU5mvw6gd/9Pyw6dIVB5imp839k9WUOKr2ZOprq3eUd4bEK9D+hfnNx+d2Fmxute/4JUt7drcLMEkCR503nJfdkOeM7aGlHHXX/GHvArVXLggmi63tf6qxPGQ/qZ7AlyP8gxcbSGASZ1g5kF9VwAlDSlJYuRQgdtc+ciw44Zy2sMYvyKQzuC/c29sXwTZ/aFW0GbdORrY61RV+FLrinvd8Yp1wu/uvOxSCwy/ZEVw3LKuxAk0Dd4O8j92yK3gfPdHbWN4MLWei0TzHFKvkTaau7im1DJiAw8aNddvrir3w7rslQVRVAWPuM/1+eaG2MAOjvzucP39Lly/y8aWWrETkFgUJPmhhgGHlMR4n23OvuDcWj4sdy+u5hcJbiXiUUudfL70l3Z5HirP06Cu9XDTThoV5U8LrCSFBqjM/RKb1Y0hKLCG2O12F14rFI1pQKU6u8OYRbTwDIvjkAbHPZvz2tNeewiiKcb0zWqK9NfVGDEzc99/eSoyGvJwKoucifbhiIIyOquYfSIG+xLxq75d6y7lmhpXE+N3WHVXFYpceQSblJuc3dUwm5l9kjR4wu6kK7LSZFRVRNersHVR++M/XsCDHBKuLyhg3czdz4LcZFBJd3PDop9l7XhsVrkOK57l2OLDCB33prs19JqeL2OQO5dVNOFpxyS1kXVV3Zhr5lEwBg/+kWoV1o1hvu6Dw00/pGBsdQrIyUXGO5RryxnEYkzu+fblGpfOGGxAWwWGgvWgblKe6J60kktIdHZM+9Np1/jwlF5DzRneFn/ZACpj3/Vedc86T3OWy7rESGdy2s8U+aOjWlb0u2KiShdAfwTKsa83e1QqWlw6y8lAgmsjPYa1jnbnEJu/xkRclwTrb91X9DTcviPM53fNsJxrbTSfj8dRjnGK7WsrQIVPmZ+XzqpkvO1LwHzKH5lYC+ye1Gs3rxUEfAtQ0QXg/3VbzKIwWt8UZeiST9GCtOZNes0tQHIbSoHf2duyepGBQ1xKSxZ9j/QhSxIp9scbzc1taK88W/p62Rsgt+RsH4kpRbInrQ4E0UQABKjCM/w7hdLocVmlirIt5oVmZT+QYDQLQ6v3o+A3teafVXCNde24yW2nOelZnK6NfLk+IlW4uOgp0JL6XOkjNtKl9zuFNFmZh8Z9Ww9F1jjI7ZKxFZoA6CA7r3f76OPaoQaViN4Zu41Ku4E9no3P8fusgmQ0WFokumfdhYDYprmWZXkmDGoTXDs8yzp3J9zzsrNBUIh5Jp8EMgLhZVadvFmjvUFj/9x5RXZHT2cEfHCdLf+ipmvSPRMZsZxbbv1Vh6WHJRZfqfDycl1WPXFUX3/GA6Z/9u6dtsn7yJf2se5NNjuJR52n5vGhLNX7GbQRpDWSatINkBFaSlZyZvtxoWnApdKYoOlb0K+9N5UHwu/mwi04E9m05Q9lN3Enzm19tvFJdYFoq+sKZKfTdYBezS79/gcnWMUiibcs2jnPw9ITnU0dv19X9UlZiUshldB0T3uZBE0q3hHnyejRam48PcvULVV6aslWlOb5VOBGIQ4VCPgtKnfGkQJJYXSFTUsgqbZQFQvzx3eII/E3qEL4I8IFy8XUi3F9KZP3eRsHgejQcjNX43mhJ2uFqQoiP1rP8v5eg6OamUw1qn2b6o2o0smkHlaTVOjN/iZXYJuA2xMCpfrSr7e0dbZmc2NjwBQ1SZh/SaAPR+UXK+v58I+8bA32ZkCCpEbOpJFjyQKZ7AlNk/RyqBnXC3PdkpdeVGbj8JvLTiNChDtu9nCPZUeFqg0K2R9SJXQw0uFf3ODQNdH+KCnRu1bGV2iRfRC6kSfa5How5pGKiFH7zB/tIHmMszzuG1TBZTFsNkRwQbtBtTQ31/ovR4+JC1oy2fHWZ7MhNO81xAUsPvjaFBbuGRaPnjfLd6j8kTZN9RpU+eTH+XSXhI/J288OndiOR6/qLH0hM7ZjkBAgTu4mq3b74r9U589s/JFYaLtR/urkou/Q/ZX71E2xjI0aVim3a+dhutfSqYCvbkdCe9i9Fh0wdktqEz/bjWNuWNey/br48PAlOuy2SvAC616j78jQOWRsTIYS1LedZpYXI/W06LiQvcmieH+l3tAbgH1/Phu+Vam1fB/8wMyQKVNPyAaMltZCK7m12EIvdIW/o7cwSrA6OTxCx3HguIcWsLierzLZrfV5XJIJhaf5Tv63WtFsgkquhzMkRP2QasDNEalsX03yv+kqIbAvkCMrnGfWMFq+OWBKpLHCnjkmFA8iLm2cGxPfX74q5Y4OwRKAxQa3qWYePMOHkRkws1qNxbq/61kNGh+JNMLOS6aIqCxwJDfQXov4UlWVkFBPemriRy4uOgD0tCQttVQulJ1vE8iCQqCGKXqW0AaNdSU13QcoLKUC75GxIGIRt3mtwbPzZB8jQ40d/ZOCoteG0K3Q/5U3wHmcg4iWEKK8tAm33khgInsxMf6bpF5/bRceQRgtCyHJ+xGaPpAwbdqZvV6xNL3v7EM7P77jC9Sp4ZZfg1zi6G+vtDyDADxsZLibtlnMMBFR11U9iJkn2MpWzYQ5ApGuVhWxBvnaW1OQpT1aP3imEBHWxz472WEJh+ZgZi45swqucw1TH9FI9uvvgZfjzU+eURKI8MWF7gubYYI/knO0drflICDuUIL9fN3GHvGklpfA4o7U8Kmic9+zsN8MbpW6pL9dC740lRYue4VoVz+jAUg21HOH21e9B6eMBuxrGJRIbVvJ+eu148+cvaInZoUqJqWVR7fmt5Fy60pGlgwdJ3s+VOosUzwliscPb/bqUmr+J6sdQ2CdVheDF5UBPSX0gtIGb51SVGm4kPGr4g5XODfGMUsMC0NwxWCWwZ06kYh4Y05FNNKLTaCYNtOzQfemviNdaFth2WA8Xs1ZT4ZLaQSy1Ljnam4U1zywQfMUo0sgpY/JyGoT01vSSh+fLxayGQjbfGF5dFcecu70n2ajLShmOYLTIBFaCU1SpXeagSStlgEKfnDcouoJT+X0Dv7H4142kciORltQBeGrb3dr3fFJ1n4RlperQby9ON3Otvdn4z1KmxycJ3GDyg61hAtxg9fWoZPj6nzfHgxfra1n5Y/3pcCIaI+xwq+IYKwPpuW9d7EgXHznXd+eM5mIwYNsIYxZ4geeKl+rt21vjSzarSa+THSCLZuOG3V6fA/p/LejVLArm/cdyyDrtc5mCpeAnM3UUhFXEGIfTfjUJbqCG1W52TjQKL0eJiZdLrveS+tJuXqllEr5LkAzn6bjOwte3l6XzswyTYyqYMz49E1wHoh7g+IJzzHnZi0L3FSfCQDTnCIR0ZfWXxUlnMIkHfEBmYzyOfDbg17yoFtaip4v7hIDr1qyilHdXBuf44TWchs2lJVqTEsJ5AGSpKg/k2igZDeJpoq3AMMaeW523WpetbHPXjWgTs9Oh9Vi8MqhvsgRCk8Lxgdfi1HfarJiLrv0dDCh8lCLWVbSZ46Ntzd+pXSiWs4fC3iNJ5LwpdJVSppCpnoKBgnWacM7CcHm/fflClgs77Ev1DhlbQXytj9dmvKcezFBSlYTiwyZA/sw3cr4jkyG8KanMhHD8ybY7FztZgKZbgmj1Z+RSm6cEBbb7Nzt3NtGdYurhsQHIUNWPtDHIF3JqLLCMPicojsliM5We4u8PPW1Cniv2+cPpdpJj1DRzV+fTF41abVulAxfC+KSlQgv2jIwL2tFkWq4bBx+13CS5BlzRGVB/jnV7XKUL1aYfzkEOnJfyVqMm/nbeG2MJ0h7Mv+MohFmPdk8e9cU8RRLFqrt7QX+tNsT/BegiOASYiIoUUSwDxXmi6oepecg1c7FQKWb5LoixoGg3px5WnfPsYXGuz/sprR4uPyhcSwGDDgdGTAc5vQpYwMjn+7z2wKhM1CKDg/A7Hsw/zFgmVrsv5dhOx7nntWvTgqotOuuDq9DJ6I9vBuvwwh8/+y4fz6lbN2b0hTxIxDkbzYDZ56YBV18UCtfCxAL7KkxlXai0GUKwVvtU5iUECCCct+H/qlvXNT1yfuif4JR2kXjn+i5/r3PHhw8OuWBR7Efvm2dcnv81LD7LVEZUlfO3u5dHfmK7bHfPwvb9vCirJst0SC61iIC6+7fvam2OBg5LBV7rcAHYrodUnvO4klJjwxBLxoPWjEEXNOx0/TCaDNH7hLSzLcuCYHhdN/Oqpi1wAqN1lWc7D2CgAkxCHQAFBa4JABPifaZGGrAzYJgMegKc85uVATbCf9rGAOj/zsWGjIS/ZBXX6uXEXcMCSyCpVTiNBKM78T65DpCWHWq5zoHufxcosGezOoav1/w8PJYF/2psw2+/V+wR81jMovciwldHD06JJe+LYdjww2j8K/i/UaBiEa2D2cYnzxmfjCk5B04+qSu7eL7rBR7FdlyuuE0iuiryDP/Ri2Vn3nFgd49vg/AHw5sAQH2A29tFOI/DW4xOUuv6l7AoSnQwrD/EBXwM5XQokBQA0lfdmUEPMB0bp+1KpN3TOhkIScQ5CIhQkVfBEQRTvlkBHqMaecCxlmsDhsOB3CsRtNojjrt7HQzBVJPfQ2IQLb9PxKNUGbTCEDbVknvtxspfhkQYQoQg/ozF5LvnZ6++IXNfNrohd2z57JtpeGqhIBIQE2DUMPx1slm3wGiekUZJQzLADnDzpWoOLQvuuNUpaKDS7+3Olth7rAqLeeybURwSUDENTaJwNK2n0ynFksHgRBKtM05eDVzC9YUZVz0+Q6brfw264gY9UVKn5gkusLk81Xqy0StKswGmjCjVy/cmtS1A10spODc9o6F8w0ow0PJYxO+w1UheVV3tpqZWRrPg/+hRPjgIXsUMzlQyJUI2WWBYubSZJ+KxKApJXmBAb5oP51qCwlPW/O7qTBOskTMADSgF/35GXAp8OPVTGECiKc0/f5hpEYGCdW5uNwIVqEApAST0ZhxX6XIzJNo1qbhfPNxUUFxeh0uOPDrQgA70Ekj5bCSXeyRBpgJedZ868uxfmZULWttgnMjk4bX+8CETnvmMcBIri5fP9KoOkrzeowqL2E4RwHRGu7XwYceC40BOQFLCrJIbIuSIC2fjLDsnnC031vUSyEVc7PSfAzOmvFREOdngdZTDurL4uKn6I2S+MUgCo6TaRTlXHDd5UyeHkw/enEpQzhZA0fTHGgV65ANmaQ1f5c0UhTR0TVM0hlRBwPkMzz9WAf+fH9f0mXwdJU5W81iraml32Q/nL6QjIrc414z/kpe6O1+Rb+xnrMd8PJF0vAQpvWL8DIc4B8Oc5bznV9SXhp0bL3uAz+liZGpAg0Ta82y+HdyqrggAiWO2+pbzD/DqS9wHruNMRSkTNYqPJkLMaD6dS+H214EQU6AnK6hXI+c5+0ShMWXULzbrtDkigEf36ae7y1TabhhnUxkgb6DV6OwY/Es9Jiz7Nm7e+7F9W7dlo9TXiTdcjN1EVTbaxzca3KrYvYG9Fudn8UpS4dwZicEd+A7HnNUTHq7CV3czITPMr+XHZxylBVi3S0ek57EoJXLE+yPtrmyLrdrJYGW2fFbUoMGQQ1SoDOxk/UFtkRfhw9/XylWXa02FTbkWuFApkVRbAc/yYBr5JdnyYoWV6QQ6x44VFFV+irhe2UMCA3zgV/FGOArW3nFK4386DfrovOkcd44QD8pWliG0nKUapdbRRh6Z1rUfBoM33dz4k6njUikfujqlo9ZRpOrso3fBvTAEi4OG6XW3/LXl4SgI+kqoenZ46h4BTJEV5b5K5UGiTrs/p365wsH0AqOuhemJgkVOeXeoI5FW2n1BAstOPMwzApEZMlcVHtFwApNJCEFgLSA/I+vr84fT22dOKdDl6H5lgWiGYl61xPFlIhj3TJ6cl4ivx721AdWOpWIyI5+cMSpsha2P5MYgcOuhCbBkb8luTi54syqwrtf8PNT90TpODX3AJKV+UX4vQSF16oPDMXfnfGBM8rs0X/EAvzPF7NWARkl0e9uLoe3aqjgWLljtKev5x9WVOs9RMKS83GZzl+5F2A3x+STZ5EwRGq0NhXZT5PYf1XM0xXOnwzDMh0Ow3Nca7fAyNbfmIPnqXOWclIKHI4q5F14B3UXE7fZLuzXkurvbQms2+gtHGcLv+EMKDpGps0cDPYnWUuK1kB54cE3PGUwpMY/Bcw1OJM/ZTOqW/5y6wabgJT4JJ+iAMosRFYp8lMgBQ5wW+Yh/fRLcpldlI23DtULGi7OdmbelDw4WIl5/45Ik0H3A9ZgoQJRculfjN/4vEEbZPkDuXZNPnpwRBjRgDyx7ZCW/gUf6xkTtn/7RirgZTD04R45//8x0rgyPz9FJToXfzUNxVCLA25xbMoErzvGlnTNtaHCBNY+S288o3qtxOoiFKg91OjsMZYJGA68dtTFBKUzDMVc+QPErV28NxAUsmXN0kzwKwMzUDrykzaJOk9ql4LDJWz+alHVaXciZZIrv2KZAAF6faWSOrPV43HCctDer1yKhBccb8szSPrUXD6Za27EEi6X+vZ83DUBouRXOpwQwZw9thoRSRzLqUGdBCI0HNyH5MXQyaH9Z74Xaz+EJIo6d3uOUWFpKFGM2s3BYdCMmPAwQgEZM5QBPq7AQwyMWk6CfsYFA7WofzjWKXYInxAfKvJFam8Gj4xdPg9qdseOA4bzr/JgLHMUz4BhHfr16JAxPjl3xis5DfCJhmet2DiQ1+wtcweZgE56kd/6Bev7F1svt5/v7Uz5FuWjJRQMeZkL7HSIZDINggdXrrEhwN+ms8kF+P8Gn2zvxG7DHLgBI2i89NzMIJQO53BfdPSs+TqydlKwBKwRP1jiPFRO5OpT8fWsBPtfglfJILoVdnLpkHSjA1Kg6gkMcmKbcWwGAhkzP9kj8bMjEb8nI6I2ACwpikwQS4DriSo+cfujL6WgeVaA9Db84DOwUB2yB/2DNLW3AI7ZZkGmRwE75M4UWUnI4rouC4T2x1pV7Mmj5rtApAqkZ6UCuIpIbjNajEjVI1uB+CN69ejfRJOt+xE4CQ8NmawYL2u1661n/4ZwnIhWCXHpyEfqFAVpahEdAVAhkh8Xi6AuJCvCISKMNCsRvOBxtAgi12j/Iddqxm6okLMHLf86/KgSj8+WI9RN/9vbb2zNxVuypfKfq3dJVHnpuUMu9DF4bE/NKodqp5qT/h02z5Kp7VdvVYhIbNZiQNAYAo49rGUezpXzUF0jEMI/OgNzoXC6hskEEzUBTKr0gKHDFeRcoZI18IFX7UqfqVK1pjBJh7lozwDxYCc4SSYuYSyPXTbDeyaaq/TClWKceNnlX0jkRQPRrH2ckwwxiD2qGrmI+yywWyrNsxZ6xiV10uH2fPqQqGbOt1NghI9dBivMMDtauVyNdvLTd5xarfVxfaPHBQNs76zcJfZOst861Mwi6g+iid9Jy4VuHmFOvK+a/ynLJ8gzmMsI58BBwqPbn5rfz42k35jKJrDoqZkuOCBGr25CWB5AWCJqgXdV5dT5th+EFDmvDY4DurNC3bO3PV3hy2rm2g9/sslNHeIGfteO73W+6c/uN5f7dyvNDTxakDTdUPj+qUEb5d10WnN94EQDLrPIE4RjuM7abh2rl7aOSlSOjn2jscmnZqb4bzntjDNW96JqS8ZCPX9c8N3akP8F6ss3sKeQmPDDExrv/tZJjQmd8LorFf2UqsaF3RmdkLTsf/PUFHo1f4roMduJbFTc7YHYeUbitYaQBKW1It6hb1IaMQTKdcUpIhm+Q5HrwCtEh+PW/grPGmBca7ALO/wqnPnDrSNDLHr8N8wY6GKvj1v54YCVIG2CDO9LhZG74wI0ITnJk2DLUxDZtk6jrzNQin2AzfrNsm5pYQHaz74wrRDJTSiBQSRBU9PIcuwa0vacv8DGybDam62yOKypwCvPe49vwro7EkjgGTqx6hlAF1988rWm8dADX5He0yrvFhyL55s7twjtHamhN3QLbIi/P6W2LLoE8ts/cZQhxbrWxZzIfQt5h5Ra/mw+0hCs+OE3rBAUAGtUlGDTjiyoT9VcJH59dl13CHao0JTUDQUdPdxk/uRrQyXKPISc19BRLRNo3a1knZEWMOkHH4owaPz3dpTn71xyjUm3wVwgQ2xA2zUfwqnCvjmhIfdlSYEGlEONciyQVILmGg0aoI+XAXm9ssZEPkQTshnA2YhxWitYPPR8BnuYFcDL+AVmvDrFAxHvFksBjTdpzJWLcyTN9m2XmGF3Rk0h8XMJjuTLlu//mnsKerMlsptJnpcoD00XlYYjFKsgDakHuYKSNtG3jKUDvHoKT4AW7fzgvMYtnKmuZ4uaVWbOD4UKchXp6k3ZYVIeMqSQcSsbpiM5j3CWKaFLId9YcG6M9mLM2WZau9l0uu8MJInA4RuB5XtEVns4hCIphG3z1yJmSJWKgUnIJSUKIwRANkR802pP0OkBHICQ1TRV5VtTLg0g6eK4vfisZ8Xt9gRDQz1M6upHiQd+fCDn6NhVuklrVjEq61SY1HWZN50ynHjYbK5KLXxorNUdOgImpe0Oz3+tesZSiMBzwrSZ3Axa1+MeV1Jw8tTNjO6MFu1CfAr9XW+rWbBbcXe5sqC1ub4v10Jqh4xdYPKss7R9Xkii5c3rgWxjmUdMAEYgekrOrXjtz+AfwYzfsAfv8LcAbdsCOAbhqQmwe9hW9cBBhCw+sGAjLLAWYfqH8ZLAvXB6d8HkCQGxWJbZt0mHu4mJlp0/hcZodZL6VzLMfP45krq8FmUTbO7/GUcGiPfTCQQxIHOiVUNJYwgXEMtPbm0PH5DwUf+QQQ240HhM8NyqbE7iMTQ+BdaD14+iGg3hyOdHmu7KBc8ORCdu77woDu7o8MJuARS75ib+gQpYH7DyCENKFxuhlPTTcNOPXrYVzI9uz4nyLrZoJaXnENyBW7zsSsSrDdgMB/nf1Yvx1klsgZXvm6BSkzfWZL06rCHULks1a+659t75kvuRzdE30iWDrXx4Z1cm5cQSQnAKDOje+Qhv/qjFQL9w2ODm/76KHQdH33gc65zy0274jDJjXnVayNHyk4pybTC9HS2NEHqO1lGJbQOWbpewsul9kPLQ4h2LblI8AZu1QwGLl6vyo6l11Nw03d57aiCJphM78yl5Mla8/Gt6cjq1uXh6rWS1efnRxMt3CoSa3Ye4e3XqAkt9sse/rLrZn7t5cfLKQ2IE9j9oj9111biUPrt5Zh6Kr6+z//bKa5zy0lFyfaq6t+ROM1tyXW7f/AwvQAf1WT9cTdLb89qQpO9Zmb+2lU69XCDGpuHRDUuT6j/a8l371edGfTcA3kV4VKsNWufbBQhhdoAA3lJ6aGLY+KVFaHMmaAI9XnNk2WC9XodDp5Qymj5SAu7lBW3zr/EPCSu/8JpD7qoaAAASGjqmoKIDX32qW6SYeTMHQNVEsa3AW1X6nhofgBiIREGiQ1MBcYJg9btAQP1bcYxMQ4UHoBoGtOz+mwirruln4gzvd1ejRa/enAwC+Nt9Q/9kJVBgZrxoOnvxoBpypZXjPAuYa3I/MGUruHLA5NqxmsRgYpWTuyf6JuYH2n52ThT9xugW6XbbEosziMRNOvO8lziphkqXq/lsDKbYrU28xHRs5ldtTLRp1CJlRr31VdJZ09+zY7dqX5hseWNgQmgMO9twygrrRGOgu4NOPCZNLCEDyVsedJABCMnFp2ORdn8iQv/oOn7lanR6dcdo3d1PqKHYboDL1dw8TG2CDMPR39mLgiR7t4DHkGMgEFOSn8yU8KcDs+OgHRjZhKbYN/OvoWhvoaD5snHMSqHfveM3GRlggnZl/WgEVogR1a1C+Sa7Tg2ngN8STQoGzAumbToowlqWqlXkVtgrTbvV2NmGP8yzJZE81jjtnnMRe3FcTm+uy5y81x6L+aM6POc1OhPW1Pdyi7DkvcIPw+X6QiKvpkblPQQWz/OPxxM5pIF57Dgz/gp1dvVam+kYilmvXOAWW4pBHVFmdJCih3ON0gtvDPCdKDsYsNr1lCQKOB06RDBbcOUeO15H70vJA64CmTSGvBNzi2SdtwKwZabEYTw08vxGCUVfqhGeo5mAXBrqMwg9AUuvEWJ59ewPczmUXVAtLZDiNVohV9s6hdNehXyYPMT2Q4neT3tVF84Foc6xDA27boipQAEcGS9R1vmjr2shBi8W9WvL2ozkPcU+SaUxgxrFsK9cFT3pxRsrpUCC6Fe9Nvg9d8+BPGDjCBHW+D3aUCUKMTTDKWtjkBrqPXzs9kzCzlBb24gIzEkkzDZLtWOJKhrGtTOoQvK2ba5zrkXUJa819BXu474v7Iam4YE/E97aajUqxkv/FtifAyxHi5NHc5pTO0Gn2zA0s4qF6Qx7N2HR5ND6PjytLcqTqZBQ8UQFKPkqzsTB4uL/3eBYec5qoVfsKVBaSCnRKxfGKTZLAZQu+ibiAtp9+KZJu4STbKZk7QdtqBhRWjs2BJxGcDkGGoOQW8i7FjjxeHD3cMcON5hNNDOAZP02MF9yC9ZZIgiBS73vhQN5OPgWiYXhHZXhuzxI7wgSuoBmydJKL4VgQFV7i/FBjSWp9FmfR5IqNoe1Yvfkte7hPah6SItusUW2dwwm6WBS2Wgyoj3agDCpOPctcr6bkvMwGlwFV+AE5acuriREWjNsYhBdglXs9ODdyd8UpJl8ZlV4xmoUPDzl48YxMSy43iI0Yijm7bVQgszVM6xjawk1/Wj+pZ4xXUMUq8zPIk3FrZAnZaqymnwwTNHK2hPIyr/XYrRrYDd2B87BL9UiOmmo/nUeuEyexO8qp5E55SprG6ft3ioIP5ZF3TZp2Is9kJuSA/j/0cnYPqxVGxyCQyLmqp0rmKy0L7XfgqhbhRsYnOXN6cs+qtNtPYtf3nBoszsJFlzuRVHjSfQULraF5NJTtmb5OmvXwZ2ura9aA7WnzfdR87s7+qsEc6DLkK5ya+WY1I/etK1df3YX3kAtT3cUZ7XiQ+nPNuLe+Ck9sTHoPOEDf1zuGaX0WbYBjM5986DoegdmaiiGFcoKIovTCyaELY5DEHSJVd7a61SPP2KnAN8z4o+4dzzqrTEPJff2UMtVuhdL5BvFxUXiibzzdj6QFXsUZxIaaTCRSG7YucPKCblcd1pGsTAw0hekNM7YYqSyk9p1azO0LBPKdpPjQdSi0YjN7MnPQWA515GbRMprLCEOqQE0mkpLygzLAtV1IIfXpuED/N7uRt8x6RHg2BY1DHJgtYtMxqlwVDg2jCY3qckuvStImtAtfS8cCKe7ABse0NJLzmcKJq+2ynodGiycoMAh/RaDPU8QSZK5xKcjD+cK668+PDk6Uj6jFOqvbG3Vbdcikkb5UGbYIDMvQwhoGc3ZEhFrNJV+rVGNxJO8lcVCKBpPHYSsUyZOm8jJiRTGbxZ+mvrlTGnNl3uTZUKa3mK1WLVyeDIPKHUJBWjuJAqCrVYWlokHZxiUkMQDhGxm0faV3v1owDO4zVDDbd5KBHxn2mJgFP5dNsMJw15mYV98dTyby7fe9patXZjcWEyL8716ajCeCBonSiHvmYkSIpWuz5G/pyH4+X5nzPK2PbRQwLXyrkKqsN0SeShj19aTMqVpKT+tDacn/iu+ml8rHiQ3JHt5RPIEASPpnV12qFgV1Kqxkd53rrfYALRMMqma6q35BFi90xz/kphf6VEEMq8UX5+vdJ/kW4/JKGOhiPNueWjytlFerLsa30O+W7Uo73clDgmA8tssXAn7dng0SwgOjwKYFZz5mrf/fa95atZN5X0VJvbCIt1zqpD/mOuQP2jlesZjPfC92WGsmMpQuCQolUqkk7Jmot2bYJBYmMGSym16CZ1MLDM3yZY5lviZV4AoI0iqPDUgUJU4qCAyIUWquUyRG4ugHytH9L/5iirYmsVJtXSAH3vTEfPT1BEzCaZg3PdpbF0Ucyfs2J+poqQaZzqm6/VQOicJZh54Jy5pEEyd/ikiqJGS6mJRjokJ36xmmRPth+KM/cux1e/ViJmvY3KM1hSBHVl/MhCPhBK6SVMuRC6hjXrNSTP32xIxdbjTLVlHX/l0H/zgD2qojXOWuAwVcNkJa0Ohx6mfBQlco2hqGYgG90bi6wnZ6mXTdV183SGbU22hHxFp0Lg+vWwr9f4pypvA0n0N6v0YP1oQxh8EBAwZKIKPRPLbhauJGkVZTHIyJhzKImI/fZ0ANYVnHNXFnu08ep6ELZ2N5SpGDvnRjgqdOrbqOYEdd1fJU1AjUVtfopASZn4zMGScEEQY9My11cfUrU5AetK5ZzjHuPc9lYaQ42mMZiQicjewdjvNdHzmiQ2xIfIKZjSEHioHinOccxsDyLs2VRCpbrH6sIA0hhf6dqCICpWPhGezOubyJ3M3H9GsCBFHqQL9mPcjIJMFMlp6//om5fCYRMhtPiG4/deIeXIbu0BXG4DJWtWhsQiZbruZ3MWFlIMhFb4N/P7jjZJn/+tb0Rfh4bqUVh9QmLqE8/qiQW5K45N3NkJG8/TMgvnMW0i45Hedd50XnBfK6UytXnKHrsbvyldn3+9N1sCKqavYbEtuaaIbp0rneM4NlGq9CA9cajLHQIqh3vBNNk9ZEIZ3ZIMDAcqpAxCpLn/O28xMtq0B9CZogSy12V6W+1uOqCYxx322guGJl0rD4Z1uOYumfjUuRbE/rd8thu3K2Cdx/ZfeWGtZxbiLX7c14/F74G7U0xxuAoUifwXM0nTsZ2blGk5hcNEl/higqSnkMv0YJ9zk6K3AE+NcX+T2o3UIdT6aqXzM38UXxYDHnRrZpDA7deGTcHiLPl88Tw/woRJoxP9ScseguoO8j1BHFTzTKg72wrjAXX7U+jwM0OA9SQGR+kRxoGqjo7KWHEqCV/iNUS00tL6GgLEZUtXEkS2liTIyODwyyndXUTU1RksGksOwcLSXNDEbyzRE8WhqWFe7DjE4ULtsSHYO8OTWb/F4A1DMBomVU76/3M2RJKd1L+xl3t4BnyIi3YunwJYanmH8iFypnGZKsLDqf1l32g3efdvRxenbvtXwmEQ6nqRM0+x+3AUONhVgCnsNq+IGJ2h0H9RDXRJgGg2vWU+rgHKOIscAg/bV2avrL4jiHu8H+GPwtfIOmaBuZV5tDaY1MDdYp5XYYCSYs5rrSiIN2pJdE6EAo+/x8VCxmt4wRCE3wcL/IWqy6N1JTUhkRjA+Ek7mimPJbdzH2ej2sXb1tG9aiNTY+DLCgdiUSjolYa2LBLgWCq4tVaE/ayGRtO+RqglQFMkfTq4eqdCPiNs+rmiKhYYRgVNuN1SxFVzGDQVyRwaAuSFOUbWczTya4eAjCq59DAIpXK+DzUsIn6IPwqnEAnMhRPOAN1+4kHQ5SnQz47/4rCnPmu7shYFif5+ycPRcY9QZ/qAQRzcaxJ0QIyM/66PGQ7e3bDW96+diCPB5n998m4bRG/0DytX7CD+vFvklP5MQlFCBCvIw74utfx13d0YLA43z1jAAB39k1638SW83SGY7Hb4a25ke/9zsENNujeYME46X9xFVcPu6JAgevEKQuuypybQ0NQ2UxDKPQ+ze4lkubxsbhyljipKzj/rLYaOwzw4bZcM4ddzYQhEozlrnYRoACDFr9E8cwvNggg2s7UGDhYoNWn6bgBHosnwCs27EOrKvj29XH1sqZ5Kphun0sS0RvtKpdku04Th/mWZ6OOYayo5fSDI2PsamZkB3TWXKXlF1Uj9lLiSgqNTak7W9mX+woVZ6NBVnc8jDw30gbYAl4g2egSAg3quUwPtspmF20NxiMpWIiJcu6woGwNx4EQGId3V2q9NKmX8SKoUHbw3rXrXARdJNycq0SycN6qA14GYUD2BrgLG1MVxcDDlbeOOfa+4AZnuWP8wOgat2a15vY7WsBeLP9uDmt4gDG6DjA/DNIslEO3iqVmZilWnWV2hTFcjjOkZBk6AyIBRFF2cEUJEAiAz1ULmJoLE5dR+6QzXaqFe4OJofkePNU/nRF8p4EJ2F7jXmnyLthZg2zcsKq1i7TVeNWggIRcz2k1uWlJtt/76pG2JjifcDR0VtYvEI5aXH+nTACa/BZwXPHn+gPNDCsUv1q05hSmhVip8tDCHinG3v/8qaKGJ5+4Hse+uDnZxRyVXGHjdTBcroyV5a1rNIHRxf9AlPihk0HvEUFFmcycTc5QwaLwx+SJXXdYTFCIHn9CjimSKEWe8NiGQLw9KBFhCCx3XMLMM63vmQ6Zoi2VHoF3KBAWt95S1XxEa4AXBSAHzOI3SpWK5IkzZWTuxJXIM4fLXJMAvlodwLbapjp9/HUlg/ekJAI3fBItMqb6+IoJjksk42ssFQfl7lSMzy+KWw4ni1e0adtiYK9pV3rMwdByySF9nz1UUQgJTNQhdRw7xxyMFKUm4mIczpwPS8ZTe6IlRNywTtR4DFrEfGiq/KKRQzLSS1lGN9uZBhJRGOG89Go4zesbfMUTZ52ARsjjaypZ/95bjSCA4+vuPHgEjqH05EeGr5Xmpck92BwogTeXmjK9vDWM2Q7cJhdWfmgLT517H9SZygPEqVYzUEZWXD+5KA5XafjhixSGlcztDRDhTjAgxgF1xt8rPylhwPNVneovQXug+3ITQGnz/E7+YtnXWqErdd5ius5oMnq2Z5y85eMpBjzfWRU5xV3OSYU51zuWnF8FLxnJOYJgB9vuPlaLKB2G/+UN/5fPBPc21/lGikT5WuM6XvtlLNTy7OcvGPpa7oPh//5vA4PdvVECGQqI6XFIXBNtvKtZa/ZKY2ESwxDIF6TbOUlSu1vfrJKWeaLIM73xCKqWVuhiIgb0ds27WNUDgNMl9Qyy4hCMXKjZzewmPdBo1HvRJOu8lZ3flRwIAw+wzUFhBJQWKYtw+6J59efyLGJBkKTZmKPwDEzl8yA6C8NqmoFDZ+3M2rNaQelSmKwQu+D0lcH/o64tv1gx0G6j04Bt/MibEeW3EJl4CG4XqRJBNKR4O9Ru7nikU7jOH+kFerhV67DgnK5Xx28R3xMcHHC4owIAc+0zxHDxqnbSAEggKc2BFvLquLHlBR+xRF85HogFN3y6Ivth1Zj+QeiXge7xAvj3fkkaLDWuTwWW3RePOIL6hO+aXZQLAgi5HtkV1fOYYfRxqsWgdQ6HrYintlfYjXz+GNGz/GbKIaZU7FdZ2KKw5AY91534UKA8QosAY0GBX4EAQyS5VIWXTzfaT/ZnySqfG+trvouwXKKygMCx2TEShmjKQkStE88UrOKKPeLl6bjAaxScG0LtjqeOUH9fFEdUlzdA+5BnWApx0pwLEyiNECeYBgilubGCMMw86rH/b94ocvXpJcu/DqwdDONYajevVFtB/tysddh781QBOHDsZ49I40f/Un6InY7jpsNnF6qJYIHQTmq5ViuJAW/f+ekY6RuKFFvUKMErZRiFJAbxfK6AbZwpXJBBq4CoFotMKM1dhENsdgsTo63ZAWissRmY57cHFXC8mmzM+f2XqgWmNatiqn0YXEiJooe+DGVViaLy2I2zkb3DYLGAWEHD8PhiZ+8wzRY7ffyQ4Q7hDqxpVHkPEsSCAVOZ+Z/J5vatVqE/AY45g0U9lESyhNM1eLaC5MMMX1cpPnKVBqfc38CQdP0t5vqDBM7AJIkk5XjSryV33dR49XtvQ8P1RpJXzBeI/28TZoMes10s2fmOQArfyXrPnu6OpHY6kuGBBwXVmFgEd+1eskuiQ+ob7LwTgiesCnWu9fqSKoZhmVR3qZdhyX8f3DN0jruOrD5lxRjDHfPo9UqQ/kszdkyG/kvcy8bfVKDJbiVB5bX5pJojdpw7CJzhCdqNFXNIftaLsn6xB81mqyMUADzMNFuztZ8Jis6YPp1lSXaDbR8/rnY5DIy8/VQqykIkH+f8xcPiLuspJk7WNWInYyxQiEd6dFBQtcgUH8wR6tH2tr6nhd1MhSfLP5wLSq7/YfUHQ+mNuA+1ozH++iTxN3hffLLcCyb4FjjY5U6V52S+3O/OBaL0d9sK7MvBYVzGNziJzMUO/rl2/0FEENhA3WhRaK0UD++AQyTEJv6gu6uIow1PvVaRDTBUWVNzsUtcv0sckrCg3j182H+/ACoYs/fahd/czMxx1mdsrdsZuO7+aCCviWnxKMt0KnHwEF8vmEPwUtTvnb5GPhA7HgyntgzTQq4mbUfap2DicqQ6GfJD2iGuCi8ze77SGC17FSt/RRCd53UTGSiP7EbBeFYyngHXTwTpkyZK8wDyLLOnJ4Syp59QNqZvIgEzcd7co4PdCERg8faqhbRtCZHYmGQ0Tj3oliZVdBg6l3W9gybHIcLvSGBvluZk5WkkU5KyVwB6hY/ZgfFYRr7DrOhB6VelxMBLurQKJTABnjfvRq7x+b8WGrCWRhxNUi1EFdQnKW21YptqFS8vliCNCWuDxh2Mw8hYA4OwomhW6fLbHSvEG9RYyeW0/KqItl8e/VIsZOhIPaz2XjQobbFTGWRmg9txfy5oMtudYRzpwdY6XoFXMtzvVbdjqyS6Ij3+VI8dkjZIvZDbH0mu8aHfO4tRdDlipJSudj3oNTCceCZITClCSdks1v2sdy7SNzlKzNEc8k7DxBOodM9mqmLT1n+W+Jr0/SZCM7IjQsLAXM8HdjDLsl+Rztz56iR1gOPAcyICaHuUhNLBxGgFcIlC+8/6txWvuxkssLtBBtVei8Rmx+fBzGH0ErEKt5ArzbIpMdKi8GB5wWOn8iaORTcQSOhOJVrLIMHIyCyPUUmbTCQFWqlUCrUZU2X2FACEXYCsBe1F1C0kik1QBm7yqX5FFqajO+uM2xksryikJpLC5ymYpRvdMIY4p8m5VILqRZHIQx2V0DJp2msPC1oY2mSaFtP6fS4Z3tynz51cXmIjrpAPUd/DO9jpENell6pvNWKfeFbQCg36tZwGF1wPjaSntdJuJDJMg4DBe58aP+Cc0MLdk2l0mNsxDwW3dGAvDdhnnsWoaUXqM85lQ4TerquaaD358Lmp8nSY4zc46ez7lx0TuK+JwnmrNDjPlkan570UvgEgFiuK5onPdfB+Fs9B2Ye9dzi+e3BB2ae9bQ8N0ouzmQ+OwoAR8iaSojTwZ3nKXE2XMB+nuzZ2zPSV9bmOvlw+wdRDT9+rMeXTph1Q4YNQ7z+yqwNn4+2rghNvlUti6KA72/V1gA5CfTlRiXl+1LQH4m6VTlZuFrxjDZG9ryoVFtNszNWN60JWGHi4TFqnZj4dygP8BDi4XJASpylyCl6Laqikt9dnYww4G4MLna2Ms2RK9MYcnKTGMrvruZtJe4S4XDc6bJbUnTTeBhSGoatBx0A2qjzuHjIy/KkGVZBST5mEJvA4NG93DFAKvV3yBNFGjVVwBAEiQBaZyqIwdJJsBKYxadywSWhvTm+RSCNsrZ+y2xuY4vOOzt5G5WiwXXt0qxvvmCNL/9wviKo5wzhknBWbYw36cSXDijYDuF8G6aunMfBiyZAuFkTRO79RZwNlrB01cBmPeZxpuSEkzGc9vyhu5l1C5nVxtY2di8cbSoOVzcho6fWau2dWDBWXeoksHc/0FOtWgu0/5jgu0J+r7gNbY0WufQM6U/JPG1jKJXqKhcPWl0aTctSCwKG2d8tVTICwGLMqz3mQCdBiY/g/LB/HQ8pcsl+KnnAtGOAjwwmgExSFlWW1Nqhi3nWLmgGy0lspT9qW/4OhWPwEI4FDvUQRGnmcLSAuUQonMQ0BEMZCZRE0IRfaykeg6lSB66Ji7usj6bSAJlneQQs5xEKHKv7zSWu8vaDxnSczQ3HX+e5VLGNlPpV9DZhx46cJGNxv+gSnwyOap707z9OsxtS2mxgXTl486Zk8lp6AaosJCj6uahTW/wDBb056Jp6YBJYBNKtXmvQMgNLCy64gAtMNlPH+GQsKv4QqwvC5e2EEfC1HEyzxtkaC4zCL1InfvYYYEaed4A6DxyO4/CIP0wC2NRZVHIdpuertZQbb7xJjsuHTMtyE8qUSETFG7WzGrZhH6eiHmqGXp6AGBMrOACidj1mScTRBKgCMkmZKzIbZSbLWqCg5AmoTB2oAkexZp2UThjbDQkNqzVIgAM8OgKz90i2CExowNPUK94FoM4NMmmfSRPyW8cfuLVh7gdzcy4pKn9Sfry28aOnGdJDzJpcgAHq5fLCcuIjlMON6j1+kO356eOAB6XqxHTTAOvNv2VbVTst7nMioCE3tIjDwn+kQVaS0VN7YnEACpCB0g6kBzBGrpEbzlefG6YEOofgnRte6MssQK+b9O4sMPmn5aTWQacu6VGnxuaCV9hQ5ZQSWpOiwfYVS4ncCWUSVzckvoZ+7opxQfRA3bHG6u/48qLXbHZACrqVz56YrUpx+syE++g9PSXYvlmwL+k/cV4ICzgcO8fdK4AZysjKLilngpFvdtyQ7kDbMODKepgIGLuX1uP5LgAJv3Q9aP3emau3guVgp9mlAiutehMFWebiSXFeDf2PORY6jhnk3HH/GrjrNpwP7/dIHpmk2N+pC8xO0RnfyXd+fmlkc/NfuPoX9lKOze8GiPresb4/zoNp5vXiG7PWadmxBrPovZMEJKjgTP/4j/s6453Cx8F56+Tmb7T2FHv5qDrp/Nb6nOLk1RUjfXrsLtreys3Sp/JAO+TNmx9XxDBuVv1KT/Hk4NTj0TU0ijZ2AeyDZbBMfSmjpsMoPbKyrAquoPxbVtIvKxhbm512FAz6aTU5mBVIMugO+oqhHHtkcxqvNMrM8sohNv3rmZDhy6XYhns1oXKWb52YjMfFZeLwPCOUJrAhwhbBtHj9UaR4Bprpq1K9KnCUq926C9kaxZSlOvAvMR1Vg4gdsNXaFXCIWdrpurpzk5LOqLLCoXtl7VvJSK2rzOSWVbK7OXFZSscEVPSRT6H9GAeLd/wpdqUmzRvpUouZ8Vb2WbcNNLTbvwiRBndGs81fgaEucCx1dzVh0bMKALqBoqyrAJLnEQUnbgdjRc7hPamsG+VQXH6uNLm8Xx2QEQBgmmXo6CtbLLFie5bOAMWRX9+ZlqkDQqtu2gVuqqOt9l1sCc0+67hFAzbXBf6vl0mg9xefs3YW0IAClCRojpIlFyqIvzfur+vIu58Y5iu2d5lV2AMLGEBbxikePTGuzZJsACnWaZTrKQDFe0DUVGtkbr+jPI1CEPC/H6yB5WPLqzHH3tDFsVc7IvBszaKSFY/w2Jr3JJ2vVPZNEl4uLsvD24MpuHSP8Nr6RQg2xnPz580KlGMz8zqNvntpf8l1B63HLq0xkxbSTtDrRES5gUf2wWxxhs/WTXUfk8rw8RLu3wJ98cM4B8Jqv5njMjk2Y4u2sCHsHkP4aXdUZ/T2IxW1ddkt5squeihndAde6Hx/domHJ2YZBPil+SvgCJZC7uk9XZOzFunrYCWatGhGo+Q5fmrJXB153AYem9JmMy0XDQiKM6NnGxOw721pU1gHCCDlxc6R+w4ElEKQG13kjfM/knms7VvWh4c2xk+GYeQEzKODyatEWDp04o+QM3P8zpBrpRf4U656MT1rOoviDeyWLww/eOXKl39AMKtPy4flOxwdZWz8L6/dIPYy2azQB2/m/pH5W02vOduBXBQ2GzogRrA520UU1+jJqaTnwX/le+7LZLL4Dr9uvtrHoWw7n91wrlvKOY4YAI6olG4doF1ohyHknvaMSeAZxn0X4ANemxMtsrPkAubJOijDlP0GfDecAMcxQHffWrdQtFsqPJoKIHKDqXW6jHQ6e+4pZDKWth7va+nF7L7QW/DQ6K77MXjhOxiEvVrx6SNAvXS8kU6SsIjwR0HZD8fHvjPE4om4GJ115rnrm+Avtg8L1k2ZGADw6+gGvnaxKRbSC7fjWN+cA6Yot3XUEo750BrOEs27wkN1I7cHGCjNqA+VAcOavdtdnfoKACTONiTXGhfC74DNglliKc5HOwl+s4YTYIx/XwhHKzBsdMUfFdPxaCQcivM0acesk5QIrm525cv9O2bUFUwU5nMMx7TzOL7NUGg6tJ0q9Qi2WOiVKOpRgcbB2F4y4nXftPkNEJeHJ7Q4arV5whLC6Lv/nc7hNXI5TIFgRKNcEdfsiEGngiG5XIEd96an6oZWUOFrEkvYDsWpVTwZzC4nUxhnNJw8LZFaWZTQtlxOr11NsyCHTyBQJhGLRtk6W0wkFFkSRWnWJQqC2AtOyGAgEE6C6Nv19ZQmBrkXEyyNEHkJmYPBbFbu5w3LNNKXZp5DQ6EeuJkixpddm9tlsBBBlElcPN3wfL8MRRE4m05ifVYlSQKLq7LEJK0kXBvmNqQcRZFE7mx70h/7gge3oLr9HyZZ99OlIMIrZJspVCgPBHXOsm0J1sTYw7cqC3m1EYxKFBUJWGkTgc2wQ7PLeGrKFWJrKRCb7uInxESwMZByH43Pz4bDoYCvXMjn8uVmEkKS16yQWq1CIKmxkXGQy2WfNqnpz+gzAVEmiySpzw6khWPYdY/ROg+01Q7o/RdIOhqXKIbnSBwFM+k0a7voWgyJqwrP+7oUWVbudcV+iYzHYkkoRz0iFQU+soi/gTOqIKlJssAxNG0O1Xl18z884TlEzSg/MDm2tXA0hyIxfual/Geg3euo2BIOonw+4suIkXCq2okcZNKFai0fy/RQhhI0pVgQ6FiC0dmDRiweC+4fU8hoNG8LgWvext7E66xsof4GXTljV4l/bi9/FMpmMhCxI6618GytUEvNkxTLsRRSjQ2WkflEcK+YiOdaqVRwv1BrR8++z8gvkUVOtUxFVq2m2aMxEoio8gkJvYX4VlLn3K2IZIOf5asFOx0x8zP2t62AKhCSXu2Ik+taOC5EIk+BT4x4WVVpj9vtcjMBng8mJt58TqXTqVgk9BCGrOksVx/49nqdCHwOBEFRi62pyoos8txzaDRkItkZ+1oWFtDkWllxrOqARLiNHMboDLchWAsu77eA1xlt5/v+v4Cu7J8EiEJMtH/Xm5LVZqKnFoit4p3Rqn3pWP/1euGN8lVh6BsRnU8XcY0L/z5Vsd4gP1f9/MRPquZQ+8h3SpWL9ZX9BT+jnPH+enqDq50XO92nL7z35dSX9B/ff61Rtjm88jPCO+dz3lUAEEucVpr8dir1YLrlcNx/pApnfyjqeNm66tZKaZ5Ee3MtnHq/n7m2GXtDVY7ukMZ8moP7BJbwc/MYQculHZBpICkTHd19rSW7hX35frvFy28EVn1JRqhUR8HZ3z+fHdna+wqD0LqxFHK01CHJXaElzJvXFdVuJWK2/bHohKriASb6GKhYWyx1dooQYzeX7lU+eOoeja19sDIbR+LuQ9MrtnMDmahNwxkURNh2uCYrac3ZD69ZjwxZ7pGbRkMA5ihrgZ4UBB1O+12xdmQknaxLCJD7lwLffYqurFi0X/gX/trOwslhy32vnas2wzqRoHaXas5+lsy5zOZ0zBMqTnM2S1bikAY9kBuo3ue24po5f3YOE9lELM6FtiNud6AaLi1Erpk62zAbfp/dKPbKCl+UEbHl07zeTK8YO5voqgGr3R89fjfMYloWatIDTE0GQK0jGsbgs2dJc4qFnCGTBCsLEQ89Dx3CJh/e+BvPUBWrUDaYvMiMR6D5t9eIjXe0pDfpsk7u6nX2EeVjxevlUfHyWEuYes8LlQnhJ/Q46KL2VIevvdMW396k2XB5kZbUcsQ+kZKJC71r8/xiPCfM1t6SiUPw9UH57KoVs3Z6Y4eWm9/IF2qzaZk/7sWsdhe9flgtiklWWWSMqsziAMdLgpvtpJp9DAEsCmuvpW5nIfWD+D0KVuYSnNGd+1GRhToWYVzv+x4eO1vGv6V+ZpmEgRJyyxk27dyhx3/afu/OyENnYS+yZWlmIXuJqT2r9JydZjKQTGD1BXkRnhiQswFM75bKoyzrqsCVqkbjcpKDc4g6wKYfGhITqByHmThrWrJybZ3A4WTk0X+PZBmlhjXUJFpRjEqT+QU0TmdyNPA2inshSpkOQgz0/6UksgW1brms0AIR330UL0jQBbm4N8VZUTTkDCSc9LqBvv6p0D0JZ9jHgMTBf+X57k9b7oTf/fwhu7mrOitH6uu+TpDWmAE1qCDMq18szsYQQq6LBxffid+QzC2WRP/mz666qZ/KUiYYf+PMHl71paKM7tzy9ysF+7jizebsUJ/0btmhye8gE9oV3HN9vs1W85/sHxd+fNd92/34YBhQ39RFmzk/uFLD/8UWNWZMHmvMkvq7nWNXDEV1eTMZNo7Zc2VdvbzJD3nlMhG2tftpF2Gd++tdh0qrmK9TFyeL0FO+PMqoFCkQwy/dwve+/CbGb7fUi7fVHsBcTXgTjZrd6KjRonsL0q7DgTLeggM7uv/S02vmCEJDGRQo/V9BElozVBj+YpnbavJrxoHATeaGb+xfBV+JUpvN2uBNhnY2YWACzXwjitIIzacZSoIBtHwt2oe0HAhg22Oc0uU6CGtj2t0FjcTJd7wviUNY1uqlqDsH/LjkOGQ01u6kXOFb7I+qwu/XfeQ26p9ZVpM0w1ghuKD61727sbZ8ZlLsFv/gh2TlZFHQqyORZIloTsbE0vWDJ3yh5Wivk0tRjwVn0oipwnL2U3HyP3/CPalEaFqBqAxViE/GDXtatgYkddUSRePKr2F4Q4tYfUKhdhX6714LME1XW20SVe3Xff2YDXVCZ1zeNBjGrmfa6nS1CbFQCOHdnMCrcoUtWlk7Frb6hWgqX3QESOapItze9PhrxOsGLcARX7mVqkoyFubcfYOO7lDIx6MG0x0xEN3VZtR6xaMHPpKjVwZgiVwTVRqLKXCSQGFQSC00hs8ov5C2huUOuDMfOArvP+QDHZ/t46ibiYbMHV+Irmc7WNMk1uhStgEWZa6HvAJ2rYx2+WmV9w349lc0WtWUMVZIQpNUlLbEbDZ+QO01ElhG4dcWJbUSN231ZoeccCeugiSD4cyeLCZNP01Gve+PKA3yC+DDI/ytKYBo1M6Td+c7GZwwz0lclBTxLOdGL24iQLm3CpsD0WwyYNQoAaa1G7tJ0iY4KsSHT2xRu3OVTfRjVs6Z2cnWVraV0ZSr6lYVvdLoEjDqKIZQvCC2NPFqQ4R9nUnH04lkKplAJYlyJrebyjajlN2wGP3WZAbK8cVIYM1tFt8Y64S0fNgLVGaiCuMqQ7gqryWRSHWWIh8ov3ma0bE6n11pCcHDcjuUWlksJflIYjofqAyyhxa8OQlM89lAdnu6WGgVGbAIFcuq8LGJ8WIdkuAKyLbPadGPSYVTC9m0v2QUC/mdDL9hONta9aKtJfkwF89iWyRpsbiDmB5ADmTKA/SujfE4cDq6bJgmkfzxP38jTG/5PRHBrdRGssQqqxEEBklqWaZ9thjafaGIUQBLy/EWJILJNBwTbrYTJuj8YRMZ7YLzMxBSPGUe2HQ8MDCPVS1foAzshhj1XUPEnoiBKFcWWvCnxEV0NrX3HmKZzAI1sDvxr8QhMnkueYfRfuq900C/qkj/fpEKB1lQ8OF9RgaawaM3Zqikv5xPRhnSOm3A6Jb92aTanM3sgOu662szjzXaEhoMUvLRc5oGudtaYe2LF9TCXyVfi/enMQY3IrWvpeXdR7MlLzjZBAdRW8tO8yMIqEhh/fdsWv9nHHigUduWX6HE5RAewWLk7ot9aHTnjfEXnBAKMJ1OyEafc8PafDD5/3dcvFVirHyJ6DrOPzc2E1ncBQOq3i72EfGOWBj13/gFy1xcTORm2QIJpk1vJkWx4kJozyiWKxFhBfE7polOCTsjUsg6jwND2UIbFCWhKBszjJpzHI241QE8FG4RX6WbWZBb+xeTvlzjR3ZaFRugzlMtJGlY5WbQFGHVZewVaZywVONzNNsKRLlAB/pHLjyLx8i2Z5QqqTW7tOlWmpPTN5R6jKmqbzX4rhNVXb5rdMYnF/zZz5kmWyvJAJ/gubtkknqF0VAhkwt6hxvhYlkqFg6ySDwlrrjVh3R/51U0AmZ0stvnEWpoYQs5vJXV6ZEKHHapXa9ZPaWvAZFT1O1VdF+xmt+jLf12aXb2bFUlx/Z1MhVh6koXoRgqdXWZjmXbY5M4hFgv13wiib5VtEGWmgDzHEiQZ9CMr21yXHkCNp0Sx+cLeTBOgHnPYykpiXQmC6s0w2mWhRCMoXA2zcK+clbMpJNxiczUenLt5CKRh5Z+OM3pKpw574ROdh3fDzgwY3RyIXU0Vi40Go346gN48d+0Tp6tnJhXNqiQYVIg6PQjEa9QZvaRNV+qR2YyyoAwRGfu+xLvveVpcbZsa32mcvGGXoUxlz2gki6X47wUzUQqS6WDNoDWxtJDwLxngo3iOEnBIihNs1lW7MlTBgOpLJI4hu52y60D5FrWhKJKPrUoT89jOK2qJ68bNQd3evSXVEsvd8FmJr6O2ykU2s7JJBV1jLYc/+vX6O6oARd4CSJW3U+8znzPOgs2G+guxxVlyXJBFgmY2y+J5jeIiARmvul1pVR1qLEzABvYKsDwM1rMjgdGcQEigc4J2DrI6lMbW6oVcuAxQOGc3tzlTZFqnzMDOIBKUy1qam/zKAcJBjmG31eAmoPCO4r/LpJfsqu+oL35SLhqvbQmOX12snuu0QEAbc2wiuE6KWBoERlK1QArOIsdWgLmlEtHGlnJhZRCtm1dFfnDdWynuA11pq/XXeCBfrvcgAutctXQsWSXj2VZfJxaoQdAfe6jK6qEM+8YkuNEJivHoJrYmuZZrhOtQ7GQwUu42aGa7Fqh29Ecs6XtbHFZCLvC+1mru1ZbNWE0GSPS+Ur3Ik2i6ShUKptMZ+MpRjBKSCBDmngrCSRmggVyEAST/wn49T5llppE2+vq2I+hxYaRmSySzTFmtwAjwT2Ix5nEcHAOwcmmob8I9N/pQ6cRspsjGEQEUUYRW2hCQqvvA2Y+dQQosjus83fXn9Klm/JV6ychIO/+ujRwZcW1AfneQ0TdTz1kWM9EU+nWdYzWofqC+lQpeyC2k186UR13YDAx229xfkH50YW34Z2ceGKVbYO0wjbZ+D08/8jsoTaDC4+qgdDhPRPftQzODNZYipZcyOO8zmtNLruhIHutejqxcnbyf6SgdmsUrIRHvNk2IWjjSNw/J098gwM+Z4LMowzEo39jSnoqiA7XbMrgBn7k3U8TiItToz4TEy5mi9XDuMe/N5dmtiJLS566UEWCJ2wAz0BZndxLyRW7uFgPRszNLJLLERQvFvIURWCZJJCUh7AJHAq8pLEFmQM4KPutV6Q2R3NL1RqZ2mUagUX4limpUycs1th8e8FhDJzJ8H8guKhLn1fVc6ZohaN2BQ23GkvACPrQUK2RtBwrOxILIhSkB3LtMp9ozCMW4XYzJOKeR4ojaz64SCZdx+URycyiTWPE3ckF3uoFmU/sA/E8hMNKjVeNDOeZElg0hP+1ld7lPkxulxt5QEv14mBltZYMuAA1gUN9pHxMzvnjAF+5PkIsCyV8Sc5bWk2u29UOU6jTYuf3iyWRhwum2pshfkVc8JZ8TgRtd/3SLyFR1uCREvEkiLDZvepmpXWCeROVYGQPgW/6GRBLPbXN1akJcyICIPo1gV5LQjFVWmPiPEfArDotdcqpywafV8/GK3fedarKiP59Zcj0jUbMBMa2P1mddZ0ixBOzeLEA7gZ2giLRCTTdFUHNeZPg50H2VS88vxeVq6/ntFlBbKYrFs41JbiCH2nFhXPXgrWmngKduhkXxVRa+9eDo4Mw+5I0gpI5ZGyO7iMdXj2/WSyL5hpu0djYFo3jno32cejWoFJQjwvrqCAHjHL+5Yvq4G2nizs1F2gWK04B8axjvrbUmJ8rdzCb6O90Fkc314FajH0amzYbx2QY6JjPPxEOmEVeddvSq4H0ws4RCgEINe3qQDGZoO2iOn0HkjKSjCC1dipzDlh8NEBu/ssuC3eCa97i+cpcaV691NVrUcphtiWylFhNcBfpPadZN9BJW1PlDXIh6imPcW9xVcNzr/9Ijt+avd/RR5A5QneDBG/EI2KbhHBA7EROT44mOgMniDRL5rhiWUi7xtaFrQwGpd5dmEIEo5BneYHXel0cK+lH2fIU6AYrWy/OaktpiynEV3Tg4bMUvrps2TwF+RYgo7afaB/TnXamNsMnwU1ZGp3cymRLPVhrR0gDE6mKsL5dzlXXqLze7IvvHOlkuus4LhTJf4YrSiw0Wer5408QXntQoLT6ulk2vN1AAagWDF5optskb6HiW9GGS5aRCSF3hI7gx85KoO392xjy96aRg60kw3GadKcyGwwlFkM4PpLoxswl30sYTsxot6ZFzWj4l23Lrulg2fi+WJHqNii8SYRo99tBaXNNUIL1NYy4vI/MtWVagvV8XXz+UKrQPRE6cB6mDvfEj4XfiAfZJrYsSKz5loJVGZKP0Jv8/jc+3ZREMH6fxTiMT0nxkfHF8bnxo7sZmPjW8WPjt48fHs/LHv0Ekt22hsbKDKq+Y1vriObW0I4KNwoSf0Vd+IELNypnDPVWs74qyiV3q4/vagBRXBwW66L2L6iHtyqV1UabOzOvPv9dekzeNxiL3OUVeiKyirWOoIiIRdJ5mxMObNcIG7li8QKdiGFzV6lN4kB/JAVtvQQZIeRSvRVKXy8ih4Du5BZ+unumIsj90a6FTbIl4cH2jm40dM+P6scrztxdYZQzX4HIufQi9iD4CLVjYfXaWwFUZuNuY9Cj4blKq3ox/2oXtVm6XguhC8cYt259VniH8PslDMswLgmLs0mpdXAuiZZw88Gxu+ghA+W8UVFUqETcvFW9LdzpMVzyelUlJJSPKG1UbZUiNsv54HJgg2tTrMupmWtbfD+whav6615+IcKtrPYjburKVkiGblA0fc3TaCn0itBAtH2tF4pebt2jbScyQEFfxibs/8+bhPF9J/JZnIqO/9MMq6vDDCReQS4aj5733vdTv96X76ad3P4VqbKzuS4B0UXUcGboEeSnBik4sOjCQfn026rUXyS0YlFoS9vT7Mn9juhfL4XVr3Vj2lStcfGBJ1iB5UwwwjcffprMlJfO70PP3HNlZ+0PjpLFQ89ZdObzuWY5kiSVJXhqyn2yplJxka3LfNY6FJdEqKTA2sM0PaVxTs0NrazIQ0K5BurH30M+sHnGTSrfF9OhrSPqWBZEkRaSCZmggRHlydXhfQmj6pwHaq5satn+KjlFL9bd1r/yM/imM8Ax99vnBtY6ku/1e849/y7MYD8L/fTpCPKA1GDqcQ7xhd6kwRUWg4svSX+qEjGhslHjD29m8pV2qBHYz4mZ2EVDvT67FU9amjwDxeEcn2Ok31NX2c8PZahlG0Z4ZvRWv/H0xL+Y2huHo6QD2W2trnTujK0KCPX77Da/ozsMbxL5jYdi8wyJ7cB4zXa1iHwLoaQLqFIt4c8OpRfHbZcTR7mYixOQrYtXhqywd8RgAHl0fLoXTtvDLthSMwR3chgsQpRrjVF/j81hNwVxgsl2htvM6Pw8HAsMKtevjEnVv1YKQyjVacq6w6AQiGIXRyaIIY85T68dmlSov4baxNptodqA/3+vnLQddu4aBVKhTRpb4gu7YDU7nACE5gmnmCn/H0d91mOtuqxCDIZ1ER7fMEOzGsecUU/XXa2MIBQX40SBMMpo2mTcsWKFsOv7+E29TsMWI21bn6pnso4sTCTChzfyBZFGxrJbXWhZlIj4xuBdiJgcGsMms27ely9chodwWVQ1nb7G5HlNHEYjLM0YXZbaodUdCFP2T8djoaiWa6lAshv529FoYS7mFyuNaAbMxMGC2QYgPK/byB4n6+SFNGgmCYphIAwLa19RZVmbp3AdjVurIowxd7dTY8NOq85YCjJaHZfSdbTbrZcq+/hytZXHapc6NetfpPHal2Qw6FtZI+Qrrlt3F9m0eqtRg5TBQBAUdkt7NHm9YRveKIVarIXLJ1rAlbzekf/gYlSvdZod7NUm+0+U7bPDtnXU1Cs2dUhoM697GauXcmAYXhxb4ZWgPNWOc1UJ666qK7nXzqRi4nqpw+xeIWdiyYK1/aZKUXk8nYjupxPZ4ly2YhmCJNu8ZJVt3axNVIYCgJ7XR4fHwXylt8WBRss1iqwyiBKr6/SgcNLuRLo9tlb6kHD4YiHLIruZKhN98+AcVy4hnWQgPIGzNOTv0Eh1pKmPHsoC5U3NJNPbcZYrFGpYSNYRc4QC/JS6qsHpcZjBHKweqU867ilffx1jUZgdeajMk+ON0nKFMHpmtCsO5os6HzdzemWVh7YVMfjiJCtuTpT6+4yLmIsXWfXDxMQ8TvMGPZ854aAOOmN/upbKCH+zL5bH4HFUUe2GYOjFNG62igWNh7QSb156wUzLcsjdfQYnJkjKYIbOE3oJgQxL2p1DzGXUuo8Xl1ct5ma91lmJOiw1mnnODwg40AdF8iu6WIt2vD3KSzi9hclya0ZrrK/CMjm7rZmNYCyzbAL+iKWjo0pXMyvPnLgqYrUkGQgMVRRbqD+qYPFNPE8P1DxgTa3DLBHDhVyxqMhWVmASfE6yu/49XhaNsL8WYd3NdrC3gIV2yhf4QRL4KbgVZSIH5/G4PxDw+YJCMeTQ6K6etfgrrUzmnXREd7YMPcjF+Wi21PUFTax4oqXTviFwM6+aKTB/vZEkpn3bVPVSFWk3SR43PV03rO64KMnVLNBg+Cz4f8rzZdYctFKDtoeEPCNUictWNaxrHg7mBumJtqwyi+BPd19dm3pYZJJk/bxwtKDOj5ljLvn1U8lFrXFQsL0bBv2yo2KqJMMAEaxrFoYLyngJGUwTcxYg03OMZJVWlaJTMigsgoUlwSgeNlBcti9oEb0tP29l56hdRdaurSk7rC0Car+OTdDEwuBcgxfFWCJrNYydR/csZ+4iJ5NPvKSk92gmNe2a99i+jfBWzHsROqRnSWAgrxahBTnHcMRkK21Ksr2JlpFc7WX+zo/25qWaVeVRx4IPcqg3814/G8vg9UWrQZWSBv6XHfn/kyjh8W6x5gTKROujKEhZ9NmLC466rtG2Zdh7h4ThJX3QNXi9evylKWkLAuJ0z47m3PwGX750rj0P1nJbhV7v8eF7NqrT21HWgJ5GnN6BAHLJMQf+dPD9LFxNdo9xVTPxfIIaFUbGmgE0SJbG6Oqea1+r1CHTo2qRUYza1A54ObDTDR3Wo1ni2OT+OoUzJJyJeGO+7IXJZJZT9aREwUCdZ3hySmTgbBLaOTtzMRiMG7NEAtabJrmLuWyOVpo2JWjWzlUGA3oNZ9O1eTjvuU5BgkmV5FHeT8NSDQXM+XJkqbVTW7OO0OroaEExs1ZuWBw6AUlUl862Pkekq7hnVxRMSBO17RELsl4ZxoIgIIMudw0hsVFbolheeThpJkUqKpKkJSUjPFxSG4egA1NDV4wa60DiIU2Dk2lZYimw8PwI2YnC7vTTodTR1JY+7mIAKzdqd3C//bIOMsvvmH12GnB5GsGPQcGCjn8kp/rBauD9HVtmrwMTdFBf5577ut50AGRldnNT74WR1/xnhoL3vBq9NEobmsC/Q44H3W4QZon8hfsJLydAbsDD49cCFiJdOjYEgi3tHhjGvpnrEWSVZ3B5rlzO8FVHi5uNabOzJeLJkUHyubX3L4LU2OL4Ri6wwU7BFA4w+nZOPx9epFGnN7Z4u3DW7rsBcC83vqTUh2/J9bJwfr2QE+iuzDuEm7E1bm7IjOm735Xu4Vy+V+kiMBVwxkm8jxmg/qie4WjKnDou364bMuVPwLdOTDQKtYHVwYkf1LNCGTABXFFWWaHWl8DDUjF5iRfNtsY1CbNZ54X6nzyP85Bc6rgdV+phz/XRLcAbIHYgGK9pIVdIbsHZ1I4TVVPwlOuOCwtKIzqV3dHvZf6vvCLRsNIj/LUUnahtynZ99Dh0cdMk4+JQ8+qt4b7v3C4afuc2CMW1ILaqgAnKKns07voir64XS9WBZNQuLhg8sAx2F+Aa9vFAU3xcsbw0k3ZfVe7Y6Nq5X04FAbdiB8SsrdZxckUjNE7IE+RymZG3wpQlbsoDE05Hoi54rxU33GeFp6e2CooR2HpeGNXcQKgh6Hq+IAA6Xq9JiSe7FRVDK8pJvAS28EUZa4rpb32cPHfj4MOzlQFH7I+9exO8tOy4CRsLhc46GEXv5OL3CoLVLqT/Qxz3ovXoO/FtSyhUPMDKgBd40PLgYIJ0umyYO9LrlVarE9syS1XTpfcNEH5AmQdyc6vVGkbKXzHkaothNhkNkrfIF6I++K7AO55QLCrECvPsOAnLu0mfA8Vxq1rDxquyo/tC5JVN5fEq8zXXzW7jf1/fzyk+1yskdrswVKET4p8GXKnnNPsI5MWch7pj6bPCxCiwHI7QxnABIg5kqPYfgUgHMCAZN2Z2LaOWDI1Arx35W7Kg+AcbMNF0UwF+ip441E4ShURdTNrq+p5c91QJ1cq8qBW9U+hE6134GhiAEEQGJOjQm8/OO+eNWvEZl25esEvIyJLtwlQQAEwNXJ7JTxUTC++ZCWPgr2q5syXItBw2MV9gSIcFsFZzDAC13uzJfCbt4/sLRsnkLpiCfp7nevciN3vZ2j3n52N+ap7NH8tVvrwG8C0sD0TYiZ8fhp7fB12sCaetewVczzL7pvbO/b47rzxNAVNVmrPnvtnd02INAMQwfMoXBHtavizeIDBG8FqK0gANFVZgcI7EeTYyh2BfZlYLKruRZU2F2AC66K2o9nrH/BeqGl0snoalz98Zf00Yhb7fq+YspZLKW+kDAPFpb9z2t16f1GKVwWuTB5fLcA9XLnLAeJ4onOr58es2icCc3ns16p1DkkSguLfjAe7BvfAS5qiMwyllIIpKSQQE/Socy70wDMNzwjU2faTB55h9fIst5bAM1sMyQrfvVctqcp3zUcryazUWNhswtBbwp/KLSP3iPKsVgYd5ZLJ7BQ7xMLmSyBES7hnZVb8tPbIP54aTh2u6xMYb9HLkOjSJPIClo0t64xAi0yog4fuL3DCxiUkVFQFApOrY74XKR6Ffy+JbhRASdEigojDhyHZJg8ai7ce6H+2fFuv5XBaZDAc5hzMbqlmuWakg0mqShAQJmKJKjZNUXQ8GEZjpEmlelgSO7wmW90ss85LBgWZ0N8C+6r3IvIgBhcMQnTNXm2otKX0gPzd/vGelI7M4COczaDa8RWjgUYfsPb9FOj96Gtt7VoJoI+6jkESoQegxQx9Vf0/wMdBrb3cOgDizQT98a0nOnsbQcBb+8+M2RGIMFTJ6M4bvrjI+l7eZjDilmu8u0K2cB6fWQgmsME5+rVJqQeicOsg2/FVCbGXRTB4G8dg92hqBp+x5CUkyOVDqbAHb/ADSs3ckFOZI7waXEmoDrR6T+M7kduqWDF57bGh4a7h4RZnEq+yDPgamml6rvFBn7e7NQByiZssrsapm8AxsYQFYbRupVfrAXh5M8Qv6a6whHSke+uWMH2ReBjq5PS2tIyX9LtW55GI33BW/7Kp1pahnjz233Fc5JHEo6vatL2oP5uiyWsNgYrEEgC5XsloeFPbrR/xhu5SGTcUerq3UH2yT54Kp4ffSKp3Q/pNTr05Ry+hNcxja5hD4TDmPqfHGJLS/87nSsTllgHzehogxXeWDG2wAt5J2VORMBk10bKGnGy2tQslzkq9yKcCe+6oB1yPsp13jBL3sl55mCM+dDx5zcTEj1AbFcRJWfbkI66Z8GEJy6YYF2Z29aC3RFR0looeKjWvre8mwT9TSnOt/kEf30nH3AZFWaLYaq3ZLeRxy4nhsDsUCIFc+QQUC+uRqyRPz6rV140w4MvpKWQcYSxeMRsUDjvMrK9WsuKPmpzZLhLG34lmWCJBYgUxdU/hF4plw0Go4g5FfLos84IpUO6IdKXvdu+Xm6X0A9TngzNQeOud/cvPrMVL6re5Dgz+7vgGNAADi6T6UMdZVrEuSgsVVKwgaYJC7ThVL6jm12tGa5Ze1M6sBFrsXeKoC5s+YXFz4IawMakGqM1a5yrqi5I5/Dkknk9DE/QPLRPRdACC9WBun5dQyIpWWxyMScQdBHxR3pLSZ4gEwx7zYhQXYifgMzUmOMChx0nZSwpC4kge4Z6wLsKZMfVZzKsaqskgLxYuuTXbjkjJGKKVK94FV7dKxVI6Bg9iK4wbssQsY9LcvcsEZT9LO6upGJwpJsShc7mSZxK1Su7nOULizWS+156gszSH6d2lyWcg/510ED82ySJLX9zDSNrDZWF7H9Vvf0F8/YWZXkKm3WlBWpDt43DBrxeW9aJBNhufRdR5YcbBM9//tfeO01lxZp93ozjuTtP7ioqidURpFb4cEjRqLUQ+AfDW99iD7rCtUiMF+ngDaTRu6qUMgMvf718ltJmpVXhDk5r7imvho/uLIo5nO5QscmuK/5Jgk5qZ5YzOvyC0xuWLwXrySWhgOrsqJdjfgjnl6xZ8oogAWLyIkB5n643/CgVcWbLVfQPV7/CK4jjnWwogAyzr2eDlq3PFuW9fgfy/ogGrKR82nF5CA7qw6fSdFRs+ynF7EQ/HJhMn2e9z3ZQUOBB3UHuZ0jS/igdqqM3HiqjAw+hNGI9/Vp3p08ijHx11Q9xvy7cDJ/haz+nJa27N9zUmYZMqpA0N8StWtl14QJCTcykmutGC8OHIh3bh8ofeno18yAX55xbG7C464jRg0B7F732XtluLZZtnHuD1sNM+OLJfoubH7/Y/KlwLieiOcK6E39Ex1Kfv9zyaeUQH/2v9BsFvqGs1ezkuYOjOlI+Q9DKPIf1gwNrxAtdgmQypc93F49y/AhkcCA8/d4ZFHzkR+bVLkpxdUK7no2cdtaB6v1iO6775QKNqAlUt3WTifhZMxLbQujjzU8pdPyP942MVl4btPMB0EBrldRKFJePupN8JjGUSRccatq/ze8M0vSdmUS84It/+kMocqy3xynyHeNCj9vLBMYYhTHsd+IAxHgJZvQ40eWJVqkwhiRJdjn4SvWzdK9L3ejoo0UJZGU7MPrAU/AZaQtQ36YCsFkkNPgojTBQaE5S9d0an9u1HSddxQp1G+2ib0njMIJrzXGiI1OOS86DxGMjnH4L6LENkWkFS3sge9bXjxTrvu2fRrUEznnem4cJ6RTYGz4cZCoRq/WFCSVx4r1BPuPt1Cjo/TZve5C/KLv2TN/dodcArzMjD/VX/GC8dyLjkrznuOhbyyvihSbxl4DkzfpX2X2l6gEmEIWNSTV6r9qeG6lnNDhewBMpLL+fJ6ok2WjmVb+ZpNT76BzCx1YWDH92vcWiaNAAoPesTwsjGf7h3DssFteLYJvFTtKRbxf2tHPaHQkFJlNubmlatfMCNOQhbchstW0JAwj3LMVUCB8rFJBoqhRLkBG+PILHezvb2HM9FeZbTN0zcUHu/hM8VUe54B8uFGgIti057xNBTKBr/FFngzTRrEyeTOXLTWQGwzE0s07nuua2iJP+1B0cndNBy6HHzspxtrsVvy/g3K/X33RhRkPq546MU/nMf46+sXBhRV8Ndo6rVyvVPsSdr5jWmaZhp+V2CUUG/BS6vLdTm5w6wGVvhZT3VxOdLku8dxhDuUuD4qi62jqWQVi0z529v0I8ttJMbEl5xXHRN8Z3UpROa8nvZ0OpO7aVj5KZfSv748dMz5wkv3zBPrl+5Z9f/lipQPeMQnmXs3ns7Wv4RaK6Hkvq6h0aLucB3VtLuXGzT6aQlSUZLYmUrWeKV3joaCYTrGK6UkQs66o4KW3zVFNtpHEakbstztR6l2Tp+50x4+uxxDeQgiJvUbW4FUUJ1Xo+UwMuJrBs/RqfVoGh+onyDWk/9xZ5vJYSYT2mXqxJ8fz/cefTlmp5PLmmdnNxG7z9ktaNqF8ADC4UJIBguTooju5ZW6Koo1IWnk5To4W2LWYNF4DBApJLc86Na11b8N/vqlJYuPmXfPsLNxHIqxs7BxCA0Tpzc4mu5P3aHxW8cCXzaxHj6hnmKMV0sveHvocpMBJ9Ecg+dyj14pveTQU9WEap6m0kYp7KZMGEaH7KwrBBQJqplmgqG0cEcfKM9XBvqfx3c7oJxHAPx4LiFT5bK+NjHdUBhApTKb/Sf1ZBRhGItvnX9raPWgWkrDOi4GNZ5PijSpSV9up/EWcUnIK6c/fS/rGJovVScz91XrFWu3rOcCvXTbKt+UuMTO1FMd8bpTnPuXuPj7uCKuX/xRUqnusQ0KSXjuBmuuM9NXkDjs36qJydjIQoPo7/+LC7znQbfTPPc5DBEfqzUb1Yzx3xH/WdHNya7xORA9utLsAYC40YnGp5eIYDjXrSoHph3NZngauOpDAcWMIgF+Gg//apUDn08Hk+tiXCvg1ajV66On0kLd6KPqI/1VJwEJJCLdBfjVaXI4ymPnYhDraAGGhlKsQuR1AoqfPKdJ5hpK03OnkfNK9jHEVSdfHxcq7kWDkXlUlXq5158yZnJLbf07zdUPPrHW6oAP0nFVleEikSAEToByetn68WA3xNdB58s+cwDUvTo2avagThjbotfIiOxolxoce9KRPb7x6VCYLCn3FGHOLrqXdLvA3DyqSAUcanwgbgn00miIxPrsNU0qfTItET2fHkGsNL4MtGaI6MIM5QAVAmhPPW6n04VYZW4XTlASpPIA0XMUHW+KYb1a6tKSciKaIWifDiwrhwV2L6UIg8tKQWHag4UysDFZIMjoHZcvtx7EKxwUuciVosOu7gUTHr68ZgNOVi15MiYaKH+Coellj/JRP3aJx6KU+S6XxmTsjeUx7YjBvvkeVICWbyNENb/vYHwbPEyRwLA5F4GqkIKDjWWABQoObGOIc1LiWukwPLJ6p2l9SiZgCzrv1BYdnRcetKSbFwydXJXPFBamjoXzlFugvSsrzcQ67+7qtJj5tIEoOdjhacVegR2Qk2Zt6l0rU/2sFx+qkbPMHWAw++jWufX00XXdXVgCaSlBC41vq4jCjh5w51utpTHZ6U1aje3JphxkZpTL4KH41pSubRhW5SPexmvPhKPvHmLCG2tUrdOj3sLlJQ4BEjKVD1/ODH7zYGVmDddnuyqYT7vBr7WWRTs5yzNRK5QqgwGBlKABPfWjBPeM0NVX2NqsrmcRVcVpUGtP6r5os7cM4gnmPzos3aqUchhHrlHfcYNm9mANTaSlGFy/fnkRFqGnnV/6RWAy60Ixix7vP4zDZJIdIBd//UCidYzB9M2Y2xzlze4toaSpRURoTPPTPL7XSF343xSonfBJolZEYxQXFE0LHc7nOhpQDNUQ3p/98DFBuBlBTCdSYiJC25NYr3Tcjh9V7JWecO2UPTXu8C+dXnKrHom6HcPlwhEZeVEpKGekbzQeocIcCoGLiDSMLGcgp5rVCtx2Oxo1Yo9kWnny6mVTfLl83skXUoFe6ppOFDfEcgvQvg4iE4cCW4X01gcniEkosPE9cjuHoy795LEAomOtO//z6lms+3PYecM56lh4aluuLWS2Bkxq58xDtQTkN59UWLgg90xR965iuInV+0T/WQJ76xOEiKWZXk2jr4skkRLFIX25U0pPld/J3VK0bUdhppBbnyUOmslweylrALU/JVfohcy3pEKrusBL7IO+jsGwIZGZYvjpp/uBK0merMCipjyuyeW6h8GFPBriIMx2ddqbtlV92bZCJ6TyYxLQe7U8GisWBZKRFWD8zubJSS8p4PGSwAqxHRm2QU/niqYElGdiQ8QiOJD8sXSuX54xDqXv3dHjYKbc59VSLhNC97HbVy5My7c2Xs3ICiyzV5geOi1KuwXirTmu17pMWs3Ck6e5tvQRc+Gd+UQEITwCCQOWHgLPBe4axVPxL88o+VhxLZi6is9yYs2650KmvK9VVD2gWxhzBRIAaKcCN+7itGNQZIBLzOdrSuyYzRJrXIDBWomP/yeTIS+0LX2k1nXSgu77LhnYCtcmGK1PT+zGFiiTISTT0nTStlFxlzopbbKCwhu9IVsIF7+QMa1Kc455tEAjz87pZGNDfzodqgsw0MfXtp0Vl+IEsy28nT5NbWSglJPOyXRf35h9GgEkDt0duNi6AYrOnlST/JeimWKhRQjtxVd0VTy4WxAFx++c4bI75WVkQ1nj2WJufNLIcukswTXpsav6D5wMxtTnyS2nZZsBKhGC2Cyboxr4aV0PsRKMUmCNSBPZVf+K6l1SDXePqG1DkIllcTxsz87wENCwG+uTZ4E9xwBY7SdWOhCLa0Gl/GOESUqtdNtHkuDbn2ilYEpraA2UEcXo89Uz01WMeXjXoDun112Sd17txQ9GUufqHWZ4C1la0hxgLhuaxfWWzPFSzldnwRs/kbOrYGiTNwxxvePDh2s7tuuXUNQYPT7nD7IBUmaElUZ3JofZyBxXqMMpJmxq4DgnXbD7XGSVbDRglwoDKZx1yDfnj1/IkkufiQKlAJJ1eT5qkm32Ix5HnmUND0k65BeOlpuOwYBmPbvbwZZcMbgKHSaa5KxWmdoO8BhFF4mRrJcvVtx8znKcFRRAvCo8K+9jtTdPEuz1235kSgm6fF8SRu4w4oOfPxaEs6G6E+fqvyVzOkngdFH0p4mPPIN6Vm1kIl5c3bIeCaoxC11xuHAZiyfiF+C1SbB6Q/9UdnobNufLKXQXmeQJVipzOf9A4tr69er3G0Ka99+M/wluSz5U2lmBN8iTfLh9q4nl6NTYkP3kYTBscOe6zWwWBWpFBXg9LnAI8NiSdpGvc4NglSRNnJbQ5EGlaXB3tcr4EOCieko1y+x1kE1AQf02zVZyUl2FqexdfmVqqttW07x3Bjq9Ktqkxg4mepQcBKyW9zwIWFn7lUV4sGAZPueGeaizXxSL7Yywo8BxuvKAG/AITjYjhtHgYLfn7wBq78knuF8zlQWvD21byx+ZeEZhWDH63VQMtQ1dwXQ79Kx3SBBHp0OGn2EtwyW9V3Z9e6IyRsbrcMfrGtjcyHWN7jWYjytlflS0naMilP9nbn1mLGHx2HkTB0+by1XRXBsaFgBNe3ZB9rX29jNs66fiulczRGH1dttGLgtmK3wPri5EP/M0s6buoY0b954SZ2ekxtv7O173AmvXrqMnLeZ5kORhep1WLZ1DsEUe3xGEb35KChYCHb6AyqOwQSCtHsUMCYMOX/x1rd7JsjdjR2dyH57dPpfBTl9+eX91zrJjPXH1n2nCnmDy7PIwMc3S9rTexAydugrHQAViUoFCoY74aWlWFdYHW0Yj8ESYkCCSqqqA6k+mJQd6sJXFIEilwGwGzaFFpjzKXRylq+6aDSPeZBOachlyunF2SfY882v3PvsGCsi1LZU2WDlVk/dU5rxbnIt+cPPojhZGefiOfoIvy3o6TXiaosizHzmrLN2dFRwlgH/Ai/VZ+Cg/ZLLpzzDnyVTcXsgdWAz8MEOhm6qTU+CvTedFU4aQRKaxLWvaHl2raSArB2GSj+m11q3dRU47EYlN0vTA2ZiXVI18IzxPejBnFw8EdszAw6ze39Cwat7HxElqilWlrllklhnu7dHujXNXtf4Vm2upbC5VfvKN4XAovVXyPKjOO2qrCpNvxtdTDaJJWuWpePRA/PZljoc7i85pUGH/JH1ZnpAnlBcEUZIK3jSw1IcxEEDPXUw4FsOFMgUD2WXfr8v7c2uELttML3Uv5TrqxKXYgJCeDH8M8PeB2KKE6M0O7KVLtjLs4wC1vcp8A98Drk16K8O1Oq1eGyqRikRSwAclOjnZLWQANmKPAAZd6IawP35D+WPqysa6jvbOhrgoqSxCToDUMyFwed0QVBQmUqVpaF/qdbRsYCU5kOcToMgSagNl6Cpmn+dAMsBhNFctgTccgA0LRiEihvodagzNvlY+mcsGEQREigfpUgTd/hblSvK+PdSMIm9GjLlHibYsKp7xtmy8wBlUKdtthfeMNSHim5kgGN6dxhHPXiekx0oE4epCUM/iz3iO3ZpjHsHp6DXZOXb9PqGD0wFS0KEUKID8lppv/QYdjPSyBS957unGA73tx1O6/769iqfDdkspho+F/O5veL5N6GKYtBcCFTw9edtjlt3oJdKQqdT69qUHa2tKjQONuabj98+NBWjZYki6Yn46jukgGi8+764NkasN6NIA+xhopH4WewWmMJST73SPTl/69AnWjR4zQF68AVjyUd6yHt7V+QObcwuqk9x9Wf93L5gt0XfHmTBBA23aryPK3/gcuDLvwhX5q8ECVhX4naNBvr4E1gkkFNcUJaYGGWQmXVVGyZJDG/hCM5Bzw4nAiXWuKIuyDo/EvhvPo7Y/NuOptgnz8VTaN5v1tOI970GbqxEEI3UkdAG/MCwCruDhL4HoewvJFB6Kvc9WljvryNp7CSz0kTw1oEx120A1Sw9vBKpgr63Jo2+9ZiZdc35jcHL0YyC3A8AB0jMBZ0+MTYDCfB/6eKH2MBHxgU+Dx7qH/wZaO4k+NnUSgf/DPwCTMRaaMTxS+5S5eqatLlOW++rIOngJLIbjK08PhrEw/Pl55eHfgGnYUyv06NlXm/DQbMyWeoZRyzfxnDO1q4AhazBzxsb+1fNvTn7307rfX/Xq1gzmjwPxcv2H6de2B//CiyKIvDDuI7BTEABEM5L/4Llb3bH6GByy7dhRsQfsaZyvhgOW7URTCGshW3vcq6sliykgqH/hauthkXWu7FO7PLOOt5DPLIfdHlvzWLik2Po3XLZbVvXLoR0s9nWGCwCS/ofyxDSK+45Wd7q1qeL2IS80CFMGDpqsUHFpltnrpbrOtGMwtFEN42j3ftrUPXB4DnoWalMoUI/uiQx3Q7K16Fx6RtpFNjsLONciFqt7Y6NPwWC7O+swRq6yhzeQJUJfb9f3q84zY4fDo9X+0c1eEw6OOkHzZjV40FteGAJu1BnhuLXl5hAhlxwvrMltnHg/WcbnXG9G4qeeHLnLBWD/83+Oe+ZH2t6ph+KqHN36XS1n3nIK87arh2nbD/EYe717TrSyyZpBd494rQBg/fbRrhtWdiE36iOrW1C3luLqVLK7kH1uNGcYp0XsCpM6p8h6Ht5VDn0rV9JiEs/Era1MdIzJlqUYppWccs3Xaqc/r3/vyNs82mcZd4Buqdhf1+0SmEjHi0u0vDXqlrN9m6RlYTQPsjTaPTddmOMZ8xnF4vwejAoprnF/vE7ZNxhqQ9qv+WlMImDWDmdGDTQ7xB7QgQZWwIKLUAUpZZYK5cJEzTjvTZvWR3zfE67g3G7Y1iK2rhbPyS81SDfvAlLmZUwJkA3vkxLOjasBgATkO4e1y+sHlmLPQViv2NV5M1jOMuOA5w+uCq1w2vmUZyD1vADpg+yzyD92QIDvqtgh9ZwAiWcBEGS8tX94YAdFlmvYi7ZRhbP9MPgAbf4WN2fXnkFYGc8QDLk647BLQsajCC8TsIl9JqJwf5uBg789JgA9v5oFGiFZYfnObKBwPltgTkbUmjngXC0DROHezOkozc6sQ2VmSa4J4hH1/owLGjNW0WTGIHcgqNwFQkHvXwBbEDQReD5SfplDqwoRTk6vz7L64qj2y6KWfWVl35IYFW2iQG6BCPYIIURt/gmpiXYjaGcbKJIE6hO5u75RJ+Gjs0U6jyIdzt2rqFdZO+9IqSrSD+leh1lui3d3Q7ReZKdox7uDy/FqIxq9e6vcgul1EUHGq5bRtvVonMw1F6nKYppcqGvgvAJH/nF8yxkVRtVVzE+K+k71c9mczGcnp45BJXJxFWRTzkjuR7OgpU/70zuvKL/ISmfXR5qvSTx8ahYwSD4+OkXOMtUdCPUankcfUrKKHeNlIe+m45os9l/seI+kr0X13QJd67zY6zv8GzakP8YUyZp6Uo8PIV60W33WqpVs0y1tHTNc3DxBvjf7BWLN4as3JCyS2azNHNaJS0hKxYbNMrJy8nAFD0iMjl81SoxbxNEm+T2ZYOL7Zy75CvL6xPfTfK+Dhpu+orKzeh73a6wssM9JmtTHXPWY76NjcANcBBKFVpPwouUJohCkJGXcEU4yIEje+xRkql/PYojkGickdh9axncS8P/LYBVN7OMQXPybVDj+3idGjbtF5ttq1bntpKZwAwo4kDgHGljgQQQZVNDBBOuHJbyjyz1dL8x56Y9Ub+5N5XO+KVSkxE/FfHxZhTIp/tzXVauyz+9ESnpXtyhaR6P0zz5GJ3jnMVhNHP7Z4fZT0iGRdSl6cfVBKi1q+k2O3aLwtp/6L0cwCdK4Vu7Inq1bzN509FuRiywLbOd3AIkUzyGCvGrpKi5l7aGykwrJtxVeH35AfgrJszMpHeeS0klN8q3oS2mLDtkQWsZ6d6XIRFrh1gWxTtJKokTLOQyIXCcjDg8io7tVroNKIAyEExxd6FSWhkeXnkBuvN2ZKpYzDq6VekVM3CkxEUaHGiziu/XuBMVxglW3OWzl0aF6lz4wS4ND66k54C0HgbK4nfxpuKb+v2DKRN0CAAA=) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url(data:font/woff2;base64,d09GMgABAAAAAH1AABMAAAAA62wAAHzMAAQAQgAAAAAAAAAAAAAAAAAAAAAAAAAAGohdG+M0HIsgP0hWQVKHfj9NVkFSgSgGYD9TVEFUgVwnNACCTi+BNgrEWLlDMIH2PAE2AiQDhEQLgiYABCAFiUAHIBtn4yfEKSvzByPaLay2DI55PMejETHkLjFWKv27ztmIGDYOmDGJZ7P//z8jORmjYP6DS1XLK5YgG5YEV2ReV2utogtD0VyttjG1796wmvMxMtHrWffgk4WPop8Kqkp3ml9e9LJfenAmRH6O+UPL3ShRYTaZhQ8O3I4e8W9jbLzfc/XreScaRiSarBIXnzOH6FqWqEKRoPCtjjYUpR34y5G4cFObm/egpDsYPSt+ppo+OWgu5FqQILQd3hD2XUl7Qy5SyffPJAiLzEM0N1y4uAUi/5c+KlS6I2PpZVEvOo9gD0xF9Ra5G++mE9RLst0WbWGYrChpCh0Dm5dD/f1dvghsXMZIknX7QlQ0tZ7dPUmGAJCC7LjyF2CWIciSgkR2gOmZvcOD277nwMwMd47MleConIhjgQKiKCA4cIRjJboZ5kJQceIeuSvTXAstzebZRWvZXLbG5x/6e7H7GFMbVg6GSmlCmYwvr9ES7PzDgzTm+5LctSPSCH5KsEJws8B+Rs6IP+NmBKJqhnCqnWSxhWjLsiTL5jiATZxwCYdZBwjN0nUPBEPk/3ZQCpCT4dlmL/pIi0Xllf+iOv1XkVuzaCwwQApe38WiToACZq8P0aXRSIwX+z9fZ9+fPBgNptNKfAshO12xCwxaM17sjO34C1h57cD/01zveUPJAv0SUbZATlXIuT8pAEpARyRVhewOj3P+/zlN2lDUJn5FjLTsmdhXTdJSUYeKURNY0cHm+EQdnujynXalU1qzDxKwrjZ7GxCJyb6hb6r92Jw4qXtEHLd3j+EL8ROwinzw9RjDbS9ADtiW1wJengWaJdJqRfj/59Kv+wglFbpMKTv5DjUw7fr02XcP8GpmN5GqBmE12+FVE2GI7NgFJPGhzv4byXZos3hAWHRATXPVVd0pzuemPYIWCB/Q7lsMObZlAY2k5W3vUgVSsYDfQ+wVvGYjqtOiOytsjGz4xE3IrYjfBw9+5LWeigUx+O8be30B4pFhlaivAmgJhMKSqvq3UyEbleMLZAloi2Rx/S+dud/m/wynAGIL3KUT7OmAUOsNqdW1mesCBB2jIQSwDdZqLQX9/zfVbN+FSO2HI4hN4FYDx4eNf2PNPd6isnPVDQFyNQAo75DaAEBLewDp+Ayx6QMS7QG465RCFeMfYMMnJB1/gZI9khworUOKnWs3jSsXTeEyZP9rWUrn7dco5K9RgtqSu2rWIQKydwrF7YwD4Kee3Rr1/e2bm1Pa2VZKoxQCc040pT2HmFgC2MzQ1ICaQJkwm5kw6v9/rjc7KbOrIl0hAXCBhFv15r7k3+BA5gNBCpS/9DKTzQBnyqQWkI1YJcnK/92cVW1V6xaEWbO9+Wq1weRSC0/jkgsfxYT+1v8N/zVH6XO/MEsWQgkhE3crTpwVa8VJCOnvt1jnIR34PA9M6xQDQQTmTFrwo3XMoXguzg/Z9HlJA5uXb5WZUGqMEiSfprlDxuw9IWjSkyt1SeLDSmFC0WlFKOELm6oBPVULZqoRwlQTxPJMQHqhPVWwnEjGTTylr9IColEC7TGCvkorhezUPK0jkRfJeIAPPX8iiQMuZgIknQTcEp9TPenqVwjkA4KaMWv2jss/WUU1Hc+PJuUoIio63S7Ncb10qWOoC8uBFCDoU+8zMYBg3n9eqgyCoGzHsqnhBl5AAfppyZk4RTTS/dePBoBAaBd+h5KZ8GGfHa9+/lwSPg+Wq06EiVlTJVFFFEGk+0mgX14KhrWhrcf6R9Wm8wsFrbQ9CksyH+Is9lTLLYGTeAANKMyp7/2eZr3/syP47/J3VlVKHRbIfyJtdZ7KTzhTuWwp3uo7SI7EnnpwzBrTbLuP4nv33tix426HpCQ5RiZln56N9l44W+aFUJxTYiHU0njVXEP8T/NgXVykSYdTVKorPvnOO7xtYnD0yPD/YkXsLmnPLiBTRdWLMh1yT8VL05ZrAMkmAvRp1uCV4TYlBN9B6d+oo0NzuQP1d6ucY4W8Qcr9Qp2Pjz516Q4Ox1Lnbh3fti1hh4ls6agxwleko+6udeCjM80r0lxde25q85w3p/36d59r1/MF38gk6acP9C97uuRQyHCJDHS78COKes8tWNSbLfgzML6qT82T/iCcmFX+3dt50/3/y72y+ksFBfDTdyOADRD4lfkQTGA6ZmdIXsrF6mrKh4cXDNjc5RX6uW3t/fudtfwNYK8nUB1h3Xs7rOAAEAFU7cTplo5fun3pxmS0juXamt3ifrrPkJJYzpK/pIs2/5bMCeHH5ii48B/TvuH1sxQSeTVzNF0rKbHPbiRDFLmqPYlu9LQqRrNC35ac/HTNk1uHUyZHg0GdJfGeupJGHUr69NyhDHt3oyQEEPT1KOCMbZMFEqUFF7StR75Po0gNQTBWW/hizy5/uQMoyhvMs+3Blp8gB3YCdMP7m8fqSrp2XU8EtK6NppsAvzWk1AD4/R5sG+AMPPmwXLYGldCHbgN0tLtuWpYrtob2TfFQTAQ+NNFklLOfjnfENMDXeMZBlJ57ey9ZXTTzUkwV9blxm3MiCbx8P3EyHJYpSzmauv1WGnqzft2bYlQvNFpmCP1YkY0kI00WfvyLoyIbAMB4+sQUFamghtg5KPr26wPQcVHPkN3FuCgCXIPjGbzLBak12tYIXxz5KUAiOU95k50iYzQ3x7xfhGAIQ02YgTAAbo7H79QG9F0c72weL6CL/ce8xo+yCKgE+Mmi/kxn/za+jZxypBhgawtfRXt7/riXPk2XAdJHzv8C8a948nofE4sS1YEf9inRo7yW90O+C8PpNu+hSb2I42g2Dl6hR7V9ZtpvWN9zeSchhzMa55AL9vSp3NIltWAy94sKvhhm2ltl+eahlJsHxJPjS96cefJyslnH5EIYpZfV6m/ictChgY/Y+vMcdZSSY47XcNKpOs46E+O8cw1cdJlH5QLpZXMCjBfHsOvrxdGtM0LLFQqm8YMETRmOIOOQqCnurrXIGz4qzjQK6ooyQGwlFhbmLCEVTlCCpwyDZ8agFCMogX+cE1wDQI8sdlhgmQDMQYQCR6OIMkiKMmCAbZ8j5hx3BsYBlNQaSASxbr7Co5qjFNG28OPPttJ6W+123VOCg6MxBAqNzmCyVHQ5zpZJpO11p5zWBsHmUU024qIvzIA9N6GjizY18WqCSmLkzb10RgiamaR6vWSBUHSRsfG+M6EsbZN1KM/e8Qx3E+uonmnajslGyU7WtN1a+jlbDAjJNlfoTEO2KO22NLVtTQ8vG2YgTzld6gODF5zt9QCA4lYgQEBOaToJsQbe98bRM3UovY2qPHmN/SMO/Lf1kXWguzL1WxyYx0L0MGsZ+tdDbpXypFCy34bHinro+uweY4q1m032MnbI7gqve3RiOzeVG3HpnxFMp7yKl3un6lnN45DxxsUnwLGEUlNoXr4g/HGJvOP6UF2m7V9utnPRWUlOvoETre0c531Of1W+teoWNdEPSrx/eZg26a2SjRhXdLKPL7/bcBhOVopqnmPrB/PEtxKlAyFOexq+ugYV8imwNJXZqXARE/68FjLPhR6O5l0usbWoi+Fy+u2d3qYPL68+Fhv+oUlH2wcu2sxpC2XG4VAu4NUQNGkZXqX/2nJGGd4OV1L9d9KbQPzXeLKcJKS7GMPJYaGcI8X92W/rCuktFffDBoxfwxQPKl0qYJHlRt6emKytqM+CZQ4P8JqqzYLljxfQtCLTyFINL1gF7ueZU/teTYObCqE06h6w9ZaEJfs0VLD2rHR9R/tCh4swWsb+rqKp/r5ZCzYi7Zz0m4hqvpMtqZ1Qkyg/PaX1e0KNjd9SYNfR+WN9OS0GGFuXiacwnbPoIkLdZ4W3lbDdVvuydn6WeXdjdFx8Z7sqXkVvec1Hyoiq/0euTfc9M3p7Q6BL9/Zgkh8zsIsUBZeiBO/THMbPEPQhUplvf1mqv/yj3B4/YfSWfjG5pky3DNC0nyEe+fbqQvq2ZY8hrNgF5TAcl4UHhdO/obH8+77lcOwkWWeb9aBiCGB77EB+DC8Gfo6yyDYxzfGRlDfqMk7IbngIHoA/+SZy32i83Ak/glna6G9tr9n5wltTgmtlIp5d5462bJ1yk9Ne/2a9xCbt1wcX1rf3BSGMv05ijcLyt2kb7drUV4yW3upbww02toPrgFtYEOyf9pXJJMY2sbg9Q76934UcmYlCdV3YE7adTyE3Wn+NnKQdLgccrkdgjjpchy/T4S93hOZ7ENxTd42IGVK/jga4w0iuonlxzyP1BbDHGMOq1V3KGusctk2Pu2QT8ff4FrFwFvx1pC12uZ+CqpHl+jU7Y8F/qoEheCW1rW9JyCv3u44/R4QO5+eaQl+PGOVFoxryS6yWFZ8E+y824MjReq+zbc3+DDXnYl7i2+EJHqsatJh2dl4XPdLHTsI6gZcfSNXIbpYjIHdCQ6r5GfW0qyWQVl75Zc8ht55kfVhHe3BkJqwT8Oo9UpMvqvtnK6PZe1j/Pz+Xw/EheTv6fNqtnf7VZvVOikpaYyHTF6+X7pheT24773zHk/ZzkuMNVdg+xoVjCOJ/tccLmUUVd3powsSo56y5ka8l27PXwIbXLKTcEVC7o0fTymZ302zeVeA8aGuuvj65+mw63hS5jTPPWIdI/b+Q00bNAJk59tuTZhzxEdf9EDPYSTo371aEuyVgyjj8v/7f2K2je+LhiTc03pVxy3qE+/mwLb3448FE+72IEXSaIczJ7D2WvrmjS40PoW3LS8vGODUxwOXSw6WT2xrwOIy9hzwBDuWRyXBGdiZnZX6IEyEiiCQrOchDPgqg/ZvDruAQaBC4DIuPlmT6l6PSEBIeg+BJUdFsMBh0zgDQ9g4TjAREQwH0sdjaRGFhYjyPcyXnUhGAZ0jw05UzgGc997s10JEfmABkLL+qINLYZ4tkMGVZucxZQeYD0XJmUR/HogbdDz+eTILxUg9RLEpJKpNQlODwBD43SR0N4QDpmkmMAZYYWxqHIZBTDJqVygBcELqLgvm2yooeMuF74ykilh9KszT2ikhaU+ZKZXbZpBNrxR9FUuIp6M5RZoJhuYAIAAfgQbQQPRGCgABigYWCDAA4GBFwDoRojJj1KkHMCCcFEQNsOQMGadLlMNnJOoUZYTMBs4Q6C0ACKmEkQHMCpUJ8SACvasQgIcUSYuB/MAyGQg0OUI6CDcgF5yxsRSnQopiTAIgUlAupAhyEAOHCQyAOwspogfOVxGaKkQwpoBARVYRDFgEWeNYgi51JkgGzge9ALPdOuJkIMRlEa13CDgCYoCtINogQJNv2FAkG2GMCci2AYcAA0oIbwIJGC5ZgsxFzHM4Qs5BTRMO3Qc5CFzBwFmwGyDrfYTiAIYlY6ajgMIU5geAgrXRDGowDsDPi1kEAwo8EEyYqg2GLCNogxB2AYKCsynfaFwScsyTGkmNijFBJNSyIVX0HY4OCBGxFMoSdgQQMiDTVWIK0gUeEomdFVECtzm6KIy2eswYcBgGsKM4RwAD9LoQyOFSLnq4hp56i0evUJJPmVa5dabJwance14ILqxr48RsTQ4zrxlk8AFx2INrTtkryPvwDHg5BjkBMD0OMRDn2GWWM47CdiAzNARlOQ8Zy1hU4p7cxrxzKrxJratW8PXAkMeyGn/0AIDLYP4QbXQa5hA7yF3FDyPGg0/xt5WvodP/Y8iY6w19VbsqZAboTNNvFzrIcqO6Ddm3Sabp6bX1tFmfHFDJfYliP1WE51TbsWBOAQGoVUsm1f/Z0tNqQGjH/8JlYeUhVzV9xA7wopMA0qgqKwaj9oHTT6oruESzBr1sAJwVuEX1icbEpFjN5Cs967EqwoCawt3NLcgKL90oJOL+iL76i5+qxfIMprYk36J4Gko8g5Roeof9MR/M6pIoZrsPPtH2I9V9R3h6RAE7sLRbROSMGEMfr5ABUVvUt9vnpEdPX++zHnbNm+Pt6AQJ9Oj0UVXUZqhV2qpmgvU8mR7L6Z4rXuL7kM8XFPu5x2NyF2ZuTw6pcsZTVsXEcmWIFB5nasbGPew5INjOtEIj7JZqmiNHtLYNOpTUvVlJJ7PT2SF7EvJhTTvkPqd7HmWznPqGrWQ7g8qOlX97Q3ExmUSYVpwq5vX4UCRIlnXIOrkJrn/ojRJgwm09lZ8Y4Q+L5AysRFqtmOLSG4Vj5uFkeYmA6W3nPG3rJDeNar7o3pXC245iqg8gmMZc8BeEEEjaObnzTseUMRwdqAn0Jo5yzXPzp0EmGpnp0jXg/FvbnIyHzRUHlJ1iIUAfRhfEXIBBNkHARIkWJFiOWJD5q8AIciJwHmTwDM0MZ+uIKjJVHUYipZPIfObQ8X0ao5/S6tIxIYJA3IpXBwZvzJ1d+BqjMUNWgOgHUEIBa+JhayE1Ahyw/ovH/lpom9gdC3Vw21LL5BuIlpuW2o5FHuzph2r1jCr3LoVOE00J0r2A0kN2vLZ5a9LxPfKDTP3rw7o7+TyPv7h6Yxiu7DGyNuqM1CNO/rXk8n7N8YPiS+J7V1NXs4/+9L0vdgqYvJF8wnv5/8gXT6VtmF5DTL6zv2Ux//pX61xlB/BOT2UnGOePZNT9Fudn30HMaC/9Dn4GJPqpx05VrOit6p39xoOV6E1PL4Nya1WzYeZHhabh4yUDl87UjGj+pt2fil188OJ50ociRZrz55uyW/Nru00j+aPccakf/QsqH/uErXxU/efGVH9rnf315lNp08cSHQv7tN7G1Sz5/h0wyV5VGfYCq25XQeJ2U/UnQpWrFCzbSsvkjK8L7N+a2Q9nh7z6/nUdHyL9/hCdHjD92pTouH5X8YPUSX2rZPgkk5WXzy6trlWDq29+b151NG/2vJJVGuQ4U8ppp2q+Kn2cmS3MjL/UweqcwH/gDCPGBqkwc+mi0EmlvL8RZIvVv9PV83z2It9dAjpC3r5d1rE2hOsNAwknNiPWtSOGo765cpnIyoDMrh194132ycksW27ifvRjRqBb/qurf5gCzP/8kpHyqT2AXnybaTFveNJbVs7k2GgVmxaNmPiiXs/ST5KBogRhCCqdJuITxRHRIdNt9/QjByNa5yiWucZPGyh6wgz3gL5G1wCGgwq+UhGqNJnCDxzlR0FETwpc5JUkucJ6goLlIQxgxwsWicC/loyWjVbA3bdYeH/bWOKMD+o2sOtVFFBUSFMmJ4BQ6o7usSZSECCk0Mrm+xVrhw6HC5yGdAwAhmLlq+IDi0mhEGDkqUGGrdIkeT27joj+SudbXvnjHaOX0pTZ2Rtvse5kbGyLt5IlqHHDKj/+BlVMp6pbZqmsKzmPaG0HoO2ryUMvT3jCshPLvwFdWrbZ5avwQ8lamq3Mf5A3ECT4jzij6wiWogYMYWVVsq5G3qqxKkLe83EpVkiKrgk8vCtfnJ1rqOkpYzHp760lxqWEOSsgLGaHoPcJwlT1SAnquEp9ka3JaPStSfmMjolX7Q1PrR6QtPZe+Cu1ANUoB1eHBoNCx7/Au3jb61sYp2Q5nIeA381eVr1e5KpFQlVg4jUxsJObCMfIyZMevJr+iSquqGlcwtiwznOEJ7/iSr/men/nML/7kXa7hOq7n3p/fd+m/MistpLgyYq4LWgROy8/nHwwQCADpQLE+JdhLXOMWuzVlz+FuXPPqKOv8b9hbelxOflN8dGb4Iagglq359fgBXzqLfg430y/Lvy6M1dHXNjByQ0JSiscXCGWOpfTBlinfv0ijJs1atGoDARCCwWQkNqsKx8EpOnDDEKAMa4YiSD5NYABQIllYr1UzCkIW+EYwIYwBOjlsCRF4PWw9ROF3sBGiGeALwzZDLNaCrRDPgOwdtj2U8ZJ3Av3D869NAOggPNcWk+/BX1oM/Qe0JkgVZ24W6Jx9GuHImAWq4aZ44UgFDoIpKAWNYEnqhGDsRsGOgKW3pQf6ZeEAtTi/cB3XyF5wXTcEAMYvftU8IlNUqCI0FdGISOEIVrJ5XifciDQSKhu6j85I1Pjw+nURIoS8hjA4giA5jTdvrpQLyGxkfduiEeN5NE+4zRSWSQuFGCGZDAjRaxgrLt7kvYdoBI2EJbKhEUF0Gj9Hrk6M0lCcK0IHecbyKikrVvtkx9iCyEkUhZ59IjekxzjyYZFTFOCMoFEFxjdWSf/R2VSwuZiO5oD5IlIoAATTJfJKluz5roqX/G79q0j+T06xhjZEJpQdcE4lYrGbdqcoayxi+piI4UBxtMzo2ay7A0gEcZBwNCWROMi0UikZzFYMTfH6TKFyO5IdkepopoKoxrQ6zHLefD7KSXOrKo77T2WhuvvN8jh3BLpDOt7WRX++dlkRneKukh8xuh9VFYzSHDtR3zKdduQL3AbsozEIe7vLzg7r2kOyHWjvDlTQsM/kOEVIPlcqyYmOPHnyrtttP/Vij6aJpIiSDTNKYwcvpO1+zJ9sDmpFFt1Sw0sPKAPGdlFeslRCix7Onb6eb4qV+52kuOXRpXIDroXGbU3ZKLRmRE9rUwSkn+L6bQNnaCJeCVgbrj3IivpAb68dVOLeE/nL4CpnRePAIIKJL0F2VK2kQ0wqXZS3DFwweAUL1ojg4plAIn+SgCEsgGS1FFXjrCO4m8bqhLk2c4a+HKl1HcTnGKTDhPBmtD5SgiZvhCW0YEklfa5psTX+oDlYjP0BLO6Q509RCFtjw3mJMiVuvnzNSu+MWKcwABGhqL+7EUkkzoFE4VnNTGimVkIrhrgtyqs75PB94W0D9XAVX7FXM0uxM5I+zmUOIyGR0XqZqyFoV9gf+SKdp9QojlrKc8I8npePRxKgtzBZjBeVomkuSwBgYbx1A6DMtif7CZYqkXgMNJeW2qdkyXRtL0UROZjqR0eR4DDyTDqOrh5Zq7mD6Mqm1eOKYqyTcGg5Oq0O2PsPlWijdnbug27LlYuf7mERlbyxZpCmDBl4f9hHWGVSjTgP0XKJ2zvI7X9x65GuZh8IEM635SZqBHWW3KbNZNDHNvzhWD8c+PjAs+daXMLn/J+uJA3BnhBoCsskFAJeZd7k1BoiU477VwKj8UGZ1ZOnYnnMnU0YyjTQoXXHvi6pslbHOtbi1Q559QTI4gf3kmifKHn8jC1s0dsHMshRjLpVyYv0P0AQ7VbuSFHdU/N76h4n0wgHA8s2uVh77f4ukee5mr7aXBTdkiSp+5uDgiC61VKBUcJbALRRGQtOW8DXngzi6hOmL7lCoSJV5b+bZ1lq33tmjNMe3A3EOfEKF9JgoK1B16JK10CvD3aRE8Cv0RtHbIAMtOBN56TyHG2nNDwd4yhbJEGtTqgjxHwBRH+zYITGRiYEjiPviROpqGOyJ6KxEuW6J/Du1brmls5r49uXGLuZxCVaqxiV6th9m+S7VIY8gXhM5UoIYeLPD/dWDaF/XXzPACs+p7LK0vb1/oJcMrRZJv7QJKhYs7BdA3+3gkkgYsX2C4zI8aRw95xkT5QSFCtVFhh6hJ0aO3H30MnIQfpIrSCCQMgtI4Qf6saT+S6EdJ+IIkENEVh8VF02nT0W8Pad/2ibzi2nnUN3cRmTKukiBW9vZjJJYORZdLM4V2ZZxJW5WSTwFBgnE71ZCgSRchpjoivvnBsQBIZCp9+XsaWmJljg+YwTnKGCO4ixPu8Xr/qJzhO6MWIAEYsARKzhEOHQxvOOoY4vTwL9UDB09t+kXm0hsCSrnt03Nxjw5h2/BUZzy5xL2CN8xrhKwtouD0LaId8CU1LB9aJcmRURF3K7uJS7zGCsFZUtDDj1znUoKNfzaYsKoYWi6nEGoANAHSbSoKdy5vuXC2QRuaS8kpnOoykxFhnf+PYlsDl60QobnRefmb24+XPs0WqdVZPT9/NP4ZKhyGtaX9l1xlFlXHcDiOm4sj9C0F2fh1f0Ig2Z+ukrpvf1Uw1Z+jGndvUOKwCIeIFqBs6B+ZICqKIqxqxyf6FR0lXVq9R+tb1UMYyxP9+8WgOvrC7JlyiUyLKk5mNtwp7MsdyZxBoYZbes/7Z2iQKzWoXHfay/Svbyygk7hsvdK528bUG63JgCLEGQcDx1XF02mTsW8O6t60xmRaOCG0VcGdGKuKUtKLpZzA2VB0FJwJ9b/u3d5CZeFwgSbz7MG4kfDOdUkVFCGg1VVk3KQAJ0H3j93nr/7ZbvDdaP3G5aaoEpTuLlDVx8mD7ScFTIqcSguYFB6PwqfLZZrXGdN5I6QXW2I2/jBPOyOavbqBGJzYjAmG70wQwSnhwksCepTVjlX4GzS/Xc4sUXcdV1j+Lyx6VS5+UTpziC8GoXUiKOGE4vRNDrjZerbQtC/SoPZXFXPw0GMjDTodihqwBiKgIQUzCnnZQprfrQclN0LoE+MBqWlTUSdnAg4ZzoZkvVB+lSQLuLbnWCpUUg/7WZg9mISJn1Bf1nYnAhW4z4NHS1Vhmv36jbutNXHer7x9/b+KlXUKm9Bf38dyp4g0b91o0FrekvlhIeOlG7pikQ31eUOqkRcuCWWoWxmsBErB2v8PkWsDdkoisMonTu3XA0xzqFWYX8d/dYhbiEm2PvON40oO4SGqrg70pndtjTLGnvTO5Y0RyCRTKZgHakgXvqPfimJdm71jjF2zjNp97MG7Z5dzriSJA/1aT34X63mCIrtE8IZE4ydMeQfImJ1GVzHKMCgTnT9P+VoUPgRjbGMCmmJTmckMHFtOj7bI+Sz915ykQGZx0eZ00kp1nivHYN25nG1KSPmgfYVWoVkgLaCx6NNcvDqRSBrWtndKmPRw6mbdhTla5Ak6tFbUuFu3uhHBx94ozAVVkYfDw21Ez1xAiAiCeNoAfcg/M8koTXyg9Ljo1nSF2rGOiOF6biRGwWdl6YxIgrj8PN5uR4LAkZIFprflqVJzU8mif9tKrZt8qEQ/RP34Uftpi39MAhQrRtU6tY2KXUZOxiFTPV7uAePNKSsHjcQs0rgJVBqTEFNa38ekWG1PjYYcnr5eVJeR6Y4D1Qo0kAEY+cUNXBhfLwpO7YcobHUk4ObrY8Lo4hTMLOs9g4UUUqYGo9r6u4EsPD2ZDHdc1Bww7CfOr1NkJ0sxTVNhlzrDg8JqYqktAZEpPjP9xKi3VLgPl440+Ya1Kz86Y9gGk0vbW2deca/XNEML8G7YuiqtpZtly7CKcS/Hwvgsj7cyZdMuL21xzMw/kcRkYWDeeVbSqZYwJ5bolF17nZn0dPZP67IS5P5OGwIQeUJkazq/nT9/yFCbHloR4jWRm4yfLYOEZFIm4qlekxWhEJfP/eOQkg4skCXavWRX5e2rFQ+nzl+tQMv6iGTc7DegpAZ9dJOth+jT41AuKXN9WQkgwH9IkeNCrA/fqh/v23D6WVVZO8Lp/121I4bpDHVT4C1GDirdlvv3Wj4CfbHRzJKXTEZzU2qGVqqFDjMxvRQRFdVPrR/K3D7zKL44IJiS4OSR53Jv9LjU0LQ6c7YTOCVhS7nn4CQDVhy9EZk08uxH7LszeTHh3Ok3r2+3en1TCxi8kpWFENKy3QHzvo2ABkwMgh1URaEMbaWwUl2ZrG1B6YsZ5JEjT0zyEhOj5AqhMjOqvXY+KXvrPryLC8jl9nbLRqxMeptO+GZK6bB8t7EWiqM8fdmAUqYceM1UMK/aPZZVFYB7I3RXluX9PeukZOeELtPCWD2Y2JPqxB7DFJYEQkRheG4FyCvCJ2DRk17a1pZEYmN68HAlg0vdWtdXD7JI7ghPFQ8qAaNs3htu+tOdJcCjR2BnVpoYI4FBM3SVFY5xR9REHDul2UBx5ln6SfedcIi0Vc0g5z6z/8uH++Yexl+cyOPWjJhKAvF7/YHeX6R6dLd0+z81/teMGLlYK79WKd/uxp19Ntdfmjfaj4xXKP1UT1z0zeJl1Gg6oBxir+xkMmR9S81j8UsO7LB6Xro8Vlt2yoxBoTd7qpO64GSa24tdGTKJhkX+n9VcHXW2iMCjNGYYU2vv2/EC8+0GaYFCTvQdAi6YZqTUav2elx1hd/7j40rulMQfRp9PRcJMkCuxNwdxhZw3eEDXpUwVX27GAPAvRbaVbDJy2HdQ3TFIulcmVjKx0IbFpBe32futWxp+NPWckX+Jyo1duscchzf/mdWLHV8CuI5QAQZBh4NZHt93lrqf+rqf7+11PZ/ltbi8/aiYH+pKYKktySiCQ/eEnyStIO0RJJrgGMr+s6LfzXw0AuTu6S+3vQOuO9BiUoqdg2C0v0TMt1IvvnYNxz/KYLM89eSRYILiWzFti+9s01pwrKscHyo4MgS6p9FFU4Js1egeD8YsuQ/vRqFJXt40vOasGmZPZnBha6eKb5eKGSMpx8vQuRfjGS+BkpVsHYraiC8nMpCVMMbuFomr48HVoUgWugZxUsP0sGGaU24zVZ5nsfHaakfPpgntlBgC9MAYgYUKWCy7HZ49JpsxC0T1yOAyFYSCXV0cOpTdUBdGzFvrExtcBHioOpVuOy18stfGKHPfOKcFOJVbyHD3lAkOHgnHtzV4jSxhkvi0rx+cS83DNRuWNKrHmN8HI+K71PEPhnQj43hVZq5sO7mst9UF2e/fhRUdNAcFUQtfFgCLm+IjAYw0IEhlpw0DTfxqpQcK5ojK78n6urYyb++uB8qek5g7eQSSd0FyRQoLKJu/PmOOns8f/FCgr6TeGMp3N4c/G7ZcnQggSfbnpm/sJzRkNfVBWKyCJRqdwafCgdN+2oJB9WDSpKRMp0waURCO5JWU6+FF3d8w8zJi3bBRws5Z2Jyp1Q4izuiiwv4KT3Cmh/J+VzUmglFkTedS73QVV57tPHRc2SIWCmdlNHiMLGupdlhfh8YpIIw7YJDLXkuAVQ6itDQ4MradTG0BByfXkgaNKbwkz/ra0l/i+nXk1leYssIRQSdywt9yV4FZleXvqYhODR+pZu1a+68ze6u1R3PTF9lhlJqhBm0tD3enq/l/BBeNBDfO38D5iRkXZWMYFJtu6mT1C3Ef2kcG4zviEoKqipzz859UhAYHUQxopJi2g1uRfi7sXCemKTc50pQb14fjFh+fCJevelgKSLTnjiHR9wu2uvWzTTyytr1Ls9leroVStAKCSb+Y+Ncm/lnwJhKm06ycJqJ6/W0SuF6tM+6pXF8kLH9DwsPJVzDaB7yx8GZr5+nRFw73qm78u3PjnXNpCFVx7H72lOULuBGS9JZCEydUM9K2S7BOFpgvGC4M2KIsbV+ayMcB62X86vs87JLQjl6RO153JvDuXl4Nx/zT3DOw8tnI3QmZ6N0Dm1tjtmnty8J8PwvGm5uBrWp9GBj+D4INs5hx2LOMhACtPPWegXankkJRLsw2noyPy4Qg148/HlgcoBgIKXBMBb5IGoc1Wi1fj719CC/KsHd+ZX++sH0a5djUBOqi0QudGGBGxBmxry9M97BqG8HZFop5IA8lHrR9eRdV1nuoDHHR3DR4cB6l+p1gV2THbb4WDNYzGZdC86QLULER/l1x3sjtq//0jf9pX67p4cwDhZAY538DMz97I2t/pq2ZbUmcPMaig4CNMlB2UEhMWz5HDFQG/CNSyf4lZKIVLcS44KPZxHQZfE7Mrj+aeR7+18yJ3o5hhPJKDi3YjuLofQ7g+f++DyKahHuSrGrtfmyxV+nAU7fwoGIoE+DKexiVfR4mtzJYOIbLIRWrPaU1OzwStb8iAlDVhD1CyxWMueMCnMi8PeuKkABbaatecytPLEWCPCt7I8nzDQuiGeYzsMgx23pex5FmYRECEV7O1LS/Y9DCThwAYA4EAotiAojZJBjYRY72GKRnQHDFQrQcJa7qGCUJkr2gPbEJGSqc1WicqDEnu3yz2NLowhGQsBxlUBeziA8ZsAeyZAl5cTpZix9G2fgtW9x30X/1/Pu0Z/1EUVDqawdBOfo5dppGRbuYfAITC7uG3giuiGrssHEsHEJBiHfkbCZ5jUZjFkHfTasCxMWk3JEEBXxLXdF+MB3vJACTIIGAwD9ymGRJfhNwrAazNaA6otI3ePjEEkiTYF9RdRlLt00TTCwvNgh9GJmdwk7UpOpoBqSKE0qxDGptSkHIVNT6utO6cpnziTz9A3AJgFzdd3Z5sd/89Z583Nq4KO/dzfLjKHsqKHUiMxmv0y6ta94wAZ6dGshWf1+/m7K20Edpmc8+tL0Hv1WsuYXAvJSX2XM+wd4ny21NIxH+XRdf6oI3awPBJYVl7B8tE9jMZyb1nOY/+vJK5atJa7zLesrBWJiTCmafZXXzxVnmavTfka7/ccMEiRr27tEqh8FpTvfEJURete3qHFPRXjML3H6BH1gvxsEtUaFQaNgSb3s7Rso1tCLRbaTUuGuGTPbT01y1NOdyBddEz7e13PBKqnKFqnHODdDIDPIoDs0Dxj4r5epV7O+9aT1kg1mLJCB7h7rVhW9hpTBbd2ONIPVS4IoZy/wprAKta8mzPuq8UmW7uIJcPgmmSNAE9f5z4BFA5ITDMmmlpDegskS/VUX1WBopkGZsLkoxfoQWgf+bE5NX5/3aKj9Q/havYfDa92pud/fuLp+fefuaYlkPtcGxylRab1w6t2tn949ZVXf3hNUfeDnh6XT7n8m57rvfqtvP673gd9N/s7XTv2et5afqPJUZ1/bjyxqXby8bfde9uvtx94tyv13Tsbt7rfdf/2BQ/u37Fi4tbnwyPyct/0lS/ZP5wsfP4R8+LK+ePmx1898eqjV/995PNHuWfkSr0LRy5c8dqF156+9vujbz8m/Uy33Ls4unjB4u9fv/n6t4+9+9i7ZrQMt7xtRUSgECGIDEQjYgHxAPHHRsvGwybGJsemzmbE5hFSFYlE0pBZSDHyi626Lco2zLbC9qRtdFzad1uhbbhKUpXhqt2rcqqZdm6pttHkQ9OqXdtiPQiAq6ors1hAEkEN0vIAoSJC0P2XrEnze5j9f2UJOiArPyjH4JLCT+EnTGtLwRdYBamqGNiuTkVRpQJS4jYauihCYocFuEQ6ajTsj4m3Xg1XlkuoN/2s5brbQi4HjOKyBxRZuNc6OXHImS/kryE9f87/2CTz/npP5OHjjA9/u5l+cECAEIrf6zZ5VwADPvyMtwiXNTWXbf4LwxD3rLk1X8ANVYbL8agzGH9cqUFKu47DFB593MJhN9xGZjdtmuy2A1mY7VAnZyZhAvMzxKZYrNSbdUAjx3IcfQP89FvMJhzrsRGnYQM2mpBbKLDayTLCYRxxpPjqRoeOvibD/jsIp1JT+0n/Z+AYnCbCNlrVmqbhoIvVrMXh8HmHwTxhSM5OpTR60dQ0wT7N8imyWm0WDnjlzGv6+sleecngr/K80d6F7I/9+Don4TSRhmAgx0FnYpnp2SCesR4nd22n0EHPOfYZZYMs7c4wh7bWXp0tSLpWmtZkBzoNyxFQVvyvbC3FrbRwdA8qcFThH+4rPOraerw9dgbr4TQZd7TAJLVU0g04GrMzQemNdq+CD4o+3a1+cXqFrY5IXUchaCVt+X+fTpdzdMwjTwvEyanMN8QgKBzsicbVagFYhNPklmRtS4W5ItlIxMkPB3Adk3yRNEJurFSvI3nMwh5+Z7ZammLzoQ22I/lrOdnxTFNcTCLdK5VNsMDqJqYnc20oWCBXuwmOO2Sd8X2WVemcE8rC/GI+M7EBB06ejLVh5m9sIM16PAMqpAqcNbS8FSTseWtGtXEhKTlpYMIOcTaxMOlKZJhTQhgiLSsEOL40mTQyRpGmrFfYhmYbc3zTrUBnkPiF7inntd3yLTmJoqvJGz2T2cz32fgiuM6EohJm3KKoZNEa7SuH4ECpC4Yx0+CtdbZhMPQtzpXfndO3N8HpeX1cfcYaaROaGkBG/8faodN3FShZ5bqBCdyZDtdS4R/hRv83sryHQk+OsQVpPl/6e1/VuCMf8t2ZmZpqxv5HW8oGvCGcWgVILBBw0jP2U+nEEQh0b8NCo7WrDzY1P7y6trI4NzszNjE5tbh298Uz7F/eW1ucnpo4OTM7v3QK1ITqgrADk7kEw1LkWBrnVK16VjjYjycmmuRKmUzl6Hl6RjDro7SJ4jhJkCZyqrdkjCSHXUGUFCW2qTIDLkOibglGJf3CUIeAVvSw0sMsDdcyijN2h/P3sxKmaDIxbO4Z8B5Q4AFGUk8QRQRj/2tF0o1MosiSKkN0RDA4GzJi8i/Buk+m2fevyiLbbpEn4Wx6AbsE/ZLnHVPG+PXrZe7V1exhcmUnnn3V8WXQwU7/NRtft33iYSAty/e+C0DjUy25I2MUqJt5cwjQYpKdonuHKZcW7L9np7bhDEqNMb3cLzNtTc0kpmUbVoCwFxiYZKgp7Iusa7AsI+WoyHZCsyzbSUfawA1Dngc5yHoM1lPAd19GaxZB8MD5X6cDOMGB0AUu5AASfFYSIb/1lhuvbo3XXkAwEaQsmZ64NHNpr3LZt/jT3etJaP621tFXDNbuyjZcXr3fr7LpH2x3V/94dTbHTZHkZDrMh5WN1xdMr7+TX5rAgIEChpgrOVvhkbNb6++ce+cBQcPOZcboppcv7b50a6Vb/OMfCZl5oA1QuDe5U4/KS2u88C2jZsdygGoc31wwsjHsnzhnuWB3/0qwGaM4FVtoowLe98RDta7bzUMCgkNVIkq3kuQwRaMVj6VUlCaIpwXHeV6cjU3BLZxXnMs0EvkApnHoKS4xTfl8ep1lZD1mQjypNlTtF+NLzssT9f+BzjYVv9J1S2zpLaZaOwT/khAx6y9By/YKxJ5x2H37XQG79ummoTup+fydyZei6PmUNnsq+TtKun3YbrnVBlK0T893O/qBUEpYusidXtOT93FT8dXW99S1aW0g/D6wUqexSBiC2Llu4a93Ko8uwtuZ9Z5+EK/bWnL1HUH4yVZTCjJ+8SfJy7pCo1jAcofl2Eg4WysJtugclaJLB9lMsVgtpUIBh57v7l6owsIEgUUbUXpEDUl5nUqKNzifftHdNuuuN5abphie8aqfns2U6LxB1V5VY8MYRDNjiNl+OENDJlmvIU3mvPYaZTuJLwd1pd40s7jMvQ9YiYUGb8ADAjxh0EW56st/z/7+u6TxQZ8AQlWU2/rr77JnbL4Gvg4xMahA9dSgLCH0iJPhvu35B3Vq3HGRlYEEKeghSCKHAfoziBBIi083Ad57xzaiRhjXnR3m11bTq4MGZkuF0WuxCmKBJrKGNmg9eYOMRogOlX4l0vddRTE8T1W1BwQmp+BCgprRkdXvKropt7TVehT9SD+Eh5D13BWExhEfbflkBhaPxqCX/59nvhYO48Dp+Yc22PHVSDcB3oak+0fNze4WHNTeplj/e2MwVdleX+Wms8Zx2tNOfgFTYyYYBjgGHSVqQpJzrGaI9gw6aKZRxFKfT7M7KVZbdEwTI9aaKKEVgyihZFQf8YIs8RrDsAhBKHSbr3EEDZIi0BgFqwMzQBKaB0kMUTRm5NZZ1XDe7DbOIsBNiKarPH5U7O83cals9dUSp/+oWTgtZaA/8U2GPnwo2n5z7GGpsLFzw2eO5iaGxsyhnVFQ/O/5L6e9+sMaKgl4JOMlhUvE80W39chtu5Kn8MrW+y8ZXE7uLGdXeq5le3oUhQgFgRsEut8+Bach0MJwglkMxbhwOG1i4/N4drDuNlVUbte2eD4M82EoGLoDuJj+/SdqGKIXbt2/6vEY5KIZwhIl+dYji311vvQCuM+86Zq1yTV40qUluElPlZeSeLb8OhM4FNXlyLC64XKzilFcgd9hlEYPDcoBfYQSRbEQ0gyBExQpYVh97LPkpR7CikgQJEU0VVXZu5EYYHWJaqgO2/UbczkjtmyCbIM+ENnGMPRobl18lXNofpsxWsskY2hqqo3Lyy+0/S5egkJ26avyJ0rzPDxZT1sbiSGzWzMqk/y0/MElyzcdOHHk0P59e7DghxBVy8o5apKfDs2dO9l6kN23GnTsqbbkCnW/csZBGzyGhAbuiZF8sefZg2c1CFmesIKXcZJvJWOylzK825WcG61P9dV32ScM0tlqS58ls0JS9Ic6MjeIws5Ki+70eSpssUwmrLNHCAMblDDVG7OZ5ycKkvgsXFuexzkJ5R3z5PAoEmr5RbpL0hPLF4Mp7+p5XilJH7r+8dagTbeIaTwrxyY1qOKwPkwvOZF2z/TPQxu/TlGLO25bYRDEUZv3bWIvkhwHu6TdrirDsqW02sOVYe7dTAwKOE1PEbDpuRqvuI46bhbckKCnGgK8FOwqJ9JBN6PSjWFZDnmD9a6lOQuFPvoB6xeoNLdlgdW6j4U864xuiVLrugPoLPgi2ZqHJJ2G4NyDzhwLOT61nHOUz+dM2CNADIBG1CheRASET1E5un56ONUkVVsq8ZSuK74k8SxfRuAXxbT1yX6rtM/UiCzTsBYtvbZYWD9mmpq2/eioWSnTCgGkMpqDfxZ/d7tU7p28HfK5XQI7dELjw8JKeG3Qno+NwUSKTB0cmlAL1OFTNrNLQJBn5DzU3+XauDM22YP+gMNjVWf/v568cO4wXBRHhb0hRBpGM9gC9aWRqpqvwCAA7yM8lEKjd9/F7p6ZiMU890iiwc6BrK8X39vfQKH0cdyvy03fJqUdZ+uWphrQdf2QJGAZiukTr64q8TNOqjLOZGauVayvVnL4SiJ5QVha8qGvs1qlJI+YonsPzLVYAgYu0NDWPXrSrLUonQtOzIqSNZfaGMRajGIIAw1q4jsZesNPBtVihjTo0rJKVvKuZUkVy0KhTfmpgwmrphKcKuW5EQG7GFpFoG5kvczaV9vJqFXrUBijnNYrnVYzo/hD7X/l49lnwBokimmYdovIG1ACevdAHiuGL4DusX2TdP+rhCt1iqif14Ohhe41rehbUanj/2ArqFXRfvFs4SKn4p38kjmgHkbspbUwocG6lQSuEXim34ol2ZbsLPjQWW/H6i0/uAMIReXI6mmu2GmVxPNPWA0nKdmuyPsctClPMRNgY4aRBdZNQp4iIOterYpAEI4fLBxgGPCisQ1mR93WEJjR6hpqEuEN3KPQlQDLiaItsArCYlYCP/TsyS3IbDieHbCCFVqgLuqq1m9GQKMH3kD5RkkueR7SKTLO9rOfQTADp93HVnmnBGWYI6sGj5953Gdq+u6JScpfepC+bdnO1oizwZeLoNytGIdhoRYM+jkLzoW1kiTtDcyhN5Jr6UEmJ0XpX9wg2DjFjRdc2YPSZrAdTot4U71ps0tv3SB/Wb3L2QWVv/WrKZGHPG9Du/bUBuzuBOhyG4BxKK6kV8i1lLDeRg7KuSokv/u8Sinvudgb7QuNaa7zfLUQhiCEwsadbCdKcwbVcGu4SRXbC2uwFedhrbdqBogB+5lvj5Ovnu1143/5bulf/XrjpgY/tuDh6QyMntDk3y/39bnUaPDgm4Wsv6vVf5glYP8YApdX7yfEGvB0fMqL1Hh/df04+Spa1L3z2unzPH+Fv4MQ3OhAB5ajAx3kBDuzYVryYjP7lbgLsE4NBU5TGOo6uACnHfcSYyHVDJjUSrzHGCrNeFHeF4aBMymy4+vLr78Ek0OKfs/LttaCvsLUba/rKMn1RVFRBkRLy1aS+KnnLSYyvBNj8BacFnlHPfSPBH18g7mTesTLtlYxvavQA3uwXIU8F8s7R09PZKsovR0EDVbjwG447Z6OTclBlMG81cYJZsXT4KMJ2ShP2N13GhhJtowcnzPCUK9ZLYtDisMJ+hMtqM2s2Wp66LqTd0uJk3EafoQTcZKh6YfFkiJeOtqbDDci2CxYwA9uGAoFgpd4HtkmQdRLSP/nWAjeZMqdmRwbTPOWGne7DqbIKwsYvHVdWsI6uAiYworzXE7bSspRdWoyCCYvxWC9HunoufzBVpT7vcaSPzLeCmCV1My6PDQwp3Llmt70XDJ1h/yuHh1OXvmp2VaA/RstVwXUlqVmK56vXRZosE/p/nahs6umDRQMwyin9JkXm4paO4nebGD3XO4xKxhpRjPoXxxNXoCzcAWlzsQ+JZRFDxItBRvNTHe7j+o0X3777N4HAUNElT4scCfQCAM7kjTVeMoMqiCYbI/YgYd76/AysmFBp9PtWQo7HHFGZoQ0CbbSFR81KOklHu4za1sNPT1ryAmeOySBGL3zQwkTJ83o7D+VSkP2ID6fa88NIfRr2/OQpLSn0iG9K7ULXtbFDxhECWRFvk7nr/iK59cxcCkiHsNWCAKLCKsOa+jubEKfyXTVbcCcC9WFNTp+x0/0mwo1ewi7paXKMA6s4mLJ0NrRWKl2dHc1pzt72huQDqlovalkt9HUmgNbmcONtk9FosDaBLtIsA9wVVRnKEZJj+6oo8OFOGCd4tpI6yKs1FZUGUtdKtCgIQrRiG4yijA09Acepx8QCAapIPvXGF98ffYXg/3wZ3/hgsaefpelKZ27HwMsCH3y7p0khFNIWYje9eyvs83uAnBUqxAZQxUDiKg6DbSBOsKEiTE1P+X5ZhPnVZVhXiKZCtTOYoIG+u/mkVy0nXkP2qOjEfqwo7gHzIEORpqKlVb8PwlN1r2tDCJlhEf0Cu4wxLxpvpkfdeN/dwd1K02/h8eG5GnwI1CEE7s3BmtvJkHJqPpDlNZPPYZE0ISP1mwtYmYSRYO1Ooi1ebqDcQGE81oCDlqdpupJHks5li7xZK7rJEAV1OsxBlaKGcvNUY3MCxG9OYSDPMpw4Gi4OwgqsmxC6eCbbKopURijUto5NbxoweyrxsL0NhFy9GPv8PYtV3b9xCiKPXVSu1yl02k2e2txDC/ax8nreAx/KDEGZGGQN9r70x5HUrTmCwPFGlbgibTOYrGlF8bPuh0t9gGV1t1sczhgN29gAoUZDMZYGP/II0DTxNN+25RKicBqnIILsRrr2pmAGGFMkiKKGidL7ZKkoNOAUJdFKbrP/3gI0qKYdm4L50jKe3Z1QuuC1PHrypIKt8NI9lXj/izG69UazzHN6m5tPJjXjvOp0VoeOyy0/z9O1F22/Urk4EEmNsoDElFsd2jgQC+wWjki/pLccldXWTlw+BVer7AhVbIG2iav5zH8FWKkKNDEIblKkz6IgrHcLW3CUmOlraOz56U95rSc/v3PN/YSCIbcPLmLYCWJxSQUe5BV+8FjaQeZlh2EQzVfE/SubWnaHU83/9vpyGplU5q1bjXPM53aouaDWgTWinBQtHVCqgp6RH7uNtIbZ/BQ9/dmkpyshIiTIBzDbYxj9vX4fBpa9ws6WyRoknTP5nNzGqeXuBysWvDMH5zlWasJwqvehs8wDlv97YKVotdN3m812Z3ABhyOQQz+vKaComg0X6kLvCz7kWJAjmN1xbNESRTxOs+AlAgoljHTe8LTuzYT8XMZ05SshayNW3uDpRqNEfwkHL3KRraLj9Kl3ARWPr21ba1CgRPn3Q/vbpSq9zPJzOQFW0tIEfD1J/jG1IdinT2ZdOj5cucWS3qYZM7Pxnz6jpXhDL/nXZ+u8IOq7XA9XpxYMcaW5s6W6mvPM35x4o9nvfcl5xWJfIcngI8WPbe+VnUYAnZ/XczFUhzz+/FNSd62u195cOsFPNexnMi/hF3L5/G4rZ6Jt2XjdZVCaMPJisTN6nXoZYqII1UVMMsyhHPWQqa9Wnu9SZvHUKpipnemeEcmrcmXy5i+EjnH4LzWQqgeQ4hcebTGWq19ggkEBOnUxw6afL/RRReAUupv3FG69TqlTEGACBUECHwhVIPh6SwIdNWA+iDd9QM0xhRpntvIHP1ogI5psR77qnF9Gx5OF+54x/yNr95RgYQI8EsKG+joI84uJBnwy+0OQvnneQD/jybNK3J5c/6V55jTYR3O8TUCeKZKUY2DhQKxmAw8TRtTjeTzVgRc9uginB2gxxKUqn80hiXZ8nghJ/SZJOimFJNqLRbbg9TCzaShGV04BM1otjUOZV9My4RRpd/9e/R2vXuSqUTMpxKc9OAzCKavreCoYbI0MdPepGVGheV4LHvB+uGbprJfGgpMhPdlWbI0o9oZsnFxvE+OgkNjkYu/2nURHU7UNTLwkbvRglzI04oLS60Llh6LxnQbPg5ebf0grnYPC4QwPKNhao4LKQD8yUrefx+DAD/uGSfpanN4pxoF8hijEBjnRWmTwiTosWLzNqvp48e7ju6SdDNIeSpYcr1P7EFBUQAWE0z3PWPCSOVrT9YiribxKknuF0fgL183bNUH/Sbtfe7HX3vDq73z+Wz0WA7MSqT9Hw1V4RQ1XCP3Ue3Ay6Y955kBXIIL8WNciAvDzk9BuraQbxzXUykj3qQEUY2i4v/FFqfofpE+HOc4PTCcxzppb5KvwgQGzwA+9RAab4a9ayJZlqHbAkloyPJjEtcfuqexvO0dH8az5UVmmhCYx1u/lUQ+ujjNCRl9bJnaDoXfVZitvfh64xyDnd42qjvBzWLJku7J6G3z0YgnRpMZIELtNLamXvpbqdb2MkhrsxrXuv/L/TFRk6x08alahoZz1cA0WdDNONE3erdnd3ZNkPhflGms80Y0FPC58btQdnFTyel8V2zyFFafpCu5kGt05twzbSdjIEIbsw79B95AIwYbMohQN/UgV4q44y85n7yMAc6p+dVizzk4WGHvV7jhi8zDZLPSA866QjxSGXPnusjN9E1U74cPXURKcPct/G6En/Xkb1UsZPqTvxWcIim+169uruweUBY7g8IuNyhyQ6Mj8bMIBV635cTvGmeq9GazQdbGOO00Ij4/HyedU9+uIQWRzRaCQRe8WSqbmbhuxR35vXuxxR7KlVMHvEj3oI0pVWz6TF5Od7H6oFcY7qrRx34SpykMeroiOZGxUCmFubLv9myNLovYVol+TZNExm1L1mOqitO2IjBad0zQzWZX3+camlwE550RLni4KzrZkSUkeljlvpvp5kZmgmf6QLTzfOm+bQZAjc3bn8CBAxc4EB6Bba4OuEZDmdXAPVkIRrI8tDJ66N7Wmo71k2djfV90s188KvJ8g0CkKkyzfzdLuWLFBnGK1dgJRrBk1YaggUN0QO+w3UW9MFsYPC5jqEKrh2iJt9Bo3ycJOdVwu2G19ofeuGwKBF5I/o/L5NnrUJX7PllqJhpvlZk2EylPPUF+BVQ7LQI9/aTG7sJ92kMrsIa1AKfh59eH1xYHB3BYBa8umjelnM8nJ0gCFzYCbYG9L38PvngbTuJE0AwX1NpwlEtfX+a3PKdfi2MgqzZxVKRrCzuJhF7xAzNCbMlZLqEH2vDCzV6th6vClPvg0/VuFmo0LIKXN6Mn/fUO9OdHK/1HXutDJP3l0wObxLCtWIrinbCYzyhYpVuWQVl/S3JXmhkXPvbz5ETD1INdldaGNF73HCVNcEGtNuJxcP6cqvK8riftuWZzPxvKMna6XA5YpZJOJlybZAogYfNh1pp1NX0+jWYlhic2wGnO6LYGH3u2FkNu0EgZMUxYhw04BuuwPsxcpyWkWaIbUFPIQrGCk2RDlFisJaFB1PNH5bG6IDHAKnKrlN4JzTrycdCgHC/WCbrAThzZHetDIs8pJ5jx85YV2cQsQ6fjxcO7jh0ZjRny1H2sZFT+XLydqRaDfyeXOil8tG+B4r2okNp9jM6uKuOmLFRyS/ivr2uNJHZj/55+mOhmozOs3nS/IW2+033iUG699XHC2kkdSoKNXGhn6w29S90+ueH504lcNYFeEqCsHYmaJFmblyQ8PjVIgcOFY+QmMjiYBPlIIWRaovCpZQUZPc/6ekeREX73BgxfYZKSJi2ze4cg8PRhwD1nNvAj4Vse0aTtrd5RILszepacvvdkcQWaFHODqQtxQ+o+eIxr/21z//kA2+AxG7ZC69D2ZEUSRY2yXRTa9iXN2SUJA0sSQAcMEa1PJUvWIb6r2lwtO5lmznom87EZvFhFUWeDpfnSZLYMWKciwd1duFLCCrJhQH1gMHRc6qjGbVpsRQ4p4pp3stNXc7lyWSxeDu6rE7AYXiM0jV1UFVKTgpY3sFo2xh/8Ush2st17BvJiZahc3m7fgfblPWRsWjHdDROJPxl6g0Nrv8rYm3Yw5C5Tua5cCkwKtYFwsF9TY9BP/lHL6ZzSmIeQj55aDNY7G3cX5evNzXdmIOykxi2d2u2z2f7n+tlnPqfK+Jry5BXWji+ecQQJDkrqC7C7EbCTROhM0F31csSoJ0kW1ZqZKr73mzML3l27V9sxsG0xfMGH3TyP6ChoDSXRZKm0jalU0t0H4+cM14NjifBst9hhpCZl1YNXuTH/yft+tlPvnp9DHhdU1vleUxsGtUwuNMpsVVYYLS2R2GpcV8ut8pzXNFWm6xLKo0VckJoUouDrr+vGZNX59DjKuzMKeQ3Dpd5jHaxq0vYRNmETRrERm6ezJybYbpUuyYjMifNjjUbhpNSkKX3paWmyXsnnivkj4OgKtsv9tUJqH/ri++PYdaNAZeQI4dEU8gGFli/KsOMXnevnHTq+QHXTijvIrh+aXEMXtw9Vauee7w7ae9GH3w60wEXI7bjndQq31fHOTlfXG9Sgs4YN7tt3/v1Kz/9VXLz20ni0vr2HyC5vqg26EodkKQ/wc375x4ejV9+AsQKPETWC02kuzOC3Az/dc0yASjG2qeJI0GQDLcrpLfRuwxLyMV7w7EOfd7Y3DdWOd7mcpOk3VbqzyPqqP35kp+O5fMpddDu3pYPncPrA2mR3tTkHnO4JodQaSamNO74UcSsVAq3VETUamflN19uBdzeZFcAgLu/ycsWy4WI+jMvlfMdJZ9JJQ5dBqXwhSPlRoZxJbiIXkZISkzYgV7T3piFEwaW8m29/F/frT6jcBa1hhXWdnI0E/8oGgl3ZHPBG1gn3To0BFTShC30oo1GJ/7f3kfBEU/5mUkfguHEwZIqU96MCPA7KjJdbBQMX7uUe6+zlkYTvDIZjqj0Yv2mp+vCOj8dSbi8YZTyeUsnWNmWlWDKc2tzux3BNqTPVfyZzCuXcGzdkTdhfx1CW0fuZCAi/sFtkCJCRgJTBn8ksfH9xW0bPX4RS4tYXpApYo6279rtxVYSY2oJVR/1UfXiM12P0wMUE5Czr6zscxdnoJkjkcTPuz+wehDzf1L020elxgyECXpyesNAENYn7DXSUoQXpdFKnwcd+7FXU3doOZ+I8bMOZOEPfel8kcHtlJop7QlVJLF4OHcAh0vBE86p7kiuVjmCV6Wa1ybBGpamorEmRgU3vErrTeeyRDx0C70lv0g/KK7scX6aqw2j3BwSGvUWJ0g9XeIkX4HUMK+CrVTr7fv400px7s4uhUv3dmHF+EDptJKrc7nua9odiowuMsWa2kXtM6VrlmJkC5c4NbDL7wI2hWp2dvrXRqVetYDOSckP18NaalkRgK6E39lt1bdvf66zjVGLXJ4h/w28saghZqB3s3sOEYO0s2+X9V+w2GcS69ARtSKP1W3qNN2C3/5+shc8tnlwKqvOnbd1O2k02Nxw+j7oNz90yV1rfk9sv7u8+MWeH3XiTLfVyxKAnSaa+g94AF26lbk9R/1Cl2nWty4P+Rnl3D3xHCdRC8eH8hlxSSndvtZ1SnEWacSQOpPCJhoYOWLMr2mm/7ZkiMjevBgomm2C2ZSHvolZpeYg+vbgJv9SO5ZOQMLjrlzpzNkPYjdA9R2Wsa2Zig/OtpDP+flJ8p2rpniplVU0p3bTeu5AQeQ0zqCw3maJl+bBqi6IbOjMNBReRgZDQBLkBT/8727bicIg/qzJsiVhzRd4dr/srcjaMdcAVwmv7dFlXiDV+1BUMEyPELm2PM1dW9J5Gbq+eYEfFdGEiiViXoVgOAq/AnNf9IAtl4ZVqhvGFbXZBLtt72rUPrKZ85XI1X5F+TL08IT90gRuT6ZtyVBLBGNeHl2oN1vAqpdDuOF9bYO/LP4BlcAAzQjyMECHq+fGnX9RGaTUGXHwZ/DssOM3B712kOdrVMfhEzsm3BYnUvV2f3F5dLlKqWZHUq00r9AOw+k3mbl0uRg/uLEuufS/XhNleHc97nmCVWjqDOIRV7mykA2syXZfpaA2h1HhZU5aDL/U+MHtZCT6WjQYvZAvA3y2AG8sQRAAuqCEIdyjDXoXo7X58Cz4A4wB62hX7by2B6bel9XfboG9R6U6Fbkf7IDo9tRswkTGBTIgT5SeFICkSQkYklDAhCNjbELJqT94xpme6DtJCX2JPV4ZJsNfRPIPZ5lrXBfwj022MF/ZTZfAaJO3qTOsi2l5zXYQDZnrdk8PytudOwT9hdLlSAX+HaKnQckGzH5T104w3FwZBaNQPjqoFStPAbFNpO0EmKFl+OvdmlI9pWpXuCusjKhJAzhN6wwv2pW8acQUX5ARnk8FrE9SE+lQIcnARoQoXSY9v2hhex2lx1CJP1EBQjGqGwTBd34cl4j5yyqlitBrXoHvebvHRNxfRKvGEEq32PJaEEdp22O5P+5+Pn2/VNvkuSHIT/t3el3O1+d5vZuCCTBn8GxVe2dxk8aEy6MB7a1urg8WHPt2w7Fpdk+AVUBEtsFB4J6KSIiLsDtY9STW0Ha6wHd0ARTPykf+gSnHJkxf6BxYL4jXgBTy8z97/fjpY3xqxzQbAARJXItbaRztAEKxaAKOxxy6nCMX2BJPtzziIcwKEfCs2bIVlVFViNbUyD+8RfS8tC5Yxwprj0Pm/xGDqShFMXa5W8uDl5uhan8cTzuQKB2mBZ0iCJ/LSDzjL2Obfd+lDR5/g7rk04DJUG9PxCWH6xmqNSklwZAV05cxaXief0rZPH5e4trQdvi//JAKcqNFjwYUfD3YyuAmRp+rtmiY17vsZX2XfO10OJ0BBEH4stO8VVssJIPBBm/FEolo/181hLpM//Lgyzof0fIH9uA4UVEbbEySQ3kxK71tP+9i/tLwfvF3XcDyyG3zmB+nKCQKPolXJDCPDDvU60ZYX1DO+1ibUsaWMNCYLi1A46xJcLeZzQmBphq74xHmZDQXeI2JaG98mxolERdM1QI8kslZJDWvnchajC63zMW6kp853Svw648cWWCTGfiLHAh8oThaC810T9S+xYOL1gUChGogVvLm5BjNJORZaiBX8j4muF6B5IZZ/ZVQ24FMiVo45Fp3Bwf/MwGDftJbwH9UUWLmqqwT9Z9zguEFxh/qGWkWQragsHWZrsdJUI/d0vPxplbLoBwaRG3iKr24KTlpB5laK075HVlSMllEUHI/7l1tsFx939wauvLGPp2jlzoIFeyA0NPc0DLkrjYKfX/eurBcO4xiSmkV+dVnKaQ9fZCXCxW775rR9UZ396b+wyWqINx97cyAJZnLeO5ndAHiHlGhEBc0rr6YgVodhN7HJDTY5wY5d3XRG0TX1FjKixiaNZTFeiULUV04oI9EyLFDZvUppQiobHQMzWwxZckGHqTviWAnb6ajDRTAMHD6YE7h2puleGdvNVs7IuobSMAHGbbFTOk1EoghZa4XHQZcpt07sB9gOZ0ddrs7ODkFzNgQ3sneAKTuHR6dqq3gwsLCJc7g7nJNa5y5u4vkiOyYQQ7xfPatulITjES8ndrzEKESeV0wATCIJsmVAmUU3l4tJzKEaOEQ96eQVwwhKHUqBjBidGI5R9EWSLSpRneYQRzXyvGLyIEiQbUP/+hFem/j504X0OJC51DbwxGICECTINivt4LXhj6NnDXRd3kK1p2RxvPZhmPkZX5yM3sgd5duYoS93qlqF2P8HCaXX5J8Vy+UckxQit1NHFnySC4ZRSdUHN0YKllE6q67/ScgIeRSbEEouZAuXVL30+RfcEUspnaPF8j8ipAb2iGWUks+Il2tYKmX6kvhpJWVM7xK1iRDZTh5ZMEoumRYy6eUTEwk5s8JzHjCkXaJQvDzZ7kiP9PzyquPL2fET+KGIMoaQR95TFqMYpl69HgiatVq1yRidbd8kpdr2EiuXC1g5uePZWr0tyM39ruI22BWs7Dn9O7FYVtMad+wO0oeY12MKGdCrQQAvLm/UHRorY+f34wijdob4LxH87+B6Cz8jnqIJUNsPPvjXJsT+wlFdqy3/sg2waSPYVxmKqOmiUBQl7b6uBPl8IcwIU4EyuAbVUuGmqeND37Xauhrtd3UZMehGeYD0R6PZzbA+pbsIVh4LSB6f62AVIvnyVnNyNA7FoTgLh+EwbfEeJGmkNEtU7VgnW2MEqK8dZhJV7KXhSiydm8Up30kmowNHa0At8gV0u4jg+lIXJ4FrGrrKE3XZkX0oOkU7JM1ystmy7c54U0HrjG3/01E5PjvCoebpDb6e34tOr7k8fYYH2qEFJ14tXTfqh6dBTuQLygz/34GCRvHS9o8hdCqeGccs2JIajmwlwi4vEtVijdGc/ji0ML8qlfdQIh2ODl99DcfsPYK5bnJ+NIwDt01kVSj0Z08ffe/JEJvisAIHHeHQJHVD4b+ZCWi/WvNW+LRZk2ap2unRnJgskhmcXj15KsW+5p7Lt7Yuq62n4nREvGIxbS90hzjUcTTsVFf0wZIV+3k/zEaFOFThDI77TmQIVQD181p3dO7pvsqghGPNhpRvBT9NtdCLcRhr326jbcbFxSDQqVFxR5YUPpsPUNvH8Wy6peudINvRGFWyydZq1sMpVMv5gBezwJKrmdPZVymEvYyVtIwpea2EjZIfte35yR0mLBBhXLfIrC4NWIZBFFPFIkPoH7MoF2VguM/rQTcI4FMwVk3H82p0sY6TvvRReyJmV7k2bWsNn7fN0Mrq3aZBAjX85LvG2P7OHLotPqud3i0ToTNo1U8Ro87gSZaVzbMInB2mdphBJEixosKa5mILsQcOwKU5f8xp7VrtGJ4igoRDvZST0ngXhNJfpe7jEjlTPpSnTd91QdOJ9aIXYNsYFQrnypyZxnhXB/tBSNdxnWhZzRd2dItetaKA4YOCjirNeheH3m+AxKuG7rjde6me4FP7GEmwSdEEfh9WKDQath0Cr1rtx7v/FosOvoRlEAeHPIN61WKU9J/myrzbSbtvVL6/gWm1FuxlQU508TCDfbgj0mQOxzhIkb6o6/irWSmz8JyBUNJs5+wEZWWP59hYKpUJtQN/imjGaDFjbXoEeMLBQus9M04zBk/f3vuPoPi8IJ1W3J712hCEeCKxYBUUgQsZY9o2beoo1AgxBoCNesu0QQjpjsJ6haPGzNy03oJ1kx0R1WBrkPPW2grvsr88x+0CnUQn0cbleG3b1I0GBOddpVYzCuw8tdZVNhFcvRAeCWAWC/T5SUak4CC/rcdbsp96ElkuncoC1zy5XQNGEQ0vsXFneSrlvDB7+mXdb8ks/XmhQVDblGOvee8DWIXCNnkWw5C7JOTBBwsXyJSDIwGP32W1fLJHjkNJPLkoVkbkfobV2sFAhvFCI/vAjscNOY77YHbHwC02jaFPHrrdmctbO1pQGajITP2/NWyqqQXhETb7jySRndJmYy2OwvFYjpXfIP86XyvX8lilnC8WvxuJh0PxaDAcdgRDidFMLl+pjOULZYBHseSul5hIty/404KoAnbTk/w3JcMs11nsbnKMNZ39HUh7/Ipdfrq/fDf03s3PGvlWg082v/Pv/Pwd3h+jky7pOL8Fl/v7KTf+f1wOa7jWfI28qujOyV+XKzKehhvrwRGrQsNVqW1skQDVqZyCb/yeXcjiWct+flJbzecz311AUHaxO3FLg2e9uUdV87lf7YhOVBrybBRqCBQZ/AfTeKI4v9JotAeo6IZYVE83ldj6S3jSbBJAk8tr1cveWf2tquk00/0wa1q9+fnwLnI8pe+yKM2xNUfYyvHjdNHDD6GwxCLxE2YlDMdSZNFv3loUjjNDFTZoSzzbNrdvrxc2tnV0Dy22tHa0rQtFo0m7PxQOpqMRt9Nht2EYsnS3gZq4izlTyURoO+PnNatdSMmlb/qr1dKpgizEMvRjBbrQu67zXFUVmqvjuCDYgkynJIpg6TrH1TgaxES0ZCMMq+mjKtrLWv6T6rkZzHVRzufLWn/sBW3MZ2366pFI0H8tSNQvDQQC/oFfTpr+6HN+/oItJi4R8OMn+diRwpne8vaJmYSN381g80J3WX+wgdvzf4sl+gK+cmQ05J0KSsHnzxMjQYJQmfue/VF2ddAZRuDKeJQIOPBNYV3s1zG+Pezethu/eyjuFG/gavbzT9wNhJS6O7fTMemW6FMdRZHJZ9kMbZFk8hqQgABYgiXEjw0j2AnGIOdY8cl/do/D76ztb8AKfuqSAczN2eMEOqD+ET3PD7u74q3F94I9LMP/f/5QJCSGKMp+KxiD/V4Q7VFFziIiWlWlYKehC23YiDZ09tu/6+/Yca/4dKGYJ6kWJU4gcrdThRql9jj8Wf1s3AGf399dXj3ulvnA7DNZfl7/7zutsubU+OeW/rqA0+QWbtir3nvmzq50uIUPwdB/0/DlDsf9VcUm57yiNP5HSNJ+OZO/KnM3woZWa6JSORgJpGtpbf7664zpmI5pdj6+72VcAK+SXqCtD9SI4CN0M/CDfKORkflZ1CP5L45orSzJywFjtJ7dlZ4U1eKBmYyr6rS3AbdLNwS+vW+BW6zgKxoR9sp0pkAn2O34eFvEtMiliZcWRk7s0Ll/m0AErper7O0r1MRi84x1pgCQMWbb4iWi27lvpGDxL0nCu6ukC/sieMiGIonUCxXMZJrpW+hmdK7+r8ZyWSgEeKwxHlN8SJIYVgnS2bKIdle41lr+au7f9pub9X4vmIBALv7fhbTtR+xc5HOZGEAIY4QwQUv5WVuzj1/phFQAeo93ix/2jGW4xDiOhzg3/SDfrP104eMW+zofjsAsywiYpDPm+VMuGDeRfEuLLPcTx+Te6oafkJHEPV3BfOEzcVPe0I+NWId+9JMXRcjQNN2wnWqaOtKip6jIAgsF4YWFYYCS6BClCJARHSJMWJhgCiBCbRKoIWOccvWPm19/7o35cHHLRfqf2fmueVMsnP2VTPlO3Dn/T7c4wkKxkDipDCy/m/h3gL/XmR20blakndKv2NwwmLT4b8aWCXtz+gWuuT+8Zx/z5K4CafG8mWe2O9Z/0R0ScjyCKfw33jgg8I8B/Amx5FbsFHBMI5qzSoNSorMk+MRo6d/10VbBd4fcrSUGQqqua6ok2lQ0pMdiBzl7Nwxc1zRUFeyCrpSYoayjUgUXhYsCgqWIlQUJrF3uJ/I8GwmcN9qmC0IhepItWbPMPllvA+sh/fr5DMAABl5ovQ0H3J769AKvVaJfMtm0uqBasL/1q0C97IM12sVZJWEuph2tPAhWah0WASilWAIF3Uxlta0Sn/An/6dJ5qwsBWccRh7zxcvKpncSRGAHC1iIi1nSDDiDH13yHwXbpgU1m/fBJzsFnE4/iB5MESIIo1glwXj08vf1+p/VhCxLyqQlGuQkXD/L4S3ncsOOZzB5ogaajKEml1+ofu3buEyU7Pv4Ydjy3eXqxXiv1aMhQ9dtWhSs4G2oCy09BGuklCIozGqrQTtgQnof0bC/66K0XbARa+DseSorlJSN48XDgsJdpHCfbBweQaJCAEqSLkBhwUOdCIbF/H6L3YBRbWdBggEDEqTR2FcLFCURRAZ4RSFufdDUrVVQBlmpn1P1wa0ZgcuHCMxgS6U48SKrwklewqg1lsh+sBa0rGUKoW2F7emvbaI2QvLcwe3zDQPX+g40vBHv1LTvNkYmD00NtI8WjgbdsWEjVh5Go6VScZKRLJ+oggb//2ZZABY1Gwy/hBQrBwslz54UCrBDLWDvJYWJq7vH2XJBvC+UlrVhytLpXfFO4qPGPrK4wO6wMz3JN9eb/ROHPkTrseypc47XcqhggrS5sdFCE6Z22016+coYn8/tel/e2Fk7Yt+LoLd7lKbffF249Cq0TIBGFfJtlL4fbtPfHUYGXyHjGWPXOzvz9+yDhi26VoLQ2InYS5K0ZfDjZIKdEbORZkuJmbjxOE17TdZEli2VWMOIZ4SQLh4myY0BpEVs8G5lDupgjbzoOo5JlaO1dKXZnJ/DxXhLZolbmxJoGETNNZLUtXc2l03GaqcvHYzjZ3jQT25l3qaqri/Wu2QsCB1LmMB1qG516OjFfDnE6ThF/BycjpMNLb98TTUFuim1U8pCztqkPe1G1Jhg9xuizommBiFSkxXEphGdbIQW8EveEWdv6E0m9fGVhYWzgkg1C3rAseH540KB69FkEs8zlBWlKhA11rsLe24//WuJY8qY7uaRqRuNj1u87Lza2mTul45dZtuOWOwed/KSH6YXiaRaazS+D2REboHQunZxgy/zHw43Cz30QktZtas7ddNid2IENUlX1xNZDFgl2rhfLUMGd6uK7+HFPme5f4X90cvKU4urtL3K/4/8LJxXmPf3MNBiSJ9K/EZ+UO5Tu/e8fF4hQXNjI3Bcb/gTQgPa1/jqJMiwhyqv339d/uQ46a011g/NW9xBLWzKIDpzufk428Cco2QV4a6jsWT8XhYky6cNCtmCrLvKvgFZFnKSsg4ynfY9olGsyKHfm+176qxmtBdh2iNQ0TuAnhx7PJPg5SFMVkK6SJQx7Wmm+OioszNLl8lsOkIZlAQ83FE6alk99LdJVYiqbzwfuYcmJaMaS43GRd/i7FphhMvNrSspxfm+6KIuPKQc8OxcvS9mctiv42FM0GnhJTu04LBcdogkjlshw7U09d7vv5C3sBemqI04EWOb7XPsM5mU5LMPS5laY9qWcQImgY2qY3XxflSttoPWrh1YtNu90391k55F2JuHnc7av+IDvWCte0hWMmzS9XT6dRX3k2/R8+Rr39r57/PYEbglzwrEzzFWS4J/nioe/NDn0u+9S/sRl9qL2uho0ZGpw7F91IwLQl7TgAk09sbqAN1RVQ6E8h31OBpqVcTnpp41F7z+6Sjt1j2cA11nQDTuGYgNk2elDtT/S5+RRL0pxHMqdVmFivrZ0VT9yk3mO18Tu+MzlMA1BorhE8gOMtvWFlIZLMugo5txX15RkE2o+Dk374pGFliBxi+854dvIj/hSoLT1hnHg4ndpI7LmW0x1/qDKoXJFXXrlCI7cyAoskOeZR5d4jPfUn+7P6azFLyxpgXCFzFCwd6MOnMTl6Gp9P5hdQ8Vku7coNHdw3In9C6NeDoISPt2m5UYsR/GsjUHCAkzgg83TjVa5kbB3xDdt3mNLyXhIPbUcqrWqhcvqVHhhhIRS8Fw2WhGr3IszfF8DR+/8JvmJBmpMs8IfiPXaLWuHla5+B36u+JWpc5bXd7T0MpgFrLDzpfL4lAEQym/Mx1dSn3cJITcXA+x89ywk+Xx2pphK6lLAp62jq5ixTPsMvVGH04NPtPenv/6xnBxIcD9nx5cpkucNZphtOZE1qS8iVqNtwXPvJM18jkIiHabfd5YiK6T9TXDqbgYv8OpOFlpfvIkNYO0ZmtNCWkiRJbpcDTPN8s1ipUlCKNZUVSQUKSMwLFGUQZpvS3O3phPzqVDKGGMEeJtQW1LCgvDnQtColLahwR5TQvzWqi6+76ogX5PwBx5UIkrWHqUxy1y43jYoNHIcEPna6yqQSNYpa7F4WmxU7sJm8pDnwin9HzlyFgJyEQyfBPCvvyT1YvPQ5iQl1wIt/7iWzx1uGrIk0o0hb+6aJ9SRsNWBgb4rcp/c/mchvZ391orh6OM9xsOwkGKB1v4COfPXuPtdLgvH2ashEhSIIFHqoLOcPzhPibbydudN496RFXjItS6MfAPboBhGOYjnUAJWpZ/lDMMCiBCbwt33Vjp2sNvJakKNE/tTVwS9h8915hYAB2dxyAQ1+8KVpwRx3WstT4pZO65KjHvwx1O86KWLGgvhCXpYtS17RW8HK5FTlTNBDCsUcoz0T7b5pEURtrJJDblsP4Xrk0mBmtVxBNB4LVilBCihuDmUh01y1AgsdYqZAXGXIc0O534YdCj1X8LzXQO80ZKhjkTgkvjLAUDgz/GM+lHQSCTDBFKsSG8bRVJGkO5xuHNfT/o04Yz3ETcAIy9c6mghl0iXAhAQD+uUD+UJIKoVIos1J1P88VFDLAxM26191biwYIELEPQVkjSdhXZMP5+R7AAf60PgkgGH0OwVYaH1yqtyTEx+fx30ZccSyAjCusc48GDmChFcd1MJgeGJVsehqWNwJW4Av/Glbii0fNUbVft8AdV1M/Tgpq3V3IH2bFm6YCCJGu6etozQPfSneojLZmqSCIPD4UTVsDdGhBnMQPXipVqOHCyJAj2K6yUYrAU0RiLKWOiATc1WpNSRpgIjVYQjGCxPlK1opqwZLahIa8yrtxwhWMWdrlC6RyrHPKnF4fZHPyYviZl0RV/Wfhl03Wfe1GyuSOHV8CbkI3qSnZxL7ela1E4eVVjWixJvWqTXkXhx5dHlqP5YScGrx4JN4S1vPWMWz2ER5vQuOy9fLatmft9nRW5T8isrA7e6ryVBI2mDxPbQtEKfBxEQ1XRHmqSPz7JtcabnI8iwUIJqqs9yZSaUlzbPbdslAQhDiQSuCHw36gRVpLX1no12JAWm+SJ5WpusmkkFYMzNmZMHvyjh2E4uOYtO7z3sajVOwuYaAjiNPkFYatHFkjVheEMhIfzrElBQUEiZoWoZRQBEptnaAi5Ml2KYDwHGZZzn9up3Qq4UQOYZAhgXMdMPSwFq0XI4GhTRUoAYtI5iRCVL0dqpGMM6rk2gzWTcqey0YAyZamsLLrKzIQpnY1mTB0HU1wtlcI1nIUTMlDGUJ2bKrAMTQR6fFFNYImpkbfAUEkaXgOlyauIhMVxg0rKYcYBYxQWcx3FS0MfYc4pxsWi3wMVnAlnyHHm5I9Tp451nyYZvl5tVniF5w3P1TVB6jqwovEjOL1GNNeUJFnVikm8JHHMdk4qwTvXSwupzH2qzEa1DOOIsiests56VlYMA8RccH8SQSkbrf+iLhOXv8ji82Y/tenYZjwcb7s3ehMr3JSxK3DT1e/LC5y3LjHVTaNQuDexJZO5J8/UNyGoxz99K3nxhcVyK4TZmBpCDakAzW7a/uVDD8Hzl8VV0HxkXzJ5zhhQtytZtJn+ZYPaw4N55hyTuzOfLzMk9mS0PMctnGfhq4ckGCvtqLo3P7hs7yUOvWH1fHFVv1mr7VcE4R/6Oax5S2c/USYgFHZLlrQ9IovSYcDaFRpgRNnmiobu/Jb41R7uybpP/HunjIRd0554DXdeldttrkh6IzpppZqzbOAmVHTJn9aLs970Jtg+MspLKw3BNEtXOJY2Gs+VWlBpK9VW18cn8iXZ0JCKTezjuL1OptYcXzCnmmQ2WSmHwfRditK3qdLKg3NBi6el8pdso870vASz17MS3YTBqIbFylaFsS6aeV/owTc+DYYDG78NaJOHkG7g1fvl8qRgG+Mpz2wuA9WyHIZQZjtDE4T1HUjt8LIDlZyFIQzgQAyhf3Hq71w31btX9i5tiORI/FaIRaXZonnBEFIeoxUxF1lSVE6b2MQwW3pNw7IMleW6U34SmrLmwTP6Qwtctavenzsbgvtoyb1AYWvv+D1v1+J2kb7pMRQ+MDtaGVnuergg/PtH3G4Qbcuz4ejHEnQNuxOTNrEvuFRHpQGEoVeu/cXDtHvgkx1smdeK+qNg6zICV70FVHurQsmC6oEfMmkqIj0k4BSl/TxLgCA0WmFeWJjo3fW8MO8FFFNMZPMamfSWUh+1xw81ElDHZ7TE4jwEewY17yHMh4YEXGjQUqZIL3ljpTPfJW8DM+wCp/HpeqHmHQmtdmusv8pjBjMsw+0yDrGxSdPFwOcXWfaZaJRKU09EyU9qfiNtAnzJtoRxIuUvQF3M4zi6b0oIJvtnIqmkc9V9u/IcwIABAwZsK/g5YIY1NGb5SEWcDIhCwTECEwoogj5RyrhAtE116Akp4+KlHqXSBwoeF4QO6D96TdpxkehZRFIh2ceFokPyo2eUeZKBj2NCNgXHeAM+cjD94+m9zV6/Vydb5tgACBAgBQTDptnhBQPPR0QQIEGAANEJvTGsmsE5hwZf6njm0PuctxNw0Qfh3pk+SZlpx9wYVGtUYCarEzQHGl4KHn3WjkQAmQcPhvKzLDhrQdj3+tDZWIRMfy8esHNgdDFUHodYGqPW9lPzo6FBZzURAb9DBlVvuhqjSwUA9vCJ3An9+LDnpWPBrd48aBkJYGNAUtByPvVZbXufs4POkT/ZKabMAeJIRMQiE8dGF45ntXC86sKBky5uKXhYO6UhBVE+RZP972sy1sQ/igsuxpK4hcCRwA78Etfhx+07qHRj+IVlr1rCjHbFL0q370xQWEcLeYFD+vEuOZiqSBCKTDdFUeYiRhxHrqGqp+5O9kSzV3eRjsO7xcV4eh6ucQNXhnhVW6gfDG04ZqivdlgQJUk/ZlUoxkOhwniWlbkK47n/VN8dmMhxV/FSu4fPq5Z5Pu04u1nsv7jqoAFDnjwoF+tpsmNkfPr42KljdhN/8bvyMcJLyRrr+7kbneVjUgc7uGI99P2OeJQtVY6dSSSHGftSOj8ohPIYvRMRLJ9kDkyaa2gnU9lSWl49T63Obykxa3RqCW/1LdrUUWF7r5xeQHj+hqMrHL7v7GZ7jha1bK+HQDuVd38pcmGTQalzTXzvVDruI4DPgcYWK5yTBkUwfi2ocxInZGy2V0/hd+iLSITIWoQvmuV/b0nW1Qos+l1XeleDETPdOdeNsdJcsl37TM/x5unD0czJ15mMKFYwYkwDaoZsPo9AGAf8HzaM2ehImWqhqzv6TvJq7mw4nqnbLfksdxKa1msVHuZ1VbVDdvr4fLvcqAoNodObPUiUyISjFFYfAafoBZQ1q7c2OvNB7c5U0l5pNggPzzUn8Srv01cLs9Qhhtb2SgcHB0XBZu2U1AEWUXpVl5+box16Wo56WrQJ4dkSC2yOio1fnqWcL2gGzz27KDNRUkxTZZzrqbIRYQmhyrfE0/iL5g0ijTmkEPcodpTsxFPq6QpFS+AI2QJZPbcWcZLvFe3lQlzM53qmb/sq6NQQxnlbRa9G/IdHxxdNnsORQwUlRIg0wpF8KjLi9Iaidod9zpFkHrQ4Jh86Rmg4R5LxnW6lsysri/orsUmwZ1vQkS+1Imz1OWGteA269Fe1poV1bwUSF5rz0k5zucT3xhnnfV6v73fHBBAIw7BY3iq9HonB6xA0WLKYAbSEWCSOQaeupxBuWmrSkgV6JDOpMhzwngyvPHf1FnjICKOLJoaepZZbqnn7GtvKqhOC1XEJhjhsBEzsuq8kY51YZNCATCpTf0RUlTdoHq+dHl81g8OgiU6akZJzg46vz8poKtPh2eCDbOn2kJ6fyBoHZhHNheZuoSUgMH68uFTw4uO6j7mbPiLRavV7ESLq531PbCVv6cExIDpdg2Qao0xy8Nql+KitExd7L1WRNDccxBHe0uLA9YrlyoJCsK/bntzSE62NhUyz2Ap8wNPBgQC7ETEKXLZiEcvIwiM8Vlq8GWCHQopnkLazN1f2I091Gz8zX0GWKdCeORzuVaAyLgjHWrVdlMzYJqHYmmEQv6lf/u1NiQ646cYGrGkroSSLjInowAM8A/x4fBnCeZx2lHT6+jVj/Ngmu9SsqixlkmdEWQllbm67aMQXG/91aIOnZEGpcE4OYKlpGMSajDolv+0ZfYuaXcar4wM5W1HGRAoiYTdFhpumhw1msvzoCTRL3Us2ZBVkw1Cyx44U5biz0qPXCZLnwu5+dnnodEqrb3pGa8Jd+Fg3Ox0NbS82jKinIrExZLyjBFw+/D8zWuPn49VXv5Ac2aGiysWt7MzQmUKB/WWC23bt63/BI/R/dKuUkZG5ObQgXz1ZuAh1C5VcNP78U59dajd1zT/EGm3/T6Waf/riJTwGPUb+xYX+2oIdBmo/7s8xVPxC1YGIA0LOswXzJFWZ49OCovO43BxfPNpE3WHaZihMSFh4uDuYh1KZJSmEGqjk7x8aGxoSlWAXE+Tp6u6CDXEDnTRRGOmf6o9yZi0uJCEDC0qoQ7X+y170opDr6uqFm88/fEln7R2Sn5fG/YX527+YCv4cl11im5sfZPWMJPi2bSYm8vrh3Hlr8v7LjZPywpWPptvOVzN8hD81/Mmdi6vBwViVl4vtn1qprcvJCX/8rIN3jzhhgUBKVKGu9RePciZjk59969zRj1xN4xrQRuZwTqsejWM5B3XSi1OJ9XyBpjjFzPFvejGda7XimRpfVdlj2H4RLzehETsADg34isjaTgILk0g8fvzIqvvWrH8p98XqTME0okgTOeN9Lo5O+exZJ+uIMstMKZJ7CHNUTbMEunW0YnqQsy6nC8UgY5OjgXg6C1SJK8W6yI0j01K6eLix+3E2Uz5uyiwJQxYkiQrhjkI1c/elKqHpXYSbfQLeQRgfyHvDqCO/TuBDjYJ6g6Q0Fg5BlQGEw3wRuiZ8gmT4ryNT69BP2V1nLrfqsQS0VRNzqdi193VWvWP+LGW0Nul3ZWU8ZqjfUjfNXG0C5VpLt+XrMd5jnt4UOZTFDRQoUKCVMbMVoWVEArO4v6nXgQnwtSeKcFnx1wye1cEkDgJ4CvdpbfCANhNS1LVFcPeTHPSkBaqAzXzS4X8zIf0LHll20tHpD+6qsZLsV3yBCv68sVjp6czpp8pinh+Warip51b/pwPap9b/Xu15dmBPzb4V/pc+dlvLrc7mD2TEDWEkYHCmeqUvcl09u5p+9zXXZ6dDfq3sm1Yyl9+9KEJiFA2YyBgwIITFYQRCyhdegJWgrqdKwgHoqSMRDLnRv/qvGnX781eE+9b5tAMbx9stHf+AkjC6ptJITGOM6oFEgwSHRrOv4knpHpysbD576hxOd4GNeIZXcdL98PmNAg74WbFNIsLrjT25JD7dEvd6+7yTAP9XigAerJAMLNhY5AMxgwvgsVv4+k+cR393exLIBP5VjtCDBiGEgXoNZOFSEjwGiMDMHFAxGBf3U1ZeE9bAS+WLmFvBVpY0yavob9R8Ebhm9Cl9eo6I0j9jYL5h0JzU6VFnPI2AlZoa3cCzWgAe7ycdpIPsJyXLIFJ+hDkABymoIUjgxWHXIBS4B+AxO4+nQQi/GuLWbjtDdkmX3NcZP/B4FUSfSU7i7iS8rGjOcXHrWsZmQ1q0v+C4mIoEu5601Myg6gDJa5V1Uvs/Akw7LAf4hiubnUaCfQPVNULBbTfnosMVqr2Qb8OxA/pT5VrljvKZWDWzKLUjoh46z/MnnTXWESBySDSsffs/1laQf8Zl9RpgSoSwkukLeb71PAJso/l3RUrXWw8cDOLXJoHLVJeuakZ0amDOOhCSNtRS5mmJRk1ZsJ6DvGDpBBBTA666upnhzZm6QpqcZyaTW7ncL9ISZUorxEmFgnsHbvlmwRk3tvEjW8inFP1kC4N9ANsJy8kQ/puTDXrw6iD34DNqQQsKiFoDsDwGeEyvyV6I/3dgGpakj1beArgsYkq6EJKCBRa8BySUg0cVPEfCGBc3qWjEiyfeoMWLRVD7pJt0Y/b+6sE599180s/M/UvmtoikJ6gbjQd64fptl+fXn/jy+ucA8qM/+Prnahwg/vaXrgP0poPswjpFFQck6PFKgDxxQg+YZ/ZL9ISmKdjHO7+sdj/G3vvLPXX+V9hDVFitV40+H0ye2nZNm98gEYpIhqAgBoC5VNae8fXBZ3OlFv0nwTxYavQG/8Fb1PsLaPDHP6w0a43upe9oKDGL4vrDpWVue2Ppv7OtUuQEDrICMAFDBI5LyuMO/HnVVHnZBME9cwD+7FGzSgUwKvOVF7FwgSbKD++047noGZywHY30bLl+hetfwfUvE/5aADgC4iBBII74dcin8pXKoUzkIoGKr10H4qNCIh3s8IVhLdrehmGAi3+cDgZJfwXo5wd1phpH/oI3zSgIXgnekJEec7Kw3zqgR4FoiQZ42PDZoSnZjrfpLLOD/V9jO9Mh8AAbnzjFRncvEROkcYGV8gno+DaHq3o+xMG3gW/bKrjVc/DKvkwEOtGDTnSio8N+pU+RT061lSQnMypKm6I6eIuZV/AAohe7LYpuX+E8bjTMdWO94erh6z+M0uVsPwk5F6Ljp9Vc7v3G+OLhIfFjlLNnR4x8E4F7VB9kVqK+vKQDz4cnzCinfdqVu1cND3PX5ysr0Mo05agjv1SXBnut9rboP3xPXW0bYL/raGFzm6YFZ0pImOAKBHufEp91DYUpodi4pZCcb/zhmmrpKa5WoEkCzkFVcMybJtc57Gt8PWrSzCwf72Dc0F9eUMfqcuslDBMJV1+aJ6pPeoJgeggtI42eN8fbJrZQbxBJUgcs80etBM80NjSTLAgQakhBPrs2LNjXsKGpZzoEF73NAyVfBdX+B6DwofctffMiT4b64lVYw1xcwHor7sFV+CtuWEkejAVsqcAfjYbT1fzDSDQ4Nn09GrfeRvI31milTKCmSrTct4kuhutmmlfLVUZQVlfLbfiY6uBMEhJktSzNzgz37XA6+5U/WdD5Rjxb7GzLCju38f08dSfWBjM7ubnptlsak8w/asUZpWZXGrlNT5z+lQnw5hwyWKDV7ui5nPyQIZG7uuphYvi3BHXxdyZaNlCmWi8RXD3agUTdNPtY7uFslE3VteU2h31+tn40zoLAs5rCzECtcpDwYInTmp11h4mg/IE4OISftUpPfambEs8zpIRb7xF0ljrwuHCfyB4Cxwtzemz2HDrE31QFn0ZQUFry54Mobyz4wsm04E+652vcfyhQ68mLCQxiCYC/WcUAp7gS1k/Tv6rnawbrHiD/vdyLSFoOOtraUVEgb2xbV9fw6Y2Ne5/DMp/lga0c7+Lve+bPdqc3tdI9AxCIsjEC4RYUqx/k1mXgShCPMPg6MuHtXvUQYotNbIwN4PD2dnV3TwzyeDcbb/dpoo2eUV6HEx8VdxvRDA4RFFKGQF28hAI4oILClaooTsQh7AwLCKiMbI6H9q3YsWyVibBmYZuRwPTsS98O2mB64c9E8Mx0T9nzU9T79IGGStGc9HRQho9VW/45PK7p2Vh4aUmvWNCVCgKRoCcQ9wPeY9mPMzzBjfBKBjQYfbvUr6vRV2W5bjcL926LYrsKxYcfZUIH2zCzqyiA6wyYEKRIacKTRkQOTKmAKL3JpadtXiqJT2xBn81LFgI40KDjYh+Mj4Q4yP1iMSu11O+iBxu/paV2hWqoSc6/u+ferM+Qk54Ii5xlBTrNlb0H85dlybmWZpii2dzeFWZH3iBrUBIEz84xxPxGkWVVV2XEcTsvVCrlcqVQKIbkoOdX1Iem4+/GACJTaJzGo6vVbxSU7Qkx/IYunUbbxh77GvUFLzOGMR6MW+envfZ8LYp/p9rvjYWkrJe0ji5NEb4rUXqkY9dqu42ZnC1Fo4aGyVK2gQ4fNQM3iBCXGuuc9y4S+PDCjN3MOITthbTve0nP13aQpc+SLsam7mJQchBwLahkoeAzY3VnYxvVL+UV4nPza8FmUgWiEIUkRGraLQUi4xHiRwyBsxxNbb3PMtzvEVvsi968vqnTnx9jHf/0aKM329nEmBGMxi/S2mog8saz3SMOX5g983/eiK0fovZs58etrTrBjfeu4YEQ9r+IAK81PSwWvZk4Hg183+A+UlrWdeFwdHIF2Ewh2aSecnYChOOKiuvIcZBA0zoCZGj6+2Y9RglBKPovC8srvvhgY8dDEIAIQpS+W8u+6AAE9vio0NNs2edbXyJRRG4cb9UjYEJwA6aDlohVxy+W7I83PClVZih6N1U5LqUaPOREtxBGA0EgffRco894hus5IUSbQSdL0BU9aYqXuPvSjGKjyXWRH5RU796oWWVmgfks0fomZ3bgYMiXJrj267hL/uI7havtx4Q2nC3w151M4d5F0szVp1Qa9EIrZ4hxbUgtlHPC6xdmZPGC2md4VfBEhSOxQMwSdGisirAEKk1C/V8hJA/RpBGgzrw1ryTJVHGcoONfKcrYX6AkQoH+CwABAAT6RtGRsMxpp8ltIgEAAL5cWLx9MlIPg+q/m/GGunwAQAxgwLUQgB/Z5itb3qSnf/PZqYTtr2JLFf7ASQDQvwDvZLwM3BWzwH9lrA+LScRc9vJcjR/0S1rBV2roPburV6TwOix6trGs09qeU5Jf4xgYNovpOX+zjTq+JsvHKkw29jNZ15ZlzJhA8O9zfrbW1BLA5x47V8s/UB0v36ufYq18JAc9Ovva3snR+2anV9IBZn7IJYEoPu95WrqsaS8x15Ixjlh2lwdyIaTu6Ar66jscCXBHGxymPGOqBuHjnZXmE7mzuFHjHEHzjawxjZ7j19SYM8uYS7zDGSzFaBzEMhzF8uIyBZdYPr+YWHnZjkFi/iwTRPRx2L8Qy6bKD6ewQH7rOR7cfXmSMWj6XqkaYb4B4MNdmqCAm01UZutVLGJ9EmYqMyI89OquMeQch8AqfHEs/7oyI2WQy6FR/kzU4opGyxc+34CA/wPcyZYAAO1yoWcIAP9qsminOwwyrsrNh1FEgwapw94FFMS2TsFYJ6uYQ8mHIk8rVIt3zsKYIb8eBMBWwKEgQEe3ggERK1QM+EFRCJCDo1BQiTKFASoeUDgIY+0QQsmvUyHSpaIAHbtUHETxTdGATx3FgEKaKRYQebDigJ+RiidmkRKUslmJqHxGScL8v8rR85vKI4pVBWypqoguf+0Sqn58NeJdTkJ6/ZqKKtYdGmpL1p4mskIpd2pjYehoAnPWUTcpEDMMV0x1fWMaQ3IxOZt5Tl5TTchNpVOaqqUrFqidGMPd1AbyeTqabJZ6UcqLlhk0C/P6IQa7ez4daR4SIxim+ah3tN3hZl9t535dbM0FOblj1ch7ZsOrMYvidItr2h7GerYSDb2beEz31WTv1P3vd4V4A3zENZxWvzvFhA2tDNdpHHPRZI+0/eYx4tD222BvRMFTfssLGiYxYc+p9MOIaLuGJDO6eY7EqZqiqXlIR6ua17afvLbmIQQA) format('woff2');
}

  @page { size: A4; margin: 0; }
  /* P1.6: DRAFT watermark — real DOM nodes (not ::after) so PDF text-layer extraction
     can detect the watermark for testing. The renderer post-processes the HTML to
     append <div class="draft-watermark">DRAFT</div> inside each .pg when state.draft is true. */
  .draft-watermark {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 110px; font-weight: 800; letter-spacing: 0.18em;
    color: rgba(192, 57, 43, 0.12);
    transform: rotate(-30deg);
    pointer-events: none; z-index: 999;
    text-align: center;
    user-select: none;
  }
  .pg.cover .draft-watermark { color: rgba(255,255,255,0.10); }
  :root { --navy:#0A1F44; --gold:#C9A24D; --offwhite:#F9FAF7; --ink:#1B1F2A; --muted:#5C6373; --rule:rgba(10,31,68,0.10); }
  body { margin: 0; font-family: 'Inter', system-ui, sans-serif; color: var(--ink); background: var(--offwhite); -webkit-font-smoothing: antialiased; }

  .pg { width: 210mm; min-height: 297mm; padding: 22mm 20mm; box-sizing: border-box; background: var(--offwhite); page-break-after: always; position: relative; }
  .pg:last-child { page-break-after: auto; }
  /* P3 v2.2: unified spec-flow. min-height removed so content flows naturally
     across physical pages without forcing 297mm boundaries. Each category
     block stays together when possible (break-inside: avoid-page). */
  .pg.pg-specs-flow { min-height: 0; padding-bottom: 16mm; }
  .pg.pg-specs-flow .pg-foot { position: static; margin-top: 10mm; padding-top: 4mm; border-top: 1px solid var(--rule); }
  /* Keep breadcrumb header with the following content — never orphan. */
  .pg.pg-specs-flow .pg-head,
  .pg.pg-specs-flow .eyebrow,
  .pg.pg-specs-flow .section,
  .pg.pg-specs-flow .lede { break-after: avoid-page; page-break-after: avoid; }
  /* Cat-section: keep header with at least the first card; allow break inside
     a long category only AT card boundaries (.spec-card has break-inside avoid). */
  .pg.pg-specs-flow .cat-section { break-inside: auto; page-break-inside: auto; margin-top: 6mm; }
  .pg.pg-specs-flow .cat-section thead { break-after: avoid-page; page-break-after: avoid; }
  .pg.pg-specs-flow .cat-section h2 { break-after: avoid-page; page-break-after: avoid; }
  /* For the spec-grid: each .spec-card is atomic. Already break-inside avoid in main rules. */

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
  /* Phase 6.1 #10: quote validity line at end of cover. Italic Fraunces serif, gold tint. */
  .cover-validity { font-family: 'Fraunces', serif; font-style: italic; font-size: 11.5px; color: rgba(244,213,138,0.85); margin: 8mm 0 0; letter-spacing: 0.02em; font-weight: 400; }
  .cover-trust { display:flex; gap: 14px; flex-wrap: wrap; justify-content: center; color: rgba(255,255,255,0.55); font-size: 10px; letter-spacing:.18em; text-transform:uppercase; margin-top: 18mm; }
  .cover-trust span { padding: 0 4px; }
  .cover-trust span + span:before { content: '·'; padding-right: 14px; }
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

  /* Phase 6.2 — Floor Area Summary table (top of Area Calculation page). */
  .floor-summary-block { margin: 0 0 3mm; break-inside: avoid; page-break-inside: avoid; }
  .floor-summary-title { font-family: 'Fraunces', serif; font-size: 16px; color: var(--navy); margin: 2mm 0 1mm; font-weight: 600; letter-spacing: 0.01em; }
  .floor-summary-subtitle { font-size: 11px; color: var(--muted); margin: 0 0 3mm; font-style: italic; }
  .floor-summary-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  .floor-summary-table thead th { background: #0A1F44; color: white; text-align: left; font-weight: 500; font-size: 10.5px; letter-spacing: 0.04em; padding: 5px 10px; text-transform: uppercase; }
  .floor-summary-table thead th.r { text-align: right; }
  .floor-summary-table tbody td { padding: 4px 10px; border-bottom: 1px solid rgba(10,31,68,0.06); color: var(--ink); font-variant-numeric: tabular-nums; }
  .floor-summary-table tbody td.r { text-align: right; }
  .floor-summary-table tbody tr.floor-sum-alt td { background: rgba(10,31,68,0.025); }
  .floor-summary-table tbody tr.floor-sum-total td { background: rgba(201,162,77,0.08); border-top: 2px solid #C9A24D; border-bottom: none; color: var(--navy); font-weight: 600; }

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
  /* Phase 6.3 — additional zones (Elevation / GST / Custom). Single navy tag
     since their letters are dynamic; treat them as a continuation block. */
  .calc-table .z-extra { background:#0A1F44; }
  .calc-table tbody tr { border-bottom: 1px solid var(--rule); }
  .calc-table tbody tr.zone-total td { font-weight: 600; color: var(--navy); }
  .calc-table tbody tr.zone-total { border-bottom: 2px solid var(--rule); }
  .calc-table .small { color: var(--muted); font-size: 10.5px; }
  .calc-table .desc { color: var(--muted); font-size: 11px; }
  .calc-table tfoot td { padding: 10px; }
  .calc-table tfoot .sub { background: rgba(10,31,68,0.04); font-weight: 600; }
  .calc-table tfoot .grand { background: var(--navy); color: white; font-weight: 700; font-size: 13.5px; }
  /* P3 v2: per-item rows in cost table when zone has rate variations */
  .calc-table tbody tr.cost-zone-hdr td { background: rgba(10,31,68,0.04); color: var(--navy); font-weight: 600; padding: 8px 10px; border-top: 1.5px solid var(--rule); }
  .calc-table tbody tr.cost-item-row td { padding: 5px 10px; font-size: 11.5px; border-bottom: 0.5px dashed var(--rule); }

  /* Phase 7B Item 5 — area-calc page page-break hygiene. The Phase 6.2 floor
     summary table sits at the top of the Area Calculation page, followed by a
     long single-table list of zone rows. When the floor summary pushes the
     remaining height under one A4 page, the renderer used to orphan the
     "Zone X — …" header at the bottom of page 1, splitting items across pages
     in an ugly way. Strategy:
       1. Each zone-header row keeps its FIRST item row attached.
       2. The total row of each zone stays attached to the previous item row.
       3. The full table avoids breaking between thead and the first row.
       4. .calc-table itself doesn't get a hard "avoid" — that would push the
          whole table to a new page which leaves a big white gap. Instead we
          allow the table to break BETWEEN zones, just not WITHIN a zone's
          header/items group. */
  .calc-table thead { break-inside: avoid; page-break-inside: avoid; }
  .calc-table tbody tr.zone-hdr { break-after: avoid-page; page-break-after: avoid; }
  .calc-table tbody tr.zone-total { break-before: avoid-page; page-break-before: avoid; }
  .calc-table tbody tr.cost-zone-hdr { break-after: avoid-page; page-break-after: avoid; }
  .calc-table tbody tr.cost-zone-sub { break-before: avoid-page; page-break-before: avoid; }
  /* Keep zone-hdr together with at least one item: avoid orphan header at page bottom. */
  .calc-table tbody tr { break-inside: avoid; page-break-inside: avoid; }
  /* tfoot grand-total stays with the last sub-total row when possible. */
  .calc-table tfoot tr.grand { break-before: avoid-page; page-break-before: avoid; }
  /* Phase 7F-B — Cost Calculation page pagination strategy.
     Goal: cost-calc page must NEVER produce blank pages or page-only-totals.
     Approach:
       1. Totals (Sub-total / Lift Machine / Construction Total) live in <tbody>
          (not <tfoot>) so they don't auto-repeat on every paginated page.
       2. The 3 totals rows have break-before:avoid so they stay attached to
          the last zone row above them — they cannot get orphaned onto their
          own page.
       3. We do NOT force the whole table onto one page (that strategy from
          7F-A produced a blank "header-only" page when the table was tall
          enough to push to page 2). The table is allowed to paginate naturally
          between zones; <thead> repeats on each page (browser default, table-
          header-group); rows still avoid mid-row breaks via the existing
          .calc-table tbody tr rule. */
  .cost-calc-table tbody tr.cost-totals-sub,
  .cost-calc-table tbody tr.cost-totals-grand {
    break-before: avoid-page; page-break-before: avoid;
    break-inside:  avoid;    page-break-inside:  avoid;
  }
  /* Style the in-body totals rows the same as the old tfoot rows. */
  .cost-calc-table tbody tr.cost-totals-sub td   { padding: 10px; background: rgba(10,31,68,0.04); font-weight: 600; }
  .cost-calc-table tbody tr.cost-totals-grand td { padding: 10px; background: var(--navy); color: white; font-weight: 700; font-size: 13.5px; }
  /* Phase 7F-C — Cost page: lede full-width (override 440px max-width)
     and suppress thead-repeat on page 2 of paginated cost table. Varun:
     "if the cost table is running into page 6, no need to give the
     headers for the table again — it is the continuation of the same
     table, so it should be directly zone J (not the headers)."
     Setting <thead> display:table-row-group makes it behave as a normal
     tbody row group → renders ONCE at the start, no auto-repeat. */
  .cost-calc-page p.lede { max-width: none; }
  .cost-calc-table thead { display: table-row-group; }
  /* Floor summary table — its title + subtitle should stay with the table on the same page. */
  .floor-summary-title, .floor-summary-subtitle { break-after: avoid-page; page-break-after: avoid; }
  .calc-table tbody tr.cost-zone-sub td { background: rgba(10,31,68,0.02); padding: 6px 10px; border-bottom: 1px solid var(--rule); }

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
  /* Phase 6.1 #5: hide 'Set details' placeholder in printed PDF; editor preview
     keeps it as a visual nudge to the rep. The PDF route is window.print() /
     headless chrome --print-to-pdf, both honour @media print. */
  @media print {
    .rate-pill.set, .set-rate { display: none !important; }
    /* Phase 6.1 #6: render unedited rows identically to edited rows in the PDF
       so the customer never sees the dev-style "needs attention" hint. */
    .spec-card.unedited { background: white !important; border-style: solid !important; }
    .spec-card.unedited .desc { color: var(--ink) !important; font-style: normal !important; }
  }
  .spec-card .desc { color: var(--ink); font-size: 10.5px; line-height: 1.5; margin: 2px 0 0; white-space: pre-line; }
  /* P3 #10: brand-rate combined field (bold). */
  .spec-card .brand-rate { font-size: 11px; color: var(--navy); font-weight: 600; margin: 4px 0 0; }
  /* P3 #6: table layout. */
  .spec-table-block { width: 100%; border-collapse: collapse; margin-bottom: 6mm; break-inside: avoid; }
  .spec-table-block thead .cat-row th { text-align: left; padding: 4mm 0 1mm; border-bottom: 1px solid var(--rule); }
  .spec-table-block thead .cat-row h2 { font-family: 'Fraunces', serif; font-size: 14px; color: var(--navy); margin: 0; font-weight: 500; }
  .spec-table-block thead .cat-row h2 .count { color: var(--gold); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; margin-left: 8px; font-weight: 600; }
  .spec-table-block thead .hdr th { font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 2mm 2mm 1.5mm; border-bottom: 1px solid var(--rule); text-align: left; background: var(--offwhite); }
  .spec-table-block tbody td { font-size: 10.5px; padding: 2mm; vertical-align: top; border-bottom: 0.5px solid var(--rule); }
  .spec-table-block tbody .lab { font-weight: 600; color: var(--navy); width: 28%; }
  .spec-table-block tbody .lab .loc { color: var(--gold); font-weight: 500; font-size: 10px; }
  .spec-table-block tbody .br  { width: 28%; color: var(--navy); }
  .spec-table-block tbody .desc { color: var(--ink); line-height: 1.45; white-space: pre-line; }

  /* Notes page (legacy) */
  .notes-block { background: white; border: 1px solid var(--rule); border-radius: 8px; padding: 10mm; font-size: 12px; line-height: 1.65; white-space: pre-wrap; color: var(--ink); }
  /* P3 #8: notes appended to cost page (cap content height ≤ ~14mm so it never overflows). */
  .cost-notes-block { margin-top: 6mm; padding: 5mm 6mm; background: white; border: 1px solid var(--rule); border-radius: 8px; max-height: 30mm; overflow: hidden; break-inside: avoid; }
  .cost-notes-eyebrow { font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--gold); font-weight: 600; margin-bottom: 2mm; }
  .cost-notes-body { font-size: 10.5px; line-height: 1.5; color: var(--ink); white-space: pre-wrap; }
</style>
`;
}

function logoSvg({ accent='#C9A24D', text='#0A1F44', size='large' }={}) {
  // Bigger logo on cover (size=large), small on inner pages
  const w = (size==='cover') ? 340 : (size==='large' ? 160 : 110);
  return `
<svg width="${w}" viewBox="0 0 114 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M15 21V13C15 12.7348 14.8946 12.4804 14.7071 12.2929C14.5196 12.1054 14.2652 12 14 12H10C9.73478 12 9.48043 12.1054 9.29289 12.2929C9.10536 12.4804 9 12.7348 9 13V21" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M3 10C2.99993 9.71 3.063 9.422 3.186 9.158C3.308 8.894 3.487 8.66 3.709 8.472L10.709 2.472C11.07 2.167 11.527 2 12 2C12.473 2 12.93 2.167 13.291 2.472L20.291 8.472C20.513 8.66 20.692 8.894 20.814 9.158C20.937 9.422 21 9.71 21 10V19C21 19.531 20.789 20.04 20.414 20.415C20.039 20.79 19.53 21 19 21H5C4.47 21 3.961 20.79 3.586 20.415C3.211 20.04 3 19.531 3 19V10Z" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="28" y="17" font-family="Inter, sans-serif" font-size="12" font-weight="600" fill="${text}" letter-spacing="0.5">ZuildUp</text>
</svg>`;
}
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
    </div>
    <div class="cover-mid">
      <div class="cover-eyebrow">Custom Home Quotation</div>
      <p class="cover-tagline">Don't just build, Zuild!</p>
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
      <div class="cover-qid">Quote ID<span class="cover-qid-num">${escapeHtml(state.quoteId)}</span></div>
      <p class="cover-validity"><em>Quote valid until ${escapeHtml(quoteValidUntil(state.createdAt, 60))}</em></p>
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



// Phase 6.2 — Floor Area Summary helper.
// Synthesises a per-floor matrix from the existing calc result `c`. Returns
// rows in this shape (with a totals row at the end):
//   [{ label, liftStair, covered, semiCovered, open, isTotal? }, ...]
// Used by renderAreaPage to render the 5-column "Floor Area Summary" table
// at the top of the Area Breakdown page.
//
// Conventions:
//   - Lift & Staircase column = LIFT_PER_FLOOR (if hasLift) + STAIRCASE_PER_FLOOR per level.
//   - Stilt row: parking area shows under "Open" (it's open/uncovered ground).
//   - Floor rows: covered = floorAdj (the habitable enclosed area); semi-covered = balconyPerFloor.
//   - Terrace row: terrace area shows under "Open" (open-to-sky).
//   - Basement row: enclosed area under "Covered".
//   - Mumty: not a separate row — counted into the staircase/lift totals via the
//     calc engine's `staircaseLevels` formula. We label Terrace as "Terrace
//     (Mumty)" so the customer sees the rooftop access mention.
//   - Package label: derived from build mode. `structure` → "Structure Only";
//     `full` (stilt/nostilt) → "Premium Package".
function buildFloorSummary(state, c) {
  const b = state.build;
  const hasStilt = b.buildType === 'stilt';
  const hasLift  = !!b.hasLift;
  const isStruct = b.buildType === 'structure';
  const numFloors = b.floors;
  const breadth   = b.breadth;
  const plotSqFt  = b.plotSqYards * 9;
  const floorArea = plotSqFt * b.coverage / 100; // 7G-B: keep precision; display via niA()
  // Phase 7B Item 14: respect per-quote editable lift/staircase sqft.
  const _p7bfs = state.pricing || {};
  const _ovr7bfs = (v, fb) => (v != null && v !== '' && !isNaN(parseInt(v))) ? parseInt(v) : fb;
  const liftPerFloor      = _ovr7bfs(_p7bfs.liftSqftPerLevel,      LIFT_PER_FLOOR);
  const staircasePerFloor = _ovr7bfs(_p7bfs.staircaseSqftPerLevel, STAIRCASE_PER_FLOOR);
  const floorAdj  = floorArea - (hasLift ? liftPerFloor : 0) - staircasePerFloor;
  const balconyPerFloor = breadth * BALCONY_DEPTH;

  const liftStairPerFloor = (hasLift ? liftPerFloor : 0) + staircasePerFloor;

  const pkgLabel = isStruct ? 'Structure Only' : 'Premium Package';
  // Phase 7E-A Item 1: use the canonical FLOOR_DISPLAY_NAMES so the summary
  // table matches the calc engine's Zone A item names exactly.
  const floorNames = FLOOR_DISPLAY_NAMES;

  const rows = [];

  // Basement first (if present) — convention from the reference image groups
  // basement at the bottom, but Varun's scope says "(Basement) — only if
  // hasBasement". We'll render it before Stilt to keep below-grade-first
  // ordering; the totals row math is order-independent.
  if (b.hasBasement) {
    // Phase 7B Item 13: basement area mirrors the ground floor footprint
    // (floorArea − lift − staircase = floorAdj). Pull the post-override area
    // when set, fall back to floorAdj.
    const basementArea = (c && c.zones && c.zones.E && c.zones.E.items && c.zones.E.items[0])
      ? c.zones.E.items[0].area : floorAdj;
    rows.push({
      label: 'Basement',
      // Phase 7E-A Item 2: drop pkgLabel from basement row in summary too.
      sublabel: '',
      liftStair: liftStairPerFloor,
      covered:   basementArea,
      semiCovered: 0,
      open: 0,
    });
  }

  // Phase 7B Item 11: pull POST-override areas from the calc result instead of
  // recomputing from raw build inputs. This makes manual area overrides
  // (e.g. First Floor 2073 → 2200) flow through the floor summary.
  // Helper: look up the post-override area for a Zone:item key, with fallback.
  const getZoneItemArea = (zoneKey, itemName, fallback) => {
    if (!c || !c.zones || !c.zones[zoneKey] || !Array.isArray(c.zones[zoneKey].items)) return fallback;
    const it = c.zones[zoneKey].items.find(x => x.name === itemName);
    return (it && typeof it.area === 'number') ? it.area : fallback;
  };

  // Phase 7B Item 12: Stilt row column reassignment.
  //   Lift+Staircase Area: as today (liftStairPerFloor)
  //   Floor Covered Area: 0 (stilt is not enclosed habitable space)
  //   Semi Covered Area: stilt covered footprint = floorAdj
  //   Open Area: setback = plotSqFt − floorArea (stilt covered footprint
  //     before lift/staircase deductions; setback area = land NOT under the
  //     stilt slab). This matches Varun's mental model (stilt = semi-covered;
  //     surrounding open ground = open).
  if (hasStilt || isStruct) {
    const stiltCovered = getZoneItemArea('B', 'Stilt', floorAdj);
    // Phase 7E-B Item 4: stilt 'open area' = setback + ramp. Pull POST-override
    // values from Zone C when present (Setback / Ramp), else use defaults
    // matching calcPackage. Keeps stilt summary in sync if rep tweaks
    // setback or ramp via the Per-Item Area Override panel.
    const setbackDefault = Math.max(0, plotSqFt - floorArea);
    const rampDefault    = breadth * RAMP_DEPTH;
    const setbackArea = getZoneItemArea('C', 'Setback', setbackDefault);
    const rampArea    = getZoneItemArea('C', 'Ramp',    rampDefault);
    rows.push({
      label: 'Stilt',
      sublabel: '',
      liftStair: liftStairPerFloor,
      // Structure mode: stilt is enclosed at structure rate → covered.
      // Package mode (Phase 7B Item 12): stilt area lives in Semi Covered;
      // setback + ramp (open ground) lives in Open (Phase 7E-B Item 4).
      covered:    isStruct ? floorArea : 0,
      semiCovered: isStruct ? 0 : stiltCovered,
      open:        isStruct ? 0 : (setbackArea + rampArea),
    });
  }

  // Floor 1..N (habitable floors). Phase 7B Item 11: use the post-override
  // area for Covered (Zone A items: Ground/First/Second/...).
  // 7G-B: for nostilt, the ground floor (i=0) has NO balcony (semiCovered=0)
  // and Open = setback + ramp (since there's no separate stilt row absorbing
  // the open ground area). Floors 1..N-1 retain normal balcony semiCovered.
  const isNostiltSummary = b.buildType === 'nostilt';
  const nostiltSetbackDefault = Math.max(0, plotSqFt - floorArea);
  const nostiltRampDefault    = breadth * RAMP_DEPTH;
  const nostiltSetbackArea = isNostiltSummary ? getZoneItemArea('C', 'Setback', nostiltSetbackDefault) : 0;
  const nostiltRampArea    = isNostiltSummary ? getZoneItemArea('C', 'Ramp',    nostiltRampDefault)    : 0;
  for (let i = 0; i < numFloors; i++) {
    const zoneAName = floorNames[i] ? floorNames[i].replace(' Floor','') + ' Floor' : ((i+1) + 'th Floor');
    // Phase 7E-A Item 1: lookup name === floorNames[i] (FLOOR_DISPLAY_NAMES);
    // single source of truth for floor labels across summary + calc engine.
    const lookup = floorNames[i] || `Floor ${i+1}`;
    const coveredArea = getZoneItemArea('A', lookup, floorAdj);
    // 7G-B: nostilt ground floor (i=0) — no balcony, open = setback + ramp.
    const isNostiltGround = isNostiltSummary && i === 0;
    rows.push({
      label: floorNames[i] || `Floor ${i+1}`,
      // Phase 7E-A Item 2: drop pkgLabel ("Premium Package") from per-floor rows.
      sublabel: '',
      liftStair: liftStairPerFloor,
      covered:   coveredArea,
      // Package modes have balcony as semi-covered; structure mode has no balcony in the per-floor row (terrace at the top still applies).
      // 7G-B: nostilt ground floor — semiCovered=0 (no balcony on ground).
      semiCovered: isStruct ? 0 : (isNostiltGround ? 0 : balconyPerFloor),
      // 7G-B: nostilt ground floor — open = setback + ramp.
      open: isNostiltGround ? (nostiltSetbackArea + nostiltRampArea) : 0,
    });
  }

  // Terrace row — Mumty stop.
  // Compute terrace area same way calcPackage does.
  const terracePackageDefault = floorArea + balconyPerFloor - staircasePerFloor - (hasLift ? liftPerFloor : 0);
  const terraceStruct  = floorArea;
  // Phase 7E-B Item 3: respect manual area override on Zone C 'Terrace' (if
  // any) so the floor summary reflects the rep's edit. Mirrors Phase 7B Item
  // 11's pattern for Zone A items (was missed for Terrace).
  const terracePackage = getZoneItemArea('C', 'Terrace', terracePackageDefault);
  rows.push({
    label: 'Terrace',
    sublabel: 'Mumty',
    liftStair: liftStairPerFloor,
    covered: 0,
    semiCovered: 0,
    open: isStruct ? terraceStruct : terracePackage,
  });

  // Phase 7E-C Item 7: attribute Zone A line items with `_floor` to the
  // matching summary row's Covered. Skip line items without _floor.
  const lineItemsA = (c.zones && c.zones.A && Array.isArray(c.zones.A.items)) ? c.zones.A.items : [];
  for (const it of lineItemsA) {
    if (!it || !it._zoneLineItem || !it._floor) continue;
    const target = rows.find(r => r.label === it._floor);
    if (!target) continue;
    target.covered = (target.covered || 0) + (it.area || 0);
  }

  // Phase 7E-C Item 11: apply per-row floor-summary overrides AFTER all
  // numeric attribution so the rep's manual edits win.
  const fsOv = (state && state.pricing && state.pricing.floorSummaryOverrides) || {};
  for (const r of rows) {
    const ov = fsOv[r.label];
    if (!ov) continue;
    const numKeys = ['liftStair', 'covered', 'semiCovered', 'open'];
    for (const kk of numKeys) {
      const v = ov[kk];
      if (v != null && v !== '' && !isNaN(parseFloat(v))) r[kk] = parseFloat(v);
    }
    if (ov.label && typeof ov.label === 'string' && ov.label.trim()) {
      r._origLabel = r.label;
      r.label = ov.label;
    }
  }

  // Totals row.
  const totals = { label: 'Total', sublabel: '', liftStair: 0, covered: 0, semiCovered: 0, open: 0, isTotal: true };
  for (const r of rows) {
    totals.liftStair   += r.liftStair;
    totals.covered     += r.covered;
    totals.semiCovered += r.semiCovered;
    totals.open        += r.open;
  }
  // Phase 7E-C Item 11: optional override on the Total row itself.
  const totalOv = fsOv['Total'];
  if (totalOv) {
    const numKeys = ['liftStair', 'covered', 'semiCovered', 'open'];
    for (const kk of numKeys) {
      const v = totalOv[kk];
      if (v != null && v !== '' && !isNaN(parseFloat(v))) totals[kk] = parseFloat(v);
    }
    if (totalOv.label && typeof totalOv.label === 'string' && totalOv.label.trim()) {
      totals._origLabel = 'Total';
      totals.label = totalOv.label;
    }
  }

  rows.push(totals);
  return rows;
}

// Phase 6.2 — Floor Area Summary table renderer. 5 columns:
//   Floor | Lift & Staircase | Covered | Semi Covered | Open
// Banner header with navy background; alternating row backgrounds; totals row
// with gold-tint top border. Print-friendly. The plot subtitle line shows
// sq.yd + sq.ft for context.
function renderFloorSummaryTable(state, c) {
  const rows = buildFloorSummary(state, c);
  if (!rows.length) return '';
  const subtitle = `Plot Area — ${c.plotSqYards} Sq. Yard / ${niA(c.plotSqFt)} Sq. Ft.`;
  const cell = (n) => (n === 0 || n == null) ? '<span style="color:var(--muted);">—</span>' : (niA(n) + ' sq.ft'); // 7G-B
  const trs = rows.map((r, i) => {
    const labelCell = r.sublabel
      ? `${escapeHtml(r.label)} <span style="color:var(--muted);font-weight:400;font-size:10.5px;">(${escapeHtml(r.sublabel)})</span>`
      : escapeHtml(r.label);
    if (r.isTotal) {
      return `<tr class="floor-sum-total"><td><b>${labelCell}</b></td><td class="r"><b>${cell(r.liftStair)}</b></td><td class="r"><b>${cell(r.covered)}</b></td><td class="r"><b>${cell(r.semiCovered)}</b></td><td class="r"><b>${cell(r.open)}</b></td></tr>`;
    }
    const altCls = (i % 2 === 1) ? ' class="floor-sum-alt"' : '';
    return `<tr${altCls}><td>${labelCell}</td><td class="r">${cell(r.liftStair)}</td><td class="r">${cell(r.covered)}</td><td class="r">${cell(r.semiCovered)}</td><td class="r">${cell(r.open)}</td></tr>`;
  }).join('');

  return `
    <div class="floor-summary-block">
      <h2 class="floor-summary-title">Floor Area Summary</h2>
      <p class="floor-summary-subtitle">${escapeHtml(subtitle)}</p>
      <table class="floor-summary-table">
        <thead>
          <tr>
            <th>Floor</th>
            <th class="r">Lift &amp; Staircase</th>
            <th class="r">Covered Area</th>
            <th class="r">Semi Covered</th>
            <th class="r">Open Area</th>
          </tr>
        </thead>
        <tbody>${trs}</tbody>
      </table>
    </div>`;
}

function renderAreaPage(state, c) {
  const zoneRows = (key, zone) => {
    if (!zone) return '';
    const tag = `<span class="zone-tag z${key.toLowerCase()}">${key}</span>`;
    return `
      <tr class="zone-hdr"><td colspan="3">${tag} Zone ${key} — ${zone.rateLabel}</td></tr>
      ${zone.items.map(it => `<tr><td>${escapeHtml(resolveItemName(state, key, it))}</td><td class="desc">${escapeHtml(resolveItemDesc(state, key, it))}</td><td class="r"><b>${zone.unit ? ni(it.area) : niA(it.area)}${zone.unit ? ' '+zone.unit : ''}</b></td></tr>`).join('')}
      <tr class="zone-total"><td colspan="2">Total Zone ${key}</td><td class="r">${zone.unit ? ni(zone.total) : niA(zone.total)}${zone.unit ? ' '+zone.unit : ''}</td></tr>
    `;
  };
  const totalArea = (c.zones.A?.total || 0) + (c.zones.B?.total || 0) + (c.zones.C?.total || 0) + (c.zones.E?.total || 0);

  // Bug fix: count rendered rows. If high (basement+lift+all 5 zones), split
  // into 2 pages with clean breaks. Threshold ~16 rows; 4-floor stilt+basement
  // produces ~18-22 rows reliably.
  // Phase 7B Item 5: choose the split pivot dynamically so neither page is
  // sparse. We aim for roughly even row counts across the two pages.
  const aRows = (c.zones.A?.items.length || 0) + 1;
  const bRows = (c.zones.B?.items.length || 0) + 1;
  const cRows = c.zones.C ? (c.zones.C.items.length + 1) : 0;
  const dRows = (c.zones.D?.items.length || 0) + 1;
  const eRows = c.zones.E ? (c.zones.E.items.length + 1) : 0;
  const rowCount = aRows + bRows + cRows + dRows + eRows;
  const splitPage = rowCount > 14;
  // Determine pivot: 'A' = page1 has A only, 'AB' = page1 has A+B, 'ABC' = page1 has A+B+C.
  // The headerBlock + floor-summary table takes ~22 rows of vertical space, so
  // page 1 has roughly 12-14 rows of "zone table" budget; page 2 (continuation
  // header only) has roughly 30 rows budget. So we want page 1's zone rows ≤14.
  let splitPivot = 'AB';
  if (splitPage) {
    const ab = aRows + bRows;
    const abc = ab + cRows;
    // Empirical budget after the headerBlock + floor-summary table + lede.
    // Phase 7F-B measurement (basement+lift+4-floor quote): with ab=9, the .pg
    // section measured 305mm — i.e. 8mm overflow that orphaned the "Continued"
    // line onto its own physical page. Tightening the AB budget to 6 forces
    // pivot='A' for any non-trivial build, which keeps section 1 well under
    // 297mm. The 'A'-only fallback is the safest default for dense quotes.
    if (ab <= 6) {
      splitPivot = 'AB';        // small total — both fit on page 1
    } else if (aRows <= 8 && (rowCount - aRows) >= 4) {
      splitPivot = 'A';          // page 1 = A only; the rest dense on page 2
    } else if (abc <= 6 && (rowCount - abc) >= 4) {
      splitPivot = 'ABC';        // rare: tiny A+B+C still fits
    } else {
      splitPivot = 'A';          // safest — A alone, even if oversized
    }
  }

  const headerBlock = `
    <div class="pg-head">
      ${logoSvg({ size:'large' })}
      <div class="breadcrumb"><span class="current">Area Calculation</span></div>
    </div>
    <div class="eyebrow">Step 1</div>
    <h1 class="section">Area Calculation</h1>
    <p class="lede">Built-up area derived from plot dimensions, coverage and the chosen build configuration. Each zone bills at a different rate (see Cost Calculation).</p>

    <div class="params-row">
      <span><b>Plot:</b> ${c.plotSqYards} sq.yd / ${niA(c.plotSqFt)} sq.ft</span>
      <span><b>Dims:</b> ${c.breadth}ft × ${c.depth}ft</span>
      <!-- Phase 7E-A Item 8: hide Coverage % and Floor Area from the cover params-row.
           Values are still in c.coverage / c.floorArea for downstream calcs. -->
      <span><b>Build:</b> ${escapeHtml(c.buildLabel)}</span>
      ${state.build.hasBasement ? '<span><b>Basement:</b> Yes</span>' : ''}
      ${state.build.hasLift ? '<span><b>Lift:</b> Yes</span>' : ''}
    </div>

    <!-- Phase 6.2 — Floor Area Summary table. 5-col matrix synthesised from
         the same calc inputs (plot/coverage/floors/basement/stilt). Rendered
         BEFORE the existing zone-by-zone tables. -->
    ${renderFloorSummaryTable(state, c)}`;

  const continuationHeader = `
    <div class="pg-head">
      ${logoSvg({ size:'large' })}
      <div class="breadcrumb"><span class="current">Area Calculation (cont.)</span></div>
    </div>
    <h1 class="section" style="margin-top:8mm;">Area Calculation <span style="color:var(--gold);font-size:0.7em;">(continued)</span></h1>`;

  if (!splitPage) {
    return `
<section class="pg">
  ${headerBlock}
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
      <tr class="sub"><td colspan="2">Total Built-up Area (excluding water tank capacity)</td><td class="r">${niA(totalArea)} sq.ft</td></tr>
    </tfoot>
  </table>
  <div class="pg-foot"><span>Area Calculation</span><span>+91 92172 63051 · info@zuildup.com</span></div>
</section>`;
  }

  // Phase 7B Item 5: split tuning — pivot is dynamic via `splitPivot`.
  // 'A'   → page1 = A; page2 = B+C+D+E
  // 'AB'  → page1 = A+B; page2 = C+D+E (legacy default)
  // 'ABC' → page1 = A+B+C; page2 = D+E
  const page1Zones = (
      splitPivot === 'A'   ? `${zoneRows('A', c.zones.A)}` :
      splitPivot === 'ABC' ? `${zoneRows('A', c.zones.A)}${zoneRows('B', c.zones.B)}${c.zones.C ? zoneRows('C', c.zones.C) : ''}` :
                             `${zoneRows('A', c.zones.A)}${zoneRows('B', c.zones.B)}`
  );
  const page2Zones = (
      splitPivot === 'A'   ? `${zoneRows('B', c.zones.B)}${c.zones.C ? zoneRows('C', c.zones.C) : ''}${zoneRows('D', c.zones.D)}${c.zones.E ? zoneRows('E', c.zones.E) : ''}` :
      splitPivot === 'ABC' ? `${zoneRows('D', c.zones.D)}${c.zones.E ? zoneRows('E', c.zones.E) : ''}` :
                             `${c.zones.C ? zoneRows('C', c.zones.C) : ''}${zoneRows('D', c.zones.D)}${c.zones.E ? zoneRows('E', c.zones.E) : ''}`
  );
  return `
<section class="pg">
  ${headerBlock}
  <table class="calc-table">
    <thead><tr><th>Area</th><th>Description</th><th class="r">Est. Size</th></tr></thead>
    <tbody>
      ${page1Zones}
    </tbody>
  </table>
  <p class="lede" style="color:var(--muted);font-size:11px;margin-top:6mm;">Continued on next page →</p>
  <div class="pg-foot"><span>Area Calculation (1/2)</span><span>+91 92172 63051 · info@zuildup.com</span></div>
</section>
<section class="pg">
  ${continuationHeader}
  <table class="calc-table">
    <thead><tr><th>Area</th><th>Description</th><th class="r">Est. Size</th></tr></thead>
    <tbody>
      ${page2Zones}
    </tbody>
    <tfoot>
      <tr class="sub"><td colspan="2">Total Built-up Area (excluding water tank capacity)</td><td class="r">${niA(totalArea)} sq.ft</td></tr>
    </tfoot>
  </table>
  <div class="pg-foot"><span>Area Calculation (2/2)</span><span>+91 92172 63051 · info@zuildup.com</span></div>
</section>`;
}

function renderCostPage(state, c) {
  // Phase 6.2 — PDF collapse rule: when per-floor balcony pricing is ON and
  // every per-floor balcony rate is numerically equal (after fallback), the
  // customer PDF collapses the N expanded rows back to a single combined
  // "Balcony" row. Editor (form list) always shows N rows; this collapse only
  // affects the printed artifact. Returns a *new* zone object with the
  // collapsed items array — never mutates the live calc result.
  const collapseBalconyForPdf = (zone) => {
    if (!zone || !zone.items) return zone;
    const balconyRows = zone.items.filter(it => it.balconyFloor != null);
    if (balconyRows.length < 2) return zone;
    const firstRate = balconyRows[0].rate;
    const allEqual = balconyRows.every(it => it.rate === firstRate);
    if (!allEqual) return zone;
    // Collapse: replace the per-floor rows with one combined row.
    const totalArea = balconyRows.reduce((s, it) => s + (it.area || 0), 0);
    const totalCost = balconyRows.reduce((s, it) => s + (it.cost || 0), 0);
    const numFloors = balconyRows.length;
    const breadth = state.build.breadth;
    const combined = {
      name: 'Balcony',
      desc: `${breadth}ft × ${BALCONY_DEPTH}ft × ${numFloors} floors`,
      area: totalArea,
      rate: firstRate,
      cost: totalCost,
    };
    const newItems = [];
    let inserted = false;
    for (const it of zone.items) {
      if (it.balconyFloor != null) {
        if (!inserted) { newItems.push(combined); inserted = true; }
        // skip the rest of the per-floor rows
      } else {
        newItems.push(it);
      }
    }
    // Recompute zone.varies based on the COLLAPSED items (so if all items now
    // match the zone default, the renderer falls into the simple flat-row path).
    let varies = false;
    for (const it of newItems) {
      if (it.rate !== zone.rate) { varies = true; break; }
    }
    return { ...zone, items: newItems, varies };
  };

  const costRow = (key, zone) => {
    if (!zone) return '';
    // PDF collapse for Zone B per-floor balcony when all rates are equal.
    if (key === 'B') zone = collapseBalconyForPdf(zone);
    const tag = `<span class="zone-tag z${key.toLowerCase()}">${key}</span>`;
    // Phase 7B Item 17: if any item has a name override, force-expand the zone
    // even when rates don't vary, so the renamed item shows up in the cost sheet.
    const hasNameOverride = (zone.items || []).some(it => {
      const orig = it.origName || it.name;
      return _itemNameOverride(state, key, orig) || _itemDescOverride(state, key, orig);
    });
    // P3 v2 (A): if zone has per-item rate overrides, expand into one row per item.
    if (zone.varies || hasNameOverride) {
      const itemRows = zone.items.map(it => `<tr class="cost-item-row"><td style="padding-left:18px;color:var(--muted);font-size:11.5px;">— ${escapeHtml(resolveItemName(state, key, it))}</td><td>${zone.unit ? ni(it.area) : niA(it.area)}${zone.unit ? ' '+zone.unit : ''}</td><td class="r">${fmtINR(it.rate)}${zone.unit ? '/'+zone.unit : '/sqft'}</td><td class="r">${fmtINR(it.cost)}</td></tr>`).join('');
      const subtitle = zone.varies ? '— per-item rates' : '';
      return `<tr class="cost-zone-hdr"><td colspan="4">${tag} Zone ${key} ${subtitle ? `<span style="color:var(--muted);font-size:11px;">${subtitle}</span>` : ''}</td></tr>${itemRows}<tr class="cost-zone-sub"><td colspan="3" style="text-align:right;color:var(--navy);font-weight:600;">Zone ${key} subtotal</td><td class="r"><b>${fmtINR(zone.cost)}</b></td></tr>`;
    }
    return `<tr><td>${tag} Zone ${key}</td><td>${zone.unit ? ni(zone.total) : niA(zone.total)}${zone.unit ? ' '+zone.unit : ''}</td><td class="r">${fmtINR(zone.rate)}${zone.unit ? '/'+zone.unit : '/sqft'}</td><td class="r">${fmtINR(zone.cost)}</td></tr>`;
  };
  // Phase 6.3 — additional zones (Elevation / GST / Custom). Single-line each,
  // dynamic letter, header label "Zone X — {Name}". Rate column shows em-dash
  // since these are flat lump sums, not per-sqft.
  const additionalRow = (z) => {
    const tag = `<span class="zone-tag z-extra">${escapeHtml(z.letter)}</span>`;
    const safeDesc = escapeHtml(z.desc || '');
    const descLine = safeDesc ? `<span style="color:var(--muted);font-size:11px;">${safeDesc}</span>` : '<span style="color:var(--muted);font-size:11px;">—</span>';
    return `<tr><td>${tag} Zone ${escapeHtml(z.letter)} — ${escapeHtml(z.name)}</td><td>${descLine}</td><td class="r">—</td><td class="r">${fmtINR(z.cost)}</td></tr>`;
  };
  return `
<section class="pg cost-calc-page">
  <div class="pg-head">
    ${logoSvg({ size:'large' })}
    <div class="breadcrumb"><span class="current">Cost Calculation</span></div>
  </div>
  <div class="eyebrow">Step 2</div>
  <h1 class="section">Cost Calculation</h1>
  <p class="lede">Each zone's area multiplied by its applicable rate. Lift cost added separately if enabled. Taxes and any liaisoning are quoted separately, outside this document.</p>

  <table class="calc-table cost-calc-table">
    <thead><tr><th>Zone</th><th>Area</th><th class="r">Rate</th><th class="r">Total</th></tr></thead>
    <tbody>
      ${costRow('A', c.zones.A)}
      ${costRow('B', c.zones.B)}
      ${c.zones.C ? costRow('C', c.zones.C) : ''}
      ${costRow('D', c.zones.D)}
      ${c.zones.E ? costRow('E', c.zones.E) : ''}
      ${(c.additionalZones || []).map(additionalRow).join('')}
      <!-- Phase 7F-B: totals moved from <tfoot> into <tbody>. tfoot would
           auto-repeat on each PDF page when the table paginates, producing
           duplicate "Sub-total / Construction Total" rows. As tbody rows
           with break-before:avoid (via .cost-totals-* classes) they stay
           glued to the last zone and appear exactly once. -->
      <tr class="sub cost-totals-sub"><td colspan="3">Sub-total (zones)</td><td class="r">${fmtINR(c.zoneSubtotal)}</td></tr>
      ${c.lift ? `<tr class="sub cost-totals-sub"><td colspan="3">Lift Machine</td><td class="r">${fmtINR(c.lift.cost)}</td></tr>` : ''}
      <tr class="grand cost-totals-grand"><td colspan="3">Construction Total</td><td class="r">${fmtINR(c.grandTotal)}</td></tr>
    </tbody>
  </table>

  <p class="lede" style="margin-top:6mm; color: var(--muted); font-size: 11px;">Final billed at actual brand and finish selection. GST and any liaisoning fees are quoted separately outside this document.</p>

  ${(state.notes && state.notes.trim()) ? `
  <div class="cost-notes-block">
    <div class="cost-notes-eyebrow">Notes &amp; Caveats</div>
    <div class="cost-notes-body">${escapeHtml(state.notes).split('\n').slice(0, 12).join('\n')}</div>
  </div>` : ''}

  <div class="pg-foot"><span>Cost Calculation</span><span>+91 92172 63051 · info@zuildup.com</span></div>
</section>`;
}

function renderSpecPages(state, sortedCats, byCat) {
  if (!sortedCats.length) {
    return `
<section class="pg">
  <div class="pg-head">${logoSvg({ size:'large' })}<div class="breadcrumb"><span class="current">Specifications</span></div></div>
  <p class="lede" style="margin-top:30mm;text-align:center;">No specifications selected. Add rows from the catalog or create custom items.</p>
  <div class="pg-foot"><span>Specifications</span><span>+91 92172 63051 · info@zuildup.com</span></div>
</section>`;
  }
  // P3 #6: branch on state.specsLayout — 'grid' (default cards) or 'table' (compact rows).
  // P3 #10: per-row rendering composes Label / Brand+Rate / Description from overrides.
  function rowFields(row, it) {
    // Phase 6.1 #11b — rate column is now rate-only; brand information migrates
    // into the description so reps can edit it inline. Backward-compat: if a saved
    // quote has `o.brand_rate` set (rep-typed free text from old UI), we display
    // that string AS-IS in the rate column. The header label has changed to
    // "Rate" — minor mislabel on legacy quotes is acceptable; rep can clean up.
    const o = row.override || {};
    const lab = o.label ?? (it ? it.label : '');
    // Rate column ("brandRate" key kept for back-compat with saved quotes).
    let brandRate = (o.brand_rate !== undefined) ? o.brand_rate : '';
    if (!brandRate) {
      const rt = (o.rate_text !== undefined) ? o.rate_text : ((it && it.rate_text) || '');
      const rate = (o.rate !== undefined) ? o.rate : 0;
      if (rt && rt.trim())     brandRate = rt;
      else if (rate > 0)        brandRate = fmtINR(rate);
      else                      brandRate = '';
    }
    // Description: if rep hasn't customised it AND the catalog item has brand
    // suggestions, prepend "Brands: …" to the catalog default. Editor reps can
    // tweak this manually per row (rich-text formatting comes in Phase 6.4).
    let desc;
    const userOverroteDesc = (o.description !== undefined && o.description !== null);
    if (userOverroteDesc) {
      desc = o.description;
    } else {
      const baseDesc = (it ? it.description : '') || '';
      const brands = (o.brands !== undefined && Array.isArray(o.brands))
        ? o.brands
        : ((it && Array.isArray(it.brands)) ? it.brands : []);
      if (brands.length) {
        const brandLine = 'Brands: ' + brands.join(' · ');
        desc = baseDesc ? (brandLine + '\n' + baseDesc) : brandLine;
      } else {
        desc = baseDesc;
      }
    }
    const loc  = o.location || '';
    // Phase 6.4 #11c: pass through richness so renderers can emit HTML
    // (sanitised) instead of escaping. Legacy/plain stays escaped.
    const descIsRich = !!o.descriptionRich;
    return { lab, brandRate, desc, loc, descIsRich };
  }

  const isTable = state.specsLayout === 'table';
  // Per-category section builder. Returns the inner HTML for one category.
  const buildCatSection = (cat) => {
    if (isTable) {
      const rowsHtml = byCat[cat].map(({row, item: it}) => {
        const f = rowFields(row, it);
        return `
          <tr>
            <td class="lab">${escapeHtml(f.lab)}${f.loc ? ' <span class="loc">— '+escapeHtml(f.loc)+'</span>' : ''}</td>
            <td class="br"><b>${escapeHtml(f.brandRate || '—')}</b></td>
            <td class="desc">${f.descIsRich ? sanitizeRichText(f.desc) : escapeHtml(f.desc)}</td>
          </tr>`;
      }).join('');
      return `
        <table class="spec-table-block">
          <thead>
            <tr class="cat-row"><th colspan="3">
              <h2>${escapeHtml(cat)}<span class="count">${byCat[cat].length} items</span></h2>
            </th></tr>
            <tr class="hdr"><th class="lab">Item</th><th class="br">Rate</th><th class="desc">Description</th></tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>`;
    }
    // Grid mode (default)
    const cardArr = byCat[cat].map(({row, item: it}) => {
      const f = rowFields(row, it);
      return `
        <div class="spec-card${f.brandRate ? '' : ' unedited'}">
          <h3 class="lab">${escapeHtml(f.lab)}${f.loc ? ' <span class="loc">— '+escapeHtml(f.loc)+'</span>' : ''}</h3>
          ${f.brandRate ? `<div class="brand-rate"><b>${escapeHtml(f.brandRate)}</b></div>` : `<span class="rate-pill set">Set details</span>`}
          <p class="desc">${f.descIsRich ? sanitizeRichText(f.desc) : escapeHtml(f.desc)}</p>
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
  };
  // Bug fix: emit one .pg per category in grid mode (clean breaks, no blank
  // pages). Table mode packs everything onto fewer pages — but each .pg now
  // has explicit overflow protection.
  const introBlock = `
    <div class="eyebrow">Step 3</div>
    <h1 class="section">Detailed Specifications</h1>
    <p class="lede">Every line item, every brand, every rate. Brand options shown are indicative; final selection confirmed at the brand-picker stage.</p>`;

  // P3 v2.2: unified single-section flow for BOTH grid and table modes.
  // Categories pack onto pages naturally — small ones share, large ones split
  // at category-block boundaries (browser paginates). No blank-space and no
  // orphan-header pages.
  const sectionsHtml = sortedCats.map(buildCatSection).join('');
  const modeClass = isTable ? 'pg-specs-table' : 'pg-specs-grid';
  return `
<section class="pg pg-specs-flow ${modeClass}">
  <div class="pg-head">
    ${logoSvg({ size:'large' })}
    <div class="breadcrumb"><span class="current">Detailed Specifications</span></div>
  </div>
  ${introBlock}
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
