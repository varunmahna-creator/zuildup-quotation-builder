# Phase 5 Work Log — Sales Team Bug Fixes

**Date:** 2026-05-02
**Owner:** Varun Mahna
**Status:** 🟢 LIVE in production
**Live URL:** https://zuildup-quotes-zim2owjloq-el.a.run.app
**Cloud Run revision:** `zuildup-quotes-00015-55t`
**Commit:** `d1ad3f6`

---

## What Was Wrong (Sales Team Reports)

1. **Concrete subsection missing** from Structure specs.
2. **Zone cost sums inaccurate** — Σ(line items) ≠ zone subtotal in many cases.
3. **Lift / staircase counts wrong** — current formula did not include the mumty stop.
4. **Area-overridden rows showed misleading descriptions** — the original formula text remained even after the area was manually overridden.

---

## Root Causes

### Issue 2 — `applyAreaOverrides` had THREE bugs (in one 30-line function!)

`scripts/build_quote_js.py` lines 537-568 (pre-fix):

| # | Bug | Effect |
|---|---|---|
| 2.1 | `let dirty = false` declared **outside** the per-zone loop | Once one zone gets an area override, the flag stayed `true` for every subsequent zone — triggering recomputes on zones the user didn't touch. |
| 2.2 | `it.cost` was never recomputed after `it.area = newArea` | Per-item cost rendered on the cost page used the stale formula-derived cost. Σ(items) shown ≠ what the engine internally used. |
| 2.3 | `z.cost = z.total * z.rate` after override | This used the **zone-default** rate, ignoring any per-item rate overrides the user had set. Sales would set Lift to ₹3,000/sqft and Balcony area to 800 — Lift's ₹3,000 silently reverted to ₹2,000. |

The combined effect: any quote that had **both** a per-item rate override AND a per-item area override would show wrong sums. Sales had been catching these mismatches manually.

### Issue 3 — `calcPackage` missed the mumty stop

```js
// before
const staircaseLevels = numFloors + (hasStilt ? 1 : 0) + (b.hasBasement ? 1 : 0);
// for Stilt+4: 4 + 1 + 0 = 5 ❌ (should be 6: S + 4 floors + mumty)

// after
const staircaseLevels = numFloors + (hasStilt ? 1 : 0) + (b.hasBasement ? 1 : 0) + 1;
// for Stilt+4: 4 + 1 + 0 + 1 = 6 ✅
```

`calcStructure` already had `+1+1` (stilt+mumty); just normalized the form to match.

### Issue 4 — descriptions not swapped

The desc strings (`"Floor Area (1620) − Lift (25) − Staircase (125)"`) were baked at compute time and never replaced when the user later overrode the area.

### Issue 1 — Concrete simply missing from catalog

The `Structure` category had Steel, Cement, Bricks but no Concrete entry. Adding one as a descriptive (rate=0) item fixed it.

---

## The Fix

### `applyAreaOverrides` — full rewrite (lines 537-587)

```js
function applyAreaOverrides(c, state) {
  const ovrs = state.areaOverrides || {};
  if (!c.zones) return;
  let anyDirty = false;
  for (const k of ['A','B','C','D','E']) {
    const z = c.zones[k];
    if (!z || !z.items) continue;
    let zoneDirty = false;                          // ← scoped per-zone
    for (const it of z.items) {
      const key = k + ':' + it.name;
      const v = ovrs[key];
      if (v != null && v !== '' && !isNaN(parseInt(v))) {
        const newArea = parseInt(v);
        it.areaOverridden = true;                   // ← flag
        it.desc = 'as per design scope';            // ← Issue 4
        if (newArea !== it.area) {
          it.area = newArea;
          it.cost = it.area * (it.rate || 0);       // ← recompute item cost
          zoneDirty = true;
        }
      }
    }
    if (zoneDirty) {
      z.total = z.items.reduce((s, x) => s + (x.area || 0), 0);
      z.cost  = z.items.reduce((s, x) => s + (x.cost  || 0), 0);   // ← respects per-item rates
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
```

### Staircase formula — unified across all 3 modes

```js
// calcPackage AND calcStructure now both use:
const staircaseLevels = numFloors + (hasStilt ? 1 : 0) + (b.hasBasement ? 1 : 0) + 1;
```

Truth table verified by `tests/test_phase5.py`:

