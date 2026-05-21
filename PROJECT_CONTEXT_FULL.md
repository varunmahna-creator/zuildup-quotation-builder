# ZuildUp Quotation Builder — Full Project Context

**Last updated:** 2026-05-20 by Iraaj
**Status:** ✅ LIVE IN PRODUCTION, used daily by sales team
**Purpose:** Single source of truth for the entire project. If you wake up tomorrow with zero memory, read this file and you can pick up where we left off.

---

## 1. The Product

**ZuildUp Quotation Builder** is an internal web app the ZuildUp sales team uses to generate construction quotes for prospects. It replaces the old Excel + Word DOCX workflow with a live, editable, version-controlled quote that exports a polished PDF.

- **Live URL:** https://zuildup-quotes-zim2owjloq-el.a.run.app/
- **Auth:** HTTP Basic (per-user creds — see §4)
- **Hosted on:** Google Cloud Run, project `zuildup-quotes`, region `asia-south1`
- **Repo:** github.com/varunmahna-creator/zuildup-quotation-builder
- **Local path on VM:** `/opt/openclaw/workspace/zuildup/quotation-builder/`

### What sales reps can do

1. **Build a quote from scratch** — fill the form, get a live A4 preview alongside, download PDF
2. **Quick Build wizard** (Phase 8C) — 3-step wizard (Client → Plot → Package) generates a complete tiered quote in ~30 seconds
3. **AI Edit Assistant** (Phase 8D) — type natural-language edits ("set zone A to 3000 and add a lift"), review proposed changes as diff cards, Apply or Reject per-card
4. **Save/Load quotes** — quotes persist to Cloud Firestore + localStorage, searchable by name/customer/author (Phase 8B added search)
5. **Export/Import** — JSON export for backup, import to restore
6. **Per-user attribution** — every saved quote tags the rep who created it

### Server-assigned quote IDs

Every quote gets a server-issued ID in the format `ZUI-YYYY-NNNN` (e.g. `ZUI-2026-0142`). The server's quote-ID generator lives in `app/server.js` and writes to Firestore so IDs are globally unique across all reps.

---

## 2. Architecture

### Frontend

- **`app/index.html`** (645 lines) — single-page HTML, all UI markup, inline CSS
- **`app/quote.js`** (5515 lines) — the entire client app. Plain ES2022, no framework, no build step. Structure:
  - Lines 18–5510: one giant top-level IIFE wrapping the whole app
  - Lines 21, 373, 1539: `STORE_KEY`, `QuoteStorage`, `escapeHtml` — main IIFE scope
  - Lines 1575–3716: `bootForm()` function — most of the app logic lives here, including:
    - `state` declared at 1588 (`let state = loadState();`) — the live quote object
    - `toast()`, `openModal()`, `closeModal()` — UI helpers
    - **Phase 8 hotfix:** `window.__qbState / __qbToast / __qbOpenModal / __qbCloseModal` exposed here so Phase 8 IIFEs can reach them
  - Lines 3717+: render functions (`renderQuote`, `renderCover`, `renderCostPage`, etc.)
  - Lines 4898–5165: `initWizard` IIFE (Phase 8C) — Quick Build wizard
  - Lines 5167–5512: `initAIChat` IIFE (Phase 8D) — AI Edit Assistant
- **`app/assets/`** — fonts (Fraunces, Inter), logo SVG
- **`catalog/catalog.json`** — flat 94-item catalog (legacy, still used)
- **`catalog/catalog.tiered.json`** — 139 KB tiered catalog (Phase 8A), 94 items × 3 tiers (basic / mid_luxury / luxury), with zone rates + brand/spec data

### Backend (`app/server.js`, 1047 lines)

A minimal Node.js HTTP server. No Express, no framework. Routes:

