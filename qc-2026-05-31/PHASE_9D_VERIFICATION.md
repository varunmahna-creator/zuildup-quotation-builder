# Phase 9D — Verification
**Date:** 2026-05-31
**Engineer:** Iraaj 🌀 (Opus 4.7)
**Commit:** `0b2c305` — `Phase 9D: clean draft-qid state + wizard isolation + Zone E override`
**Revision:** `zuildup-quotes-00062-449` (100% traffic, deployed 2026-05-31 11:30 UTC)
**Live URL:** https://zuildup-quotes-zim2owjloq-el.a.run.app/

---

## Bugs fixed (sales team report, 2026-05-31)

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | New quote inherits previous quote's data | `loadState()` legacy fallback fired for fresh draft qids | Hard guard: draft qid + empty sessionStorage → `defaultState()` |
| 2 | Quick Build doesn't populate tier defaults cleanly | `applyWizard()` deep-cloned polluted `__qbState` | Rebuild newState from `defaultState()`; only preserve `quoteId` + `scope` |
| 3 | Zone E basement ₹2700 uneditable from wizard | Hardcoded `basementRate: 2700`; no wizard input | Added `wiz-custom-E` input; wired through `getWizValues` + `applyWizard` |
| (4) | Edits to one quote bleed into next | Same as #1 — legacy fallback hydrated next quote with prior saved data | Same fix as #1 |

---

## Three-way MD5 verification

```
quote.js:
  Working tree: c58082176a5a874d9d64363234fa6fb7
  HEAD:         c58082176a5a874d9d64363234fa6fb7
  Live:         c58082176a5a874d9d64363234fa6fb7
  → 3-way match ✅

index.html:
  Working tree: df2a3cf945100ed41634a4e5cea11d10
  HEAD:         df2a3cf945100ed41634a4e5cea11d10
  Live:         df2a3cf945100ed41634a4e5cea11d10
  → 3-way match ✅
```

## Content verification (live URL)

- `Phase 9D` markers in served `quote.js`: **8** (expected ≥ 4)
- `wiz-custom-E` input in served HTML: **1** (expected 1)
- `node --check app/quote.js` → syntax OK

## Diff summary

```
app/index.html | +2/-0
app/quote.js   | +71/-16
```

---

## Sales-team test checklist

### Test 1 — "New Quote button creates truly fresh tab"
1. Hard-reload live URL (Cmd+Shift+R).
2. Open Quick Build, enter customer "TestA", plot 200 sqyd, Mid Luxury, Apply.
3. Click **New Quote** button — opens fresh tab.
4. **Expected:** Fresh tab has NO customer name, NO plot size, NO build type carryover. Empty form.
5. Click Quick Build in fresh tab.
6. **Expected:** Wizard opens with BLANK customer name, BLANK plot size, default coverage 75%, build type stilt, floors 4 — NOT TestA's data.

### Test 2 — "Quick Build tier defaults populate cleanly"
1. In a fresh tab, open Quick Build.
2. Pick **Basic** tier → Apply.
3. **Expected after Apply:** Zone A rate = ₹2,850 (Basic), Sanitary Ware = Hindware ₹25,000.
4. Click New Quote → fresh tab.
5. In new tab open Quick Build → pick **Luxury** → Apply.
6. **Expected:** Zone A rate = Luxury tier rate from catalog, Sanitary Ware = Kohler ₹1,00,000.
7. **Critical:** No leakage of Basic tier rates / brands from the previous quote.

### Test 3 — "Zone E basement rate editable from wizard"
1. Fresh tab → Quick Build → tick **Has Basement**.
2. Expand "Advanced overrides".
3. **Expected:** New input "Zone E (basement) ₹/sqft" visible, placeholder "leave blank for tier default (2700)".
4. Enter `3000` → Apply.
5. After apply, basement rate in left rail = 3000.
6. PDF preview Zone E basement = 3000 × area.

### Test 4 — "Override on one quote doesn't bleed into next"
1. Fresh tab, Quick Build → Mid Luxury → Apply.
2. In left rail, change Zone A rate from default to 4500.
3. Save quote (with customer name).
4. Click **New Quote** → fresh tab.
5. **Expected:** Zone A rate input is BLANK (not 4500).
6. Open Quick Build → Mid Luxury → Apply.
7. **Expected:** Zone A rate = Mid Luxury tier default (not 4500).

### Test 5 — "Refining current quote: wizard still shows current data"
1. Fresh tab → manually enter customer name "RefineTest" and plot 180 sqyd.
2. Open Quick Build.
3. **Expected:** Wizard opens with name "RefineTest" and plot 180 pre-filled (because the current quote is NOT pristine).
4. This proves we didn't break the "refine current" flow.

---

## Rollback

If issues found, rollback to 9B-2:

```bash
gcloud run services update-traffic zuildup-quotes \
  --to-revisions=zuildup-quotes-00061-7xv=100 \
  --region=asia-south1 --project=zuildup-quotes
```

---

## Notes

- Legacy `localStorage.zuildup.quote.v2` + `localStorage.active_quote_id` still preserved (untouched) — no data loss, can be hand-recovered from browser dev tools if needed.
- The one-shot `_bootQid()` legacy migration still fires for pre-9B-2 users on their first post-deploy visit; it copies legacy scratch into the first draft qid (preserving in-progress work). Phase 9D's hard guard only short-circuits AFTER that migration has had its chance.
- AI Chat history continues to be stored in DOM only (per-tab implicitly).
