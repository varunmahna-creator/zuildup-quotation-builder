# ZuildUp Quotation Builder — Full Day Snapshot 2026-06-03

**Date:** 2026-06-03 (Tuesday)
**Engineer:** Iraaj 🌀 (Opus 4.7)
**Purpose:** End-of-day single-source-of-truth covering EVERYTHING that shipped today (Phase 9F → 9G → kishan add → 9H → cleanup). Read this file first if you are resuming this project tomorrow.

**Companion doc:** `qc-2026-06-03/CONTEXT_SNAPSHOT_2026-06-03.md` — written at ~12:30 UTC, BEFORE 9H + cleanup landed. This file is the strict superset; that file is the deep-dive on the data-loss incident + 9F/9G technical detail.

---

## 0. Verified production state right now (orchestrator MD5 evidence)

| Thing | Value |
|---|---|
| Live URL | https://zuildup-quotes-zim2owjloq-el.a.run.app/ |
| GCP project | `zuildup-quotes` (asia-south1) |
| Cloud Run service | `zuildup-quotes` |
| **Live revision** | **`zuildup-quotes-00068-zqs`** @ 100% traffic (created 12:31:55 UTC) |
| HTTP smoke | 200 OK on `/` (54693 bytes) |
| GitHub HEAD | `9a328cb` (master) — "Remove customer PDF from repo + gitignore" |
| Repo path | `/opt/openclaw/workspace/zuildup/quotation-builder` |
| Git status | clean tree |
| 3-way MD5 verification | ✅ PASS — see below |
| `app/quote.js` MD5 | `013633cc97a5bc146ecb8a7a973241f6` (LIVE == HEAD) |
| `app/index.html` MD5 | `a4a3d29a63deb3e089064cb2653c403c` (LIVE == HEAD) |
| Firestore PITR | ✅ ENABLED (7-day window, turned on during 9F) |
| GCS PDF bucket | `gs://zuildup-quotes-uploads` (asia-south1, UBLA, PAP enforced) |
| Active users | varun, karan, avish, vaishali, rajat, zuildup-sales, kishan + bcrypt store in Firestore |

---

## 1. Chronological log of today (12 hours, in order)

### 07:53–11:02 UTC — The wipes (invisible to me at the time)
Five customer quotes wiped to blank `defaultState()` shape by a latent client bug in `applyWizard()` (Phase 9D ship, May 22). All five last-edited by `avish`.

- `q_mpv1ov9f_bnilgp` — **Devi Ram Bansal** — wiped 11:02 UTC
- `q_mpv8781d_6icyii` — **Sudhir Mahajan** — wiped 08:44 UTC
- `q_mpnzam1f_z3t7cp` — **MK Midha (Deepesh Sachdeva copy)** — wiped 07:53 UTC
- `q_mp6tm2to_5eg45f` — **Amit Mathur (Sample Basic)** — wiped previous day 11:48 UTC
- `q_muu1brp_7uhsav` — **Anuj Hasija** — wiped previous day 14:25 UTC

### 10:55 UTC — Varun's report
> "The loaded quotations are showing random values/wrong data is being picked. The team is facing major issue because they have to rework on quotations which are already complete."

### 10:55–11:10 UTC — Investigation
- Fetched live Firestore docs, confirmed wipe fingerprint: empty customer, null pricing, all rows `_isFresh:true` with empty `override`.
- Audited all 88 quote docs → identified the 5 above as wiped.
- Discovered Firestore PITR was DISABLED on this project. Recovery window past for all 5. Cloud copy unrecoverable.
- Traced root cause to `app/quote.js` line 5487 in `applyWizard()`:
  ```js
  const newState = (typeof defaultState === 'function') ? defaultState() : JSON.parse(JSON.stringify(window.__qbState));
  if (cur.quoteId) newState.quoteId = cur.quoteId;   // ← THE BUG (Phase 9D, May 22)
  ```
  Blank `defaultState()` template inherits the saved quote's id; subsequent save PUT writes blank against the original slot.

### 11:16 UTC — **Phase 9F shipped** (commit `6fbd1d1`, rev `00065-5fr`)
Five defence-in-depth layers — any one of them would have stopped the wipe.