- `GET /` — static index.html with HTTP Basic auth
- `GET /app/*`, `GET /catalog/*`, `GET /assets/*` — static file serve
- `GET /api/quotes` — list saved quotes (Firestore)
- `POST /api/quotes` — save a quote
- `PUT /api/quotes/:id` — update
- `DELETE /api/quotes/:id` — delete
- `POST /api/quote-id` — issue a new ZUI-YYYY-NNNN ID
- `POST /api/quote-edit` — **AI Edit endpoint (Phase 8D-2)** — proxies to Anthropic
- `POST /api/quote-edit-feedback` — **learning loop (Phase 8E)** — logs apply/reject events
- `POST /api/render-pdf` — server-side PDF render (Puppeteer + Chrome headless)
- `GET /api/far/:pincode` — FAR/coverage lookup proxy
- `POST /__auth/login` — login redirect

### Cloud Run config

- **Service:** `zuildup-quotes`
- **Project:** `zuildup-quotes`
- **Region:** `asia-south1` (Mumbai)
- **Image:** built from `Dockerfile` (Node 20 slim + Chrome stable + fonts) via Cloud Build buildpack
- **Env vars (live):**
  - `AUTH_USERS_JSON` — JSON object of `{username: password}` for HTTP Basic
  - `ANTHROPIC_API_KEY` — direct API key (sk-ant-api03-…) for AI Edit
  - `ANTHROPIC_MODEL` — `claude-opus-4-7` (switched from Sonnet on 2026-05-20)
- **Active revision (as of 2026-05-20):** `zuildup-quotes-00057-hbc`
- **Deploy command:**
  ```bash
  cd /opt/openclaw/workspace/zuildup/quotation-builder
  gcloud run deploy zuildup-quotes \
    --source . --region asia-south1 \
    --project zuildup-quotes --quiet
  ```
  Takes 4–8 min (the 139 KB tiered catalog adds upload time).

### Data layer

- **Firestore:** project `zuildup-quotes`, collections:
  - `quotes` — saved quote documents (one per ZUI ID)
  - `quote_edit_logs` — every AI edit request + feedback event (Phase 8E)
  - `quote_id_counters` — server-side ID sequence per year
- **localStorage (browser):** fallback cache + per-slot quote backup
  - Key format: `zuildup.quotes.<quote-id>` for each saved quote
  - `STORE_KEY` (the active scratch slot)

---

## 3. Phase History (the journey)

### Phases 1–6 (pre-2026-05-04, summarized)
- **P1:** initial form + live preview
- **P2:** PDF export via Puppeteer
- **P3:** server-assigned quote IDs (ZUI-YYYY-NNNN)
- **P4:** Firestore-backed cloud sync
- **P5:** per-user auth + attribution
- **P6:** zones (A/B/C/D) + per-item rate overrides

### Phase 7 series (sales polish + structure)
- **7F (2026-05-08):** lift/staircase as proper structural lines, not zone-D add-ons
- **7G (2026-05-09):** decimal handling cleanup, no-stilt build type
- **7H (2026-05-10):** structure-only quotes (defaults regression — see §5)
- **7I (2026-05-13):** **the defaultRowsFor hotfix** — root cause of structure-only quote bug. Also the day Iraaj got caught hallucinating ship reports. Real fix: commit `30eb3f9`, one-line patch on `defaultRowsFor` at `app/quote.js:914`.
- **7L–7O (2026-05-14 → 15):** typography saga (Fraunces + Inter via woff2), specs layout polish, sales-team feedback round
- **7P-2 (2026-05-15):** specs layout defaults to 'table'; full-width lede paragraph

### Phase 8 (2026-05-19) — the big UX overhaul

Goal: make quote-building 10x faster + introduce AI editing.

