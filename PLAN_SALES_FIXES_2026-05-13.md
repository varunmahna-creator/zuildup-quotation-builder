# PLAN — Sales-team Blocker Fixes (Varun, 2026-05-13)

**Status:** INVESTIGATION + PLAN ONLY. No code touched. Orchestrator to execute.
**Author:** iraaj subagent `plan-sales-fixes` (depth 1).
**Repo:** `/opt/openclaw/workspace/zuildup/quotation-builder/`

---

## 1. Pre-flight ground state (IRAAJ Rule #2 ground-truth)

### 1a. Git HEAD (literal `git log --oneline -5` output)

```
301caa3 Phase 7I (migration): heal legacy localStorage rows missing _isFresh
3e9716e Phase 7I: live verification — revision 00040-p7z confirms 28/28 rows have _isFresh=true and descriptions render
30eb3f9 Phase 7I: defaultRowsFor stamps _isFresh:true so catalog-default desc renders on new quotes
6849c51 docs: Phase 7H consolidated session record (items A/B/C/D shipped)
cbca0bd Phase 7H: JS unit tests covering Rs→₹ regex + brand de-dup + suppression
```

- HEAD = `301caa3` ✅ matches brief.
- Working tree clean (`git status --short` returned no output).

### 1b. Cloud Run revisions (literal `gcloud run revisions list` output)

```
✔
REVISION                  ACTIVE  SERVICE          DEPLOYED                 DEPLOYED BY
zuildup-quotes-00041-ls6  yes     zuildup-quotes   2026-05-13 14:35:18 UTC  openclaw@...
zuildup-quotes-00040-p7z          zuildup-quotes   2026-05-13 14:02:11 UTC  openclaw@...
zuildup-quotes-00039-xqd          zuildup-quotes   2026-05-13 09:18:44 UTC  openclaw@...
```

- Live revision = `zuildup-quotes-00041-ls6` ✅ matches brief.

### 1c. MD5 parity (literal output)

```
$ curl -s -u zuildup-sales:zuildup https://zuildup-quotes-zim2owjloq-el.a.run.app/app/quote.js | md5sum
0b9ce98297726d80d5369f937a0b1075  -

$ md5sum app/quote.js
0b9ce98297726d80d5369f937a0b1075  app/quote.js

$ git show HEAD:app/quote.js | md5sum
0b9ce98297726d80d5369f937a0b1075  -
```

**3-way MD5 parity confirmed: live = local working tree = HEAD = `0b9ce98297726d80d5369f937a0b1075`.** No drift.

### 1d. Filesystem quirk note

While investigating, the Read tool and bare `cat /opt/.../file` both fail with ENOENT for files inside `zuildup/quotation-builder/`, but `grep` works fine and `find /opt/.../quotation-builder -name FILE -exec cat {} \;` works fine. This is the same FS quirk noted in `IRAAJ_ACCOUNT_SWAP_PLAYBOOK.md`. Orchestrator should use `find -exec` or `sed`/`awk` patterns when patching.

---

## 2. Per-issue diagnosis & proposed minimal patches

### Issue 1 — PDF font + ₹ symbol rendering wrong  **[CONFIDENCE: HIGH] [RISK: MEDIUM]**

**Files + lines:**
- `app/quote.js` lines ~3720–3760: three `@font-face` declarations (Fraunces × 2 subsets + Inter × 1) inlined as base64 woff2 data URIs.
- `app/quote.js` line ~3791: `body { font-family: 'Inter', system-ui, sans-serif; }` (the cascade).
- `app/server.js` line ~340–400: Chrome-headless invocation (`--headless --no-sandbox --disable-gpu --virtual-time-budget=15000 --run-all-compositor-stages-before-draw --print-to-pdf=...`).
- `Dockerfile`: only `fonts-liberation` installed. **No `fonts-noto`, no `fonts-noto-core`, no font with U+20B9.**

**Current behavior — root cause (two compounding bugs):**

