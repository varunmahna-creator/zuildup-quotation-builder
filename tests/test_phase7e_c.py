"""Phase 7E-C — sales feedback batch C, feature work (items 5, 7, 11).

Items:
5.  Inline editable description in area-overrides panel: replaces the
    prompt()-based 📝 button with always-visible <input data-desc-key>.
    Reuses state.pricing.itemDescOverrides from 7B-17 (no new map).
7.  Per-floor attribution for Zone A line items: zoneLineItems entries
    can carry a `floor` field. buildFloorSummary adds the area to that
    row's Covered column. UI: <select data-li-field="floor"> on Zone A
    line-item editor rows.
11. Editable floor summary: new fieldset (#floor-summary-fs) with
    per-row label + 4 numeric overrides. New state map
    state.pricing.floorSummaryOverrides keyed by row label.
    buildFloorSummary applies overrides as a final pass.
"""
import json
import subprocess
import tempfile
from pathlib import Path

QB = Path(__file__).parent.parent
QUOTE_JS = (QB / "app/quote.js").read_text()
INDEX_HTML = (QB / "app/index.html").read_text()
CAT = json.load(open(QB / "catalog/catalog.json"))


def _run_node(state, fn="buildFloorSummary"):
    catalog_json = json.dumps(CAT)
    state_json = json.dumps(state) if state is not None else "null"
    shim = r"""
'use strict';
const QUOTE_SRC = require('fs').readFileSync(process.argv[2], 'utf8');
const CATALOG = JSON.parse(process.argv[3]);
const STATE = JSON.parse(process.argv[4]);
const FN = process.argv[5];

global.window = {};
global.document = { getElementById: () => null };
global.localStorage = { _s:{}, getItem(){return null;}, setItem(){}, removeItem(){}, key(){return null;}, get length(){return 0;} };
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
  .replace("function appendZoneLineItems(c, state) {", "global.appendZoneLineItems = function appendZoneLineItems(c, state) {")
  .replace("function calcPackage(state) {", "global.calcPackage = function calcPackage(state) {")
  .replace("function calcStructure(state) {", "global.calcStructure = function calcStructure(state) {")
  .replace("function buildFloorSummary(state, c) {", "global.buildFloorSummary = function buildFloorSummary(state, c) {")
  .replace("function floorOptionsForA(state) {", "global.floorOptionsForA = function floorOptionsForA(state) {")
  .replace("function loadState() {", "global.loadState = function loadState() {");
try { eval(patched); } catch(e) { console.error('eval err', e.message); process.exit(2); }

let out;
if (FN === 'buildFloorSummary') {
  const c = computeQuote(STATE);
  out = buildFloorSummary(STATE, c);
} else if (FN === 'computeQuote') {
  out = computeQuote(STATE);
} else if (FN === 'floorOptionsForA') {
  out = floorOptionsForA(STATE);
} else { out = null; }
process.stdout.write(JSON.stringify(out));
"""
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(shim); shim_path = f.name
    out = subprocess.run(
        ["node", shim_path, str(QB / "app/quote.js"), catalog_json, state_json, fn],
        capture_output=True, text=True, timeout=20,
    )
    if out.returncode != 0:
        raise RuntimeError(f"node shim failed: {out.stderr}")
    return json.loads(out.stdout)