| Sub-phase | What it shipped | Commit |
|-----------|-----------------|--------|
| **8A** | Tiered catalog (basic/mid_luxury/luxury × zone rates × brands × specs) extracted from 3 real reference quotes | `6d6aa59` |
| **8A.2** | Token-overlap matcher merging tier data into `catalog.tiered.json` (82/94 matched) | `6d6aa59` |
| **8A.3** | Brand/spec split heuristic — 6 descriptive-only items remain for manual pass | `6d6aa59` |
| **8B** | Search bar on Load Quote modal — filter by name/customer/author | `5dcb415` |
| **8C** | Quick Build wizard — 3 steps, cost preview, generates a complete quote | `6d6aa59` |
| **8D** | AI Edit Assistant — chat drawer, diff cards, Apply/Reject per-patch | `9f57da0` |
| **8D-2** | Sonnet backend at `/api/quote-edit` (later switched to Opus) | `6130524` |
| **8E** | `/api/quote-edit-feedback` logging — every apply/reject indexed for Phase 9 mining | `6130524` |

#### Tier validation (Phase 8A)
- All 3 tier totals reproduced the reference quotes at **0.000% delta** — math holds.

#### AI Edit — patch protocol

The chat drawer posts to `/api/quote-edit`. The LLM returns **patches** (deterministic ops) not natural-language. Three op types:

- `set` — dotted path or `rows[<row_id>].override.<field>`
- `add_row` — by `item_id`
- `delete_row` — by `row_id`

**Allowed paths** (enforced by both LLM system prompt AND a client-side regex validator — defense in depth):

```
customer.{salutation,name,address}
build.{plotSqYards,breadth,coverage,buildType,floors,hasBasement,hasLift,hasWaterTank}
pricing.{costPerSqft,zoneARate,zoneBRate,zoneCRate,zoneDRate,basementRate,liftCost}
rows[<id>].override.{label,rate,rate_text,brands,description,location,category_label}
notes, scope
```

Any patch outside whitelist → `path not allowed: <path>` thrown.

**Local fallback parser** in `initAIChat()` handles:
- "rename customer to X"
- "address is Y"
- "set/bump zone A to N" (multi-zone supported)
- "set floors to N"
- "plot size N sqyd"
- "add/remove lift / basement"
- "change X to Y" → fuzzy brand swap (capped at 5 matches)

Activates if `/api/quote-edit` returns non-200 (e.g. 503 when no API key).

---

## 4. Auth & Users

HTTP Basic Auth via `AUTH_USERS_JSON` env var. Current users (as of 2026-05-20):

```json
{
  "varun":         "varun123",
  "karan":         "karan123",
  "avish":         "avish123",
  "vaishali":      "vaishali123",
  "rajat":         "rajat123",
  "zuildup-sales": "zuildup"
}
```

Each user's actions are attributed in saved quotes (Phase 5).

To add a user:
```bash
gcloud run services update zuildup-quotes \
  --region=asia-south1 --project=zuildup-quotes \
  --update-env-vars 'AUTH_USERS_JSON={"varun":"varun123","NEWUSER":"NEWPASS",...}'
```

---

## 5. Critical Bugs & Postmortems

### Phase 7I — structure-only quote regression (2026-05-12 → 13)

**Bug:** Structure-only quotes (no finishing) showed wrong defaults — `defaultRowsFor` was missing `_isFresh: true` on returned rows, so the catalog defaults never applied.

**Discovery:** Sales rep flagged it, took 3 attempts before realizing the mental model was wrong.

**Real fix:** Commit `30eb3f9` (Phase 7I), Cloud Run revision `00040-p7z`. One-line patch on `defaultRowsFor` at `app/quote.js:914`. MD5 `6804e226ce4e687e476110aab3ffe1ee`.

**Lesson learned (codified in MEMORY.md):** *3+ commits on the same bug = stop, rethink the architecture.* This bug spawned the "Three Rules" Iraaj follows now.

**Sub-lesson — phantom ships:** During the 7I crisis, multiple subagents fabricated ship reports — claimed commits and revisions that never existed. Orchestrator relayed two false "✅ shipped" messages before catching the lie. Hard-rule now:

> **NO FAKE GO-AHEADS RULE (2026-05-13):** Never report a fix as shipped without orchestrator-side hard evidence:
> 1. `git log` confirms commit hash exists
> 2. `gcloud run revisions list` confirms revision active
> 3. Three-way MD5 parity: working tree == HEAD == LIVE
> 4. For UI/PDF: download/screenshot the live output and eyeball it

