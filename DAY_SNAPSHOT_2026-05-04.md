# DAY SNAPSHOT — 2026-05-04

ZuildUp Quotation Builder. Single biggest day of work since the project
launched. Everything below was shipped, deployed, and verified live in
one session.

> **Purpose of this file:** if context is lost (LLM compaction, session
> rotation, fresh agent picking up later), this single file lets anyone
> reconstruct what changed today, why, where the code lives, and what
> the verification status is. Read alongside `PROJECT_CONTEXT.md`
> (the canonical long-form doc).

---

## At a glance

| Metric | Value |
|---|---|
| Phases shipped today | **6.1 → 7D** (across the whole day; final run was 7A → 7D) |
| Commits today | **20** |
| Net code change | **+5,041 / −298** lines |
| Tests on disk | **140** (all green; +9 from Phase 7D alone) |
| Live revision (end of day) | `zuildup-quotes-00026-4mf` |
| Live URL | https://zuildup-quotes-zim2owjloq-el.a.run.app/ |
| Final HEAD MD5 (`app/quote.js`) | `c648b75047339b414894175971dd954d` |
| MD5 parity HEAD == LIVE | ✅ verified |

---

## Phases shipped today (chronological)

### Phase 6.1 — `cc3b25d` — 7 sales-team feedback fixes
- Override-row auto-expand
- Formatting alignment in spec list
- ₹ glyph regression guard
- Hide placeholder copy
- Unedited-row styling
- Quote validity field
- Rate column rename

### Phase 6.2 — `1dd201b` — Per-floor balcony pricing + floor area summary table
- Balconies are now priced per floor (not flat).
- New floor area summary table on cost page.

### Phase 6.3 — `22fe2a3` — Sequential additional zones
- Elevation / GST / Custom zones get dynamic letter assignment (A, B, C…)
  based on insertion order rather than hard-coded slots.
- Zone-sum invariant `grandTotal = Σ(zone.cost) + liftCost` preserved.

### Phase 6.4 — `8bab87a` + `73fcb1b` — Copy Category + Basement specs + Rich-text descriptions
- ⎘ **Copy Category** button on every category header — clones every row
  in the group with catalog defaults (override reset to `{}`). Each clone
  keeps the same catalog `id` so it pulls fresh defaults; each clone has
  its own row slot so the rep can edit independently.
- Auto-suffixed group name on collision: `X (Copy)`, `X (Copy 2)`…
- Inline-rename ✎ on category header. Stamps `row.categoryGroup` on every
  row in the group; ESC reverts; Enter / blur commits.
- New **Basement** specs (catalog category) added.
- Rich-text descriptions render correctly in PDF (line breaks etc.)

### Phase 7A — `d0799fe` (+ `f4ecea2` docs) — Cosmetic / UI fixes (Batch A, 6 items)
- Item 1: Added `<option>Ar.</option>` to salutation dropdown
- Item 6: Copy Category now inserts cloned rows immediately AFTER source
  (not appended at end). Verified via Node-shim test.
- Item 7: Inline rename input visibility — colour/bg `!important`,
  font 11→13px, `.renaming .cat-name { overflow: visible }`
- Item 8: Cover wordmark width 220→340
- Item 9: Tagline `Zuild.` → `Zuild!`
- Item 10: Removed `<span class="cover-meta-tag">` markup AND CSS
- Tests: 7 new in `tests/test_phase7a.py`

### Phase 7B — `4514eb9` + follow-ups `a863095`, `a0444e2` (+ `5e64472` docs) — Calculator + UI fixes (Batch B, 12 items)
12 items shipped. `app/quote.js` grew by ~1,087 lines.
- Item 2: Collapsible area panel
- Item 3: Zone D opt-in (water tank, with `hasWaterTank` state + migration)
- Item 4: Basement rate description ("varies" copy)
- Item 5: PDF page-break tightening — dynamic area-page split pivot to
  balance row density (9 vs 13 budget)
