# ZuildUp Quotation Builder — Handoff / Session Continuity Doc

**Last updated:** 2026-04-28 14:00 UTC
**Last commit:** `5d5043e` (master, pushed)
**Last tag:** `phase2-step-5-about-polish`
**Status:** P0.3 complete. Awaiting Varun's ack to proceed to P1.1 / P1.2 / P2 cleanup.

This doc is the single source of truth for what's been built, decided, and what's next, so the next session can pick up cleanly without trawling chat history.

---

## TL;DR — Where we are

ZuildUp Quotation Builder is a local Node static app that lets the sales team:
1. Enter customer + plot details
2. Pick brand specs from a 87-item catalog (auto-loaded), duplicate, customize, add bespoke items
3. Generate a multi-page branded PDF quote with cover + about + area calc + cost calc + spec list + notes

**Phase 1 shipped** (catalog 57 items from PPT, mock, end-to-end PDF). **Phase 2 in progress** (canonical recompute from customer-facing DOCX, 87 items, calculator parity, about polish, GST/liaison out, breadcrumb polish).

**Current state:** repo on GitHub at `varunmahna-creator/zuildup-quotation-builder`, app runs at `127.0.0.1:8124` via `node app/server.js`. Not deployed yet.

---

## Repo layout

```
/opt/openclaw/workspace/zuildup/quotation-builder/
├── HANDOFF.md                            ← this file
├── README.md
├── run.sh                                 ← starts node app/server.js
├── .gitignore                             (.preview-checks/ excluded)
├── .preview-checks/                       ← QC artifacts (PDFs, PNGs); gitignored
│
├── app/                                   ← the running app
│   ├── server.js                          ← static server, port 8124
│   ├── index.html                         ← form / builder UI
│   ├── quote.js                           ← rendered output JS (~53 KB, EMITTED, do not hand-edit)
│   └── preview.html                       ← (generated; or served at /preview route)
│
├── scripts/                               ← source-of-truth generators
│   ├── build_catalog.py                   ← parses customer-facing DOCX → catalog.json
│   └── build_quote_js.py                  ← Python emits app/quote.js (1057 lines JS from 1109 lines Py)
│
├── catalog/
│   └── catalog.json                       ← 87 items, current canonical (DOCX-derived)
│
├── assets/
│   ├── about/
│   │   ├── about-content.json             ← scraped + cleaned content (vision/mission/process/why/warranty)
│   │   └── _raw_dom.html                  ← raw scrape archive
│   └── lookbook/                          ← brand imagery
│
├── src_docx/
│   └── Customer_Facing_Quote_Sheet.docx   ← canonical input, md5 3e75b2277a082e66be33c8e6f690663b
│
├── src_calc/                              ← snapshot of canonical calculator HTML for reference
├── src_logo/                              ← SVG logo source
├── extracted/                             ← extracted from PPT / DOCX during phase 1/2
├── bugs/                                  ← QC notes per phase
├── mock/                                  ← phase 1 mock PDFs
└── bugs.md
```

---

## Git history & tags

```
5d5043e (HEAD, master)  Phase 2 P0.3: about-page polish + breadcrumb cleanup + canonical naming
87dd329                 p0.2 remove gst and liaison from quote calculator
4655f69                 Phase 2 P0.2: 3-mode calculator port + form rebuild + about page
9bf68ce                 Phase 2 P0.1: catalog v2 — drop tier system, derive from customer-facing DOCX
04f11b9                 Phase 1 baseline: catalog (57 items), bugs.md, mock, builder app, end-to-end PDF export
```

**Tags:**
- `phase1-baseline`
- `phase2-step-3-catalog`
- `phase2-step-4-calculator`
- `phase2-step-4-calculator-fix`
- `phase2-step-5-about-polish`  ← current

**Remote:** `https://github.com/varunmahna-creator/zuildup-quotation-builder` (collaborator: skjftp)

---

## Architecture & key decisions

### Generator-first discipline (mandatory)
- **Never hand-edit `app/quote.js`** — it's emitted by `scripts/build_quote_js.py`
- Edit Python → re-emit → smoke test from canonical paths → commit
- The 17 KB Write-tool ceiling that originally drove this also defends against drift
- Same for catalog: `scripts/build_catalog.py` reads DOCX, emits `catalog/catalog.json`

