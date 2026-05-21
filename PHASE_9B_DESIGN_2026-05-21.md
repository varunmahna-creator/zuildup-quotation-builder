# Phase 9B — Design Doc

**Author:** Iraaj (9B design subagent)
**Date:** 2026-05-21
**Status:** DESIGN ONLY. No code touched. Ready to hand off to an implementation subagent after Phase 9A merges.

---

## Scope

Two independent fixes from the 2026-05-21 sales feedback triage:

- **Issue 4 — Multi-tab independence:** today, every browser tab shares the same `localStorage` singleton (`STORE_KEY = 'zuildup.quote.v2'` + `'zuildup.active_quote_id'`). Loading or editing a quote in tab B silently mutates tab A. Fix = URL-based qid per tab + `sessionStorage`-backed working state.
- **Issue 6 — AI Edit Apply causes full reload:** `app/quote.js:5430` does `setTimeout(() => location.reload(), 600)` after Apply. Closes the drawer, wipes the input, blocks parallel edits. Fix = expose `window.__qbRerender()` and call it instead of `location.reload()`.

Sequencing: ship **9B-1 = Issue 6** first (smaller, lower risk, easier to verify), then **9B-2 = Issue 4** (bigger storage refactor).

---

## Key code-path map (file:line, confirmed via read)

| Symbol | Location | Purpose |
|---|---|---|
| `STORE_KEY = 'zuildup.quote.v2'` | `app/quote.js:21` | Singleton localStorage key for scratch state |
| `loadState()` | `app/quote.js:179` | Reads `active_quote_id` from localStorage, then either named slot or `STORE_KEY` |
| `saveState(s)` | `app/quote.js:345` | Writes to `STORE_KEY` always; also `_touch`es named slot if `activeId` is set; dispatches `quote-state-changed` event |
| `QuoteStorage` | `app/quote.js:373` | Named-slot persistence layer (localStorage + Firestore sync) |
| `QuoteStorage.ACTIVE_KEY = 'zuildup.active_quote_id'` | `app/quote.js:375` | The OTHER cross-tab singleton |
| `QuoteStorage.PFX = 'zuildup.quotes.'` | `app/quote.js:376` | Named slot key prefix in localStorage |
| `bootForm()` | `app/quote.js:1575` | Form-page bootstrap; declares `state`, exposes `window.__qbState/__qbToast/__qbOpenModal/__qbCloseModal` at lines 1593–1596 |
| `bootPreview()` | `app/quote.js:3725` | Preview-iframe bootstrap; listens to `storage` event, `quote-state-changed`, and polls every 700 ms |
| Preview iframe markup | `app/index.html:464` | `<iframe class="preview" id="preview" src="/preview" …>` — the iframe is same-origin same-document context |
| `New Quote` button | `app/quote.js:2025` (handler) → `location.reload()` at 2040 | Clears `STORE_KEY` + `active_quote_id`, reloads |
| `openSavedQuote(id)` | `app/quote.js:2278` → `location.reload()` at 2285 | Load Quote modal → click → sets active id + reload |
| Import JSON → reload | `app/quote.js:2374` | Same pattern |
| `flush()` | `app/quote.js:1725` | The form-page in-memory re-render (saveState + 5 panel re-renders); does NOT re-hydrate `<input>` values |
| `renderSpecList()` | `app/quote.js:2886` | Left-rail spec list repaint |
| `renderAreaOverridesPanel()` | `app/quote.js:2431` | Area overrides panel repaint |
| `renderItemRatesPanel()` | `app/quote.js:2664` | Item rates panel repaint |
| `renderBpfPanel()` | `app/quote.js:2754` | Balcony-per-floor panel repaint |
| `renderFloorSummaryEditor()` | `app/quote.js:2801` | Floor summary editor repaint |
| `initAIChat` `doApply` | `app/quote.js:5407–5436` | The Apply handler; `location.reload()` at 5430 |
| `persistChatState()` | `app/quote.js:5210–5216` | AI Edit's manual writeback to localStorage |

Form-page input hydration is a **one-shot at boot** (lines 1626–1640+). `flush()` does NOT re-hydrate inputs. The reason the current code does `location.reload()` after Apply is to re-run that one-shot hydration so input fields reflect AI-modified state.

---

## Architecture observations that shape the design

### Form ↔ Preview communication

The form and preview live in the SAME tab as parent + iframe. The preview (`bootPreview`) currently watches THREE signals:

1. `window.addEventListener('storage', paint)` — cross-tab AND same-origin-different-document localStorage change events. This is how preview repaints when the form's `saveState` writes to `STORE_KEY`.
2. `window.addEventListener('quote-state-changed', paint)` — `saveState` dispatches this, but it fires on the form's window, NOT the iframe's. (See "Risk" below.)
3. `setInterval(paint, 700)` — belt-and-braces poll. This is what actually keeps the preview in sync most of the time.

**Implication for Issue 4 (sessionStorage migration):**
- `sessionStorage` IS shared between a parent and same-origin iframe (same browsing context, same session).
- `storage` events DO fire for `sessionStorage` changes within the SAME tab between documents. (Confirmed by the HTML5 spec: `StorageEvent` fires on every Window/Document in the same browsing context except the one that initiated the change.)
- The 700 ms polling fallback means even if events misfire, the preview will catch up within 700 ms.

So moving the working state to sessionStorage is safe for the form↔preview channel.

### Server is qid-agnostic

`POST /api/quotes` (server.js:731) accepts an ID-less payload and assigns. `PUT /api/quotes/:id` (server.js:688) accepts any client-supplied ID. The server stores by whatever ID it sees. So URL-based qids require **zero server changes**.

### `_aiChat` is already in `state`