1. **₹ rendering bug.** The Inter @font-face has `unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, ...` — i.e. the standard Google Fonts **"latin" subset, which does NOT include U+20B9 (₹)**. When ₹ is rendered, Chrome consults the cascade: Inter (declines via unicode-range), `system-ui` (no system fonts in container), `sans-serif` (generic → Liberation Sans, no ₹). Result: tofu / `.notdef` rectangle. Note: Fraunces is loaded but its `font-family: 'Fraunces'` is *only* used by `h1.section`, `.eyebrow`, `.lede`, `.zus-id` — **not** by body/table cells where currency lives. Fraunces' second @font-face DOES include `U+20AD-20C0` (covers ₹), but it's not in the body cascade.

2. **Body-font monospaced appearance bug.** With `font-display: block` and a ~90 KB base64-encoded Inter woff2, plus headless Chrome with `--virtual-time-budget=15000`, Chrome SHOULD wait for the font. However, if the woff2 data URI parsing has any hiccup (or the page renders before the 3s `block` swap completes for any cell), Chrome falls back to `system-ui → sans-serif → Liberation Sans`. Varun's screenshot describes a "monospaced/typewriter" body — this is likely Liberation Sans rendered with disrupted kerning from Inter's CSS letter-spacing/font-feature-settings being applied on top of a font that doesn't support them, OR the woff2 is genuinely failing to decode in some Puppeteer/Chrome runs.

The deeper risk: **NEITHER `system-ui` NOR `sans-serif` is defined inside the Docker container** beyond Liberation Sans. The whole cascade is fragile.

**Proposed change (diff sketch — three layers, defense-in-depth):**

```diff
# Dockerfile (add Noto package for ₹ glyph + better fallback)
- RUN apt-get install -y fonts-liberation ...
+ RUN apt-get install -y fonts-liberation fonts-noto-core fonts-noto-cjk-extra \
+     && fc-cache -fv

# app/quote.js around line 3791
- body { font-family: 'Inter', system-ui, sans-serif; ... }
+ body { font-family: 'Inter', 'Noto Sans', 'Liberation Sans', system-ui, sans-serif; ... }

# app/quote.js around line 3760 (extend Inter unicode-range)
  @font-face {
    font-family: 'Inter';
    font-style: normal;
    font-weight: 100 900;
-   font-display: block;
+   font-display: block;
    src: url(data:font/woff2;base64,...) format('woff2');
+   unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+20B9, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
```

Adding `U+20B9` to Inter's declared unicode-range tells Chrome "this font claims to own ₹". If the embedded Inter woff2 has the glyph (Inter v3+ does ship ₹), it'll render. If not, Chrome will scan to the next font (Noto Sans, now installed in container) which definitely has ₹.

**Test strategy:**
- Headless render via existing PDF endpoint after change → `pdftotext output.pdf -` and `grep -c '₹'` to confirm count > 0.
- Visual diff: open both old and new PDF in `pdftocairo -png` then `compare` (ImageMagick) to verify body looks sans-serif consistent.
- Phase 7H-D unit test (`tests/test_rupee.js`) already covers source-text Rs→₹ conversion. Add a Puppeteer smoke that loads `/preview?id=test` and checks `document.fonts.check('12px Inter')` returns true.

**Risk:** MEDIUM. Docker rebuild adds ~15 MB to image (Noto packages). `fc-cache -fv` runtime negligible. The unicode-range extension is benign — if Inter's woff2 doesn't have the glyph, Chrome handles fallback gracefully. Test on staging Cloud Run revision first.

**Open question for Varun (Q1.1):** What's the "professional font we have always used"? Git log shows `7131532 Phase 3 v2.2: PDF layout fixes + offline-safe fonts` (Apr 30) introduced the current Inter + Fraunces combo. Was there an earlier font he prefers? Or is Inter the right one and we just need to fix it?

---

### Issue 2 — "Detailed Specifications" divider line doesn't span page width  **[CONFIDENCE: MEDIUM] [RISK: LOW]**

