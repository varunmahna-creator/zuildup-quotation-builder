# Phase 4 Work Log — Quotation Builder

**Date:** 2026-05-01
**Owner:** Varun Mahna
**Channel:** Discord `#zuildup-quotation-builder`
**Branch:** `phase4-firestore-quote-library` (merged into `master` as of `f31f52d`)
**Status:** 🟢 LIVE in production

---

## 1. The Problem

The sales team (Varun, Karan, Avish, Vaishali, Rajat) reported that after building a quote and downloading the PDF, they could not revisit the quote later for revisions following client discussions.

**Root cause:** Quotes were persisted only in **browser `localStorage`**. This meant:
- A quote was bound to the specific browser on the specific laptop where it was created
- Switching laptops, browsers, or clearing cache → quote lost
- Team members could not see each other's quotes
- No central record of what the team was working on

---

## 2. The Solution

**Phase 4 — Cross-Device Quote Library (Firestore-backed)**

Quotes are now persisted server-side in **Google Cloud Firestore**, with browser localStorage acting as a hot read/write cache. Every save propagates to the cloud in the background; every page boot pulls the team's latest quotes from the cloud first.

**Key properties:**
- Quotes are **team-shared** — all reps see all quotes
- Each quote tags its **author** (creator) and **last_edited_by** (most recent editor)
- Survives browser cache clears, laptop changes, browser switches
- Auto-migrates any pre-Phase-4 localStorage quotes up to the cloud on first boot
- Existing UI (Save / Load / Export / Import buttons) works unchanged — no retraining

**Phase 4.1 — Per-Rep Logins**

Replaced the shared `zuildup-sales` / `zuildup` login with five individual rep logins, so author tags are meaningful (Karan can see "this quote was built by Avish, last edited by Varun").

---

## 3. What's Live

### Live URLs
- **App:** https://zuildup-quotes-zim2owjloq-el.a.run.app
- **GCP Cloud Run dashboard:** https://console.cloud.google.com/run/detail/asia-south1/zuildup-quotes/metrics?project=zuildup-quotes
- **Firestore data viewer:** https://console.cloud.google.com/firestore/databases/-default-/data/panel/quotes?project=zuildup-quotes

### Production state (as of 2026-05-01 ~11:10 UTC)
- Cloud Run revision: `zuildup-quotes-00014-v2v`
- Service account: `586295767597-compute@developer.gserviceaccount.com` (granted `roles/datastore.user`)
- Firestore database: `(default)` in `asia-south1`, collection: `quotes`
- Image: `asia-south1-docker.pkg.dev/zuildup-quotes/cloud-run-source-deploy/zuildup-quotes`

### Logins

| Username | Password | Purpose |
|---|---|---|
| `varun` | `varun123` | Sales rep |
| `karan` | `karan123` | Sales rep |
| `avish` | `avish123` | Sales rep |
| `vaishali` | `vaishali123` | Sales rep |
| `rajat` | `rajat123` | Sales rep |
| `zuildup-sales` | `zuildup` | **Legacy fallback during transition; remove once team has switched** |

Configured via the `AUTH_USERS_JSON` env var on the Cloud Run service.

---

## 4. Architecture Changes

### 4.1 Backend — `app/server.js`

**Added:**
- Firestore client initialization (`@google-cloud/firestore` v7.10+) — picks up project from metadata server on Cloud Run, or `GOOGLE_CLOUD_PROJECT`/`FIRESTORE_PROJECT_ID` env vars locally
- Helper `getAuthUser(req)` — extracts username from Basic Auth header (no auth check; caller has already passed `requireAuth`)
- Helper `readJsonBody(req)` — promised JSON body reader with 10 MB cap
- Helper `genQuoteId()` — server-side equivalent of client `_genId()` — `q_<ts36>_<rand6>`
- Helper `indexEntryFromDoc(doc)` — projects a Firestore doc into the lightweight index entry shape
- Multi-user auth: `_loadAuthUsers()` parses `AUTH_USERS_JSON` env (JSON dict username→password). Falls back to legacy `AUTH_USER`/`AUTH_PASS` single-user mode for backward compat.

**New endpoints (all behind Basic Auth):**
- `GET /api/quotes` — list all team quotes, newest-modified first (limit 500), returns `{items: [indexEntry...]}`
- `GET /api/quotes/:id` — full slot including state body
- `POST /api/quotes` — create new slot. Body: `{name?, id?, state}`. Returns full slot.
- `PUT /api/quotes/:id` — overwrite slot. Body: `{name?, state}`. Returns full slot. Preserves original `author` while updating `last_edited_by`.
- `DELETE /api/quotes/:id` — remove slot. Returns `{ok: true}`.

