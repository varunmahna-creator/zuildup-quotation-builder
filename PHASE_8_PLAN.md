# Phase 8 — LLM Quotation Builder
**Created:** 2026-05-18
**Status:** Awaiting sign-off, no code yet

## Inputs received
- Basic / Mid-Luxury / Luxury reference quotes (PDFs) — 15 pages each, fully extracted.
- Same plot used in all three (170 sq.yd, 27×57, Stilt+4, Lift Yes) — useful: differences are PURE pricing/brand deltas, not configuration deltas.

## Confirmed tier deltas (key examples)
| Line item | Basic | Mid-Luxury | Luxury |
|---|---|---|---|
| Zone A rate | ₹2,300/sqft | ₹2,850/sqft | ₹3,850/sqft |
| Zone B rate | ₹1,200/sqft | ₹1,425/sqft | ₹1,925/sqft |
| Zone D | ₹15/L | ₹25/L | ₹25/L |
| Zone E (Elevation) | not in quote | ₹5,00,000 | ₹10,00,000 |
| Lift Machine | ₹10,00,000 | ₹10,00,000 | ₹13,50,000 |
| Sanitary Ware | ₹25k/bath, Hindware Italian | ₹45k, Jaquar/Hindware | ₹1L, Kohler/Grohe |
| Floor Flooring | ₹50/sqft Vitrified | ₹200/sqft Italian Marble | ₹350/sqft Italian Marble |
| Modular Kitchen | ₹1L Plyboard | ₹1.75L HDHMR Hettich | ₹3.75L HDHMR fluted glass Hettich/Haffle |
| Main Entry Door | ₹20k 32mm flush | ₹35k 44mm Teak | ₹60k TATA Pravesh |
| Switch & Sockets | Anchor/Havells | Legrand | Legrand |
| Internal paint | Asian Tractor Shyne | Asian Apcolite Premium | Asian Apcolite Royal |
| Wardrobe | ₹800/sqft laminate | ₹1250/sqft modular | ₹1750/sqft fluted/PU |
| CCTV | ₹40k | ₹40k | ₹1,00,000 |
| Bathroom Wall Tile | ₹50/sqft ceramic | ₹80/sqft ceramic | ₹200/sqft Italian Marble |

## Structure confirmed
- ALL three quotes have the same sections, same line-item list, same area-calc logic. Only RATES and BRANDS vary per tier.
- ~70 line items total across 11 categories: Design & Drawings, Excavation/Civil, RCC, Brickwork, Plumbing, Bathroom, Kitchen, Doors/Windows/Wardrobe, Flooring, Electrical, Water Management, Ceiling/Elevation, Safety/Security, Paint/Polish, General Aspects.
- 5 zone rates (A/B/C/D/E) + Lift wallet drive cost calc.

## Architecture (proposed)

### Layer 1 — Canonical catalog
`catalog/packages.json` — single file, schema:
```json
{
  "line_items": [
    {
      "id": "sanitary_ware",
      "category": "Bathroom & Toilet",
      "name": "Sanitary Ware and CP Fitting",
      "unit": "per_bathroom",
      "tiers": {
        "basic":      { "rate": 25000,  "brand": "Hindware Italian Collection", "desc": "..." },
        "mid_luxury": { "rate": 45000,  "brand": "Jaquar / Hindware Italian", "desc": "..." },
        "luxury":     { "rate": 100000, "brand": "Kohler / Grohe", "desc": "..." }
      }
    }
  ],
  "zones": {
    "A": { "basic": 2300, "mid_luxury": 2850, "luxury": 3850 },
    "B": { "basic": 1200, "mid_luxury": 1425, "luxury": 1925 },
    ...
  }
}
```
This is the SINGLE source of truth. All 3 packages live here. Adding new line items / changing rates = edit this file.

### Layer 2 — Intake wizard (deterministic, no LLM)
3-step form:
1. **Client:** name, address, phone, email, project location
2. **Project:** plot (sq yd / dims), facing, floors (G/G+1/G+2/G+3), stilt y/n+area, basement y/n+area, lift y/n, terrace use
3. **Package:** 4 cards — Basic / Mid-Luxury / Luxury / Custom (Custom = pick mix per category)