**Files + lines:**
- `app/quote.js` line ~4775: render — `<h1 class="section">Detailed Specifications</h1>` followed by `<p class="lede">…</p>`.
- `app/quote.js` line ~3856-3866: CSS rule for `h1.section { ... }` — currently has **NO border-bottom**.
- `app/quote.js` lines ~3958: `table.cat-section h2 { ... border-bottom: 1px solid var(--rule); }` — this is the per-category divider (e.g. "Architectural Layout", "Doors", etc.), constrained to the table-cell width which inherits from `<table class="cat-section">` width (which is itself 100% but possibly not extending to page-margin edges depending on the wrapper).

**Hypothesis:** Varun's screenshot is showing the divider under the FIRST category h2 below "Detailed Specifications", and that h2 lives inside a `<th>` of `table.cat-section`. The `border-bottom` is on the `h2`, not on the `th`/`tr`, so its width matches the h2's content-box, not the table width.

Alternative hypothesis: Varun wants a NEW divider/rule directly under the h1 "Detailed Specifications" itself (spanning full page width), to visually separate the section header from the content below.

**Proposed change (sketch):**

```diff
# Option A — extend the per-category h2 underline to full table width
  table.cat-section h2 {
-   border-bottom: 1px solid var(--rule);
+   /* moved to th */
  }
+ table.cat-section th {
+   border-bottom: 1px solid var(--rule);
+   padding-bottom: 6px;
+ }

# Option B — add a full-width rule under the "Detailed Specifications" h1
  h1.section {
    font-family: 'Fraunces', serif;
    font-weight: 600;
    font-size: 22pt;
    margin: 0 0 4mm;
+   padding-bottom: 3mm;
+   border-bottom: 1px solid var(--rule);
  }
```

**Test strategy:** Visual diff of the printed PDF.

**Risk:** LOW. Pure CSS change. Won't break logic.

**Open question for Varun (Q2.1):** Which line — the one directly under the bold "DETAILED SPECIFICATIONS" header, or the one under the first category subheader (e.g. "ARCHITECTURAL LAYOUT")? Screenshot would resolve this in 5 seconds.

---

### Issue 3 — Left-form section order reshuffle  **[CONFIDENCE: HIGH] [RISK: MEDIUM]**

**Files + lines:** `app/index.html` lines ~228–405. Current top-level `<fieldset>` order:

| Pos | id / class | Heading | Maps to Varun's letter |
|-----|---|---|---|
| 1 | (Customer fieldset, line ~228) | "Customer" | **(a)** User Details ✓ already first |
| 2 | (Build Config fieldset, line ~245) | "Build Configuration" | **(b)** ✓ already second |
| 3 | (Pricing fieldset, line ~285) – wraps Pricing + nested `<details id="item-rate-overrides">` + `<details id="bpf-block">` for balcony | "Pricing" | **(e)** + **(f)** — currently THIRD, needs to move down |
| 4 | `<fieldset id="area-ovr-fs">` (line ~355) | "Per-Item Area Overrides" | **(d)** Area override — currently FOURTH, needs to move to position 4 (slightly earlier) |
| 5 | `<fieldset id="floor-summary-fs">` (line ~370) | "Floor Names & Areas" | **(c)** Floor Summary — currently FIFTH, needs to move up to position 3 |
| 6 | (Additional Charges, line ~385) | "Additional Charges" | **(g)** ✓ |
| 7 | (Specifications, line ~395) | "Specifications" | **(h)** ✓ |
| 8 | (Notes, line ~402) | "Notes" | (no letter — stays after h) |

**Required new order:** a, b, c (Floor Summary), d (Area Overrides), e (Pricing rates), f (Per-line-item override + balcony), g, h, Notes.

**Complication:** items (e) and (f) are currently CONCATENATED inside one `<fieldset>` ("Pricing"). The "Per-line-item override (including balcony)" is `<details id="item-rate-overrides">` + `<details id="bpf-block">` nested inside that fieldset. Varun wants (f) as a separate top-level step AFTER (e).

**Proposed change (sketch):**