| Build | Levels |
|---|---|
| Stilt + 4 floors | 6 |
| Basement + Stilt + 4 floors | 7 |
| Ground + 3 (4 floors, no stilt) | 5 |
| Structure mode Stilt + 4 | 6 |

### Catalog — Concrete added

`catalog/catalog.json` line 91 (between Bricks and Plinth/Floor/Stilt):
```json
{
  "id": "structure.concrete",
  "category": "structure",
  "category_label": "Structure",
  "label": "Concrete",
  "rate": 0,
  "rate_text": "",
  "unit": "descriptive",
  "brands": [],
  "scope": ["full", "structure_only"],
  "description": ""
}
```
items_total bumped 87 → 88.

---

## Tests Added (tests/test_phase5.py — 13 tests, all green)

- `test_concrete_in_structure_catalog` — Issue 1 catalog presence
- `test_staircase_stilt_4_floors`, `test_staircase_basement_stilt_4`, `test_staircase_ground_4`, `test_staircase_structure_mode`, `test_staircase_consistency_across_modes` — Issue 3 truth table
- `test_zone_invariant_baseline`, `test_zone_invariant_with_rate_override`, `test_zone_invariant_with_area_override`, `test_zone_invariant_combined_overrides`, `test_zone_invariant_multi_zone_overrides` — Issue 2 invariant: Σ(item.cost) == zone.cost; Σ(zones) == zoneSubtotal
- `test_area_override_replaces_description`, `test_non_overridden_keeps_formula_description` — Issue 4

Test harness extracts `computeQuote` from `app/quote.js` via regex-based string replacement, runs in Node with minimal browser shims, parses JSON output. No browser/CDP needed at unit level.

---

## End-to-End Verification

Both local (port 8124) and live (Cloud Run revision `zuildup-quotes-00015-55t`) PDFs verified via headless Chrome → CDP → /pdf endpoint.

Test fixture: Stilt + 4 floors, lift on, ₹2,000/sqft baseline. Per-item rate override on Lift (₹3,000/sqft). Per-item area overrides on First Floor (1,500 sqft) and Balcony (800 sqft).

**Expected vs actual on live PDF:**

| Check | Expected | Actual |
|---|---|---|
| Concrete in Structure specs | yes | ✅ |
| First Floor desc | "as per design scope" | ✅ |
| Balcony desc | "as per design scope" | ✅ |
| Other rows desc | formula text | ✅ |
| Lift area = 25 × 6 levels | 150 | ✅ |
| Staircase area = 125 × 6 | 750 | ✅ |
| Lift line cost = 150 × ₹3,000 | ₹4,50,000 | ✅ |
| First Floor cost = 1,500 × ₹2,000 | ₹30,00,000 | ✅ |
| Zone A subtotal | ₹1,22,70,000 | ✅ |
| Construction Total = Σ + lift machine | ₹1,80,53,600 | ✅ |

PDF: <http://34.80.141.244:8123/qb_phase5_live.pdf>

---

## Files Changed

```
catalog/catalog.json       +17 lines  (Concrete item, items_total bump)
scripts/build_quote_js.py  +35 lines  (applyAreaOverrides rewrite, staircase formula unify)
app/quote.js               regenerated
tests/test_phase5.py       new (271 lines, 13 tests)
PHASE5_ANALYSIS.md         new (analysis doc)
PHASE5_WORK_LOG.md         this file
```

---

## Commits

```
d1ad3f6  Phase 5: zone sum QC + lift/staircase rework + concrete section + area-override description
```

Pushed to GitHub master: <https://github.com/varunmahna-creator/zuildup-quotation-builder>

---

## Open Questions / Follow-ups

1. **Lift cost line item editability** — currently the lift machine ₹12,00,000 line is not subject to per-item rate override. If sales wants to override on a per-quote basis, we'd add it via the existing `state.pricing.liftCost` (already supported).
2. **Mumty area billing** — Issue 3 added the mumty stop to staircase/lift counts (so the stairwell and lift shaft area is billed correctly), but mumty itself is not a billable area zone. Per Varun's spec ("mumty is NOT counted as a separate area, but IS counted as a stop") this is intentional. Confirm with sales if a future request comes in to add a mumty area row.
3. **Description-replacement on per-item RATE override** — currently only AREA override swaps to "as per design scope". If sales also wants the same treatment when a row's rate is manually overridden, that's a one-line addition to `enrichZone`. Not in scope per Varun's brief.
