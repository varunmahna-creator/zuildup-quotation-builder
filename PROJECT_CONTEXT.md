# ZuildUp Quotation Builder — Full Project Context

**Last updated:** 2026-05-02 (post Phase 5 deploy)
**Status:** 🟢 LIVE in production. Phase 5 shipped: zone-sum QC fix, lift/staircase rework (mumty stop), Concrete spec section, area-override description.

This doc consolidates everything needed to resume work on this project from cold context. Read this + the channel brief (`/opt/openclaw/workspace/discord-briefs/zuildup-quotation.md`) and you're caught up.

Related docs in this repo (also worth scanning):
- `HANDOFF.md` — original Phase 1 → Phase 2 handoff (Apr 28, 43 KB, dense detail on architecture)
- `PROJECT_ARCHIVE.md` — closeout doc from Apr 29 stand-down (was reopened for Phase 3)
- `SESSION_RESUME_2026-04-28.md` → `SESSION_RESUME_2026-05-01.md` — daily resume snapshots
- `bugs.md` — running bug tracker

---

## 1. What This Is

A web-based quotation/cost-estimate builder for **ZuildUp's** sales team to generate luxury-grade, customer-facing PDF quotes for high-end interior fitouts (NCR luxury segment, ticket size ₹2 Cr+).

**Core flow:**
1. Sales rep enters customer details (name, project address, plot/built-up area)
2. Picks a calculator mode (3 modes: per-sqft, area-based, line-item)
3. Picks line items from a catalog (~57 items: civil, joinery, kitchen, wardrobes, electrical, HVAC, plumbing, etc.)
4. Adjusts per-line rates if needed (Phase 3 added this)
5. Hits "Download PDF" → gets a 13-page polished PDF: cover, area summary, itemized cost sheet, detailed specs, T&Cs.

**Why it matters:** Replaces ad-hoc DOCX/Excel quotes the sales team used to pass around. Branded, consistent, fast.

---

## 2. Where It Lives

### Live Production
- **URL:** https://zuildup-quotes-zim2owjloq-el.a.run.app
- **Aliased to:** https://zuildup-quotes-586295767597.asia-south1.run.app
- **Auth (per-rep, Phase 4.1):** Basic Auth, one login per sales rep
  - `varun` / `varun123`
  - `karan` / `karan123`
  - `avish` / `avish123`
  - `vaishali` / `vaishali123`
  - `rajat` / `rajat123`
  - `zuildup-sales` / `zuildup` (legacy fallback during transition; remove later)
  - Configured via `AUTH_USERS_JSON` env var on Cloud Run service
- **Platform:** Google Cloud Run
- **GCP project:** `zuildup-quotes`
- **Region:** `asia-south1` (Mumbai)
- **Service name:** `zuildup-quotes`

### Current revision
- **Active:** `zuildup-quotes-00015-55t` (deployed 2026-05-02, Phase 5 — sales-team feedback fixes)
- Previous: `00014-v2v` (Phase 4.1 per-rep logins, 2026-05-01 11:10)
- Previous: `00013-zqv` (Phase 4 cross-device quote library, 2026-05-01 10:50)
- Previous: `00012-ztc` (v2.3 ₹ fix, 2026-05-01 09:15)
- Previous: `00011-jq5` (v2.2 layout fixes)

### Local Source
- **Path:** `/opt/openclaw/workspace/zuildup/quotation-builder/`
- **Git branch:** main (single branch)
- **Local HEAD:** `cb8a615` Phase 3 v2.3
- **Remote:** none — git is local only on the VM

### Deploy command
```bash
cd /opt/openclaw/workspace/zuildup/quotation-builder
gcloud run deploy zuildup-quotes --source . --region asia-south1 --quiet
```
Cloud Build picks up the `Dockerfile` automatically. Deploy takes ~2-3 minutes.

---

## 3. Architecture (Quick Overview)

**Single-tenant SPA + thin Node server.** No DB, no API layer. All state in `localStorage`. PDF rendering is client-side via headless Chrome (the browser does the layout, then `window.print()` saves to PDF).

```
Browser (Chrome / Edge)
  index.html (form UI)
  quote.js   (PDF gen)
  embedded_fonts.css (base64 woff2)
        |
        v window.print() -> PDF
        |
        v (auth + static)
Cloud Run: zuildup-quotes (Node 20, Express)
  - server.js: Basic Auth, static file serve
  - Sets Content-Disposition for PDF filename
```

### Key files

| File | Purpose | Size |
|------|---------|------|
| `app/server.js` | Express app, Basic Auth, static + PDF download routes | 483 lines |
| `app/index.html` | Main SPA form UI | 381 lines |
| `app/quote.js` | Generates the multi-page PDF preview HTML, line-item logic, calculators | 2403 lines |
| `app/assets/embedded_fonts.css` | Base64-embedded woff2 fonts (Fraunces + Inter) | 213 KB |
| `catalog/` | JSON catalog of 57 line items (descriptions, default rates) | — |
| `scripts/build_quote_js.py` | Builds `quote.js` from sources (templates + catalog injection) | — |
| `Dockerfile` | Node 20 Alpine, runs `node app/server.js` | — |
| `package.json` | Deps: only `sharp` (image compression for embedded photos) | — |