1. Cut `<fieldset id="floor-summary-fs">` (lines ~370–384) and paste BEFORE the current Pricing fieldset (i.e. right after Build Configuration, position 3).
2. Cut `<fieldset id="area-ovr-fs">` (lines ~355–369) and paste AFTER Floor Summary (position 4).
3. Split the Pricing fieldset: extract `<details id="item-rate-overrides">` + `<details id="bpf-block">` into a NEW `<fieldset>` titled "Per-Line-Item Overrides" placed AFTER the (slimmed-down) Pricing fieldset.
4. Leave (g), (h), Notes as-is.

**Test strategy:** Manual UX walkthrough — load a quote, verify sections appear in correct order in left form. Check `getElementById('floor-summary-fs')` still resolves (any JS that references these IDs by getElementById will continue to work regardless of DOM position — but check for any code that relies on `.previousElementSibling` / `.nextElementSibling` traversal).

**Risk:** MEDIUM. Pure DOM rearrangement, no logic change, but a careless cut/paste could break event listeners or innerHTML references. Need to verify no `.parentElement.parentElement.querySelector(...)` patterns are walking up from inside these fieldsets.

**Open question for Varun (Q3.1):** When splitting Pricing into "rates" vs. "per-line overrides", what's the heading for the new sub-section? Suggest "Per-Line Overrides (rates + balcony)".

---

### Issue 4 — Left-side line items not collapsed by default  **[CONFIDENCE: MEDIUM] [RISK: LOW]**

**Files + lines:** `app/index.html`:
- Line ~358: `<details id="area-ovr-collapse" open>` — Per-Item Area Overrides default-expanded
- Line ~372: `<details id="floor-summary-collapse" open>` — Floor Names & Areas default-expanded

The individual SPEC cards (inside the Specifications section) are NOT `<details>` elements — they're divs that toggle on click via `state._uiCardOpen` (lines ~3090–3170 of quote.js). Categories are collapsed-by-default via `state._uiCatOpen[cat]` defaulting to falsy (line ~2815). **So spec line items are already collapsed by default.**

**Hypothesis:** Varun's "all the line items in left side have to be collapsed by default" most likely refers to the two `<details open>` blocks above (#4 + #5 in the section order list), which always render expanded on load.

**Proposed change (sketch):**

```diff
# app/index.html line 358
- <details id="area-ovr-collapse" open>
+ <details id="area-ovr-collapse">

# app/index.html line 372
- <details id="floor-summary-collapse" open>
+ <details id="floor-summary-collapse">
```

**Test strategy:** Load a quote, verify Area Overrides and Floor Summary sections start collapsed with a "▶" affordance.

**Risk:** LOW. Single-attribute removal. Possible: if quotes are loaded with existing data, sales team might prefer to see the entered values immediately — collapsing them hides current state. May want JS to auto-open if any data is non-default. (Open question Q4.1 below.)

**Open question for Varun (Q4.1):** When loading an existing quote with already-customised areas/floor names, should those sections auto-expand (because the rep needs to see/edit existing values), or stay collapsed (cleaner)?

---

### Issue 5 — Cost calculation sheet must fit one page  **[CONFIDENCE: MEDIUM] [RISK: MEDIUM]**

**Files + lines:** `app/quote.js`:
- Line ~4565–4620: render of `<section class="pg cost-calc-page">`.
- CSS for `.calc-table tbody tr.cost-item-row td { padding: 5px 10px; font-size: 11.5px; }` etc.
- CSS for `.cost-totals-sub td` and `.cost-totals-grand td { padding: 10px ... }`.
- Bottom: optional `<div class="cost-notes-block">` rendered if `state.entry.notes` non-empty.

Current page has:
- 1 lede paragraph (~6mm + 7mm vertical margin)
- Calc table with N item rows (5px × 2 = 10px row padding + 11.5px font + 1.4 line-height) ≈ 22 px per row → ~7.5 mm per row → 10 rows = 75 mm
- Subtotal row + grand-total row (10 px padding each, larger font) ≈ 15 mm
- Optional notes block

A4 page = 297 mm, minus 25 mm top/bottom margins = 247 mm content. Page-foot takes ~20 mm. So usable = ~225 mm. The cost-calc section can overflow when notes are long OR when 12+ line items exist.

**Proposed change (sketch — tighten without rebuilding):**

