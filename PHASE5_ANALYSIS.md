# Phase 5 Analysis — Sales Team Bug Fixes

**Date:** 2026-05-02
**Author:** Claude (subagent task from Varun)

---

## Issue 1: Concrete subsection missing from Structure specs

### Where it lives
- `catalog/catalog.json` — defines the `items[]` array. Items grouped by `category_label`. The "Structure" category currently has 15 items: Structural Design, Steel, Cement, Bricks, Plinth/Floor/Stilt, Aggregates (Rodi), PCC, Plaster Work, Compound Wall, Parapet Wall, Curing, Waterproofing, Anti-Termite, Misc, Assumptions. **No "Concrete" item.**
- `scripts/build_quote_js.py` lines ~1066-1169: `renderSpecPages()` renders one card-per-item, grouped by `category_label`. So a "Concrete" item appears automatically once added to the catalog with `category_label: "Structure"`.

### Bug / Gap
Sales sheet wants a "Concrete" subsection under Structure. No such item exists.

### Fix plan
Add a new catalog entry inserted right after `structure.bricks`:
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
Description empty as Varun specified — sales rep can fill in via override. Card will render in `unedited` (dashed) style with "Set details" placeholder per existing renderer logic.

---

## Issue 2: Zone cost sums inaccurate (CRITICAL)

### Where it lives
- `scripts/build_quote_js.py` lines 537-568 — `applyAreaOverrides(c, state)`
- `scripts/build_quote_js.py` lines 639-654 — `enrichZone()` in `calcPackage`
- `scripts/build_quote_js.py` lines 733-747 — `enrichZone()` in `calcStructure`

### Bug analysis — THREE bugs in `applyAreaOverrides`:

```js
function applyAreaOverrides(c, state) {
  const ovrs = state.areaOverrides || {};
  if (!c.zones) return;
  let dirty = false;                          // ← BUG: declared outside zone loop
  for (const k of ['A','B','C','D','E']) {
    const z = c.zones[k];
    if (!z || !z.items) continue;
    for (const it of z.items) {
      const key = k + ':' + it.name;
      const v = ovrs[key];
      if (v != null && v !== '' && !isNaN(parseInt(v))) {
        const newArea = parseInt(v);
        if (newArea !== it.area) {
          it.area = newArea;
          dirty = true;
          // ← BUG: it.cost NOT recomputed from new area × it.rate
        }
      }
    }
    if (dirty) {                              // ← TRIGGER: dirty stays true across zones
      z.total = z.items.reduce((s, x) => s + (x.area || 0), 0);
      z.cost  = z.total * (z.rate || 0);      // ← BUG: ignores per-item rate overrides
    }
  }
```

**Bug 2.1 — `dirty` shared across zones:**
`dirty` is declared outside the `for (const k of ['A','B','C','D','E'])` loop. Once any zone gets an area override, `dirty` becomes true and stays true. So zones B, C, D, E (whatever comes after the overridden zone in iteration order) get their `z.cost` recomputed to `z.total * z.rate` — overwriting any per-item-rate variations the user set.

**Concrete scenario:** User sets Zone A "Lift" line item rate from default ₹2000/sqft to ₹3000/sqft (rate override). Then later sets Zone B "Balcony" area from auto to manual override. Now `dirty=true` after Zone B's loop. Zones C, D, E pass through `if (dirty) { ... z.cost = z.total * z.rate ... }`. They recompute correctly because they had no per-item rate override. **BUT WAIT** — by this point, Zone A was already done. And actually, looking again, the flow is: A is iterated first, no area override there → dirty stays false → Zone A cost untouched. Then Zone B gets area override → dirty=true → Zone B z.cost recomputed using zone-default rate (overwriting any per-item-rate-override on Balcony). Zones C/D/E follow with `dirty=true` → also get z.cost = z.total * z.rate, **wiping their per-item rate overrides too.**

**Bug 2.2 — `it.cost` not recomputed when area overridden:**
After `it.area = newArea`, the field `it.cost` (set by `enrichZone` to `it.area * it.rate`) is now STALE. The cost-page rendering (when `zone.varies === true`) renders per-item cost via `${fmtINR(it.cost)}`. So a row with overridden area will display old cost, even though the zone subtotal recomputes. **Σ(displayed item costs) ≠ zone subtotal in this case.**

**Bug 2.3 — `z.cost = z.total * z.rate` ignores per-item rates:**
When `zone.varies === true` (any item has rate override), zone cost is computed as `Σ(it.cost)`. After applyAreaOverrides hits this path, it overwrites with `z.total * z.rate`, which is the zone-default rate × total area, ignoring all per-item rate overrides.

### Failing test fixture (manually computed):
Build: `nostilt`, plotSqYards=240, breadth=36, coverage=75, floors=4, hasBasement=false, hasLift=true.
Pricing: costPerSqft=2000, no zone overrides, BUT Zone A "Lift" line-item rate overridden to ₹3000/sqft, AND Zone B "Balcony" area overridden to 800 sq.ft.

Expected:
- Zone A items: 4 floors × (1620 - 25 - 125) sqft = 4 × 1470 = 5880; Lift: 25 × 5 levels = 125 (NOTE: see Issue 3 — current count is 4, should be 5).
  - Floor cost (×4): 1470 × ₹2000 = ₹2,940,000 each → ₹11,760,000
  - Lift cost: 125 × ₹3000 = ₹375,000  ← **per-item rate override**
  - Zone A subtotal: ₹11,760,000 + ₹375,000 = **₹12,135,000**
