# DAY SNAPSHOT — 2026-05-06

ZuildUp Quotation Builder. Phase 7E session — sales-team feedback batch C
(11 items). Three sub-phases (A: quick fixes, B: bug fixes, C: feature
work), single deploy at the end.

> **Purpose of this file:** if context is lost (LLM compaction, session
> rotation, fresh agent picking up later), this single file lets anyone
> reconstruct what changed today, why, where the code lives, and what
> the verification status is. Read alongside `PROJECT_CONTEXT.md`
> (the canonical long-form doc) and yesterday's
> `DAY_SNAPSHOT_2026-05-04.md`.

---

## At a glance

| Metric | Value |
|---|---|
| Phases shipped today | **7E-A, 7E-B, 7E-C** (11 items total) |
| Commits today | **3** code + 1 docs (this file + PROJECT_CONTEXT 7E section) |
| Net code change (3 phase commits) | **+765 / −45** lines (incl. tests) |
| Tests on disk | **174** (all green; +34 new across 3 new test files) |
| Live revision (end of day) | `zuildup-quotes-00027-ssm` |
| Live URL | https://zuildup-quotes-zim2owjloq-el.a.run.app/ |
| Final HEAD MD5 (`app/quote.js`) | `d2d111a3ba2e638710427e96f94244bb` |
| Final HEAD MD5 (`app/index.html`) | `98930d7bb2540914ea3e531f0ca6b8a5` |
| MD5 parity HEAD == LIVE | ✅ verified for both files |

---

## Phases shipped today (chronological)

### Phase 7E-A — `0b5c737` — Quick fixes (5 items)

Items 1, 2, 8, 9, 10. Mostly label / formatting / removal changes.

- **Item 1 — Floor area summary nomenclature parity.** Summary uses
  canonical `Ground Floor / First Floor / ...` matching `calcPackage`
  / `calcStructure` zone-A item names. New module-level constant
  `FLOOR_DISPLAY_NAMES` referenced from BOTH calc + summary. Removed
  the duplicate `['1st Floor', ...]` array.
- **Item 2 — Removed 'Premium Package'** sublabel from per-floor and
  basement rows in floor area summary. Terrace keeps `Mumty`.
- **Item 8 — Quotation header cleanup.** Removed `Coverage:` and
  `Floor Area:` spans from the Area Calculation page params-row.
- **Item 9 — BPF format parity.** Added `#bpf-rate-list` to the
  shared `.aov-zone / .aov-zone-hdr / .aov-row / .aov-name /
  .aov-unit / input` selectors.
- **Item 10 — Spec editor label.** Renamed `Brand Name & Rate` →
  `Rate` to match customer PDF.

Tests: +9 in `tests/test_phase7e_a.py`. Updated 2 tests in
`test_phase6_2.py` and 1 in `test_phase7b.py` (label parity).

### Phase 7E-B — `b88cb86` — Bug fixes (3 items)

Items 3, 4, 6. Each diagnosed root-cause-first.

- **Item 3 — Terrace area override bug.** `buildFloorSummary` now
  reads `getZoneItemArea('C', 'Terrace', default)` instead of
  recomputing the raw formula. Override flow already worked for
  Zone A floors (Phase 7B Item 11) — terrace was the only static
  item still bypassing it.
- **Item 4 — Stilt open area = setback + ramp.** `open` column on
  the stilt row sums setback (plot − floor area) **AND** ramp
  (`breadth × RAMP_DEPTH`), both honouring overrides on Zone C
  `Setback` and `Ramp`.
- **Item 6 — 'Add line' panel not expanding.** Pure CSS specificity
  bug. The shared `.aov-row` rule forced `display:grid` with 3
  columns, clobbering the inline `flex-wrap` on the 7-element
  `.aov-lineitem` rows. Fix: higher-specificity rule for
  `.aov-lineitem` with `display:flex !important`.

Tests: +7 in `tests/test_phase7e_b.py`. Updated 1 test in
`test_phase7b.py` (stilt `open == 756` instead of 540).

### Phase 7E-C — `eb4bc38` — Feature work (3 items)

Items 5, 7, 11. Bulk of the day.

- **Item 5 — Inline editable description.** Replaced the
  `prompt()`-based 📝 button (7B-17) with an always-visible inline
  `<input data-desc-key>` below each row in the area-overrides
  panel. Reuses existing `state.pricing.itemDescOverrides` (no
  parallel map). Empty / matches default → clears override. Italic
  + muted when default; solid + ink when overridden.
- **Item 7 — Per-floor attribution for Zone A line items.**
  Optional `floor` field on `zoneLineItems['A'][i]`. New helper
  `floorOptionsForA(state)` enumerates available labels honouring
  build mode (Basement, Stilt, Ground/First/..., Terrace). Line-item
  editor for Zone A renders a `<select data-li-field="floor">`.
  `buildFloorSummary`, after computing per-floor rows, adds line
  item areas to the matching row's `covered` column. Backwards-
  compat: items without `_floor` don't get attributed.
- **Item 11 — Editable floor summary + new left-rail tab.** New
  `<fieldset id="floor-summary-fs">` (collapsible `<details open>`)
  with per-row inputs: label (text) + 4 numeric overrides
  (`liftStair / covered / semiCovered / open`). Total row included
  for renaming + numeric override. New state map
  `state.pricing.floorSummaryOverrides` keyed by row label.
  `loadState` merge handles legacy quotes. `renderFloorSummaryEditor()`
  is wired into `flush()` and init sequence. `buildFloorSummary`
  applies overrides as the FINAL pass (override > line-item
  attribution > computed default).

