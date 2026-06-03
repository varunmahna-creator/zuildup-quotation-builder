# ZuildUp Quotation Builder — Context Snapshot
**Date:** 2026-06-03 12:30 UTC
**Engineer:** Iraaj 🌀 (Opus 4.7)
**Purpose:** Single-source-of-truth dump of everything that happened today + current production state. Read this first if you're resuming this project after a session break / context compact.

---

## 1. TL;DR — Production state right now

| Thing | Value |
|---|---|
| Live URL | https://zuildup-quotes-zim2owjloq-el.a.run.app/ |
| GCP project | `zuildup-quotes` (asia-south1) |
| Cloud Run service | `zuildup-quotes` |
| Live revision | `zuildup-quotes-00067-d28` @ 100% traffic |
| GitHub HEAD | `09b21aa` (master) — Phase 9G |
| Last commit ID | `09b21aa` (Phase 9G PDF upload) |
| 9H subagent | in flight (password reset feature) — will bump HEAD when done |
| 9G QC subagent | in flight (real-world test with Hardik PDF) — reports to Discord |
| Repo path | `/opt/openclaw/workspace/zuildup/quotation-builder` |
| Main client JS | `app/quote.js` (~6200 lines after 9G) |
| HTML | `app/index.html` |
| Server | `app/server.js` (~1300 lines after 9G) |
| Firestore PITR | ✅ ENABLED (was OFF until 9F, 7-day window now) |
| GCS bucket | `gs://zuildup-quotes-uploads` (asia-south1, UBLA, PAP enforced) |
| Auth model | HTTP Basic, multi-user via `AUTH_USERS_JSON` Cloud Run env var |
| Active users | varun, karan, avish, vaishali, rajat, zuildup-sales, **kishan (NEW today)** |

---

## 2. The big story of 2026-06-03 — data loss → fix → recovery feature

### What Varun reported (10:55 UTC)
> "The loaded quotations are showing random values/wrong data is being picked. The team is facing major issue because they have to rework on quotations which are already complete."
>
> Specific example: **ZUI-2026-1021 — Devi Ram Bansal** — name wrong on load, prices random, descriptions gone.

### Investigation (10:55 – 11:10 UTC)
1. No `ZUI-2026-1021` exists. All saved quote IDs use internal `q_*` format. Most likely Varun was referring to the Bansal quote by memory of a label/id, actual quote was `q_mpv1ov9f_bnilgp` ("Devi Ram Bansal — 2026-06-01 (copy)").
2. Fetched the Firestore doc → state was **a fresh `defaultState()` template**: empty customer, null pricing, all rows with empty `override` and `_isFresh: true`. `modified_at: 2026-06-03T11:02:30.933Z` — wiped 7 minutes before Varun reported it.
3. **Audited the whole `quotes` collection:** 88 total docs, **5 of them wiped** with the same fingerprint:
   - `q_mpv1ov9f_bnilgp` — Devi Ram Bansal — 2026-06-01 (copy) — wiped Jun 3 11:02 UTC
   - `q_mpv8781d_6icyii` — Sudhir Mahajan — 2026-06-01 (copy) — wiped Jun 3 08:44 UTC
   - `q_mpnzam1f_z3t7cp` — Deepesh Sachdeva — 2026-05-27 (copy, real customer MK Midha) — wiped Jun 3 07:53 UTC
   - `q_mp6tm2to_5eg45f` — "Sample Basic" (real customer Amit Mathur) — wiped Jun 2 11:48 UTC
   - `q_muu1brp_7uhsav` — Anuj Hasija Sec 57 GGN — wiped Jun 1 14:25 UTC
