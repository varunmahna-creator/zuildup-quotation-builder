# Session Log — Zuildup Quotation Builder
**Period:** 2026-05-14 → 2026-05-15
**Agent:** Iraaj (Claude Opus 4.7)
**Driver:** Varun Mahna
**Live URL:** https://zuildup-quotes-zim2owjloq-el.a.run.app/ (basic auth `zuildup-sales:zuildup`)
**Cloud Run:** project `zuildup-quotes`, service `zuildup-quotes`, region `asia-south1`
**Repo:** `/opt/openclaw/workspace/zuildup/quotation-builder`

---

## Headline summary

Two-day saga to fix font rendering in downloaded PDFs and a handful of sales-rep-reported polish issues. The font fight needed **four** phases (7L → 7M → 7N → 7O) because each fix revealed a deeper root cause. Layout polish landed cleanly in Phase 7P / 7P-2.

**Current live revision: `zuildup-quotes-00049-wsc`** (Phase 7P-2, deployed 2026-05-15 17:38 UTC, 100% traffic)

---

## Phase 7L — Sales-fix batch B+C+D (2026-05-14)
**Commit:** `366ce86` (code), `66e94c3` (doc)
**Doc:** `PHASE_7L_2026-05-14.md`

8 sales-rep fixes in one batch:
- Inter + Fraunces inlined as base64 woff2 inside `quoteCss()` so PDF doesn't depend on Google Fonts CDN (Cloud Run print container has no internet).
- `<h1 class="section">` underline rule extended to full content width.
- Area-calculation divider lines cleaned up.
- Cost-calculation page packed onto a single page.
- Form section reorder: Customer → Build Config → Floor Summary → Area Overrides → Pricing → Per-Line Item Override → Additional Charges → Specifications → Notes.

Status at end of 7L: PDF rendered with embedded fonts, but ₹ (U+20B9) showed tofu in headings.

---

## Phase 7M — ₹ glyph + font subset fix (2026-05-14)
**Commit:** `cf559e5` (code), `73b708b` (doc)
**Doc:** `PHASE_7M_2026-05-14.md`
**Revision:** `zuildup-quotes-00045-rgc`

**Root cause:** Chrome `--print-to-pdf` didn't honor `unicode-range` to pick between Fraunces latin / latin-ext subset splits. The on-disk `Fraunces-{400,600,700}.woff2` files were latin-only (222 glyphs, no ₹).

**Fix:**
- Replaced 3-block `@font-face` (Fraunces latin + Fraunces latin-ext + Inter) with **two full-coverage variable woff2 blocks**: `Fraunces.var.woff2` (637 glyphs, ₹ included) + `Inter.var.woff2` (2,852 glyphs, ₹ included).
- `font-display: block` → `swap` for better print behaviour.
- Removed Google Fonts `@import` from `preview.html` (last network dependency).
- Dropped stale `Fraunces-{400,600,700}.woff2` files.
- Three-way MD5 verified.

Status at end of 7M: I told Varun "shipped + verified." He came back saying body text still looked like Helvetica. I had verified Type0 embedding on a **synthetic test** (a minimal HTML with just the @font-face blocks), not the real preview HTML. The fix worked in isolation but failed in production.

---

## Phase 7N — Replace `--print-to-pdf` CLI with puppeteer (2026-05-15)
**Commit:** `7a3191e` (code), `47c14ff` (doc — honest "not fixed" report)
**Doc:** `PHASE_7N_2026-05-15.md`
**Revision:** `zuildup-quotes-00046-wwm`

**Initial hypothesis (WRONG):** Chrome `--print-to-pdf --virtual-time-budget=15000` was racing font decode. Virtual time is a virtual clock; real-time font parsing might not complete before snapshot.

**Fix attempted:**
- Migrated `app/server.js` `renderPdf` from `spawn('google-chrome', ['--print-to-pdf', ...])` to **puppeteer-core**.
- Added explicit `await page.evaluate(() => document.fonts.ready)` before `page.pdf({ format: 'A4', ... })`.
- Kept callback signature so the rest of the pipeline didn't change.
- Added `puppeteer-core@^25.4.0` (system Chrome via `executablePath`, `PUPPETEER_SKIP_DOWNLOAD=1`).

**Verification result: Inter STILL didn't embed.** PDF still showed `LiberationSans-Bold` as body font. Fraunces still worked.

**Deeper investigation:** drove puppeteer locally against the same preview HTML and inspected `document.fonts`:
```json
{
  "Fraunces": "loaded",
  "Inter":    "error"   <-- net::ERR_INVALID_URL
}
```
**Chrome was rejecting the Inter base64 data URI at the network layer**, before any parsing or rendering. The Inter base64 (~459 KB encoded for the 270 KB variable woff2) hit a Chrome data-URL ceiling. Fraunces (smaller, ~268 KB encoded) snuck through.

Reported honestly: "code shipped, hypothesis wrong, need Phase 7O."

---

