# Sales Feedback Triage — 2026-05-21

**Investigator:** Iraaj (Opus subagent)
**Inputs:** 7 feedback items from sales-team review of Quick Build + AI Edit (Phase 8C/8D, live revision `zuildup-quotes-00057-hbc`).
**Goal:** Verified root cause + severity + fix sketch + effort + open questions for each item. No code changes.

---

## Executive Summary

**Severity distribution:** 3 × P0 (sales-blocking), 2 × P1 (high), 2 × P2 (annoying).

Three of the seven items (1, 2, 3) share a **single architectural root cause**: **Quick Build's `applyWizard` only consumes tier data for zone rates (A/B/C/D + lift cost) and never touches the per-row tier data that already lives in `catalog.tiered.json`.** Rows are regenerated from the flat `catalog.json` (sourced from a single reference quote — Hardik Malik's), so the rep gets Hardik's brands/specs no matter which tier they pick. The data to do tier-aware rows exists; the wizard just ignores it. Fixing items 1+2+3 is essentially **one well-scoped change to `applyWizard`** plus a render-time bug-fix for brand duplication.

Issue 4 (multi-tab) is a localStorage architecture issue: every tab shares `STORE_KEY = 'zuildup.quote.v2'` + `'zuildup.active_quote_id'`. Sales team can't compare or work parallel because of it. Medium-complexity refactor.

Issues 5, 6, 7 are all AI Edit UX issues. 5 + 7 are system-prompt fixes (S). 6 is a small UX refactor that removes the `location.reload()` and re-renders in place (M).

**Recommended order of attack:**
1. **Phase 9A (P0 sweep):** Issues 1+2+3 — fix Quick Build to consume tier rows from `catalog.tiered.json` + fix brand-duplication dedup. One coherent change, one deploy.
2. **Phase 9B (P0 UX):** Issue 6 — remove the forced reload; Issue 4 — per-tab quote sessions.
3. **Phase 9C (AI prompt polish):** Issues 5 + 7 — extend system prompt + patch protocol.

---

## Issue 1 — Quick Build using wrong reference quote (Hardik's specs, not tier-specific)

**Reported:** "The LLM is picking up the quote for Hardik Malik for the detailed specification part and not the 3 quotes (Budget / Mid-Luxury / Luxury) I shared."

### Verified root cause

1. The Quick Build wizard's `applyWizard()` in `app/quote.js:5040–5080` reads the tiered catalog **only** for zone-A/B/C/D rates and lift cost:
   ```js
   const A = v.customA || z.A[v.tier];
   ...
   newState.pricing = { ..., zoneARate: A, zoneBRate: B, ..., liftCost: lift };
   ```
2. It then **wipes rows** and marks the state fresh:
   ```js
   newState.rows = [];           // app/quote.js:5071
   newState._wizardSource = { tier: v.tier, ... };
   newState._isFreshQuote = true; // app/quote.js:5076
   ```
3. On reload, `bootForm()` (line 1606) calls `state.rows = defaultRowsFor(state.scope, ...)`.
4. `defaultRowsFor` (`app/quote.js:945`) reads **only the flat catalog** (`CATALOG.items` populated from `catalog/catalog.json` — schema-version 2.0.0, `source: "_hardik_reference_quote.pdf"`). It returns one row per matching catalog item with empty overrides:
   ```js
   return cat.map(it => ({ id: it.id, override: {}, _isFresh: true }));
   ```