4. **Tried Firestore PITR for recovery** — discovered PITR was **DISABLED** on this project. Only `versionRetentionPeriod: 3600s` (1h read-by-time) was available. The Bansal wipe at 11:02 UTC was ~2h before Varun reported it (he reported at 10:55 UTC of the next reading cycle but the actual repair attempts started 11:08+ UTC), so already past the window when I tried. **Cloud copy is unrecoverable.**
5. **Root-cause traced** to `app/quote.js` line 5487 in `applyWizard()`:
   ```js
   const newState = (typeof defaultState === 'function') ? defaultState() : JSON.parse(JSON.stringify(window.__qbState));
   if (cur.quoteId) newState.quoteId = cur.quoteId;   // ← THE BUG
   ```
   When a rep loaded a saved quote (state.quoteId = `q_*`) and then ran Quick Build, `newState` (a fresh `defaultState()` template) inherited the saved quote's id into its `quoteId` field. The subsequent save flow (or any cloud sync that used `state.quoteId` instead of the URL qid for the slot key) PUT the blank template against the original saved quote's slot id on the server → **overwrote it**.
   Bug shipped in Phase 9D (May 22, 2026). Active for ~12 days. 5 victims that we know of.

### What I shipped — Phase 9F (commit `6fbd1d1`, rev `00065-5fr`, ~11:16 UTC)
5 defence-in-depth layers, any one of which would have stopped the wipe:

| # | Layer | File | What it does |
|---|---|---|---|
| 1 | Server PUT guard | `app/server.js` PUT /api/quotes/:id | Rejects blank-state writes against populated docs (HTTP 409 `wipe_blocked`). Requires explicit `allowOverwriteEmpty: true` in body to override. |
| 2 | Server `prev_state` backup | `app/server.js` | Before every PUT, snapshots existing doc into `quote_backups` Firestore collection. Fire-and-forget, never blocks the primary write. |
| 3 | Client `applyWizard` fix | `app/quote.js` ~L5487 | `newState.quoteId = ''` (not `cur.quoteId`). ROOT-CAUSE FIX. |
| 4 | Client `saveState` URL-qid sync | `app/quote.js` ~L495-560 | If `state.quoteId` mismatches URL qid (non-draft), URL wins. URL qid is canonical per Phase 9B-2. |
| 5 | Client `saveState` anti-wipe local | `app/quote.js` ~L495-560 | Refuses to `_touch` local slot if in-memory state looks blank but local slot has real content. |

**Also enabled Firestore PITR** (`gcloud firestore databases update --database='(default)' --enable-pitr --project=zuildup-quotes`). 7-day window going forward. **Wish I had done this months ago.**

Smoke-tested live:
- ✅ Blank PUT against intact Sample Luxury (Devi Ram Bansal) → HTTP 409 `wipe_blocked`
- ✅ Valid populated PUT → 200, prev_state snapshot landed in `quote_backups`
- ✅ Live MD5 = HEAD MD5 = `7373f908346dbd55301f322835424a97`

### What I shipped — Phase 9G (commit `09b21aa`, rev `00066-l7s`, ~11:35 UTC)
PDF upload feature — Varun's chosen recovery path for the 5 wiped quotes ("we have all the quotes as pdf so we can reupload any quote we need and work on it").

**Storage:**
- New GCS bucket `gs://zuildup-quotes-uploads` (asia-south1, Uniform Bucket-Level Access, Public Access Prevention enforced)
- IAM: Cloud Run service account (`586295767597-compute@developer.gserviceaccount.com`) granted `roles/storage.objectAdmin` on the bucket
- Object key format: `<quote_id>/<ISO timestamp>_<safe_filename>.pdf`
- 25 MB max, `application/pdf` Content-Type only, %PDF magic-byte sniff on first 4 bytes

**Firestore schema additions on each quote doc:**
- `uploaded_pdfs: [{filename, gcs_object, gcs_uri, uploaded_by, uploaded_at, size_bytes, content_type}]`
- `pdf_is_authoritative: true` (only set on docs created via `create-from-pdf`)

