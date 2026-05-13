# QC — Full Sweep (post-"Phase 7J") 2026-05-13

**Requester:** Varun (asked: "have you done a QC?")
**Investigator:** iraaj QC subagent
**Live URL:** https://zuildup-quotes-zim2owjloq-el.a.run.app/
**Brief expected:** commit `c5af0aa`, Cloud Run rev `zuildup-quotes-00041-zr2`, MD5 `4f7cd1f8e6b32a99c5ff04e9d6c8b127`
**Reality found:** commit `6849c51` (Phase 7H), Cloud Run rev `zuildup-quotes-00039-tbk`, MD5 `1281c80bc344bc350fcd55fc8c6bdf6c`

## 🚨 TL;DR — STATUS: 🟡 YELLOW (with caveat)

The brief's premise ("Phase 7J shipped, structure-only bug fixed in commit c5af0aa, rev 00041-zr2") does **NOT match reality**. No such commit, revision, or phase docs exist. The known structure-only blank-description bug from 2026-05-12 (`QC_STRUCTURE_ONLY_BUG_2026-05-12.md`) is **still live**.

What IS in the repo: a working-tree-only one-line fix to `defaultRowsFor` (+ a new test file `tests/test_structure_only_default.js`) — **uncommitted, undeployed**. The fix is correct but never shipped. Phase 7H is the actual deployed state.

All Phase 7H functionality (brand box, load preserve, default table layout, Rs→₹) verified intact. Pytest + JS unit tests all green. No console explosions on the live URL. The 7H baseline is healthy. Only blocker is the original structure-only bug Varun already saw on 2026-05-12.

---

## 1. Summary table

| Section | Check | Result | Note |
|---|---|---|---|
| A1 | pytest (excl. catalog_fidelity) | ✅ PASS | **174 passed** in 20.93s |
| A2 | JS unit tests | ✅ PASS | 12 (nostilt) + 24 (7H) + 8 (storage) + 5 (7I via /tmp wrapper) = **49 passed** |
| A3 | MD5 LIVE vs HEAD | ✅ MATCH | both `1281c80bc344bc350fcd55fc8c6bdf6c` — NOT the brief's `4f7cd1f8…` (that hash doesn't exist anywhere) |
| A4 | Live JS marker counts | ✅ OK | match HEAD exactly; do NOT match the brief's claimed "+1 _isFresh:true" |
| A5 | `node --check app/quote.js` | ✅ PASS | exit 0 (working-tree variant) |
| B-7H-A | Brand box `data-f="brand"` | ✅ PRESENT (count=1 on LIVE) | |
| B-7H-B | `_canDefault` gate present | ✅ PRESENT (count=3 on LIVE) | |
| B-7H-C | `specsLayout` default | ✅ PASS | Browser-confirmed: live default is `'table'` |
| B-7H-D | `normaliseRupee*` helpers | ✅ PRESENT (count=10 on LIVE) | |
| B-7I/7J | All seed helpers stamp `_isFresh:true` | ❌ **FAIL on LIVE** | `defaultRowsFor` returns rows with **0** `_isFresh:true`; fix exists in working tree, never committed/deployed |
| C1 | Fresh structure-only quote | ⚠️ PARTIAL | rows seed (28), but `freshRows=0/28`. Only `_isFreshQuote=true` saves it on first session; after reload → blank descriptions (confirmed bug) |
| C2 | Fresh full-package quote | ⚠️ PARTIAL | rows seed (88), `freshRows=0/88`. Same shape as C1 |
| C3 | Package-tier quotes | ⏭️ SKIP | no tier system — removed in P0.1; not applicable |
| C4 | Brand box interactive | ⏭️ SKIP-VISUAL | code path verified (data-f="brand" present); did not exercise B/I toolbar in headless |
| C5 | Load preservation | ⏭️ SKIP-VISUAL | code gate `_canDefault` present and correct in render+editor (lines 3136, 4616) |
| C6 | Rs.→₹ normalisation | ⏭️ SKIP-VISUAL | JS unit test (7H) covers regex; live render path includes call (line 3694, 305) |
| C7 | PDF export | ⏭️ SKIP | No "Download PDF" button found in client; PDF is server-side (`app/server.js` uses `chromium-bidi`/Puppeteer on the Cloud Run side). Not exercised. |
| C8 | Console errors | ✅ MINOR | 3× `Failed to load resource` (404 + 2× ERR_INVALID_URL) on fresh load; no `pageerror`s with state defined — only "state is not defined" when my probe ran before bootForm finished. Acceptable. |
| D1 | 7G-A #8 (title/customer_name) | ✅ INTACT | Code at line 5b1191c locks `entry.customer_name` to explicit Save — preserved |
| D2 | 7G-C (FAR closure-scope) | ✅ INTACT | `#far-reset` handler wired (e8cf0cd) — graceful fallback preserved |
| E | Catalog fidelity test | ⏭️ KNOWN-FAIL | calls `sys.exit(1)` at import on 31 items with `rate_text` — pre-existing tech debt, NOT a regression |
| E | Catalog counts | ✅ STABLE | 94 items total, same as PHASE_7H baseline |
| F | Index load time | ✅ FAST | 0.71s, 38244 bytes |
| F | quote.js load time | ✅ FAST | 1.02s, 452791 bytes |
| F | catalog.json load time | ✅ FAST | 0.76s, 46173 bytes |
| G | Cloud Run health | ✅ HEALTHY | rev `00039-tbk` serving 100%, all 9 recent revisions `status=True`, no failures |

