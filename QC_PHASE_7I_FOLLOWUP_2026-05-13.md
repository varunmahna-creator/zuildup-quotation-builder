# QC Phase 7I Followup — Structure-only "still blank" investigation

**Date:** 2026-05-13
**Investigator:** subagent `deep-investigate` (depth 1)
**Trigger:** Varun reported that even after "Phase 7I ship", a new structure-only quote still renders blank Description/Rate on the right-side preview.

---

## TL;DR

**Phase 7I was never deployed. The "shipped" claim was wrong.**

- Local working tree has a 1-line edit on `app/quote.js:914` that stamps `_isFresh: true` on rows returned by `defaultRowsFor()`.
- That edit is **uncommitted** (`git status` → "modified: app/quote.js"; no Phase 7I commit in `git log`).
- No `PHASE_7I_2026-05-13.md` doc exists on disk.
- The "deployed revision" referenced in the task (`zuildup-quotes-00040-tlj`) **does not exist**. Cloud Run lists `zuildup-quotes-00039-tbk` as the latest active revision, deployed 2026-05-12T18:31Z (Phase 7H).
- MD5 of served `/app/quote.js` = `1281c80bc344bc350fcd55fc8c6bdf6c` = MD5 of `git show HEAD:app/quote.js`. The "MD5 parity" claim in the brief was true but compared the wrong files (live = HEAD, not live = working tree).

The proposed Phase 7I fix itself is **architecturally correct** and, once deployed, will resolve the new-quote / scope-toggle / reset-to-defaults blank-desc bug. It does **not** retroactively fix existing localStorage quotes from yesterday's testing (by design — those rows have already gone through save+reload and lost the chance to be marked `_isFresh`).

---

## 1. What we know (verified facts)

| Check | Result |
|---|---|
| MD5 of live `/app/quote.js` | `1281c80bc344bc350fcd55fc8c6bdf6c` |
| MD5 of local working tree `app/quote.js` | `6804e226ce4e687e476110aab3ffe1ee` |
| MD5 of `git show HEAD:app/quote.js` | `1281c80bc344bc350fcd55fc8c6bdf6c` |
| `git log` HEAD | `6849c51 docs: Phase 7H consolidated session record` |
| `git status` | `modified: app/quote.js` (uncommitted) |
| `git diff app/quote.js` | Single hunk at line 914: adds `, _isFresh: true` to the row literal in `defaultRowsFor()` |
| Cloud Run latest revision | `zuildup-quotes-00039-tbk` (created 2026-05-12T18:31:33Z) — **not 00040-tlj** |
| `PHASE_7I_2026-05-13.md` on disk | does **not** exist |
| `tests/test_structure_only_default.js` on disk | exists, ID-stamped "Phase 7I unit tests" |
| Test against local file with CATALOG stub | 28/28 structure_only rows have `_isFresh: true` ✓ |
| Test against live `/app/quote.js` | 0/28 structure_only rows have `_isFresh: true` ✗ |
| Catalog `items` count, scope=structure_only | 28 |
| Of those, items with non-empty `description` | 28 / 28 |
| Of those, items with `rate > 0` | 0 / 28 |
| Of those, items with non-empty `rate_text` | 3 / 28 |
| Of those, items with non-empty `brands[]` | 8 / 28 |

**Live JS render logic (verified, line numbers below from served file):**
- L54: `defaultState() → _isFreshQuote: true, rows: []`
- L169 / L224: `loadState()` always forces `_isFreshQuote: false` on the returned object
- L1556: `bootForm` first-load — if `state.rows.length === 0`, seeds via `defaultRowsFor(state.scope, …)`
- L914 (live): `return cat.map(it => ({ id: it.id, override: {} }));` — **no `_isFresh` stamp**
- L1568 / L2982 / L3477: other call sites that build rows DO stamp `_isFresh: true` (e.g. catalog picker, basement auto-add, custom add)
- L4616 inside `rowFields`: `const _canDefault = (state._isFreshQuote === true) || (row._isFresh === true);` — Phase 7H-B gate
- L4622–4625: `if (!_canDefault) desc = '';` — blank-desc branch (this is what Varun sees)
- L4666–4669: same gate also drops the brand default for non-canDefault rows

