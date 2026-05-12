"""Phase 6.1 — Sales-team feedback regression tests.

Locks the invariants behind:
  Item 1  — per-item rate override panel opens by default (regex on quote.js)
  Item 5  — @media print hides .rate-pill.set / .set-rate
  Item 6  — @media print neutralises .spec-card.unedited styling
  Item 10 — quoteValidUntil(createdAt, 60) returns date+60d, en-IN format;
            cover renders the validity line.
  Item 11b — table header is "Rate" (not "Brand & Rate"); rowFields() rate
             column is rate-only; brand info migrates into description for
             catalog defaults.

Strategy: source-string assertions for CSS / HTML invariants (no Node needed),
plus a Node shim for rowFields() and quoteValidUntil() behaviour matching the
test_phase5.py pattern.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

QB = Path(__file__).parent.parent
QUOTE_JS = (QB / "app/quote.js").read_text()
INDEX_HTML = (QB / "app/index.html").read_text()
CAT = json.load(open(QB / "catalog/catalog.json"))


# ----------------------------------------------------------------------------
# Item 1: <details id="item-rate-overrides"> opens by default
# ----------------------------------------------------------------------------
def test_item_rate_panel_opens_by_default():
    # The render code should set details.open = true unconditionally.
    m = re.search(
        r"const details = document\.getElementById\('item-rate-overrides'\);\s*"
        r"if \(details\) details\.open = true;",
        QUOTE_JS,
    )
    assert m, "Expected unconditional `if (details) details.open = true` in renderItemRatesPanel"

    # And the prior gated form must be GONE.
    bad = re.search(
        r"if \(details && hasOverride\) details\.open = true;",
        QUOTE_JS,
    )
    assert not bad, "Old conditional auto-open is still present"


# ----------------------------------------------------------------------------
# Item 2: shared CSS for both override panels
# ----------------------------------------------------------------------------
def test_item_rate_panel_shares_css():
    # The aov-row selector must now also target #item-rate-list .aov-row
    assert "#area-ovr-list .aov-row, #item-rate-list .aov-row" in INDEX_HTML, \
        "Expected shared selector for .aov-row across both override panels"
    assert "#area-ovr-list .aov-name, #item-rate-list .aov-name" in INDEX_HTML
    assert "#area-ovr-list input, #item-rate-list input" in INDEX_HTML


# ----------------------------------------------------------------------------
# Item 5 + Item 6: @media print rules
# ----------------------------------------------------------------------------
def test_print_hides_set_details_placeholder():
    """@media print { .rate-pill.set, .set-rate { display: none; } }"""
    # Be permissive on whitespace & !important.
    pattern = re.compile(
        r"@media\s+print\s*\{[^}]*\.rate-pill\.set,\s*\.set-rate\s*\{[^}]*display:\s*none",
        re.DOTALL,
    )
    assert pattern.search(QUOTE_JS), "Missing @media print rule for hiding placeholder"


def test_print_neutralises_unedited_card():
    """@media print { .spec-card.unedited { background: white; border-style: solid; } ... }"""
    # Look for white background and solid border inside @media print on .spec-card.unedited
    block_match = re.search(r"@media\s+print\s*\{(.+?)\n  \}", QUOTE_JS, re.DOTALL)
    assert block_match, "Could not locate @media print block"
    body = block_match.group(1)
    assert "spec-card.unedited" in body
    assert "background: white" in body
    assert "border-style: solid" in body
    assert "font-style: normal" in body


# ----------------------------------------------------------------------------
# Item 10: quoteValidUntil + cover validity line
# ----------------------------------------------------------------------------
def _node_eval(snippet, args=None):
    """Run a JS snippet in a Node shim that exposes quote.js helpers globally."""
    args = args or []
    args_json = json.dumps(args)
    catalog_json = json.dumps(CAT)
    shim = r"""
'use strict';
const fs = require('fs');
const QUOTE_SRC = fs.readFileSync(process.argv[2], 'utf8');
const ARGS = JSON.parse(process.argv[3]);
const CATALOG = JSON.parse(process.argv[4]);

