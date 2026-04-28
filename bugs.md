# bugs.md — ZuildUp source-data audit

Findings from cross-checking the 3 PPTs (`Premium.pptx`, `Platinum_WIP.pptx`, `Royale.pptx`) against the 3 DOCX templates (`Premium.docx`, `Platinum.docx`, `Royale.docx`). PPTs win on disagreement — they are customer-facing and tier-correct. DOCX is internal scratch and is wrong in many places.

Each entry: **section**, **exact quote**, **why it's wrong**, **fix**.

---

## 🚨 Severity 1 — Tier integrity is broken in DOCX

### B1.1 — Premium.docx is actually Platinum content (modular kitchen rate)

- **Section:** `Premium.docx` table 16 (Kitchen) and table 3 (Finishes)
- **Exact quote (Premium.docx, table 16):** *"Modular Kitchen — Factory finished Modular Kitchen – Upto Rs. 2,50,000/- per kitchen / Factory-cut HDHMR modular kitchen with premium laminates. Soft-close hardware from Hettich/Hafele."*
- **Why it's wrong:** `Premium.pptx` slide 9 + slide 14 specify **"Modular kitchen worth INR 1,00,000 made with HDHMR board with laminates finish. Channels & hinges from any Indian brand"** — which is a 2.5× lower rate and a different brand tier (any Indian brand, not Hettich/Hafele). Premium.docx has been pasted with Platinum's Rs. 2,50,000 spec. Same kitchen text appears word-for-word in Platinum.docx.
- **Fix:** PPT is canonical. In `catalog.json`, `rate.premium=100000` for `modular-kitchen` with `brands.premium=["any Indian brand"]`. Do NOT trust DOCX premium content for any rate.

### B1.2 — Royale.docx is also Platinum content (modular kitchen rate + brands)

- **Section:** `Royale.docx` table 16 (Kitchen), table 3 (Finishes)
- **Exact quote (Royale.docx, table 16):** *"Modular Kitchen – Factory finished Modular Kitchen – Upto Rs. 2,50,000/- per kitchen ... Soft-close hardware from Hettich/Hafele."*
- **Why it's wrong:** `Royale.pptx` slide 9 specifies **"Modular kitchen worth INR 5,00,000 including Chimney & in-built Hobb, factory-cut HDHMR with premium acrylic laminates/fluted glass/PU Finish."** That's 2× the rate, plus chimney + hob included. Royale.docx is missing all of this and parrots Platinum.
- **Fix:** PPT canonical. `rate.royale=500000` for `modular-kitchen`, `description` includes "chimney + in-built hob".

### B1.3 — All three DOCX files share table 1 (warranty grid) and table 3 (finishes) verbatim

- **Section:** Tables 1 + 3 across `Premium.docx`, `Platinum.docx`, `Royale.docx`.
- **Why it's wrong:** Identical text — "Modular kitchen worth INR 2,50,000... Hettich..." appears in **all three** DOCX files including Premium and Royale. Means the only DOCX that's tier-correct is Platinum; Premium and Royale were almost certainly created by `Save As` from Platinum without rate updates.
- **Fix:** Treat DOCX as the source for **Platinum only**. Premium and Royale rates and brands come from their respective PPTs. (This affects ~30 line items per package.)

### B1.4 — All three DOCX files have placeholder customer info still in template

- **Section:** First 6 paragraphs of every DOCX.
- **Exact quote:** *"Prepared for: Mr. Rahul Sharma / Address - xxxxxxxxx / Date: 2026-02-25"*
- **Why it's wrong:** This is template scaffold left in the source. Pulled from a sample quote, not real data. If anyone copies these DOCX files to send to a real customer they'll ship "Mr. Rahul Sharma" + dummy address.
- **Fix:** In the builder app, customer name + address + date are **always** pulled from the form (left panel inputs); the template no longer carries placeholder values.

---

## 🚨 Severity 2 — Decorative + design noise in source