`state._aiChat = { history: [], log: [] }` lives inside the state object. Persisted via `persistChatState()` (5210). Moving state to sessionStorage automatically carries the AI chat history with it — good.

### Cross-tab `storage` listener inventory

Confirmed locations that respond to `storage` events:
- `bootPreview` paint (3742, 3743) — preview iframe.
- No other `window.addEventListener('storage'` exists in the form-page code.

This means the form does NOT currently react to other tabs changing localStorage. Good — there's nothing to "remove" for Issue 4 from the form side. The preview iframe's listener stays — it'll be listening to sessionStorage instead (or we keep writing to localStorage for preview compat; see Decision D5 below).

---

## ISSUE 6 — `__qbRerender` hook (ship as 9B-1)

### Current code path

`doApply()` in `initAIChat` IIFE (`app/quote.js:5407–5436`):

```js
function doApply(indices) {
  const toApply = indices.map(i => pendingPatches[i]).filter(Boolean);
  let applied = 0, failed = 0;
  const chat = getChatState();
  for (const pp of toApply) {
    try {
      applyPatchToState(pp.patch);     // mutates window.__qbState
      applied++;
      chat.log.push({ ts: ..., action: 'apply', patch: pp.patch, ... });
      postFeedback('apply', pp);
    } catch (e) {
      failed++;
      chat.log.push({ ts: ..., action: 'apply_fail', ... });
      postFeedback('apply_fail', pp, { error: e.message });
    }
  }
  pendingPatches = pendingPatches.filter((_, i) => !indices.includes(i));
  persistChatState();
  renderPending();
  if (applied) {
    chat.history.push({ role: 'system', text: '✓ Applied ' + applied + ' change…. Reloading…' });
    renderHistory();
    window.__qbToast('Applied ' + applied + ' change' + (applied===1?'':'s'));
    setTimeout(() => location.reload(), 600);   // ← THIS
  } else if (failed) {
    window.__qbToast(failed + ' patch(es) failed validation', 'err');
  }
}
```

`applyPatchToState(p)` at 5290 mutates `window.__qbState` in place but does NOT call `saveState`. The save is implicit on reload.

`renderQuote` rebuilds the entire `#preview-root` (3738) but only runs in the preview iframe.

### Target design

Add `window.__qbRerender` inside `bootForm()` (alongside `__qbState`, `__qbToast`, etc.) — a function that:

1. Re-hydrates form `<input>` / `<select>` / `<checkbox>` values from `state` (so AI-modified customer.name, build.floors, pricing.zoneARate, etc. show up in the form fields).
2. Calls `flush()` — which itself does `saveState(state)` + repaints all five panels.
3. `saveState` already dispatches `quote-state-changed` and writes to storage → preview iframe picks it up via its `storage` / `setInterval` listeners. No extra signalling needed.

```js
// To add inside bootForm(), after the existing window.__qb* exposures (line ~1596):
function repaintInputsFromState() {
  $('f-salutation').value = state.customer.salutation;
  $('f-name').value       = state.customer.name || '';
  $('f-address').value    = state.customer.address || '';
  $('f-plot').value       = state.build.plotSqYards || '';
  $('f-breadth').value    = state.build.breadth || '';
  $('f-coverage').value   = state.build.coverage || 75;
  $('f-floors').value     = state.build.floors || 4;
  $('f-build-type').value = state.build.buildType || 'stilt';
  $('f-basement').checked = !!state.build.hasBasement;
  $('f-lift').checked     = !!state.build.hasLift;
  if ($('f-water-tank')) $('f-water-tank').checked = (state.build.hasWaterTank !== false);
  if ($('f-lift-sqft'))      $('f-lift-sqft').value      = state.pricing.liftSqftPerLevel      ?? '';
  if ($('f-staircase-sqft')) $('f-staircase-sqft').value = state.pricing.staircaseSqftPerLevel ?? '';
  // Zone rates + costs
  ['f-zone-a-rate','f-zone-b-rate','f-zone-c-rate','f-zone-d-rate','f-basement-rate','f-lift-cost'].forEach(id => {
    const el = $(id); if (!el) return;
    const key = ({
      'f-zone-a-rate':'zoneARate','f-zone-b-rate':'zoneBRate','f-zone-c-rate':'zoneCRate',
      'f-zone-d-rate':'zoneDRate','f-basement-rate':'basementRate','f-lift-cost':'liftCost',
    })[id];
    el.value = state.pricing[key] ?? '';
  });
  if ($('f-specs-layout')) $('f-specs-layout').value = state.specsLayout || 'table';
  // Notes / scope
  if ($('f-notes')) $('f-notes').value = state.notes || '';
  if ($('f-scope')) $('f-scope').value = state.scope || 'full';
  // … (full list to be derived from the boot hydration block at lines 1626–1700;
  //    the implementation subagent should sweep that block and mirror every field)
}

window.__qbRerender = function() {
  repaintInputsFromState();
  flush();    // saves + repaints all five panels + fires quote-state-changed
};
```

Then in `initAIChat` `doApply()` (line 5430), replace:

```js
chat.history.push({ role: 'system', text: '✓ Applied ' + applied + ' change' + … + '. Reloading…' });
renderHistory();
window.__qbToast('Applied ' + applied + ' change' + …);
setTimeout(() => location.reload(), 600);
```

with:

```js
chat.history.push({ role: 'system', text: '✓ Applied ' + applied + ' change' + (applied===1?'':'s') + (failed?' ('+failed+' failed)':'') + '.' });
renderHistory();
window.__qbToast('Applied ' + applied + ' change' + (applied===1?'':'s'));
// Phase 9B-1: in-place rerender — no full reload.
try {
  if (typeof window.__qbRerender === 'function') window.__qbRerender();
  else { /* defensive fallback */ setTimeout(() => location.reload(), 600); }
} catch (e) {
  console.error('[ai-edit] rerender failed, falling back to reload', e);
  setTimeout(() => location.reload(), 600);
}
```

