"""Phase 6.2 — Per-floor balcony pricing + Floor area summary table.

Two-feature lockdown:
  Item 7 — Per-floor balcony pricing
    - balcony_per_floor_off_unchanged: toggle off → grand total identical to baseline
    - balcony_per_floor_on: toggle on, varied rates → calc = Σ(balconyPerFloor × floorRate)
    - balcony_per_floor_collapse_pdf: all rates equal → PDF renders ONE Balcony row;
      editor still shows N rows (state holds N items).
    - balcony_per_floor_blank_falls_back: blank rates fall back to Zone B default
    - balcony_per_floor_zone_sum_invariant: zone.cost == Σ(items.cost)

  Item 8 — Floor Area Summary table
    - floor_summary_rows_full: basement+stilt+4 floors → Basement, Stilt, F1..F4, Terrace, Total
    - floor_summary_totals: column sums equal totals row
    - floor_summary_no_basement: no Basement row
    - floor_summary_no_stilt: nostilt mode → no Stilt row
    - floor_summary_structure: structure mode renders without errors
    - render_floor_summary_table_in_area_page: HTML contains the table block
    - state_shape_default_off: defaultState exposes balconyPerFloor.{enabled:false, rates:[]}
    - index_html_has_toggle: index.html has #f-bpf-on + #bpf-block

Re-uses the Node shim pattern from test_phase6_3.py.
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


# ----------------------------------------------------------------------------
# Source-string sanity (no Node)
# ----------------------------------------------------------------------------
def test_state_shape_default_off():
    """defaultState() exposes balconyPerFloor with enabled:false, rates:[]."""
    m = re.search(
        r"balconyPerFloor:\s*\{\s*enabled:\s*false[^}]*rates:\s*\[\s*\]",
        QUOTE_JS, re.DOTALL,
    )
    assert m, "Expected default-off balconyPerFloor block in defaultState()"


def test_index_html_has_bpf_toggle():
    for el in [
        'id="f-bpf-on"',
        'id="bpf-block"',
        'id="bpf-body"',
        'id="bpf-rate-list"',
    ]:
        assert el in INDEX_HTML, f"index.html missing form element: {el}"


def test_buildFloorSummary_function_present():
    assert "function buildFloorSummary(state, c)" in QUOTE_JS
    assert "function renderFloorSummaryTable(state, c)" in QUOTE_JS


def test_collapse_balcony_for_pdf_present():
    assert "collapseBalconyForPdf" in QUOTE_JS


def test_calc_uses_bpf_rates():
    """calcPackage's enrichZone branches on it.balconyFloor."""
    assert "balconyFloor" in QUOTE_JS
    assert "bpfRates" in QUOTE_JS or "balconyPerFloor" in QUOTE_JS


def test_area_page_renders_floor_summary_first():
    """renderFloorSummaryTable(state, c) is invoked inside the Area page header
    block, BEFORE the existing zone-by-zone tables."""
    # The summary call must appear inside the headerBlock template literal (which
    # comes before the calc-table / zoneRows section).
    pat = re.compile(
        r"\$\{renderFloorSummaryTable\(state,\s*c\)\}.*?"
        r"\$\{zoneRows\('A'",
        re.DOTALL,
    )
    assert pat.search(QUOTE_JS), "Floor summary must render before Zone A rows"


def test_area_page_has_floor_summary_css():
    assert ".floor-summary-table" in QUOTE_JS
    assert ".floor-summary-block" in QUOTE_JS
    assert ".floor-sum-total" in QUOTE_JS


