"""Phase 7B — calculator + UI fixes (12 items).

Items covered (key behaviours locked in):
- 2  Collapsible area override panel (<details open>)
- 3  Zone D opt-in toggle (hasWaterTank). Default true; legacy migration.
- 4  Basement description shows entered ₹/sqft, not "varies"
- 5  PDF page-break CSS hygiene on area calc page
- 11 Floor Area Summary uses post-override areas
- 12 Stilt row column reassignment (semi-covered = stilt; open = setback)
- 13 Basement area = ground floor area (floorArea − lift − staircase)
- 14 Editable lift / staircase per-level sqft
- 15 Add line item button per zone
- 16 Multiple custom charges (array)
- 17 Editable item name + description overrides

Re-uses the Node shim pattern from test_phase6_2.
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
# Node shim — same pattern as test_phase6_2; exposes computeQuote, calcPackage,
# calcStructure, buildFloorSummary, renderAreaPage, renderCostPage, loadState.
# ---------------------------------------------------------------------------
def _run_node(state, fn="computeQuote", localStorageState=None):
    catalog_json = json.dumps(CAT)
    state_json = json.dumps(state) if state is not None else "null"
    ls_json = json.dumps(localStorageState or {})
    shim = r"""
'use strict';
const QUOTE_SRC = require('fs').readFileSync(process.argv[2], 'utf8');
const CATALOG = JSON.parse(process.argv[3]);
const STATE = JSON.parse(process.argv[4]);
const FN = process.argv[5];
const LS = JSON.parse(process.argv[6]);

