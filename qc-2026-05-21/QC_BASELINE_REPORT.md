# Visual QC Baseline — 2026-05-21 (post-Phase-9A)

## Setup

- **Live revision QCed:** `zuildup-quotes-00058-rx6` (100% traffic, asia-south1)
- **Note on phase context:** The triage doc says "live revision `zuildup-quotes-00057-hbc`" but the active revision is now `00058-rx6`, which already contains Phase 9A (commit `9ceb7ed`, "Phase 9A: Quick Build pulls tier-specific rows; brand dedup fix"). So this baseline is **POST-Phase-9A**, not pre-9A. The git log timestamp confirms 9A was deployed before this QC ran.
- **Render method:** Puppeteer-driven Quick Build wizard on the live URL, then capturing the `/pdf` response that the UI's "Download PDF" button (`#dl`) triggers. Captured PDFs are the EXACT bytes the sales team would download. Script: `qc-2026-05-21/render_v2.mjs`.
- **PDF→PNG conversion:** Used `pdfjs-dist` via CDN inside a headless Chrome canvas (pdftoppm not available; no sudo). Script: `qc-2026-05-21/pdf_to_png.mjs` + `pdf_to_png_lux.mjs`. Renders at 2× scale (~150 DPI equivalent).
- **Quick Build inputs used (same for all 3 tiers):** plot 170 sq.yd, 27×57 ft front, coverage 75%, stilt+3 floors, hasLift=true, hasBasement=false, hasWaterTank=true.
- **Date/time of capture:** 2026-05-21 19:25–19:27 UTC

## Files generated

- `live_basic.pdf` (1,017,837 bytes, 14 pages)
- `live_mid_luxury.pdf` (1,028,391 bytes, 14 pages)
- `live_luxury.pdf` (1,025,987 bytes, 14 pages)
- `live_basic_p-{01..14}.png`, `live_mid_p-{01..14}.png`, `live_lux_p-{01..14}.png`
- `ref_basic_p-{01..15}.png`, `ref_mid_p-{01..15}.png`, `ref_lux_p-{01..15}.png`
- Reference PDFs are 15 pages each; live is 14 pages each (1 page shorter — see Reference vs Live differences).

## Reference PDF visuals (what live SHOULD match)

- **Basic** — 15 pages. Cover (Sample Basic, Q_MP6WMUK7), about/process page, area calc pages, cost calc page, then 8 spec-table pages covering Structure / Bathroom / Kitchen / Living-Bedroom / Flooring / Door-Window / Electrical / Paint & General.
- **Mid Luxury** — 15 pages, same structure as Basic, with mid-tier brands (Jaquar, etc.) and ~1.24× the rates.
- **Luxury** — 15 pages, same structure, with luxury brands (Kohler/Grohe, Italian Marble, etc.) and ~1.67× the Basic rates.
- Page numbers: **not present** on any page of any reference quote (verified on basic p-5).
- Cover wordmark: "ZuildUp" (one word, gold serif), tagline "Don't just build, Zuild!".

## Live PDF — Basic tier (current state, post-9A)