- Zone B: Balcony 800 (overridden) + Staircase 125×staircaseLevels at default ₹1000/sqft.

What the current code shows after applyAreaOverrides:
- Bug 2.3 flips Zone A to: (5880 + 125) × ₹2000 = ₹12,010,000 — **₹125,000 short** because Lift's ₹3000 was overwritten by Zone A's default ₹2000.

This is the exact discrepancy sales is reporting.

### Fix plan
Rewrite `applyAreaOverrides`:
```js
function applyAreaOverrides(c, state) {
  const ovrs = state.areaOverrides || {};
  if (!c.zones) return;
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
        if (newArea !== it.area) {
          it.area = newArea;
          it.areaOverridden = true;       // flag for Issue 4
          it.cost = it.area * (it.rate || 0);  // recompute item cost
          zoneDirty = true;
        }
      }
    }
    if (zoneDirty) {
      z.total = z.items.reduce((s, x) => s + (x.area || 0), 0);
      z.cost  = z.items.reduce((s, x) => s + (x.cost  || 0), 0);  // sum item costs (respects rate overrides)
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

Also: cost-page render mismatch — currently when `zone.varies` is true the zone subtotal in the table is shown as `${fmtINR(zone.cost)}` (last cell of the `cost-zone-sub` row). After the fix this will correctly equal Σ(item costs). Lock invariant in test.

---

## Issue 3: Lift & staircase logic rework

### Where it lives
- `scripts/build_quote_js.py`:
  - Line 587 (`calcPackage`): `const staircaseLevels = numFloors + (hasStilt ? 1 : 0) + (b.hasBasement ? 1 : 0);` ❌ missing mumty
  - Line 695 (`calcStructure`): `const staircaseLevels = numFloors + 1 + (b.hasBasement ? 1 : 0) + 1;` ✅ correct (always has stilt + always +1 mumty)

### Bug
`calcPackage` formula doesn't include the mumty stop. `calcStructure` does (`+1+1` = stilt+mumty).

### Truth table from Varun:
| Build | Expected staircase levels |
|---|---|
| Stilt + 4 floors | 6 (S + 4 + mumty) |
| Basement + Stilt + 4 floors | 7 (B + S + 4 + mumty) |
| Ground + 3 (4 floors total, no stilt) | 5 (4 + mumty) |
| Basement + Ground + 3 (4 floors, no stilt) | 6 (B + 4 + mumty) |

### Unified formula
```js
const staircaseLevels = numFloors + (hasStilt ? 1 : 0) + (b.hasBasement ? 1 : 0) + 1;
//                                                                                ^^^ mumty (always)
```

For structure mode, since stilt is always present (per current code), simplify to identical formula. Lift levels = staircaseLevels (one stop per level + mumty access).

### Fix plan
1. In `calcPackage` line 587: add `+ 1` for mumty.
2. In `calcStructure` line 695: change to use `hasStilt = true` constant and same formula (already equivalent, just normalize).
3. Add unit test asserting all three configs produce expected counts.

---

## Issue 4: Area-overridden line items → generic description

### Where it lives
- Line ~592 (calcPackage) and ~702 (calcStructure): `desc` strings like `"Floor Area (1620) − Lift (25) − Staircase (125)"` are hardcoded into items at compute time.
- Render: `renderAreaPage` line ~2280 uses `${escapeHtml(it.desc)}` for every item.

### Bug
When area is overridden via `state.areaOverrides`, the original `desc` is misleading (refers to the formula that's no longer being used).

### Fix plan
1. In `applyAreaOverrides`, when `it.area = newArea`, also set `it.desc = 'as per design scope'`.
2. Set a flag `it.areaOverridden = true` so render layer can detect it (e.g. styling differently if needed).
3. Add unit test verifying that after override, `it.desc === 'as per design scope'`.

---

## Test Strategy

I'll create `tests/test_phase5.py` with a Node-based test harness using the existing `quote.js` IIFE pattern. Approach:
1. Build `quote.js` in test mode (skipping browser-only blocks) by extracting `computeQuote` + helpers into a test bundle with `module.exports`.
2. Or — simpler — use Node directly: load the file, define `localStorage`/`fetch`/`window` shims, eval, then call `computeQuote(state)`.
3. Assert:
   - `test_concrete_in_catalog`: catalog contains an item with `label == "Concrete"` and `category_label == "Structure"`.
   - `test_lift_staircase_counts`: 4 fixtures × 3 calculator modes → expected staircaseLevels.
   - `test_zone_sum_invariant`: zone subtotal == Σ(line item costs) under all override permutations (rate-only, area-only, both).
   - `test_area_override_description`: items with area override show `desc == "as per design scope"`.

---

## Files Touched (planned)

- `catalog/catalog.json` — Issue 1 (add Concrete item)
- `scripts/build_quote_js.py` — Issues 2, 3, 4
- `tests/test_phase5.py` — new tests
- `app/quote.js` — regenerated from build script

## Risk
- All changes are additive or surgical inside the calculator functions. No API/UI shape changes. Existing saved quotes deserialize fine.
- Cost-page render of `zone.varies` rows already uses `it.cost` per-item — fix to recompute `it.cost` on area override is required anyway.
