# ZuildUp Quotation Builder — Phase 1

Single-page web app for ZuildUp's internal team. Form on the left, live A4 quote preview on the right, "Download PDF" button to render the preview to a print-ready A4 PDF.

## Run

```
./run.sh
# → open http://127.0.0.1:8124/
```

Requires `node` (any modern version) and `google-chrome` on PATH (used for headless PDF render).

## What's here

| Path | Purpose |
|------|---------|
| `app/index.html` | Form UI (customer, plot, scope, package, spec list editor, picker dialog) |
| `app/preview.html` | Right-pane preview, also the page POSTed back for PDF render |
| `app/quote.js` | Shared client logic — state, calculator port, render, picker, download |
| `app/server.js` | Tiny Node HTTP server: static + `POST /pdf` → A4 PDF |
| `catalog/catalog.json` | 57 line items, per-tier rates + brand sets + scope + lookbook image paths. Built from PPTs (canonical), corrected per `bugs.md`. |
| `assets/lookbook/{premium,platinum,royale}/` | Per-package slide images (slide-01.png is hero; slide-NN.png is per-spec page reference) |
| `src_logo/zuildup_logo_full.svg` | Master mark — used inline in cover + spec headers |
| `src_calc/CALCULATOR.html` | Source for the cost-calculator formula port |
| `src_ppt/` , `src_docx/` | Original sources kept for reference (PPTs are canonical) |
| `extracted/` | Structured extracts from PPT/DOCX (cross_summary.json, raw_lineitems.json per pkg, slides.json) |
| `bugs.md` | 15 issues found in source data — Severity 1 to 4. Fixes applied at the catalog layer. |
| `mock/` | Phase-3 mock — locked the visual quality bar before app build |

## State

LocalStorage key: `zuildup.quote.v1`. Reload-safe. Internal only — no DB, no login, no share links.

## Calculator port

`PACKAGE_RATES = { premium:1950, platinum:2850, royale:4100 }` — base rate ₹/sq ft.
`ZONE_RATES   = { A:1.0, B:0.5, C:0.3, D:0.3 }` — zone area multipliers.
`EXACT_AREAS` — pinned scenarios for `150_premium`, `300_platinum`, `400_royale`; everything else scales linearly.
Total = Σ over zones of `area_z × floor(base × ZONE_RATES_z)`.
**Note:** the calculator's zone multipliers don't match the per-PPT slide-19 percentages (logged as bugs.md B4.4).

## Known content gap

ZuildUp's PPTs do not contain bathroom/kitchen/interior product photography — only icons (slide-09 has 7 small icon glyphs) and house exteriors (slide-01 hero). The lookbook field in `catalog.json` currently maps each line item to its source slide, but for production we need per-category interior/product photography. See bugs.md B4.3.

## Day-1 deliverables completed

1. `bugs.md` — 15 issues, headlined by **Premium.docx and Royale.docx are tier-mislabeled** (both are actually Platinum content). PPT is canonical.
2. `catalog/catalog.json` — 57 items, valid JSON, brand typos fixed in-line.
3. `mock/cover.pdf` + `mock/spec-card.pdf` — locked the visual bar before logic.
4. The app — form + live preview + PDF download.

## Out of scope (Phase 2+)

- Full brand-marketing pages (about ZuildUp, 5-step process, warranty grid, timeline grid, CTA) — the quote currently renders cover → area-cost → spec-cards → footer. Brand pages can layer in after the lookbook photography lands.
- Embedding into the ZuildUp platform — currently runs as a local internal URL.
- Per-row drag handle UI polish; reordering works but the affordance is minimal.