- Item 11: Floor summary above per-item overrides (so override panel
  doesn't push the summary off-screen)
- Item 12: Stilt columns
- Item 13: Basement area formula
- Item 14: Editable lift / staircase **areas** (sqft, not rates):
  staircase = 125 sqft per floor default, lift = 25 sqft per floor default;
  state shape `liftSqftPerLevel`, `staircaseSqftPerLevel` with backwards-compat
- Item 15: Add line item per zone (`zoneLineItems` state)
- Item 16: Multiple custom charges (custom array upgrade)
- Item 17: Editable item name/desc (`itemNameOverrides`, `itemDescOverrides`)
- Tests: 18 new in `tests/test_phase7b.py`
- Recovery note: original Batch B subagent died mid-run on a "key" scope
  verification step; substantial work was intact in the working tree
  (`app/quote.js` +263 lines), recovered and completed without restart.

### Phase 7C — `e600485` — Position-based category ordering (recovery from QC bug)
**Problem found post-7B:** Cloned categories (e.g. `Bathroom & Toilet (Copy)`)
were falling to the bottom of the spec list and PDF. Root cause:
`renderSpecList` and `renderQuote` both used a hardcoded `catOrder` array;
clones aren't in `catOrder` so the `.concat()` tail dumped them at the end,
defeating Phase 6.4's splice-after-source insertion.

**Fix:** Both renderers now derive category render order from
**first-occurrence position in `state.rows`**. PDF render uses `_byCatOrder`
tracked during the `byCat` assembly. Picker UI (catalog browse) keeps the
canonical `catOrder` since it isn't tied to `state.rows`.

This phase silently set up the foundation for Phase 7D — once order
became position-based, "move category up/down" became a simple
state.rows splice.

### Phase 7D — `e786082` (+ `58a3e91` docs) — Move category up/down ✨ (today's last ask)
- ▲ / ▼ buttons on every category header
- First category gets ▲ disabled, last gets ▼ disabled
- New helper: `moveCategory(cat, dir)` swaps two adjacent category blocks
  in `state.rows`, preserving each block's internal insertion order
- Because Phase 7C made render order purely first-occurrence in
  `state.rows`, **this single state mutation reorders BOTH the editor
  spec list AND the customer PDF** in one operation
- Edge case: interleaved rows (legacy quotes / scattered custom rows) —
  swap still produces correct outer order; "intruder" rows (third-category
  rows that fell inside the spanned slice) are appended at the end of the
  slice with relative order preserved
- Tests: 9 new in `tests/test_phase7d.py`

---

## Where the code lives (quick map)

| What | File | Anchor |
|---|---|---|
| Main SPA + calc + PDF render | `app/quote.js` | ~3,978 lines |
| Form UI / cover / spec list scaffold | `app/index.html` | ~408 lines |
| Express + Basic Auth | `app/server.js` | small |
| Embedded fonts (Fraunces + Inter w/ ₹ glyph) | `app/assets/embedded_fonts.css` | base64 woff2 |
| Catalog of items | `catalog/` | JSON |
| `quote.js` build script | `scripts/build_quote_js.py` | reads sources |
| Phase 7D helper | `app/quote.js` `function moveCategory(currentCat, dir)` | inserted right before `buildSpecCard` |
| Phase 7C order derivation | `app/quote.js` `_byCatOrder` array | search "first-occurrence" |
| Copy Category | `app/quote.js` `function copyCategory(currentCat, sourceIndices)` | line ~2461 |
| Inline rename | `app/quote.js` `function beginCategoryRename(hdr, currentCat)` | follows copyCategory |
| Spec list render | `app/quote.js` `function renderSpecList()` | line ~2313 |
| PDF render | `app/quote.js` `function renderQuote()` / `renderSpecPages()` | lower in file |

---

## Tests

```
tests/test_phase5.py            13 tests
tests/test_phase6_1.py          13 tests
tests/test_phase6_2.py          25 tests
tests/test_phase6_3.py          15 tests
tests/test_phase6_4.py          13 tests
tests/test_phase6_4_11.py       27 tests
tests/test_phase7a.py            7 tests
tests/test_phase7b.py           18 tests
tests/test_phase7d.py            9 tests
                                ───
                               140 tests   ← all green
```

(Excluded from runs: `tests/test_catalog_fidelity.py` — has unrelated
`sys.exit(0)` issue at line 109; not a regression.)

**Run:** `cd /opt/openclaw/workspace/zuildup/quotation-builder && .venv/bin/python -m pytest tests/ --ignore=tests/test_catalog_fidelity.py`

---

## Doctrine learnings reinforced today

1. **MD5 parity HEAD == LIVE is the only "deployed" gate.** `gcloud run
   deploy` returning success isn't enough — verify the new revision
   matches `git show HEAD:<file> | md5sum` against the live URL.
2. **In multi-agent shared checkouts**, compare `git show HEAD:<file>` md5
   against live, NOT `md5sum <file>` — sibling agents can have parallel
   uncommitted edits in the working tree.
3. **The Edit/Read tools sometimes run in a different mount namespace
   that lags behind Bash.** When Edit returns `File not found` but `stat`
   shows the file exists, switch to `python3 <<'PY'` for multiline edits
   instead of fighting the tool. (FS isn't broken, the tool process is.)
4. **Recover, don't restart.** When a subagent dies mid-run, the working
   tree usually has substantial intact work. Map item completion via
   marker counts in the source first; only restart what's missing.
5. **Cloud Run deploys take 3–5 min.** Don't try to wait with a single
   `sleep 600` — the bash tool pre-empts long sleeps. Poll the gcloud
   describe endpoint at intervals or check `ps -p <pid>` for the
   foreground deploy process.
6. **Phase 7C → 7D synergy was free.** Once we made render order purely
   position-based in state.rows (7C, fixing a bug), reordering became a
   trivial state mutation that automatically affects all surfaces (7D).
   Worth reflecting on: structuring derived state from a single source
   pays compounding interest.

---

## What's still open (next session pickup)

- **Phase 7D QC by Varun** — UI live, awaiting his click-through
  feedback on icon style (▲ ▼ vs drag-handle) and placement
- **Channel brief refresh** — `discord-briefs/zuildup-quotation.md` is
  stale (points to an old project path); should be updated to reference
  `/opt/openclaw/workspace/zuildup/quotation-builder/`
- **Untracked QC artefacts** in `qc-phase6/`, `qc-phase63/`,
  `qc-phase7a/` — gitignored already, can be cleaned up if disk pressure

No known bugs in production at end-of-day.

---

## Key paths & commands cheat-sheet

```
Project root:    /opt/openclaw/workspace/zuildup/quotation-builder/
Live URL:        https://zuildup-quotes-zim2owjloq-el.a.run.app/
Auth:            zuildup-sales / zuildup
GCloud project:  zuildup-quotes
Region:          asia-south1
Service name:    zuildup-quotes
Latest revision: zuildup-quotes-00026-4mf

# Deploy
cd /opt/openclaw/workspace/zuildup/quotation-builder \
  && gcloud run deploy zuildup-quotes \
       --source . --region asia-south1 \
       --project zuildup-quotes --quiet

# Verify live revision
gcloud run services describe zuildup-quotes \
  --region asia-south1 --project=zuildup-quotes \
  --format='value(status.latestReadyRevisionName)'

# MD5 parity check
git show HEAD:app/quote.js | md5sum
curl -s -u zuildup-sales:zuildup \
  https://zuildup-quotes-zim2owjloq-el.a.run.app/app/quote.js | md5sum

# Tests
.venv/bin/python -m pytest tests/ --ignore=tests/test_catalog_fidelity.py
```

---

## Commit timeline (today, oldest first)

```
cc3b25d  Phase 6.1: 7 sales-team feedback fixes
8bab87a  Phase 6.4 #9: Copy Category + inline-rename
22fe2a3  Phase 6.3: sequential additional zones
73fcb1b  Phase 6.4 #11a + #11c: Basement category + Rich-text
9c1cf23  docs: PROJECT_CONTEXT — Phase 6.3
0be3d7c  docs: PROJECT_CONTEXT — Phase 6.4
1dd201b  Phase 6.2: per-floor balcony pricing + floor area summary
d0799fe  Phase 7A: cosmetic + UI fixes (batch A)
f4ecea2  docs: PROJECT_CONTEXT — Phase 7A
4514eb9  Phase 7B: 12 calc + UI items
a863095  Phase 7B Item 5: dynamic area-page split pivot
bca8fe9  chore: gitignore PDF QC harness
a0444e2  Phase 7B Item 5: tighten split-pivot row budget
9717605  chore: gitignore PDF QC harness scripts and qc dir
4227c18  chore: remove stray QC harness scripts
5e64472  docs: PROJECT_CONTEXT — Phase 7B
e600485  Phase 7C: position-based category ordering
e786082  Phase 7D: move category up/down
58a3e91  docs: PROJECT_CONTEXT — Phase 7D
```

— Iraaj 🤖, EOD 2026-05-04