# ----------------------------------------------------------------------------
# Node shim — re-using test_phase6_3 pattern, adds renderQuote + buildFloorSummary
# ----------------------------------------------------------------------------
def _run_node(state, fn="computeQuote"):
    """Run computeQuote(state) or renderQuote(state, null) or buildFloorSummary(state, c)."""
    catalog_json = json.dumps(CAT)
    state_json = json.dumps(state)
    shim = r"""
'use strict';
const QUOTE_SRC = require('fs').readFileSync(process.argv[2], 'utf8');
const CATALOG = JSON.parse(process.argv[3]);
const STATE = JSON.parse(process.argv[4]);
const FN = process.argv[5];

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
global.CATALOG = CATALOG;

const patched = QUOTE_SRC
  .replace("function computeQuote(state) {", "global.computeQuote = function computeQuote(state) {")
  .replace("function applyAreaOverrides(c, state) {", "global.applyAreaOverrides = function applyAreaOverrides(c, state) {")
  .replace("function appendAdditionalZones(c, state) {", "global.appendAdditionalZones = function appendAdditionalZones(c, state) {")
  .replace("function calcPackage(state) {", "global.calcPackage = function calcPackage(state) {")
  .replace("function calcStructure(state) {", "global.calcStructure = function calcStructure(state) {")
  .replace("function buildFloorSummary(state, c) {", "global.buildFloorSummary = function buildFloorSummary(state, c) {")
  .replace("function renderFloorSummaryTable(state, c) {", "global.renderFloorSummaryTable = function renderFloorSummaryTable(state, c) {")
  .replace("function renderAreaPage(state, c) {", "global.renderAreaPage = function renderAreaPage(state, c) {")
  .replace("function renderCostPage(state, c) {", "global.renderCostPage = function renderCostPage(state, c) {");

try { eval(patched); } catch(e) { console.error('eval err', e.message); process.exit(2); }

let result;
if (FN === 'computeQuote') {
  result = computeQuote(STATE);
} else if (FN === 'buildFloorSummary') {
  const c = computeQuote(STATE);
  result = buildFloorSummary(STATE, c);
} else if (FN === 'renderArea') {
  const c = computeQuote(STATE);
  result = { html: renderAreaPage(STATE, c), c };
} else if (FN === 'renderCost') {
  const c = computeQuote(STATE);
  result = { html: renderCostPage(STATE, c), c };
} else { result = null; }
process.stdout.write(JSON.stringify(result));
"""
    with tempfile.TemporaryDirectory() as td:
        sp = os.path.join(td, "shim.js")
        with open(sp, "w") as f:
            f.write(shim)
        proc = subprocess.run(
            ["node", sp, str(QB / "app/quote.js"), catalog_json, state_json, fn],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"shim rc={proc.returncode}\nSTDERR: {proc.stderr}\nSTDOUT: {proc.stdout[:500]}"
            )
        return json.loads(proc.stdout)


def _state(buildType="stilt", floors=4, hasBasement=False, hasLift=False,
           costPerSqft=2000, structureRate=1500,
           bpf=None,
           plotSqYards=240, breadth=36, coverage=75):
    bpf_block = {"enabled": False, "rates": []}
    if bpf is not None:
        bpf_block = {**bpf_block, **bpf}
    return {
        "customer": {"salutation": "", "name": "T", "address": ""},
        "build": {
            "plotSqYards": plotSqYards, "breadth": breadth, "coverage": coverage,
            "buildType": buildType, "floors": floors,
            "hasBasement": hasBasement, "hasLift": hasLift,
        },
        "pricing": {
            "costPerSqft": costPerSqft, "structureRate": structureRate,
            "zoneARate": None, "zoneBRate": None, "zoneCRate": None,
            "zoneDRate": None, "basementRate": None,
            "itemRates": {}, "liftCost": None,
            "additionalZones": {
                "elevation": {"enabled": False, "desc": "", "cost": 0},
                "gst":       {"enabled": False, "desc": "", "cost": 0},
                "custom":    {"enabled": False, "name": "", "desc": "", "cost": 0},
            },
            "balconyPerFloor": bpf_block,
        },
        "scope": "structure_only" if buildType == "structure" else "full",
        "rows": [], "notes": "", "draft": False,
        "specsLayout": "grid",
        "_uiCatOpen": {}, "_uiPickerOpen": {},
        "areaOverrides": {},
        "quoteId": "ZUI-2026-TEST",
        "createdAt": "2026-05-04",
    }


