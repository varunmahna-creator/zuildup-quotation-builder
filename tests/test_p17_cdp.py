#!/usr/bin/env python3
"""P1.7 CDP test harness — 4 tests.

P1.6:
  T-filename       : Content-Disposition uses ZuildUp_Quote_<lastname>_<date>.pdf
  T-watermark-off  : default state.draft=false → "DRAFT" text NOT in PDF
  T-watermark-on   : state.draft=true → "DRAFT" appears in PDF (multiple times)
  T-pdf-size       : standard fixture renders < 1 MB

P1.7:
  T-validate-coverage    : coverage 150 → input gets .invalid; 50 → clean
  T-validate-rate        : clearing costPerSqft → invalid; setting 1500 → clean
  T-validate-empty       : zero rows → Download PDF disabled, hint visible
  T-validate-norate-block: row with no rate → modal appears on Download click
"""
import json, sys, time, hashlib, urllib.request, urllib.parse, websocket

CDP = "ws://127.0.0.1:9223"
HTTP_DBG = "http://127.0.0.1:9223"
SERVER = "http://127.0.0.1:8124"


_msg_id = 0
def cdp_open(url):
    req = urllib.request.Request(HTTP_DBG + "/json/new?" + url, method="PUT")
    raw = urllib.request.urlopen(req).read()
    target = json.loads(raw)
    ws = websocket.create_connection(target["webSocketDebuggerUrl"])
    return ws, target["id"]


def cdp_close(tid):
    try: urllib.request.urlopen(HTTP_DBG + "/json/close/" + tid).read()
    except: pass


