# Phase 9A Verification — 2026-05-21

**Status:** ✅ SHIPPED
**Ship-by:** Iraaj (Phase 9A subagent)
**Scope:** Issues 1, 2, 3 from FEEDBACK_TRIAGE_2026-05-21.md

---

## 1. Git evidence

```
9ceb7ed Phase 9A: Quick Build pulls tier-specific rows; brand dedup fix   <-- HEAD
72a6339 phase 9c: orchestrator-side verification evidence
fe40f3f Phase 9C: AI Edit multi-place edits + free-form row add
```
Pushed to `origin/master` at 2026-05-21 19:20 UTC.

## 2. Cloud Run revision

- **Active revision:** `zuildup-quotes-00059-qph` (previous: `00058-...` / `00057-hbc`)
- **Traffic:** 100%
- **Region:** asia-south1
- **Project:** zuildup-quotes

```
$ gcloud run services describe zuildup-quotes --region=asia-south1 \
    --project=zuildup-quotes \
    --format="value(status.traffic[0].revisionName,status.traffic[0].percent)"
zuildup-quotes-00059-qph    100
```

## 3. 3-way MD5 parity

**app/quote.js**
- WT = 6d1f44bfa10dbb5660025e9841313526
- HD = 6d1f44bfa10dbb5660025e9841313526
- LV = 6d1f44bfa10dbb5660025e9841313526
- ✅ PARITY OK

**catalog/catalog.tiered.json**
- WT = 9bb767e5910e573469be5f21fbbc3eac
- HD = 9bb767e5910e573469be5f21fbbc3eac
- LV = 9bb767e5910e573469be5f21fbbc3eac
- ✅ PARITY OK

## 4. Live site health

```
GET /: 200
GET /app/quote.js: 200 (281,650 bytes — identical to working tree)
GET /catalog/catalog.tiered.json: 200
```

## 5. Behavioural verification (offline simulation, identical to LIVE code)

### A. Wizard row counts per tier

- **Basic:** 77 rows (13-16 items omitted via `tiers.basic === null` — shower partition, granite work, premium kitchen cladding, etc.)
- **Mid Luxury:** 80 rows
- **Luxury:** 80 rows

### B. UPS / EV / Solar text matches reference quotes verbatim (Issue 3)

Verified parity between:
- `reference_quotes/basic.txt` lines 726-736
- `reference_quotes/mid_luxury.txt` lines 743-754
- `reference_quotes/luxury.txt` lines 741-752
- LIVE wizard-generated rows (sim from LIVE catalog.tiered.json)

| Tier | Item | Live text |
|------|------|-----------|
| Basic | UPS Wiring | "Provision for UPS wiring shall be provided for each floor." |
| Basic | EV Charging | "Provision for one electric vehicle charging point shall be provided per floor." |
| Basic | Solar Electrical | "Provision for solar electrical system shall be included." |
| Mid Luxury | UPS / EV / Solar | (identical text to Basic — matches reference) |
| Luxury | UPS / EV / Solar | (identical text to Basic / Mid — matches reference) |

All 9 (3 items × 3 tiers) checks passed ✅.

### C. Tier differentiation (Issue 1 — Hardik leak fixed)

Example: **Sanitary Ware and CP Fitting**

| Tier | Brand | Rate text |
|------|-------|-----------|
| Basic | Hindware Italian Collection | ₹25,000 per Bathroom |
| Mid Luxury | Jaquar/Hindware Italian | ₹45,000 per Bathroom |
| Luxury | Kohler / Grohe | ₹1,00,000 per Bathroom |

Example: **Bathroom Accessories**

| Tier | Brand | Rate text |
|------|-------|-----------|
| Basic | (empty — ISI Marked baseline) | ₹3,000 per bathroom |
| Mid Luxury | Jaquar | ₹10,000 per bathroom |
| Luxury | Kohler/Grohe | ₹15,000 per bathroom |

Example: **Bathroom Exhaust Fan**

| Tier | Brand | Rate text |
|------|-------|-----------|
| Basic | Havells | ₹1,250 per kitchen/bath |
| Mid Luxury | Havells | ₹1,500 per kitchen/bath |
| Luxury | Havells | ₹3,500 per kitchen/bath |

### D. Brand-duplication fix (Issue 2)

Static analysis on LIVE bundle:
- Old `"Brands: " + brands.join(' · ')` prepend: **0 occurrences** (was the bug source)
- Old `newState.rows = [];` (wizard wipe that fell through to flat catalog): **0 occurrences**
- Phase 9A comment markers present at lines 4730 (renderSpecPages dedup) and 5064 (applyWizard tier build)

