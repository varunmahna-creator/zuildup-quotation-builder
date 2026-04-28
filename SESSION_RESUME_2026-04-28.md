# SESSION RESUME — 2026-04-28 17:36 UTC

> **Read this entire file before doing anything.** Then check `HANDOFF.md` for project history, `memory/2026-04-28.md` for today's daily log, and `LESSONS_LEARNED.md` (parent dir) for the 12 logged lessons.

## TL;DR — Where We Are

- **P1.1 shipped** ✅ (commit `1d7a941`, tag `phase2-step-6-pdf-inlining-pagination`, pushed)
- **P1.2 shipped** ✅ (commit `ba12bea`, tag `phase2-step-7-catalog-fidelity-pass`, pushed)
- **P1.3 pending** — architectural pivot from Varun: catalog becomes template/dictionary, NOT price source-of-truth. Subtractive engineering. Plan locked, not yet executed.

**Resume point: Execute P1.3 in fresh context.** Rotation triggered because context hit 108% (217k/200k) and phantom-FS bit me 3× in the last hour.

## The Pivot — Why P1.3 Exists

P1.2 hardcoded `rate`, `rate_text`, `unit` for 22 items in `OVERRIDES`. It worked, tests passed, PDF renders correct caps. Varun then said:

> "No spec cost or description should be hardcoded."

The right architecture is:

- **Catalog** = template/dictionary (item set, categories, canonical labels, suggested brands as hints, suggested descriptions as starting-points)
- **Pricing** = per-quote, set by sales via the override mechanism that already works end-to-end (`state.rows[].override`)

P1.2 wasn't waste — it proved the override path works, hardened `parse_rate`, and surfaced the audit-vs-source-of-truth mismatch (audit referenced `extracted/platinum/raw_lineitems.json` which is a Platinum PPT extract; catalog builds from `Customer_Facing_Quote_Sheet.docx` — they disagree). P1.3 keeps the infrastructure, gutted the data direction.

## P1.3 — Seven Changes To Execute

### 1. Strip hardcoded prices from `OVERRIDES` (`scripts/build_catalog.py`)

Currently lines ~74-148 (after P1.2 edits, the OVERRIDES dict is at lines ~85-170 — verify). Remove every entry's `rate`, `rate_text`, `unit` keys.

**Keep only:**
- Brand typo fixes (e.g. `Jaguar` → `Jaquar`, `Wilroy & Bosch` → `Villeroy & Boch`)
- Category misrouting fixes (none currently)
- `brands: []` overrides where the regex extracted noise (these become suggested-brands hints, not authoritative)

**Drop everything that looks like:** `"rate": 250000`, `"unit": "cap"`, `"rate_text": "₹X,XX,XXX (cap)"`. Including the canonical examples I added in P1.2: `safety.cctv_camera`, `safety.video_door_phone`, `general.main_gate`, `general.lift_machine`, all 22 P1.2-added entries.

**Result:** OVERRIDES shrinks from ~75 entries (pre-P1.2 had ~50, P1.2 grew to ~75) → ~30-40 entries with structural-only concerns.

### 2. Reframe `brands` as suggested

Field name stays `brands` (avoid breaking callers); semantics change.
- Renderer should NOT auto-render brands as badges by default.
- Edit panel shows `brands` as a suggestion list sales can pick from / add to / replace.
- Spec card on rendered PDF should show only what's in `state.rows[].override.brands` (the per-quote authoritative value), not catalog defaults.

### 3. Reframe `description` as starting-point template

- Edit panel pre-fills with catalog `description`.
- Sales edits per customer.
- Visual cue when unedited (italic placeholder, or "Template — edit to customize" hint at edit-panel level).

### 4. Renderer change in `scripts/build_quote_js.py`

When no rate is set on a row, the spec card pill currently renders "Included" (looks finalized).

**Change to:** "**Set rate**" or "**—**" in muted style. "Included" reads as a closed commitment; we want the default to read as an open field.

Optional: when `o.rate_text` (override) is unset AND `item.rate_text` is also empty (which becomes the common case after P1.3), show a subtle "Edit to set rate" cue rather than nothing.

Find the rendering site — search for `"Included"` literal in `build_quote_js.py`. Likely one or two spots in the spec-card template.

### 5. Invert `tests/test_catalog_fidelity.py`

Currently asserts: "for each of 24 audit items, the cap-bearing text is findable in `rate_text + description`."

**Invert to:** "For every catalog item, `rate == 0` and `rate_text == ''`. The catalog's job is structure, not pricing. Pricing comes from per-row overrides."

This becomes the regression guard so future-me (or a future Iraaj) doesn't reintroduce hardcoded caps.

### 6. Update catalog `_meta.schema`

In `scripts/build_catalog.py`'s catalog dict literal (~line 410):

