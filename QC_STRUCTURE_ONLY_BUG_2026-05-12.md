# QC — Structure-Only Blank Description/Rate Bug (2026-05-12)

**Reporter:** Varun
**Symptom:** "the description/rate is coming blank in the right side for structure only quote"
**Investigated:** 2026-05-12 (iraaj QC subagent)
**Live revision audited:** `zuildup-quotes-00039-tbk`
**Live MD5 == HEAD MD5:** `1281c80bc344bc350fcd55fc8c6bdf6c` ✅
**Code-freeze posture:** Investigation only — no commit / no deploy.

---

## 1. Bug Repro (code path)

The right-side preview is the HTML produced by `renderSpecPages()` (lines 4580+ of `app/quote.js`). Each row is composed in `rowFields(row, it)` (line 4591). Two independent failures combine to produce a blank Description + Rate for a Structure-Only quote:

### 1a. Description goes blank — the `_canDefault` gate (Phase 7H-B) fires

```js
// app/quote.js:4616
const _canDefault = (state._isFreshQuote === true) || (row._isFresh === true);
...
if (userOverroteDesc) {
  desc = o.description;
} else if (!_canDefault) {
  desc = '';                            // ← loaded quote, no override → empty
} else {
  /* catalog fallback (item.description + brands) */
}
```

And similarly for `brand`:

```js
// app/quote.js:4644
let brand = '';
if (o.brand !== undefined)            { brand = o.brand || ''; }
else if (_canDefault && it && Array.isArray(it.brands) && it.brands.length) {
  brand = it.brands.join(' · ');
}
```

For Description to fall through to the catalog default, **either**
`state._isFreshQuote === true` **or** the per-row `row._isFresh === true` must hold.

### 1b. Rate column is also blank — catalog has no `rate_text` for structure_only items

`rowFields` rate logic (lines 4598-4608):
```js
let brandRate = (o.brand_rate !== undefined) ? o.brand_rate : '';
if (!brandRate) {
  const rt   = (o.rate_text !== undefined) ? o.rate_text : ((it && it.rate_text) || '');
  const rate = (o.rate !== undefined) ? o.rate : 0;
  if (rt && rt.trim())     brandRate = rt;
  else if (rate > 0)        brandRate = fmtINR(rate);
  else                      brandRate = '';
}
```

Catalog inspection (`catalog/catalog.json`, 28 structure_only items):
- `rate_text` is empty / whitespace on **25 of 28** items
- `rate` is unset / 0 on all of them (structure rate is global `state.pricing.structureRate`, not per-line)

So `brandRate` collapses to `''` and renders as `—` (the empty-fallback in the table cell). **This is by design** for structure-only (the rate is a single ₹/sqft applied to the whole structure) — but combined with 1a it makes the row look fully blank.

### Why structure_only suffers more than full

In a **full-package** quote a sales rep typically edits descriptions and the rate column reflects each zone's ₹/sqft. The `_canDefault=false` gate is fine because reps' overrides survive verbatim.

In a **structure-only** quote almost every spec row is "accept catalog default + sign off" — reps rarely override descriptions because the structure items (steel, cement, concrete, foundation grade…) are largely standard. So `override.description` is unset for most rows, `_isFresh` is unset (because `defaultRowsFor()` returns rows without that flag), and after the first save+reload `_isFreshQuote=false`. **Net effect: 25+ rows render with blank desc AND blank rate.**

### Concrete reproduction steps

1. Open live URL fresh (no quote in localStorage). `loadState()` returns `defaultState()` → `_isFreshQuote: true`, `scope: 'full'`, `rows: []`.
2. `bootForm` first-load seed (line 1556) runs `state.rows = defaultRowsFor(state.scope, ...)`. These rows are `{ id, override: {} }` — **no `_isFresh` flag**.
3. User toggles scope to `Structure Only` (or sets `build.buildType = 'structure'`, which auto-flips scope at line 1779). Handler does `state.rows = defaultRowsFor('structure_only')`. Still no `_isFresh`. `_isFreshQuote` is still `true`. Render works on this in-memory state ✅.
4. `flush()` → `saveState(state)` writes the state (including `_isFreshQuote: true`) to localStorage.
5. **Reload the page.** `loadState()` reads back the state, then explicitly sets `_isFreshQuote: false` (lines 169 and 224). Now all rows have `override = {}` and no `_isFresh`. `_canDefault === false` → `rowFields` returns `desc = ''` for every row. Rate stays empty because the catalog has no `rate_text` for structure items.
6. Right-side preview: all 28 structure rows show blank Description and `—` Rate.

### Affected code locations (no-fresh rows added by `defaultRowsFor`)

`defaultRowsFor` is invoked from 5 sites — none of them stamp `_isFresh: true`:

| Line | Caller |
|------|--------|
| 1556 | `bootForm` first-load seed |
| 1780 | `f-build-type.onchange` → `buildType === 'structure'` auto-flip |
| 1955 | scope toggle button |
| 1962 | "Reset to defaults" button |
| 3639 | (separate "reset specs" code path) |

All five share the same defect class.

---

## 2. Root Cause (one line)

`defaultRowsFor()` returns rows without `_isFresh: true`; combined with `loadState()` always forcing `_isFreshQuote = false`, the very next page-load makes every catalog-default Description render as blank (and structure-only rows additionally have no `rate_text` in the catalog, so the Rate column also looks empty).

---

## 3. Proposed Fix (DO NOT APPLY — describe only)

### Minimal patch (one-liner; safest)

Change `defaultRowsFor` (line ~915):