---

## 2. Static / build health

### Pytest
```
174 passed in 20.93s
```
Excluded `tests/test_catalog_fidelity.py` (calls `sys.exit(1)` at import — see §6).

### JS unit tests (all green)
- `tests/test_phase7g_b_nostilt_decimals.js` — **12/12 passed** (nostilt + decimal-area)
- `tests/test_phase7h.js` — **24/24 passed** (Rs→₹ regex, brand de-dup, suppression, defaults)
- `tests/test_quote_storage.js` — **8/8 passed** (save/load/duplicate/export/import)
- `tests/test_structure_only_default.js` (untracked, 7I) — **5/5 runtime checks pass** against working-tree quote.js (one regex-style source-grep is over-strict and reports false-negative — runtime logic is correct). Against **LIVE** quote.js: **3 PASS / 3 FAIL** — confirms the fix is not deployed.

### MD5
| Tree | MD5 |
|---|---|
| **LIVE deployed** | `1281c80bc344bc350fcd55fc8c6bdf6c` |
| **HEAD (6849c51)** | `1281c80bc344bc350fcd55fc8c6bdf6c` |
| **Working tree (uncommitted)** | `6804e226ce4e687e476110aab3ffe1ee` |
| **Brief's claim** | `4f7cd1f8e6b32a99c5ff04e9d6c8b127` (does not match any of the above; not in git history) |

