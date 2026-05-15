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
// 7H-B: PERMANENT — loaded quotes preserve user-edited descriptions/brands.
// Never re-apply catalog defaults on load.
// `_isFreshQuote` is true ONLY for brand-new quotes (defaultState). loadState
// returns set it to false. Render fall-throughs that auto-populate from
// catalog (description text, brand defaults, brand_rate text) MUST gate on
// `state._isFreshQuote === true || row._isFresh === true`. The per-row
// `_isFresh` flag is set true when a row is added via the catalog picker on
// an already-loaded quote, so new picks get defaults but old rows don't.
const defaultState = () => ({
  _isFreshQuote: true,
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

// 7I-migration (2026-05-13): Phase 7H-B introduced the _isFresh per-row flag.
// Quotes saved BEFORE 7H-B don't have it. Without _isFresh, the _canDefault
// render gate (line ~4616) forces desc='' on any row with an empty override —
// which is every legacy catalog-default row. Heal those rows on load: if a
// row has empty override AND no _isFresh flag, stamp _isFresh: true so it
// falls through to the catalog default. Edited rows (override.description or
// other override.* set) are left untouched — the userOverroteDesc branch
// wins for them, so 7H-B preserve-edits invariant remains intact.
function _migrateLegacyRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => {
    if (!r || typeof r !== 'object') return r;
    if (r._isFresh === true) return r; // already marked, leave alone
    const ov = r.override || {};
    const hasEdit = Object.keys(ov).some(k => {
      const v = ov[k];
      // treat undefined/null as "not edited"; treat '' as "explicit blank by user"
      return v !== undefined && v !== null;
    });
    if (hasEdit) return r; // user actually edited — preserve verbatim
    return { ...r, _isFresh: true };
  });
}

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
          // 7H-B: explicit false — this state came from a saved slot, so
          // catalog defaults must NOT be re-applied to descriptions/brands.
          _isFreshQuote: false,
          // 7I-migration: heal legacy rows missing the _isFresh flag.
          rows: _migrateLegacyRows(s.rows),
          // Issue-4 (sales fix 2026-05-13): always reset per-category UI
          // open/close state so the left-rail spec list defaults to all-
          // collapsed every time the form loads.
          _uiCatOpen: {},
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
      // 7H-B: scratch-state load also counts as "loaded" — preserve edits.
      _isFreshQuote: false,
      // 7I-migration: heal legacy rows missing the _isFresh flag.
      rows: _migrateLegacyRows(s.rows),
      // Issue-4 (sales fix 2026-05-13): reset per-category UI open/close.
      _uiCatOpen: {},
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

// 7H-D: deep-walk a state object and normalise Rs.→₹ in every string field.
// Skips internal keys (prefixed `_`) and the catalog-rebuilt items array.
// Idempotent — already-₹ text is unchanged. Mutates in-place for speed.
function _normaliseStateRupee(obj) {
  if (obj == null || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    if (k.startsWith('_')) continue;            // skip _uiCatOpen etc.
    const v = obj[k];
    if (typeof v === 'string') {
      obj[k] = normaliseRupee(v);
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (typeof v[i] === 'string') v[i] = normaliseRupee(v[i]);
        else if (v[i] && typeof v[i] === 'object') _normaliseStateRupee(v[i]);
      }
    } else if (v && typeof v === 'object') {
      _normaliseStateRupee(v);
    }
  }
}