def _state(zoneLineItems=None, floorSummaryOverrides=None, **overrides):
    s = {
        "build": {
            "plotSqYards": 240, "breadth": 36, "coverage": 75,
            "buildType": "stilt", "floors": 4,
            "hasBasement": False, "hasLift": False, "hasWaterTank": True,
        },
        "pricing": {
            "costPerSqft": 1500, "structureRate": 1100, "lift": 0,
            "zoneARate": None, "zoneBRate": None, "zoneCRate": None,
            "zoneDRate": None, "basementRate": None,
            "itemRates": {},
            "additionalZones": {"elevation": {"enabled": False, "desc": "", "cost": 0},
                                 "gst": {"enabled": False, "rate": 18},
                                 "custom": []},
            "balconyPerFloor": {"enabled": False, "rates": []},
            "liftSqftPerLevel": None, "staircaseSqftPerLevel": None,
            "zoneLineItems": zoneLineItems or {},
            "itemNameOverrides": {}, "itemDescOverrides": {},
            "floorSummaryOverrides": floorSummaryOverrides or {},
        },
        "scope": "full", "rows": [], "notes": "", "draft": False,
        "specsLayout": "grid", "_uiCatOpen": {}, "_uiPickerOpen": {},
        "areaOverrides": {}, "quoteId": "",
    }
    s["build"].update({k: v for k, v in overrides.items() if k in s["build"]})
    s["pricing"].update({k: v for k, v in overrides.items() if k in s["pricing"]})
    for k, v in overrides.items():
        if k not in s["build"] and k not in s["pricing"]:
            s[k] = v
    return s


# ============================================================================
# Item 5 — inline desc editor markup + handlers exist
# ============================================================================
def test_inline_desc_input_rendered_in_area_panel():
    # The renderer emits <input data-desc-key="..."> for each static aov row.
    assert 'data-desc-key="${escapeAttr(key)}"' in QUOTE_JS

def test_inline_desc_handler_writes_to_itemDescOverrides():
    needle = "list.querySelectorAll('input[data-desc-key]').forEach(inp =>"
    assert needle in QUOTE_JS
    # And it touches state.pricing.itemDescOverrides.
    assert "state.pricing.itemDescOverrides[key] = val;" in QUOTE_JS

def test_old_redesc_prompt_path_is_noop():
    # 7E-C Item 5: prompt() path replaced with no-op forEach.
    assert "list.querySelectorAll('button[data-redesc-key]').forEach(() => {});" in QUOTE_JS
    # The old prompt() call should be gone.
    assert "window.prompt('Edit description for this item" not in QUOTE_JS


# ============================================================================
# Item 7 — Zone A line items attribute to floor-summary rows
# ============================================================================
def test_floorOptionsForA_basic():
    s = _state(floors=4, buildType="stilt", hasBasement=False)
    opts = _run_node(s, fn="floorOptionsForA")
    # Stilt + Ground/First/Second/Third + Terrace = 6
    assert opts == ["Stilt", "Ground Floor", "First Floor", "Second Floor", "Third Floor", "Terrace"]

def test_floorOptionsForA_with_basement_no_stilt():
    s = _state(floors=3, buildType="nostilt", hasBasement=True)
    opts = _run_node(s, fn="floorOptionsForA")
    assert opts == ["Basement", "Ground Floor", "First Floor", "Second Floor", "Terrace"]

def test_zone_a_line_item_no_floor_does_not_change_summary():
    s = _state(floors=4, zoneLineItems={
        "A": [{"id": "li1", "name": "Pooja Room", "desc": "", "area": 80, "rate": 1500}]
    })
    rows = _run_node(s, fn="buildFloorSummary")
    # Without _floor, the Zone A line item area should not be added to any
    # floor-summary row's covered column.
    ground = next((r for r in rows if r["label"] == "Ground Floor"), None)
    assert ground is not None
    # Default Ground Floor covered = floorAdj = 1620 - 0(no lift) - 125 = 1495.
    assert ground["covered"] == 1495

def test_zone_a_line_item_with_floor_adds_to_covered():
    s = _state(floors=4, zoneLineItems={
        "A": [{"id": "li2", "name": "Pooja Room", "desc": "", "area": 80, "rate": 1500, "floor": "First Floor"}]
    })
    rows = _run_node(s, fn="buildFloorSummary")
    first = next((r for r in rows if r["label"] == "First Floor"), None)
    # 1495 + 80 = 1575
    assert first["covered"] == 1575
    # Other floors unchanged.
    ground = next((r for r in rows if r["label"] == "Ground Floor"), None)
    assert ground["covered"] == 1495