global.window = {};
global.document = { getElementById: () => null };
global.localStorage = {
  _s:{}, getItem(k){return this._s[k]||null;},
  setItem(k,v){this._s[k]=String(v);},
  removeItem(k){delete this._s[k];},
  key(i){return Object.keys(this._s)[i]||null;},
  get length(){return Object.keys(this._s).length;},
};
global.fetch = () => Promise.resolve({ ok:true, json: async () => CATALOG });
global.CustomEvent = class { constructor(n,o){this.type=n;Object.assign(this,o||{});} };
global.Event = class { constructor(n){this.type=n;} };
window.dispatchEvent = () => {};
window.addEventListener = () => {};

let patched = QUOTE_SRC
  .replace('let CATALOG = null;', 'let CATALOG = ' + JSON.stringify(CATALOG) + ';')
  .replace('function quoteValidUntil(createdIso, days = 60) {', 'global.quoteValidUntil = function quoteValidUntil(createdIso, days = 60) {')
  .replace('function formatDate(iso) {', 'global.formatDate = function formatDate(iso) {')
  .replace('function fmtINR(n) {', 'global.fmtINR = function fmtINR(n) {')
  .replace('function escapeHtml(s) {', 'global.escapeHtml = function escapeHtml(s) {')
  .replace('function renderQuote(state, about) {', 'global.renderQuote = function renderQuote(state, about) {')
  .replace('  function rowFields(row, it) {', '  global.rowFields = function rowFields(row, it) {');

try { eval(patched); } catch(e) { console.error('eval err', e.message); process.exit(2); }

try {
  global.renderQuote({
    customer:{name:'',address:''}, build:{plotSqYards:240,breadth:36,coverage:75,buildType:'stilt',floors:1,hasBasement:false,hasLift:false},
    pricing:{costPerSqft:1000,structureRate:1000,itemRates:{}}, scope:'full',
    rows:[{id:'structure.steel', override:{}}], notes:'',
    // Phase 7H-B: harness state mimics a fresh quote so legacy rowFields
    // fall-back behaviour (catalog defaults) is exercised by tests.
    _isFreshQuote:true,
    draft:false, specsLayout:'grid', _uiCatOpen:{}, _uiPickerOpen:{}, areaOverrides:{},
    quoteId:'X', createdAt:'2026-05-04',
  }, null);
} catch(e){ console.error("renderQuote bootstrap err:", e.message); }

// SNIPPET will be appended here:
"""
    full = shim + "\n" + snippet
    with tempfile.TemporaryDirectory() as td:
        sp = os.path.join(td, "shim.js")
        with open(sp, "w") as f: f.write(full)
        proc = subprocess.run(
            ["node", sp, str(QB / "app/quote.js"), args_json, catalog_json],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"node shim rc={proc.returncode}\nSTDERR: {proc.stderr}\nSTDOUT: {proc.stdout[:500]}")
        return proc.stdout.strip()


def test_quote_valid_until_60_days():
    out = _node_eval("process.stdout.write(quoteValidUntil('2026-05-04', 60));")
    assert out == "03 Jul 2026", f"Expected '03 Jul 2026', got {out!r}"


def test_quote_valid_until_default_arg():
    """Default 2nd arg should be 60 — matches Phase 6.1 spec."""
    out = _node_eval("process.stdout.write(quoteValidUntil('2026-01-01'));")
    # 1 Jan + 60 days = 2 Mar (2026 is not leap)
    assert out == "02 Mar 2026", f"Expected '02 Mar 2026' (default 60d), got {out!r}"


def test_quote_valid_until_handles_bad_input():
    out = _node_eval("process.stdout.write(JSON.stringify([quoteValidUntil(''), quoteValidUntil(null), quoteValidUntil('garbage')]));")
    arr = json.loads(out)
    assert arr == ["", "", ""], arr


def test_cover_emits_validity_line():
    """Cover-bot block must contain the cover-validity p tag."""
    assert '<p class="cover-validity">' in QUOTE_JS, "Cover validity line not emitted"
    assert "quoteValidUntil(state.createdAt, 60)" in QUOTE_JS
    # And the styling must exist.
    assert ".cover-validity" in QUOTE_JS, "cover-validity CSS not defined"
    assert "font-style: italic" in QUOTE_JS  # broad — at least one italic somewhere


# ----------------------------------------------------------------------------
# Item 11b: rate column rename + rowFields behaviour
# ----------------------------------------------------------------------------
def test_table_header_renamed_to_rate():
    assert '<th class="br">Rate</th>' in QUOTE_JS, "Table header not renamed to 'Rate'"
    assert '<th class="br">Brand &amp; Rate</th>' not in QUOTE_JS, \
        "Old 'Brand & Rate' header still present"


def test_rowfields_rate_only_no_brand_in_rate_column():
    """rowFields() with no o.brand_rate, no o.rate, but it.brands set →
       brandRate must be empty string (no brand prefix), and brand info migrates
       into description."""
    snippet = r"""