### Phase 4 storage stack
- **Source of truth:** Firestore Native (project `zuildup-quotes`, location `asia-south1`, database `(default)`, collection `quotes`).
- **Document shape:** `{id, name, customer_name, author, last_edited_by, created_at, modified_at, row_count, state: <full quote state>}`. Document id == slot id (`q_<ts>_<rand>`).
- **Hot cache:** localStorage in browser. `QuoteStorage` writes there first (sync), pushes to cloud in background.
- **Boot sync:** `QuoteStorage.syncFromCloud()` runs at start of `bootForm()` and again when Load modal opens. 4s timeout — if cloud is slow, falls through to local cache.
- **Failure mode:** 3 consecutive API failures disable cloud sync for the session. Rep keeps using localStorage; nothing breaks.

### Local dev with Firestore
- Need either `gcloud auth application-default login` (uses your gcloud creds) OR `GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json`.
- Set `GOOGLE_CLOUD_PROJECT=zuildup-quotes` env var (or `FIRESTORE_PROJECT_ID`).
- Local writes hit the SAME Firestore as production — be careful with test data (use clearly-prefixed names).

### Boot dev environment
```bash
cd /opt/openclaw/workspace/zuildup/quotation-builder
PORT=8124 GOOGLE_CLOUD_PROJECT=zuildup-quotes nohup node app/server.js > /tmp/_qb_server.log 2>&1 &
# Server on http://localhost:8124

# For headless PDF tests:
google-chrome --headless=new --no-sandbox --disable-gpu \
  --user-data-dir=/tmp/qb_chrome_p1567 --remote-debugging-port=9223 \
  --remote-allow-origins='*' --window-size=1400,900 about:blank &
```

---

## 4. Brand & Design Language

- **Primary navy:** `#0A1F44`
- **Gold:** `#C9A24D`
- **Off-white:** `#F9FAF7`
- **Display serif:** Fraunces (variable, latin + latin-ext)
- **Body sans:** Inter (variable)
- **Cover word "ZuildUp":** inline SVG, `font-family="Inter, sans-serif"` (huge, gold on navy)
- **Tagline:** Fraunces serif italic
- **Customer h1:** Fraunces serif

**Customer-facing PDF must look polished/luxury.** Always do thorough vision QC before deploy.

---

## 5. Phase History (Most Recent First)

### Phase 7A (May 4) — Cosmetic + UI fixes (Batch A, 6 items)
Sales-team / Varun feedback on the live tool. Six small surgical fixes;
landed in parallel with Phase 7B (which touches calc logic). Live revision
**`zuildup-quotes-00021-tpl`**, commit `d0799fe`.

**Items shipped:**
1. **`Ar.` (Architect) added to salutation dropdown.** `app/index.html` line
   239 — appended `<option>Ar.</option>` after Dr. Cover renders "Ar.
   Rajesh Sharma" correctly (vision QC confirmed).
6. **Copy Category insertion order — locked in.** `copyCategory` in
   `app/quote.js` already used `splice(Math.max(...sourceIndices)+1, ...)`
   from Phase 6.4 #9. Brief noted "currently appends to end" but the code
   was already correct — wrote a Node-shim test in `tests/test_phase7a.py`
   to lock the contract: clones land contiguously after the LAST source
   row, not at the end of `state.rows`.
7. **Inline rename input now visible while typing.** Root cause: the
   input replaces the `.cat-label` span inside `.cat-name`, which has
   `text-transform: uppercase`, `color: var(--gold)`, AND `overflow: hidden`.
   The CSS already set `color: var(--navy)` and `text-transform: none` on
   `.cat-rename-input`, but the parent's `overflow: hidden` was clipping the
   typed text. Fix: added explicit `color: #0A1F44 !important`, `background:
   #fff !important`, bumped font-size 11 → 13px, and added a
   `.spec-cat-hdr.renaming .cat-name { overflow: visible }` rule so the
   input expands without clipping. Also added `-webkit-text-fill-color`
   for Safari belt-and-braces.
8. **Cover ZuildUp wordmark enlarged.** `logoSvg` in `app/quote.js`
   bumped the cover-only width from 220 → 340 (~1.55×). Inner-page logo
   sizes (large=160, default=110) untouched. Vision QC: "logo prominent
   and well-sized."
9. **Cover tagline** `Don't just build, Zuild.` → `Don't just build,
   Zuild!` Single character change.
10. **Removed `Delhi NCR · Estd 2024` meta-tag.** Both the `<span
    class="cover-meta-tag">…</span>` markup AND the orphan
    `.cover-meta-tag` CSS rule deleted. Vision QC confirmed tag absent.

**Tests:** 7 new in `tests/test_phase7a.py`. 112/112 green
(105 prior + 7 new). The Node-shim for #6 extracts `rowCategoryGroup` and
`copyCategory` via brace-balanced regex slicing and exercises the splice
behaviour with a 5-row interleaved fixture.

**End-to-end live verification (revision `zuildup-quotes-00021-tpl`):**
- Local `app/quote.js` md5 (HEAD `d0799fe`) == live `/app/quote.js` md5
  (`3dabd940c10899020dea4db30464d10a`).