| # | Layer | File | What it does |
|---|---|---|---|
| 1 | Server PUT guard | `app/server.js` PUT /api/quotes/:id | HTTP 409 `wipe_blocked` if existing doc is populated and incoming body matches `defaultState()` fingerprint. Override only with `allowOverwriteEmpty: true`. |
| 2 | Server `prev_state` backup | `app/server.js` | Before every PUT, snapshots existing doc into Firestore `quote_backups` collection (fire-and-forget). |
| 3 | Client `applyWizard` fix | `app/quote.js` ~L5487 | `newState.quoteId = ''` (not `cur.quoteId`). ROOT-CAUSE FIX. |
| 4 | Client `saveState` URL-qid sync | `app/quote.js` ~L495-560 | If `state.quoteId` mismatches URL qid, URL wins. URL qid is canonical per Phase 9B-2. |
| 5 | Client `saveState` anti-wipe local | `app/quote.js` ~L495-560 | Refuses to `_touch` local slot if in-memory state looks blank but local slot has real content. |

Also enabled Firestore PITR:
```bash
gcloud firestore databases update --database='(default)' --enable-pitr --project=zuildup-quotes
```

Smoke tests:
- ✅ Blank PUT against intact Sample Luxury → HTTP 409 `wipe_blocked`
- ✅ Valid populated PUT → 200, `prev_state` snapshot landed in `quote_backups`
- ✅ Live MD5 = HEAD MD5

### 11:35 UTC — **Phase 9G shipped** (commit `09b21aa`, rev `00066-l7s`)
PDF upload feature — Varun's chosen recovery path ("we have all the quotes as pdf so we can reupload any quote we need").

**Storage:**
- New GCS bucket `gs://zuildup-quotes-uploads` (asia-south1, UBLA + PAP enforced)
- Cloud Run service account (`586295767597-compute@developer.gserviceaccount.com`) granted `roles/storage.objectAdmin` on bucket
- Object key: `<quote_id>/<ISO timestamp>_<safe_filename>.pdf`
- 25 MB max, `application/pdf` only, %PDF magic-byte sniff on first 4 bytes

**Firestore schema additions on each quote doc:**
- `uploaded_pdfs: [{filename, gcs_object, gcs_uri, uploaded_by, uploaded_at, size_bytes, content_type}]`
- `pdf_is_authoritative: true` (only on docs created via `create-from-pdf`)

**5 new server endpoints:**
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/quotes/:id/attach-pdf` | multipart `pdf`, magic-byte validated, uploaded to GCS, appended to `uploaded_pdfs` |
| GET | `/api/quotes/:id/pdfs` | List `uploaded_pdfs` |
| GET | `/api/quotes/:id/pdfs/:b64/download` | base64url-decoded path, traversal-guarded, streamed through server |
| DELETE | `/api/quotes/:id/pdfs/:b64` | Deletes from GCS + array |
| POST | `/api/quotes/create-from-pdf` | New quote skeleton, marks `pdf_is_authoritative: true`, uploads PDF |

**Client UI:**
- Toolbar: `📎 Import PDF` button
- Load modal: `📎 N` chip per item + per-quote attach button + popover with download/delete actions
- Gold restore-from-PDF banner at top of form when `pdf_is_authoritative: true`, auto-dismisses on first edit

**Dependencies:**
- `@google-cloud/storage`
- `busboy@^1.6`

Curl-verified all 5 endpoints. Real-world QC dispatched to subagent with Hardik PDF (real customer, 824 KB, 8 pages).

### 12:21 UTC — kishan added to AUTH_USERS_JSON (rev `00067-d28`)
Varun requested kishan access. Updated `AUTH_USERS_JSON` env var, redeployed, flipped traffic.

```yaml
AUTH_USERS_JSON: '{"varun":"varun123","karan":"karan123","avish":"avish123","vaishali":"vaishali123","rajat":"rajat123","zuildup-sales":"zuildup","kishan":"kishan"}'
```

Verified: kishan:kishan → 200, kishan:wrong → 401, all existing users still work.

### 12:28 UTC — **Phase 9H shipped** (commit `175aa2c`, rev `00068-zqs`)
Password change + admin reset + Firestore-backed user store.

**Architecture change:** Moved user store from immutable env var → Firestore `users` collection (bcrypt-hashed). Env var preserved as fallback for zero-downtime cutover.

**5 new auth endpoints:**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auth/me` | Returns username, role, `password_changed_at` |
| POST | `/api/auth/change-password` | Self-serve. Requires current password. |
| POST | `/api/auth/admin/reset-password` | Admin-only. Resets any user's password. |
| GET | `/api/auth/users` | Admin-only list of users for management UI |
| (boot) | one-shot migration | Idempotent boot migration of `AUTH_USERS_JSON` → Firestore `users` collection |

