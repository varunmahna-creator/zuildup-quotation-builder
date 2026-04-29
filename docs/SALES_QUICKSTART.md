# ZuildUp Quotation Builder — Sales Quickstart

## Login
- **URL:** https://zuildup-quotes-586295767597.asia-south1.run.app
- **Username:** `zuildup-sales`
- **Password:** `zuildup`

The browser will prompt for credentials on first visit. Most browsers remember
them per-session.

## Create your first quote — 5 steps
1. **Customer** — fill name, plot address, phone (left pane, top).
2. **Build details** — plot length × breadth (in feet), coverage %, floor count,
   tick "Lift" / "Basement" if applicable.
3. **Build mode** — choose Full / Stilt+Floors / No-stilt / Structure-only,
   then enter **₹ per sq ft** (or **structure rate** for structure-only mode).
4. **Spec rows** — each row is a line item. Click a card to set rate, brands,
   description per item. Use **Tab / Shift+Tab** to move between rows. Use
   **+ Add Custom** for non-catalog items.
5. **Download** — click **Download PDF**. Filename auto-formats as
   `ZuildUp_Quote_<Lastname>_<YYYY-MM-DD>.pdf`.

## Multi-customer (Save / Load)
- **New Quote** — clear current state, return to scratch
- **Save** — name the quote (defaults to `<Customer> — <date>`); creates a slot
- **Load** — open the list, pick a saved quote (with Duplicate / Delete inline)
- **Export** — download a `.json` backup off-platform
- **Import** — upload a `.json` to restore
- **Auto-save** — once a quote is named, edits auto-save 3 sec after you stop typing
  (the toolbar shows "Saving…" then "Saved at HH:MM")

## Keyboard shortcuts
- **Tab** — next row's first input (jumps + opens editor)
- **Shift+Tab** — previous row
- **Enter / Space** on a focused card — open its editor
- **Esc** — close editor, return focus to card

## DRAFT mode
Toggle **DRAFT** on the toolbar to add a diagonal "DRAFT" watermark on every
PDF page. Default: off (final copy).

## Reporting issues
If something feels off — broken layout, wrong calculation, missing item — tell
Varun on **WhatsApp**. We'll prioritise based on impact.


## Known limits
- One customer per saved slot (~5 MB localStorage; the app warns at ~80% full).
- Single-browser tool — no real-time collaboration. Use **Export → Import** to
  share a quote between machines.
- PDF rendering takes 5–15 seconds (longer on first request after idle —
  Cloud Run scales to zero between bursts).
- DRAFT watermark is on EVERY page, not removable without unticking the toggle.

## Troubleshooting
- **Blank PDF / spinner forever** → reload, try again. If persistent, ping Varun on WhatsApp.
- **"Saving…" stuck** → use Save button manually. Refresh to verify state
  survived.
- **Lost a quote** → check Load list. If gone, Export every important quote
  preventively.

## Questions or issues
Channel: **#zuildup-quotation-builder**. Tag Varun directly for credential
resets or hosting questions.
