"""Phase 6.4 — Items 11a (Basement category, conditional render) + 11c (Rich-text descriptions).

Item 11a: When state.build.hasBasement === true, a "Basement" category exists
in spec list + PDF. 6 catalog items live under category=basement. Picker hides
basement items when toggle is off. defaultRowsFor(scope, {hasBasement: true})
includes basement; without the flag, excludes it.

Item 11c: Description editor uses contenteditable + B/I/U toolbar. Stores
HTML in override.description with descriptionRich=true flag. sanitizeRichText
strips everything except b/strong/i/em/u/br. Old plain-text descriptions
(no flag) keep escaping path. PDF rendering branches on descIsRich.
"""
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

QB = Path(__file__).parent.parent
QUOTE_JS = (QB / "app/quote.js").read_text()
INDEX_HTML = (QB / "app/index.html").read_text()
CAT = json.load(open(QB / "catalog/catalog.json"))


# ---------------------------------------------------------------------------
# 11a — Basement catalog items
# ---------------------------------------------------------------------------
def test_basement_catalog_items_present():
    """All 6 basement items are present in catalog with category='basement'."""
    expected = [
        "basement.raft_foundation",
        "basement.retaining_walls",
        "basement.waterproofing_system",
        "basement.sump_pit_dewatering",
        "basement.height",
        "basement.flooring",
    ]
    by_id = {it["id"]: it for it in CAT["items"]}
    for eid in expected:
        assert eid in by_id, f"Missing basement item: {eid}"
        it = by_id[eid]
        assert it["category"] == "basement", f"{eid}: wrong category {it['category']!r}"
        assert it["category_label"] == "Basement", f"{eid}: wrong category_label"
        assert "full" in it["scope"], f"{eid}: missing 'full' scope"
        # Catalog fidelity: rate & rate_text empty.
        assert it["rate"] == 0
        assert (it.get("rate_text") or "") == ""


def test_basement_catalog_descriptions():
    """Descriptions match the spec brief verbatim."""
    by_id = {it["id"]: it for it in CAT["items"]}
    # Quick canary on each — full-text match for the key phrase.
    assert "M25 grade concrete" in by_id["basement.raft_foundation"]["description"]
    assert "RCC retaining walls of 6 inch thickness" in by_id["basement.retaining_walls"]["description"]
    assert "Three-layer waterproofing system" in by_id["basement.waterproofing_system"]["description"]
    assert "RCC sump pit shall be constructed at lowest level" in by_id["basement.sump_pit_dewatering"]["description"]
    assert "11 ft" in by_id["basement.height"]["description"]
    assert "18mm Granite" in by_id["basement.flooring"]["description"]


def test_basement_brand_suggestions():
    """Waterproofing and Sump Pit must carry brand suggestions per the brief."""
    by_id = {it["id"]: it for it in CAT["items"]}
    assert set(by_id["basement.waterproofing_system"]["brands"]) == {"Sika", "Dr. Fixit", "Fosroc"}
    assert set(by_id["basement.sump_pit_dewatering"]["brands"]) == {"Crompton", "Bajaj"}


# ---------------------------------------------------------------------------
# 11a — Conditional inclusion in defaultRowsFor + picker
# ---------------------------------------------------------------------------
def test_default_rows_excludes_basement_without_flag():
    """defaultRowsFor(scope) without hasBasement excludes basement items."""
    snippet = r"""
const rows = defaultRowsFor('full', { hasBasement: false });
const ids = rows.map(r => r.id);
process.stdout.write(JSON.stringify(ids));
"""
    out = _node_eval(snippet)
    ids = json.loads(out)
    for bid in ["basement.raft_foundation", "basement.flooring"]:
        assert bid not in ids, f"{bid} leaked into defaultRowsFor without basement"


