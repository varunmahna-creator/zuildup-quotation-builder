#!/usr/bin/env python3
"""P1.6 CDP test harness — 4 tests.

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


# ---- P1.6 tests --------------------------------------------------------------

def t_filename():
    """Default-path render — server must echo ZuildUp_Quote_<last>_<date>.pdf in Content-Disposition."""
    # Open the seeded preview to get a normal HTML payload.
    ws, tid = cdp_open(SERVER + "/app/_p13_preview.html")
    try:
        wait_preview_ready(ws)
        time.sleep(1.5)
        html = cdp_eval(ws, "'<!doctype html>' + document.documentElement.outerHTML")
    finally:
        cdp_close(tid)
    pdf, cd = render_pdf_via_post(html, customer_last="Kamboj", date_str="2026-04-29")
    expect = 'filename="ZuildUp_Quote_Kamboj_2026_04_29.pdf"'
    assert expect in cd, f"got CD={cd!r}, want {expect}"
    # also test sanitization fallback when last is empty
    _, cd2 = render_pdf_via_post(html, customer_last="", date_str="2026-04-29")
    assert 'Untitled' in cd2, f"empty-last fallback failed: {cd2!r}"
    return f"CD={cd!r}; empty→{cd2!r}"



def t_watermark_off():
    """state.draft=false (default) → no DRAFT text in extracted PDF."""
    ws, tid = cdp_open(SERVER + "/app/_p13_preview.html")
    try:
        wait_preview_ready(ws)
        time.sleep(1.5)
        # Verify state.draft is falsy
        d = cdp_eval(ws, "JSON.parse(localStorage.getItem('zuildup.quote.v2')).draft")
        html = cdp_eval(ws, "'<!doctype html>' + document.documentElement.outerHTML")
    finally:
        cdp_close(tid)
    pdf, _ = render_pdf_via_post(html, customer_last="Kamboj", date_str="2026-04-29")
    text, npg = extract_pdf_text(pdf)
    # In non-draft mode, neither compact "DRAFT" nor spaced "D R A F T" should appear.
    import re as _r
    n_draft = len(_r.findall(r'D\s*R\s*A\s*F\s*T', text))
    assert n_draft == 0, f"unexpected DRAFT in non-draft PDF (count={n_draft})"
    assert (d in (False, None)), f"state.draft was {d!r}, expected falsy"
    return f"draft={d}, pages={npg}, DRAFT_count=0"



def t_watermark_on():
    """state.draft=true → DRAFT appears in PDF text (once per page via ::after)."""
    ws, tid = cdp_open(SERVER + "/app/_p13_preview.html")
    try:
        wait_preview_ready(ws)
        time.sleep(1.5)
        # Toggle state.draft = true and force re-paint
        cdp_eval(ws, """(function(){
            var s = JSON.parse(localStorage.getItem('zuildup.quote.v2')) || {};
            s.draft = true;
            localStorage.setItem('zuildup.quote.v2', JSON.stringify(s));
            window.dispatchEvent(new Event('storage'));
        })()""")
        time.sleep(1.5)  # let the 700ms paint interval run twice
        html = cdp_eval(ws, "'<!doctype html>' + document.documentElement.outerHTML")
    finally:
        cdp_close(tid)
    pdf, _ = render_pdf_via_post(html, customer_last="Kamboj", date_str="2026-04-29")
    text, npg = extract_pdf_text(pdf)
    # Rotated DRAFT extracts as either 'DRAFT' (compact) or 'D R A F T' (spaced) depending
    # on glyph positioning. Both forms count.
    import re as _r
    n_draft = len(_r.findall(r'D\s*R\s*A\s*F\s*T', text))
    assert n_draft >= 2, f"expected DRAFT on multiple pages, got count={n_draft}, pages={npg}"
    return f"draft=true, pages={npg}, DRAFT_count={n_draft}"



def t_pdf_size():
    """Default-path PDF on standard fixture must be < 1 MB."""
    ws, tid = cdp_open(SERVER + "/app/_p13_preview.html")
    try:
        wait_preview_ready(ws)
        time.sleep(1.5)
        html = cdp_eval(ws, "'<!doctype html>' + document.documentElement.outerHTML")
    finally:
        cdp_close(tid)
    pdf, _ = render_pdf_via_post(html, customer_last="Kamboj", date_str="2026-04-29")
    n = len(pdf)
    assert n < 1024 * 1024, f"PDF size {n} bytes > 1 MB"
    return f"{n} bytes ({n/1024:.1f} KB)"


# ---- P1.7 tests --------------------------------------------------------------


# ---- runner ------------------------------------------------------------------

TESTS = [
    ("T-filename",              t_filename),
    ("T-watermark-off",         t_watermark_off),
    ("T-watermark-on",          t_watermark_on),
    ("T-pdf-size",              t_pdf_size),
]


def main():
    fails = 0
    print("P1.6 CDP tests")
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