# ============================================================================
# Item 7 — Per-floor balcony pricing
# ============================================================================
def test_balcony_per_floor_off_unchanged():
    """Toggle off → grand total identical to a baseline state with no bpf field."""
    base = _run_node(_state())
    s_off = _state(bpf={"enabled": False, "rates": [3000, 4000, 5000, 6000]})  # rates ignored
    c = _run_node(s_off)
    assert c["grandTotal"] == base["grandTotal"], (
        f"toggle-off must not change total: {c['grandTotal']} vs {base['grandTotal']}"
    )
    # Zone B should have ONE Balcony row (combined).
    balcony_rows = [it for it in c["zones"]["B"]["items"] if "Balcony" in it["name"]]
    assert len(balcony_rows) == 1
    assert balcony_rows[0]["name"] == "Balcony"


def test_balcony_per_floor_on_varied_rates():
    """Toggle on, varied rates per floor → balcony cost = Σ(balconyPerFloor × floorRate)."""
    rates = [800, 900, 1000, 1100]
    s = _state(bpf={"enabled": True, "rates": rates})
    c = _run_node(s)
    # breadth=36 × BALCONY_DEPTH=5 = 180 sq.ft per floor.
    bpf_area = 36 * 5
    expected = sum(bpf_area * r for r in rates)
    bpf_items = [it for it in c["zones"]["B"]["items"] if it.get("balconyFloor") is not None or it["name"].startswith("Balcony — ")]
    assert len(bpf_items) == 4, f"expected 4 per-floor balcony rows, got {len(bpf_items)}"
    actual = sum(it["cost"] for it in bpf_items)
    assert actual == expected, f"per-floor cost mismatch: {actual} vs {expected}"


def test_balcony_per_floor_blank_falls_back_to_zone_b():
    """Blank/null cells fall back to Zone B default. Total still well-defined."""
    # costPerSqft=2000 → Zone B default = 1000.
    rates = [1500, None, None, 1500]
    s = _state(bpf={"enabled": True, "rates": rates})
    c = _run_node(s)
    bpf_area = 36 * 5
    expected = bpf_area * (1500 + 1000 + 1000 + 1500)
    bpf_items = [it for it in c["zones"]["B"]["items"] if it["name"].startswith("Balcony — ")]
    actual = sum(it["cost"] for it in bpf_items)
    assert actual == expected, f"fallback math mismatch: {actual} vs {expected}"


def test_balcony_per_floor_zone_sum_invariant():
    """Phase 5 invariant: zone.cost == Σ(item.cost) for Zone B with per-floor balcony."""
    s = _state(bpf={"enabled": True, "rates": [800, 900, 1000, 1100]})
    c = _run_node(s)
    z = c["zones"]["B"]
    items_sum = sum(it["cost"] for it in z["items"])
    assert items_sum == z["cost"], f"zone-sum invariant broken: items={items_sum} zone={z['cost']}"


def test_balcony_per_floor_collapse_pdf_when_equal():
    """All per-floor rates equal → PDF cost-page collapses to ONE 'Balcony' row.
    Editor (calc result) still has N rows."""
    rates = [1200, 1200, 1200, 1200]  # all equal, all == zone B default? No — default = 1000.
    s = _state(bpf={"enabled": True, "rates": rates})
    rendered = _run_node(s, fn="renderCost")
    html = rendered["html"]
    c = rendered["c"]
    # Editor side: 4 per-floor items in the calc result.
    bpf_items = [it for it in c["zones"]["B"]["items"] if it["name"].startswith("Balcony — ")]
    assert len(bpf_items) == 4, "calc result must keep 4 per-floor items"
    # PDF side: only ONE "Balcony" mention in the cost-page rendering for Zone B.
    # Look for the per-floor row labels (— Balcony — Floor X) — should NOT appear.
    assert "Balcony — Floor 1" not in html, "PDF must collapse — no per-floor labels expected"
    assert "Balcony — Floor 2" not in html
    # The combined "Balcony" row must be present in the PDF — exactly ONE
    # mention as a per-item label in the cost-page (since rate differs from
    # zone default, it renders inside the varies-mode "per-item rates" block).
    # Count: only one "— Balcony" label (no "— Balcony — Floor X" entries).
    plain_balcony_count = html.count("— Balcony</td>")
    assert plain_balcony_count == 1, (
        f"PDF should have ONE collapsed Balcony row; got {plain_balcony_count}.\n"
        f"Per-floor labels: {[s for s in ['Floor 1','Floor 2','Floor 3','Floor 4'] if s in html]}"
    )
    # Combined area = 4 × 180 = 720 must appear next to the collapsed Balcony row.
    assert "720" in html, "Combined balcony area (720 sq.ft) should appear in the row"



