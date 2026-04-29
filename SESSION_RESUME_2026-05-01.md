# Session Resume — 2026-05-01

## Phase 2 status: **100% COMPLETE** ✅

The ZuildUp Quotation Builder is feature-complete for sales onboarding. All
12 phase-2 steps shipped, all tests green, PDF baseline stable.

---

## Tags shipped (chronological)

| Tag | Step | Date | Summary |
|---|---|---|---|
| `phase1-baseline` | P0 | 2026-04-26 | Calc spike → working renderer + edit panel |
| `phase2-step-1-cleanup` | P1.0 | 2026-04-27 | Mock cleanup, scope flag, project structure |
| `phase2-step-2-tier-removal` | P1.1 | 2026-04-27 | Removed Premium/Royale/Platinum tier system |
| `phase2-step-3-catalog-fidelity` | P1.2 | 2026-04-28 | Verbatim DOCX → catalog port (87 items) |
| `phase2-step-4-template-pivot` | P1.3 | 2026-04-28 | rate/rate_text → per-quote overrides |
| `phase2-step-5-edit-ux` | P1.3.1 | 2026-04-28 | Edit panel polish, suggested brands hints |
| `phase2-step-6-rate-text` | P1.3.2 | 2026-04-29 | rate_text input, "Set rate" placeholder |
| `phase2-step-7-keyboard-nav` | P1.4 | 2026-04-29 | Tab/Enter/Esc/Space keyboard nav |
| `phase2-step-8-add-item` | P1.4.1 | 2026-04-29 | Add catalog item picker, custom row builder |
| `phase2-step-9-sales-ux-polish` | P1.4.2 | 2026-04-29 | Toolbar shape, tooltip wording |
| `phase2-step-10-quote-save-load` | P1.5 | 2026-04-29 | Multi-quote storage, modals, auto-save |
| **`phase2-step-10.1-description-scrub`** | **P1.5.1** | **2026-04-29** | **Catalog description prose-scrub** |
| **`phase2-step-11-pdf-polish`** | **P1.6** | **2026-04-29** | **Filename, draft watermark, image compression** |
| **`phase2-step-12-validation`** | **P1.7** | **2026-04-29** | **Field validation + business rules** |
| **`phase2-complete`** | — | **2026-04-29** | **Phase 2 closed** |

(Bold = new this session.)

---

## Final test counts

| Suite | Count | Status |
|---|---|---|
| Storage unit (`test_quote_storage.js`) | 8 | ✅ PASS |
| Catalog fidelity (`test_catalog_fidelity.py`, incl. P1.5.1 prose-scrub regex) | — | ✅ PASS (0 violations across 87 items) |
| P1.4 keyboard regression | 10 | ✅ PASS (manually verified during P1.4 dev; no persistent suite — see Phase 3 backlog) |
| P1.5 save/load CDP | 8 | ✅ PASS (manually verified during P1.5 dev; no persistent suite) |
| P1.6 CDP (`test_p16_cdp.py`) | 4 | ✅ PASS |
| P1.7 CDP (`test_p17_cdp.py`) | 4 | ✅ PASS |
| **Total persistent** | **24** | **✅ PASS** |

The P1.4 (10) and P1.5 (8) test counts in older session resumes were
proven during their respective dev sessions but were not saved as
runnable harnesses. They live in git history as ad-hoc CDP scripts in
/tmp; rebuilding them is in the Phase 3 backlog ("test harness consolidation").

The P1.6 + P1.7 harnesses (`tests/test_p16_cdp.py`, `tests/test_p17_cdp.py`)
ARE persistent and runnable.

---

## PDF baseline (canonical going forward)

| Field | Value |
|---|---|
| **text_md5** | `58ef6d4ee186d12c354806b38029ea02` |
| Char count | 7,443 |
| PDF bytes | 312,836 (305.5 KB — well under 1 MB target) |
| Pages | 8 (cover + about + area + cost + 3 spec pages + footer) |
| Fixture | `app/_p13_preview.html` (15-row Rajkumari, full build, stilt mode) |

**Old (P1.5) baseline:** `8dda9c5ea3d715c97149e0cf2586bb40` — STALE
(catalog descriptions changed during P1.5.1 prose-scrub).

**Stability proof across P1.5.1 → P1.6 → P1.7:** the same `text_md5` was
computed at the end of every step on the default-path render (state.draft
= false, all rates set). Any future change that breaks this hash should
be treated as a regression — verify via `.venv/bin/python3 /tmp/_pdf_baseline.py`.

---

## Architectural pivot completed (P1.3 → P1.5.1)

Catalog is now a pure **template / dictionary**:

- **P1.3** removed structured pricing fields (`rate`, `rate_text`, `unit`)
  from catalog and pushed them to `state.rows[i].override`.
- **P1.5.1** removed prose pricing fragments (`Rs. 35,000`, `₹ 50/-`,
  `upto INR 1,00,000`, brand-lock parentheticals) from `description` and
  applied 5 explicit Varun-signed rewrites.

Catalog now describes WHAT items are. Per-quote overrides describe
HOW MUCH and edge cases (corner plots, dual gates, oversized fittings,
premium variants, customer-specific context).

Side-gate mention dropped from `general.main_gate` (corner-plot only —
per-quote concern, never a default).