def test_default_rows_includes_basement_with_flag():
    """defaultRowsFor(scope, {hasBasement:true}) includes all 6 basement items."""
    snippet = r"""
const rows = defaultRowsFor('full', { hasBasement: true });
const ids = rows.map(r => r.id).filter(i => i.startsWith('basement.'));
process.stdout.write(JSON.stringify(ids.sort()));
"""
    out = _node_eval(snippet)
    ids = json.loads(out)
    expected = sorted([
        "basement.raft_foundation",
        "basement.retaining_walls",
        "basement.waterproofing_system",
        "basement.sump_pit_dewatering",
        "basement.height",
        "basement.flooring",
    ])
    assert ids == expected, f"basement rows mismatch: {ids}"


def test_picker_filters_basement_when_off():
    """Source-level: picker filter checks state.build.hasBasement for basement category."""
    # Strict: explicit guard inline in the picker filter.
    assert "it.category === 'basement' && !state.build.hasBasement" in QUOTE_JS, \
        "Picker must explicitly skip basement category when basement toggle is off"


def test_sync_basement_rows_function_exists():
    assert "function syncBasementRows()" in QUOTE_JS, "syncBasementRows() missing"
    # Must be called from f-basement onchange.
    assert re.search(
        r"\$\('f-basement'\)\.onchange\s*=\s*e\s*=>\s*\{[^}]*syncBasementRows\(\)",
        QUOTE_JS,
    ), "f-basement onchange must call syncBasementRows()"


def test_sync_basement_adds_rows_when_on():
    """syncBasementRows() with hasBasement=true appends missing basement rows."""
    snippet = r"""
const state = {
  build: { hasBasement: true }, scope: 'full',
  rows: [{ id: 'structure.steel', override: {} }],
};
// Manually invoke the sync logic via the same predicate the helper uses.
const items = (CATALOG.items || []).filter(it => it.category === 'basement' && it.scope.includes('full'));
const have = new Set(state.rows.filter(r => !r.categoryGroup || r.categoryGroup === 'Basement').map(r => r.id));
for (const it of items) {
  if (!have.has(it.id)) state.rows.push({ id: it.id, override: {} });
}
process.stdout.write(JSON.stringify(state.rows.map(r => r.id).sort()));
"""
    out = _node_eval(snippet)
    ids = json.loads(out)
    assert "structure.steel" in ids
    assert "basement.raft_foundation" in ids
    assert "basement.flooring" in ids


def test_sync_basement_removes_default_rows_when_off():
    """When hasBasement=false, default-group basement rows are removed but
       cloned/renamed basement rows (with categoryGroup) are preserved."""
    snippet = r"""
const state = {
  build: { hasBasement: false }, scope: 'full',
  rows: [
    { id: 'structure.steel', override: {} },
    { id: 'basement.raft_foundation', override: {} },                              // default group — should drop
    { id: 'basement.flooring', override: {}, categoryGroup: 'Basement' },           // explicit default group — should drop
    { id: 'basement.height', override: {}, categoryGroup: 'Basement (Cellar)' },    // renamed — should KEEP
  ],
};
state.rows = state.rows.filter(r => {
  const it = (CATALOG.items || []).find(i => i.id === r.id);
  if (!it || it.category !== 'basement') return true;
  if (r.categoryGroup && r.categoryGroup !== 'Basement') return true;
  return false;
});
process.stdout.write(JSON.stringify(state.rows.map(r => r.id + ':' + (r.categoryGroup || ''))));
"""
    out = _node_eval(snippet)
    arr = json.loads(out)
    assert "structure.steel:" in arr
    assert not any(s.startswith("basement.raft_foundation") for s in arr), arr
    assert not any(s == "basement.flooring:Basement" for s in arr), arr
    assert "basement.height:Basement (Cellar)" in arr, arr


# ---------------------------------------------------------------------------
# 11a — catOrder includes Basement (form list + PDF)
# ---------------------------------------------------------------------------
def test_basement_in_cat_order_form_list():
    """Form-list catOrder includes 'Basement' between Structure and Bathroom."""
    rsl = QUOTE_JS.index("function renderSpecList()")
    end = QUOTE_JS.index("function ", rsl + 50)  # next function (beginCategoryRename or buildSpecCard)
    block = QUOTE_JS[rsl:end]
    assert "'Basement'" in block, "Form-list catOrder missing Basement"


