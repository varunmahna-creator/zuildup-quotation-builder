# Phase 9E — Verification
**Date:** 2026-06-01
**Engineer:** Iraaj 🌀 (Opus 4.7)
**Commit:** `7ca9a3a` — `Phase 9E: enforce golden rule — new quote = freshly calculated areas`
**Live revision:** `zuildup-quotes-00064-dtn` (100% traffic, deployed 2026-06-01 09:01 UTC, traffic flipped 09:04 UTC)
**Live URL:** https://zuildup-quotes-zim2owjloq-el.a.run.app/

---

## Golden rule (Varun directive, 2026-06-01)

> If I am loading a quote on which I had already worked and pressed save, it should open with the last version which I saved to. For any new quote — it should be picked from the sample quotes I shared (floor area to be calculated on actual details provided).

**Contract:**

1. **Loading a saved quote (`ZUI-YYYY-NNNN`)** → restore exact state at save time. All overrides preserved.
2. **New quote** (New Quote button / fresh tab / Quick Build apply) → state must be:
   - Customer / build / scope: from wizard inputs or blank
   - Floor areas, zone areas: **freshly calculated by the calc engine** from `(plotSqYards, breadth, coverage, floors, buildType, hasLift, hasBasement)`
   - Descriptions / brands / rates: from selected tier in `catalog.tiered.json` (Basic / Mid Luxury / Luxury)
   - All override containers: **EMPTY**

---

## What 9E adds on top of 9D

- Wizard apply now explicitly zeros: `areaOverrides`, `floorSummaryOverrides`, `itemRates`, `itemNameOverrides`, `itemDescOverrides`, `zoneLineItems`, `additionalZones.custom`, `balconyPerFloor.rates+enabled`
- Legacy migration during `_bootQid()` also purges those containers before persisting to sessionStorage
- New UI: per-zone **"Reset to calculated"** button + global **"N manual overrides active — Reset all"** banner

---

## Three-way MD5 verification

```
quote.js:
  Working tree: 01945c92c2ea264f6011750806e208ee
  HEAD:         01945c92c2ea264f6011750806e208ee
  Live:         01945c92c2ea264f6011750806e208ee
  → 3-way match ✅

Phase 9E markers in live JS: 5
Phase 9D markers in live JS: 8 (preserved)
"GOLDEN RULE" marker: 1
"Reset to calculated" marker: 3 (per-zone btn + banner + tooltip)
wiz-custom-E input in live HTML: 1 (preserved from 9D)
```

---

## Sales-team test checklist

**Before any test:** Hard-reload (Cmd+Shift+R) to clear cached JS from rollback period.

### Test 1 — Quick Build with golden rule (THE KEY TEST)
1. Open live URL in fresh tab
2. Click Quick Build → enter:
   - Plot: 250 sqyd
   - Breadth: 30 ft
   - Coverage: 75%
   - Stilt + 4 floors
   - No basement
   - Tier: Mid Luxury
3. Click Apply
4. **Expected:**
   - Floor footprint = 250 × 9 × 75% = **1687.5 sqft per floor**
   - Each floor row in Floor Summary = derived from this minus staircase 125 (and minus lift 25 if enabled)
   - Area Overrides panel shows the SAME numbers
   - **NO "manual area overrides active" banner**
   - All zone rates from Mid Luxury tier in `catalog.tiered.json`

### Test 2 — New Quote isolation
1. After Test 1, type 999 in Ground Floor area override → save quote with name "TestA"
2. Click **New Quote** → fresh tab
3. Quick Build → Luxury → Plot 300 → breadth 40 → Apply
4. **Expected:**
   - All areas computed from Plot 300, breadth 40, coverage 75%
   - Floor footprint = 300 × 9 × 75% = 2025 sqft
   - **Zero leak** from TestA's 999 override
   - No banner

### Test 3 — Saved quote preserves manual overrides
1. Click **Load** → pick "TestA"
2. **Expected:**
   - Plot 250 restored
   - Ground Floor area override = 999 (preserved)
   - Banner: "1 manual area override active — Reset all to calculated"

### Test 4 — Reset buttons work
1. With "TestA" loaded, click the per-zone "Reset to calculated" link next to Zone A → confirm
2. **Expected:** 999 override cleared, Ground Floor reverts to calculated value
3. Add 3 more overrides
4. Click "Reset all to calculated" in banner → confirm
5. **Expected:** All wiped, banner disappears

---

## What to send me if a test fails

Screenshot showing:
1. URL bar (so I can read the qid)
2. The wrong area value
3. Area Overrides panel (banner + values)
4. Build inputs (Plot/Breadth/Coverage/Floors)

That gives me everything to debug without another deploy.

---

## Rollback (emergency only)

```bash
gcloud run services update-traffic zuildup-quotes \
  --to-revisions=zuildup-quotes-00061-7xv=100 \
  --region=asia-south1 --project=zuildup-quotes
```

`00061-7xv` is pre-9D / pre-9E (HAS THE BUG — emergency fallback only).

---

## Code change summary

```
app/quote.js | +117 / -3
```

- `applyWizard()` — purge 8 override containers after `defaultState()` rebuild
- `_bootQid()` — parse legacy state during migration, purge same containers
- `renderAreaOverridesPanel()` — show banner when overrides active
- `renderAreaOverridesPanel()` — per-zone "Reset to calculated" button
- Event wiring for both Reset paths

Syntax: `node --check` ✅
GitHub: pushed to `origin/master` at `7ca9a3a` ✅