def test_balcony_per_floor_no_collapse_when_varied():
    """When per-floor rates differ, PDF expands per-item rows (no collapse)."""
    s = _state(bpf={"enabled": True, "rates": [800, 900, 1000, 1100]})
    rendered = _run_node(s, fn="renderCost")
    html = rendered["html"]
    # All 4 floors must appear in the PDF cost page.
    for fn in ("Balcony — Floor 1", "Balcony — Floor 2", "Balcony — Floor 3", "Balcony — Floor 4"):
        assert fn in html, f"varied rates: PDF must include {fn}"


def test_balcony_per_floor_resize_when_floors_change():
    """When floors=3, the calc still emits 3 balcony rows (irrespective of rates length).
    The state-side resize is an editor concern — the calc just uses indices 0..numFloors-1."""
    s = _state(floors=3, bpf={"enabled": True, "rates": [800, 900, 1000, 1100]})  # 4 entries, only 3 used
    c = _run_node(s)
    bpf_items = [it for it in c["zones"]["B"]["items"] if it["name"].startswith("Balcony — ")]
    assert len(bpf_items) == 3
    # Sum cost should match first 3 rates only.
    bpf_area = 36 * 5
    expected = bpf_area * (800 + 900 + 1000)
    actual = sum(it["cost"] for it in bpf_items)
    assert actual == expected


# ============================================================================
# Item 8 — Floor Area Summary
# ============================================================================
def test_floor_summary_full_basement_stilt_4_floors():
    """Basement + stilt + 4 floors → rows: Basement, Stilt, F1..F4, Terrace, Total = 8 rows."""
    s = _state(hasBasement=True, hasLift=True, floors=4)
    rows = _run_node(s, fn="buildFloorSummary")
    # 1 basement + 1 stilt + 4 floors + 1 terrace + 1 total = 8
    assert len(rows) == 8, f"got {len(rows)} rows: {[r['label'] for r in rows]}"
    labels = [r["label"] for r in rows]
    assert labels[0] == "Basement"
    assert labels[1] == "Stilt"
    assert labels[2] == "1st Floor"
    assert labels[5] == "4th Floor"
    assert labels[6] == "Terrace"
    assert labels[7] == "Total"
    assert rows[-1]["isTotal"] is True


def test_floor_summary_totals_match_column_sums():
    """The Total row's column values equal the sum of the body rows."""
    s = _state(hasBasement=True, hasLift=True, floors=4)
    rows = _run_node(s, fn="buildFloorSummary")
    body = [r for r in rows if not r.get("isTotal")]
    total = rows[-1]
    for col in ("liftStair", "covered", "semiCovered", "open"):
        body_sum = sum(r[col] for r in body)
        assert body_sum == total[col], (
            f"column {col}: body sum={body_sum} totals={total[col]}"
        )


def test_floor_summary_no_basement():
    """Without basement → no Basement row."""
    s = _state(hasBasement=False, floors=4)
    rows = _run_node(s, fn="buildFloorSummary")
    labels = [r["label"] for r in rows]
    assert "Basement" not in labels
    # stilt + 4 + terrace + total = 7
    assert len(rows) == 7


def test_floor_summary_no_stilt():
    """Build mode 'nostilt' → no Stilt row."""
    s = _state(buildType="nostilt", hasBasement=False, floors=4)
    rows = _run_node(s, fn="buildFloorSummary")
    labels = [r["label"] for r in rows]
    assert "Stilt" not in labels
    # 4 floors + terrace + total = 6
    assert len(rows) == 6