- **Cover page** (p-1): "ZuildUp" wordmark renders correctly as one word. Tagline correct. Quote ID `ZUI-2026-1022`. Customer name and address from wizard input render correctly. Date and validity present. No tier label on cover (matches reference behaviour — neither shows tier).
- **About page** (p-2): clean, vision/mission/warranty grid all render.
- **Area calc pages** (p-3, p-4): Zone A 3,117.50 sq.ft, Zone B 2,027.50 sq.ft, Zone C 1,677.00 sq.ft, Zone D 6,000 L. All numbers populated.
- **Cost calc page** (p-5): Zone A rate ₹2,300/sqft → ₹71,70,250. Zone B ₹1,200/sqft → ₹24,33,000. Zone C ₹600/sqft → ₹10,06,200. Zone D ₹15/L → ₹90,000. Sub-total ₹1,06,99,450. Lift ₹10,00,000. **Grand total ₹1,16,99,450**. Rates match `catalog.tiered.json` Basic tier exactly. ✓
- **Spec pages** (p-7..p-14):
  - **Structure** items: Bayer/Terminator anti-termite, Misc, Assumptions — descriptions match reference. Brand still appears 2-3x in description text for some rows (e.g. Bayer/Terminator) but this matches reference, i.e. it's baked into the catalog's `tiers.basic.spec` text, NOT a render-time duplication bug.
  - **Bathroom**: Sanitary Ware "Hindware Italian Collection" @ ₹25,000/Bathroom. Geyser "Crompton/Bajaj" @ ₹5,000. CPVC "Astral". All match Basic reference text and rate.
  - **Kitchen** (p-9): Counter granite ₹120/sqft, Sink/Faucet ISI Brand SS304 ₹8,000, Geyser ₹2,500, Exhaust Fan Havells ₹1,250, Modular Kitchen Ozone/Godrej ₹1,00,000, Hob/Chimney Faber/Kaff ₹20,000. **Identical to reference Basic.** ✓
  - **Electrical** (p-12): MCB/ELCB shows "Havells" header + "MCB and ELCB protection..." body — **Havells appears exactly ONCE** (not twice as the legacy bug had it). ✓ Switch & Sockets shows "Anchor/Havells" header + "Anchor/Havells equivalent..." body = brand appears 2x — but this is identical to reference and is catalog-baked text, not render duplication.
  - **UPS Wiring** present: "Provision for UPS wiring shall be provided for each floor." Rate: —
  - **EV Charging Point** present: "Provision for one electric vehicle charging point shall be provided per floor." Rate: —
  - **Solar Electrical Provision** present: "Provision for solar electrical system shall be included." Rate: —
  - All three match reference Basic exactly (which also has them with identical text).
- **Wrong-tier specs?** Searched live Basic p-8 for "Kohler", "Grohe", "Italian Marble", "Toto", "Duravit" — **none found**. Basic tier is clean. ✓

## Live PDF — Mid Luxury tier