function saveState(s) {
  // 7H-D: normalise Rs.→₹ on every save so the stored copy is canonical.
  try { _normaliseStateRupee(s); } catch(_) {}
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
// 7H-D: Rs. → ₹ normalisation. Applied:
//   1) On blur in any text input / textarea / contenteditable (in-editor)
//   2) At HTML preview + PDF render time on every text field (descriptions,
//      brands, labels, item names, notes, etc.)
//   3) On state save (via saveState wrapper) so stored data is normalised too.
//
// Matches case-insensitively: "Rs.", "Rs ", "RS.", "rs.", and bare "Rs" when
// followed by a digit or currency-ish context. Does NOT match "Mrs.", "Rsv",
// or words where "Rs" is part of a larger word (word-boundary anchored).
//
// Test cases (handled in tests/test_phase7h_rs_normalise.js):
//   "Rs. 2,500"   → "₹2,500"
//   "Rs 100/kg"   → "₹100/kg"
//   "RS.500"      → "₹500"
//   "rs. 1000"    → "₹1000"
//   "₹ 500"       → unchanged
//   "Mrs. Sharma" → unchanged
//   "Rsv"         → unchanged
//   "earn 5 Rs"   → "earn 5 ₹" (trailing Rs with leading word-boundary)
function normaliseRupee(s) {
  if (s == null) return s;
  if (typeof s !== 'string') return s;
  // Primary form: "Rs." optionally with trailing space, followed by digit / whitespace / comma.
  // Also covers "Rs " (no dot, with trailing space) when followed by a digit.
  // \bRs\.?\s? → word-boundary, "Rs", optional ".", optional single whitespace.
  // Lookahead (?=[\d.,\s]) ensures we're at a price prefix, not "Rsv" or "Rshape".
  return s.replace(/\bRs\.?\s?(?=[\d.,])/gi, '₹')
          // Trailing form: "5 Rs" → "5 ₹" (number then space then Rs at word end).
          .replace(/(\d)\s?Rs\.?\b/g, '$1 ₹');
}

// 7H-D: walk an HTML fragment string and replace Rs. → ₹ in TEXT only,
// preserving tag structure. Splits on tag boundaries, normalises non-tag
// chunks, rejoins. Lightweight + safe (no DOM dependency).
function normaliseRupeeHtml(html) {
  if (html == null) return html;
  if (typeof html !== 'string') return html;
  // Split into alternating [text, tag, text, tag, ...] segments.
  const parts = html.split(/(<[^>]*>)/);
  for (let i = 0; i < parts.length; i++) {
    // Even indexes are text; odd indexes are tags. Only transform text.
    if (i % 2 === 0) parts[i] = normaliseRupee(parts[i]);
  }
  return parts.join('');
}

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
  return cat.map(it => ({ id: it.id, override: {}, _isFresh: true }));
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
      basementItems.forEach(it => state.rows.push({ id: it.id, override: {}, _isFresh: true }));
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
          // 7H-B: auto-added basement rows are fresh — defaults can apply.
          state.rows.push({ id: it.id, override: {}, _isFresh: true });
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
    // 7H-B: PERMANENT — loaded quotes preserve user-edited descriptions/brands.
    // Never re-apply catalog defaults on load. Only fall back to catalog
    // description for fresh quotes OR rows added after load (row._isFresh).
    const canDefault = (state._isFreshQuote === true) || (row._isFresh === true);
    const label = o.label ?? (item ? item.label : '');
    const desc  = (o.description !== undefined)
      ? o.description
      : (canDefault && item ? item.description : '');
    // Phase 6.4 #11c: prepare the initial HTML for the contenteditable editor.
    // Rich descriptions are stored as sanitised HTML; legacy/plain descriptions
    // are escaped and have newlines converted to <br>.
    // 7H-A: rich if explicitly flagged OR if the source string has HTML.
    const descIsRich = !!(o.descriptionRich) || /<[a-z]/i.test(String(desc));
    const descRichInitial = descIsRich
      ? sanitizeRichText(desc)
      : escapeHtml(desc).replace(/\n/g, '<br>');
    const cat   = (o.category_label) ?? (item ? item.category_label : 'Custom');
    const loc   = o.location || '';

    // P3 #10: 3-field model — Label / Brand Name & Rate / Description.
    // Auto-populate brand_rate from catalog on first open if override has none.
    // 7H-B: PERMANENT — only auto-populate for fresh quotes or freshly-added
    // rows. Loaded quotes preserve whatever the rep had (including empty).
    let brandRate = (o.brand_rate !== undefined) ? o.brand_rate : '';
    if (brandRate === '' && item && canDefault && o.brand_rate === undefined) {
      // Compose from catalog: brands joined · rate_text or fmtINR(rate)
      const cBrands = (item.brands || []);
      const cRT = (item.rate_text || '');
      const parts = [];
      if (cBrands.length) parts.push(cBrands.join(' · '));
      if (cRT && cRT.trim()) parts.push(cRT);
      else if (item.rate > 0) parts.push(fmtINR(item.rate));
      brandRate = parts.join(' · ');
    }
    // 7H-A: separate Brand field. Pre-fills from catalog item.brands[] joined
    // with ' · ' for fresh rows. Editable. Empty = rep deliberately blanked,
    // suppressed in render. Supports bold via contenteditable + sanitizer
    // (allows <b><strong><i><em><u><br>). Saved as o.brand (HTML string).
    let brandText = (o.brand !== undefined) ? o.brand : '';
    if (brandText === '' && item && canDefault && o.brand === undefined) {
      const cBrands = (item.brands || []);
      if (cBrands.length) brandText = cBrands.join(' · ');
    }
    // If brand is stored as plain text, render it directly; if rich (saved
    // with bold markup), sanitise. Treat any string containing < as rich.
    const brandIsRich = !!o.brandRich || /<[a-z]/i.test(brandText);
    const brandRichInitial = brandIsRich
      ? sanitizeRichText(brandText)
      : escapeHtml(brandText);

    const ed = document.createElement('div');
    ed.className = 'editor';
    ed.innerHTML = `
      <div class="full"><label>Label</label><input data-f="label" value="${escapeAttr(label)}"></div>
      <div class="full"><label>Rate <span style="font-weight:400;color:var(--muted);">(rendered bold in PDF)</span></label><input data-f="brand_rate" placeholder="e.g. Rathi Steel 500FE @ ₹35,000 per bathroom" value="${escapeAttr(brandRate)}"></div>
      <div class="full">
        <label>Brand <span style="font-weight:400;color:var(--muted);">(bold above body in PDF, blank = hide)</span></label>
        <div class="rt-toolbar" role="toolbar" aria-label="Brand formatting">
          <button type="button" class="rt-btn" data-rt="bold" title="Bold (Ctrl+B)" tabindex="-1"><b>B</b></button>
          <button type="button" class="rt-btn" data-rt="italic" title="Italic" tabindex="-1"><i>I</i></button>
        </div>
        <div data-f="brand" class="rt-editor" contenteditable="true" role="textbox" spellcheck="true" style="min-height:34px;">${brandRichInitial}</div>
      </div>
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
    if (canDefault && (o.brand_rate === undefined) && brandRate) { // 7H-B
      state.rows[idx].override ??= {};
      state.rows[idx].override.brand_rate = brandRate;
      saveState(state);
    }
    ed.addEventListener('input', e => {
      const f = e.target.dataset.f;
      if (!f) return;
      state.rows[idx].override ??= {};
      if (f === 'brand' && e.target.classList.contains('rt-editor')) {
        // 7H-A: brand field — store sanitised HTML (preserves bold).
        state.rows[idx].override.brand = sanitizeRichText(e.target.innerHTML);
        state.rows[idx].override.brandRich = true;
      } else if (f === 'description' && e.target.classList.contains('rt-editor')) {
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
          // 7H-B: mark freshly-added rows so catalog defaults still apply to
          // them even if the parent quote was loaded from save.
          state.rows.push({ id: it.id, override: {}, _isFresh: true });
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

  // 7H-D: global Rs. → ₹ normaliser on blur. Captures EVERY text input,
  // textarea, and contenteditable in the page (including the dynamically-
  // mounted spec editor and area-override panel rows). Fires on blur so we
  // don't fight the rep mid-keystroke — only after they leave the field.
  // The transform is idempotent (already-₹ text is unchanged) so re-applying
  // is safe.
  document.addEventListener('blur', (ev) => {
    const t = ev.target;
    if (!t) return;
    if (t.tagName === 'INPUT' && (t.type === 'text' || t.type === '' || !t.type)) {
      const before = t.value;
      const after  = normaliseRupee(before);
      if (after !== before) {
        t.value = after;
        // Trigger an input event so the bound handler re-persists to state.
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (t.tagName === 'TEXTAREA') {
      const before = t.value;
      const after  = normaliseRupee(before);
      if (after !== before) {
        t.value = after;
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (t.isContentEditable) {
      const before = t.innerHTML;
      const after  = normaliseRupeeHtml(before);
      if (after !== before) {
        t.innerHTML = after;
        // contenteditable bound handlers listen on 'input', dispatch it.
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }, true); // capture phase — fires before the field's own blur listeners
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
  // 7H-D: final Rs. → ₹ normalisation across the entire rendered quote
  // (HTML preview and the PDF that's printed from it). normaliseRupeeHtml
  // walks text nodes only — never tags/attrs — so CSS classes, styles, and
  // base64-encoded font data are untouched.
  html = normaliseRupeeHtml(html);
  return html;
}

function quoteCss() {
  return `
<style>
  /* Phase 7O (2026-05-15): fonts served over HTTP (/fonts/*.var.woff2) instead of
     inline base64 data URIs. Chrome rejects Inter's b64 data URI with
     net::ERR_INVALID_URL (likely data-URL ceiling). HTTP serving bypasses that
     bug entirely. PDF renderer injects <base href="http://127.0.0.1:PORT/">
     in <head> so these relative URLs resolve during page.setContent. */
@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('/fonts/Fraunces.var.woff2') format('woff2-variations');
}
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('/fonts/Inter.var.woff2') format('woff2-variations');
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
  /* Issue-2 (sales fix 2026-05-13): full-page-width divider directly under
     the "Detailed Specifications" h1, spanning content margin to content
     margin (the .pg has 20mm side padding so 100% spans page-content area). */
  .pg.pg-specs-flow h1.section { padding-bottom: 4mm; border-bottom: 1px solid var(--rule); width: 100%; margin-bottom: 5mm; }
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
  /* Issue-5 (sales fix 2026-05-13): cost calculation MUST fit on a single
     A4 page. Compact font + tighter padding + lock notes height. */
  .cost-calc-page { padding-top: 18mm; padding-bottom: 14mm; }
  .cost-calc-page h1.section { font-size: 26px; margin-bottom: 3mm; }
  .cost-calc-page p.lede { font-size: 11px; margin-bottom: 4mm; line-height: 1.5; }
  .cost-calc-table { font-size: 10.5px; margin-bottom: 4mm; }
  .cost-calc-table thead th { padding: 5px 8px; font-size: 10px; }
  .cost-calc-table tbody td { padding: 4px 8px; }
  .cost-calc-table tbody tr.zone-hdr td { padding: 5px 8px; font-size: 11px; }
  .cost-calc-table tbody tr.cost-zone-hdr td { padding: 5px 8px; }
  .cost-calc-table tbody tr.cost-item-row td { padding: 3px 8px; font-size: 10.5px; }
  .cost-calc-table tbody tr.cost-zone-sub td { padding: 4px 8px; }
  .cost-calc-table tbody tr.cost-totals-sub td   { padding: 6px 8px; font-size: 10.5px; }
  .cost-calc-table tbody tr.cost-totals-grand td { padding: 7px 8px; font-size: 12px; }
  .cost-calc-page .cost-notes-block { margin-top: 3mm; padding: 3mm 4mm; max-height: 22mm; }
  .cost-calc-page .cost-notes-body { font-size: 9.5px; line-height: 1.4; }
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
  /* 7H-A: separate brand line (rendered bold above body, both layouts). */
  .spec-card .spec-brand, .spec-table-block .spec-brand { font-size: 10.5px; color: var(--navy); font-weight: 600; margin: 2px 0 1px; line-height: 1.4; }
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
  // Phase 7P (2026-05-15): removed duplicate "Plot Area — X Sq.Yard / Y Sq.Ft."
  // subtitle line; the same info is already shown in the metrics row above.
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
    // 7H-B: only fall back to catalog defaults for fresh quotes or freshly-
    // added rows. Loaded quotes preserve user-edited descriptions verbatim,
    // including the absence of a description (renders empty).
    const _canDefault = (state._isFreshQuote === true) || (row._isFresh === true);
    if (userOverroteDesc) {
      desc = o.description;
    } else if (!_canDefault) {
      desc = '';  // 7H-B: loaded quote, no override → render empty, NOT catalog.
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
    // 7H-A: catalog descriptions can also contain <b>/<br> markup — auto-
    // detect by presence of a tag-like sequence and treat as rich.
    const descIsRich = !!o.descriptionRich || /<[a-z]/i.test(String(desc));
    // 7H-A: separate brand field. Pre-fills from catalog brands[] for fresh
    // rows. Empty = rep blanked → suppress. brandIsRich = stored as HTML
    // (with possible <b>/<i>) — sanitise on render. Plain text → escape.
    let brand = '';
    if (o.brand !== undefined) {
      brand = o.brand || '';
    } else if (_canDefault && it && Array.isArray(it.brands) && it.brands.length) {
      brand = it.brands.join(' · ');
    }
    // Issue-8 (sales fix 2026-05-13): when the rep clears a previously-set
    // brand the contenteditable leaves residue like '<br>', '&nbsp;', or
    // bare whitespace. Treat any brand whose plain-text strip is empty as
    // "no brand" so the renderer collapses the brand line entirely.
    if (brand && !String(brand).replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim()) {
      brand = '';
    }
    const brandIsRich = !!o.brandRich || /<[a-z]/i.test(brand);
    // 7H-A: de-dup. If brand text (plain) matches the first line of body
    // (plain text, after stripping HTML tags / whitespace / bold markers),
    // skip that first line in the rendered description. Case-insensitive.
    let descForRender = desc;
    const brandPlain = String(brand).replace(/<[^>]+>/g, '').trim().toLowerCase();
    if (brandPlain) {
      // Split body into lines (rich = on <br> or </p>; plain = on \n).
      if (descIsRich) {
        // Split on <br> tags into segments; first non-empty segment is first line.
        const segs = String(desc).split(/<br\s*\/?>/i);
        if (segs.length) {
          const firstPlain = segs[0].replace(/<[^>]+>/g, '').trim().toLowerCase();
          if (firstPlain === brandPlain) {
            descForRender = segs.slice(1).join('<br>');
            // Trim leading <br>s if any.
            descForRender = descForRender.replace(/^(\s*<br\s*\/?>\s*)+/i, '');
          }
        }
      } else {
        const lines = String(desc).split(/\n/);
        if (lines.length && lines[0].trim().toLowerCase() === brandPlain) {
          descForRender = lines.slice(1).join('\n').replace(/^\n+/, '');
        }
      }
    }
    return { lab, brandRate, brand, brandIsRich, desc: descForRender, loc, descIsRich };
  }

  const isTable = state.specsLayout === 'table';
  // Per-category section builder. Returns the inner HTML for one category.
  const buildCatSection = (cat) => {
    if (isTable) {
      const rowsHtml = byCat[cat].map(({row, item: it}) => {
        const f = rowFields(row, it);
        // 7H-A: brand line (bold) renders above body when present.
        const brandHtml = f.brand
          ? `<div class="spec-brand"><b>${f.brandIsRich ? sanitizeRichText(f.brand) : escapeHtml(f.brand)}</b></div>`
          : '';
        const bodyHtml = f.descIsRich ? sanitizeRichText(f.desc) : escapeHtml(f.desc);
        return `
          <tr>
            <td class="lab">${escapeHtml(f.lab)}${f.loc ? ' <span class="loc">— '+escapeHtml(f.loc)+'</span>' : ''}</td>
            <td class="br"><b>${escapeHtml(f.brandRate || '—')}</b></td>
            <td class="desc">${brandHtml}${bodyHtml}</td>
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
      // 7H-A: brand line (bold) above the body in spec cards too.
      const brandHtml = f.brand
        ? `<div class="spec-brand"><b>${f.brandIsRich ? sanitizeRichText(f.brand) : escapeHtml(f.brand)}</b></div>`
        : '';
      const bodyHtml = f.descIsRich ? sanitizeRichText(f.desc) : escapeHtml(f.desc);
      return `
        <div class="spec-card${f.brandRate ? '' : ' unedited'}">
          <h3 class="lab">${escapeHtml(f.lab)}${f.loc ? ' <span class="loc">— '+escapeHtml(f.loc)+'</span>' : ''}</h3>
          ${f.brandRate ? `<div class="brand-rate"><b>${escapeHtml(f.brandRate)}</b></div>` : `<span class="rate-pill set">Set details</span>`}
          ${brandHtml}
          <p class="desc">${bodyHtml}</p>
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