On submit: deterministic pricing engine reads `packages.json` + form state → produces full quote JSON. NO LLM in this path.

### Layer 3 — LLM Edit Assistant (Claude Sonnet)
Endpoint `POST /api/quote-edit` with:
- **Input:** `{ currentQuoteState, userText }`
- **Output:** `{ patches: [{op, path, value, explanation}], clarify?: [] }`

The system prompt embeds the catalog schema + tier brand library so the model can reason about "change bathroom to Kohler" → which line items to touch.

**Safety:** every patch validated by deterministic rules before applying. Rejected if invalid. Shown to rep as diff card → Apply/Reject.

### Layer 4 — Quote search (new feature #7)
Quote list view gets a search bar with:
- Client name (fuzzy)
- Phone, email
- Quote ID
- Date range
- Package tier
- Created-by rep

Backed by `GET /quotes?q=...` — indexed table or in-memory filter, depending on quote-log size.

### Layer 5 — Learning loop (v2, after 50+ quotes)
Every Apply/Reject logged. Phase 9 will mine this for: auto-promoting common edits to defaults, brand preference learning per rep, question pruning.

## UX shape
- **Top:** progress strip — Intake → Package → Draft → Edits → Final
- **Left 60%:** wizard during intake; full editable quote table after generation
- **Right 40%:** during intake = next question; after draft = chat assistant
- **Bottom:** collapsible live PDF preview
- **Top bar:** quote name, save, download PDF, share WhatsApp link, search-previous-quotes button

## Multi-rep
Each rep already has unique login. Quote record stores `created_by_rep_id`. Quotes searchable per rep + globally.

## Reps can share
No approval gate. Rep finalizes → shares directly.

## Cost estimate
- Sonnet on edit endpoint: ~₹0.20-0.50 per edit conversation. Negligible vs deal size.
- Wizard + pricing engine: zero LLM cost (deterministic).

## What I'll build, in order
**Phase 8A** (no LLM yet, ~3-4h) — Build canonical `packages.json` from the 3 PDFs. QC against PDFs line-by-line. Deliverable: a `packages.json` that, when fed through the existing pricing engine with the 170/27x57/Stilt+4 config, produces totals matching the PDFs to the rupee.

**Phase 8B** (~1 day) — Build intake wizard UI + pricing engine v2 reading packages.json. Custom-mix UI. Deliverable: rep can go through 3-step wizard, pick Basic/Mid/Luxury/Custom, get a full draft quote on screen matching the reference PDFs.

**Phase 8C** (~1 day) — Build `/api/quote-edit` endpoint (Sonnet), validator, diff-card UI, Apply/Reject flow. Deliverable: rep can type "change bathroom fittings to Kohler" and see the patch apply correctly.

**Phase 8D** (~0.5 day) — Quote search (feature #7). Deliverable: rep can find any past quote by name/phone/date.

**Phase 8E** (continuous) — Learning loop logging (just write JSONL for now; mining is Phase 9).

## Open questions before I touch code
1. **Custom-mix granularity:** for "Custom" tier, do reps pick mix at category level (Bathroom: Luxury, Flooring: Mid, Kitchen: Basic) or line-item level (every single item independently)? Category-level is simpler and probably what the team will actually use; line-item level is more flexible but UI gets dense.
2. **Sample plot for QC:** the 3 PDFs are all built on 170 sq.yd / 27×57 / Stilt+4. Should I use this as my acceptance test (match these PDFs to the rupee), or do you have a different plot you want me to validate on?
3. **Quote storage:** existing quotes are stored where? Same Cloud Run instance memory, or is there a DB I should write to? Need this for the search feature.
4. **Look book integration:** you mentioned the look book is being built. Should I leave clean hooks for it now (e.g. `lookbook_id` field on each line item) or wait?
5. **PDF output:** keep the current Phase 7P-2 PDF renderer or do you want a different layout for these LLM-built quotes? (My default: keep it, just populate it from the new pricing engine.)