def cdp_send(ws, method, params=None):
    global _msg_id
    _msg_id += 1
    ws.send(json.dumps({"id": _msg_id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _msg_id:
            return msg.get("result", msg)


def cdp_eval(ws, expr, await_promise=False):
    r = cdp_send(ws, "Runtime.evaluate", {
        "expression": expr, "returnByValue": True, "awaitPromise": await_promise,
    })
    if "exceptionDetails" in r:
        raise RuntimeError(f"JS: {r['exceptionDetails']}")
    res = r.get("result", {})
    return res.get("value")


def wait_preview_ready(ws, timeout=5):
    """For preview pages — wait until preview-root has children."""
    for _ in range(int(timeout / 0.3)):
        n = cdp_eval(ws, "document.getElementById('preview-root') ? document.getElementById('preview-root').children.length : 0")
        if (n or 0) > 0:
            return True
        time.sleep(0.3)
    return False


def wait_form_ready(ws, timeout=5):
    """For index.html — wait until #spec-list exists."""
    for _ in range(int(timeout / 0.3)):
        n = cdp_eval(ws, "document.getElementById('spec-list') ? 1 : 0")
        if n:
            time.sleep(0.5)  # give bootForm() a beat to wire listeners
            return True
        time.sleep(0.3)
    return False


def render_pdf_via_post(html, customer_last="", date_str=""):
    qs = urllib.parse.urlencode({"customer_last": customer_last, "date": date_str})
    req = urllib.request.Request(
        SERVER + "/pdf?" + qs, data=html.encode("utf-8"),
        headers={"Content-Type": "text/html"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), r.headers.get("Content-Disposition", "")


def extract_pdf_text(pdf_bytes):
    import fitz
    with open("/tmp/_test.pdf", "wb") as f: f.write(pdf_bytes)
    doc = fitz.open("/tmp/_test.pdf")
    # Use both default + blocks-based extraction. Blocks captures rotated/positioned
    # text that the flow-aware default pass omits (e.g. our DRAFT watermark with rotate(-30deg)).
    parts = []
    for p in doc:
        parts.append(p.get_text())
        parts.append("\n".join(b[4] for b in p.get_text("blocks")))
    t = "\n".join(parts)
    n = doc.page_count
    doc.close()
    return t, n


# ---- P1.7 tests --------------------------------------------------------------

def t_validate_coverage():
    """Coverage 150 → .invalid + hint; 50 → clean."""
    # Open the form (index.html), set coverage to 150 via the input, observe class.
    ws, tid = cdp_open(SERVER + "/")
    try:
        wait_form_ready(ws)
        # Simulate user typing 150 in coverage
        cdp_eval(ws, """(function(){
            var i = document.getElementById('f-coverage');
            i.value = 150;
            i.dispatchEvent(new Event('input', {bubbles:true}));
        })()""")
        time.sleep(0.4)
        invalid_150 = cdp_eval(ws, "document.getElementById('f-coverage').classList.contains('invalid')")
        hint_150 = cdp_eval(ws, "(function(){var p = document.getElementById('f-coverage').parentElement.querySelector('.qb-hint'); return p ? p.textContent : null;})()")
        # Now set to 50
        cdp_eval(ws, """(function(){
            var i = document.getElementById('f-coverage');
            i.value = 50;
            i.dispatchEvent(new Event('input', {bubbles:true}));
        })()""")
        time.sleep(0.4)
        invalid_50 = cdp_eval(ws, "document.getElementById('f-coverage').classList.contains('invalid')")
    finally:
        cdp_close(tid)
    assert invalid_150 is True, f"coverage=150 should be .invalid, got {invalid_150}"
    assert (hint_150 or "").strip() != "", f"hint should be shown, got {hint_150!r}"
    assert invalid_50 is False, f"coverage=50 should be clean, got {invalid_50}"
    return f"150→invalid+hint={hint_150!r}, 50→clean"



def t_validate_rate():
    """Clearing costPerSqft (full mode) → invalid; setting 1500 → clean."""
    ws, tid = cdp_open(SERVER + "/")
    try:
        wait_form_ready(ws)
        # Ensure full-build mode (default)
        cdp_eval(ws, """(function(){
            var s = JSON.parse(localStorage.getItem('zuildup.quote.v2'))||{};
            s.scope = 'full'; s.build = s.build||{}; s.build.buildType = 'stilt';
            localStorage.setItem('zuildup.quote.v2', JSON.stringify(s));
        })()""")
        # Reload to apply
        cdp_send(ws, "Page.reload", {})
        time.sleep(2.0)
        wait_form_ready(ws)
        # Clear cost-sqft
        cdp_eval(ws, """(function(){
            var i = document.getElementById('f-cost-sqft');
            i.value = '';
            i.dispatchEvent(new Event('input', {bubbles:true}));
        })()""")
        time.sleep(0.4)
        invalid_blank = cdp_eval(ws, "document.getElementById('f-cost-sqft').classList.contains('invalid')")
        hint_blank   = cdp_eval(ws, "(function(){var p = document.getElementById('f-cost-sqft').parentElement.querySelector('.qb-hint'); return p ? p.textContent : null;})()")
        # Set to 1500
        cdp_eval(ws, """(function(){
            var i = document.getElementById('f-cost-sqft');
            i.value = 1500;
            i.dispatchEvent(new Event('input', {bubbles:true}));
        })()""")
        time.sleep(0.4)
        invalid_1500 = cdp_eval(ws, "document.getElementById('f-cost-sqft').classList.contains('invalid')")
    finally:
        cdp_close(tid)
    assert invalid_blank is True, f"blank costPerSqft should be invalid, got {invalid_blank}"
    assert (hint_blank or "").strip() != "", f"hint should show, got {hint_blank!r}"
    assert invalid_1500 is False, f"1500 should be clean, got {invalid_1500}"
    return f"blank→invalid+hint={hint_blank!r}, 1500→clean"



def t_validate_empty():
    """Zero rows → Download PDF button disabled, inline empty-hint visible.

    Implementation: bootForm auto-seeds rows on first load. After that, we delete
    every row via the row's .x (close) handler — the user-facing path. Then
    applyValidation() flips Download PDF to disabled.
    """
    ws, tid = cdp_open(SERVER + "/")
    try:
        wait_form_ready(ws)
        # Click every row's .x to delete. The handlers re-render the list, so
        # we have to repeatedly click the FIRST row's x until the list is empty.
        for _ in range(120):
            n = cdp_eval(ws, "document.querySelectorAll('#spec-list .spec').length")
            if n == 0: break
            cdp_eval(ws, "(function(){var x=document.querySelector('#spec-list .spec .x'); if(x) x.click();})()")
            time.sleep(0.05)
        time.sleep(0.4)
        dl_disabled = cdp_eval(ws, "document.getElementById('dl').disabled")
        hint_text = cdp_eval(ws, "document.getElementById('spec-count').textContent")
        rows_count = cdp_eval(ws, "JSON.parse(localStorage.getItem('zuildup.quote.v2')).rows.length")
    finally:
        cdp_close(tid)
    assert rows_count == 0, f"rows wasn't 0: {rows_count}"
    assert dl_disabled is True, f"Download PDF should be disabled, got {dl_disabled}"
    assert ("add at least one" in (hint_text or "").lower()) or ("0 items" in (hint_text or "")), \
        f"hint missing: {hint_text!r}"
    return f"rows=0, dl.disabled={dl_disabled}, hint={hint_text!r}"



def t_validate_norate_block():
    """Add 1 row with no rate → click Download PDF → modal opens → Cancel → no download."""
    ws, tid = cdp_open(SERVER + "/")
    try:
        wait_form_ready(ws)
        # Seed: one row, no override.rate
        cdp_eval(ws, """(function(){
            var s = JSON.parse(localStorage.getItem('zuildup.quote.v2'))||{};
            s.rows = [{ id: 'general.main_gate', override: {} }];
            // ensure pricing is OK so other validators don't intervene
            s.build = s.build || {};
            s.build.coverage = 60;
            s.pricing = s.pricing || {};
            s.pricing.costPerSqft = 2850;
            localStorage.setItem('zuildup.quote.v2', JSON.stringify(s));
        })()""")
        cdp_send(ws, "Page.reload", {})
        time.sleep(2.5)
        wait_form_ready(ws)
        # Click the Download PDF button — this should pop the modal
        cdp_eval(ws, "document.getElementById('dl').click()")
        time.sleep(0.6)
        modal_open = cdp_eval(ws, """(function(){
            var m = document.getElementById('qb-norate-modal');
            return m ? m.classList.contains('open') : false;
        })()""")
        modal_text = cdp_eval(ws, """(function(){
            var n = document.getElementById('qb-norate-n');
            return n ? n.textContent : '';
        })()""")
        # Click Cancel
        cdp_eval(ws, "document.getElementById('qb-norate-cancel').click()")
        time.sleep(0.4)
        modal_after = cdp_eval(ws, """(function(){
            var m = document.getElementById('qb-norate-modal');
            return m ? m.classList.contains('open') : false;
        })()""")
        # Verify no download occurred — check that the dl button is back to enabled
        dl_text = cdp_eval(ws, "document.getElementById('dl').textContent")
    finally:
        cdp_close(tid)
    assert modal_open is True, f"modal should be open after click, got {modal_open}"
    assert "1 row" in (modal_text or "") or "row has no" in (modal_text or ""), f"modal text wrong: {modal_text!r}"
    assert modal_after is False, f"modal should be closed after Cancel, got {modal_after}"
    assert "Download" in (dl_text or ""), f"button text indicates ongoing download: {dl_text!r}"
    return f"opened={modal_open}, msg={modal_text!r}, cancelled→closed={not modal_after}"


# ---- runner ------------------------------------------------------------------


# ---- runner ------------------------------------------------------------------

TESTS = [
    ("T-validate-coverage",     t_validate_coverage),
    ("T-validate-rate",         t_validate_rate),
    ("T-validate-empty",        t_validate_empty),
    ("T-validate-norate-block", t_validate_norate_block),
]


def main():
    fails = 0
    print("P1.7 CDP tests")
    print("=" * 50)
    for name, fn in TESTS:
        try:
            r = fn()
            print(f"  [PASS] {name:28s} :: {r}")
        except Exception as e:
            fails += 1
            import traceback
            print(f"  [FAIL] {name:28s} :: {e}")
            traceback.print_exc(limit=3)
    print("=" * 50)
    import sys
    print(f"=== {len(TESTS)-fails}/{len(TESTS)} PASS ===" if fails == 0 else f"=== {fails} FAIL ===")
    sys.exit(0 if fails == 0 else 1)


if __name__ == "__main__":
    main()