### 4.2 Frontend — `app/quote.js` (built from `scripts/build_quote_js.py`)

**Modified `QuoteStorage` (kept its synchronous public API; all 25+ existing call sites work unchanged):**
- Added `_apiPush(method, id, body)` — fire-and-forget API call; tracks pending count + failure count; auto-disables sync after 3 consecutive failures
- Added `_apiFetch(id)` — pulls a single full slot from the cloud and writes it to local
- Added `syncFromCloud()` — pulls remote-newer + pushes local-only on boot. Returns `{fetched, pushed, total}`. Called automatically:
  - At start of `bootForm()` (with 4s timeout — if cloud slow, falls through to local cache)
  - When the **Load** modal opens (so a rep always sees teammates' latest quotes)
- Modified `save()` (both overwrite + create-new branches) — fire-and-forget cloud push
- Modified `_touch()` (auto-save on keystroke) — debounced 1.5 s before cloud push to avoid hammering Firestore
- Modified `delete()` — fire-and-forget cloud delete
- Emits `quote-sync-state-changed` events; the toolbar "Saved" indicator now shows "Syncing…" while pushes are in flight, "(local only)" if sync has been disabled

**Modified Load modal `renderLoadList()`:**
- Each saved quote now displays the author tag, e.g. `Aanya Kapoor — Sector 47 · Mr. Sharma · by karan · saved 2026-05-01 · 12 rows`

### 4.3 GCP / Infra changes
1. Enabled `firestore.googleapis.com` API on project `zuildup-quotes`
2. Created Firestore Native database in `asia-south1`
3. Granted Cloud Run runtime SA (`586295767597-compute@developer`) `roles/datastore.user`
4. Set `AUTH_USERS_JSON` env var on Cloud Run service (Phase 4.1)

### 4.4 Dependencies
- Added `@google-cloud/firestore` ^7.10 to `package.json`
- No other deps changed

---

## 5. Firestore Document Schema

```jsonc
// Collection: quotes
// Document id == slot id (q_<ts36>_<rand6>)
{
  "id": "q_momspmal_69xzcz",
  "name": "Aanya Kapoor — Sector 47",         // human-friendly label
  "customer_name": "Aanya Kapoor",            // derived from state.customer.name
  "author": "karan",                          // creator (preserved on edits)
  "last_edited_by": "varun",                  // most recent editor
  "created_at": "2026-05-01T10:30:00.000Z",
  "modified_at": "2026-05-01T11:05:33.421Z",
  "row_count": 12,
  "state": { /* full quote state object */ }
}
```

The full quote state body lives inside `state`. The top-level fields are denormalised so the list endpoint can return a lightweight index without fetching every state body.

---

## 6. End-to-End Verification (executed on LIVE URL)

A scripted Chrome+CDP test ran the following sequence against the live deployed URL:

1. ✅ Opened https://zuildup-quotes-zim2owjloq-el.a.run.app/ with Basic Auth, page booted, `QuoteStorage` available
2. ✅ Saved a quote programmatically with name + customer
3. ✅ Confirmed it appeared in Firestore via `/api/quotes` with correct `author`
4. ✅ Cleared `localStorage` entirely (simulating a different device)
5. ✅ Reloaded the page
6. ✅ After `syncFromCloud()` ran, the quote was back in `QuoteStorage.list()` — proving the cross-device flow works
7. ✅ Deleted the quote — confirmed removed from cloud

**Phase 4.1 auth verification:**
- ✅ All 5 rep logins return 200 on `/api/quotes`
- ✅ Legacy `zuildup-sales` still works
- ✅ Bogus credentials return 401
- ✅ Author tag = creator's username
- ✅ `last_edited_by` updates on edit, original `author` preserved

---

## 7. Operational Runbook

### Add a new sales rep

1. Decide username + password
2. Update Cloud Run env var:
   ```bash
   cat > /tmp/env.yaml << 'EOF'
   AUTH_USERS_JSON: '{"varun":"varun123",...,"newrep":"newrep123"}'
   EOF
   gcloud --project zuildup-quotes run services update zuildup-quotes \
     --region asia-south1 --env-vars-file=/tmp/env.yaml
   ```
3. Verify: `curl -s -u newrep:newrep123 -o /dev/null -w "%{http_code}" https://zuildup-quotes-zim2owjloq-el.a.run.app/api/quotes` should return `200`

### Remove the legacy `zuildup-sales` fallback (once everyone is migrated)
Same as above, but omit `zuildup-sales` from the JSON dict.

### Reset a rep's password
Same as above, with the new password.

### List all quotes (admin view)
```bash
curl -s -u varun:varun123 https://zuildup-quotes-zim2owjloq-el.a.run.app/api/quotes | python3 -m json.tool
```

### Delete a quote out-of-band
```bash
curl -s -u varun:varun123 -X DELETE https://zuildup-quotes-zim2owjloq-el.a.run.app/api/quotes/<quote-id>
```

### Verify deploy is actually live (use this!)
```bash
md5sum app/quote.js                                           # local
curl -s -u varun:varun123 https://zuildup-quotes-zim2owjloq-el.a.run.app/app/quote.js | md5sum   # live
# These MUST match. If they don't, the deploy hasn't fully landed.

gcloud --project zuildup-quotes run services describe zuildup-quotes \
  --region asia-south1 --format='value(status.latestReadyRevisionName)'
```

---

## 8. Costs

- **Firestore (Native, free tier):** 50K reads + 20K writes per day. Each quote save = 1 write; auto-save debounce of 1.5s means ~40 writes/min/active-rep at heavy editing. With 5 reps, well within free tier.
- **Cloud Run:** unchanged (cold-start scaling stays the same; new endpoints add negligible compute).
- **Net additional spend:** ~₹0/month at current usage.

---

## 9. Watchlist

- **Firestore quota under heavy auto-save**: free tier is 20K writes/day. If usage spikes (e.g. a rep edits a quote with rows changing every keystroke for an hour), watch for throttling. Mitigation if needed: increase `_touch` debounce from 1.5s to 5s.
- **Migration of pre-Phase-4 localStorage quotes**: any rep who had quotes saved before this deploy will auto-push them up on first boot. If anyone reports old quotes "missing," ask them to open the live URL once on the original browser/laptop where they built them — the auto-migration will run.
- **Legacy `zuildup-sales` login**: kept active as fallback. Plan to remove after the team confirms switchover.
- **Single Firestore database per project**: there is now exactly one collection (`quotes`) holding all team data. No backups configured at the moment — Cloud Firestore has Point-in-Time Recovery available if needed (currently disabled). Consider enabling if data volume grows.

---

## 10. Files Changed (this work session)

```
app/server.js                  +296 lines  (Firestore client + 5 API endpoints + multi-user auth)
app/quote.js                   regenerated (cloud-sync layer, indicator hook, author label in Load list)
scripts/build_quote_js.py      +source for the above
package.json                   +@google-cloud/firestore ^7.10
package-lock.json              regenerated
PROJECT_CONTEXT.md             updated with Phase 4 + 4.1 sections
PHASE4_WORK_LOG.md             this file (new)
```

---

## 11. Commits

```
f31f52d  Merge Phase 3 + Phase 4 + Phase 4.1 into master
466f198  docs: PROJECT_CONTEXT — Phase 4.1 per-rep logins
711ca15  Phase 4.1: per-rep logins via AUTH_USERS_JSON
ee06739  docs: PROJECT_CONTEXT.md — Phase 4 (cross-device quote library)
ccfe945  Phase 4: cross-device quote library (Firestore-backed)
```

Pushed to GitHub: https://github.com/varunmahna-creator/zuildup-quotation-builder (master branch)

---

## 12. Lessons Learned (for future sessions)

1. **`/opt/openclaw` is a separate `rw` bind-mount over a `ro` root.** Don't bail out when mount table shows `ro,errors=remount-ro` — check `cat /proc/self/mountinfo | grep openclaw` first; if there's an `rw` line for the workspace, writes work.
2. **Each Bash tool call is a fresh shell** — `cd` doesn't persist. Use absolute paths everywhere (`git -C /abs/path`, `python3 /abs/path/script.py`).
3. **The Edit/Read tools occasionally have a stale view** of fresh writes — Bash + Python file I/O is the most reliable substrate. Probe with `echo > /abs && cat /abs` in a single bash invocation if uncertain.
4. **Deploy != commit.** Always verify `md5sum` of local `app/quote.js` vs `curl https://.../app/quote.js` before declaring done. Note the path is `/app/quote.js` not `/quote.js` (the root path 404s).
5. **Cloud Build can take 5-10 min** for the Quotation Builder image (Chrome + Node deps). Watch via `gcloud alpha builds list --region=asia-south1`.
6. **Per-rep auth via `AUTH_USERS_JSON` env var** is simple and works fine for 5–20 users without a real auth service. If we ever need >50 users or password reset flows, swap to Firebase Auth or Auth0.