---

## 2. What we proved wrong

The premise of the task brief itself, namely that:
- (a) Phase 7I commit `28617e7` was made,
- (b) revision `zuildup-quotes-00040-tlj` was deployed,
- (c) the served file contains `_isFresh: true` 5×,

is **all false**. None of these happened. The brief was assembled from a model of the world that doesn't match reality. Concretely:

- No commit `28617e7` in `git log`.
- No revision `00040-tlj` in `gcloud run revisions list`.
- `_isFresh` appears in the **served** file but only at the 3 pre-existing call sites and the 2 comment lines — **not** in `defaultRowsFor`. (Grep'd: 7 occurrences in live, 8 in local; the extra 1 is the new stamp.)

I did **not** disprove the underlying RCA. Yesterday's RCA in `QC_STRUCTURE_ONLY_BUG_2026-05-12.md` is correct: `defaultRowsFor` produces rows without `_isFresh`, so after save+reload the `_canDefault` gate denies them the catalog-default description.

---

## 3. What we proved right (real root cause)

**Root cause:** Exactly the one yesterday's RCA identified. `defaultRowsFor` (live file line 914) returns rows without `_isFresh: true`. After the first auto-save and any reload, `state._isFreshQuote` is forced to `false` (line 169 / 224), and the per-row `_isFresh` check fails, so `_canDefault === false` → `desc = ''` → blank Description in the right-side preview.

**Why "new quote" still shows blank after a moment:**
1. User clicks New Quote → `localStorage.removeItem(STORE_KEY); location.reload()`.
2. `loadState()` finds no slot → returns `defaultState()` with `_isFreshQuote: true`.
3. `bootForm` sees `state.rows.length === 0`, calls `defaultRowsFor(scope, …)` → 28 rows with no `_isFresh`. **In memory** `_isFreshQuote` is still `true`, so the very first render works.
4. `bootForm` then calls `saveState(state)` (L1557). The state — including `_isFreshQuote: true` — gets persisted to localStorage.
5. The rep edits anything (or the page reloads for any reason). `loadState()` finds the slot and returns it with `_isFreshQuote: false` (the field is unconditionally overridden on load). Rows still have no `_isFresh`.
6. Render now hits `!_canDefault` → blank desc on every row.

**Why Rate column is blank (and that's a separate, expected condition):**
- 25 of 28 structure_only catalog items have `rate: 0` and `rate_text: ''`.
- In `rowFields` (L4604–4612), if there's no override, no `rate_text`, and `rate <= 0`, `brandRate = ''`, and the table cell renders as `<b>—</b>`.
- This is by design (yesterday's RCA noted it). It is **not** the same bug as Description. If Varun wants per-row rates for structure_only, that's a content/catalog decision, not a render bug.

**Live reproduction:** I exercised `defaultRowsFor('structure_only')` from the live JS in a Node harness with the real catalog. Result: 28 rows, all without `_isFresh`. Then exercised the local-edited file: 28 rows, all with `_isFresh: true`. Diff is exactly the one line.

---

## 4. Proposed fix

**Option A (recommended — what the working tree already has):**
Ship the existing local edit:

```js
// app/quote.js:914
- return cat.map(it => ({ id: it.id, override: {} }));
+ return cat.map(it => ({ id: it.id, override: {}, _isFresh: true }));
```

Plus the existing `tests/test_structure_only_default.js`. That's it.

Steps:
1. `git add app/quote.js tests/test_structure_only_default.js`
2. Run the test (verified above to pass green when catalog is provided).
3. Run pytest suite as a sanity check.
4. Write `PHASE_7I_2026-05-13.md` describing the change.
5. Commit. Build container. Deploy to Cloud Run. Confirm new revision (will be `00040-…`).
6. Verify served `/app/quote.js` MD5 == new local MD5.
7. Verify `defaultRowsFor` body contains `_isFresh: true` via grep on served file.
8. **Tell Varun to fully reset:** `localStorage.clear()` in DevTools, then reload. Existing quotes from yesterday's testing will NOT be auto-healed (their rows are already in localStorage without `_isFresh`; load path doesn't backfill). Hitting "New Quote" or toggling scope post-deploy should produce a working quote.

**Trade-offs:** None real. This is the minimal, surgical fix that exactly matches the gate it's meant to satisfy.

**Option B (alternative — backfill on load):**
In `loadState()`, scan `s.rows`, and for any row that lacks the `_isFresh` field AND has an empty `override`, treat it as fresh: set `_isFresh: true`. This would auto-heal yesterday's stale localStorage quotes too.

```js
// inside loadState, after merging build/pricing:
rows: Array.isArray(s.rows) ? s.rows.map(r => {
  if (r && typeof r === 'object' && r._isFresh === undefined) {
    const o = r.override || {};
    const isEmptyOverride = !o.description && !o.brand && !o.label && !o.brand_rate && !o.location;
    if (isEmptyOverride) return { ...r, _isFresh: true };
  }
  return r;
}) : [],
```

**Trade-offs:** Slightly more invasive. Could mask legitimate "loaded quote with deliberately blanked desc" intent for old data (but that's a near-impossibility in practice — yesterday's quotes were never edited; they're test artifacts). On the upside, Varun doesn't have to manually clear localStorage.

**Option C (heavier — re-seed on every load if rows look stale):**
On load, detect if rows have empty overrides and re-seed via `defaultRowsFor`. Rejected — too aggressive, risks clobbering real edits.

**Recommendation:** **Option A** is what the working tree already implements and is what the brief described. Ship that. Tell Varun explicitly that pre-existing test quotes won't be auto-healed and he should "New Quote" once after deploy.

If Varun wants belt-and-suspenders, layer Option B on top in the same commit.

---

## 5. Why "yesterday's fix" didn't work

Because there was no yesterday's fix. The edit was made in the working tree but never committed and never deployed. Whoever wrote the task brief assumed the deploy had happened and built the brief on a counterfactual world state. The actual served file is still Phase 7H code.

This is a process failure, not an architecture failure. The proposed Phase 7I architecture is fine; it just wasn't shipped.

**Lesson:** After any claimed "deploy", the gold-standard verification is `gcloud run revisions list --service=<svc> --region=<r> --project=<p> --limit=3` and check that the timestamp matches the deploy attempt. MD5-parity grep is necessary but not sufficient — it can confirm "what is served = what is on disk", but if the disk hasn't been touched since the previous deploy, parity matches without proving the new change shipped.

---

## 6. Recommended next step

1. **Do NOT slap another patch on top.** The architecture is already correct in the working tree; the only failure is the build/deploy step.
2. Get Varun's explicit approval to **commit and deploy** the existing 1-line edit (Option A).
3. After deploy, verify three things:
   - `gcloud run revisions list` shows a new revision created in the last 5 min, status True.
   - Served file MD5 == working-tree MD5 (post-commit).
   - `curl -s -u zuildup-sales:zuildup https://…/app/quote.js | grep -A1 "function defaultRowsFor" | grep "_isFresh: true"` returns a hit.
4. Ask Varun to **clear localStorage** in his test browser, reload, then click "New Quote" → "Structure Only". Description should render with full catalog text for all 28 rows. Rate column should be `—` on 25 rows (catalog has no per-row rate) and the 3 items with `rate_text` should show their text — that's by design.
5. If Varun also wants the Rate column to show something for structure_only, that's a **separate** decision about either (a) sourcing `pricing.structureRate` per row, or (b) adding rates to the structure catalog items. Don't lump it into Phase 7I.

**Confidence:** High. The MD5 mismatch between local and live, combined with `gcloud run revisions list` showing no 00040 revision and `git log` showing no Phase 7I commit, is unambiguous evidence. The fix in the working tree is mechanically correct (verified by node harness against the real catalog).