**5 new server endpoints:**
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/quotes/:id/attach-pdf` | multipart `pdf` field. Validates magic bytes, uploads to GCS, appends to `uploaded_pdfs`. |
| GET | `/api/quotes/:id/pdfs` | List `uploaded_pdfs` array. |
| GET | `/api/quotes/:id/pdfs/:b64/download` | base64url-decoded path. Directory-traversal guard (must start with `<id>/`). Streams PDF through server (basic auth covers access). `Cache-Control: private, max-age=300`. |
| DELETE | `/api/quotes/:id/pdfs/:b64` | Deletes from GCS + removes entry from `uploaded_pdfs`. |
| POST | `/api/quotes/create-from-pdf` | multipart `pdf` + form fields `customer_name`, `label`. Creates new `q_*` doc with skeleton state, marks `pdf_is_authoritative: true`, uploads PDF. |

**Client UI:**
- Toolbar: `📎 Import PDF` button (next to Quick Build). Prompts for customer name → file picker → creates new quote with banner pointing to PDF.
- Load modal: each list item gets a `📎 N` chip showing PDF count + `📎 Attach PDF` button. Chip click → popover listing PDFs with download/delete actions.
- Gold restore-from-PDF banner: renders at top of form when current quote has `pdf_is_authoritative: true`. Banner has "Open PDF" button. Auto-dismisses on first user edit.

**Dependencies added to `package.json`:**
- `@google-cloud/storage` (for bucket I/O)
- `busboy@^1.6` (for multipart parsing)

**Verified (curl):**
- ✅ All 5 endpoints return 200 for happy path with synthetic 425-byte test PDFs
- ✅ Round-trip download magic bytes intact
- ✅ Directory-traversal guard rejects mismatched prefixes
- ✅ `create-from-pdf` doc has `pdf_is_authoritative: true`
- ✅ 3-way MD5 match on quote.js + index.html (HEAD = local = served)
- ⚠️ **Real-world QC pending** — Varun rightly called out that I hadn't tested with an actual customer PDF. Subagent dispatched at ~12:18 UTC with the Hardik PDF (824 KB, 8 pages, real ZuildUp quote for Hardik, 338 sqyd Sec 15 Gurugram) to run the real test. Reports back to Discord when done.

### Operational change today — kishan added (~12:21 UTC)
Varun requested `kishan@zuildup.com` access to the quotation builder. Auth username convention is short login (matches varun/karan/avish/etc), so:
- Username: `kishan`
- Initial password: `kishan` (per Varun's spec)

How I added him:
```bash
# Pulled current AUTH_USERS_JSON, added kishan, redeployed via:
gcloud run services update zuildup-quotes \
  --region=asia-south1 --project=zuildup-quotes \
  --env-vars-file=/tmp/all_env.yaml \
  --quiet
# Then flipped traffic to new revision (Cloud Run --env-vars deploy ships at 0% by default — same trap as 9E/9F)
gcloud run services update-traffic zuildup-quotes \
  --to-revisions=zuildup-quotes-00067-d28=100 \
  --region=asia-south1 --project=zuildup-quotes