global.window = {};
global.document = { getElementById: () => null };
global.localStorage = {
  _s: Object.assign({}, LS), getItem(k){return this._s[k]||null;},
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
  .replace("function appendZoneLineItems(c, state) {", "global.appendZoneLineItems = function appendZoneLineItems(c, state) {")
  .replace("function calcPackage(state) {", "global.calcPackage = function calcPackage(state) {")
  .replace("function calcStructure(state) {", "global.calcStructure = function calcStructure(state) {")
  .replace("function buildFloorSummary(state, c) {", "global.buildFloorSummary = function buildFloorSummary(state, c) {")
  .replace("function renderFloorSummaryTable(state, c) {", "global.renderFloorSummaryTable = function renderFloorSummaryTable(state, c) {")
  .replace("function renderAreaPage(state, c) {", "global.renderAreaPage = function renderAreaPage(state, c) {")
  .replace("function renderCostPage(state, c) {", "global.renderCostPage = function renderCostPage(state, c) {")
  .replace("function loadState() {", "global.loadState = function loadState() {");

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
} else if (FN === 'loadState') {
  result = loadState();
} else { result = null; }
process.stdout.write(JSON.stringify(result));
"""
    with tempfile.TemporaryDirectory() as td:
        sp = os.path.join(td, "shim.js")
        with open(sp, "w") as f:
            f.write(shim)
        proc = subprocess.run(
            ["node", sp, str(QB / "app/quote.js"), catalog_json, state_json, fn, ls_json],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"shim rc={proc.returncode}\nSTDERR: {proc.stderr}\nSTDOUT: {proc.stdout[:500]}"
            )
        return json.loads(proc.stdout)


def _state(buildType="stilt", floors=4, hasBasement=False, hasLift=False,
           hasWaterTank=True,
           costPerSqft=2000, structureRate=1500, basementRate=None,
           liftSqftPerLevel=None, staircaseSqftPerLevel=None,
           zoneLineItems=None,
           itemNameOverrides=None, itemDescOverrides=None,
           additional_custom=None,
           plotSqYards=240, breadth=36, coverage=75,
           areaOverrides=None):
    return {
        "customer": {"salutation": "", "name": "T", "address": ""},
        "build": {
            "plotSqYards": plotSqYards, "breadth": breadth, "coverage": coverage,
            "buildType": buildType, "floors": floors,
            "hasBasement": hasBasement, "hasLift": hasLift,
            "hasWaterTank": hasWaterTank,
        },
        "pricing": {
            "costPerSqft": costPerSqft, "structureRate": structureRate,
            "zoneARate": None, "zoneBRate": None, "zoneCRate": None,
            "zoneDRate": None, "basementRate": basementRate,
            "itemRates": {}, "liftCost": None,
            "liftSqftPerLevel": liftSqftPerLevel,
            "staircaseSqftPerLevel": staircaseSqftPerLevel,
            "additionalZones": {
                "elevation": {"enabled": False, "desc": "", "cost": 0},
                "gst":       {"enabled": False, "desc": "", "cost": 0},
                "custom":    additional_custom if additional_custom is not None else [],
            },
            "balconyPerFloor": {"enabled": False, "rates": []},
            "zoneLineItems": zoneLineItems or {},
            "itemNameOverrides": itemNameOverrides or {},
            "itemDescOverrides": itemDescOverrides or {},
        },
        "scope": "structure_only" if buildType == "structure" else "full",
        "rows": [], "notes": "", "draft": False,
        "specsLayout": "grid",
        "_uiCatOpen": {}, "_uiPickerOpen": {},
        "areaOverrides": areaOverrides or {},
        "quoteId": "ZUI-2026-TEST",
        "createdAt": "2026-05-04",
    }


# ============================================================================
# Item 2 — Collapsible area override panel (and the per-item rate panel must
#          remain default-open from Phase 6.1).
# ============================================================================
def test_collapsible_panels_open_by_default():
    """Both <details> sections (area-override + per-item rate) default OPEN."""
    # Per-item rate panel — id="item-rate-overrides", `details.open = true`
    # is set in the JS path; the markup itself doesn't need an `open` attribute.
    assert 'id="item-rate-overrides"' in INDEX_HTML
    # Area override panel — Phase 7B Item 2 wraps in `<details open>`.
    assert 'id="area-ovr-collapse"' in INDEX_HTML, "Phase 7B Item 2 area-ovr-collapse missing"
    # The `<details open>` flag is on the same element.
    m = re.search(r'<details[^>]*id="area-ovr-collapse"[^>]*\sopen[^>]*>', INDEX_HTML)
    assert m is not None, "area-ovr-collapse must have the `open` attribute"


# ============================================================================
# Item 3 — Zone D opt-in toggle
# ============================================================================
def test_zone_d_opt_in_off():
    """hasWaterTank=false → c.zones.D is null and Zone D omitted from totals."""
    s_on = _state(hasWaterTank=True)
    s_off = _state(hasWaterTank=False)
    c_on  = _run_node(s_on)
    c_off = _run_node(s_off)
    assert c_on["zones"]["D"] is not None
    assert c_off["zones"]["D"] is None
    # Grand total drops by exactly costD.
    assert c_off["grandTotal"] == c_on["grandTotal"] - c_on["zones"]["D"]["cost"]


def test_zone_d_opt_in_default_true_legacy():
    """A legacy quote with no hasWaterTank field → loadState defaults it to true."""
    legacy_quote = {
        "customer": {"salutation":"","name":"L","address":""},
        # NB: no `hasWaterTank` field on build — simulates a pre-7B saved quote.
        "build": {"plotSqYards":240,"breadth":36,"coverage":75,"buildType":"stilt",
                  "floors":3,"hasBasement":False,"hasLift":False},
        "pricing": {"costPerSqft":2000,"structureRate":1500,"itemRates":{}},
        "scope":"full","rows":[],"notes":"","draft":False,"specsLayout":"grid",
        "areaOverrides":{},"quoteId":"L","createdAt":"2026-05-04",
    }
    out = _run_node(None, fn="loadState", localStorageState={
        "zuildup.quote.v2": json.dumps(legacy_quote)
    })
    assert out["build"]["hasWaterTank"] is True, \
        f"legacy quote should default hasWaterTank=true; got {out['build'].get('hasWaterTank')!r}"


def test_zone_d_explicit_false_legacy():
    """If a saved quote DOES have hasWaterTank:false, loadState preserves it."""
    legacy_quote = {
        "customer": {"salutation":"","name":"L","address":""},
        "build": {"plotSqYards":240,"breadth":36,"coverage":75,"buildType":"stilt",
                  "floors":3,"hasBasement":False,"hasLift":False,"hasWaterTank":False},
        "pricing": {"costPerSqft":2000,"structureRate":1500,"itemRates":{}},
        "scope":"full","rows":[],"notes":"","draft":False,"specsLayout":"grid",
        "areaOverrides":{},"quoteId":"L","createdAt":"2026-05-04",
    }
    out = _run_node(None, fn="loadState", localStorageState={
        "zuildup.quote.v2": json.dumps(legacy_quote)
    })
    assert out["build"]["hasWaterTank"] is False


# ============================================================================
# Item 4 — Basement description shows entered ₹/sqft
# ============================================================================
def test_basement_rate_description():
    """basementRate=3000 → cost-page shows ₹3,000/sqft on Zone E (not 'varies')."""
    s = _state(hasBasement=True, basementRate=3000)
    c = _run_node(s)
    e = c["zones"]["E"]
    assert e is not None
    # E should NOT be flagged as varies — explicit global rate wins.
    assert e.get("varies") in (False, None), f"Zone E should not be 'varies' when explicit rate set: {e}"
    assert e["rate"] == 3000
    assert "3,000" in e["rateLabel"], f"rateLabel should show 3,000 — got {e['rateLabel']!r}"


# ============================================================================
# Item 5 — PDF page-break CSS hygiene
# ============================================================================
def test_page_break_css_present():
    """The Phase 7B Item 5 page-break rules are present in quote.js inline CSS."""
    assert "Phase 7B Item 5" in QUOTE_JS, "Phase 7B Item 5 marker missing"
    # The key CSS rules.
    assert ".calc-table tbody tr.zone-hdr" in QUOTE_JS
    assert "break-after: avoid-page" in QUOTE_JS or "page-break-after: avoid" in QUOTE_JS
    assert ".calc-table tbody tr.zone-total" in QUOTE_JS
    assert "break-before: avoid-page" in QUOTE_JS or "page-break-before: avoid" in QUOTE_JS


# ============================================================================
# Item 11 — Floor Area Summary uses post-override areas
# ============================================================================
def test_floor_summary_post_override():
    """Override Zone A 'First Floor' → corresponding summary row reflects it."""
    s = _state(floors=4)
    # Override 'First Floor' (Zone A index 1) to a value clearly different from default.
    # Phase 7E-A Item 1: summary now uses canonical calc labels, so the row label
    # IS 'First Floor' directly (not '2nd Floor').
    s["areaOverrides"] = {"A:First Floor": 2200}
    rows = _run_node(s, fn="buildFloorSummary")
    second = next((r for r in rows if r["label"] == "First Floor"), None)
    assert second is not None
    assert second["covered"] == 2200, \
        f"Floor summary First Floor 'covered' should reflect override 2200; got {second['covered']}"


# ============================================================================
# Item 12 — Stilt row column reassignment
# ============================================================================
def test_stilt_row_columns():
    """Stilt row: semi-covered = stilt covered area; open = setback + ramp.

    Phase 7E-B Item 4: open now includes ramp area (was setback only).
    """
    s = _state(buildType="stilt", floors=3, hasLift=False)
    rows = _run_node(s, fn="buildFloorSummary")
    stilt = next((r for r in rows if r["label"] == "Stilt"), None)
    assert stilt is not None
    # Plot 240 sq.yd × 9 = 2160 sq.ft; coverage 75% → floorArea = 1620.
    # No lift so stiltCovered = floorAdj = 1620 - 0 - 125 = 1495.
    # setbackArea = 2160 - 1620 = 540; ramp = breadth(36) * RAMP_DEPTH(6) = 216.
    # open = 540 + 216 = 756 (Phase 7E-B Item 4).
    assert stilt["covered"] == 0, f"covered must be 0 (stilt not enclosed); got {stilt['covered']}"
    assert stilt["semiCovered"] == 1495, f"semiCovered should be 1495 (stilt area); got {stilt['semiCovered']}"
    assert stilt["open"] == 756, f"open should be 756 (setback 540 + ramp 216); got {stilt['open']}"


# ============================================================================
# Item 13 — Basement area = ground floor area (floorAdj)
# ============================================================================
def test_basement_area_formula():
    """basement area == floorArea − liftPerLevel − staircasePerLevel (= floorAdj),
    matching the 'Ground Floor' Zone A row."""
    s = _state(buildType="stilt", floors=3, hasBasement=True, hasLift=True)
    c = _run_node(s)
    zoneE = c["zones"]["E"]
    zoneA = c["zones"]["A"]
    assert zoneE is not None
    basementArea = zoneE["items"][0]["area"]
    # floorArea = 2160 * 0.75 = 1620; with lift: 1620 - 25 - 125 = 1470.
    assert basementArea == 1470, f"basement area should be 1470; got {basementArea}"
    # And it should match the Ground Floor zone-A area exactly.
    ground = next(it for it in zoneA["items"] if it["name"] == "Ground Floor")
    assert ground["area"] == basementArea


# ============================================================================
# Item 14 — Editable lift / staircase per-level sqft
# ============================================================================
def test_editable_lift_staircase():
    """liftSqftPerLevel=30, staircaseSqftPerLevel=150 cascades through calc."""
    s = _state(buildType="stilt", floors=3, hasLift=True,
               liftSqftPerLevel=30, staircaseSqftPerLevel=150)
    c = _run_node(s)
    zoneA = c["zones"]["A"]
    # Floor area 1620 - 30 - 150 = 1440
    ground = next(it for it in zoneA["items"] if it["name"] == "Ground Floor")
    assert ground["area"] == 1440, f"Ground Floor area should be 1440; got {ground['area']}"
    # Lift item: levels (3 floors + stilt + mumty = 5) × 30 = 150
    lift = next(it for it in zoneA["items"] if it["name"] == "Lift")
    # Stops = floors + stilt + mumty = 3 + 1 + 1 = 5
    assert lift["area"] == 5 * 30, f"Lift total area should be 150 (5 levels × 30); got {lift['area']}"
    # Staircase in Zone B: 5 × 150 = 750
    zoneB = c["zones"]["B"]
    sc = next(it for it in zoneB["items"] if it["name"] == "Staircase")
    assert sc["area"] == 5 * 150, f"Staircase area should be 750 (5 × 150); got {sc['area']}"


def test_lift_staircase_legacy_default():
    """Legacy quote with no liftSqftPerLevel / staircaseSqftPerLevel → 25 / 125."""
    legacy_quote = {
        "customer": {"salutation":"","name":"L","address":""},
        "build": {"plotSqYards":240,"breadth":36,"coverage":75,"buildType":"stilt",
                  "floors":3,"hasBasement":False,"hasLift":True,"hasWaterTank":True},
        # NB: no liftSqftPerLevel / staircaseSqftPerLevel — pre-7B
        "pricing": {"costPerSqft":2000,"structureRate":1500,"itemRates":{}},
        "scope":"full","rows":[],"notes":"","draft":False,"specsLayout":"grid",
        "areaOverrides":{},"quoteId":"L","createdAt":"2026-05-04",
    }
    out = _run_node(None, fn="loadState", localStorageState={
        "zuildup.quote.v2": json.dumps(legacy_quote)
    })
    # Defaults from defaultState: null → falls back to LIFT_PER_FLOOR / STAIRCASE_PER_FLOOR.
    assert out["pricing"].get("liftSqftPerLevel") in (None, 25)
    assert out["pricing"].get("staircaseSqftPerLevel") in (None, 125)
    # Verify calc still uses 25/125 by computing through.
    c = _run_node(out)
    zoneA = c["zones"]["A"]
    ground = next(it for it in zoneA["items"] if it["name"] == "Ground Floor")
    # 1620 - 25 - 125 = 1470
    assert ground["area"] == 1470


# ============================================================================
# Item 15 — Add line item per zone
# ============================================================================
def test_zone_line_item():
    """Adding a Zone B line item 'Pergola' (200 sqft × ₹1500) → +₹3,00,000."""
    base = _run_node(_state(buildType="stilt", floors=3))
    s = _state(buildType="stilt", floors=3, zoneLineItems={
        "B": [{"id":"li1","name":"Pergola","desc":"Steel + glass canopy","area":200,"rate":1500}]
    })
    c = _run_node(s)
    delta = c["grandTotal"] - base["grandTotal"]
    assert delta == 200 * 1500, f"Grand total should be +₹3,00,000; got delta={delta}"
    # The Pergola item should appear in Zone B items.
    zoneB = c["zones"]["B"]
    pergola = next((it for it in zoneB["items"] if it["name"] == "Pergola"), None)
    assert pergola is not None
    assert pergola["area"] == 200
    assert pergola["rate"] == 1500
    assert pergola["cost"] == 300000


# ============================================================================
# Item 16 — Multiple custom charges
# ============================================================================
def test_multiple_custom_charges():
    """3 custom charges → 3 sequential additional zones."""
    customs = [
        {"enabled":True,"name":"Site Logistics","desc":"Material movement","cost":50000},
        {"enabled":True,"name":"Permits & NOCs","desc":"Statutory","cost":75000},
        {"enabled":True,"name":"Soil Treatment","desc":"Anti-termite","cost":25000},
    ]
    s = _state(additional_custom=customs)
    c = _run_node(s)
    additional = c["additionalZones"]
    assert len(additional) == 3, f"Expected 3 additional zones; got {len(additional)}"
    names = [z["name"] for z in additional]
    assert names == ["Site Logistics","Permits & NOCs","Soil Treatment"], names
    # Sequential letters — should be the next three after the static zones.
    letters = [z["letter"] for z in additional]
    assert len(set(letters)) == 3, f"letters should be unique: {letters}"
    # Sum into grand total.
    base = _run_node(_state())
    delta = c["grandTotal"] - base["grandTotal"]
    assert delta == 50000 + 75000 + 25000


def test_custom_charge_legacy_object():
    """A legacy quote with custom as a single object → loadState wraps in array."""
    legacy_quote = {
        "customer":{"salutation":"","name":"L","address":""},
        "build":{"plotSqYards":240,"breadth":36,"coverage":75,"buildType":"stilt",
                 "floors":3,"hasBasement":False,"hasLift":False,"hasWaterTank":True},
        "pricing":{
            "costPerSqft":2000,"structureRate":1500,"itemRates":{},
            "additionalZones": {
                "elevation":{"enabled":False,"desc":"","cost":0},
                "gst":{"enabled":False,"desc":"","cost":0},
                # Legacy single-object shape — should become [obj] on load.
                "custom":{"enabled":True,"name":"Old Custom","desc":"x","cost":12345}
            }
        },
        "scope":"full","rows":[],"notes":"","draft":False,"specsLayout":"grid",
        "areaOverrides":{},"quoteId":"L","createdAt":"2026-05-04",
    }
    out = _run_node(None, fn="loadState", localStorageState={
        "zuildup.quote.v2": json.dumps(legacy_quote)
    })
    customs = out["pricing"]["additionalZones"]["custom"]
    assert isinstance(customs, list), f"custom should be list after migration; got {type(customs).__name__}"
    assert len(customs) == 1
    assert customs[0]["name"] == "Old Custom"
    assert customs[0]["cost"] == 12345


def test_legacy_object_no_data_becomes_empty_array():
    """A legacy `custom: {enabled:false,name:'',cost:0}` (no real data) → []."""
    legacy_quote = {
        "customer":{"salutation":"","name":"L","address":""},
        "build":{"plotSqYards":240,"breadth":36,"coverage":75,"buildType":"stilt",
                 "floors":3,"hasBasement":False,"hasLift":False,"hasWaterTank":True},
        "pricing":{
            "costPerSqft":2000,"structureRate":1500,"itemRates":{},
            "additionalZones": {
                "elevation":{"enabled":False,"desc":"","cost":0},
                "gst":{"enabled":False,"desc":"","cost":0},
                "custom":{"enabled":False,"name":"","desc":"","cost":0}
            }
        },
        "scope":"full","rows":[],"notes":"","draft":False,"specsLayout":"grid",
        "areaOverrides":{},"quoteId":"L","createdAt":"2026-05-04",
    }
    out = _run_node(None, fn="loadState", localStorageState={
        "zuildup.quote.v2": json.dumps(legacy_quote)
    })
    customs = out["pricing"]["additionalZones"]["custom"]
    assert customs == [], f"empty legacy object should migrate to []; got {customs!r}"


# ============================================================================
# Item 17 — Editable item name + description overrides
# ============================================================================
def test_item_name_override():
    """Renaming Ground Floor → 'Penthouse' shows up in the area-page render."""
    s = _state(buildType="stilt", floors=3, itemNameOverrides={
        "A:Ground Floor": "Penthouse"
    })
    out = _run_node(s, fn="renderArea")
    html = out["html"]
    assert "Penthouse" in html, "Renamed 'Penthouse' should appear in area page HTML"


def test_item_name_override_in_cost_sheet():
    """Renaming an item also surfaces in the cost-sheet render (via the
    hasNameOverride force-expand path)."""
    s = _state(buildType="stilt", floors=3, itemNameOverrides={
        "A:First Floor": "Studio Suite"
    })
    out = _run_node(s, fn="renderCost")
    html = out["html"]
    assert "Studio Suite" in html, \
        "Renamed item should expand the zone in the cost sheet so it's visible"


def test_item_desc_override():
    """Description override surfaces on the area-page render."""
    s = _state(buildType="stilt", floors=3, hasBasement=True,
               basementRate=3000,
               itemDescOverrides={
                   "E:Basement": "Custom: home theatre + wine cellar"
               })
    out = _run_node(s, fn="renderArea")
    assert "home theatre" in out["html"]