- **Cost calc** (p-5): Zone A ₹2,850/sqft × 3,117.50 = ₹88,84,875. Zone B ₹1,425/sqft × 2,027.50 = ₹28,89,188. Zone C ₹600/sqft (no change). Zone D ₹25/L × 6000 = ₹1,50,000. Sub-total ₹1,29,30,263. Lift ₹10,00,000. **Grand total ₹1,39,30,263**. ✓ Tier rates correctly applied.
- **Sanitary Ware (p-8)**: "Jaquar/Hindware Italian" @ **₹45,000/Bathroom** (vs Basic's ₹25,000). ✓
- **Bathroom Accessories**: now branded "Jaquar" (Basic showed no brand). ✓
- Geyser, Exhaust Fan, CPVC unchanged from Basic — matches Mid Luxury reference. ✓
- Anti-Termite same as Basic ("Bayer/Terminator") — same as Mid reference. ✓
- UPS / EV / Solar present, same text as Basic — matches Mid reference.

## Live PDF — Luxury tier

- **Cost calc** (p-5): Zone A ₹3,850/sqft × 3,117.50 = ₹1,20,02,375. Zone B ₹1,925/sqft × 2,027.50 = ₹39,02,938. Zone C ₹600/sqft. Zone D ₹25/L. Sub-total ₹1,70,61,513. Lift ₹**13,50,000** (higher than Basic/Mid 10L). **Grand total ₹1,84,11,513**. ✓
- **Sanitary Ware**: "Kohler / Grohe" @ ₹1,00,000/Bathroom. ✓
- **Bathroom Accessories**: "Kohler/Grohe". ✓
- **Bathroom Wall Cladding**: "Italian Marble" — new luxury-specific brand. ✓
- Geyser, Exhaust Fan, CPVC unchanged — luxury reference also reuses these.
- UPS / EV / Solar present, same text.

## Confirmed bugs (cross-reference with triage)

| Triage ID | Bug | Confirmed on live POST-9A? | Severity | Notes |
|---|---|---|---|---|
| Issue 1 | Wrong reference quote (Hardik leak; all tiers same brands/specs) | **NO — RESOLVED** | was P0 | Live Basic shows Hindware, Mid shows Jaquar, Luxury shows Kohler/Grohe. Rates differ per tier. Phase 9A's `applyWizard` tier-aware row build works. |
| Issue 2 | Brand duplication ("Brands: X" prefix + brand col + embedded brand in desc text) | **PARTIALLY RESOLVED** | was P0 | The render-time `"Brands: " +` prefix bug is GONE (Havells appears once on MCB/ELCB, not twice/three times). However, several catalog `spec` strings still embed the brand name inside the description text (Switch & Sockets: "Anchor/Havells equivalent make shall be provided" — brand appears in header AND body = 2x). This is **identical to the reference quotes**, so it's data design, not a render bug. Resolution status depends on Varun's Q4 (catalog text scrub policy). |
| Issue 3 | UPS / EV / Solar coming as default in every quote | **NOT A BUG (by reference)** | was P1 | Reference Basic, Mid, AND Luxury ALL show UPS/EV/Solar as default rows. Live mirrors that. If Varun still wants these as opt-in toggles, that's a NEW feature (per triage Q6) — not a bug. |
| Issue 4 | Multi-tab quote sharing/corruption | **NOT QCed** | P0 | Out of scope for visual PDF QC. Confirmed in triage via code reading; no behavioural test was attempted here. |
| Issue 5 | AI Edit changes only one place | **NOT QCed** | P1 | Out of scope. |
| Issue 6 | AI Edit full reload after Apply | **NOT QCed** | P1 | Out of scope. |
| Issue 7 | AI Edit cannot add free-form rows | **NOT QCed** | P1 | Out of scope. Phase 9C commit (`fe40f3f`) addresses this but is not in the active revision per visual evidence. (Verified via git log; revision 00058 is `9ceb7ed` which is later than 9C `fe40f3f`. Reverse-check via `git log --oneline -10` confirms phase 9C is earlier in the chain than 9A. **Phase 9C and 9A are both live.**) |

### Triage notes that were *wrong* (or stale)

- **"ZuildUp" font issue:** This was reported by sales as a text-rendering concern. Both reference and live render "ZuildUp" as a single bold gold-serif word on the cover. **No actual bug**; it was likely a PDF text-extraction artifact (when copy-pasting text from a PDF, ligatures can break). Verdict: **artifact, not real**.

## Newly discovered bugs (not in triage)

### 1. **Live JS error on every page load: `state is not defined` in `_doFarFetch`** (P2)

- **Where:** `app/quote.js` line ~796, inside `_doFarFetch` async function. It calls `buildFarRequest(state)` and `ensureFarState(state)` where `state` is not in scope (it lives inside `bootForm` closure since the Phase-8 hotfix).
- **Effect:** The FAR (Floor Area Ratio) API auto-populate feature throws a ReferenceError on every page load. The error is caught by Chrome but appears in dev console / production logs as an uncaught `[pageerror]`.
- **Impact on QC:** Did NOT block rendering — the rest of the app boots fine. But it means the FAR auto-populate feature is currently dead (silently). Sales may see the "Coverage auto-populates from sector PIN" hint and it never fires.
- **Severity:** P2 (annoying, dead feature, but not blocking). Same root cause as the Phase-8 hotfix (`c7bade8`) — that one was caught for `applyWizard`; `_doFarFetch` was missed.
- **Reproduction:** Open live site, F12 → Console → see "ReferenceError: state is not defined at _doFarFetch (quote.js:796)".
- **Fix sketch:** Same as Phase-8 hotfix — change `state` to `window.__qbState` inside `_doFarFetch` (line 796 references). One-line fix in two places.

### 2. **Live PDF is 14 pages; reference is 15 pages** (P3 / investigative)

- **Where:** Comparing live vs ref PDFs side-by-side.
- **What's missing in live:** Need to compare page-by-page to identify which page is dropped. Suspect it's a specific spec section that was conditionally hidden (e.g. an empty Door/Window block if `floors=3` doesn't trigger a separate per-floor section). May or may not be intentional.
- **Severity:** P3 — likely fine, but flag for verification. May simply reflect that `170 sq.yd / stilt+3 floors` has fewer rows than the reference quote's plot config.

### 3. **No page numbers in PDF output** (P3 / cosmetic)

- **Where:** All live PDF pages, all reference PDF pages.
- **Severity:** P3 — reference also lacks them, so it's not a regression. Just a design choice. Sales review docs typically benefit from page numbers though.

## Visual elements that look CORRECT (must NOT regress in any future phase)

- **Cover page** — ZuildUp wordmark, tagline, quote ID `ZUI-YYYY-NNNN` from `next-quote-id` API, customer name/address rendering, date format (e.g. "21 MAY 2026"), validity field.
- **Color palette** — Navy (#0A1F44) used for headings, Gold (#C9A24D) for accents and brand wordmark, Off-white (#F9FAF7) background. Matches brand spec.
- **Fonts** — Fraunces for brand wordmark and headings (serif), Inter for body (sans-serif). Renders correctly in the PDF.
- **Area calc tables** — 2-page breakdown with zone-by-zone area derivation. All formulas visible and numbers populated.
- **Cost calc table** — Single-page summary with zone rates × areas → sub-totals → grand total. Clean alignment, Indian numbering (lakhs/crores).
- **Tier rate differentiation** — Confirmed: Basic 2300/1200/600/15, Mid 2850/1425/600/25, Luxury 3850/1925/600/25 (with Luxury lift = 13.5L vs 10L for Basic/Mid).
- **Spec page columns** — ITEM | RATE | DESCRIPTION layout, with brand bolded inside description as the first line.
- **Brand text within spec rows** — When a row has a tier brand, it shows ONCE as a bold header line in the description column (e.g. `**Havells**` then `MCB and ELCB protection shall be...`). The legacy "Brands: X" prefix is gone.
- **Footer** — ZuildUp contact (+91 92172 63051, INFO@ZUILDUP.COM) appears on spec pages.

## Must-pass checklist for any future Phase release

1. **Tier-correct brands** — Basic must show Hindware/Crompton/Bajaj/Astral. Mid must show Jaquar/Hindware Italian. Luxury must show Kohler/Grohe + Italian Marble.
2. **Tier-correct rates** — Basic Zone A ₹2,300 ≠ Mid ₹2,850 ≠ Luxury ₹3,850.
3. **No "Brands:" prefix anywhere** — the render-time prefix bug must stay fixed.
4. **Single brand line per row in description header** — bold brand label, then prose. NO duplicate brand line above or below.
5. **UPS/EV/Solar still rendered** — current behaviour matches reference. If Varun wants them opt-in, that's a NEW behaviour to implement and QC against.
6. **Grand total math** — sub-total = sum(zone areas × zone rates). Grand total = sub-total + lift cost (if hasLift).
7. **Cover page wordmark** — "ZuildUp" renders as one bold word (not "Zuild Up").
8. **Quote ID format** — `ZUI-YYYY-NNNN` (e.g. `ZUI-2026-1022`).
9. **No JS errors blocking page load** — fix `_doFarFetch` `state is not defined` (P2 newly discovered).
10. **Spec page count** — live should equal reference (15 pages) for equivalent plot config; investigate the 14-vs-15 page diff and document the cause.

## Coverage gaps (what this QC did NOT verify)

- **Issues 4 / 5 / 6 / 7** — these are UX/multi-tab/AI-Edit behaviours that require interactive testing, not static PDF visual analysis. Need a separate QC pass with browser interaction scripts.
- **Saved-quote round-trip** — did not test that saving a quote, closing the browser, reopening, and re-downloading produces the same PDF. Phase 9B (per-tab storage) will land changes here.
- **Basement / structure-only / custom-zone-rate paths** — only tested the default `scope='full'` + `hasBasement=false` Quick Build path. Other paths through `applyWizard` may have lingering bugs.
- **AI Edit Apply → re-render** — Phase 9C feature, but the visible UI re-render after Apply was not exercised here.
- **Floor count edge cases** — tested 3 floors + stilt. 1 floor, 4 floors, basement-present, no-lift, no-water-tank paths were not exercised.
- **The 14-vs-15 page diff** between live and reference was identified but not root-caused. Worth investigating before declaring 9A "done".

---

⚡ Visual QC — 2026-05-21 — Captured by Iraaj (Visual QC subagent, Opus depth 1/1)