```js
// Before
return cat.map(it => ({ id: it.id, override: {} }));

// After
return cat.map(it => ({ id: it.id, override: {}, _isFresh: true }));
```

**Rationale:**
- Rows produced by `defaultRowsFor` are by definition fresh catalog seeds — they should fall through to catalog defaults until the user explicitly edits them, regardless of whether the surrounding quote is fresh or loaded.
- Matches the pattern already used at lines 1568, 2982, 3477 where every other "added by us" row gets `_isFresh: true`.
- Once the user edits a row, `override.description` (or `override.brand`) is set and the `userOverroteDesc` branch wins — so `_isFresh: true` is harmless on edited rows.
- This is `_isFresh`, NOT `_isFreshQuote`, so the Phase 7H-B invariant ("loaded quote does not silently revert edited descriptions") is preserved: any row that the user previously customised has `override.description !== undefined` and the override branch takes precedence over the catalog-default branch.

### Side-effect to consider

After this fix, a user who explicitly **clears** a description on a structure-only row (typing nothing into the body editor → stored as `override.description = ''`) will see the empty string render, NOT the catalog default — same as today, no regression.

### Tests to add

- New JS unit test: assert `defaultRowsFor('structure_only')` rows all have `_isFresh === true`.
- Render-path test (extend `test_phase6_4.py` or `test_phase7h.js`): with `state._isFreshQuote=false` and a row `{id, override:{}, _isFresh:true}`, the rendered description must equal the catalog `item.description`.

### Out of scope of the minimal patch (but flag)

- Structure-only Rate column staying empty is **arguably correct** because there is no per-item rate in structure mode. If sales wants something to show, the fix is at the **renderer** level: render `state.pricing.structureRate ? fmtINR(state.pricing.structureRate) + '/sqft' : '—'` for structure_only rows. This is a UX call, not a regression — flag to Varun separately.

---

## 4. QC Results

| Check | Status | Detail |
|------|--------|--------|
| 7H-A — Brand box (`data-f="brand"`) editor | ✅ PASS | line 3194 — `<div data-f="brand" class="rt-editor" contenteditable="true">` |
| 7H-A — Brand de-dup in renderer | ✅ PASS | lines 4660-4670 — strip-tags + first-line compare both grid and table |
| 7H-A — Brand suppression (empty = no line) | ✅ PASS | both render templates gate on `f.brand ? <…> : ''` |
| 7H-B — `_isFreshQuote: true` in `defaultState()` | ✅ PASS | line 54 |
| 7H-B — `_isFreshQuote: false` in `loadState()` (both paths) | ✅ PASS | lines 169 (named-slot) + 224 (scratch) |
| 7H-B — `_isFresh: true` on catalog-picker pushes | ✅ PASS | lines 1568, 2982, 3477 |
| 7H-B — `_canDefault` gates in both render + editor | ✅ PASS | lines 3136 (editor) + 4616 (render) |
| 7H-C — `defaultState().specsLayout === 'table'` | ✅ PASS | line 143 |
| 7H-D — `normaliseRupee` + `normaliseRupeeHtml` helpers | ✅ PASS | lines 855, 870 |
| 7H-D — Called on save (state walker) | ✅ PASS | `_normaliseStateRupee` invoked at top of `saveState` (line 305) |
| 7H-D — Called on HTML preview render | ✅ PASS | line 3694 |
| **Python pytest** (excluding `test_catalog_fidelity.py`) | ✅ **174 passed** | run took 13.0s |
| **JS unit test** `node tests/test_phase7h.js` | ✅ **24 passed, 0 failed** | all Rs→₹ + brand checks green |
| **MD5 parity LIVE vs HEAD** | ✅ **MATCH** | `1281c80bc344bc350fcd55fc8c6bdf6c` on both |
| Obvious JS regressions (syntax / unclosed blocks) | ✅ Clean | (unit-test green + MD5 parity — no static-analysis tool run in this pass) |

---

## 5. Open Items / Risks

1. **Existing localStorage-stored structure-only quotes** still have rows with `override: {}` and no `_isFresh`. The proposed fix only helps **newly-seeded** rows (after the fix is deployed) — quotes saved before the fix will continue to render blank until the user re-seeds via the "Reset to defaults" button, or until a one-shot migration runs in `loadState` ("if row has empty override AND no `_isFresh`, set `_isFresh: true` for catalog-known ids"). Probably worth pairing the fix with a one-line migration in `loadState`. Flag to Varun.

2. **Rate column still says `—`** for every structure-only row after the description fix lands. Sales may or may not consider that a bug. See §3 "Out of scope" note.

3. **Visual QC pending** — no puppeteer in subagent toolset; structural / MD5 / unit checks all green but live-browser eyes on `https://zuildup-quotes-zim2owjloq-el.a.run.app/` would lock the confirmation.

4. **Carried-forward items** from PHASE_7H doc (still relevant, NOT this bug):
   - FAR API closure-scope bug (7G-C)
   - Mismatched title/customer_name on historical Load-modal entries (7G-A bug #8)
   - Catalog HTML conversion is still incremental (only Steel migrated)

---

## 6. Recommended next action (for Varun)

Apply the one-line `defaultRowsFor` patch + (optionally) the `loadState` migration for historical quotes. After CODE FREEZE lifts:
- Patch `defaultRowsFor` to stamp `_isFresh: true`.
- Add render/unit tests covering the structure_only + reload scenario.
- Decide on the Rate-column UX for structure_only quotes (separate ticket).
- Re-deploy + MD5-parity-confirm.

— iraaj QC subagent, 2026-05-12.