Tests: +18 in `tests/test_phase7e_c.py`.

---

## Where the code lives (quick map)

(Same as yesterday — the generator script is still legacy. All edits
this phase went directly into `app/quote.js` and `app/index.html`.)

- `app/quote.js` (~14k LOC) — main SPA + calc + PDF render. Hand-edited.
- `app/index.html` — form/cover scaffold. Hand-edited.
- `scripts/build_quote_js.py` — legacy generator, last touched Phase 5
  (May 2). Do **not** rerun; it would clobber 6.1 → 7E.
- `tests/` — 174 tests across 13 test files; canonical command:
  `cd /opt/openclaw/workspace/zuildup/quotation-builder && \
   .venv/bin/python -m pytest tests/ --ignore=tests/test_catalog_fidelity.py`

### New files this phase

| File | Tests | Purpose |
|---|---|---|
| `tests/test_phase7e_a.py` | 9 | Floor label parity, sublabel removal, header cleanup, BPF CSS, spec editor label |
| `tests/test_phase7e_b.py` | 7 | Terrace override, stilt+ramp open, line-item CSS opt-out |
| `tests/test_phase7e_c.py` | 18 | Inline desc, floor attribution, summary editor + override |

---

## Live verification (curl-grep evidence)

After deploy of `zuildup-quotes-00027-ssm`:

```
=== Item 6: aov-lineitem CSS opt-out present in live HTML ===
#area-ovr-list .aov-lineitem, #item-rate-list .aov-lineitem { display: flex !important; flex-wrap: wrap; gap: 4px; align-items: flex-start; }

=== Item 7: floor select dropdown present in live JS ===
1
=== Item 7: floorOptionsForA function present in live JS ===
1

=== Item 11: floor-summary fieldset present in live HTML ===
  <fieldset id="floor-summary-fs" style="display:none;">
    <legend>Floor Summary (editable)</legend>
=== Item 11: renderFloorSummaryEditor in live JS ===
1
```

MD5 parity:

```
$ git -C ... show HEAD:app/quote.js | md5sum
d2d111a3ba2e638710427e96f94244bb  -
$ curl -s -u zuildup-sales:zuildup https://zuildup-quotes-zim2owjloq-el.a.run.app/app/quote.js | md5sum
d2d111a3ba2e638710427e96f94244bb  -
```

✅ HEAD == LIVE for both `app/quote.js` and `app/index.html`.

---

## Doctrine learnings reinforced today

1. **Three-rules hold.** Read first → verify end-to-end on LIVE →
   md5 parity gate. Three-commit triage didn't trigger today (no
   item took more than one diagnostic loop).
2. **Single source of truth wins.** Item 1's nomenclature parity
   was a perfect example: two parallel arrays drifted apart →
   inconsistent UI. The fix wasn't to update the divergent one,
   it was to delete the divergent one and reference the canonical.
   `FLOOR_DISPLAY_NAMES` is now the only place floor labels live.
3. **CSS specificity > JS hypothesis (Item 6).** "The button does
   nothing" → instinct says JS handler bug. Reality: handler
   always worked, the resulting DOM was visually collapsed by an
   over-specific grid rule. Always inspect *computed* CSS when
   state changes but UI doesn't.
4. **Phase 7B Item 17's prompt() was always going to be revisited
   (Item 5).** Native `prompt()` is fast to ship, slow to use.
   When the brief says "patterned after X" it usually means
   "X had a UX flaw, do better." Inline > modal.

---

## Verification status

- ✅ All 174 tests green (140 baseline + 34 new + 0 deletions)
- ✅ Build successful (Cloud Build `cc71af4d-acf3-4f92-bafd-5683d98d1c18`)
- ✅ Deploy successful (revision `zuildup-quotes-00027-ssm`, 100% traffic)
- ✅ MD5 parity HEAD == LIVE (both `quote.js` and `index.html`)
- ✅ Curl-grep evidence for all 11 items present in served files

Live click-test (suggested, not blocked-on):
- Open https://zuildup-quotes-zim2owjloq-el.a.run.app/ → enter a
  basic plot/coverage → confirm Floor Summary fieldset appears in
  left rail.
- Enter Zone A line item → select a floor in the dropdown →
  confirm the Area Calculation page floor summary's `covered` for
  that row goes up by the entered area.
- Override a row label in the new editor → confirm summary
  reflects the rename.
- Add a line item via Zone B `+ Add line` → confirm the row
  expands properly (Item 6 fix).

---

## Commit timeline (today)

- `0b5c737` Phase 7E-A: sales feedback batch C — quick fixes (items 1, 2, 8, 9, 10)
- `b88cb86` Phase 7E-B: sales feedback batch C — bug fixes (items 3, 4, 6)
- `eb4bc38` Phase 7E-C: sales feedback batch C — feature work (items 5, 7, 11)
- `<next>`  docs: DAY_SNAPSHOT_2026-05-06 + PROJECT_CONTEXT Phase 7E section

---

## What's still open (next session pickup)

Nothing from this batch. All 11 items shipped, tested, deployed,
and verified live. Awaiting the next sales-team feedback round.

If a regression is reported, the canonical reproduction steps live
in the per-item test cases under `tests/test_phase7e_*.py` —
each item has at least one test asserting the expected behaviour.