Note the dropped "Reloading…" copy from the system message.

### Why this works without a heavy DOM rebuild

- `applyPatchToState` already mutates `window.__qbState` in place. `state` inside `bootForm` is the SAME object reference (assigned at 1588). So the in-memory state is already correct after Apply.
- `flush()` already re-saves and repaints all five form panels. It just doesn't touch raw `<input>` values.
- `repaintInputsFromState` covers that gap.
- The preview iframe runs `bootPreview` independently and repaints on every `storage` event + `quote-state-changed` + 700 ms poll. `saveState` (called by `flush`) writes to localStorage AND dispatches `quote-state-changed`, so the preview will pick up the new state within ≤700 ms.

### Cascading state changes (the one risky case)

Some patches change `build.floors`, `build.buildType`, or `build.hasBasement` — these have downstream effects on which catalog rows exist. The current `location.reload()` path implicitly re-runs the boot-time `defaultRowsFor` top-up at line 1605–1620:

```js
if (!state.rows.length) {
  state.rows = defaultRowsFor(state.scope, { hasBasement: !!state.build.hasBasement });
  saveState(state);
}
if (state.build.hasBasement) {
  const haveBasement = state.rows.some(r => …'basement'…);
  if (!haveBasement) { /* top up basement rows */ saveState(state); }
}
```

If an AI patch flips `build.hasBasement` from false to true, the in-place rerender will NOT auto-top-up basement rows. Two mitigations:

**Mitigation A (simpler):** Pull this top-up block into a `function reconcileRowsForBuild()` and call it from both boot AND `__qbRerender`. Implementation subagent should refactor.

**Mitigation B (safer):** Detect AI patches that change `build.hasBasement` / `build.floors` / `build.buildType` and route them through the full-reload path:

```js
const needsHeavyReload = toApply.some(pp =>
  pp.patch && pp.patch.op === 'set' && /^build\.(hasBasement|floors|buildType|hasLift|hasWaterTank)$/.test(pp.patch.path || '')
);
if (needsHeavyReload) { setTimeout(() => location.reload(), 600); return; }
```

**Recommendation:** Mitigation A. It's the right architectural fix and aligns with the goal of "no surprise reloads ever." Mitigation B is the fast-path if 9B-1 needs to ship same-day.

### Drawer + chat state behaviour after Apply

- Drawer stays open (no reload).
- `pendingPatches` already filtered to exclude applied indices (line 5424).
- `renderPending()` repaints the pending list (now showing only un-applied items).
- `renderHistory()` shows the new "✓ Applied N changes." system message.
- `state._aiChat.log` keeps the applied/rejected events forever (persisted in state). The drawer doesn't display the log directly — but Phase 9C / future could add a "view applied history" toggle.
- The input field stays usable (input element is never re-created).

### Code changes required (file:line + nature)

| # | File | Line | Change |
|---|---|---|---|
| 1 | `app/quote.js` | ~1596 (after existing `window.__qbCloseModal` exposure) | Add `repaintInputsFromState()` local helper AND `window.__qbRerender = function() { repaintInputsFromState(); flush(); }`. |
| 2 | `app/quote.js` | extract from 1605–1620 into `function reconcileRowsForBuild()` (boot calls it once; `__qbRerender` calls it too) | Mitigation A from above. Optional but recommended. |
| 3 | `app/quote.js` | 5430 (the `setTimeout(() => location.reload(), 600)` in `doApply`) | Replace with `__qbRerender()` call + defensive fallback. Update the chat-history message text (drop "Reloading…"). |
| 4 | `app/quote.js` | (optional, defensive) `doApply` start | If we go with Mitigation B, prepend the `needsHeavyReload` short-circuit. |

### Test plan (manual, browser)

1. **Drawer stays open:**
   - Open AI Edit drawer. Type "set zone A to 3000". Send. Wait for diff card. Apply.
   - ✅ Drawer is still open. Input field is empty (typeable). Toast shows "Applied 1 change". Preview iframe updates to ₹3000/sqft for Zone A.
2. **Sequential edits:**
   - In the still-open drawer, type "change Hindware to Kohler". Send. Wait. Apply.
   - ✅ All matching rows updated. Drawer still open. Input still typeable.
3. **Customer-name patch propagates to form input:**
   - Drawer: "rename customer to Mr. Acme Corp". Apply.
   - ✅ The form's customer-name `<input>` shows "Acme Corp" (not stale). Preview cover page updates.
4. **Zone rate patch propagates to form input:**
   - Drawer: "set zone B rate to 1800". Apply.
   - ✅ The form's f-zone-b-rate input shows "1800". Preview cost page updates.
5. **Build-flag patch (the cascade case):**
   - Drawer: "add basement". Apply.
   - ✅ `f-basement` checkbox is now checked. Basement category rows appear in spec list (via `reconcileRowsForBuild`). Preview shows basement section.
6. **Many patches at once:**
   - "Apply all" with 6 diff cards.
   - ✅ All apply, single toast "Applied 6 changes", drawer stays open, no flashing/flicker.
7. **Failure path:**
   - Synthetic broken patch (e.g. invalid path). Apply.
   - ✅ Toast "1 patch(es) failed validation". Drawer stays open. No rerender (since `applied === 0`).
8. **PDF download immediately after Apply:**
   - Apply a patch, then click Download PDF.
   - ✅ PDF reflects the post-Apply state (because saveState happened inside flush).