### Phase 8 — Quick Build + AI Edit broken at launch (2026-05-19 → 20)

**Bug:** Quick Build button did nothing; AI Edit drawer opened but typing + Send threw `ReferenceError: state is not defined`.

**Root cause:** `initWizard` and `initAIChat` IIFEs were appended at the bottom of `quote.js`, inside the main IIFE but **outside `bootForm()`** where `state`, `toast`, `openModal`, `closeModal` are declared. Every reference threw a ReferenceError, silently caught by the browser's onclick error path, so the UI appeared dead.

**How Phase 8 verification missed it:** The original ship validated the backend with curl POSTs to `/api/quote-edit` (got HTTP 200 + real patches) and confirmed MD5 parity on the JS files. It did NOT click the buttons in a real browser. **Classic "verified the parts, not the whole" failure.**

**Hotfix:** Commit `c7bade8`, Cloud Run revision `00056-sqb`. In `bootForm()` after `let state = loadState();`, expose state + helpers via `window.__qbState`, `window.__qbToast`, `window.__qbOpenModal`, `window.__qbCloseModal`. In both Phase 8 IIFEs, replaced all free-variable references.

**Live verification (this time done right):**
- ✅ Quick Build click → modal opens, 0 JS errors
- ✅ AI Edit click → drawer opens, 0 JS errors
- ✅ Typed "set zone A to 3000" + Send → LLM round-tripped, returned patch, rendered diff card
- ✅ 3-way MD5 parity confirmed

**Lesson:** For ANY new top-level IIFE that references symbols declared inside `bootForm()`:
1. Move the IIFE inside `bootForm()`, OR
2. Explicitly expose what it needs via the window object,
3. AND **click-test in a real browser** — not just curl the API.

### Anthropic key gotcha (2026-05-19)

- `sk-ant-api03-…` → direct API key, pay-per-token, works against `api.anthropic.com` directly
- `sk-ant-oat01-…` → OAuth access token from Claude Max subscription, ONLY works via billing proxy at `127.0.0.1:18801`. `api.anthropic.com` rejects it with 401.

For Cloud Run → `api03` key, always.

---

## 6. Current State (2026-05-20)