def test_zone_a_line_item_on_terrace_adds_to_terrace_covered():
    s = _state(floors=4, zoneLineItems={
        "A": [{"id": "li3", "name": "Mumty Room", "desc": "", "area": 120, "rate": 1500, "floor": "Terrace"}]
    })
    rows = _run_node(s, fn="buildFloorSummary")
    terr = next((r for r in rows if r["label"] == "Terrace"), None)
    # Terrace covered defaults to 0; +120.
    assert terr["covered"] == 120

def test_zone_a_line_item_totals_reflect_attribution():
    s = _state(floors=4, zoneLineItems={
        "A": [{"id": "li4", "name": "Pooja Room", "desc": "", "area": 80, "rate": 1500, "floor": "Second Floor"}]
    })
    rows = _run_node(s, fn="buildFloorSummary")
    body = [r for r in rows if not r.get("isTotal")]
    total = rows[-1]
    assert total["covered"] == sum(r["covered"] for r in body)
    # And the +80 made it into the total.
    base_state = _state(floors=4)  # no line items
    base_rows = _run_node(base_state)
    base_total = base_rows[-1]
    assert total["covered"] - base_total["covered"] == 80


# ============================================================================
# Item 11 — floor summary overrides
# ============================================================================
def test_floor_summary_label_override_applied():
    s = _state(floors=4, floorSummaryOverrides={
        "Ground Floor": {"label": "Plinth"},
    })
    rows = _run_node(s)
    labels = [r["label"] for r in rows]
    assert "Plinth" in labels
    assert "Ground Floor" not in labels

def test_floor_summary_numeric_override_applied():
    s = _state(floors=4, floorSummaryOverrides={
        "First Floor": {"covered": 1800, "open": 50},
    })
    rows = _run_node(s)
    first = next((r for r in rows if r["label"] == "First Floor"), None)
    assert first is not None
    assert first["covered"] == 1800
    assert first["open"] == 50

def test_floor_summary_total_override_label_and_value():
    s = _state(floors=4, floorSummaryOverrides={
        "Total": {"label": "Grand Total", "covered": 9999},
    })
    rows = _run_node(s)
    total = rows[-1]
    assert total["label"] == "Grand Total"
    assert total["covered"] == 9999

def test_floor_summary_override_does_not_affect_non_overridden_columns():
    s = _state(floors=4, floorSummaryOverrides={
        "First Floor": {"covered": 1800},
    })
    base_rows = _run_node(_state(floors=4))
    rows = _run_node(s)
    base_first = next(r for r in base_rows if r["label"] == "First Floor")
    first = next(r for r in rows if r["label"] == "First Floor")
    # liftStair / semiCovered / open unchanged.
    assert first["liftStair"] == base_first["liftStair"]
    assert first["semiCovered"] == base_first["semiCovered"]
    assert first["open"] == base_first["open"]


# ============================================================================
# UI smoke — fieldset + render fn references in code
# ============================================================================
def test_floor_summary_fieldset_in_index_html():
    assert 'id="floor-summary-fs"' in INDEX_HTML
    assert 'id="floor-summary-list"' in INDEX_HTML
    assert "Floor Summary (editable)" in INDEX_HTML

def test_renderFloorSummaryEditor_function_defined():
    assert "function renderFloorSummaryEditor()" in QUOTE_JS

def test_flush_calls_renderFloorSummaryEditor():
    # The flush() one-liner calls our new fn.
    assert "renderBpfPanel(); renderFloorSummaryEditor();" in QUOTE_JS

def test_floor_select_dropdown_present_in_zone_a_line_item():
    # The Zone A line-item editor injects a <select data-li-field="floor">.
    assert 'data-li-field="floor"' in QUOTE_JS

def test_floor_summary_overrides_in_default_state():
    # Defaults block declares the new override map.
    assert "floorSummaryOverrides: {}," in QUOTE_JS