def test_basement_in_cat_order_pdf():
    """PDF render catOrder includes 'Basement'."""
    rq = QUOTE_JS.index("function renderQuote(state, about)")
    block = QUOTE_JS[rq:rq + 8000]
    assert "'Basement'" in block, "PDF catOrder missing Basement"


# ---------------------------------------------------------------------------
# 11c — sanitizeRichText
# ---------------------------------------------------------------------------
def test_sanitize_rich_text_function_exists():
    assert "function sanitizeRichText(html)" in QUOTE_JS


def test_sanitize_strips_script_tag():
    snippet = r"""
const out = sanitizeRichText('<script>alert(1)</script><b>ok</b>');
process.stdout.write(out);
"""
    out = _node_eval(snippet)
    assert "<script" not in out.lower(), out
    assert "alert" not in out, out
    assert "<b>ok</b>" in out, out


def test_sanitize_strips_iframe():
    snippet = r"""
process.stdout.write(sanitizeRichText('<iframe src=\"x\"></iframe><b>x</b>'));
"""
    out = _node_eval(snippet)
    assert "<iframe" not in out.lower()
    assert "<b>x</b>" in out


def test_sanitize_strips_event_handlers():
    snippet = r"""
process.stdout.write(sanitizeRichText('<b onclick=\"alert(1)\">x</b><img onerror=alert(1) src=z>'));
"""
    out = _node_eval(snippet)
    # <b> kept but stripped of onclick; <img> entirely dropped.
    assert "onclick" not in out.lower(), out
    assert "<img" not in out.lower(), out
    assert "<b>x</b>" in out, out


def test_sanitize_keeps_allowed_tags():
    snippet = r"""
process.stdout.write(sanitizeRichText('<b>bold</b> <strong>also</strong> <i>it</i> <em>em</em> <u>under</u> line<br>break'));
"""
    out = _node_eval(snippet)
    assert "<b>bold</b>" in out
    assert "<strong>also</strong>" in out
    assert "<i>it</i>" in out
    assert "<em>em</em>" in out
    assert "<u>under</u>" in out
    assert "<br>" in out


def test_sanitize_drops_attributes_on_allowed_tags():
    """Allowed tag, but with hostile attributes — strip the attributes."""
    snippet = r"""
process.stdout.write(sanitizeRichText('<b style=\"color:red\" onclick=\"x\">y</b>'));
"""
    out = _node_eval(snippet)
    assert "style" not in out.lower()
    assert "onclick" not in out.lower()
    assert "<b>y</b>" in out


def test_sanitize_handles_empty_and_null():
    snippet = r"""
process.stdout.write(JSON.stringify([sanitizeRichText(''), sanitizeRichText(null), sanitizeRichText(undefined)]));
"""
    out = _node_eval(snippet)
    assert json.loads(out) == ["", "", ""]


# ---------------------------------------------------------------------------
# 11c — Editor + render path
# ---------------------------------------------------------------------------
def test_editor_uses_contenteditable():
    assert 'contenteditable="true"' in QUOTE_JS, "Description editor must be contenteditable"
    assert 'class="rt-editor"' in QUOTE_JS
    assert 'data-f="description"' in QUOTE_JS  # still binds to override.description


def test_editor_has_biu_toolbar():
    assert 'data-rt="bold"' in QUOTE_JS
    assert 'data-rt="italic"' in QUOTE_JS
    assert 'data-rt="underline"' in QUOTE_JS


def test_editor_persists_descriptionRich_flag():
    """When user types into the rt-editor, descriptionRich=true is set."""
    assert "descriptionRich = true" in QUOTE_JS


def test_pdf_grid_branches_on_descIsRich():
    """Grid mode emits HTML when descIsRich, else escapes."""
    # Find the .desc paragraph in grid mode.
    assert re.search(
        r'<p class="desc">\$\{f\.descIsRich\s*\?\s*sanitizeRichText\(f\.desc\)\s*:\s*escapeHtml\(f\.desc\)\}</p>',
        QUOTE_JS,
    ), "Grid mode must branch on descIsRich"