```diff
# app/quote.js cost-calc-page CSS
- .calc-table tbody tr.cost-item-row td { padding: 5px 10px; font-size: 11.5px; line-height: 1.4; }
+ .calc-table tbody tr.cost-item-row td { padding: 3.5px 10px; font-size: 11pt; line-height: 1.3; }

- .calc-table tr.cost-totals-sub td { padding: 10px; font-size: 12px; }
+ .calc-table tr.cost-totals-sub td { padding: 7px 10px; font-size: 11.5pt; }

- .calc-table tr.cost-totals-grand td { padding: 10px; font-size: 13.5px; }
+ .calc-table tr.cost-totals-grand td { padding: 8px 10px; font-size: 13pt; }

- .cost-calc-page p.lede { margin: 0 0 6mm; ... }
+ .cost-calc-page p.lede { margin: 0 0 4mm; ... }

# Optionally cap notes block height + scroll-marker:
+ .cost-notes-block { max-height: 35mm; overflow: hidden; }
+ .cost-notes-block.truncated::after { content: "… see notes page"; ... }
```

**Test strategy:**
- Generate a PDF with 14 cost-line-items + 200-char notes (worst case).
- Assert: `pdfinfo cost-calc-only.pdf | grep '^Pages:'` returns `Pages: 1`.
- Add Puppeteer test that measures `.cost-calc-page` `scrollHeight` vs `clientHeight` — must be equal.

**Risk:** MEDIUM. Aggressive font/padding shrinkage can hurt readability. Notes truncation is a usability call — confirm with Varun.

**Open question for Varun (Q5.1):** If notes are long, should we (a) truncate with a "see notes page" pointer, (b) hide notes from cost-calc (they appear elsewhere), or (c) auto-shrink font further? Recommendation: (b), since notes already have a dedicated end page.

**Interaction with Issue 6:**

The "line after area calculation" (Issue 6) — if it's the `.pg-foot` border-top showing through with empty space, removing or thinning it on the cost-calc page may free 2–3 mm. Combined effect could be sufficient without aggressive shrinkage.

---

### Issue 6 — Remove line after Area Calculation  **[CONFIDENCE: LOW — needs clarification] [RISK: LOW]**

**Files + lines:** `app/quote.js`:
- Line ~4487: `<p class="lede">Continued on next page →</p>` rendered inside area-calc section.
- Lines ~3825: `.pg-foot { border-top: 1px solid var(--rule); ... }` — visible horizontal rule at bottom of every page.
- Line ~3958: `.cat-section h2 { border-bottom: 1px solid var(--rule); }` — visible under EACH category sub-heading.

**Three plausible interpretations of Varun's "line after area calculation":**

1. The `<p class="lede">Continued on next page →</p>` paragraph at line 4487 — shown only when content paginates. Verbose AND consumes ~10 mm.
2. The `.pg-foot` border-top — a thin 1 px horizontal rule under the page-foot, present on every page including area-calc.
3. A divider/rule between the area-calc table totals row and whatever follows (next page break or notes section).

Without seeing Varun's screenshot of the area-calc page, I cannot disambiguate confidently. Best guess (60%): #1 — the lede paragraph. If area-calc fits cleanly on one page, this line shouldn't render anyway; the fact that Varun mentions an empty space then the line suggests it's the "Continued on next page →" cruft.