```python
"schema": "no-tier; catalog as template/dictionary; rate, description, brands all set per quote via row overrides"
```

(Currently says: `"no-tier; single rate + single brands per item; team enters cost-per-sqft per quote"`)

### 7. HANDOFF.md + audit footnote

- Append to `HANDOFF.md` a P1.3 outcome section explaining the pivot.
- Document the audit-vs-source-of-truth mismatch: audit (Dhurandhar/Varun forwarded) referenced `extracted/platinum/raw_lineitems.json` which is a Platinum PPT extract from Phase 1, but the catalog is built from `src_docx/Customer_Facing_Quote_Sheet.docx` (Phase 2 canonical). Methodology lesson is real even though P1.3 makes the audit moot (no caps to audit).

## Verification Gates

1. **Inverted test passes:** `python3 tests/test_catalog_fidelity.py` → PASS (zero items have hardcoded prices).
2. **Filled-fixture PDF renders:** every spec card shows "Set rate" placeholder where sales hasn't entered a value, NOT "Included" or a hardcoded cap.
3. **Generator-first preserved:** only edit `scripts/build_catalog.py` and `scripts/build_quote_js.py`; never hand-edit `app/quote.js` or `catalog/catalog.json`.
4. **Regen and copy:**
   - `cat src_docx/Customer_Facing_Quote_Sheet.docx | python3 scripts/build_catalog.py` → writes `/tmp/_catalog_v2.json`
   - `cp /tmp/_catalog_v2.json catalog/catalog.json`
   - `cd scripts && python3 build_quote_js.py` → writes `/tmp/_quote_v2.js`
   - `cp /tmp/_quote_v2.js app/quote.js`
   - `node -c app/quote.js` → SYNTAX_OK
5. **Vision-QC at least one filled spec page** with the digit-by-digit prompt: confirm "Set rate" appears where caps used to.

## Lessons To Append (`/opt/ocplatform/workspace/zuildup/LESSONS_LEARNED.md`)

#13-15 below. Append after the existing #12.

### Lesson #13 — Catalog as Template, Not Truth

Spec catalogs in quote-builder applications should be **dictionaries** (what items exist, in what categories, with what canonical names) — not authoritative pricing. Pricing is a per-customer business decision; baking it into a catalog removes flexibility, creates fidelity-audit liability, and obscures the sales workflow.

**Default position:** catalog = structure, quote = values.

**Trigger event:** P1.2 hardcoded 22 OVERRIDES with `rate`/`rate_text`/`unit`. Tests passed, PDF rendered correct caps. Varun then ruled it the wrong direction — catalog must be modular, sales drives values per quote. P1.3 deletes the entries P1.2 added.

### Lesson #14 — Audit Reference Must Match Build Pipeline Input

A fidelity audit is only as good as its reference. If the audit and the codebase reference different "source-of-truth" files, the audit may flag non-bugs OR miss real bugs.

**Always confirm the reference file matches the build pipeline's input.**

**Trigger event:** P1.2 audit (Dhurandhar) referenced `extracted/platinum/raw_lineitems.json` (Platinum PPT extract, Phase 1 artifact). Catalog actually builds from `Customer_Facing_Quote_Sheet.docx` (Phase 2 canonical). The two disagree on values (e.g. Steel cap, Main Gate price). The audit found real-feeling bugs based on wrong canonical.

### Lesson #15 — Subtractive Engineering > Additive Engineering

When the right architecture turns out to be "less, not more," **delete confidently**.

P1.2 added 22 OVERRIDES entries to enforce caps. P1.3 deletes them. That's not waste — P1.2 confirmed the override mechanism works end-to-end (renderer correctly displays `rate_text`). P1.3 shifts that mechanism from catalog-side to quote-side. **Infrastructure stays; the data moves.**

**Trigger event:** P1.3 pivot. The instinct on receiving Varun's correction would be to feel like P1.2 was wasted work and over-explain or apologize. Right move: absorb the lesson, ship the new direction, log the pattern.

## Commit + Tag

After all 7 changes verified:

```
git add -A
git commit -F /tmp/_p13_commit_msg.txt   # write structured msg first
git tag phase2-step-8-catalog-modularization
git push origin master --tags
```

Commit message structure:

- Headline: `P1.3: Catalog Modularization — catalog as template/dictionary, pricing per-quote`
- Body: explain the pivot, list the 7 changes, reference P1.2 commit `ba12bea` as the prior waypoint (not a regression), note that infrastructure stays + data moves, list the deferred items resolved (main_gate question becomes moot — it's no longer in catalog as a price).

## State Snapshot at Session Rotation

### Repo
- Path: `/opt/openclaw/workspace/zuildup/quotation-builder`
- Branch: `master`
- HEAD: `ba12bea` (P1.2)
- Last tag: `phase2-step-7-catalog-fidelity-pass`
- Origin: `varunmahna-creator/zuildup-quotation-builder` (in sync — pushed)
- Working tree: clean (after P1.2 commit)

### File MD5s (post-P1.2)
- `scripts/build_catalog.py`: had md5 from P1.2 patch (~441 lines); will change in P1.3
- `scripts/build_quote_js.py`: untouched since P1.1; need to find "Included" string + change in P1.3
- `app/quote.js`: `5926278bd43d9c3c99c8f9694dc974fe` (will regen in P1.3)
- `catalog/catalog.json`: `b551610a7028e975fb88ba7eaf85c621` (will regen in P1.3)
- `tests/test_catalog_fidelity.py`: created in P1.2; needs INVERSION

### Server
- pid 277020 on port 8124, started 14:59 UTC
- Log: `/tmp/_qb_server.log`
- Has all P1.1 inliner helpers (`inlineLocalAssets`, `injectImageLoadWait`, etc.)

### Tooling
- PDF→PNG: `python3 /tmp/_pdf2png.py <pdf> <out_prefix> [dpi]` OR inline `import fitz; d=fitz.open(...); d.load_page(i).get_pixmap(dpi=150).save(...)`
- DOM capture for PDF render: `google-chrome --headless --no-sandbox --disable-gpu --user-data-dir=/tmp/qb_chrome_X --virtual-time-budget=15000 --dump-dom http://127.0.0.1:8124/app/_seed.html > /tmp/_dom.html` then `curl -X POST --data-binary @/tmp/_dom.html http://127.0.0.1:8124/pdf -o /tmp/output.pdf`
- Vision QC prompt template (see lesson "AI-Vision QC — Confident-Wrong Failure Mode" in `MEMORY.md`): "Read the EXACT text. Digit by digit. Do not infer or guess. If any value is blank, '—', NaN, or undefined, say so explicitly."

### Filled-fixture seed pattern (for vision QC)
Use the seed-into-localStorage approach from P1.2:

```html
<script>
const SEED = { rows: [{id: "structure.steel"}, ...], customer: {...}, build: {...}, pricing: {...}, scope: "full", quoteId: "...", createdAt: "..." };
localStorage.setItem('zuildup.quote.v2', JSON.stringify(SEED));
</script>
<div id="preview-root"></div>
<script src="/app/quote.js"></script>
```

Save to `app/_p13_seed.html`, fetch via `http://127.0.0.1:8124/app/_p13_seed.html`, render to PDF, delete after QC.

For P1.3 the seed should NOT have any per-row override values — that's how we test the "Set rate" placeholder appears.

## Phantom-FS Operational Notes (already proven today)

- `/dev/sda1 /opt/openclaw ext4 rw,...` is fine — bind-mount of root which IS ro at `/`. Writes work inside `/opt/openclaw/...`.
- `mkdir -p /opt/...` from outside the mount fails with "Read-only file system" because the path-walk hits root mount (ro) before resolving. Workaround: `cd /opt/ocplatform/workspace/zuildup/quotation-builder && mkdir -p tests`.
- `python3 open(file)` fails with ENOENT on freshly-written file (separate dentry cache from bash). Workaround: `cat file | python3 script.py output_path`.
- `ls`/`stat`/`md5sum` flicker on freshly-written files. Sleep 5-15s + retry typically clears.
- Long sleep commands (`sleep 30`/`sleep 60`/`sleep 120`) in bash sometimes hang past their duration if the shell is wedged — kill them and retry.
- Git is ground truth: `git ls-files`, `git show HEAD:path` always work even when filesystem flickers.
- Write tool > `bash cp` for the same content (different code path, fewer phantom failures).

## Varun's Discipline Note (verbatim)

> "This is a real direction-change, not a regression. P1.2 wasn't wasted — it proved the override mechanism works, hardened parse_rate, and surfaced the audit-vs-source confusion. Don't apologize for it; just absorb the lesson and ship the new direction. Generator-first, subtractive, modular. Go. 🔥"

## Continuity

- After P1.3 ships, **rebuild the parent `LESSONS_LEARNED.md`** from chat history (it was truncated to only have lessons #8-15; #1-7 are gone). Discord brief `discord-briefs/zuildup-quotation.md` may have hints. Or rewrite from memory + the existing entries as anchors.
- `general.main_gate` value contradiction (₹1L source vs ₹2.5L override) becomes moot in P1.3 — both values are deleted; sales sets per quote.
- Self-heal toolkit (`propose/`) still deferred. Add to backlog after P1.3 + LESSONS rebuild.

---

**Last action of session 2026-04-28 17:36 UTC:** Wrote this file. Session at 108%+ context, rotating now.
**Resume action:** Read this file end-to-end, then HANDOFF.md, then begin P1.3 step 1.