const it = { label: 'X', brands: ['Asian Paints', 'Berger'], description: 'Two coats.', rate: 0, rate_text: '' };
const row = { id: 'foo', override: {} };
const f = global.rowFields(row, it);
process.stdout.write(JSON.stringify(f));
"""
    out = _node_eval(snippet)
    f = json.loads(out)
    # Rate column must NOT contain brand strings.
    assert 'Asian Paints' not in f['brandRate'], f"Brand leaked into rate column: {f['brandRate']!r}"
    assert 'Berger' not in f['brandRate']
    # With no rate set, rate column is empty.
    assert f['brandRate'] == '', f"Expected empty rate, got {f['brandRate']!r}"
    # Brand info should now live in description.
    assert 'Brands:' in f['desc']
    assert 'Asian Paints' in f['desc']
    assert 'Two coats.' in f['desc']


def test_rowfields_user_brand_rate_passthrough_for_compat():
    """Saved quote with `o.brand_rate` typed by old UI must still display in
       the rate column (back-compat)."""
    snippet = r"""
const it = { label: 'X', brands: ['Asian Paints'], description: '', rate: 0, rate_text: '' };
const row = { override: { brand_rate: 'Asian Paints Apex Ultima · ₹350/sqft' } };
const f = global.rowFields(row, it);
process.stdout.write(JSON.stringify(f));
"""
    out = _node_eval(snippet)
    f = json.loads(out)
    assert f['brandRate'] == 'Asian Paints Apex Ultima · ₹350/sqft', \
        f"Legacy brand_rate not preserved: {f['brandRate']!r}"


def test_rowfields_user_description_override_wins():
    """If rep typed a custom description, brand prefix must NOT be auto-added."""
    snippet = r"""
const it = { label: 'X', brands: ['BrandA'], description: 'Default desc', rate: 0, rate_text: '' };
const row = { override: { description: 'Rep said this exact thing.' } };
const f = global.rowFields(row, it);
process.stdout.write(JSON.stringify(f));
"""
    out = _node_eval(snippet)
    f = json.loads(out)
    assert f['desc'] == 'Rep said this exact thing.'
    assert 'BrandA' not in f['desc']


def test_rowfields_rate_only_when_rate_is_numeric():
    """No brand_rate, but it.rate > 0 → rate column shows fmtINR(rate), no brand."""
    snippet = r"""
const it = { label: 'X', brands: ['BrandA'], description: 'd', rate: 0, rate_text: '' };
const row = { override: { rate: 350 } };
const f = global.rowFields(row, it);
process.stdout.write(JSON.stringify(f));
"""
    out = _node_eval(snippet)
    f = json.loads(out)
    assert 'BrandA' not in f['brandRate']
    # fmtINR(350) → "₹350"
    assert '₹' in f['brandRate'] and '350' in f['brandRate']


if __name__ == "__main__":
    import traceback
    fns = [k for k in list(globals().keys()) if k.startswith("test_")]
    failed = 0
    for n in fns:
        try:
            globals()[n]()
            print(f"  ✅ {n}")
        except Exception as e:
            failed += 1
            print(f"  ❌ {n}: {e}")
            traceback.print_exc()
    if failed:
        sys.exit(1)
    print(f"\nAll {len(fns)} tests passed")