**Server.js additions (~282 lines):**
- bcryptjs (pure-JS, no native deps) — added to package.json
- 60-second per-username cache to avoid Firestore hammering on every request
- `varun` hardcoded as admin fallback in case Firestore is unreachable
- One-shot idempotent boot migration

**Client UI (`quote.js` + `index.html`, ~311 lines):**
- 👤 Account pill in toolbar
- Change Password modal (self-serve)
- Admin-only Manage Users modal with inline per-user reset + add-user form

### 12:33 UTC — Repo hygiene (commit `9a328cb`)
Removed customer PDF that had been temporarily placed at repo root during QC. Added `_qc_samples/` to `.gitignore` to prevent future leaks.

**Why it mattered:** Repo is private but the team has been growing — defence-in-depth on customer data leaks.

---

## 2. Cumulative phase history table (current as of EOD 2026-06-03)

| Phase | Ship date | Commit | Live rev | Headline |
|---|---|---|---|---|
| 9B-2 | 2026-05-22 | `c1685f4` | `00061-7xv` | URL-qid + sessionStorage per-tab isolation (architectural baseline) |
| 9D | 2026-05-22 | `4ef55b0` | `00063-jgj` | loadState hard guard, applyWizard rebuild, wiz-custom-E. Introduced the wipe bug. |
| 9D rollback | 2026-05-31 | — | `00061-7xv` | Rolled back per Varun's request. Bug still latent in code, just not live. |
| 9E | 2026-06-01 | `7ca9a3a` | `00064-dtn` | Override purge + Reset-to-calculated UI. Did NOT fix wipe (symptom-driven patch). |
| **9F** | 2026-06-03 11:16 | `6fbd1d1` | `00065-5fr` | **STOPS THE WIPE.** 5 defence layers + PITR enabled. |
| **9G** | 2026-06-03 11:35 | `09b21aa` | `00066-l7s` | **PDF UPLOAD.** GCS + 5 endpoints + UI. |
| (env) | 2026-06-03 12:21 | n/a | `00067-d28` | kishan added to AUTH_USERS_JSON |
| **9H** | 2026-06-03 12:28 | `175aa2c` | **`00068-zqs`** | **Password reset (self + admin), Firestore user store, bcrypt.** |
| cleanup | 2026-06-03 12:33 | `9a328cb` | (same rev) | Repo hygiene — customer PDF removed + gitignore |

---

## 3. Critical lessons recorded today (durable, do not forget)

1. **ALWAYS enable Firestore PITR on production projects from day 1.** Default is OFF. 7-day window costs pennies. Audit every prod project:
   ```bash
   gcloud firestore databases describe --database='(default)' --project=<P>
   # Look for: pointInTimeRecoveryEnablement: POINT_IN_TIME_RECOVERY_ENABLED
   ```
   **Todo:** sweep all prod projects — openclaw-prod-777874, zuildup-prod, astro-v3-prod, zuildup-quotes (done).

2. **Defence-in-depth on destructive operations.** Don't trust the client. Server-side guard that validates the destructive shape of the payload regardless of client intent is the difference between "the bug can recur" and "the bug can't recur".

3. **Default-state fingerprint pattern.** A `defaultState()` payload has a recognisable signature (empty customer + null pricing + every row `_isFresh:true` + empty `override`). Any anti-wipe guard should match exactly that. Generalises to any "blank vs populated" mutation guard.

4. **`state.quoteId` vs URL qid is a footgun.** With 9B-2, URL is canonical. Treat `state.quoteId` as cache. Any place that uses `state.quoteId` independently of URL qid is a wipe vector.

5. **Cloud Run `--source` and env-var deploys often ship at 0% traffic.** ALWAYS verify after deploy:
   ```bash
   gcloud run revisions list --service=zuildup-quotes --region=asia-south1 --project=zuildup-quotes
   gcloud run services describe zuildup-quotes --region=asia-south1 --project=zuildup-quotes --format='value(status.traffic)'
   gcloud run services update-traffic zuildup-quotes --to-revisions=<NEW>=100 ...
   ```
   Happened 5+ times today. Every. Single. Deploy.

6. **Investigate before you patch.** Phase 9D introduced a wipe bug. Phase 9E patched around it (missed root cause). Phase 9F finally fixed it. ~12 days of customer data loss because each previous patch was symptom-driven. The Three Rules apply (docs first, verify end-to-end on live URL, 3+ commits on same bug = rethink architecture).

7. **Notify the human EARLY about recoverability.** When data is gone, the user needs to know NOW so they can chase rep browser localStorage before it's reloaded. I told Varun within 5 min of confirming the wipe — gave him real-time decision power.