**Proposed change (sketch — for hypothesis #1):**

```diff
# app/quote.js line ~4487
- ${needsContinuation ? '<p class="lede">Continued on next page →</p>' : ''}
+ ''  // remove entirely — page break alone is sufficient signal
```

If hypothesis is wrong, alternate fix is to scope `.pg-foot` border-top out of the area-calc page or remove a specific divider element.

**Test strategy:** Visual diff before/after on the area-calc page.

**Risk:** LOW. Cosmetic removal.

**Open question for Varun (Q6.1):** Could you screenshot the EXACT line you want removed and annotate? Three candidates above.

---

### Issue 7 — Electrical UPS/EV/Solar shows "Included" when user blanks the field  **[CONFIDENCE: HIGH] [RISK: LOW]**

**Files + lines:**
- `catalog/catalog.json` lines ~965–1015: UPS wiring, EV Charging Point, Solar Electrical Provision entries each have `"rate_text": "Included"`.
- `app/quote.js` line ~4630 (inside `rowFields(...)`): the fallback logic.

**Current code snippet (line 4630 area):**

```js
let brandRate = (o.brand_rate !== undefined) ? o.brand_rate : '';
if (!brandRate) {
  const rt = (o.rate_text !== undefined) ? o.rate_text : ((it && it.rate_text) || '');
  if (rt && rt.trim()) brandRate = rt;
}
```

**Bug:** The check `if (!brandRate)` treats empty-string `''` (user explicitly blanked the input) the same as `undefined` (never set). So when the user types something in the rate field and then clears it back to empty, `o.brand_rate === ''` (truthy that user-set, falsy as value), and the fallback to `it.rate_text = "Included"` kicks in. Net result: blank in UI → "Included" in PDF.

**Proposed change (sketch):**

```diff
- let brandRate = (o.brand_rate !== undefined) ? o.brand_rate : '';
- if (!brandRate) {
-   const rt = (o.rate_text !== undefined) ? o.rate_text : ((it && it.rate_text) || '');
-   if (rt && rt.trim()) brandRate = rt;
- }
+ let brandRate;
+ if (o.brand_rate !== undefined) {
+   brandRate = o.brand_rate;  // respect user value, even if empty string
+ } else if (o.rate_text !== undefined) {
+   brandRate = o.rate_text;
+ } else {
+   brandRate = (it && it.rate_text) || '';
+ }
```

The key change: when `o.brand_rate !== undefined` (user has touched the field), use that value verbatim — do NOT fall through to catalog default. Same pattern for `rate_text`.

**Test strategy:**
- Unit test: stub a row with `override.brand_rate = ''`, call `rowFields`, assert `f.brandRate === ''` (no "Included" fallback).
- Manual: open Electrical section → UPS row → type "₹15,000" → save → reopen → clear field → save → preview → assert no "Included" appears.

**Risk:** LOW. Self-contained change.

---

### Issue 8 — Brand de-dup regression: clearing brand to blank still renders an empty line  **[CONFIDENCE: HIGH] [RISK: LOW]**

**Files + lines:**
- `app/quote.js` line ~3256: contenteditable blur handler stores `override.brand`.
- `app/quote.js` line ~4673–4677: `rowFields` brand assignment.
- `app/quote.js` line ~4710 + ~4744: render: `const brandHtml = f.brand ? '<div class="spec-brand">...' : '';`.

**Current behaviour (the bug):**

The render gate `f.brand ? ... : ''` is correct — empty string SHOULD collapse to nothing. But the upstream value `f.brand` is **not empty** when user "clears" the field. When a user empties a contenteditable `<div>`, the browser leaves residual HTML: typically `<br>`, `<div><br></div>`, or `&nbsp;`. Line 3256:

```js
state.rows[idx].override.brand = sanitizeRichText(e.target.innerHTML);
```

After `sanitizeRichText`, the residual might become `"<br>"` or `"&nbsp;"` or whitespace — all truthy. Then in `rowFields` (line 4673):

```js
if (o.brand !== undefined) {
  brand = o.brand || '';   // o.brand = '<br>' → brand = '<br>' (truthy)
}
```

Then render: `f.brand ? '<div class="spec-brand"><b>...</b></div>' : ''` → emits `<div class="spec-brand"><b><br></b></div>` — **an empty line with vertical space**.

**Proposed change (sketch — two layers, both recommended):**

```diff
# app/quote.js line ~3256 — normalise empty contenteditable to '' at WRITE time
- state.rows[idx].override.brand = sanitizeRichText(e.target.innerHTML);
+ {
+   const raw = sanitizeRichText(e.target.innerHTML);
+   const plain = raw.replace(/<br\s*\/?>/gi, '').replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').trim();
+   state.rows[idx].override.brand = plain ? raw : '';
+ }

# app/quote.js line ~4710 — defence-in-depth in render gate
- const brandHtml = f.brand
+ const brandPlainTest = (f.brand || '').replace(/<br\s*\/?>/gi, '').replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').trim();
+ const brandHtml = brandPlainTest
    ? `<div class="spec-brand"><b>${f.brandIsRich ? sanitizeRichText(f.brand) : escapeHtml(f.brand)}</b></div>`
    : '';
```

The WRITE-time normalisation prevents the bug at source. The RENDER-time gate guards against legacy data already saved in this state.

**Test strategy:**
- Extend `tests/test_brand_dedup.js` (Phase 7H-A): add cases `brand="<br>"`, `brand="&nbsp;"`, `brand="  "`, `brand="<div><br></div>"` — all must collapse.
- Manual: type "Asian Paints", save, edit to clear, save again, preview → no blank line.

**Risk:** LOW. Both changes are conservative additions; existing valid brand values (with `<b>`, `<i>` rich formatting) remain untouched.

---

## 3. Suggested execution order

**Tier 1 — easy CSS/HTML wins, ship today (low risk, high relief):**
1. **Issue 4** (remove `open` from two `<details>`) — 30 seconds.
2. **Issue 2** (CSS rule for spec divider) — 2 min once Q2.1 answered.
3. **Issue 6** (remove "Continued on next page →") — 2 min once Q6.1 answered.
4. **Issue 5** (tighten cost-calc CSS) — 10 min, partly depends on Issue 6 outcome.

**Tier 2 — JS logic fixes, ship today (medium risk, requires unit test):**
5. **Issue 7** (rate fallback bug) — 10 min including test.
6. **Issue 8** (brand blank-edit bug) — 15 min including test extension.

**Tier 3 — bigger refactor, ship after Tier 1–2 verified:**
7. **Issue 3** (left-form section reorder + Pricing split) — 30–45 min, needs UX review.

**Tier 4 — infra change, ship LAST and on its own deploy:**
8. **Issue 1** (Docker fonts + CSS cascade + Inter unicode-range) — 30 min coding, 5–10 min Cloud Build, then Cloud Run rollout. **Deploy separately** so if PDF rendering regresses, we can roll back fonts without losing the other fixes.

---

## 4. Estimated complexity (by category)

| Category | Issues | Why |
|---|---|---|
| CSS/HTML one-liners | 2, 4, 6 | Pure presentation, no logic |
| CSS multi-line tightening | 5 | Multiple selectors, but no logic |
| JS data-binding bug | 7, 8 | Localised to `rowFields` + blur handler |
| DOM rearrangement | 3 | index.html cut/paste + verify no parentElement traversal breaks |
| Docker + cross-cutting CSS | 1 | Image rebuild, font cascade, unicode-range |

---

## 5. Open questions for Varun

| Q | Issue | Question |
|---|---|---|
| Q1.1 | 1 | Which font is "the professional font we have always used"? Git suggests Inter (since Apr 30 `7131532`). Confirm or name preference. |
| Q2.1 | 2 | Screenshot: divider under main "DETAILED SPECIFICATIONS" h1, or under first category subheading? |
| Q3.1 | 3 | Heading text for new "Per-Line Overrides" fieldset when splitting Pricing? |
| Q4.1 | 4 | When loading an existing quote with customised data, should Area Overrides / Floor Summary auto-expand if data is non-default, or always start collapsed? |
| Q5.1 | 5 | If cost-notes block is long: truncate-with-pointer, hide-on-cost-calc-page, or auto-shrink? |
| Q6.1 | 6 | Three candidate "lines" after area calc — which one? Screenshot would resolve. |

---

## 6. IRAAJ Rule #2 contract

This document represents the planning subagent's commitments. The orchestrator (main session) will:
1. Execute Tier 1 + Tier 2 fixes as one atomic commit + deploy, verify live MD5 + Cloud Run revision changed, post evidence.
2. Then Tier 3 in a separate commit.
3. Then Tier 4 (fonts) in a separate Cloud Build + deploy with rollback plan documented.

Subagent does NOT claim any commits, deploys, or live verification — those are orchestrator-only actions, gated by explicit Varun confirmation per the new IRAAJ post-mortem rules.

— end of plan —