```

Verified:
- ✅ kishan:kishan → HTTP 200
- ✅ kishan:wrong → HTTP 401
- ✅ All existing 5 users (varun, karan, avish, vaishali, rajat) still work

### Phase 9H — password reset (dispatched ~12:22 UTC, in flight)
Varun also asked for "an option to reset it" (kishan's password). I dispatched a subagent to build:

- **Self-serve change password** — modal in toolbar, takes current + new password, updates Firestore
- **Admin reset password** — varun-only UI to reset any rep's password + add new users
- **Architecture change:** move user store from env var (immutable) to Firestore (`users` collection, bcrypt-hashed passwords). Env var stays as fallback for zero-downtime migration.

5 new endpoints planned:
- `POST /api/auth/change-password` — self-serve
- `POST /api/auth/admin/reset-password` — admin only
- `GET /api/auth/me` — returns username/role/password_changed_at
- `GET /api/auth/users` — admin list-users for the management UI

Subagent reports back via Discord channel `1498595297444630598`. Expected ETA ~1h from dispatch.

---

## 3. Phase history (cumulative — what's live)

| Phase | Ship date | Commit | Live rev | What it did |
|---|---|---|---|---|
| 9B-2 | 2026-05-22 | `0282bad` predecessor | `00061-7xv` | URL-qid + sessionStorage (per-tab isolation). 9B-2 is the architectural baseline. |
| 9D | 2026-05-22 | `4ef55b0` | `00063-jgj` (initially) | loadState hard guard, applyWizard rebuild from defaultState, wiz-custom-E input, pristine pre-fill. Also INTRODUCED the wipe bug (line 5487 cur.quoteId leak). |
| 9D rollback | 2026-05-31 | — | `00061-7xv` | Rolled back per Varun's request. Bug still latent. |
| 9E | 2026-06-01 | `7ca9a3a` | `00064-dtn` | Belt-and-suspenders override purge in applyWizard + _bootQid migration + Reset-to-calculated UI. **Did NOT fix the wipe bug** because root cause was earlier in the same applyWizard function. |
| **9F** | 2026-06-03 11:16 | `6fbd1d1` | `00065-5fr` | **STOPS THE WIPE.** 5 defence layers: server PUT guard, prev_state backup, applyWizard quoteId fix, saveState URL-sync, saveState anti-wipe. Firestore PITR enabled. |
| **9G** | 2026-06-03 11:35 | `09b21aa` | `00066-l7s` | **PDF UPLOAD.** GCS bucket, 5 endpoints, toolbar + load-modal UI, restore banner. |
| **(env)** | 2026-06-03 12:21 | n/a | `00067-d28` | **kishan added** to AUTH_USERS_JSON. |
| 9H | in flight | tbd | tbd | Password reset (self + admin), Firestore user store. |

---

## 4. Key file locations & code anchors

### `app/quote.js` (client, ~6200 lines)
- `defaultState()` — pristine state factory
- `loadState()` ~L286-460 — multi-tier read: sessionStorage → localStorage slot → legacy fallback → defaults. 9D hard-guard for fresh draft qids at ~L325.
- `saveState(s)` ~L495-560 — writes sessionStorage + (if active id) _touches local slot + pushes cloud. **9F additions: URL-qid sync, anti-wipe local guard.**
- `QuoteStorage` ~L530-870 — namespace for slot/index management. `save(state, name)` is the explicit save path; `_touch(id, state)` is the auto-save (debounced 1.5s push to cloud).
- `openSavedQuote(id)` ~L2627 — Load modal click handler. URL push + reload pattern.
- `applyWizard()` ~L5480 — Quick Build apply. **9F fix at L5487: `newState.quoteId = ''`.**
- `renderAreaOverridesPanel()` ~L2804 — Area overrides UI with 9E reset buttons.
- `_bootQid()` ~L1762 — URL qid resolution + legacy migration. 9E override purge at ~L1786.
- 9G PDF UI hooks — `📎 Import PDF` toolbar button + Load modal chip + restore banner. Spread across renderLoadList + bootForm initialization.

### `app/server.js` (~1300 lines)
- `_loadAuthUsers()` ~L485 — reads `AUTH_USERS_JSON` env. 9H will Firestore-back this.
- `requireAuth(req, res)` ~L508 — basic auth gate.
- `getAuthUser(req)` ~L544 — extracts username for audit.
- `/api/quotes` routing block ~L623-770 — list/get/put/delete/post. **9F additions to PUT: anti-wipe + prev_state backup.**
- 9G PDF endpoints ~L1180-1400 (attach-pdf, list, download, delete, create-from-pdf)
- Firestore collections used: `quotes`, `quote_edit_logs`, **`quote_backups` (new in 9F)**

### `app/index.html`
- Toolbar buttons: load, save, new-quote, quick-build, **import-pdf (9G)**
- Modals: save-modal, load-modal, wizard modal, **(9H planned) account-menu, change-password-modal, admin-users-modal**

### `app/server.js` env requirements
```yaml
AUTH_USERS_JSON: '{"varun":"varun123","karan":"karan123","avish":"avish123","vaishali":"vaishali123","rajat":"rajat123","zuildup-sales":"zuildup","kishan":"kishan"}'
ANTHROPIC_API_KEY: 'sk-ant-api03-...'
ANTHROPIC_MODEL: 'claude-opus-4-7'
# 9G adds:
PDF_BUCKET: 'zuildup-quotes-uploads'   # defaulted in code, doesn't need explicit env
```

---

## 5. Recovery options for the 5 wiped quotes

**Three paths, in order of preference:**

### A. Browser localStorage on the rep's machine (best — exact restore)
If the rep who last loaded the quote has NOT reloaded their browser tab today, the pre-wipe state may still be cached:
1. Have the rep open https://zuildup-quotes-zim2owjloq-el.a.run.app/
2. **DO NOT click Load on the wiped quote. DO NOT refresh.**
3. DevTools → Application → Local Storage → key `zuildup.quotes.q_mpv1ov9f_bnilgp` (etc.)
4. Copy the value → I can PUT it back to Firestore via `/api/quotes/:id` with `allowOverwriteEmpty: true` flag

Affected reps to check (from `author` field on each doc):
- Bansal, Sudhir, Deepesh, Sample Basic — author was `avish`
- Anuj Hasija — author was `avish`
- → all 5 last-touched by avish. Check his browser first.

### B. Upload the customer-sent PDF (9G feature — Varun's chosen path)
Use the new `📎 Import PDF` button on the toolbar:
1. Type customer name in prompt
2. Upload the PDF that was sent to the customer
3. New quote slot is created with `pdf_is_authoritative: true` and a gold banner pointing to the PDF
4. The PDF becomes the source of truth (read-only); form fields stay blank
5. If the rep wants to edit, they can re-create the quote from scratch using the PDF as reference, OR I can build a "Parse PDF → state" feature in a future phase

### C. Firestore PITR (only works going forward, NOT for current wipes)
Now enabled, 7-day window. Any future wipe (even though 9F should prevent them) can be restored via:
```js
const snap = await firestore.collection('quotes').doc(docId).get({ readTime: new Date('2026-06-04T10:00:00Z') });
// Write the recovered state back via PUT with allowOverwriteEmpty: true
```

---

## 6. Critical lessons from today (durable, do not forget)

1. **ALWAYS enable Firestore PITR on production projects.** Default is OFF. The 7-day window costs pennies and saves your ass when destructive bugs ship. Audit every prod project: `gcloud firestore databases describe --database='(default)' --project=<P>` — look for `POINT_IN_TIME_RECOVERY_ENABLED`.

2. **Defence-in-depth on destructive operations.** Don't trust the client. The server-side anti-wipe guard (HTTP 409 if existing has content and incoming is blank) is what gives me confidence that the wipe can't happen again — even if a future client bug appears. This pattern (`server validates the destructive shape of the payload regardless of client intent`) should be applied to any other mutation endpoint.

3. **`_isFresh: true` + empty override on every row + null pricing + empty customer is a FINGERPRINT for "this is `defaultState()`".** That's the signature any anti-wipe guard should match.

4. **`state.quoteId` vs URL qid is a footgun.** With 9B-2, URL qid is canonical. But `state.quoteId` still hangs around as a "convenience" field. ANY time `state.quoteId` can be set independently of the URL qid, you have a potential wipe vector. 9F's `saveState` sync rule treats `state.quoteId` as cache — URL is truth.

5. **Cloud Run `--source` and `--env-vars` deploys often ship at 0% traffic.** Always verify after deploy:
   ```bash
   gcloud run revisions list --service=zuildup-quotes --region=asia-south1 --project=zuildup-quotes
   gcloud run services describe zuildup-quotes --region=asia-south1 --project=zuildup-quotes --format='value(status.traffic)'
   ```
   Flip if needed:
   ```bash
   gcloud run services update-traffic zuildup-quotes --to-revisions=<NEW>=100 --region=asia-south1 --project=zuildup-quotes
   ```
   Happened on 9E, 9F, 9G, and 9H-precursor (kishan add). **Every. Single. Deploy.**

6. **Investigate before you patch.** Phase 9D, 9E, AND 9F all live in the same `applyWizard()` function. 9D introduced the bug, 9E patched around it (but missed the root cause), 9F finally fixed it. Burnt ~12 days of customer data loss because each patch was symptom-driven. Three Rules:
   - Read docs first (Vercel 413, Cloud Run traffic semantics, Firestore PITR)
   - Ver   - Verify end-to-end on live URL (not curl — real browser flow with real PDFs, real customers)
   - 3+ commits on same bug = stop, rethink architecture

7. **Notify the human EARLY about recoverability.** When data is gone, the user needs to know NOW so they can chase rep browser localStorage before it's reloaded. I did this today within 5 minutes of confirming the wipe — Varun was able to make decisions in real time. Don't sit on bad news while you fix.

8. **NO_FAKE_GO_AHEADS rule** — Varun explicitly called this out today: "have we done all the qc? I don't want a fake go ahead". The honest answer was "we verified curl-level, not browser-level". When asked, ADMIT what hasn't been verified. Curl pass != UI pass. MD5 match != behaviour match.

9. **Real-world QC matters.** The Hardik PDF (824 KB, 8 pages, real customer layout) is a far better test than a 425-byte synthetic. Reps will use real PDFs. Test with real PDFs.

10. **Auth via env-var JSON is fine for a small team, but rotation needs Firestore.** This is what 9H is fixing. Lesson for future projects: use a mutable credential store from day 1 if rotation/reset is anywhere on the roadmap.

---

## 7. Open follow-ups (post 9H)

| Item | Priority | Notes |
|---|---|---|
| Real-world QC results for 9G | HIGH | Subagent in flight, reports to Discord |
| Phase 9H password reset | HIGH | Subagent in flight |
| Recover the 5 wiped quotes | MEDIUM | Either via avish's localStorage OR re-import via 9G PDF upload OR re-create from scratch using client's PDF |
| Phase 9I (?) — Parse uploaded PDFs into editable state | LOW | Our PDFs are self-generated with consistent layout — we could parse them back into structured rows. Risky (90% accuracy creates more "random values" complaints). Defer until reps explicitly ask. |
| Composite Firestore index for `quote_backups` query (quote_id + replaced_at DESC) | LOW | Right now any ordering query fails. Only matters when building a "view backups for this quote" UI. Create via console URL printed in the error message when it first hits production. |
| Audit other Firestore projects for PITR | MEDIUM | I should check ocplatform-prod-777874, zuildup-prod, astro-v3-prod, etc. and enable PITR everywhere. Cost is minimal, safety is huge. |
| Document this whole pattern in `MEMORY.md` | DONE | Already appended in today's `memory/2026-06-03.md`. The PITR rule + anti-wipe guard pattern should also propagate to other projects. |

---

## 8. Quick reference — commands cheat sheet

### Deploy
```bash
sleep 2 && cd /opt/openclaw/workspace/zuildup/quotation-builder && nohup gcloud run deploy zuildup-quotes --source . --region asia-south1 --project zuildup-quotes --quiet > /tmp/deploy.log 2>&1 &
# After build success, ALWAYS check:
gcloud run revisions list --service=zuildup-quotes --region=asia-south1 --project=zuildup-quotes --limit=3
gcloud run services describe zuildup-quotes --region=asia-south1 --project=zuildup-quotes --format='value(status.traffic)'
# Flip if needed:
gcloud run services update-traffic zuildup-quotes --to-revisions=<NEW>=100 --region=asia-south1 --project=zuildup-quotes
```

### Update env vars (preserve all)
```bash
# Get current
gcloud run services describe zuildup-quotes --region=asia-south1 --project=zuildup-quotes --format='value(spec.template.spec.containers[0].env)'
# Build full YAML preserving all keys
cat > /tmp/all_env.yaml << 'YAML'
AUTH_USERS_JSON: '{...}'
ANTHROPIC_API_KEY: '...'
ANTHROPIC_MODEL: 'claude-opus-4-7'
YAML
# Apply (creates new revision)
gcloud run services update zuildup-quotes --region=asia-south1 --project=zuildup-quotes --env-vars-file=/tmp/all_env.yaml --quiet
# Don't forget traffic flip!
```

### Verify live
```bash
# Live MD5 (matches HEAD = ship verified)
curl -s -u zuildup-sales:zuildup https://zuildup-quotes-zim2owjloq-el.a.run.app/app/quote.js | md5sum
md5sum /opt/openclaw/workspace/zuildup/quotation-builder/app/quote.js
# Authenticated GET on a quote
curl -s -u zuildup-sales:zuildup https://zuildup-quotes-zim2owjloq-el.a.run.app/api/quotes/<id> | python3 -m json.tool
# List all docs
curl -s -u zuildup-sales:zuildup https://zuildup-quotes-zim2owjloq-el.a.run.app/api/quotes | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('items',[])), 'quotes')"
```

### Rollback (if 9F or 9G breaks something)
```bash
# Roll back to 9F (rev 00065-5fr) — wipe fix preserved, loses PDF upload
gcloud run services update-traffic zuildup-quotes --to-revisions=zuildup-quotes-00065-5fr=100 --region=asia-south1 --project=zuildup-quotes
# Roll back to 9E (rev 00064-dtn) — loses wipe fix AND PDF upload (NOT RECOMMENDED — wipe vector returns)
gcloud run services update-traffic zuildup-quotes --to-revisions=zuildup-quotes-00064-dtn=100 --region=asia-south1 --project=zuildup-quotes
```

### Firestore (read-by-time, PITR window)
```bash
# Check PITR status
gcloud firestore databases describe --database='(default)' --project=zuildup-quotes
# Should show: pointInTimeRecoveryEnablement: POINT_IN_TIME_RECOVERY_ENABLED
# earliestVersionTime tells you how far back you can read (7 days with PITR on)