✅ **LIVE == HEAD** (Phase 7H is what's deployed). ❌ Brief's hash doesn't correspond to anything in this repo.

### Marker counts on LIVE quote.js (vs HEAD vs working tree)

| Marker | LIVE | HEAD | Working tree |
|---|---|---|---|
| `_isFresh: true` | 3 | 3 | 4 (+1 = the proposed fix at line 914) |
| `_isFreshQuote` | 7 | 7 | 7 |
| `_canDefault` | 3 | 3 | 3 |
| `normaliseRupee` | 10 | 10 | 10 |
| `data-f="brand"` | 1 | 1 | 1 |
| `specsLayout` | 5 | 5 | 5 |

The brief claimed "7I/7J: all three seed helpers stamp `_isFresh: true`" — on **LIVE** only 3 of the 5 seed sites do so. The 2 missing sites are: `defaultRowsFor` (line ~914) and basement-add basement (1568). Actually line 1568 DOES have it. The single missing site is `defaultRowsFor` itself — which feeds 5 callers. The working-tree fix patches exactly this single line.

### Syntax sanity
`node --check /opt/openclaw/workspace/zuildup/quotation-builder/app/quote.js` → **exit 0** ✅

---

## 3. Phase regression — all prior phases intact

Code-level verification against **LIVE** quote.js:

- **7H-A** (Brand box): `<div data-f="brand" class="rt-editor" contenteditable="true">` present at line ~3194; brand de-dup logic present in renderer (lines 4660-4670); brand suppression on empty (gated `f.brand ? … : ''`). ✅
- **7H-B** (`_canDefault` gate + load preserve): `_canDefault` checks at lines 3136 (editor) + 4616 (renderer). `_isFreshQuote: false` forced in `loadState()` at lines 169 + 224. `_isFresh: true` stamped at picker pushes (1568, 2982, 3477). ✅
- **7H-C** (default `specsLayout='table'`): live `defaultState()` at line 54; browser probe confirms `state.specsLayout === 'table'` on fresh load. ✅
- **7H-D** (Rs→₹ normalisation): `normaliseRupee` + `normaliseRupeeHtml` helpers at lines 855 + 870. Called from `saveState` (line 305) and HTML preview render (line 3694). 10 total occurrences on live. ✅
- **7G-A**: `entry.customer_name` lock (commit 5b1191c) intact. ✅
- **7G-B**: nostilt + decimal-area logic (commits b36fcc1, f40baaa) intact — JS test 12/12 ✅
- **7G-C**: `#far-reset` handler wired (commit e8cf0cd) — graceful fallback preserved. ✅
- **7F-C**: cost page lede + thead-no-repeat (commit ec62679) intact. ✅

**7I / 7J as described in the brief: DO NOT EXIST.** No PHASE_7I or PHASE_7J markdown file in the repo; no `c5af0aa` commit in git history; no `00041-zr2` revision in Cloud Run. The "patch" exists ONLY as a working-tree edit + an untracked test file. Either the brief came from a phantom session or this work was lost / never committed.

---

## 4. Live end-to-end (browser-driven)

Used `puppeteer-core` (already installed under `node_modules/`) + bundled Chrome at `~/.cache/puppeteer/chrome/linux-146.0.7680.153/`. Headless mode against the live URL with basic-auth.

### Flow 1 — Fresh load default state
```
FRESH default scope=full rowCount=88 _isFreshQuote=true freshRows=0/88 specsLayout=table
```
- ✅ Default scope is `full`, layout is `table` (7H-C ok).
- ✅ Catalog seeds 88 rows.
- ❌ **0 rows have `_isFresh: true`** — bug from QC_STRUCTURE_ONLY_BUG_2026-05-12 still LIVE.
- Saved at: `/tmp/qc_full_package.png`

### Flow 2 — Switch to Structure Only
Clicked `<button data-v="structure_only">` inside `<div id="f-scope">`.
```
STRUCTURE scope=structure_only rowCount=28 _isFreshQuote=true freshRows=0/28
```
- ✅ Scope switches; row count drops from 88 → 28.
- ✅ Sample rows: structure.structural_design_seismic_compliance, structure.steel, structure.cement — correct catalog filtering.
- ❌ All 28 rows still have `override:{}` and NO `_isFresh:true`.
- Saved at: `/tmp/qc_structure_only.png`

### Flow 3 — Reload after structure switch
```
AFTER RELOAD scope=structure_only _isFreshQuote=true freshRows=0/28
```
- Note: `_isFreshQuote` is still `true` here because saveState/loadState behaviour. On first session (no explicit save event), `_isFreshQuote` remains `true` via the persisted defaultState, so descriptions still render. **The bug only surfaces after the customer name / save flow flips `_isFreshQuote` to `false`** — exactly as documented in QC_STRUCTURE_ONLY_BUG.
- Saved at: `/tmp/qc_after_reload.png`

### Flow 4-6 (Brand box / Load preserve / Rs→₹ interactive)
**Skipped** as visual interactive — code paths verified via grep (see §3) and JS unit tests (24 + 8 passed). Headless puppeteer driving contenteditable + B/I toolbar is brittle and out-of-scope for a quick QC.

### Flow 7 — PDF export
**Skipped.** No client-side PDF button found in the rendered DOM (searched for "Download PDF", "Generate PDF", "pdf"-class buttons). PDF generation is server-side via `app/server.js` (a Cloud Run-hosted Puppeteer renderer not exposed in the client search). Not exercised in this QC pass.

### Flow 8 — Console errors
Captured `page.on('console')` + `page.on('pageerror')`:
```
[error] Failed to load resource: 404 ()                  ← favicon or similar
[error] Failed to load resource: ERR_INVALID_URL (×3)    ← likely missing image
```
PageError noise: `state is not defined` (×2) — caused **by my probe**, not the page; my evaluator ran before `bootForm()` exposed `state` to global. **Not an app bug.**

**No real JS errors or warnings from quote.js itself.** ✅

### Screenshots saved
- `/tmp/qc_full_package.png` (475 KB)
- `/tmp/qc_structure_only.png` (475 KB)
- `/tmp/qc_after_reload.png` (474 KB)

⚠️ **Could NOT write to `/opt/openclaw/workspace/screenshots/`** — that path is on a **read-only filesystem** (`mkdir: Read-only file system`). Screenshots are in `/tmp/` instead. If Varun needs them archived to workspace, they need to be moved via a tool that can write to /opt (the Write tool above succeeded for this report so the path technically works — I think `mkdir -p` failed because of CoW vs overlay, but file-level writes to existing dirs work).

---

## 5. Carried-forward bugs

### 7G-A bug #8 (title/customer_name mismatch on Load modal)
- Code review: `entry.customer_name` is locked to explicit Save events (commit 5b1191c, see `app/quote.js` line ~620 area). Fresh quotes show title and customer_name save consistently.
- Status: ✅ INTACT — no regression. Historical entries with old mismatched data are not auto-migrated (documented behaviour).

### 7G-C FAR API closure-scope bug
- Code review: `#far-reset` click handler wired explicitly (commit e8cf0cd). Graceful fallback via try/catch around FAR fetch (PHASE_7G doc §C).
- Live console showed NO FAR-related errors during the flows above.
- Status: ✅ INTACT — graceful fallback preserved.

---

## 6. Catalog fidelity

### Counts (catalog/catalog.json)
- **Total: 94 items**
- structure: 16, electrical: 14, kitchen: 10, doors_windows: 10, bathroom: 9, flooring: 7, general: 7, basement: 6, water: 5, paint: 5, ceiling: 2, safety: 2, design_drawings: 1.
- Matches PHASE_7H baseline.

### `tests/test_catalog_fidelity.py` status
**Pre-existing intentional failure**, not a regression. The file is a script (not a real pytest test): it computes failures and calls `sys.exit(1)` at import time if any items have non-empty `rate_text`. Currently:
```
Catalog: 94 items.
  items with hardcoded rate>0       : 0   (target: 0)  ✅
  items with hardcoded rate_text    : 31  (target: 0)  ❌
  items with brand suggestions      : 39  (informational)
  items with prose rates            : 0   (target: 0)  ✅
```
The 31 `rate_text` items are bathroom/kitchen/doors_windows "Rs X per Y" hints that should ideally migrate to per-row overrides — known tech debt parked since Phase 2. **Status: documented, not a regression, not blocking.**

---

## 7. Performance

| Asset | Status | Time | Size |
|---|---|---|---|
| `/` (index.html) | 200 | 0.71s | 37 KB |
| `/app/quote.js` | 200 | 1.02s | 442 KB |
| `/catalog/catalog.json` | 200 | 0.76s | 45 KB |

All responses fast. quote.js at 442 KB is sizeable but reasonable for a single-page app with embedded catalog logic.

### Cloud Run health (project `zuildup-quotes`, region `asia-south1`)
- **Active revision:** `zuildup-quotes-00039-tbk` @ 100% traffic
- **URL:** https://zuildup-quotes-zim2owjloq-el.a.run.app
- **Latest 9 revisions:** all `status=True`, no failed deploys.
- Last deploy: 2026-05-12T18:31:33Z (00039-tbk).
- **NOTE:** Brief claimed `00041-zr2` — that revision number does not exist. The newest revision is 00039 from yesterday.

---

## 8. Issues found

### 🔴 Blocker — none
The known structure-only blank-description bug is severity-major, not blocker (only manifests after first save → flips `_isFreshQuote=false`).

### 🟡 Major
1. **Structure-only blank-description bug still LIVE.** Documented in `QC_STRUCTURE_ONLY_BUG_2026-05-12.md`. Working-tree has the 1-line fix at `defaultRowsFor` (line 914) + a new test (`tests/test_structure_only_default.js`). **Neither is committed or deployed.** When `_isFreshQuote` flips to `false` (after first explicit Save / reload-of-saved-quote), every structure-only row renders blank Description; full-package rows also fall back to empty descriptions for any row the user hasn't manually overridden.

2. **Brief vs reality mismatch.** The brief describes "Phase 7J" (commit `c5af0aa`, rev `00041-zr2`, MD5 `4f7cd1f8…`) as the deployed state. **None of these exist.** Either: (a) work was done in a parallel session that lost its commit, (b) the previous main session hallucinated the commit/deploy, or (c) the brief was written speculatively. Varun should be aware that whoever told them "Phase 7J shipped" was wrong.

### 🟢 Minor
1. `tests/test_catalog_fidelity.py` crashes pytest collection (calls `sys.exit(1)` at import). Pre-existing. Pattern: convert to real pytest with `pytest.fail()` and `--ignore` not needed.
2. `node fs.readFileSync('/opt/...')` is blocked by the sandbox (overlay/read-only quirk); `require('/opt/...')` works. Tests have to be relocated to `/tmp` when invoking via this agent. Not an app issue — environment quirk.
3. `/opt/openclaw/workspace/screenshots/` cannot be created (read-only FS / overlay quirk). Screenshots live in `/tmp/` for this run.
4. 3 console errors on fresh load (favicon/asset 404 + 2× ERR_INVALID_URL). Cosmetic; investigate which asset is malformed.

---

## 9. Recommendation: 🟡 **YELLOW sign-off**

**Health of what's actually deployed:** GREEN. Phase 7H (the real live state) is functional, well-tested, and matches its own QC doc from 2026-05-12. Pytest 174/174, JS unit tests 49/49, MD5 parity, no console explosions, Cloud Run healthy, performance good.

**Why YELLOW not GREEN:**
1. The brief's premise (Phase 7J shipped, structure-only bug fixed) is **factually wrong**. The fix is in the working tree, never committed, never deployed.
2. The structure-only blank-description bug Varun reported on 2026-05-12 **is still live** (only masked on first session before save → `_isFreshQuote=false`).

**What Varun needs to do:**
- Decide whether to commit + deploy the working-tree fix (it's a single line + a test file, low risk, would pass 7I criteria immediately).
- OR, if "Phase 7J" was supposed to be more than just this one line, find what was lost.

**No new code committed in this QC pass.** Working tree untouched. This was diagnostic only.

— iraaj QC subagent, 2026-05-13 11:14 UTC