### Schema
- **State key:** `localStorage['zuildup.quote.v2']` (v1 ignored)
- **Single rate** + `brands[]` per row (v1 had per-tier rates, dropped)
- **Cost-per-sqft drives Zone A** in package mode

### Calculator (3 modes — verbatim from canonical HTML calculator)
| Mode | Use case | Zones | Rates |
|---|---|---|---|
| `stilt` | Stilt + N floors (full package) | A, B, C, D, (E if basement) | A=costPerSqft, B=Math.round(A*0.50), C=600 |
| `nostilt` | Ground + (N-1) (full package) | A, B, C, D, (E if basement) | same as stilt |
| `structure` | Structure-only quote | A, B, D, (E if basement) | A=structureRate, B=500 (STRUCT_B_RATE), no C, +1 mumty access |

**Constants (locked, canonical, do not change without re-deriving from source):**
```
C_RATE              = 600
STRUCT_B_RATE       = 500
BASEMENT_RATE       = 2700 ₹/sqft
WATER_TANK_RATE     = 15 ₹/L
WATER_TANK_PER_FLOOR = 2000 L
BALCONY_DEPTH       = 5 ft
RAMP_DEPTH          = 6 ft
STAIRCASE_PER_FLOOR = 125 sqft
LIFT_PER_FLOOR      = 25 sqft
LIFT_COST           = ₹12,00,000
```

### Cost-page output (verbatim canonical)
```
zoneSubtotal = sum of (zone A + B + [C] + D + [E]) cost
liftCost     = ₹12,00,000 if hasLift else 0
grand        = zoneSubtotal + liftCost
```

**Cost page footer rows:**
1. Sub-total (zones) → `c.zoneSubtotal`
2. Lift Machine → `c.lift.cost` *(only if hasLift)*
3. Construction Total → `c.grandTotal`

**NO GST row, NO Liaisoning row** — those are quoted separately in commercial conversation, not in the calculator. This was Varun's audit finding from P0.2; now locked.