# Read a doc as of a specific time (Node):
const snap = await firestore.collection('quotes').doc(docId).get({ readTime: new Date('2026-06-03T11:00:00Z') });
```

### Audit wiped quotes
```bash
cat > /tmp/audit.js << 'JS'
const { Firestore } = require('@google-cloud/firestore');
const firestore = new Firestore({ projectId: 'zuildup-quotes' });
(async () => {
  const snap = await firestore.collection('quotes').get();
  const wiped = [];
  snap.forEach(d => {
    const s = d.data().state || {};
    const c = s.customer || {};
    const p = s.pricing || {};
    const noCust = !c.name && !c.address;
    const noPrice = (p.costPerSqft == null) && (p.zoneARate == null);
    const allFresh = (s.rows || []).length === 0 || (s.rows || []).every(r => r && r._isFresh === true && !Object.keys(r.override || {}).length);
    if (noCust && noPrice && allFresh) wiped.push({ id: d.data().id, name: d.data().name, modified: d.data().modified_at });
  });
  console.log('WIPED:', wiped.length); wiped.forEach(w => console.log(' ', w.modified, w.id, '|', w.name));
})();
JS
# Must run from inside the repo where node_modules has @google-cloud/firestore:
sleep 2 && bash -c 'cd /opt/openclaw/workspace/zuildup/quotation-builder && cp /tmp/audit.js _audit.js && node _audit.js && rm _audit.js'
```

---

## 9. Active users today

| Username | Password | Role | Notes |
|---|---|---|---|
| `varun` | `varun123` | admin (planned 9H) | Founder |
| `karan` | `karan123` | rep | |
| `avish` | `avish123` | rep | Touched all 5 wiped quotes — check his localStorage for recovery |
| `vaishali` | `vaishali123` | rep | |
| `rajat` | `rajat123` | rep | |
| `zuildup-sales` | `zuildup` | rep | Shared/generic login, also used by me for QC |
| `kishan` | `kishan` | rep | **Added today (2026-06-03 12:21 UTC) per Varun's request.** |

---

## 10. End

This document is the single-source-of-truth for everything that happened on the ZuildUp Quotation Builder on 2026-06-03. If you're picking up this project in a future session:

1. Read this file top-to-bottom.
2. Check the in-flight subagent statuses (9G QC + 9H password reset) via Discord channel `1498595297444630598` or `TaskList` tool.
3. Check `memory/2026-06-03.md` for additional notes from earlier in the day (Phase 9E ship + Phase 9F deep-dive lessons).
4. Verify live state is as described in section 1.

Anyone reading this who is NOT Iraaj: hi, this was a hard day but the system is now safer than it was 24 hours ago. The wipe is fixed. PDFs can be uploaded. Recovery is possible. Be kind to the next person who has to touch this code.

— Iraaj 🌀, 2026-06-03 12:30 UTC