Behavioural simulation:
- 237 simulated wizard rows across all 3 tiers
- Rows where `brand` equals first line of `description` (the actual duplication bug): **0**
- Rows where `brand` appears anywhere in description body: 11 — but these are intentional in-prose mentions (e.g. "Modular switches and sockets in white finish from Legrand equivalent make"), matching the reference quote behavior. Not a duplication.

### E. Behaviour for catalog items with brand-as-first-line of description (legacy flat catalog)

20 items in flat `catalog.json` have description starting with brand name (e.g. `electrical.mcb_elcb` desc starts with `"Havells\n..."`). For these:
- **Pre-Phase 9A:** prepended `"Brands: Havells\n"` then `"Havells\nMCB and..."` → brand rendered 3 times.
- **Post-Phase 9A:** no prepend, so desc = `"Havells\nMCB and..."`. The existing dedup block at the bottom of `rowFields` strips first line → final desc body = `"MCB and ELCB protection shall be provided for each floor."`. Bold brand renders once in brand column. ✅

## 6. Reference quote behaviour captured (per Varun's Q1, Q4, Q6)

**Q1 — Items where tiers[tier] is null:**
Implementation: OMITTED from wizard output (per the conservative pick).
Examples: `bathroom.shower_partition_cubicles` (null for basic), `kitchen.kitchen_wall_cladding_visible_areas` (null for all tiers), `flooring.lift_fa_ade` (null for mid_luxury + luxury). Total: 13-16 omitted items depending on tier.

**Q4 — Brand twice/thrice:**
Stopped duplication. Brand renders ONCE in the bold brand-column. The flat-catalog's leading-brand-line in `description` is stripped by the existing dedup block (which now works because we stopped adding the `"Brands: "` prefix that broke its equality check).

**Q6 — UPS / EV / Solar:**
Present in ALL THREE tiers with EXACT reference-quote text. Rate text "—" (descriptive, no rate). Brand empty. Text matches `basic.txt` / `mid_luxury.txt` / `luxury.txt` verbatim (which is the same text for all three tiers — the reference quotes are identical for these 3 items).

## 7. What I could NOT verify

- **End-to-end live browser click test (Quick Build → Generate → render PDF):** BrowserControl tool is not available in this subagent context. I verified by (a) 3-way MD5 parity proving LIVE code == HEAD code, (b) offline Node simulation of the exact wizard logic against LIVE-served catalog.tiered.json. Varun should manually click-test once: open https://zuildup-quotes-zim2owjloq-el.a.run.app/, log in, Quick Build → Basic / Mid Luxury / Luxury → Generate, scroll the preview, confirm brand renders once per row and UPS/EV/Solar match the sample quotes.
- **Live PDF artefact:** PDF rendering is gated through the SPA which requires a browser. Could not generate a fresh PDF without browser automation. (Code parity + data parity gives high confidence the PDF will render correctly.)

## 8. Files touched

- `app/quote.js` — 41 insertions, 13 deletions (+54 lines net diff).
  - Lines 4727-4742 (rowFields fresh-row desc builder — removed `"Brands: "` prepend).
  - Lines 5063-5100 (applyWizard — populate rows from tiered catalog with overrides).
- No changes to: `app/server.js`, `app/index.html`, `catalog/catalog.json`, `catalog/catalog.tiered.json`, scripts.

## 9. Manual test checklist for Varun

1. Hard-reload https://zuildup-quotes-zim2owjloq-el.a.run.app/ (Ctrl+Shift+R to bust cache)
2. Click **Quick Build** in the toolbar
3. Fill: customer name "Test 9A", plot 250 sqyd, breadth 30 ft, floors 4, lift on
4. Select **Basic** tier → Apply → Generate
5. Scroll preview. Verify:
   - Sanitary Ware row says **Hindware Italian Collection** with `₹25,000 per Bathroom`
   - Bathroom Exhaust Fan says **Havells** with `₹1,250 per kitchen/bath`
   - UPS Wiring appears with text "Provision for UPS wiring shall be provided for each floor."
   - EV Charging Point appears with text "Provision for one electric vehicle charging point shall be provided per floor."
   - Solar Electrical Provision appears with text "Provision for solar electrical system shall be included."
   - **Brand appears ONCE per row** (in the bold left-of-description label), NOT twice or thrice.
6. Repeat with **Mid Luxury** — Sanitary should now say Jaquar/Hindware ₹45,000.
7. Repeat with **Luxury** — Sanitary should say Kohler/Grohe ₹1,00,000.
8. Download PDF and confirm same.

---

⚡ Iraaj — 2026-05-21 — Phase 9A complete.
