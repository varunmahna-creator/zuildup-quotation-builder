# ZuildUp Quotation Builder — Project Archive
**Status: ✅ SHIPPED — Phase 2 deployed, verified clean, stood down**
**Date archived:** 2026-04-29
**Final commit:** `cfb661d` — "Deploy follow-up: simpler password, remove feedback button per Varun"
**Final tag:** `phase2-deployed`

---

## 🚀 LIVE DEPLOYMENT

| Field | Value |
|---|---|
| **URL** | https://zuildup-quotes-zim2owjloq-el.a.run.app |
| **Old URL** (also routes) | https://zuildup-quotes-586295767597.asia-south1.run.app |
| **Username** | `zuildup-sales` |
| **Password** | `zuildup` *(simplified per Varun's request, post-deploy)* |
| **GCP Project** | `zuildup-quotes` (number 586295767597) |
| **Region** | asia-south1 (Mumbai) |
| **Billing Account** | 01E743-EB4996-3EAD7C |
| **Latest Revision** | zuildup-quotes-00005-wgm |
| **Resources** | 2Gi memory, 1 CPU, 60s timeout, max 10 instances |
| **Auth Mode** | --allow-unauthenticated at Cloud Run; basic-auth in app |
| **gcloud account** | varunmahna@gmail.com (on VM) |

---

## 📜 PROJECT JOURNEY (Phase 1 → Phase 2 → Deploy)

### Phase 1 — Catalog & Calculator (DONE earlier)
Tags: `phase2-step-3-catalog` through `phase2-step-9-sales-ux-polish`
- Built service catalog (`catalog/catalog.json`) with all interior-build line items
- Per-item calculator with floor/area/finish multipliers
- Sales UX polish: keyboard nav, line-item search, totals panel

### Phase 2 — Save/Load, PDF, Validation (DONE this sprint)
- **P1.5 (Save/Load)** — Multi-customer quote storage in localStorage, auto-save, export/import JSON. Tag `phase2-step-10-quote-save-load`
- **P1.5.1 (Description scrub)** — Customer-facing PDF prose cleanup. PDF text-md5 baseline locked at `58ef6d4ee186d12c354806b38029ea02` (305.5 KB, 8 pages). Tag `phase2-step-10.1-description-scrub`
- **P1.6 (PDF polish)** — Filename pattern, draft watermark, image compression. Tag `phase2-step-11-pdf-polish`
- **P1.7 (Validation)** — Field validation + business rules. Tag `phase2-step-12-validation`
- Closed: `phase2-complete` at commit `026055d`

### Cloud Run Deploy — 2026-04-29 (THIS SESSION)
- Stage 0: GCP project, billing, APIs (run / cloudbuild / artifactregistry)
- Stage 1: Dockerfile (node:20-slim + Chrome stable + fonts), .dockerignore (excludes 449MB lookbook)
- Stage 2: server.js patches — bind 0.0.0.0, CHROME_BIN env, basic auth, /healthz, /feedback handler
- Stage 3: Live smoke tests — all 6 checks green (auth gate, catalog, /pdf minimal, /pdf p13 fixture)
- Stage 4: Feedback button + modal added, then **REMOVED** in commit `cfb661d` per Varun's call (low-friction internal use, simpler is better)
- Stage 5: `docs/SALES_QUICKSTART.md` written
- **Final:** Password simplified `EPCYThzvsNuJGywr4doS` → `zuildup`. Tagged `phase2-deployed`.

---

## 📁 KEY FILES

```
quotation-builder/
├── app/
│   ├── server.js          # Express + Puppeteer PDF, basic auth, Cloud Run-ready
│   ├── index.html         # Sales UI (no feedback button — removed in cfb661d)
│   ├── quote.js           # GENERATED — never hand-edit
│   └── styles.css
├── catalog/
│   └── catalog.json       # GENERATED via scripts/build_catalog.py
├── scripts/
│   ├── build_catalog.py
│   └── build_quote_js.py  # Generator-first source-of-truth for app/quote.js
├── docs/
│   ├── SALES_QUICKSTART.md      # For sales team onboarding
│   ├── SESSION_RESUME_*.md      # Per-sprint resume docs
│   └── ...
├── tests/                  # CDP test fixtures (P1.6, P1.7)
├── Dockerfile              # node:20-slim + Google Chrome Stable
├── .dockerignore           # Critical: excludes assets/lookbook/ (449MB)
├── package.json
└── PROJECT_ARCHIVE.md      # ← THIS FILE
```

---

## 🧠 DURABLE LESSONS LEARNED

### Architecture
1. **Generator-first rule paid off** — `scripts/build_quote_js.py` made the late "remove feedback button" change a 1-line edit + regen vs. surgical hand-edits in 1934 lines of generated code.
2. **PDF text-md5 as a baseline contract** — `58ef6d4ee186d12c354806b38029ea02` lets us detect any prose drift in customer-facing output without visual diff infrastructure.
3. **Listen ports + bind addresses are not the same thing** — Cloud Run requires `0.0.0.0`, not `127.0.0.1`. Localhost-only worked locally but failed in container.

### Cloud Run Specific (apply to ALL future Cloud Run deploys)
4. **VM has NO Docker** — always `gcloud run deploy --source .` (Cloud Build runs server-side)
5. **Mandatory Chrome flags for Puppeteer in Cloud Run:**
   - `--no-sandbox` (no privileged containers)
   - `--disable-dev-shm-usage` (limited /dev/shm)
   - `--disable-gpu`, `--headless=new`, `--hide-scrollbars`
   - Set `CHROME_BIN=/usr/bin/google-chrome-stable` env, install via Dockerfile
6. **Cloud Run edge LB intercepts some paths** — `/healthz` returned 404 from edge despite container having a handler. TCP probe still works. Don't rely on third-party HTTP healthz.
7. **Auth gate ordering matters** — `app.use('/healthz', ...)` MUST come BEFORE `app.use(requireAuth)`.
8. **Always exclude large unused assets via .dockerignore** — 449MB lookbook would have ballooned image, build time, and cost. Audit with `du -sh */` then trace runtime references with grep.
9. **Build context size sanity-check** — `du -sh .` minus dockerignored paths before every deploy.

### gcloud Auth Workflow
10. **Background gcloud auth via FIFO works but is fragile** — `gcloud auth login --no-launch-browser` has a "Y/n" prompt that breaks naive heredoc piping. Solution: FIFO + `(echo Y; sleep 7200) > /tmp/gauth-stdin &` then later write the verification code.
11. **`setsid nohup ... disown`** survives bash tool 30s timeouts.

### Phantom-FS Mitigations (this VM)
12. **`git ls-files` is ground truth** for "does this file exist" — not `ls`/`stat`
13. **Absolute paths everywhere** — never `cd` then relative
14. **Sleep 12-15s + retry on ENOENT** for fresh writes
15. **Use `cat` or `python -c "open(...)"` for verification**, not `stat`/`ls`

### Process / Scope
16. **Ship simple, then iterate** — Varun killed the feedback button after deploy. Right call: internal tool, low-friction wins. Don't over-engineer for hypothetical needs.
17. **Password simplicity for internal tools** — `zuildup` beats `EPCYThzvsNuJGywr4doS` for a sales team that types it daily. Threat model: this is internal, single-shared-cred is fine.

---

## 🔧 OPERATIONAL RUNBOOK

### View / inspect
```bash
gcloud run services describe zuildup-quotes --region asia-south1
gcloud run services logs read zuildup-quotes --region asia-south1 --limit 50
```

### Redeploy after code change
```bash
cd /opt/openclaw/workspace/zuildup/quotation-builder
gcloud run deploy zuildup-quotes --source . --region asia-south1 \
  --allow-unauthenticated --memory 2Gi --cpu 1 --timeout 60s --max-instances 10 \
  --set-env-vars AUTH_USER=zuildup-sales,AUTH_PASS=zuildup,NODE_ENV=production
```

### Update env var only (no rebuild)
```bash
gcloud run services update zuildup-quotes --region asia-south1 \
  --update-env-vars KEY=value
```

### Roll back to a previous revision
```bash
gcloud run services update-traffic zuildup-quotes --region asia-south1 \
  --to-revisions zuildup-quotes-00004-xxx=100
```

### Generator-first workflow (for any UI/logic change)
1. Edit `scripts/build_quote_js.py` (NEVER `app/quote.js` directly)
2. Run: `python3 scripts/build_quote_js.py`
3. Verify: `node -c app/quote.js` (syntax check)
4. Test locally if possible, then redeploy

---

## ⚠️ KNOWN ISSUES (deferred / accepted)

| Issue | Severity | Decision |
|---|---|---|
| `/healthz` returns 404 from edge LB | Low | Accepted — TCP probe works, kept for internal use |
| PDF baseline md5 not auto-verified | Med | Deferred — VM has no headless Chrome locally; verify manually via live URL when needed |
| Single shared credential | Low | Accepted — internal tool, simplicity wins. Migrate to OAuth if team grows |
| `assets/lookbook/` (449MB) excluded | None | Working as designed; not loaded at runtime |

---

## 🎯 IF / WHEN PROJECT RESUMES

**Read in this order:**
1. This file (`PROJECT_ARCHIVE.md`)
2. `docs/SESSION_RESUME_2026-05-01.md` (Phase 2 close-out)
3. `docs/SALES_QUICKSTART.md` (user-facing)
4. `memory/2026-04-29.md` (workspace) — original deploy-day notes

**Common future-asks:**
- *"Add a new line item to catalog"* → `scripts/build_catalog.py`, then redeploy
- *"Change pricing logic"* → `scripts/build_quote_js.py`, regen, redeploy
- *"Add feedback button back"* → revert to commit `00d3a18`, cherry-pick the index.html + build_quote_js.py changes, set `FEEDBACK_WEBHOOK` env var
- *"Per-user auth"* → replace basic-auth middleware with OAuth (Google Identity-Aware Proxy / Cloud IAP is the cleanest path)
- *"Cost concern"* → switch min-instances to 0 (already there), reduce max-instances if traffic is low

---

## 🏁 FINAL SIGN-OFF

**Varun:** "great job iraaj! All verified clean. Done. Stand down. 🔥"
**iraaj:** Standing down. Project archived. 🪶