### B2.1 — DOCX files carry 31 embedded images each, mostly decorative PNGs

- **Section:** `word/media/` inside each DOCX zip.
- **Exact quote:** Premium.docx → 31 images including `image1.jpeg` (478 KB), `image2.png` (51 KB), etc. Same image set in all three files — not tier-specific.
- **Why it's wrong:** Brief explicitly says *"drop the decorative PNGs and blank pages"*. None of the DOCX images are tied to specific spec rows; they're cover/section decoration, will pixelate at A4 print scale, and the brief says SVG-only for the brand mark.
- **Fix:** Builder ignores DOCX media entirely. Lookbook images come ONLY from the 3 PPTs (extracted into `assets/lookbook/{premium,platinum,royale}/slide-NN.png`), which were exported as a customer-facing deck and have been sized for that purpose.

### B2.2 — DOCX paragraphs contain 8 blank-line gaps used as "blank pages"

- **Section:** All three DOCX paragraph streams.
- **Exact quote:** lines 14, 19, 24, 31 etc. of `docx_paragraphs.txt` — all blank, sandwiched between Heading 4 sub-sections.
- **Why it's wrong:** These blanks render as page breaks in Word but are noise in the structured catalog. Brief calls them out.
- **Fix:** Catalog extractor strips empty paragraphs; quote PDF uses A4 page-break rules driven by section structure, not by source whitespace.

---

## 🚨 Severity 3 — Specific copy-paste / typo bugs (the brief seeded some of these)

### B3.1 — "Lift" line carries "exhausting" — looks like exhaust-fan copy-paste residue

- **Section:** Cost & Area block, all three packages, slide 19/20 of each PPT.
- **Exact quote:** *"Lift | Area including lift structure, all civil, electrical, paint, exhausting, earthing works for lift | 150"*
- **Why it's wrong:** "exhausting" is gibberish here — it should be "exhaust" (noun, referring to the lift shaft exhaust vent) or just removed. Likely got pasted in from an "Exhaust Fan" line elsewhere.
- **Fix:** In `catalog.json` description for `lift`, replace `"exhausting"` with `"exhaust ventilation"`.

### B3.2 — "Bathroom CPVC Fittings" — Platinum + Royale use vertical-pipe `Jaguar|Kohler` instead of `/`

- **Section:** Slide 16 of Platinum.pptx, Royale.pptx.
- **Exact quote (Platinum):** *"Bathroom CPVC Fittings – Jaguar|Kohler; upto Rs. 20,000/- per Bathroom"* (Royale: *"Jaguar|Kohler or equivalent"*).
- **Why it's wrong:** Every other brand-pair uses `/` as the separator (`Jaquar/Kohler`, `Parryware/Hindware`). The `|` is a typo. Also note the brand spelling switches between **"Jaquar"** (correct) and **"Jaguar"** (typo, the car company) within the same deck — Premium uses "Jaquar", Platinum and Royale use both.
- **Fix:** Canonicalise brand name to **"Jaquar"** everywhere in `catalog.json`. Replace `|` with `/`. Surface this typo to ZuildUp brand for source-deck cleanup.

### B3.3 — Brand name typo: "Wilroy & Bosch" — likely meant "Vilroy & Boch"

- **Section:** Slide 16 of Royale.pptx, multiple bathroom rows.
- **Exact quote:** *"Artize by Jaguar/Kohler/Wilroy & Bosch; upto Rs. 40,000/- per Bathroom"*
- **Why it's wrong:** "Villeroy & Boch" is the correct German luxury sanitaryware brand. "Wilroy & Bosch" is a phonetic mis-spelling that pairs Villeroy with Bosch (the appliance company). Customer at the Royale tier (Rs 40K/bathroom) will notice immediately and lose trust.
- **Fix:** `catalog.json` `brands.royale` for bathroom fittings: `["Artize by Jaquar","Kohler","Villeroy & Boch"]`. Surface to ZuildUp brand for source-deck correction. **High priority — this one will visibly damage the Royale pitch.**