## Phase 7O — Serve fonts over HTTP, not base64 (2026-05-15) ✅
**Commit:** `0cc0292` (code), `1f17456` (doc)
**Doc:** `PHASE_7O_2026-05-15.md`
**Revision:** `zuildup-quotes-00047-zs6`

**Root cause (confirmed):** Chrome rejects very large `data:` URIs inside `<style>` `@font-face src`. Soft ceiling ~400 KB encoded, varies by context.

**Fix:**
1. Added public `GET /fonts/:name` endpoint in `app/server.js`, mounted **BEFORE** basic-auth middleware. Whitelist: `Inter.var.woff2`, `Fraunces.var.woff2` only. `Content-Type: font/woff2`, `Cache-Control: public, max-age=31536000, immutable`. No auth — puppeteer's fetch needs to succeed without creds.
2. In `renderPdf`, inject `<base href="http://127.0.0.1:${PORT}/">` as the first tag inside `<head>` of the HTML before `page.setContent`. Without it, `page.setContent`'s default base is `about:blank` and `/fonts/...` won't resolve.
3. Updated `quoteCss()` `@font-face` rules:
   - **Before:** `src: url("data:font/woff2;base64,d09GMgABAAAA…")` (~620 KB of inline base64)
   - **After:** `src: url('/fonts/Inter.var.woff2') format('woff2-variations');`
4. `quote.js` shrank from 988 KB → 244 KB (−744 KB).

**End-to-end verification:**
- Live `/fonts/Inter.var.woff2` returns HTTP 200, 352240 bytes, MD5 matches `app/fonts/Inter.var.woff2` exactly.
- Captured fresh real-preview HTML via puppeteer driving the deployed app.
- POSTed to live `/pdf`:
  ```
  $ strings /tmp/quote_7o.pdf | grep -iE "basefont|fontname" | sort -u
  /FontName /AAAAAA+InterVariable           ← ✅
  /FontName /ABAAAA+Fraunces-9ptBlack       ← ✅
  ```
- **No LiberationSans, no system fallback.** Both fonts properly subset and embedded as Type0.
- Three-way MD5 parity: working tree == HEAD == LIVE.

**Status: SHIPPED + VERIFIED end-to-end.** Real Inter, real Fraunces, real ₹.

---

## Phase 7P — Remove duplicate "Plot Area" subtitle (2026-05-15)
**Commit:** `9ab2835`
**Revision:** `zuildup-quotes-00048-949`

**Trigger:** Varun screenshot of page 3 — "Plot Area — 240 Sq. Yard / 2,160.00 Sq. Ft." line appeared between the "Floor Area Summary" heading and the table. The same info was already shown in the metrics row above. Pure duplication.

**Fix:**
- In `renderFloorSummaryTable()` (`app/quote.js` line ~4334), removed the `subtitle` const and the `<p class="floor-summary-subtitle">` markup line.
- Orphan CSS rule `.floor-summary-subtitle` left in the stylesheet as dead code (harmless — flagged for future cleanup).
- Three-way MD5 verified: `5f19348b10db1492e33ce4677f4cab5f`.

---

## Phase 7P-2 — Specs default + lede full-width + cleanup (2026-05-15)
**Commit:** `cf0b631`
**Revision:** `zuildup-quotes-00049-wsc` ← **current live**

**Trigger:** Varun screenshot of Detailed Specifications page — page was rendering grid (cards) instead of table, and the "Every line item, every brand, every rate…" lede paragraph was constrained to ~440px / 116mm while the heading underline below it spanned 170mm content width. Misaligned.

**Fix #1 — force specs layout to `'table'` on load:**
- Both `loadState` branches (named slot + scratch state) now override `specsLayout: 'table'` after the `{...d, ...s}` shallow merge.
- Legacy quotes saved before the 2026-05-13 default flip had `'grid'` baked into their state — these now render as table.
- Reps can still pick "Grid (cards)" from the toolbar dropdown in-session; that choice won't persist across reload (acceptable since per Varun "default view had to be table").

**Fix #2 — specs lede paragraph spans full content width:**
- `p.lede` has a global `max-width: 440px` rule (looks good on cover and intro pages).
- Specs page already overrode `min-height` and other rules under `.pg.pg-specs-flow .lede`. Added `max-width: none` to that override.
- Result: specs lede now stretches the full 170mm content width — same as the heading underline.

**Fix #3 — cleanup:** dropped two stray test artifacts (`_hardik_reference_quote.pdf`, `_zone_j_full.jpg`) that accidentally got swept into commit `9ab2835`.

**Three-way MD5 parity:** working tree == HEAD == LIVE = `0c810e07c8e372a16f5b8c538e0592ac`.

---