8. **NO_FAKE_GO_AHEADS rule** — Varun called this out today: "have we done all the QC? I don't want a fake go ahead". Honest answer was "we verified curl-level, not browser-level". When asked, ADMIT what hasn't been verified. Curl pass ≠ UI pass. MD5 match ≠ behaviour match.

9. **Real-world QC matters.** Hardik PDF (real 824 KB, 8 pages) is a far better test than a 425-byte synthetic. Reps will use real PDFs. Test with real PDFs.

10. **Auth via env-var JSON is fine for a small team, but rotation needs a mutable store.** This is what 9H fixed. Lesson for future projects: use a mutable credential store from day 1 if rotation/reset is anywhere on the roadmap.

11. **bcryptjs > bcrypt for Cloud Run.** Pure-JS, no native deps, no Docker build issues. Tiny perf hit not worth the build pain.

12. **One-shot idempotent migration on boot is the cleanest way to seed a new datastore from a legacy env var.** Code path: on first request after deploy, check `users` collection exists; if empty, copy from `AUTH_USERS_JSON`; record migration timestamp. Safe to redeploy any number of times.

---

## 4. Active users (after 9H, with Firestore now authoritative)

| Username | Initial password | Role | Notes |
|---|---|---|---|
| `varun` | `varun123` | **admin** (Firestore + hardcoded fallback) | Founder. Hardcoded admin even if Firestore is unreachable. |
| `karan` | `karan123` | rep | |
| `avish` | `avish123` | rep | Touched all 5 wiped quotes — check his localStorage for any recovery |
| `vaishali` | `vaishali123` | rep | |
| `rajat` | `rajat123` | rep | |
| `zuildup-sales` | `zuildup` | rep | Shared/generic login |
| `kishan` | `kishan` | rep | **Added today** (2026-06-03 12:21 UTC) |

Reps can now change their own passwords via the 👤 Account pill → Change Password modal.
Varun can reset anyone's password via 👤 Account → Manage Users.

---

## 5. Recovery options for the 5 wiped quotes (status as of EOD)

| Quote | Customer | Recovery path | Status |
|---|---|---|---|
| q_mpv1ov9f_bnilgp | Devi Ram Bansal | (A) avish localStorage / (B) 9G PDF upload | Pending Varun's call |
| q_mpv8781d_6icyii | Sudhir Mahajan | same | Pending |
| q_mpnzam1f_z3t7cp | MK Midha | same | Pending |
| q_mp6tm2to_5eg45f | Amit Mathur (Sample Basic) | same | Pending |
| q_muu1brp_7uhsav | Anuj Hasija | same | Pending |

**Path A — browser localStorage (best, exact restore):** rep opens app, DOES NOT click Load on wiped quote, DOES NOT refresh → DevTools → Application → Local Storage → key `zuildup.quotes.<id>` → copy value → I PUT it back via `/api/quotes/:id` with `allowOverwriteEmpty: true`.

**Path B — 9G PDF upload (always works):** Use `📎 Import PDF`, type customer name, upload customer's PDF → new quote slot with `pdf_is_authoritative: true` and gold banner. Form fields stay blank (PDF is source of truth).

**Path C — PITR:** NOT available for these 5 (window expired before PITR was enabled). Available for any FUTURE wipe.

---

## 6. Open follow-ups (post-EOD 2026-06-03)

| Item | Priority | Notes |
|---|---|---|
| Real-world QC for 9G with Hardik PDF | HIGH | Subagent dispatched earlier today. Need to verify result. |
| Recover the 5 wiped quotes | MEDIUM | Varun's call: Path A (chase avish browser), Path B (re-upload PDFs), or both. |
| End-to-end browser test of 9H Change Password + Admin Reset flows | HIGH | Curl-verified only. Need actual UI walkthrough with varun login + non-admin login. |
| Email/notify reps about kishan addition + password reset feature | LOW | Varun's call. |
| Sweep other prod projects for Firestore PITR | MEDIUM | openclaw-prod-777874, zuildup-prod, astro-v3-prod. Enable everywhere. |
| Phase 9I (?) — Parse uploaded PDFs into editable state | LOW | Risky (90% accuracy creates "random values" complaints). Defer unless reps ask. |
| Composite Firestore index for `quote_backups` queries | LOW | (quote_id + replaced_at DESC). Needed when we build "view backups for this quote" UI. |

---

## 7. Quick reference — commands cheat sheet