### Quote ID
- Format: `ZB-YYYYMMDD-XXXX`
- Display: **cover only** (Varun's decision in P0.3, option (b)). Removed from breadcrumbs.

### About page
- **Source:** scraped from zuildup.com → `assets/about/about-content.json`
- **Hero H1 fix:** website's H1 is JS-animated typing; static DOM only captured "Tech Enabled Construction Quality A". Replaced with static copy: **"Tech-Enabled Construction. Quality Assured."**
- **Process cleanup:** stripped trailing next-step bleed (each step had next step's `02 2-3 Week`-style tail)
- **Warranty data structure:** pre-extracted `term` + `description` fields per warranty entry (no fragile inline regex at render time):
  ```json
  {
    "title": "Structure Warranty",
    "term": "Up to 15 Years",
    "description": "Coverage on structural integrity",
    "body": "..."
  }
  ```
  Renderer reads `w.term` directly.
- **Layout:** 1 page (was 2). Hero H1 → vision/mission grid (2 cols) → process + why-choose 2-col split → warranty 3x3 grid

### Form / UI behaviors (locked)
- Empty by default on first load
- Build type (`stilt`/`nostilt`/`structure`) auto-syncs scope
- Cost-per-sqft input: blank with placeholder `e.g., ₹2,850`
- Notes section: 2,000 char soft limit with live counter `0/2000`
- Specs: drag-reorder, +Add Custom Item, duplicate row with location/room field

---

## Phase progression

### Phase 1 — baseline (commit `04f11b9`, tag `phase1-baseline`)
- Catalog: 57 items extracted from sales PPT
- `bugs.md` written
- Mock PDFs in `mock/`
- Initial builder app shell + PDF export wired

### Phase 2 Step 0 — git setup
- Repo created, baseline pushed, skjftp added as collaborator

### Phase 2 P0.1 — catalog migration (commit `9bf68ce`, tag `phase2-step-3-catalog`)
- Dropped tier system entirely
- Re-derived 87 items from customer-facing DOCX (`src_docx/Customer_Facing_Quote_Sheet.docx`)
- `scripts/build_catalog.py` reads DOCX from stdin (`find -exec cat | python3 -`) — works around FS dentry cache wedges
- Brand curation via OVERRIDES map in build script

### Phase 2 P0.2 — calculator port (commit `4655f69`, tag `phase2-step-4-calculator`)
- 3-mode calc (stilt/nostilt/structure) ported verbatim from canonical HTML
- Form rebuild
- 7-page preview, 14-page empty-state PDF
- About page initial scrape (had bugs: H1 truncated, step bleed)

### Phase 2 P0.2 fix — GST/liaison removal (commit `87dd329`, tag `phase2-step-4-calculator-fix`)
Varun's audit found GST and liaisoning rows in the cost calc — those don't belong in the canonical calculator. They're handled in commercial conversation outside.
- Removed `pricing.gstPercent` + `pricing.liaisonCost` from state schema
- `calcPackage()` and `calcStructure()`: restored canonical `const grand = subtotal`
- Dropped `f-gst`/`f-liaison` from form hydration + listeners
- Cost page footer now just: Sub-total (zones) | Lift Machine (if hasLift) | Construction Total
- Cost lede + footnote rewritten to disclose GST/liaison are quoted separately
- **Validation:** Empty 14pp/449KB ✅ · Filled 9pp/241KB ✅
- Filled fixture: Mr. & Mrs. Test Sharma, 300 sq.yd Stilt+3 basement+lift @ ₹3,300/sqft, 25 spec rows (23 catalog + 3 dup flooring with locations + 2 custom: Bathtub + Walk-in Wardrobe), ~500 char notes. Image-tool QC verified.

### Phase 2 P0.3 — about polish + breadcrumb cleanup + canonical naming (commit `5d5043e`, tag `phase2-step-5-about-polish`) ← **CURRENT**

Six items shipped + one bonus bug fix:

1. **Quote ID cover-only** — every inner page breadcrumb now shows JUST section name in uppercase (e.g. "AREA CALCULATION"). Cover keeps Quote ID prominently.
2. **Hero H1 fix** — replaced website's animated typing fragment with static "Tech-Enabled Construction. Quality Assured."
3. **Process body cleanup** — stripped trailing next-step bleed in JSON
4. **Warranty typography** — pre-extracted `term`/`description` directly into JSON, no regex
5. **About page consolidated to 1 page** (was 2). Tighter typography (H1 22px, list items 10.5px)
6. **Orphan `.gst` CSS class** dropped (was unused after P0.2)

**BONUS BUG CAUGHT:** While renaming `subtotal` → `zoneSubtotal` per Varun's nit:
- Renderer was reading `c.zoneSubtotal` (new name)
- But calc functions still returned `subtotal` (old name)
- `fmtINR(undefined)` returns `'—'` em-dash
- → Sub-total (zones) row was rendering as `—`, NOT a number
- **Image-tool QC missed it on first review** (false positive: said "₹22,00,000")
- Only on a more precise prompt ("read EXACT text, call out blank/dash explicitly") did the model correctly read the em-dash
- **Fix:** Added `zoneSubtotal,` to BOTH `calcPackage` and `calcStructure` return shapes
- Math now matches canonical exactly: `grand = zoneSubtotal + liftCost`

**Validation:**
- Empty: 13-page PDF, 442 KB (down from 14 — About now 1 page)
- Filled: 8-page PDF, 233 KB (down from 9)
- Cost math verified rendered: Sub-total ₹3,11,38,000 + Lift ₹12,00,000 = Construction Total ₹3,23,38,000 ✅

---

## Key constraints & preferences (from Varun, accumulated)

- **SVG logo only**, never PNG
- **No pipe-tables** in rendered output; cards/lists for specs
- **Pre-flight `df -h`** before heavy file ops
- **ENOENT on fresh-write = STOP and report** (don't retry-loop blindly)
- **Trust md5sum**, not `ls`
- **Write tool ~17 KB ceiling** — use generator script or split for big files
- **Ack between each Phase 2 step**; commit + push every meaningful change; tag each step
- **Fidelity first when porting canonical** — treat missing fields as intentional unless explicitly told otherwise (esp. calculators / financial / customer-facing)
- **Validate with TWO tests** — empty-state smoke (layout sanity) + filled realistic fixture (production validation)
- **Builder workflow order:** source-of-truth generator → emit artifact → smoke test → commit (never reverse)
- **Skip Playwright** install (95% disk); headless Chrome `--dump-dom` is sufficient
- **Image tool blocks `/tmp` paths** — copy to workspace-allowed dir first
- **No sudo available** (no_new_privileges flag)
- **Image-tool QC on numbers:** unreliable by default; always demand exact digit-by-digit reads with explicit blank/dash/NaN call-outs

---

## Lessons learned this session (durable)

### 1. Test what you ship, not what you think is equivalent
Always run smoke + filled tests **from canonical app paths**, never from `/tmp/` proxies or local file copies. Customer-facing bugs (broken filename refs, server static path issues, schema drift) hide outside the canonical tree.

### 2. Two-tests rule is non-negotiable
- Empty state smoke = layout sanity (margins, page breaks, empty arrays)
- Filled realistic fixture = production validation (long names, dups, customs, edge cases)
- Either alone is insufficient

### 3. Generator-first ordering
Order: source-of-truth → emit artifact → smoke test → commit. Reversing this leads to drift and re-emit storms.

### 4. Image-tool numerical QC is unreliable by default
**Anti-pattern:** "Verify the cost page footer rows look correct" → false positive
**Fix:** Demand exact reading. Phrase: *"Tell me the EXACT text label and exact rupee amount on each row. Do not infer or guess. If a number is blank or shows '—' or 'NaN', say so explicitly."*

### 5. Python heredocs are brittle for non-trivial scripts
A `python3 <<'EOF' ... EOF` block hung silently mid-execution today on a 50-line script with `re.finditer`. Switching to file-based execution (`Write` to /tmp/foo.py + `python3 /tmp/foo.py`) worked instantly.
**Rule:** Python scripts >30 lines or with subprocess management → write to file then run. Heredoc is fine for ~10-20 line one-liners.

### 6. Server static handler path conventions
Dev `app/server.js` serves `app/foo.html` at URL `/app/foo.html`, NOT `/foo.html`.
**Rule for fixture seeding:** ALWAYS curl-test the seed URL returns 200 BEFORE the Chrome 2-step (seed + PDF). Costs 1 second, saves a full re-test cycle.

### 7. Filled-fixture seed pattern (locked)
```html
<!-- /opt/openclaw/workspace/zuildup/quotation-builder/app/_seed.html -->
<!doctype html><html><body>
<script>
const fixture = { /* ... */ };
localStorage.setItem('zuildup.quote.v2', JSON.stringify(fixture));
document.body.innerText = 'Seeded';
</script>
</body></html>
```

Then **2-step Chrome** (NOT `location.replace()` — that doesn't survive `--print-to-pdf`):
```bash
# Phase 1 — seed via dump-dom (visit URL with same --user-data-dir)
google-chrome --headless --no-sandbox --disable-gpu \
  --user-data-dir=/tmp/qb_profile \
  --virtual-time-budget=4000 \
  --dump-dom http://127.0.0.1:8124/app/_seed.html > /dev/null

# Phase 2 — PDF /preview reusing same profile
google-chrome --headless --no-sandbox --disable-gpu \
  --user-data-dir=/tmp/qb_profile \
  --print-to-pdf=/tmp/_filled.pdf --print-to-pdf-no-header \
  --virtual-time-budget=18000 \
  http://127.0.0.1:8124/preview
```

### 8. FS dentry cache wedges (recurring this session)
At 95% disk pressure, the kernel evicts dentries aggressively → `cp`, `shutil.copyfile`, `os.open(O_CREAT)`, sometimes `find -exec` return ENOENT on freshly-touched paths. Same paths visible to `cat`, `Read` tool, sometimes `Edit`.

**Workarounds:**
- Sleep 3-5s + retry (often clears it)
- `stable_open()` Python helper with retries
- Atomic write: `tmp + os.rename()` instead of direct write
- For append: `cat existing /tmp/append > /tmp/combined && mv /tmp/combined existing`
- For multi-occurrence sed: `find <parent> -name <file> -path "*/<dir>/*" -exec sed -i '/pat/d' {} \;`
- For multi-line replacements: write Python script to /tmp, then `find -exec /usr/bin/python3 /tmp/script.py {} \;`

**Root cause:** disk at 93-95% used. Below 90% noticeably reduces wedge frequency.

### 9. Disk hygiene
- Cleared `~/.npm/_npx` (861 MB) + `~/.npm/_cacache` (179 MB) + `/tmp/qb_chrome_*` profiles → 1.1 GB recovered
- `/var/log` has ~5 GB more recoverable (syslog 793 MB + 372 MB + auth.log + fail2ban) — needs **sudo** which we don't have
- **Flagged to Varun:** VM disk expansion or manual `sudo journalctl --vacuum-size=200M && sudo find /var/log -type f -name "*.log.*" -mtime +14 -delete`

### 10. From earlier today (P0.2 audit)
- GST and liaisoning are NOT in the quote calculator — they're commercial conversation
- Canonical total = Σ(zones) + lift cost only
- Customer-facing DOCX is the source of truth for catalog (PPT-derived rates dropped)

---

## Open items / next steps (in priority order)

### Awaiting Varun's ack
- P0.3 ack (this commit, `5d5043e`)
- Decision on next phase priority

### P1.1 — Cover polish (queued)
- Bigger logo (mostly done, more queued)
- Fix cover image embed in PDF (Puppeteer `networkidle0` / virtual-time-budget tuning)
- Footer cleanup
- Date below customer details (already there — confirm)
- No per-sqft mention (already not mentioned — confirm)

### P1.2 — Spec list UX verification
- Drag-reorder ✓ (verify works under filled state)
- +Add Custom Item ✓ (verify with 5+ custom rows)
- Duplicate row with location/room field ✓ (verify location persists across reload)
- Most of these were tested implicitly by the 25-row filled fixture. Need explicit confirmation pass.

### P2 cleanup (likely already shipped — verify)
- Empty form on first load ✓
- Placeholder text on inputs ✓
- Notes counter live `0/2000` ✓

### Not yet decided
- **Hosting** — still local 127.0.0.1:8124. Options: Netlify static + serverless function for PDF, or VM-served. Defer until app is feature-complete.

---

## How to resume in next session

1. Read this file (`HANDOFF.md`)
2. Read latest memory: `/opt/openclaw/workspace/memory/2026-04-28.md`
3. Read MEMORY.md for overall context (only in main session, not Discord)
4. `cd /opt/openclaw/workspace/zuildup/quotation-builder/`
5. `git log --oneline -5` to confirm at `5d5043e`
6. Start server: `node app/server.js` (port 8124)
7. Pre-flight: `df -h /opt/openclaw/` (target <90%, currently 93%)
8. Pick next item from Open Items above

### To re-run validation (smoke + filled fixture)

```bash
QB=/opt/ocplatform/workspace/zuildup/quotation-builder
cd $QB
node app/server.js > /tmp/_server.log 2>&1 &
sleep 2

# Empty state
google-chrome --headless --no-sandbox --disable-gpu \
  --print-to-pdf=/tmp/_empty.pdf --print-to-pdf-no-header \
  --virtual-time-budget=12000 \
  http://127.0.0.1:8124/preview

# Filled fixture: write fixture to $QB/app/_seed.html FIRST,
# then Chrome 2-step (see lesson #7 above)
```

### Critical files to know
- **Generator:** `scripts/build_quote_js.py` — edit this, never `app/quote.js`
- **Catalog gen:** `scripts/build_catalog.py`
- **Form HTML:** `app/index.html`
- **About content:** `assets/about/about-content.json` (just `term`/`description` data, no regex)
- **Catalog data:** `catalog/catalog.json` (87 items, DOCX-derived)
- **Source DOCX:** `src_docx/Customer_Facing_Quote_Sheet.docx` (md5 3e75b2277a082e66be33c8e6f690663b)
- **State key:** `localStorage['zuildup.quote.v2']`
- **App URL:** http://127.0.0.1:8124 (form) and /preview (rendered output)
- **Server:** `app/server.js` (Node, static)

### QC artifacts
All in `.preview-checks/` (gitignored):
- `p03_empty.pdf` — 13-page empty state
- `p03_filled.pdf` — 8-page filled fixture
- `p03_full.png` — tall stacked filled fixture
- `p03_cost.png` — cost calc page focus
- `p03_about_only.png` — about page focus
- `p03_breadcrumb.png` — breadcrumb verification

---

## Memory file references (durable knowledge)

- `/opt/ocplatform/workspace/memory/2026-04-28.md` — daily log including pre-compaction flush + P0.3 append (314 lines)
- `/opt/openclaw/workspace/MEMORY.md` — long-term curated memory (workspace-level, only in main session)

---

**End of handoff doc.** Update this file at every meaningful state change so future sessions can resume cleanly.

---

## Definitive 10-point list — Varun's Phase 1 live test feedback (audit-confirmed by Dhurandhar, 2026-04-28)

| # | Original feedback | Audit Status | Notes |
|---|---|---|---|
| 1 | Drop the package selector entirely; rate/sqft is manually entered per quote | ✅ Shipped | P0.1 / `9bf68ce` |
| 2 | Cover: bigger logo, remove per-sqft, date below address, fix footer alignment, correct contact info from zuildup.com | ✅ All sub-items verified in P1.1 | 2a bigger logo ✅ verified · 2b About H1 JSON-wired ✅ FIXED in P1.1 (was hardcoded — pre-existing P0.3 regression caught during P1.1) · 2c per-sqft removed ✅ · 2d date below address ✅ + footer alignment ✅ verified · 2e Warranty descriptions ✅ FIXED in P1.1 (was term-only — pre-existing P0.3 regression caught during P1.1) · 2f contact info ✅ |
| 3 | Add an "About ZuildUp" page (the marketing/brand page) — second page of the quote | ✅ Shipped | P0.2 / `4655f69` + P0.3 consolidated to 1 page / `5d5043e` |
| 4 | Port the canonical cost calculator from git; show area + cost as separate blocks; add notes section (hide if empty) | ✅ Shipped | P0.2 + P0.2-fix `87dd329` (GST/liaison removed) |
| 5 | Keep card-style for specs (NOT table); copy descriptions from the customer-facing quote sheet; eliminate blank-space pagination | ✅ All sub-items verified in P1.1 | Card-style ✅ + descriptions ✅ + pagination orphan-free verified on 65-row stress fixture using `<table><thead>` (display:table-header-group) so heading repeats on every continuation page per Chrome --print-to-pdf spec |
| 6 | Spec edit box collapses too quickly — UX fix | ✅ Shipped + code-level verified in P1.1 | `toggleEdit` opens only if not already editing; closes only on Done click or Escape key; no `document.click` blur listener exists. Click-outside leaves editor open. (Headed-browser test deferred — not feasible in current environment.) |
| 7 | Add custom-row functionality (bathtub, walk-in wardrobe, lawn etc.) | ✅ Shipped + verified | Tested in fixture: Free-standing Bathtub, Walk-in Wardrobe |
| 8 | Same spec row multiple times with different specs (Flooring × 3 rooms with different materials) — add Location/Room field | ✅ Shipped + verified | Tested in fixture: 3× Flooring rows with locations |
| 9 | Use quote-sheet rates as base spec sheet (no tiers) | ✅ Shipped | P0.1 catalog v2 (87 items, single rate field) |
| 10 | Cover image not embedding in downloaded PDF — bug fix | 🟢 Architecturally moot per Varun (2026-04-28); the broader PDF asset-inlining fix landed in tag `phase2-step-6-cover-and-ux` | The lookbook bg-image was Phase 1 mock only; Phase 2 cover is SVG-on-gradient (no raster). However the architectural cause (relative URLs broken when HTML rendered from `/tmp/`) is fixed defensively in P1.1 via server-side data-URL inlining. |
| Bonus | Push the code to varunmahna-creator GitHub | ✅ Shipped | Step 0 — repo `zuildup-quotation-builder`, all tags pushed |

### P1.1 / phase2-step-6 scope (in progress)
- Cover image PDF embed bug — architectural fix via data-URL inlining helper in `app/server.js` (defense for any future asset addition)
- Verify cover logo size (point 2a)
- Verify cover footer alignment (point 2d)
- Stress test pagination (point 5c) — 50+ spec rows, long descriptions, custom rows
- Manual UI test for spec edit box stickiness (point 6)

---

## P1.1 / phase2-step-6-pdf-inlining-pagination — outcomes (2026-04-28)

**Tag:** `phase2-step-6-pdf-inlining-pagination`
**Status:** ✅ All 5 sub-items addressed; bonus 2× P0.3 regressions also fixed.

### Architectural fix — PDF asset inlining (`app/server.js`)
- `inlineLocalAssets(html, baseDir)` walks the rendered HTML and replaces every relative `src=`, `poster=`, `data-src=`, `<link rel=stylesheet href=>`, and CSS `url(...)` token with a `data:` URL by reading from disk under `ROOT`.
- External `https://` references (e.g. Google Fonts) are left alone.
- `<script>` tags are stripped (the iframe DOM already reflects post-script state; re-execution would mutate it again).
- `injectImageLoadWait()` waits for all `<img>` to load + `document.fonts.ready` before signaling print-ready (defensive — Chrome still respects `--virtual-time-budget=15000`).
- `--virtual-time-budget` bumped 8s → 15s.
- **Defense-in-depth:** any future asset addition (cover hero, badges, brand logos) automatically inlines.

### Generator changes (`scripts/build_quote_js.py`) — P1.1 scope
- **Spec pagination orphan fix (point 5c):** `.cat-section` is now rendered as `<table>` with `<thead>` containing the H2 heading and `<tbody>` containing the cards grid. `display: table-header-group` causes Chrome to repeat the heading on every continuation page when a category overflows. Verified on 65-row stress fixture: every continuation page carries its category heading.
- This is the documented Chrome `--print-to-pdf` pattern for repeating headers across page breaks. Cleaner than per-category page-break (which wastes paper) and cleaner than `keep-together` (which only hides orphans for small categories).

### Bonus fixes (P0.3 regressions discovered during P1.1)
These were not in original P1.1 scope. They were caught while inspecting the About page in QC.

1. **About hero H1** now reads from `about.hero.headline` (was hardcoded as "Tech-enabled construction, delivered with 24+ years of excellence."). Now renders **"Tech-Enabled Construction. Quality Assured."** per spec.
2. **Hero subline** added below H1 (from `about.hero.subline`). Was completely missing.
3. **Warranty cards** now show `term` AND `description` (was term-only). Each card: title / term / description.

### QC artifacts (in `.preview-checks/`)
- `p11_empty.pdf` (442 KB, 13 pages) — empty-state with default 87 catalog rows
- `p11_filled_v2.pdf` / `p11_filled_v3.pdf` (267 KB, 9 pages) — 26-row realistic fixture
- `p11_stress_v3.pdf` (396 KB, 13 pages) — 65-row stress fixture, headings repeat correctly
- `p11_negtest.pdf` (75 KB, 1 page) — verifies the data-URL inliner against `<img src>`, CSS `url()`, and `<link href>`

### Page count summary

| Fixture | Pre-P1.1 | Post-P1.1 | Target | Status |
|---|---|---|---|---|
| Empty (87 default rows) | 13 | 13 | ≤14 | ✅ |
| Filled (26 curated rows) | 9 | 9 | =9 | ✅ |
| Stress (65 rows) | 12 (with orphans) | 13 (no orphans) | ≤13 | ✅ |

### Sub-item verification

| # | Item | Status | Evidence |
|---|---|---|---|
| 10 | Cover image PDF embed bug | ✅ Architecturally fixed | `p11_negtest.pdf`: 5 inlined assets (SVG + PNG + CSS bg), all rendering. Vision QC confirmed visible on rendered page. |
| 2a | Cover logo size | ✅ Verified | Vision QC: "professional and balanced, not cramped" |
| 2d | Cover footer alignment | ✅ Verified | Vision QC: bottom-left badge + bottom-right Quote ID "vertically aligned at approximately the same baseline" |
| 5c | Spec pagination | ✅ Fixed (heading repeats) | Vision QC on 65-row stress fixture: pages 2/3/4 each carry the continuing category heading at top |
| 6 | Spec edit-box stickiness | ✅ Code-level verified | `toggleEdit` opens only if not already editing; closes only on Done click or Escape key; no click-outside listener exists. UI matches spec. |

### Bonus item verification (P0.3 regressions)

| # | Item | Status | Evidence |
|---|---|---|---|
| 2b | About H1 JSON-wired | ✅ FIXED | Vision QC on filled-fixture About page: H1 reads "Tech-Enabled Construction. Quality Assured." |
| 2e | Warranty descriptions | ✅ FIXED | Vision QC: "Structure Warranty / Up to 15 Years / Coverage on structural integrity" — all 9 cards show title+term+description |

### Self-heal toolkit
**Status:** Staged in `propose/self-heal/` (not deployed). See that directory's README for sudoers ask + cron entry text.

### Phantom-FS workarounds (operational hazard, kept stale dentry caches even post-disk-resize)
- Always use git as ground truth before destructive `cat | mv` patterns
- `find -path` works when `ls` doesn't
- `cat | python3 -c '...'` works when `python3 open()` directly fails
- Sleep + retry clears most wedges (3-15 seconds)
- `Write` tool succeeds when bash `cp` fails on identical path
- See `LESSONS_LEARNED.md` lesson #8 expansion for full pattern catalog