### Risks + rollback

- **Risk R1:** Some boot-time hydration field is missed in `repaintInputsFromState`, so an AI-modified value doesn't show in the form. Mitigation: implementation subagent must do a side-by-side diff of lines 1626–~1700 and the new repaint helper. Add a comment block tying them together: `// MUST be kept in sync with bootForm hydration block (line 1626+)`.
- **Risk R2:** A `storage` event listener (form-side) doesn't fire as expected for the cross-tab story. Out of scope for 9B-1 (this is an Issue-4 concern).
- **Risk R3:** `applyPatchToState` for `set` on a deeply nested path could create stale references that `flush` doesn't notice. Low — paths are strict-whitelisted.
- **Rollback:** Revert the commit. The `location.reload()` was the previous behaviour and continues to work; the only risk surface is the new helper.

### Estimated effort: **3–4h**

- 30 min: read + map boot hydration block.
- 1 h: write `repaintInputsFromState` + `reconcileRowsForBuild` extraction.
- 30 min: swap the `location.reload()` in `doApply`.
- 1.5 h: manual browser testing across the 8 scenarios above.

---

## ISSUE 4 — URL-based qid + sessionStorage (ship as 9B-2)

### Current state recap

- `STORE_KEY = 'zuildup.quote.v2'` in localStorage holds the scratch state. ONE per origin, shared across all tabs.
- `'zuildup.active_quote_id'` in localStorage holds the currently-active saved-quote ID. ONE per origin.
- `'zuildup.quotes.<id>'` per saved quote in localStorage. Shared across tabs (good — it's the canonical saved data).
- `loadState` (179): if `active_quote_id` is set AND the slot exists → load that; else load `STORE_KEY`.
- `saveState` (345): always write `STORE_KEY`; if `active_quote_id` is set → also `_touch` the named slot.
- New Quote, Open Saved Quote, Import JSON: all `location.reload()` after flipping `active_quote_id`.

This means: opening quote Y in tab B sets `active_quote_id=Y`. Tab A's NEXT load (or any code path that calls `loadState`) will load Y, even though tab A was on quote X.

### Target design

#### URL scheme

`/?qid=<id>` where `<id>` is:
- A **draft ID** like `draft-<uuid>` (e.g. `draft-c8a7e2f1`) for fresh/scratch quotes that haven't been server-saved yet.
- A **real ZUI ID** like `ZUI-2026-0142` for saved quotes.

The qid is the source of truth for "which quote does this tab show." If absent on first load, the boot path generates a draft ID and calls `history.replaceState({}, '', '?qid=draft-<uuid>')`.

#### Storage layout (new)

| Layer | Key | Where | When written | Lifetime |
|---|---|---|---|---|
| Tab-local working state | `zuildup.quote.<qid>` | **sessionStorage** | every `saveState` | Until the tab is closed |
| Saved quote canon | `zuildup.quotes.<qid>` | localStorage | `QuoteStorage.save()` / `_touch()` | Persistent |
| Saved quote index | `zuildup.quotes.index` | localStorage | `QuoteStorage` ops | Persistent |
| **GONE:** `zuildup.active_quote_id` | localStorage | n/a | (the URL is now the source of truth) | n/a |
| **GONE:** `zuildup.quote.v2` | localStorage | n/a | (no more singleton scratch) | n/a |
| Cloud sync | Firestore via `/api/quotes` | server | `QuoteStorage._apiPush` | (unchanged) | Persistent, cross-device |

**Key invariant:** "scratch" is no longer a special state. Every tab always has a qid (either draft or ZUI). The "save" action just transitions a draft qid → real ZUI qid in the URL.

#### Boot flow (form page)

```
boot:
  1. Parse URL: qid = new URLSearchParams(location.search).get('qid')
  2. If qid is null/empty:
       qid = 'draft-' + crypto.randomUUID().slice(0, 8)
       history.replaceState({}, '', '?qid=' + qid)
  3. Run migration (one-time-per-tab):
       - If qid is a draft AND sessionStorage has nothing for it AND localStorage 'zuildup.quote.v2' exists AND localStorage 'zuildup.migration.done' is unset:
           - Copy localStorage 'zuildup.quote.v2' → sessionStorage 'zuildup.quote.<qid>'
           - Set localStorage 'zuildup.migration.done' = '<ISO date>' (one-shot flag)
           - DO NOT delete the old key — keep it for 30 days as recovery insurance.
  4. state = loadState(qid)
       - sessionStorage 'zuildup.quote.<qid>' if present → that's the working copy
       - else localStorage 'zuildup.quotes.<qid>' (named slot) if qid is a real ZUI id → load + clone into sessionStorage
       - else defaultState() (brand new quote)
  5. Set window.__qbQid = qid  (Phase 9B-2 exposure, alongside __qbState)
  6. Continue with existing bootForm flow.
```

#### saveState (new shape)

```js
function saveState(s) {
  try { _normaliseStateRupee(s); } catch(_) {}
  const qid = window.__qbQid;
  if (!qid) throw new Error('saveState called before qid was set');
  sessionStorage.setItem('zuildup.quote.' + qid, JSON.stringify(s));
  // If qid is a real ZUI (not draft-*) AND user has explicitly saved before,
  // also write to localStorage named slot (existing behaviour via QuoteStorage._touch).
  if (qid && !qid.startsWith('draft-')) {
    try { QuoteStorage._touch(qid, s); } catch(_){}
  }
  window.dispatchEvent(new Event('quote-state-changed'));
}
```

Note: the `quote-state-changed` event still fires, and the preview iframe (same browsing context) receives it via the polled `setInterval` + the event listener. ✅

#### loadState (new shape)

```js
function loadState() {
  const qid = window.__qbQid || (new URLSearchParams(location.search).get('qid')) || null;
  if (!qid) return defaultState();   // shouldn't happen — boot guarantees qid

  // 1) sessionStorage working copy
  try {
    const raw = sessionStorage.getItem('zuildup.quote.' + qid);
    if (raw) {
      const s = JSON.parse(raw);
      return _mergeWithDefaults(s, /* _isFreshQuote */ false);
    }
  } catch(_) {}

  // 2) localStorage named slot (only for non-draft qids)
  if (!qid.startsWith('draft-')) {
    try {
      const raw = localStorage.getItem('zuildup.quotes.' + qid);
      if (raw) {
        const s = JSON.parse(raw);
        // Seed sessionStorage so subsequent saves stay tab-local.
        sessionStorage.setItem('zuildup.quote.' + qid, raw);
        return _mergeWithDefaults(s, /* _isFreshQuote */ false);
      }
    } catch(_) {}
  }

  // 3) Brand new
  return defaultState();
}

// _mergeWithDefaults: factored out of the existing loadState merge logic.
```

#### "New Quote" button behaviour

Today: clears `STORE_KEY` + `active_quote_id`, `location.reload()`. Result: old tab's view changes.

New: **opens a NEW tab** with a fresh draft qid.

```js
newQuoteBtn.onclick = () => {
  const newQid = 'draft-' + crypto.randomUUID().slice(0, 8);
  window.open('?qid=' + newQid, '_blank');
  // Optional: also clear current scratch? NO — current tab keeps its state.
};
```

This matches Varun's stated need: "currently if I open a new quote in a different tab, the quote I am working on also gets changed" → we want the old tab unchanged when a new quote opens.

Note: some browsers (Safari, Firefox in strict mode) block `window.open` outside a direct user gesture, but this is a click handler so it's allowed.

**Edge case:** the click on "New Quote" today is also used in the modal "discard scratch" confirm. With the new model, scratch is never lost (it lives in sessionStorage tied to the URL), so the confirm becomes unnecessary. Recommend dropping the `confirm()` dialog.

#### "Open Saved Quote" modal behaviour

Today: `openSavedQuote(id)` sets `active_quote_id`, `location.reload()`. The current tab now shows the loaded quote. (And every other tab, on its next loadState, also flips — the bug.)

New: open the saved quote IN THE CURRENT TAB (so the click feels normal — single-click → quote opens in front of you), but **change the URL** so the qid is now the ZUI ID:

```js
function openSavedQuote(id) {
  // No more "discard scratch" warning — scratch lives in its own sessionStorage entry,
  // and is reachable any time by navigating back to ?qid=draft-<id>.
  // BUT: warn if there are unsaved changes in the CURRENT tab's working state.
  // (Same-tab navigation will swap state. To get parallel, use right-click → New Tab on the list item.)
  history.pushState({}, '', '?qid=' + encodeURIComponent(id));
  window.__qbQid = id;
  // Re-boot in place (no reload) — but for safety, reload IS acceptable here since
  // it only affects the current tab.
  location.reload();
}
```

To support **"open this saved quote in a new tab"**, render the list item as an anchor `<a href="?qid=ZUI-2026-0142">` so users can ctrl-click / right-click → Open in New Tab and the browser does the right thing natively.

Implementation note: the click handler should NOT call `preventDefault()` if the user used a modifier key (ctrl/cmd/shift). Pattern:

```js
li.innerHTML = '<a href="?qid=' + encodeURIComponent(e.id) + '" class="qid-link">' + ... + '</a>';
li.querySelector('.qid-link').onclick = (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1) return; // browser-native new tab
  ev.preventDefault();
  openSavedQuote(e.id);
};
```

#### "Save" button behaviour (draft → ZUI promotion)

Today: explicit Save calls `QuoteStorage.save(state, name)` which assigns a `q_<ts>_<rand>` id, then `QuoteStorage.setActiveId(id)`, then `saveState(state)`. (Server then issues ZUI id separately via `ensureQuoteId`.)

New: when a draft tab is saved for the first time:

```js
async function onSaveClick() {
  let qid = window.__qbQid;
  if (qid.startsWith('draft-')) {
    // Promote draft → real ZUI id
    if (!state.quoteId) await ensureQuoteId(state);   // existing helper, calls server
    const realQid = state.quoteId;
    // Copy sessionStorage entry to new key
    sessionStorage.setItem('zuildup.quote.' + realQid, sessionStorage.getItem('zuildup.quote.' + qid));
    sessionStorage.removeItem('zuildup.quote.' + qid);
    window.__qbQid = realQid;
    history.replaceState({}, '', '?qid=' + encodeURIComponent(realQid));
    qid = realQid;
  }
  // Existing path: write named slot, fire cloud push.
  QuoteStorage.save(state, nameInputVal);  // (internally uses state.quoteId now)
}
```

`QuoteStorage.save` and `_touch` currently use a private `q_<ts>_<rand>` id. For 9B-2, refactor them to use `state.quoteId` (the ZUI id) as the canonical key. (This is largely already true once the server has assigned a ZUI id; the q_-prefix existed before server-side IDs.)

#### Import JSON / Duplicate Quote

Both currently `location.reload()` after writing to localStorage and setting `active_quote_id`. New flow:

- **Import:** create a fresh draft qid (or use the imported quote's ZUI if present), write sessionStorage entry for the current tab, then call `window.__qbRerender()` (or `location.reload()` as a defensive fallback).
- **Duplicate:** open in NEW TAB with the dup's new qid.

#### Cross-tab story

| Action in tab A | Effect on tab A | Effect on tab B (different qid) | Effect on tab B (SAME qid) |
|---|---|---|---|
| Edit form input | state changes in tab A's sessionStorage | none ✅ | tab B's sessionStorage is separate ✅, but localStorage named slot updates on each saveState — could cause tab B's `storage` listener (none in form-side) to fire. For form code, no-op. For preview iframe in tab B — see below. |
| Save (explicit) | writes localStorage named slot + cloud push | none ✅ | last-write-wins on the named slot. Acceptable for v1; flag in docs. |
| New Quote button | opens new tab with new draft qid | none ✅ | n/a |
| Open Saved Quote from modal | URL changes, current tab swaps to that qid | none ✅ | n/a |
| Refresh tab A | sessionStorage survives within tab, qid in URL re-read → state preserved ✅ | none ✅ | n/a |
| Close tab A | sessionStorage discarded; if qid was a draft, it's lost; if ZUI, named slot still in localStorage + Firestore ✅ | none ✅ | n/a |

**The preview iframe in tab A** lives in the same browsing context as the form, so it shares sessionStorage with tab A's form. Its `storage` event listener used to fire on cross-tab localStorage `STORE_KEY` writes. With sessionStorage, `storage` events DO fire across documents within the same tab (per HTML5 spec). The 700 ms `setInterval` is the belt-and-braces backup.

**One caveat:** the preview iframe also calls `loadState()` — which today reads localStorage. We need to make sure `bootPreview` (and its `paint` function) read sessionStorage for the qid that matches the parent tab's URL. Since `paint` re-runs every 700 ms via `setInterval`, the iframe will see fresh state. **Implementation note:** the iframe's `loadState` must read qid from `window.parent.location` (or be passed via `postMessage`), because the iframe's own `location.search` is `/preview` (no qid). Cleanest: in `bootPreview`, read `window.parent.__qbQid`. The iframe is same-origin so this works.

#### Edge cases (full enumeration)

| # | Scenario | Behaviour | Notes |
|---|---|---|---|
| 1 | Two tabs with same `?qid=ZUI-2026-0142` | Both can edit independently; last save to Firestore wins. Each tab has its own sessionStorage working copy. | Flag in v1 docs. Future: optimistic-lock with `If-Match` header. |
| 2 | User shares URL with `?qid=ZUI-2026-0142` | Recipient (authed) loads that quote. ✅ | New feature — bookmarkable quotes. |
| 3 | User clears browser data | All localStorage + sessionStorage gone. ZUI quotes survive in Firestore. Drafts lost. | Same as today. |
| 4 | Browser crash / power loss | sessionStorage of draft tab is lost. ZUI quotes safe via named slot + Firestore. | Same as today for drafts. Acceptable risk — drafts ARE drafts. |
| 5 | User refreshes a draft tab | sessionStorage entry for `draft-<uuid>` survives. State persists. ✅ | sessionStorage is per-tab, survives reload, dies on close. |
| 6 | User closes a draft tab before saving | Draft is lost forever. | Acceptable. To save, the user must click Save. (Future: auto-prompt-to-save on tab close via `beforeunload`.) |
| 7 | User has TWO tabs of the same draft qid (e.g. duplicated tab via Ctrl-T duplicate) | Both tabs share the sessionStorage entry (same browsing context if same window; separate if different windows). | Duplicating a tab in Chrome copies sessionStorage. So both will start with the same state, then diverge. Last save wins. Acceptable for v1. |
| 8 | Cloud Firestore has a quote that's not in localStorage yet | On Load Saved Quote modal: cloud sync runs (`syncFromCloud`). After sync, the quote shows in the list, click → URL nav → loadState reads from localStorage named slot. ✅ | Same as today, just the navigation pattern changes. |
| 9 | User has bookmarks of the root URL `/` (no qid) | New boot path generates a fresh draft qid on first load. URL silently becomes `?qid=draft-…`. ✅ | No bookmark breakage. |
| 10 | Migration: user had `STORE_KEY` populated before Phase 9B-2 deploy | First load with no qid → generates draft qid → migration block copies `STORE_KEY` into sessionStorage under that draft qid. User's scratch survives. `STORE_KEY` is preserved in localStorage for 30 days as insurance. | One-shot via `localStorage.migration.done` flag. |

### Code changes required (file:line + nature)

| # | File | Line(s) | Change |
|---|---|---|---|
| 1 | `app/quote.js` | top of `bootForm`, before line 1588 | Add qid resolution + URL rewrite + migration block. Set `window.__qbQid`. |
| 2 | `app/quote.js` | 21 | Keep `STORE_KEY` constant for migration use only; rename to `LEGACY_STORE_KEY`. |
| 3 | `app/quote.js` | 179–339 (`loadState`) | Refactor to take qid as implicit (`window.__qbQid`), read from sessionStorage first, then localStorage named slot, then defaultState. Strip the `active_quote_id` codepath. |
| 4 | `app/quote.js` | 345–360 (`saveState`) | Write to `sessionStorage['zuildup.quote.' + qid]`; if qid is non-draft, also `_touch` named slot. Drop the `STORE_KEY` write. |
| 5 | `app/quote.js` | 373–720 (`QuoteStorage`) | (a) Drop `ACTIVE_KEY` and `activeId()` / `setActiveId()` semantics — replace with no-op stubs that warn (for safety against stale callers). (b) Refactor `save()` and `_touch()` to key by `state.quoteId` (ZUI) instead of `q_<ts>` ids. |
| 6 | `app/quote.js` | 2025–2042 (New Quote button) | Change handler to `window.open('?qid=draft-' + uuid, '_blank')`. Drop the confirm dialog. |
| 7 | `app/quote.js` | 2278–2287 (`openSavedQuote`) | `history.pushState` + `__qbQid` swap + `location.reload()` (still acceptable per-tab; not cross-tab). Optionally render list items as `<a href>` for ctrl-click-new-tab. |
| 8 | `app/quote.js` | 2356–2380 (Import JSON) | Drop active-id flip; just write sessionStorage under a fresh qid and reload/rerender. |
| 9 | `app/quote.js` | 5106–5114 (Quick Build wizard apply) | Drop `QuoteStorage.setActiveId('')` + `localStorage.setItem(STORE_KEY, ...)`. Replace with sessionStorage write under current qid. Then optionally `__qbRerender()` instead of reload. |
| 10 | `app/quote.js` | 5210–5216 (`persistChatState`) | Replace with `sessionStorage.setItem('zuildup.quote.' + window.__qbQid, JSON.stringify(window.__qbState))`. Drop the active-id branch. |
| 11 | `app/quote.js` | 3725–3744 (`bootPreview`) | `loadState` for the preview reads `window.parent.__qbQid` and then `parent.sessionStorage.getItem('zuildup.quote.' + qid)`. Keep the polling + storage event listener as belt-and-braces. |
| 12 | `app/quote.js` | various `saveState(state)` callers | No-op — saveState signature unchanged. |
| 13 | `docs/PROJECT_CONTEXT_FULL.md` | §2 Data layer | Update to reflect new storage layout. (Doc change, not code.) |

### Test plan

#### Two-tab independence (the core fix)
1. Open `/` in tab A → URL becomes `?qid=draft-aaaa1111`.
2. Open `/` in tab B → URL becomes `?qid=draft-bbbb2222` (different draft id).
3. Set tab A customer name = "Alice".
4. Set tab B customer name = "Bob".
5. ✅ Tab A still shows "Alice"; tab B shows "Bob".
6. Reload tab A. ✅ Still "Alice".
7. Reload tab B. ✅ Still "Bob".

#### Open Saved Quote independence
1. Pre-seed two saved ZUI quotes in Firestore: Q1 = ZUI-2026-0101 (customer "Acme"), Q2 = ZUI-2026-0102 (customer "Beta").
2. Tab A: open Load modal, click Q1 → URL becomes `?qid=ZUI-2026-0101`, form shows Acme.
3. Tab B (open in a NEW tab via the New Quote button): URL is `?qid=draft-...`.
4. In tab B, open Load modal, click Q2 → URL becomes `?qid=ZUI-2026-0102`, form shows Beta.
5. ✅ Tab A's URL is unchanged (still `?qid=ZUI-2026-0101`), form still shows Acme.
6. ✅ Tab B shows Beta.

#### New Quote opens in new tab
1. Tab A is on quote Q1.
2. Click New Quote button.
3. ✅ New tab opens with `?qid=draft-...`. Tab A stays on Q1.

#### Migration
1. Pre-populate localStorage `zuildup.quote.v2` with a known state (customer = "Migrate Me").
2. Make sure `zuildup.migration.done` is NOT set.
3. Open `/` for the first time post-deploy.
4. ✅ URL becomes `?qid=draft-...`. The form loads with customer "Migrate Me" (state was migrated into sessionStorage). `zuildup.migration.done` is now set. `zuildup.quote.v2` is STILL present in localStorage (kept for 30 days).

#### Refresh persistence
1. Edit a quote in tab A. Don't save.
2. Refresh tab A.
3. ✅ The unsaved edits are still there (sessionStorage persists across reload within same tab).

#### Cross-browser-tab via URL share
1. Tab A: open quote Q1, customer Acme, ZUI-2026-0101.
2. Copy URL.
3. Paste URL in a new browser window (different session — incognito).
4. Authenticate.
5. ✅ Quote Q1 loads from localStorage named slot (if cached) or Firestore (via sync). Customer Acme shown.

#### Two tabs of the same ZUI quote (acceptable race)
1. Tab A: open ZUI-2026-0101.
2. Tab B: paste same URL `?qid=ZUI-2026-0101` → loads Q1.
3. In tab A, change customer name to "Alice v2". Save.
4. In tab B, change customer name to "Bob v2". Save.
5. ✅ Last save wins in Firestore + localStorage named slot. (Document this v1 behaviour. Future: lock UI.)

#### Quick Build wizard (no longer affects other tabs)
1. Tab A on a draft quote.
2. Tab B on a draft quote (different draft qid).
3. In tab A, run Quick Build wizard → apply. Tab A's quote regenerates.
4. ✅ Tab B's quote is UNCHANGED. (Today: tab B silently swaps.)

#### Quick Build wizard (no longer requires reload — bonus, depends on 9B-1 landing)
1. Run wizard, click "Generate quote" → state regenerates.
2. ✅ Form repaints inline via `__qbRerender()`. No flash. (Optional; fallback to reload if 9B-1 not yet merged.)

### Risks + rollback

- **Risk R4 (data loss):** A user has a critical scratch quote in `STORE_KEY` and the migration logic fails (e.g. malformed JSON). Mitigation: do NOT delete `STORE_KEY` for 30 days. Add a console.warn + toast if migration was attempted. Also expose a "Recover from legacy scratch" button in a Settings panel for power users.
- **Risk R5 (preview iframe break):** The iframe's `loadState` can't read parent's sessionStorage if origin checks fail. Mitigation: same-origin guarantee holds (iframe `src=/preview` is same origin). Test in Chrome, Firefox, Safari before ship.
- **Risk R6 (auto-save behaviour):** Today's auto-save only fires when there's an active id (line 2389+). With qids always set, auto-save would fire for drafts too — which means draft sessionStorage gets touched on every keystroke. That's fine for sessionStorage. But also we should NOT auto-cloud-push drafts. So gate the cloud push on `!qid.startsWith('draft-')`. Implementation subagent: audit auto-save flow.
- **Risk R7 (URL ugliness):** `?qid=draft-c8a7e2f1` is visible to the user. Acceptable trade-off for shareable URLs of real quotes. Could use shorter draft IDs (4 chars) to be less noisy.
- **Risk R8 (multi-tab confusion):** Sales rep doesn't realise tab A and tab B are now independent. Mitigation: small badge in toolbar showing "tab id: draft-c8a7" / "tab id: ZUI-2026-0142" so reps can ident
ify which tab is which. Phase 9B-2 nice-to-have, not blocker.

### Estimated effort: **8–12h**

- 1 h: design review + read all 13 touchpoints in code.
- 3 h: refactor `loadState` / `saveState` / `QuoteStorage`.
- 2 h: change New Quote, Open Saved, Import, Duplicate handlers.
- 1 h: rework Quick Build wizard apply + AI Edit `persistChatState`.
- 1 h: preview iframe qid lookup.
- 2 h: migration block + manual cross-browser testing.
- 1 h: docs update.

---

## Implementation order

1. **9B-1 — Issue 6 (3–4 h).** Smaller, lower risk, immediate sales-team relief. Ship first.
2. **9B-2 — Issue 4 (8–12 h).** Bigger refactor. Ship as a separate commit + Cloud Run revision so each can be verified / rolled back independently.

Both should depend on **Phase 9A** being merged first (9A touches `applyWizard` in the same file) — confirmed by the orchestrator. If 9A is still open when 9B-1 is ready, 9B-1 can be implemented on a branch off the 9A branch.

---

## Acceptance criteria summary (verbatim, for the implementing subagent)

### 9B-1 (Issue 6)
- [ ] `window.__qbRerender` is defined inside `bootForm()` and re-hydrates ALL form inputs that the boot hydration block hydrates.
- [ ] `doApply` in `initAIChat` no longer calls `location.reload()` on the happy path. Drawer stays open. Input is empty + focusable.
- [ ] Toast says "Applied N changes" (no "Reloading…" suffix).
- [ ] Preview iframe updates within 700 ms via existing `quote-state-changed` event + setInterval.
- [ ] Defensive fallback: if `__qbRerender` throws, fall back to `location.reload()` so users never get a broken UI.
- [ ] All 8 test plan scenarios pass in a real browser.

### 9B-2 (Issue 4)
- [ ] Every tab has its own qid in the URL.
- [ ] No tab affects another tab's working state via localStorage.
- [ ] Migration: `STORE_KEY` legacy scratch is imported into sessionStorage of the first new-deploy boot.
- [ ] Saved (ZUI) quotes still work in localStorage named slot + Firestore.
- [ ] New Quote button opens a fresh draft in a NEW TAB.
- [ ] Open Saved Quote modal supports ctrl-click → open in new tab.
- [ ] Refresh tab preserves working state (sessionStorage survives reload).
- [ ] Preview iframe correctly mirrors the parent tab's qid (not some sibling tab's).
- [ ] All test-plan scenarios pass in Chrome + Firefox + Safari.
- [ ] PROJECT_CONTEXT_FULL.md §2 updated to reflect new storage layout.

---

## Open questions for Varun

(Most have a clear default in the design; flagging where Varun's signoff would be useful before ship.)

1. **Q-9B-A:** "Open Saved Quote from the modal" — confirm desired behaviour:
   - **Default (recommended):** single-click opens in CURRENT tab; ctrl-click opens in NEW tab.
   - Alternative: every Load Saved Quote always opens in a new tab. (Safer for parallel work, but worse single-click UX.)
   - Going with default unless you say otherwise.
2. **Q-9B-B:** Confirm we can drop the `confirm("Discard scratch?")` dialogs that exist today on New Quote / Open Saved / Import. With sessionStorage qids, scratch quotes are never silently lost — they're reachable via the URL.
3. **Q-9B-C:** Tab-id badge in toolbar — nice-to-have ("tab: ZUI-2026-0142" or "tab: draft-c8a7"). Ship in 9B-2 or push to 9D?
4. **Q-9B-D:** Same-quote-in-two-tabs (race condition) — acceptable for v1 with last-write-wins? Or block the second tab with a "this quote is open elsewhere" banner? (Default: accept the race. Lock is over-engineering until reps actually hit it.)
5. **Q-9B-E (9B-1 specific):** For Apply patches that change `build.hasBasement` / `build.floors` / `build.buildType` — go with Mitigation A (proper refactor of row reconciliation) or Mitigation B (heavy-reload short-circuit)? Recommendation: A. But B ships faster.

---

## Handoff checklist for the implementing subagent

When picked up:

- [ ] Read this entire doc top-to-bottom.
- [ ] Read `PHASE_9A_VERIFICATION.md` to understand what 9A touched in `app/quote.js` (avoid merge surprises).
- [ ] Confirm 9A is merged (HEAD on master includes the 9A commit).
- [ ] Branch off latest master. Suggested branches: `phase-9b-1-no-reload-apply` and `phase-9b-2-url-qid-sessionstorage`.
- [ ] Implement 9B-1. Cut a commit. Deploy to Cloud Run. Manual-test all 8 scenarios. DM Varun the live revision id + a 30-second screen recording showing the drawer staying open after Apply.
- [ ] Implement 9B-2. Cut a commit. Deploy. Manual-test all scenarios across Chrome + Firefox + Safari. DM Varun with a side-by-side video: tab A on one quote, tab B on another, edits to A don't affect B.
- [ ] Update `PROJECT_CONTEXT_FULL.md` and add a `PHASE_9B_2026-05-21.md` work log.
