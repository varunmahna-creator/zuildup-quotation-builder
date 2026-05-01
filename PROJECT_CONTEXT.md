# ZuildUp Quotation Builder — Full Project Context

**Last updated:** 2026-05-01 (post Phase 4 deploy)
**Status:** 🟢 LIVE in production, Phase 4 cross-device quote library shipping

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
- **Active:** `zuildup-quotes-00014-v2v` (deployed 2026-05-01 ~11:10 UTC, Phase 4.1 — per-rep logins)
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