## Files changed (cumulative across 7L–7P-2)
| File | Change |
|------|--------|
| `app/quote.js` | font @font-face rewritten 3× (b64 → HTTP), CSS polish, loadState specsLayout migration, removed duplicate Plot Area subtitle, specs lede full-width override, form section reorder |
| `app/server.js` | added `inlineLocalAssetsAsync` (Phase 7L), replaced `--print-to-pdf` CLI with puppeteer-core (7N), added `GET /fonts/:name` public endpoint + `<base href>` injection (7O) |
| `app/preview.html` | dropped Google Fonts `@import` (7M) |
| `app/fonts/Fraunces.var.woff2` | NEW (7M) — 211 KB full-coverage variable, ₹ included |
| `app/fonts/Inter.var.woff2` | NEW (7M) — 270 KB full-coverage variable, ₹ included |
| `app/fonts/Fraunces-{400,600,700}.woff2` | REMOVED (7M) — were latin-only, no ₹ |
| `package.json` / `package-lock.json` | added `puppeteer-core@^25.4.0` (7N) |
| repo root | removed stray `_hardik_reference_quote.pdf`, `_zone_j_full.jpg` (7P-2) |

---

## Cloud Run revision history (today)
| Revision | Deployed (UTC) | Phase | Notes |
|----------|---------------|-------|-------|
| `00043-6tv` | 2026-05-14 | 7L | base64 fonts inlined |
| `00045-rgc` | 2026-05-15 11:18 | 7M | variable woff2, ₹ everywhere |
| `00046-wwm` | 2026-05-15 13:07 | 7N | puppeteer-core, fonts.ready wait |
| `00047-zs6` | 2026-05-15 16:23 | 7O | HTTP-served fonts ✅ INTER FIX |
| `00048-949` | 2026-05-15 17:29 | 7P | Plot Area subtitle removed |
| `00049-wsc` | 2026-05-15 17:38 | 7P-2 | **CURRENT LIVE** — specs table default + lede full-width |

---

## Lessons captured (for `MEMORY.md` / future sessions)

### 1. Verify on REAL preview HTML, not synthetic
**Mistake:** In 7M I declared "shipped + verified" because Inter embedded correctly in a synthetic HTML containing just the @font-face blocks. Varun came back saying production still looked like Helvetica.
**Lesson:** Synthetic tests prove the FIX is technically correct. They don't prove it works in the real pipeline. For "shipped" status: capture real preview HTML from the deployed app and verify embedding in THAT.

### 2. `data:` URIs have soft size ceilings in Chrome
Chrome rejects `data:font/woff2;base64,…` payloads above ~400 KB encoded with `net::ERR_INVALID_URL`, especially when inside `@font-face src` in inline `<style>`. Fonts > 200 KB raw should be served over HTTP.

### 3. `page.setContent` defaults base URL to `about:blank`
Relative URLs (`/fonts/...`, `/images/...`) won't resolve unless you inject `<base href="http://...">` before `page.setContent`, or use `page.goto()` against a real URL.

### 4. `font-display: swap` + `--print-to-pdf` was a separate latent bug
Even if Chrome had accepted the Inter data URI, the one-shot print-to-pdf snapshot races font decode. With `swap`, system fallback gets baked in if fonts haven't parsed at capture moment. Puppeteer + `await document.fonts.ready` is the durable pattern. (We kept this 7N change in place — it's still the right architecture.)

### 5. Three-way MD5 verification is non-negotiable
Working tree == HEAD == LIVE. If any leg disagrees, "shipped" is a lie. This caught the 7M false-positive (HEAD claimed fix but LIVE-served PDF still missed Inter — not actually a deploy mismatch, but the discipline pushed me to look closer).

### 6. Three-strikes architectural pause
Per IRAAJ Three Rules: 3+ commits on the same bug = stop and rethink the design. I hit four commits on the font bug (7L → 7M → 7N → 7O). The architectural rethink — "abandon clever base64 inlining, just serve over HTTP like every other web font in the world" — is what finally fixed it. Should have hit that rethink at 7N, not 7O.

### 7. VM FS race
`ls` / `cat` / `cd` can return ENOENT for 5–10 seconds after compute-heavy operations (Cloud Build, puppeteer launches, large file writes). Always retry with `sleep 5–10` and use absolute paths. Use `cp src dst && ls dst` as a poor-man's sync barrier.

### 8. Cloud Run deploy timing
`gcloud run deploy --source .` with the current Dockerfile takes ~3–5 minutes (Cloud Build upload + image build + revision rollout). Don't background with `nohup` — known to silently die at "Uploading sources." Run synchronously, watch the gcloud log file at `~/.config/gcloud/logs/YYYY.MM.DD/HH.MM.SS.…log` for live status.

---

## Open / known-harmless items
- Orphan `.floor-summary-subtitle` CSS rule still in stylesheet (dead code — flagged for next quote.js touch).
- `_hardik_reference_quote.pdf` and `_zone_j_full.jpg` deleted but were briefly in commit `9ab2835`. They were test artifacts, never user-data.
- `master` branch is 11 commits ahead of `origin` (not yet pushed). Should `git push` when convenient.

---

## Pending / next likely asks
- Continued sales-rep QC of the live builder. If more polish issues land, expect them as screenshots in this channel.
- Possible cleanup pass to remove dead CSS classes after a few stable days.