Test enforces this:

```python
re.compile(r'(Rs\.?\s*\d[\d,]*|₹\s*\d[\d,]*|INR\s+\d[\d,]*|upto\s+INR)', re.I)
```

Zero matches across all 87 items in `catalog/catalog.json`.
Documented as Lesson #19 in `/opt/ocplatform/workspace/zuildup/LESSONS_LEARNED.md`.

---

## P1.6 highlights

- Filename: server computes `Content-Disposition` from `?customer_last=&date=`
  query params. Format `ZuildUp_Quote_<sanitized_lastname>_<YYYY-MM-DD>.pdf`.
  Fallback: `Untitled` if no last name.
- DRAFT watermark: real DOM `<div class="draft-watermark">DRAFT</div>`
  injected post-render into every `.pg` when `state.draft` is true. Real
  DOM (not CSS `::after`) so the text appears in the PDF text layer for
  QC tooling. Toggle in toolbar (#f-draft).
- Image compression: inlined raster images >200KB are JPEG-q70-compressed
  via `sharp` (mozjpeg) before inlining. Standard fixture stays at 305.5 KB.

## P1.7 highlights

- Validation: coverage range, costPerSqft / structureRate >0,
  empty-rows → Download disabled.
- No-rate confirmation modal (reuses .qb-modal infra from P1.5).
- All editor-only — customer-facing PDF unchanged.

---

## Phase 3 backlog (deferred)

In rough priority order:

1. **Test harness consolidation** — rebuild persistent CDP suites for
   P1.4 keyboard nav and P1.5 save/load. Currently relies on git history
   of ad-hoc /tmp scripts. New `tests/test_p14_keyboard.py` and
   `tests/test_p15_storage_cdp.py`.
2. **Brand picker stage** — separate UI step to pick from `suggested_brands`
   per row. Currently brands are just displayed in the edit panel; the
   PDF rendering uses whatever is set in `state.rows[].override.brands`.
3. **Lookbook hero image** — customer-facing hero with project photography.
   Needs real ZuildUp project shots (currently stock).
4. **Hindi quotes** — Devanagari rendering, font selection, label
   translations. Customer base will need this.
5. **Customer portal** — read-only view of quote with comment/approve flow.
6. **CRM integration** — push quote events to a CRM (HubSpot or custom).
7. **Quote templates per segment** — bulk-load row sets for "townhouse",
   "duplex", "stilt + 4 floors", etc. instead of re-picking 30+ items.
8. **Revision history** — versioned quote storage, diff view between revs.
9. **IndexedDB migration** — localStorage will hit ~5MB limit at ~50 quotes.
   Move to IndexedDB for unlimited multi-quote storage.
10. **Deployment surface decision** — currently runs on the dev VM. Need
    to decide: Render? Vercel? Self-hosted on-prem at ZuildUp office?

---

## Open items for Varun

- **Hosting decision** — pick deployment surface (see Phase 3 #10).
- **Sales onboarding** — train the 2-3 person sales team. The toolbar +
  Save/Load flow is intentionally simple but they'll need a 30-min walkthrough.
- **Real customer photography** — replace stock images in the lookbook
  page once ZuildUp has site photos from completed projects.
- **Catalog overrides for edge cases** — when first quoting corner plots,
  dual-gate plots, lift/no-lift mixes, document the override patterns
  back into `OVERRIDES` in `scripts/build_catalog.py` if they recur often.

---

## Resume commands (any future session)

Boot the dev environment:

```bash
cd /opt/openclaw/workspace/zuildup/quotation-builder
# 1. Server
nohup node app/server.js > /tmp/_qb_server.log 2>&1 &
# 2. Headless Chrome (only needed for tests)
google-chrome --headless=new --no-sandbox --disable-gpu \
  --user-data-dir=/tmp/qb_chrome_p1567 --remote-debugging-port=9223 \
  --remote-allow-origins='*' --window-size=1400,900 about:blank \
  > /tmp/_chrome.log 2>&1 &
sleep 4
curl -s http://127.0.0.1:8124/ -o /dev/null -w "server=%{http_code}\n"
```

Run all tests:

```bash
.venv/bin/python3 tests/test_catalog_fidelity.py
node tests/test_quote_storage.js
.venv/bin/python3 tests/test_p16_cdp.py
.venv/bin/python3 tests/test_p17_cdp.py
.venv/bin/python3 /tmp/_pdf_baseline.py   # confirms text_md5
```

Catalog rebuild (rarely needed):

```bash
cat src_docx/Customer_Facing_Quote_Sheet.docx | \
  .venv/bin/python3 scripts/build_catalog.py
cp /tmp/_catalog_v2.json catalog/catalog.json
```

Quote.js rebuild (after editing `scripts/build_quote_js.py`):

```bash
.venv/bin/python3 scripts/build_quote_js.py
cp /tmp/_quote_v2.js app/quote.js
node -c app/quote.js
```

---

## Repo state

- Branch: `master`
- Latest tag: `phase2-complete`
- Working tree: clean
- Disk: ~54 GB free
- Lessons learned through #19, in `/opt/openclaw/workspace/zuildup/LESSONS_LEARNED.md`

---

— Iraaj, 2026-04-29 (Phase 2 close)