### B3.4 — "Anti Skid Tile" — bathroom flooring shows wildly different rates between PPT and DOCX, and Royale switches material entirely

- **Section:** Slide 16 of all three PPTs vs DOCX table 12.
- **Exact quote (Premium PPT):** *"Bathroom Flooring – Anti Skid Tile Cost upto Rs. 25/- per sq ft"*
- **Exact quote (Royale PPT):** *"Bathroom Flooring - Italian Marble cost upto Rs. 350/- per sq ft"*
- **Why it's wrong:** Royale doesn't use anti-skid tile — it uses Italian marble (different category, 14× the rate). DOCX lists "Anti Skid Tile" for all three. Same line item, semantically different products at Royale tier.
- **Fix:** In `catalog.json`, the line item for bathroom flooring is `category: flooring`, with **different `description.{tier}` and `brands.{tier}`**, not just different rates. Premium/Platinum: anti-skid vitrified tile. Royale: Italian marble.

### B3.5 — Cost Calculator total line in slides differs across packages, but Premium + Royale show the same total (Rs 3,18,04,625)

- **Section:** Slide 20 of all three PPTs.
- **Exact quote (Premium and Royale, both):** *"Total | | | Rs. 3,18,04,625/-"*
- **Why it's wrong:** Premium and Royale should NOT have the same total — different rates per sq ft, different finishes. The Royale total has been copy-pasted from the Premium master without recomputing. Also, the area numbers (6,641 / 4,397 / 1,573 / 2,683) are identical between Premium and Royale — that's the same hypothetical plot, but it makes the total mismatch obvious.
- **Fix:** Builder doesn't trust slide totals. The Area & Cost block in the quote is computed live from the cost-calculator JS port (canonical formulas in `src_calc/CALCULATOR.html`), with rates pulled from `catalog.json` per the selected package.

### B3.6 — Brand name inconsistency across one deck: Schneider/Johnson/Otis lift, but Crompton/Polycab elsewhere

- **Section:** Slide 8/9 of Royale.pptx.
- **Exact quote:** *"Lift Machine from Schneider/Johnson/Otis"* and *"Crompton/Polycab/Finolex"* in electrical.
- **Why it's wrong:** Cross-section brand list is fine, but **"Otis"** appears only at Royale tier — Premium and Platinum don't reference any lift brand. Either Otis was added late to Royale only, or the others should also list it. Asymmetric brand surface.
- **Fix:** Decide canonical lift-brand list per tier. Recommend: Premium = Kone (entry), Platinum = Schneider/Johnson, Royale = Otis/Schindler. Surface to brand for confirmation; for now, mirror what each PPT says.

### B3.7 — Modular kitchen Rs. INR/Rs. unit inconsistency

- **Section:** Slide 9 of Premium.pptx.
- **Exact quote:** *"Modular kitchen worth INR 1,00,000"* (slide 9) vs *"Upto Rs. 1,00,000/- per kitchen"* (slide 14, same package).
- **Why it's wrong:** Same line item uses both `INR` and `Rs.` symbols within a single deck. Minor, but breaks the typography grid in the quote PDF.
- **Fix:** Normalise to `₹` symbol (Unicode U+20B9) throughout the rendered output. `catalog.json` stores integers, formatter adds `₹`.

### B3.8 — "upto" written as one word, with and without space

- **Section:** Throughout all PPTs and DOCX.
- **Exact quote:** *"upto Rs. 5,000"*, *"upto20-year warranty"* (no space — Platinum slide 9), *"up to 20-year warranty"* (Premium slide 9).
- **Why it's wrong:** "upto" is informal Indian English. Some lines have it as `upto`, some as `up to`, one as `upto20-year` (no space at all — typo).
- **Fix:** Render canonical "**up to**" in the quote output. `catalog.json` doesn't store this phrasing — it's added by the formatter.