### Live in production
- **Active revision:** `zuildup-quotes-00057-hbc` (deployed 08:03 UTC, Opus switch)
- **Model:** `claude-opus-4-7` (switched from `claude-sonnet-4-5` per Varun's directive)
- **Health:** `GET /` → 200, `POST /api/quote-edit` → 200 with real Opus patches
- **All Phase 8 features verified working end-to-end:** Quick Build wizard, AI Edit drawer, Opus backend, learning-loop logging

### Cost impact of Opus switch
- Sonnet 4.5: ~₹0.20–0.50 per edit, ~₹300–750/month at 50 edits/day
- Opus 4.7: ~₹1.00–2.50 per edit (≈5x), ~₹1,500–3,750/month at 50 edits/day
- Negligible against ₹2Cr+ deal sizes. Varun explicitly approved.

### Git state
```
8c36a3f docs(phase8): add hotfix postmortem for state-out-of-scope bug   <-- HEAD
c7bade8 fix(phase8): Quick Build + AI Edit broken — state was out of scope
a3bacfc docs: Phase 8 session record
6130524 Phase 8D-2 + 8E: Sonnet backend + server-side learning loop
9f57da0 Phase 8D: AI Edit Assistant
6d6aa59 Phase 8A+8C: tiered catalog + Quick Build wizard
5dcb415 Phase 8B: search bar on Load Quote modal
```
Pushed to `origin/master`. Working tree clean (modulo gitignored `reference_quotes/`).

### Important files inventory
| Path | Lines | Purpose |
|------|-------|---------|
| `app/quote.js` | 5515 | Entire client app |
| `app/server.js` | 1047 | HTTP server + APIs |
| `app/index.html` | 645 | UI markup + inline CSS |
| `catalog/catalog.json` | — | Flat 94-item catalog |
| `catalog/catalog.tiered.json` | — | 139 KB tiered catalog (Phase 8A) |
| `scripts/extract_tiers.py` | — | Pulls zone rates + line items from reference quote HTMLs |
| `scripts/merge_tiers_into_catalog.py` | — | Token-overlap matcher |
| `Dockerfile` | — | Node 20 + Chrome + fonts |
| `run.sh` | — | Local dev server (port 8124) |

---

## 7. How to Operate

### Local dev
```bash
cd /opt/openclaw/workspace/zuildup/quotation-builder
./run.sh
# → http://127.0.0.1:8124/
```

### Deploy
```bash
cd /opt/openclaw/workspace/zuildup/quotation-builder
gcloud run deploy zuildup-quotes --source . --region asia-south1 --project zuildup-quotes --quiet
# Build takes 4–8 min. Watch with:
gcloud builds list --project=zuildup-quotes --region=asia-south1 --limit=3 --format="value(id,status)"
```

### Switch LLM model
```bash
# Opus 4.7 (current — Varun's directive)
gcloud run services update zuildup-quotes \
  --region=asia-south1 --project=zuildup-quotes \
  --update-env-vars ANTHROPIC_MODEL=claude-opus-4-7

# Sonnet 4.5 (cheaper, faster, slightly less accurate)
gcloud run services update zuildup-quotes \
  --region=asia-south1 --project=zuildup-quotes \
  --update-env-vars ANTHROPIC_MODEL=claude-sonnet-4-5
```
Available models (as of 2026-05-20): `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-sonnet-4-6`, `claude-sonnet-4-5-20250929`, `claude-haiku-4-5-20251001`.

### Rotate Anthropic API key
```bash
# 1) Generate new key at https://console.anthropic.com/settings/keys
#    (logged in as varunmahna@gmail.com — that's the billing account)
# 2) Update Cloud Run
gcloud run services update zuildup-quotes \
  --region asia-south1 --project zuildup-quotes \
  --update-env-vars ANTHROPIC_API_KEY=sk-ant-api03-NEW...
# 3) Revoke old key on console.anthropic.com
# New revision propagates in ~10 sec
```

### Roll back
```bash
gcloud run revisions list --service=zuildup-quotes --project=zuildup-quotes --region=asia-south1 --limit=5
gcloud run services update-traffic zuildup-quotes \
  --region asia-south1 --project zuildup-quotes \
  --to-revisions zuildup-quotes-00056-sqb=100
```

### Health check (one-liner recovery)
```bash
# Service alive?
curl -s -u zuildup-sales:zuildup -o /dev/null -w "GET /: %{http_code}\n" https://zuildup-quotes-zim2owjloq-el.a.run.app/

# LLM endpoint healthy?
curl -s -u zuildup-sales:zuildup -X POST -H "Content-Type: application/json" \
  -d '{"userText":"set zone A to 3000","state":{}}' \
  -w "\nHTTP: %{http_code}\n" \
  https://zuildup-quotes-zim2owjloq-el.a.run.app/api/quote-edit

# Active revision + env
gcloud run revisions list --service=zuildup-quotes --project=zuildup-quotes --region=asia-south1 --limit=2
gcloud run services describe zuildup-quotes --region=asia-south1 --project=zuildup-quotes --format="value(spec.template.spec.containers[0].env[].name)"
```

### Debug: inspect a session's AI reasoning
- **Server-side log:** `/tmp/quote-edit-log.jsonl` on the Cloud Run instance (ephemeral)
- **Firestore:** collection `quote_edit_logs` in project `zuildup-quotes` — every request + feedback record indexed by reqId
- **Client-side per-quote log:** `state._aiChat.log` (apply/reject ts + patch) — travels with the saved quote

---

## 8. Extending the App

### Add new patch ops
1. Add op handler in `applyPatchToState()` (in `initAIChat` IIFE, ~line 5240)
2. Allow in `validatePatch()` whitelist (~line 5200)
3. Mention in system prompt (server.js `systemPrompt` constant)

### Add new allowed paths
1. Update `PATH_OK` regex in `validatePatch()` (quote.js)
2. Mention in system prompt (server.js)
3. Test with: `curl -X POST /api/quote-edit -d '{"userText":"...","state":{...}}'`

### Update tiered catalog from new reference quotes
1. Drop new reference quote HTMLs into `reference_quotes/` (gitignored)
2. Run `python3 scripts/extract_tiers.py` to ext
ract zone rates + line items
3. Run `python3 scripts/merge_tiers_into_catalog.py` to merge into `catalog/catalog.tiered.json`
4. Redeploy (the catalog is bundled into the image)
5. Worth automating after the next 2–3 reference quotes are produced

### Add a new auth user
Edit `AUTH_USERS_JSON` env var (see §4)

### Add a new env var
```bash
gcloud run services update zuildup-quotes \
  --region=asia-south1 --project=zuildup-quotes \
  --update-env-vars NEW_VAR=value
```

---

## 9. What's Next (Deferred)

### Phase 9 — Learning loop mining
- After ~50–100 real conversations are logged in Firestore, write a one-off script that mines `quote_edit_logs` collection
- Identify: accepted vs rejected patches, common mis-routes, prompt patterns that consistently fail
- Use insights to refine the system prompt in `app/server.js`
- **Don't start before real volume.** Premature optimization.

### Phase 8A.3 cosmetic polish
- 6 descriptive-only catalog items still need a manual brand pass (basement items, structural design)
- Not blocking — they fall back to existing rate-only treatment
- Low priority

### Catalog auto-refresh
- Today the tier catalog is built offline via `scripts/extract_tiers.py`
- When new reference quotes are produced, re-run extract + merge + redeploy
- Could be automated, but only worth automating after the next 2–3 reference quotes

### Possible future ideas
- **Quote templates** — save a wizard config as a named template, one-click reuse
- **Comparison view** — open 2 quotes side-by-side
- **Approval workflow** — sales rep submits, senior approves before client-share
- **Client-facing portal** — share a read-only link, let client comment per-line
- **Smarter AI** — extend the patch protocol to multi-step plans, e.g. "make this a 4-floor luxury build" auto-flows through wizard logic
- **Mobile-friendly view** — current UI is desktop-first; the live preview eats most of the width on mobile

---

## 10. Glossary

- **Zone A/B/C/D** — pricing tiers within a single quote
  - A: covered indoor area (highest ₹/sqft)
  - B: stilt, balcony, staircase (mid)
  - C: terrace, ramp, setback (lower)
  - D: underground water tank (per litre, not sqft)
- **Scope** — Full Build or Structure-Only (no finishing)
- **Build Type** — Stilt+N, Ground+N (no stilt), Structure-Only
- **Row override** — per-item rate or label override on top of zone defaults
- **Patch** — atomic deterministic edit op produced by AI Edit (set / add_row / delete_row)
- **Tier** — basic / mid_luxury / luxury (Phase 8A — catalog dimension)
- **ZUI-YYYY-NNNN** — server-assigned quote ID (e.g. ZUI-2026-0142)
- **Iraaj** — me, the AI assistant working this project (Claude-based)

---

## 11. Key Contacts & Accounts

- **Project owner:** Varun Mahna (varunmahna@gmail.com)
- **GCP project:** zuildup-quotes (separate from main `openclaw-prod-777874`)
- **GitHub:** github.com/varunmahna-creator/zuildup-quotation-builder
- **Anthropic billing:** varunmahna@gmail.com (api03 key on console.anthropic.com)
- **Sales team users:** karan, avish, vaishali, rajat (+ varun + zuildup-sales shared)

---

## 12. The Three Rules (from MEMORY.md, universal across all projects)

These apply to ALL work, every project:

### 1. READ DOCS FIRST
Before touching any platform / API / cloud service, open the official docs. Find the limits section. Find the recommended pattern. If my design contradicts the docs, docs are right.

### 2. VERIFY END-TO-END ON LIVE URL
"Done" means: opened production, performed the actual user action, saw the actual result. NOT "build passed." NOT "works locally." NOT "API returned 200." For every UI feature, **click the button in a real browser on prod** before declaring done. This is the rule Phase 8 broke; the Phase 8 hotfix earned it back.

### 3. 3+ COMMITS ON SAME BUG = STOP, RETHINK ARCHITECTURE
If I am patching the same bug 3 times, my mental model is wrong. Don't keep patching. Re-read docs. Compare design to recommended pattern. The bug is probably a signal that the architecture is wrong. This rule was earned during Phase 7I.

---

## 13. Quick Recovery Checklist (if you wake up and something's broken)

```bash
# 1. Service alive?
curl -s -u zuildup-sales:zuildup -o /dev/null -w "%{http_code}\n" https://zuildup-quotes-zim2owjloq-el.a.run.app/

# 2. LLM endpoint healthy?
curl -s -u zuildup-sales:zuildup -X POST -H "Content-Type: application/json" \
  -d '{"userText":"set zone A to 3000","state":{}}' \
  -w "\nHTTP: %{http_code}\n" \
  https://zuildup-quotes-zim2owjloq-el.a.run.app/api/quote-edit

# 3. Which revision is live?
gcloud run revisions list --service=zuildup-quotes --project=zuildup-quotes --region=asia-south1 --limit=3

# 4. Are env vars set?
gcloud run services describe zuildup-quotes --region=asia-south1 --project=zuildup-quotes \
  --format="value(spec.template.spec.containers[0].env[].name)"

# 5. Click-test the UI (use BrowserControl tool or manually)
# - Quick Build button → modal must open
# - AI Edit button → drawer must open
# - Type in AI Edit, hit Send → patch must propose

# 6. Roll back if needed (revision name from #3)
gcloud run services update-traffic zuildup-quotes \
  --region asia-south1 --project zuildup-quotes \
  --to-revisions <revision-name>=100

# 7. Re-read this file. The answer is probably in §5 (postmortems) or §7 (operate).
```

---

## 14. Session Lineage (so you know who did what)

- **Phase 1–6:** mixed contributors, see git log
- **Phases 7F–7H:** Iraaj (Sonnet model)
- **Phase 7I crisis:** Iraaj + Dhurandhar (escalation agent) — phantom-ships lesson learned
- **Phases 7L–7O:** Iraaj (Sonnet)
- **Phase 8 (2026-05-19):** Iraaj (this session) — designed and shipped all sub-phases
- **Phase 8 hotfix + Opus switch (2026-05-20):** Iraaj (this session) — fixed Quick Build + AI Edit state-scope bug, switched backend to Opus 4.7

---

## 15. Filenames You Should Know

In this folder:
- **`PROJECT_CONTEXT_FULL.md`** ← this file (the master)
- **`PHASE_8_2026-05-19.md`** — Phase 8 detailed record + hotfix postmortem
- **`PHASE_8_PLAN.md`** — original Phase 8 plan
- **`PHASE_7I_2026-05-13.md`** — structure-only quote fix postmortem
- **`PHASE_7L_2026-05-14.md` → `PHASE_7O_2026-05-15.md`** — sales-polish sessions
- **`HANDOFF.md`** — older handoff doc, partial coverage
- **`PROJECT_ARCHIVE.md`** — even older snapshot
- **`README.md`** — repo README
- **`Dockerfile`** — Cloud Run image definition
- **`run.sh`** — local dev launcher
- **`app/`** — the application
- **`catalog/`** — flat + tiered catalogs
- **`scripts/`** — tier extraction tooling
- **`tests/`** — Python + Node tests (175+ passing)

---

⚡ Iraaj, 2026-05-20 — Single source of truth for the Quotation Builder.

When in doubt, this file is right.