- `curl /app/index.html` returns the dropdown with `<option>Ar.</option>`.
- `curl /app/quote.js | grep "size==='cover') ? 340"` returns 1.
- `grep "cover-meta-tag"` returns 0 (removed).
- `grep "Don't just build, Zuild!"` returns 1.
- Vision QC on the rendered cover (Chrome headless against the live
  `quote.js` unwrapped + `renderCover('Ar.', 'Rajesh Sharma', …)`):
  logo prominent, tagline reads "Don't just build, Zuild!",
  no Delhi NCR tag, "Ar. Rajesh Sharma" rendered correctly.

**Concurrency note:** Batch B (Phase 7B) was running in parallel and
touches the same `app/quote.js` + `app/index.html`. Pull-rebase before
push showed no conflicts (Batch B hadn't pushed yet); after my push at
`d0799fe`, Batch B's working-tree edits appeared locally (uncommitted),
which manifested as a transient md5 mismatch between the working tree
and live until I compared `git show HEAD:app/quote.js` (clean Phase 7A)
against the live URL — those matched.

**Doctrine reinforcement (§10):** When working tree md5 ≠ live md5 in a
multi-agent shared checkout, compare `git show HEAD:<file>` md5 against
live, NOT `md5sum <file>`. Working tree may have parallel uncommitted
edits from a sibling agent.

### Phase 6.4 (May 4) — Sales-team feedback iteration (Specs system overhaul)
Three-way parallel build: items #9 (Copy Category), #11a (Basement specs),
#11c (Rich-text descriptions). All three landed in the same workday on top
of Phase 6.1 and Phase 6.3, behind a per-row `categoryGroup` state shape.

**Item 9 — Copy Category + Inline Rename (commit `8bab87a`).**
- New top-level helper `rowCategoryGroup(row)`: precedence
  `row.categoryGroup > row.override.category_label > item.category_label > 'Custom'`.
  Used by both `renderSpecList` (form list) and `renderQuote` (PDF) for
  grouping. Old quotes with no `categoryGroup` keep the catalog category —
  fully backwards-compatible.
- Spec category headers now render `✎ Rename` and `⎘ Copy` buttons. Click
  rename swaps the label for an inline `<input>`; Enter or blur stamps
  `row.categoryGroup` on every row currently resolving to the old name; Esc
  reverts. Click Copy clones every row in the category as a new category
  with **catalog defaults** (override reset to `{}`) — Varun: "Clone with
  default". Custom rows preserve their `label` only. Unique naming:
  `<cat> (Copy)`, `<cat> (Copy 2)`, etc. Clones insert directly after the
  last source row so the new group sits contiguously. New category
  auto-opens.

**Item 11a — Basement category, conditional render (this commit).**
- Catalog: 6 new items under `category="basement"`, scope `["full"]`:
  - `basement.raft_foundation` — RCC raft foundation, M25, integral crystalline.
  - `basement.retaining_walls` — 6" RCC + 4.5" brick.
  - `basement.waterproofing_system` — three-layer (Sika / Dr. Fixit / Fosroc).
  - `basement.sump_pit_dewatering` — RCC pit + dual pumps (Crompton / Bajaj).
  - `basement.height` — 11 ft floor-to-ceiling.
  - `basement.flooring` — 18mm Granite (treads/risers). Suggested rate
    ₹70/sq ft (rep enters per quote — catalog stays template-only per
    P1.5.1 fidelity rule).
- `defaultRowsFor(scope, opts)` extended: basement items only included
  when `opts.hasBasement === true`. All 5 call sites updated.
- Picker filter excludes basement-category items when `state.build.hasBasement`
  is false.
- New `syncBasementRows()` helper: on toggle ON, append missing basement
  rows in default `Basement` group; on OFF, remove default-group basement
  rows but **preserve cloned/renamed basement groups** (rep created those
  intentionally, automatic delete would surprise). Hooked into the
  `f-basement` onchange before `flush()`.
- First-load top-up: saved quotes upgraded to a build that pre-dates the
  basement category get auto-seeded with all 6 rows on next paint.
- `catOrder` updated in form-list, picker, and PDF render — Basement sits
  between Structure and Bathroom.

**Item 11c — Rich-text descriptions B/I/U (this commit).**
- Top-level `sanitizeRichText(html)`: regex-based, allows ONLY
  `b/strong/i/em/u/br`. Strips `<script>`, `<style>`, `<iframe>`, `<img>`,
  HTML comments, control chars, AND all attributes (`onclick`, `style`,
  `src`, etc.) on allowed tags. Used at save time AND at render time
  (defense in depth). Handles `null`/`undefined` gracefully → `''`.
- Description editor replaced: `<textarea>` → `contenteditable="true"`
  div with floating B/I/U toolbar. Toolbar uses `mousedown`
  (`preventDefault`) so editor selection survives. Ctrl+B/I/U keyboard
  shortcuts inside the editor. Enter inserts `<br>` (not `<div>`/`<p>`).
- `override.descriptionRich = true` flag stamped on first edit. Renderer
  (`rowFields`) returns `descIsRich`; both grid and table render paths
  branch:
    grid : `<p class="desc">${descIsRich ? sanitize : escape}</p>`
    table: `<td class="desc">${descIsRich ? sanitize : escape}</td>`
- Backwards-compat: rows without `descriptionRich` keep the
  `escapeHtml` path, so old plain-text descriptions are unchanged. Newlines
  in legacy text convert to `<br>` in the editor on first open.
- Hostile inputs tested: `<script>alert(1)</script><b>ok</b>` → `<b>ok</b>`;
  `<iframe>x</iframe><b>x</b>` → `<b>x</b>`;
  `<b onclick="alert(1)" style="color:red">y</b>` → `<b>y</b>`;
  `<img onerror=alert(1) src=z>` → empty.

**Tests:** 13 in `tests/test_phase6_4.py` (Item 9 contract via Node shim);
20 in `tests/test_phase6_4_11.py` (catalog presence, fidelity preserved,
`defaultRowsFor` branching, picker filter, syncBasementRows add/remove,
catOrder in form+PDF, sanitizer XSS resilience, rowFields descIsRich path,
render branching). 80/80 total green (Phase 5 + 6.1 + 6.3 + 6.4 + 6.4_11).

**End-to-end live verification (revision `zuildup-quotes-00019-svg`):**
Local PDF render of fixture (basement on + cloned bathroom groups +
rich-text bathroom description with bold/italic/underline) →
- 7 pages, NULLs = 0, ₹ count = 18 (≥ baseline 14).
- Basement category renders with all 6 items in the correct catOrder slot.
- Cloned bathroom groups (`(1st & 2nd Floor)` vs `(3rd & 4th Floor)`)
  render as distinct sections with their own headings and item counts.
- Vision QC (image tool) confirms B/I/U formatting is visually correct in
  the PDF: `Brand: Hettich` is **bold**, `5-year warranty` is *italic*,
  `10-year` is <u>underlined</u>.
- Live md5 of `/app/quote.js` matches local md5
  (`e1fd52a4411c6a0b4ce440ddccab38f7`).

**Concurrency:** All three items (#9, #11a, #11c) touched the same
`app/quote.js`. Item 9 landed first (rebased onto Phase 6.1, picked up
in-flight Phase 6.3 changes from working tree); 11a + 11c rebased onto
the post-#9 + Phase 6.3 master and shipped together. Catalog catOrder
list updated in 3 places (form list, picker, PDF) — kept in sync via
sed pass.

**Doctrine reinforcements (§10 candidates):**
- **FS cache lag is real.** Mid-session, the Edit tool can read a stale
  snapshot of a file while sed/python see the current disk state. Symptom:
  Edit succeeds but a follow-up grep shows the old text. Recovery: write
  via stdin'd Python heredoc that calls `pathlib.write_text` — bypasses
  the cache.
- **Build script vs hand-edited app/quote.js:** `scripts/build_quote_js.py`
  is stale. `app/quote.js` has been hand-edited since Phase 3+. Future
  edits should treat `app/quote.js` as the source of truth, not regenerate
  from the script. Either delete `build_quote_js.py` or sync it back from
  the live file.

### Phase 6.3 (May 4) — Sequential additional zones (Elevation / GST / Custom)
Triggered by sales team needing flexibility to bolt extra charges onto a quote without bending the static A-D zone math. Three new opt-in toggles, each rendered as the next sequential zone letter when enabled. Letters are dynamic — depend on which static zones the build uses.

**What shipped:**
- New `state.pricing.additionalZones` shape: `{ elevation: {enabled, desc, cost}, gst: {enabled, desc, cost}, custom: {enabled, name, desc, cost} }`. All three default off.
- New form fieldset `Additional Charges (optional)` after Area Overrides. Each block has its toggle; when on, reveals desc + cost (and Header name for Custom).
- New helper `appendAdditionalZones(c, state)` runs after `applyAreaOverrides` inside `computeQuote`. Walks the live zone letters, finds the highest in use (D normally, E if basement), assigns sequential letters to enabled additional zones in order Elevation → GST → Custom. Each zone is single-line so the Phase 5 zone-sum invariant (`zone.cost == Σ items.cost`) holds for them too.
- Cost-page renders an additional-row template per enabled zone, uses navy `.z-extra` tag, em-dash in the rate column (these are flat lump sums, not per-sqft), header label "Zone X — {Name}" where Custom uses the rep-supplied Header name (falls back to "Custom Charge" when blank).
- Grand total + zone subtotal both pick up the extra cost. No double-counting, no math drift on un-enabled zones.

**Letter assignment examples:**
- Stilt + 4 floors, no basement → static A,B,C,D ; Elevation = E, GST = F, Custom = G.
- Same + basement → static A,B,C,D,E (basement) ; Elevation = F, GST = G, Custom = H.
- Structure mode (no Zone C) → max present is D ; Elevation still becomes E (we use max-letter-+1, not skip-letter logic).

**Backwards compatibility:**
- `loadState()` per-key merges `additionalZones.{elevation,gst,custom}` so old Firestore quotes get fresh defaults without losing any rep-supplied data.
- bootForm defensively re-initialises any missing keys before binding listeners.
- Internal ids (`elevation` / `gst` / `custom`) are stable; only the display letter shifts when the basement toggle changes — saved quotes never break.

**Tests:** 15 new pytest invariants in `tests/test_phase6_3.py` covering: default-off shape, letter assignment with/without basement, all-three sequential, structure-mode skip-C handling, zone-sum invariant on additional zones, custom name fall-back, disabled-but-cost-set omission. All 41 tests green (26 phase5 + phase6_1 + 15 new).

**End-to-end live QC:** Drove the live URL with Puppeteer through 4 scenarios (all-off / GST-only / all-three / all-three-with-basement). Each PDF: NULLs=0, ₹ glyphs intact, correct subtotal + total math, correct sequential letters. Vision QC on the cost-table screenshots confirmed clean styling matching A-D rows. Live `app/quote.js` md5 == local md5 → revision verified.

**Copy update:** "GST and any liaisoning are quoted separately outside this document." → "GST and any liaisoning can be added below as a separate zone, or quoted outside this document." Points reps at the new workflow.

### Phase 6.1 (May 4) — Sales-team feedback iteration (7 polish items)
Triggered by sales team using the live tool and flagging UX rough edges. Lower-stakes than Phase 5 (no math bugs); pure polish + customer-facing PDF cleanup.

**Items shipped:**
1. **Per-line-item rate override panel opens by default** (was: only auto-opened when an override was already set; reps couldn't see line items on a fresh quote). One-line change in `renderItemRatesPanel`.
2. **Override panels now share styling.** `.aov-zone / .aov-row / .aov-name / .aov-unit` selectors in `index.html` now target both `#area-ovr-list` AND `#item-rate-list`. Previously only area panel was styled, leaving the rate panel visually misaligned.
3. *(skipped — not in scope this round)*
4. **₹ glyph in PDF — verified, no regression.** Repro on live URL produced a 13-page PDF with NULLs=0 and ₹=18 rendering as proper Indian Rupee glyphs (visual QC confirmed). The v2.3 embedded-font fix from Phase 3 is still holding. No code change needed — just QC + this note.
5. **"Set details" placeholder hidden in PDF.** Added `@media print { .rate-pill.set, .set-rate { display: none; } }` inside `quoteCss()`. Editor preview keeps the placeholder as a visual nudge; PDF emits empty so the customer never sees it.
6. **Unedited spec cards render identically to edited cards in PDF.** Added `@media print { .spec-card.unedited { background: white; border-style: solid; } .spec-card.unedited .desc { color: var(--ink); font-style: normal; } }`. Editor preview keeps the dashed/faded "this row uses catalog defaults" hint.
10. **Quote validity = 60 days, displayed on cover.** New helper `quoteValidUntil(createdIso, days = 60)` in `quote.js`. Cover page emits `<p class="cover-validity"><em>Quote valid until DD MMM YYYY</em></p>` at the end of `cover-bot`. Styled in Fraunces serif italic, gold tint matching cover aesthetic.
11b. **"Brand & Rate" column → "Rate"; brand info migrates into description.** Table view header renamed. `rowFields()` no longer composes `Brand · ₹X` into the rate cell — rate-only. For catalog defaults (no `o.description` override) where `it.brands` is non-empty, the description now leads with `Brands: BrandA · BrandB\n<original desc>` so reps can edit inline. **Back-compat:** if `o.brand_rate` was set by the old UI (free text typed by rep), we display it AS-IS in the rate column — minor mislabel on legacy quotes is acceptable; rep can clean up.

**Tests:** 13 new tests in `tests/test_phase6_1.py` lock CSS / HTML / JS invariants for items 1, 2, 5, 6, 10, 11b. Includes a Node-shim path that exercises `rowFields()` directly (it's defined inside `renderQuote`, so the shim runs renderQuote once on a synthetic state to materialise the closure-bound function onto `global`). Phase 5 suite still green (26/26 total).

**Local QC:** Rendered fixture HTML through live `/pdf` endpoint → 12 pages, NULLs=0, ₹=18, validity line "Quote valid until 03 Jul 2026" present, "Set details" count in extracted text = 0, "Brand & Rate" header gone, brand prefixes visible in descriptions. Visual QC on cover, cost, and specs pages all clean.

**Item 4 doctrine note:** Repro-first saved a font rebuild we didn't need. The 5-second NULL-byte triage from §10 is now baked into `/tmp/qb_qc/render_via_shim.js` + a fitz-based extractor; recreate after VM reboots from PROJECT_CONTEXT §11 if missing.

**Open follow-ups:**
- 11b "Phase 6.4" rich-text bold/italic in description editor (Varun's note: "rep manually adjusts; rich-text comes in 6.4").
- Item 3, 7, 8, 9 — not in this round's scope.

### Phase 5 (May 2) — Sales-team feedback fixes (4 issues)
Triggered by sales team reporting wrong zone sums, missing Concrete spec, off-by-one lift/staircase counts, and confusing line-item descriptions when areas were manually overridden.

**Fixes:**
1. **Concrete added to Structure specs.** New `structure.concrete` catalog entry (description/spec may be blank — section header always renders).
2. **Zone sum QC.** `applyAreaOverrides` had three compounding bugs:
   - `dirty` flag declared outside per-zone loop → leaked across zones, causing stale recomputes.
   - `it.cost` not recomputed after `it.area = newArea` → stale per-item costs.
   - `z.cost = z.total × z.rate` discarded per-item rate overrides — Lift at ₹3,000 silently reverted to zone-default ₹2,000 when ANY area in the zone was overridden.
   - **Fix:** scoped `zoneDirty` per zone, `it.cost = it.area × it.rate`, `z.cost = Σ(item.cost)`. Σ(rows) == zone total under all override permutations.
3. **Lift/staircase count rework.** All 3 calculator modes now use the same formula: `numFloors + (hasStilt ? 1 : 0) + (hasBasement ? 1 : 0) + 1` — the `+1` is the mumty stop (rooftop access, not billable as separate area but counted as a level for staircase steps + lift stops).
   - Basement + Stilt + 4 Floors → 7 levels
   - Stilt + 4 Floors → 6 levels
   - `calcPackage` was missing the `+1`; `calcAreaBased` already had it.
4. **Area-override description.** When `state.areaOverrides[zone:item]` is set, line description becomes generic `"as per design scope"` (replacing calc-method strings like "Floor Area (4500) − Lift (25) − Staircase (125)"). Rate-only overrides still keep the calc string.

**Tests:** 13 new tests in `tests/test_phase5.py` lock all 4 invariants. Existing suite still green.

**Live verification:** PDF rendered against live URL post-deploy confirms all 4 fixes manifest in customer artifact. md5 of local `app/quote.js` matches live (`10f00d32138dcaf3de492de141a13fe7`).

**Commits:** `d1ad3f6` (code) + `0aa343f` (docs).

**Open follow-ups:**
- If sales also wants "as per design scope" on RATE-only overrides (not just area), it's a one-line addition in `enrichZone`. Out of scope this round.
- Mumty is a stop (counted for staircase/lift) but not a billable area — flagging in case future scope changes this.

### Phase 4.1 (May 1) — Per-rep logins
- 5 individual logins (varun/karan/avish/vaishali/rajat) instead of one shared `zuildup-sales` account.
- Each quote's `author` field now records the actual creator's username; `last_edited_by` tracks who last touched it.
- Server: `requireAuth` now checks against `AUTH_USERS_JSON` env var (a JSON dict). Falls back to legacy `AUTH_USER`/`AUTH_PASS` single-user mode if not set.
- Backward compat: `zuildup-sales` / `zuildup` still works as a temporary fallback. Plan to remove it after the team has switched over.

### Phase 4 (May 1) — Cross-device quote library (Firestore-backed)
- **The problem:** quotes lived only in `localStorage`. Sales team (Karan, Avish, Varun) couldn't revisit a quote on another device or browser. If a rep cleared cache or switched laptops, work was lost.
- **The fix:** server-side quote storage in Firestore (Native, asia-south1).
  - 5 new endpoints under `/api/quotes` (GET list, GET id, POST, PUT, DELETE) behind existing Basic Auth.
  - Each quote carries `author` (creator's auth username) + `last_edited_by` so the team knows who built/touched it. Quotes are TEAM-SHARED — any authenticated user sees all quotes.
  - `QuoteStorage` keeps its **synchronous** API (so all 25+ existing call sites work unchanged) but now does background `_apiPush` on save/_touch/delete.
  - On boot AND when the Load modal opens, `syncFromCloud()` pulls remote-newer quotes into local cache + pushes local-only quotes up (one-time migration of pre-Phase-4 data).
  - Auto-save (`_touch`) is debounced 1.5s before API push to avoid hammering Firestore on every keystroke.
  - "Saving…/Synced" indicator now shows pending pushes.
  - Load modal lists author next to each quote (`by zuildup-sales`).
- **GCP setup:** Firestore Native database created in `asia-south1`. Cloud Run service account `586295767597-compute@developer` granted `roles/datastore.user` (also has Editor inherited).
- **Deps:** `@google-cloud/firestore` ^7.10 (auto-auth via metadata server on Cloud Run).
- **End-to-end verified on live URL:** save quote on device A → clear localStorage → reload → quote auto-restores from Firestore. Delete propagates cloud-ward.

### Phase 3 (Apr 30 — May 1) — Sales-team feedback iteration
- **v2 (`eb5b332`)**: per-line-item rates editable (sales asked for this), UI/PDF polish, 10 small UX changes
- **v2.1 (`6461863`)**: lift machine cost made editable
- **v2.2 (`7131532`)**: 🔥 PDF layout fixes — unified `pg-specs-flow` single section eliminates per-category orphan headers + base64-embedded fonts (offline-safe). Took the PDF from 20pp (with blanks) to 13pp dense.
- **v2.3 (`cb8a615`)**: 🔥 ₹ glyph rendering fix on cost/area pages. Embedded font subsets in v2.2 lacked U+20B9 — replaced with Fraunces latin+latin-ext (₹ in latin-ext) + custom rsms.me Inter subset with explicit ₹ inclusion.

### Phase 2 (Apr 28 — Apr 29) — Production-ready
- P0.1: catalog v2 (drop tier system, derive from customer-facing DOCX)
- P0.2: 3-mode calculator port + form rebuild + about page
- P0.3: about-page polish + breadcrumb cleanup + canonical naming
- P1.1: PDF asset inlining + spec pagination + cover UX
- P1.2: Catalog fidelity pass (restore price caps stripped during DOCX extraction)
- P1.3: Catalog modularization (catalog as template/dictionary, pricing per-quote)
- P1.4: Sales UX polish (keyboard nav, unedited-row visual, New Quote button)
- P1.5: Quote Save/Load + Multi-Customer (storage layer, modals, auto-save, export/import)
- P1.5.1: Catalog description prose-scrub
- P1.6: PDF download polish (filename, draft watermark, image compression via sharp)
- P1.7: Field validation + business rules
- Deploy: Cloud Run + Dockerfile + simpler password
- Closeout: `PROJECT_ARCHIVE.md` written, project stood down

### Phase 1 (Apr 28) — Baseline
- Catalog of 57 items
- bugs.md, mock data, builder app, end-to-end PDF export working

---

## 6. Known Issues & Watchlist

### ✅ Resolved
- ~~Blank page in PDF (orphan headers)~~ → fixed in v2.2 (unified pg-specs-flow)
- ~~"Font changed" on home page~~ → was a misread; deploy mismatch (v2.2 wasn't deployed yet)
- ~~₹ tofu / missing-glyph on cost sheet~~ → fixed in v2.3 (proper font subsets)

### 🟡 Watch
- **Firestore quotas (Phase 4):** free tier is generous (50K reads, 20K writes/day) but watch out — `_touch` fires a write every 1.5s of typing. Consider further debounce if usage spikes.
- **Embedded font subsets for non-Latin glyphs:** if anyone adds new currency/special chars (₿, ৳, ฿, etc.), they will tofu unless `used_chars.txt` is updated and `embedded_fonts.css` rebuilt. See section 8.
- **Filesystem cache lag:** Workspace FS sometimes shows phantom ENOENT for fresh writes. Workaround: `sync; sleep 1; bash -lc 'ls ...'` and prefer `stat` over `ls`.
- **Deploy != commit.** Always verify the live revision matches local HEAD via `gcloud run services describe zuildup-quotes --region asia-south1 --format='value(status.latestReadyRevisionName)'` before debugging "fix didn't work."

### 🔴 None active

---

## 7. QC / Verification Procedure

Before declaring any change "done," run this end-to-end:

### 7.1 Tests
```bash
cd /opt/openclaw/workspace/zuildup/quotation-builder
.venv/bin/python -m pytest tests/ -v
```
Expected:
- `test_catalog_fidelity` ✅
- `test_quote_storage` 8/8 ✅
- `test_p16_cdp` 4/4 ✅
- `test_p17_cdp` 4/4 ✅

> Note: `test_p16_cdp` and `test_p17_cdp` share Chrome localStorage and must run sequentially.

### 7.2 Local PDF render
```bash
cd /tmp/qb_qc
python3 render_live_pdf2.py  # full customer fixture, 13pp expected
pdftotext local_quote.pdf - | tr -cd '\0' | wc -c   # should be 0
pdftotext local_quote.pdf - | grep -o '₹' | wc -l    # should be 14
```

### 7.3 Live PDF render after deploy
```bash
# Wait for deploy then:
python3 /tmp/qb_qc/render_live_pdf2.py   # uses Basic Auth
# Check: pages == 13, NULLs == 0, ₹ count == 14
```

### 7.4 Vision QC
Use the `image` tool with a clear, perceptual prompt:
> "Is the rupee symbol (₹ — looks like R with two horizontal bars) rendering correctly on the cost page, or do you see boxes/tofu/missing-glyph squares?"

**DO NOT** ask for digit-by-digit numerical reads via the image tool — that's the confident-wrong failure mode (see MEMORY.md Apr 28). Vision is reliable for **perceptual** comparisons (glyph vs tofu, layout looks right vs broken), unreliable for **numerical** verification.

### 7.5 Cover/full visual sweep
Render pages to PNG and eyeball pages 1, 2, 7, 13 at minimum:
- Page 1: cover renders Fraunces serif tagline + customer h1 + giant Inter SVG "ZuildUp"
- Page 2: about/intro
- Page 5: cost sheet — ₹ symbols correct, totals readable
- Page 7: ~75-80% density, no orphan headers
- Page 13: T&Cs, no truncation

---

## 8. The ₹ Fix (Critical Reference)

If anyone asks "what was the ₹ fix?" — this is the canonical explanation.

**Problem:** v2.2 replaced Google Fonts CDN with base64-embedded woff2 fonts in `app/assets/embedded_fonts.css`. The default Google Fonts "latin" subset only contains ~230 glyphs (basic Latin + $/£/€ at U+20AC). It does **NOT** include ₹ (U+20B9).

When the PDF renderer hit a ₹ in the cost sheet, the glyph wasn't in the font, so headless Chrome rendered a missing-glyph tofu box. In the PDF text layer this manifests as `\x00` NULL bytes.

**Solution (v2.3):**
1. **Fraunces:** include both `latin` AND `latin-ext` subsets from Google Fonts. The `latin-ext` subset covers U+20AD–U+20C0, which includes ₹.
2. **Inter:** Google Fonts Inter `latin-ext` ALSO lacks ₹ (different subset definition). So we used **rsms.me Inter** (`InterVariable.woff2`, the official source, 2852 glyphs) and subsetted it ourselves with `pyftsubset` using a `used_chars.txt` that explicitly includes ₹.
3. **`unicode-range` declarations** in @font-face tell the browser which font to use for which codepoints.

**Result:** Belt + suspenders — both fonts now include ₹.

### Files of record
- `/tmp/qb_qc/build_embedded_fonts_v2.py` — build script
- `/tmp/qb_qc/used_chars.txt` — character whitelist used for Inter subsetting
- `/tmp/qb_qc/fonts/InterVariable.woff2` — rsms.me master (2852 glyphs)
- `/tmp/qb_qc/fonts/Inter_subset.woff2` — our 96-glyph subset (32 KB)
- `/tmp/qb_qc/fonts/fraunces_latin.woff2` — Google Fonts
- `/tmp/qb_qc/fonts/fraunces_latin_ext.woff2` — Google Fonts (contains ₹)
- `app/assets/embedded_fonts.css` — final base64-embedded CSS (213 KB)

### pyftsubset command
```bash
pyftsubset InterVariable.woff2 \
  --text-file=used_chars.txt \
  --output-file=Inter_subset.woff2 \
  --flavor=woff2 \
  --no-hinting \
  --desubroutinize \
  --layout-features='kern,liga,calt,clig,onum,tnum'
```

### To add new glyphs in future
1. Add the character to `/tmp/qb_qc/used_chars.txt`
2. Re-run `pyftsubset` to regenerate `Inter_subset.woff2`
3. Re-run `/tmp/qb_qc/build_embedded_fonts_v2.py` → produces new `embedded_fonts.css`
4. Copy to `app/assets/embedded_fonts.css`
5. Re-run `python3 scripts/build_quote_js.py` → outputs `/tmp/_quote_v2.js`, then `cp /tmp/_quote_v2.js app/quote.js`
6. Local QC → commit → deploy

---

## 9. Common Operations Cheatsheet

### Check what's live right now
```bash
gcloud run services describe zuildup-quotes --region asia-south1 \
  --format='value(status.latestReadyRevisionName,status.url)'
```

### Tail Cloud Run logs
```bash
gcloud run services logs read zuildup-quotes --region asia-south1 --limit 50
```

### Roll back to previous revision
```bash
gcloud run services update-traffic zuildup-quotes \
  --to-revisions=zuildup-quotes-00011-jq5=100 \
  --region asia-south1
```

### Compare local quote.js md5 vs live
```bash
md5sum app/quote.js
curl -s -u zuildup-sales:zuildup https://zuildup-quotes-zim2owjloq-el.a.run.app/app/quote.js | md5sum
```
If they don't match, the deploy didn't go through.

### Render live PDF and verify
```bash
python3 /tmp/qb_qc/render_live_pdf2.py
# Outputs /tmp/qb_qc/live_v23.pdf (or similar)
# Should print: pages=13, NULLs=0, ₹=14
```

### Quick local server reboot
```bash
pkill -f 'node app/server.js'
cd /opt/ocplatform/workspace/zuildup/quotation-builder
nohup node app/server.js > /tmp/_qb_server.log 2>&1 &
```

---

## 10. Doctrine (Lessons Earned)

These are the durable rules that bit us on this project. Tape them to the monitor.

1. **Deploy != commit.** The single biggest time-waster on this project was assuming v2.2 was live when it was just committed. Always verify revision before debugging.
2. **Embedded fonts are a ticking time bomb for non-Latin glyphs.** Any glyph not in your subset = tofu in production. Maintain `used_chars.txt` and rebuild fonts on any content change touching new symbols.
3. **PDF NULL byte triage is a 5-second check.** `pdftotext file.pdf - | tr -cd '\0' | wc -c`. Should be 0. Run it on every PDF QC pass.
4. **Vision QC is reliable for perception, dangerous for numbers.** Use it for "does this look broken" / "is this glyph rendered." Never "what's the total in this row."
5. **Customer-facing artifact = end-to-end verification on live URL.** Build passing ≠ done. Render the live PDF, eyeball it, then declare done.
6. **3+ commits on the same bug = stop and rethink.** Don't keep patching. The bug is a signal the architecture or mental model is wrong.
7. **FS cache lag on this VM is real.** When fresh writes seem missing, `sync; sleep 1` + use absolute paths. Don't loop on retries.

---

## 11. Quick Resume Script

If you just woke up cold and need to verify the system is healthy:

```bash
cd /opt/openclaw/workspace/zuildup/quotation-builder

# 1. Git state
git log --oneline -5

# 2. What's live
gcloud run services describe zuildup-quotes --region asia-south1 \
  --format='value(status.latestReadyRevisionName,status.url)'

# 3. Local vs live md5
md5sum app/quote.js
curl -s -u zuildup-sales:zuildup \
  https://zuildup-quotes-zim2owjloq-el.a.run.app/quote.js | md5sum

# 4. Live PDF health (if /tmp/qb_qc still exists)
python3 /tmp/qb_qc/render_live_pdf2.py 2>&1 | tail -5
```

If md5s match and PDF renders 13 pages with 0 NULLs and 14 ₹, system is healthy.

---

## 12. Contacts & References

- **Owner:** Varun Mahna (Discord `896631452937113630`, +91 9930331031)
- **Sales team:** uses live URL daily; complaints/feedback come via Discord channel `#zuildup-quotation-builder`
- **Brand contact (in PDF):** +91 92172 63051 / info@zuildup.com (NEVER use Varun's personal contact in customer artifacts)
- **Legal entity:** Infinite Proptech Private Limited (the payer behind the ZuildUp brand)

### Channel brief
`/opt/openclaw/workspace/discord-briefs/zuildup-quotation.md` — read this on every session resume in this Discord channel.

---

_End of context. If something significant changes, update this file in the same commit as the change. Don't let the context drift._