### B3.9 — Address placeholder uses literal "xxxxxxxxx"

- **Section:** First page of all 3 DOCX, slide 1 of all 3 PPTs.
- **Exact quote:** *"Address - xxxxxxxxx"*.
- **Why it's wrong:** If template ever gets shipped without form input, customer sees `xxxxxxxxx`. Hard to miss but easy to slip past in a rushed export.
- **Fix:** Builder requires customer name + address fields before "Download PDF" enables. No fallback to placeholder.

---

## 🚨 Severity 4 — Things the brief asked me to flag

### B4.1 — "SInk and Faucet" capitalisation typo — NOT FOUND in any source file

- **Section:** Searched all 3 PPTs (slides.txt) and all 3 DOCX (docx_paragraphs.txt + docx_tables.json).
- **Exact quote:** None. Regex `\bSInk\b` returned zero matches across all 6 source files.
- **Why this matters:** The brief listed this as a known seed bug. Either it was fixed in a later revision before these files were shared, or it lives in a different artifact (e.g. an internal cost sheet I don't have). Not a blocker — just noting that the seed didn't reproduce here. If I get the cost sheet I'll re-scan.
- **Fix:** None needed in current sources. But: catalog labels are forced to Title Case in code (`"Sink and Faucet"`), so even if a typo recurs in future docs, the catalog stays clean.

### B4.2 — Cost/area section duplication — partially found

- **Section:** Cost calculator block on slide 19 + slide 20 of each PPT.
- **Exact quote:** Two adjacent tables — first one breaks down area by floor; second one totals and adds the per-sq-ft multiplier rows. They're not a true duplicate, but they fragment what should be one block.
- **Why it's wrong:** Brief said *"only one is needed"* — they're describing the version where the area block appears twice in DOCX too. In the DOCX I see ONE area block (table 19), so the duplicate the brief mentioned has already been deduped in DOCX. In PPT it's still two adjacent slides for layout reasons.
- **Fix:** Quote PDF renders ONE area & cost block, sourced from cost-calculator JS, placed before the spec section. PPT slide-19 + slide-20 area tables are not used in the final PDF.

### B4.3 — Decorative PNGs that don't belong in final output

- **Section:** Cover image (slide 1) of each PPT, plus the 31 embedded images in each DOCX.
- **Why it's wrong:** Brief says SVG only for logo, no PNG logo. Most of the PNGs in DOCX are decorative section-headers; the JPEG on slide 1 of each PPT is the cover hero.
- **Fix:** Quote cover uses a single full-bleed hero (chosen from PPT slide-1 image, or a brand-supplied one — TBD with Varun before mock). Logo overlay is `zuildup_logo_full.svg`. No PNG logos anywhere.

---

## Summary: tier-truth matrix (PPT is canonical)

| Field | Premium | Platinum | Royale |
|------|---------|----------|--------|
| Modular kitchen rate | ₹1,00,000 | ₹2,50,000 | ₹5,00,000 (incl. chimney + hob) |
| Modular kitchen brands | Any Indian | Hettich/Hafele | Hettich/Hafele (premium acrylic) |
| Bathroom fittings (per bath) | ₹5,000 (Parryware/Hindware) | ₹20,000 (Jaquar/Kohler) | ₹40,000 (Artize/Kohler/Villeroy & Boch) |
| Bathroom flooring | Anti-skid tile ₹25/sqft | Anti-skid tile ₹40/sqft | **Italian marble ₹350/sqft** |
| Total (sample plot) per slide-20 | ₹3,18,04,625 | ₹2,49,59,500 | ₹3,18,04,625 ⚠ wrong |

**The catalog.json built from this audit will use PPT as truth for rates and brands, and DOCX only for paragraph descriptions on the Platinum tier (since Premium.docx and Royale.docx are content-tagged wrong).**