def test_floor_summary_structure_mode():
    """Structure mode renders without errors and includes Stilt (always)."""
    s = _state(buildType="structure", hasBasement=False, floors=3)
    rows = _run_node(s, fn="buildFloorSummary")
    labels = [r["label"] for r in rows]
    assert "Stilt" in labels  # structure always has stilt
    # In structure mode, stilt is enclosed → covered, not open.
    stilt = [r for r in rows if r["label"] == "Stilt"][0]
    assert stilt["covered"] > 0
    assert stilt["open"] == 0


def test_render_floor_summary_table_appears_first_in_area_page():
    """The HTML emitted by renderAreaPage contains the floor-summary-block,
    appearing BEFORE the calc-table that holds zone rows."""
    s = _state(hasBasement=True, hasLift=True, floors=4)
    rendered = _run_node(s, fn="renderArea")
    html = rendered["html"]
    assert "floor-summary-block" in html
    assert "Floor Area Summary" in html
    assert "Plot Area —" in html
    # Must appear before the first occurrence of "calc-table".
    summary_pos = html.index("floor-summary-block")
    calc_pos = html.index("calc-table")
    assert summary_pos < calc_pos, "summary must come before zone tables"


def test_render_floor_summary_5_columns():
    """Headers are: Floor / Lift & Staircase / Covered / Semi Covered / Open."""
    s = _state(hasBasement=True, hasLift=True, floors=4)
    rendered = _run_node(s, fn="renderArea")
    html = rendered["html"]
    # Column headers (text inside <th>).
    assert ">Floor</th>" in html
    assert "Lift &amp; Staircase" in html or "Lift & Staircase" in html
    assert "Covered Area" in html
    assert "Semi Covered" in html
    assert "Open Area" in html


def test_render_floor_summary_totals_row_styled():
    """Totals row uses .floor-sum-total class (gold-tint top border)."""
    s = _state(hasBasement=True, hasLift=True, floors=4)
    rendered = _run_node(s, fn="renderArea")
    html = rendered["html"]
    assert "floor-sum-total" in html


def test_premium_package_label_in_full_mode():
    """Full-build mode rows carry '(Premium Package)' sublabel."""
    s = _state(hasBasement=False, hasLift=True, floors=4)
    rows = _run_node(s, fn="buildFloorSummary")
    floor_rows = [r for r in rows if r["label"].endswith("Floor") and not r.get("isTotal")]
    assert len(floor_rows) == 4
    for r in floor_rows:
        if r["label"] != "Terrace":
            assert r["sublabel"] == "Premium Package"


def test_terrace_labelled_mumty():
    """Terrace row has 'Mumty' sublabel (rooftop access mention)."""
    s = _state(floors=4)
    rows = _run_node(s, fn="buildFloorSummary")
    terrace = [r for r in rows if r["label"] == "Terrace"][0]
    assert terrace["sublabel"] == "Mumty"


def test_balcony_per_floor_does_not_break_invariant_with_basement():
    """Combo: basement + per-floor balcony with varied rates. zoneSubtotal still
    equals Σ(zone.cost) and each zone.cost == Σ(item.cost)."""
    s = _state(hasBasement=True, hasLift=True, floors=4,
               bpf={"enabled": True, "rates": [800, 900, 1000, 1100]})
    c = _run_node(s)
    subtotal_from_zones = 0
    for k in ("A", "B", "C", "D", "E"):
        z = c["zones"].get(k)
        if not z:
            continue
        items_sum = sum(it["cost"] for it in z["items"])
        assert items_sum == z["cost"], (
            f"zone {k}: items_sum={items_sum} cost={z['cost']}"
        )
        subtotal_from_zones += z["cost"]
    assert subtotal_from_zones == c["zoneSubtotal"], (
        f"subtotal mismatch: {subtotal_from_zones} vs {c['zoneSubtotal']}"
    )