### Deploy a new revision
```bash
sleep 2 && cd /opt/openclaw/workspace/zuildup/quotation-builder && \
  nohup gcloud run deploy zuildup-quotes \
    --source . \
    --region asia-south1 \
    --project zuildup-quotes \
    --quiet > /tmp/deploy.log 2>&1 &

# After build success, ALWAYS verify traffic:
gcloud run revisions list --service=zuildup-quotes --region=asia-south1 --project=zuildup-quotes --limit=3
gcloud run services describe zuildup-quotes --region=asia-south1 --project=zuildup-quotes --format='value(status.traffic)'

# Flip traffic if 0%:
gcloud run services update-traffic zuildup-quotes \
  --to-revisions=<NEW>=100 \
  --region=asia-south1 --project=zuildup-quotes
```

### 3-way MD5 verify after deploy
```bash
REPO=/opt/openclaw/workspace/zuildup/quotation-builder
LIVE=$(curl -s -u zuildup-sales:zuildup https://zuildup-quotes-zim2owjloq-el.a.run.app/app/quote.js | md5sum | awk '{print $1}')
HEAD=$(md5sum "$REPO/app/quote.js" | awk '{print $1}')
echo "LIVE: $LIVE / HEAD: $HEAD"
[ "$LIVE" = "$HEAD" ] && echo "✅" || echo "⚠️ drift"
```

### Audit wiped quotes (run any time)
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
sleep 2 && bash -c 'cd /opt/ocplatform/workspace/zuildup/quotation-builder && cp /tmp/audit.js _audit.js && node _audit.js && rm _audit.js'
```

### Update env vars (preserve ALL keys)
```bash
# Get current env vars
gcloud run services describe zuildup-quotes --region=asia-south1 --project=zuildup-quotes \
  --format='value(spec.template.spec.containers[0].env)'

# Build full YAML preserving all keys
cat > /tmp/all_env.yaml << 'YAML'
AUTH_USERS_JSON: '{"varun":"varun123",...}'
ANTHROPIC_API_KEY: 'sk-ant-api03-...'
ANTHROPIC_MODEL: 'claude-opus-4-7'
PDF_BUCKET: 'zuildup-quotes-uploads'
YAML

gcloud run services update zuildup-quotes \
  --region=asia-south1 --project=zuildup-quotes \
  --env-vars-file=/tmp/all_env.yaml --quiet
# REMEMBER: flip traffic to new revision after update
```

### Rollback
```bash
# Back to 9G (rev 00066-l7s) — loses 9H password reset, keeps wipe fix + PDF
gcloud run services update-traffic zuildup-quotes \
  --to-revisions=zuildup-quotes-00066-l7s=100 \
  --region=asia-south1 --project=zuildup-quotes

# Back to 9F (rev 00065-5fr) — loses 9G PDF + 9H, keeps wipe fix
gcloud run services update-traffic zuildup-quotes \
  --to-revisions=zuildup-quotes-00065-5fr=100 \
  --region=asia-south1 --project=zuildup-quotes

# NEVER go back further — wipe vector returns.
```

### Firestore PITR (read-by-time)
```bash
# Check status
gcloud firestore databases describe --database='(default)' --project=zuildup-quotes
# Look for: pointInTimeRecoveryEnablement: POINT_IN_TIME_RECOVERY_ENABLED

# Read a doc as of a specific time (in node):
# const snap = await firestore.collection('quotes').doc(id).get({ readTime: new Date('2026-06-04T10:00:00Z') });
```

---

## 8. Anti-FS-quirk note (operational)

This VM's filesystem occasionally returns ENOENT on freshly written/synced paths for ~1–2 seconds. Mitigations used today:
- `sync && sleep 1` before any `cd` or `git -C`
- Use absolute paths everywhere
- If a file shows in `git show` but not `ls`, restore via `git show <sha>:<path> > <path>`
- This pattern recovered the `qc-2026-06-03/CONTEXT_SNAPSHOT_2026-06-03.md` file mid-session today

---

## 9. End

This is the consolidated record of 2026-06-03's work. If you are picking up tomorrow:

1. Read this file top-to-bottom.
2. Read `qc-2026-06-03/CONTEXT_SNAPSHOT_2026-06-03.md` for deeper detail on the data-loss incident.
3. Check `memory/2026-06-03.md` for any additional workspace-level notes from the day.
4. Verify section 0 (production state) still matches reality:
   ```bash
   gcloud run revisions list --service=zuildup-quotes --region=asia-south1 --project=zuildup-quotes --limit=3
   ```
   If the live revision has changed since 00068-zqs, find the new SESSION doc.
5. Top priority follow-ups: real-world QC for 9G + browser test for 9H.

— Iraaj 🌀, 2026-06-03 EOD
