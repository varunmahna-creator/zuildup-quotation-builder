"""Phase 7E-B — sales feedback batch C, bug fixes (items 3, 4, 6).

Items:
3. Terrace area override bug — floor summary now respects manual area
   override on Zone C 'Terrace' (was using raw default formula).
4. Stilt open area derivation — open = setback + ramp, both honour
   manual Zone C overrides.
6. 'Add line' row in area-overrides panel: CSS opt-out from 3-column
   grid so the line-item flex layout actually expands.
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
    """Run buildFloorSummary against the given state via the same shim used
    by test_phase6_2 / test_phase7b. Returns the rows array."""
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
global.localStorage = { _s:{}, getItem(k){return null;}, setItem(){}, removeItem(){}, key(){return null;}, get length(){return 0;} };
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
  .replace("function loadState() {", "global.loadState = function loadState() {");
try { eval(patched); } catch(e) { console.error('eval err', e.message); process.exit(2); }

const c = computeQuote(STATE);
const rows = buildFloorSummary(STATE, c);
process.stdout.write(JSON.stringify(rows));
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


def _state(**overrides):
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
            "zoneLineItems": {},
            "itemNameOverrides": {}, "itemDescOverrides": {},
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


# --- Item 3: terrace area override flows into summary ---
def test_terrace_override_reflected_in_floor_summary():
    s = _state(floors=4)
    # Override Zone C 'Terrace' area to a clearly-distinct value.
    s["areaOverrides"] = {"C:Terrace": 1800}
    rows = _run_node(s)
    terrace = next((r for r in rows if r["label"] == "Terrace"), None)
    assert terrace is not None
    assert terrace["open"] == 1800, f"expected override 1800; got {terrace['open']}"

def test_terrace_default_when_no_override():
    s = _state(floors=4)  # no override
    rows = _run_node(s)
    terrace = next((r for r in rows if r["label"] == "Terrace"), None)
    # plotSqFt=2160, floorArea=1620, breadth=36, balcony=36*5=180,
    # staircase=125, hasLift=false → terrace = 1620 + 180 - 125 - 0 = 1675
    assert terrace["open"] == 1675


# --- Item 4: stilt open = setback + ramp; honours overrides on both ---
def test_stilt_open_includes_ramp_default():
    s = _state(floors=4, buildType="stilt")
    rows = _run_node(s)
    stilt = next((r for r in rows if r["label"] == "Stilt"), None)
    assert stilt is not None
    # plotSqFt=2160, floorArea=1620 → setback=540; ramp = breadth*RAMP_DEPTH = 36*6 = 216
    # open should be 540 + 216 = 756
    assert stilt["open"] == 756, f"expected 540+216=756; got {stilt['open']}"

def test_stilt_open_honours_setback_override():
    s = _state(floors=4, buildType="stilt")
    s["areaOverrides"] = {"C:Setback": 700}
    rows = _run_node(s)
    stilt = next((r for r in rows if r["label"] == "Stilt"), None)
    # setback=700 (override), ramp default = 216; open = 916
    assert stilt["open"] == 916

def test_stilt_open_honours_ramp_override():
    s = _state(floors=4, buildType="stilt")
    s["areaOverrides"] = {"C:Ramp": 300}
    rows = _run_node(s)
    stilt = next((r for r in rows if r["label"] == "Stilt"), None)
    # setback default 540, ramp 300 (override); open = 840
    assert stilt["open"] == 840


# --- Item 6: CSS opt-out for line-item rows ---
def test_aov_lineitem_css_opt_out_present():
    needle = "#area-ovr-list .aov-lineitem, #item-rate-list .aov-lineitem { display: flex !important; flex-wrap: wrap;"
    assert needle in INDEX_HTML, "aov-lineitem CSS escape rule missing"

def test_aov_lineitem_css_includes_marker():
    assert "Phase 7E-B Item 6: rep-added line items" in INDEX_HTML