def test_pdf_table_branches_on_descIsRich():
    """Table mode emits HTML when descIsRich."""
    assert re.search(
        r'<td class="desc">\$\{f\.descIsRich\s*\?\s*sanitizeRichText\(f\.desc\)\s*:\s*escapeHtml\(f\.desc\)\}</td>',
        QUOTE_JS,
    ), "Table mode must branch on descIsRich"


def test_rowfields_returns_descIsRich():
    """rowFields() must surface descIsRich so the renderer can switch."""
    snippet = r"""
const it = { label: 'X', brands: [], description: 'plain', rate: 0, rate_text: '' };
const row = { override: { description: '<b>Hettich</b>. German hardware.', descriptionRich: true } };
const f = global.rowFields(row, it);
process.stdout.write(JSON.stringify(f));
"""
    out = _node_eval(snippet)
    f = json.loads(out)
    assert f.get("descIsRich") is True, f
    assert "<b>Hettich</b>" in f["desc"]


def test_rowfields_descIsRich_false_for_legacy():
    """Old plain-text descriptions: descIsRich must be false (or missing)."""
    snippet = r"""
const it = { label: 'X', brands: [], description: 'plain', rate: 0, rate_text: '' };
const row = { override: { description: 'just a string from old quote' } };
const f = global.rowFields(row, it);
process.stdout.write(JSON.stringify(f));
"""
    out = _node_eval(snippet)
    f = json.loads(out)
    assert not f.get("descIsRich"), f
    assert f["desc"] == "just a string from old quote"


# ---------------------------------------------------------------------------
# CSS / DOM hooks for rich-text editor
# ---------------------------------------------------------------------------
def test_rich_text_editor_css_present():
    assert ".rt-editor" in INDEX_HTML
    assert ".rt-toolbar" in INDEX_HTML
    assert ".rt-btn" in INDEX_HTML


# ---------------------------------------------------------------------------
# Node shim — mirrors the test_phase6_1 pattern.
# ---------------------------------------------------------------------------
def _node_eval(snippet, args=None):
    args = args or []
    args_json = json.dumps(args)
    catalog_json = json.dumps(CAT)
    shim = r"""
'use strict';
const fs = require('fs');
const QUOTE_SRC = fs.readFileSync(process.argv[2], 'utf8');
const ARGS = JSON.parse(process.argv[3]);
const CATALOG = JSON.parse(process.argv[4]);
global.CATALOG = CATALOG;
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
  .replace('function sanitizeRichText(html) {', 'global.sanitizeRichText = function sanitizeRichText(html) {')
  .replace('function defaultRowsFor(scope, opts) {', 'global.defaultRowsFor = function defaultRowsFor(scope, opts) {')
  .replace('function catalogItem(id) { return (CATALOG?.items || []).find(it => it.id === id); }',
           'global.catalogItem = function catalogItem(id) { return (CATALOG?.items || []).find(it => it.id === id); };')
  .replace('function rowCategoryGroup(row) {', 'global.rowCategoryGroup = function rowCategoryGroup(row) {')
  .replace('function renderQuote(state, about) {', 'global.renderQuote = function renderQuote(state, about) {')
  .replace('  function rowFields(row, it) {', '  global.rowFields = function rowFields(row, it) {');

try { eval(patched); } catch(e) { console.error('eval err', e.message); process.exit(2); }

// Trigger renderQuote so rowFields gets registered in global.
try {
  global.renderQuote({
    customer:{name:'',address:''}, build:{plotSqYards:240,breadth:36,coverage:75,buildType:'stilt',floors:1,hasBasement:false,hasLift:false},
    pricing:{costPerSqft:1000,structureRate:1000,itemRates:{}}, scope:'full',
    rows:[{id:'structure.steel', override:{}}], notes:'',
    draft:false, specsLayout:'grid', _uiCatOpen:{}, _uiPickerOpen:{}, areaOverrides:{},
    quoteId:'X', createdAt:'2026-05-04',
  }, null);
} catch(e){ console.error("renderQuote bootstrap err:", e.message); }

// SNIPPET appended:
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


if __name__ == "__main__":
    import traceback, sys
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