5. Render functions in `renderSpecPages` (`app/quote.js:4688+`) fall back to `it.brands` and `it.description` from the **flat catalog** (Hardik's data) when the row has no override and `_isFresh` is true — see `rowFields()` at `app/quote.js:4706+`.
6. `_wizardSource.tier` is set once at apply-time and **never consumed anywhere else** (`grep _wizardSource` returns one write, zero reads).

**Net effect:** every Quick Build output, regardless of tier, ships with Hardik Malik's brand list and description text. Only the zone rates differ.

The tier data IS in `catalog/catalog.tiered.json` and is fully populated — e.g. `bathroom.sanitary_ware_and_cp_fitting` has distinct `tiers.basic` (Hindware ₹25k), `tiers.mid_luxury` (Jaquar/Hindware ₹45k), `tiers.luxury` (Kohler/Grohe ₹1L). It's just not being read at row-generation time.

Some items have `tiers.basic = null` (e.g. `bathroom.shower_partition_cubicles`) — meaning the item shouldn't appear in basic-tier quotes at all. This is the same data that should solve Issue 3.

### Severity: **P0** — sales-blocking. Every tier quote currently misrepresents brands/rates.

### Fix sketch
Touch `app/quote.js`:
1. In `applyWizard()` (~line 5040), instead of wiping rows, **build rows from `catalog.tiered.json` filtered to items whose `tiers[v.tier]` is non-null**. For each such item, set `override.rate`, `override.rate_text`, `override.brand` (and `override.description` if the tier `spec` differs from baseline) from `tiers[v.tier]`.
2. Keep `_isFreshQuote = true` so fresh-row renders still kick in for fall-throughs, but the overrides will dominate.
3. Persist `_wizardSource.tier` and consume it in `loadState()` or `defaultRowsFor()` so re-loads don't regress to flat-catalog defaults.

Risks:
- Need to confirm tier-data row count equals what the team expects (≈70 line items per Phase-8 plan; flat catalog has 88).
- Some tier blocks have `rate_text: "—"` and `rate: null` for descriptive-only items (e.g. UPS Wiring) — must still render those as rate-less spec rows.
- Description sources (catalog's `description` vs tier's `spec`) — need policy: prefer tier spec when present, else baseline description.

### Effort: **M** — single function refactor + render fall-through audit. 3-5h.

### Open questions for Varun
- Q1: For each tier, should items whose `tiers[X] === null` be **omitted entirely** (per the data) or **always rendered with "Not Included"**? Phase-8 plan implies omit.
- Q2: When the rep customises the wizard with `customA/B/C/D` rates, should the row specs still come from the picked tier, or fall back to baseline? (Current code: tier picks rates, rows ignore everything.)
- Q3: Should `_wizardSource.tier` lock the row choices on subsequent edits, or are they free-form once applied?

---

## Issue 2 — Detailed spec column writes the brand twice ("old format")

**Reported:** "The system is writing the brands twice — on the left side it is only written once — I think it is still picking up the old format."

### Verified root cause

The `rowFields()` helper inside `renderSpecPages` (`app/quote.js:4706–4790`) composes three pieces:

1. **`brand`** field (rendered as a separate `<div class="spec-brand"><b>…</b></div>` line, line 4806):
   ```js
   } else if (_canDefault && it && Array.isArray(it.brands) && it.brands.length) {
     brand = it.brands.join(' · ');     // e.g. "Havells"
   }
   ```
2. **`desc`** field — for fresh rows, **prefixes a "Brands: …" line** then appends the catalog description:
   ```js
   if (brands.length) {
     const brandLine = 'Brands: ' + brands.join(' · ');
     desc = baseDesc ? (brandLine + '\n' + baseDesc) : brandLine;
   }
   ```
   So `desc` for MCB/ELCB becomes: `"Brands: Havells\nHavells\nMCB and ELCB protection..."` (the catalog `description` field for MCB itself starts with "Havells\n…").
3. **Dedup logic** (lines 4779–4790) tries to strip the first line of `desc` if it matches `brand`:
   ```js
   if (lines.length && lines[0].trim().toLowerCase() === brandPlain) {
     descForRender = lines.slice(1).join('\n')...
   }
   ```
   **BUG:** the dedup compares `brand` (= "Havells") against `lines[0]` (= "Brands: Havells"). The "Brands:" prefix breaks the equality check → dedup fails → both lines render.

Compounding:
- For MCB-style items where the catalog's own `description` field starts with the brand name (e.g. `"Havells\nMCB and ELCB..."`), this means the brand renders **three times**: once as the separate `spec-brand` div, once as the "Brands: Havells" prefix in the body, once as the embedded first line of the description.
- For items where description is just a sentence and brands is set: brand renders twice (separate div + "Brands: X" prefix).

This is exactly what Varun sees ("brands written twice — on the left side it is only written once") — the left-side compact column doesn't apply this prefix.

### Severity: **P0** — every fresh row from the catalog renders polluted output. Affects every Quick Build quote.

### Fix sketch
Touch `app/quote.js:4731–4744` (the fresh-row description builder):
- Stop prepending `"Brands: " + brands.join(' · ')` to `desc`. The separate `brand` field already renders the brand line. Just use `baseDesc` directly.
- For items whose catalog `description` itself starts with a brand line (legacy Hardik-format data), strip that first line if it matches `it.brands.join(' · ')` (case-insensitive, ignoring whitespace).
- Update the dedup at line 4779 to either:
  - (a) Match `lines[0]` against `'Brands: ' + brandPlain` as well, OR
  - (b) Strip the "Brands: " prefix before comparison.
- Best fix is (a) + remove the prefix injection entirely (cleanest).

Risks:
- Old saved quotes that have user-edited `description` containing "Brands: …" lines — those should render unchanged (the dedup is gated on `_isFresh`/`_canDefault`).
- Need to also clean up `catalog.json` where brand names are baked into the `description` field for ~30+ items (e.g. MCB/ELCB, Switch & Sockets, Wires & Cables — anywhere `description` opens with a brand). Otherwise even after the fix, dedup may still fail on the catalog-baked brand line.

### Effort: **S–M** — render-fn fix is small; catalog cleanup is per-item. 1-3h.

### Open questions
- Q4: Is the catalog `description` field's leading brand name intentional (so reps can edit it inline) or a legacy bug? Cleanest fix is to remove brand names from `description` and rely entirely on the separate `brand` field.
- Q5: Confirm the desired rendered output: `**Brand**` on its own line, then the prose spec — no "Brands:" prefix anywhere?

---

## Issue 3 — UPS Wiring / EV Charging Point / Solar Electrical Provision come as default

**Reported:** "UPS Wiring / EV Charging Point / Solar Electric Provision are coming default. This should be picked up as per the 3 sample quotes I shared."

### Verified root cause

All three items exist in `catalog/catalog.json` at lines 968, 982, 996:
```json
{ "id": "electrical.ups_wiring",       "scope": ["full"], "rate": 0, ... },
{ "id": "electrical.ev_charging_point",      "scope": ["full"], "rate": 0, ... },
{ "id": "electrical.solar_electrical_provision", "scope": ["full"], "rate": 0, ... }
```

`defaultRowsFor(scope='full', ...)` filters `CATALOG.items` by `it.scope.includes('full')` and returns all matching IDs as rows (`app/quote.js:945–957`). Result: every "full" quote (which is every Quick Build quote) gets all three.

**However** — these items ALSO exist in `catalog/catalog.tiered.json` (lines 2504, 2547, 2584) with `tiers.basic / mid_luxury / luxury` all populated with identical "Provision for …" spec text and `rate_text: "—"`. So per the tiered data, they SHOULD appear in all three tiers.

**Verification against the three reference quotes:**
- `reference_quotes/basic.txt` line 726–736: contains UPS Wiring, EV Charging Point, Solar Electrical Provision.
- `reference_quotes/mid_luxury.txt` line 744–754: same.
- `reference_quotes/luxury.txt` line 742–752: same.

So the reference quotes themselves DO include all three items across all three tiers. Varun's complaint is therefore subtly different from "they shouldn't be here" — possible interpretations:

(a) These three items should be conditional on a build-flag (like `hasLift` / `hasBasement`) — e.g. `hasSolar`, `hasEV`, `hasUPS` — not always-on defaults. The rep wants to toggle them in the wizard.
(b) The text/format is wrong because it's Hardik's catalog phrasing, not the reference-quote phrasing (same root cause as Issue 1).
(c) These items should never appear in Basic tier (i.e. the team has changed their mind since the reference quotes were extracted).

**My best guess** (needs Varun confirmation): interpretation (a) — the rep wants opt-in toggles. The Phase 8 plan §"Project step" included `terrace use` and similar flags, and these three are exactly the kind of optional add-ons that customers vary on.

Note: even if Varun confirms (a), the **immediate visible problem** for him in the live tool is still likely Issue 1's root cause — the rep generates a Mid-Luxury quote and sees UPS/EV/Solar lines that read identical to the Basic quote (no brand differentiation possible since `brand=""` in all tiers). It looks like "wrong default" because the tier differentiation is invisible.

### Severity: **P1** — high; depends on Varun's interpretation.

### Fix sketch
Two layered fixes:
1. **Quick fix (defer):** make UPS/EV/Solar opt-in flags in the wizard (Step 2 toggles), and filter them out of `defaultRowsFor` unless the flag is on. Required field on each catalog item: `optional: true` + `wizard_flag: 'hasSolar'`. Or hardcode the three IDs.
2. **Proper fix:** ties into Issue 1's tier-aware row construction. Once `applyWizard` reads from tiered catalog, items with `tiers[X] === null` are omitted naturally. We'd need to set `tiers.basic = null` for UPS/EV/Solar to drop them in Basic — but the reference data says otherwise.

### Effort: **S** if (1); **M** if rolled into Issue 1's tier-aware fix. 1-2h either way.

### Open questions
- Q6: Which interpretation is correct — (a) opt-in flags, (b) wrong text/format only, or (c) drop from Basic?
- Q7: If (a), what's the canonical list of opt-in items? UPS, EV, Solar, plus anything else? (Could include CCTV/elevation/specific elevation tiers.)

---

## Issue 4 — Opening a quote in a new tab affects the current tab's quote

**Reported:** "We need to open multiple quotes in different windows/tabs … currently if I open a new quote in a different tab, the quote I am working on also gets changed."

### Verified root cause

The entire app uses **two singleton localStorage keys**:

1. **`STORE_KEY = 'zuildup.quote.v2'`** (`app/quote.js:21`) — the scratch state slot. One per browser, across all tabs.
2. **`'zuildup.active_quote_id'`** (`app/quote.js:374` in `QuoteStorage.ACTIVE_KEY`) — the currently active saved-quote ID. Also one per browser.

`loadState()` (`app/quote.js:179`):
```js
const aid = localStorage.getItem('zuildup.active_quote_id');
if (aid) { const slotRaw = localStorage.getItem('zuildup.quotes.' + aid); ... }
// else fall back to scratch (STORE_KEY)
```

Every `saveState()` (line 345) writes to `STORE_KEY` (and the named slot via `QuoteStorage._touch`). `localStorage` is shared across all tabs on the same origin. Result:

- Tab A loads quote X → `active_quote_id = X` → tab A renders X.
- Tab B opens a new quote → setActiveId(''), localStorage `STORE_KEY` is overwritten with the new scratch state.
- Tab A's next `saveState()` (triggered by ANY form input) reads the now-modified `STORE_KEY` and may corrupt tab A's view.
- More commonly: tab B's load of quote Y sets `active_quote_id = Y`. Tab A's next render reads `Y` from `loadState()` because it doesn't cache the active ID in memory — and tab A suddenly displays quote Y instead of X.

This is a fundamental cross-tab localStorage collision. Quick Build's `applyWizard` makes it worse — it calls `QuoteStorage.setActiveId('')` and `localStorage.setItem(STORE_KEY, JSON.stringify(newState))` then `location.reload()`. Any other open tab will pick up the new scratch state on its next reload/save.

### Severity: **P0** — explicitly sales-blocking. Reps can't compare/parallel-work. Quote corruption risk is real.

### Fix sketch
Three viable strategies, in order of preference:

**Option A (cleanest, biggest refactor):** **URL-based quote IDs.**
- Every quote tab is identified by its URL: e.g. `/?qid=ZUI-2026-0142` or `/quote/ZUI-2026-0142`.
- `loadState` reads the qid from `location.search` (or pathname), not from a shared localStorage key.
- Scratch quotes get a temporary qid like `scratch-<uuid>` stored in URL and `sessionStorage`.
- `saveState` only writes to the named slot (`zuildup.quotes.<qid>`) — never to a shared scratch key.
- New tab = fresh URL = independent quote. Tabs can never collide.

**Option B (medium effort):** **Per-tab `sessionStorage` shadow.**
- Each tab gets a unique tab-id (`crypto.randomUUID()` on load, stored in `sessionStorage` — survives reload, dies on close).
- `STORE_KEY` becomes a function: `'zuildup.quote.v2.' + tabId`.
- `'active_quote_id'` similarly per-tab.
- localStorage still backs each tab's state (for crash recovery), but reads/writes are namespaced.
- Drawback: saved quotes are still loaded by ID, so loading the same saved quote in two tabs still creates a collision through `zuildup.quotes.<id>`. Could keep that shared but require explicit "Save" rather than auto-save.

**Option C (band-aid):** detect tab cross-talk via the `storage` event and refresh-or-warn. Doesn't solve the problem, just makes it less subtle.

**Recommended:** Option A. It's the proper architecture and aligns with PHASE_8_PLAN.md §future ideas "Comparison view — open 2 quotes side-by-side". A's biggest unknown is touching `loadState`, `saveState`, `QuoteStorage.activeId`, `Quick Build apply`, and `AI Edit persistChatState`.

### Effort: **L** — multi-phase. 1-2 sessions just to refactor storage; another to migrate existing reps' saved scratch state without losing it.

### Open questions
- Q8: Confirm Option A is acceptable (URL-based qid). It changes the user-facing URL (good for sharing/bookmarking, bad if reps have bookmarked the root).
- Q9: When the rep clicks "New quote" — should it open in a new tab automatically, or replace the current tab? (Default browser behaviour vs intentional new-window.)
- Q10: Is scratch-quote auto-save worth preserving, or can we move to explicit Save? Auto-save was added in Phase 5; reps might rely on it.

---

## Issue 5 — AI Edit changes only one place instead of globally

**Reported:** "If I change Price of Lift Machine to 15 Lakhs, it should reflect everywhere in the quote wherever this price is mentioned — currently it is only changing in 1 place."

### Verified root cause

Two separate causes, depending on the field:

**(a) For lift cost specifically:** Lift price appears in TWO state slots:
- `pricing.liftCost` (the lump-sum fixed cost added to grand total)
- Optionally, a row in Zone B with id like `structure.lift_machine_room` carrying its own `override.rate`

The LLM gets a snapshot in the system prompt (`app/server.js:811–831`) showing both `pricing.liftCost` and all rows. **Whether** the LLM emits patches for both depends on its inference. The prompt does NOT explicitly instruct: "If a value has multiple representations (e.g. lift cost in `pricing.liftCost` AND in any row override), update ALL representations."

Inspecting the system prompt at `app/server.js:848–894`, the closest hint is Rule #6: "Multi-edit is fine — emit multiple patches in one response." That's permission, not instruction. There's no row-finder logic in the prompt for "find all rows that match this concept and emit one set per row."

**(b) For per-row fields (brands, rates):** The patch protocol is `rows[<row_id>].override.<field>` — strictly one row per patch. To change a brand across all flooring rows, the LLM must emit one `set` patch per row. The local fallback parser (`localIntentParse` at `app/quote.js:5397–5414`) does this for the simple "change X to Y" pattern with a token-overlap match capped at 5 rows — but the LLM has no equivalent guidance.

When Opus runs a "Change Price of Lift Machine to 15 Lakhs" query, it probably emits just `{ op: 'set', path: 'pricing.liftCost', value: 1500000 }` — which updates the lump-sum cost but doesn't touch the Zone-B "Lift Machine Room" row (if present). The rep sees the change in one place (cost-page total) but not the other (spec page).

### Severity: **P1** — annoying, breaks trust in AI Edit, but reps can manually fix the other location.

### Fix sketch
Two-pronged:

**Prompt fix (system prompt in `app/server.js:848+`):**
- Add Rule #8: "When a concept has multiple representations in the snapshot (e.g. `pricing.liftCost` AND any row with `id` matching `*lift*`), emit ONE patch per representation. Always update the lump-sum AND any matching row override."
- Add Rule #9: "For brand swaps that affect a category (e.g. 'change all flooring to Italian marble'), find every row whose `id` or `label` matches the category and emit one `set` per row. List them in `note` so the rep sees what you matched."
- Add an example block in the prompt showing a multi-row swap.

**Patch protocol fix (optional, more invasive):**
- Add a new op: `{ op: 'set_pattern', match: { id_regex: '*lift*' }, override: { rate: 1500000 } }` that the client expands into N individual `set` patches at apply-time. Lets the LLM be explicit about "all rows matching pattern X get this value."

Recommend the **prompt fix only** for Phase 9C. The protocol fix is over-engineering until we see the prompt fix fail.

Risks:
- LLM emits too many patches (false positives) — mitigated by Apply-per-card UX.
- Increases token usage (more patches per response) — negligible cost on Opus.

### Effort: **S** — prompt edit + redeploy. 1h.

### Open questions
- Q11: Should "change Lift Machine price" also re-render the cost page automatically, or rely on the patches alone to update state? (Cost page is derived from state at render time — patches alone should be enough.)
- Q12: For brand swaps, should we cap at the top-N matches (current local-fallback caps at 5) or apply to all matches?

---

## Issue 6 — AI Edit full-refresh blocks parallel work

**Reported:** "If I make a change and apply it in the AI edit, the whole AI client refreshes and the quote reloads. I am not able to make 2nd changes till it gets refreshed."

### Verified root cause

`doApply()` in `initAIChat` (`app/quote.js:5335–5360`):
```js
if (applied) {
  chat.history.push({ role: 'system', text: '✓ Applied ' + applied + ' change' + ... + '. Reloading…' });
  renderHistory();
  window.__qbToast('Applied ' + applied + ' change' + ...);
  setTimeout(() => location.reload(), 600);   // ← THIS
}
```

`location.reload()` does a full page navigation. The drawer closes, the chat history is restored from `state._aiChat.history` on the next load, but:
- The input field is wiped.
- The pending-patches queue is gone (these are in JS memory only, not persisted).
- Any user typing in another input loses focus.
- A second AI request started before reload completes is aborted by the navigation.

**Why the reload exists:** the rendering layer is monolithic — `renderQuote()` rebuilds the entire `<div id="preview-root">` from scratch (`app/quote.js:3738`). The reload was the easy way to ensure the full app re-binds to new state. There's no granular "patch was applied, re-render only this area" path.

### Severity: **P1** — explicitly blocks parallel work, slows down each AI iteration by ~3-5s.

### Fix sketch
Replace `location.reload()` with an in-place re-render:

```js
if (applied) {
  saveState(window.__qbState);              // persist
  if (typeof window.__qbRerender === 'function') {
    window.__qbRerender();                  // re-derive form + preview
  }
  // Drawer stays open. Input stays usable.
}
```

Need to expose a re-render hook in `bootForm` (similar pattern to `__qbState` exposed for the Phase 8 hotfix):
```js
window.__qbRerender = () => { renderSpecList(); renderPreview(); /* and form-field repaint */ };
```

`renderPreview()` already exists at `app/quote.js:3734+`. `renderSpecList()` repaints the left-rail. Form fields need a `repaintForm(state)` helper — partially exists at `bootForm` setup but isn't a single callable.

Risks:
- Some side-effect handlers (event listeners on form fields) might leak if we re-bind without cleanup. Need to audit.
- Patch types that change `build.floors` or `build.buildType` trigger downstream cascades (default rows regenerate, zone definitions change). Currently this works because reload runs the boot path. In-place rerender needs to call those same cascades.
- AI chat drawer state must NOT reset (history must persist, pending must clear). The current code persists history via `persistChatState()`; pending lives in JS-only memory, so clearing it post-apply is correct.

### Effort: **M** — re-render hook + audit cascades. 2-4h.

### Open questions
- Q13: Acceptable to keep the drawer open after each Apply? (Yes per Varun's request.)
- Q14: If the patch changes `build.floors` (a heavy state change), should we still skip reload? My recommendation: yes, but show a "Refreshing…" spinner for 500ms while we re-derive.

---

## Issue 7 — AI Edit can't add new free-form rows (only catalog rows)

**Reported (screenshot):** User typed "Add a room on terrace of 150 sqft at a rate of 5000 per sq ft" → AI responded "I can't add custom line items or new rows outside the catalog — only set fields on existing rows."

### Verified root cause

The patch protocol's `add_row` op (`app/quote.js:5260` and `5231`) requires `item_id` to be a non-empty string:
```js
if (p.op === 'add_row') {
  if (!p.item_id || typeof p.item_id !== 'string') throw new Error('add_row requires item_id');
  return p;
}
```
And `applyPatchToState` pushes:
```js
window.__qbState.rows.push({ id: p.item_id, override: {}, _isFresh: true });
```

There's no enforcement that `item_id` exists in the catalog — but rendering relies on catalog lookup to fill in label/category/description if no override is set. A non-catalog ID would produce a "ghost row" with empty defaults.

**The actual gatekeeper of the refusal** is the system prompt (`app/server.js:854–862`):
```
ALLOWED PATCH SHAPES:
  { "op": "add_row",    "item_id": "<catalog id>",            "explanation": "..." }
```

The phrase `"<catalog id>"` strongly implies the LLM must pick from the catalog. Combined with Rule #5: "NEVER invent row ids", the LLM correctly refuses to fabricate an `item_id`.

There's an architecture mismatch:
- The user wants: a free-form row with `label: "Terrace Room"`, `area: 150`, `rate: 5000`, `cost: 750000`.
- The current row schema is: `{ id, override: { label?, rate?, ... } }` — labels are overrides on top of catalog items.
- There IS a separate path for free-form rows: `state.pricing.zoneLineItems` (see `appendZoneLineItems` at `app/quote.js:1006+`). It accepts `{ id, name, desc, area, rate, floor? }` per zone (A/B/C/D/E). This is what the rep UI uses today for ad-hoc lines (Phase 7B Item 15). But this is NOT in the AI Edit patch protocol whitelist.

### Severity: **P1** — high frequency request, common in real customer conversations (terrace rooms, mumty additions, custom annexes). Workaround exists (manual add via UI) but defeats the AI assistant value.

### Fix sketch
Extend the patch protocol with a new op:
```js
{ "op": "add_zone_line",
  "zone": "C",                              // A/B/C/D/E
  "row": { "name": "Terrace Room", "area": 150, "rate": 5000, "desc": "...", "floor": "Terrace" },
  "explanation": "Add 150 sqft terrace room at ₹5000/sqft to Zone C"
}
```
Implementation:
1. Add `add_zone_line` to `ALLOWED` in `validatePatch` (`app/quote.js:5212`).
2. Validate `zone ∈ {A,B,C,D,E}`, `row.area > 0`, `row.rate > 0`, `row.name` non-empty.
3. `applyPatchToState` appends to `state.pricing.zoneLineItems[zone] = (state.pricing.zoneLineItems[zone] || []).concat([{ id: 'zl_'+rand, ...row }])`.
4. Update system prompt to describe the new op and give an example: "If the rep asks to add a custom line item not in the catalog (e.g. 'add a terrace room of X sqft at Y per sqft'), use `add_zone_line` with the appropriate zone (Zone C for terrace/setback areas, Zone A for indoor, Zone B for stilt/balcony)."
5. Server-side: update the allowed-paths comment in `server.js:780+`.

Risks:
- Zone allocation: the LLM has to guess the right zone. Need clear guidance in the prompt — e.g. terrace → C, indoor room → A, stilt → B.
- The `_lineItemId` is referenced from cost-sheet rendering; need to ensure new entries follow that pattern.
- Reps could accidentally double-add (one custom row + one catalog row override) — need explanation in UI.

### Effort: **M** — patch op + prompt + validator + applier. 2-4h. Tests for the new op.

### Open questions
- Q15: Are there any business rules about which zones can have custom rows? (e.g. "no custom rows in Zone E.")
- Q16: Should the LLM be allowed to ALSO add free-form line items at the **row** level (with no zone, just appended after the spec list)? Or only as zone line items?
- Q17: Should we also allow custom catalog-style spec rows that have no rate but DO have a description (e.g. "add a spec row: 'Premium driveway with imported pavers' under General Aspects")? That's a different op (`add_spec_row`).

---

## Recommended Phase Plan

### Phase 9A — "Tier truth + brand de-dup" (P0 sales-blocking)
**Items:** 1, 2, 3
**Scope:**
- Refactor `applyWizard` to build rows from `catalog.tiered.json` filtered by chosen tier.
- Make `_wizardSource.tier` consumed in `loadState`/`defaultRowsFor` so re-loads retain tier behaviour.
- Fix `renderSpecPages.rowFields` dedup so "Brands: X" prefix matches separate `brand` field; preferably remove the prefix entirely and clean the catalog's `description` field to not start with brand names.
- Decide Issue 3's interpretation with Varun first (opt-in flags vs catalog cleanup).
**Risk:** medium — touches both apply path and render path. Requires careful regression test (load existing saved quotes, compare PDF output).
**Effort:** **M+** — 1 long session or 2 short ones. ~6-8h.

### Phase 9B — "Independent tabs + no-reload AI Edit" (P0/P1 UX)
**Items:** 4, 6
**Scope:**
- URL-based quote IDs (Option A in Issue 4 sketch). New URL scheme: `/?qid=ZUI-XXXX-XXXX` or `/quote/ZUI-XXXX-XXXX`.
- Each tab reads its own qid; localStorage keys namespaced by qid; no shared scratch.
- Replace `location.reload()` in AI Edit Apply with in-place re-render hook.
- Expose `window.__qbRerender` from `bootForm`.
**Risk:** higher — storage refactor touches many call sites. Migration plan for existing reps' saved scratch state.
**Effort:** **L** — 2 sessions minimum, multi-phase. ~10-15h.

### Phase 9C — "Smarter AI Edit prompt" (P1 polish)
**Items:** 5, 7
**Scope:**
- System prompt update in `app/server.js`:
  - Rule for multi-representation values (lift cost in 2 places).
  - Rule for category-wide brand swaps (find all matching rows).
  - New `add_zone_line` op described.
  - Example block showing both patterns.
- New `add_zone_line` op added to `validatePatch` + `applyPatchToState` in `quote.js`.
- Update the server.js doc comment that lists allowed paths.
**Risk:** low — prompt-only change is reversible; new op is additive.
**Effort:** **S–M** — single short session. ~3-4h.

### Suggested deploy order
1. **9C first** (low risk, immediate AI Edit win) — gives sales a better AI experience while we work on the bigger fixes.
2. **9A second** (single-session high impact) — fixes the most visible Quick Build complaints.
3. **9B last** (biggest refactor) — schedule a dedicated multi-session run with explicit rollback plan.

---

## Open Questions (consolidated, for Varun before coding)

Numbered as in-section:

1. **Q1 (Issue 1):** When `tiers[tier] === null` for an item, OMIT it from the quote or render as "Not Included"?
2. **Q2:** Should custom zone-rate overrides in the wizard still use tier-specific row specs?
3. **Q3:** Should `_wizardSource.tier` lock the row choices on subsequent edits?
4. **Q4 (Issue 2):** Is brand-name-in-description in `catalog.json` intentional or a legacy artefact we should scrub?
5. **Q5:** Confirm output format: separate **Brand** line, then prose spec, no "Brands:" prefix.
6. **Q6 (Issue 3):** UPS/EV/Solar — opt-in toggles, text/format fix, or drop from Basic?
7. **Q7:** Canonical list of opt-in items beyond UPS/EV/Solar?
8. **Q8 (Issue 4):** URL-based quote IDs acceptable? (Changes the URL scheme.)
9. **Q9:** New-quote button — new tab or replace current?
10. **Q10:** Keep auto-save for scratch quotes, or move to explicit Save?
11. **Q11 (Issue 5):** Cost-page auto-re-render on lift price change — trust the state-derived render?
12. **Q12:** Brand swap cap — top-N or all matches?
13. **Q13 (Issue 6):** Drawer stays open post-apply — confirmed.
14. **Q14:** Heavy-state changes (build.floors) — show "Refreshing…" spinner or actually reload?
15. **Q15 (Issue 7):** Any zones that can't have custom rows?
16. **Q16:** Free-form line items also at the row level (no zone), or only as zone line items?
17. **Q17:** New `add_spec_row` op for description-only rows?

**Most urgent answers needed before starting:** Q1, Q4, Q6, Q8.

---

⚡ Iraaj — 2026-05-21 — Triage complete. No code changes; ready to begin Phase 9 once Varun answers the urgent questions.
