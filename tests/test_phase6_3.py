"""Phase 6.3 — Sequential additional zones (Elevation / GST / Custom).

Locks the invariants behind the new opt-in additional charge zones:
  - All three off → grand total identical to pre-6.3 (no extra zones).
  - One on → that zone appears as the next sequential letter, label
    "Zone X — {Name}", grand total = previous + cost.
  - All three on → all three appear sequentially, letters sequential,
    grand total = sum.
  - Zone-sum invariant holds: zone.cost == Σ(items.cost) (single line item,
    so just zone.cost == cost field).
  - Letter assignment with basement: hasBasement → basement is E,
    Elevation becomes F, GST G, Custom H.
  - Custom uses rep-supplied name as the zone label; falls back to
    "Custom Charge" when the name is blank.
  - Static zones (A/B/C/D/E) untouched when additional zones toggled.

Re-uses the Node shim pattern from test_phase5.py.
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
# Source-string sanity (cheap, no Node)
# ----------------------------------------------------------------------------
def test_state_shape_default_off():
    """defaultState() exposes additionalZones.{elevation,gst,custom}, all off."""
    m = re.search(
        r"additionalZones:\s*\{\s*"
        r"elevation:\s*\{\s*enabled:\s*false[^}]*\}[^}]*"
        r"gst:\s*\{\s*enabled:\s*false[^}]*\}[\s\S]*?"
        r"custom:\s*\[",  # Phase 7B Item 16: `custom` is now an array of charges
        QUOTE_JS, re.DOTALL,
    )
    assert m, "Expected default-off additionalZones block in defaultState()"


def test_index_html_has_three_toggles():
    # Phase 7B Item 16: custom block became dynamic — replaced by addl-custom-list
    # + addl-custom-add. Elevation + GST stay as static blocks (singletons).
    for el in [
        'id="f-addl-elevation-on"',
        'id="f-addl-gst-on"',
        'id="f-addl-elevation-desc"',
        'id="f-addl-elevation-cost"',
        'id="f-addl-gst-desc"',
        'id="f-addl-gst-cost"',
        # Phase 7B Item 16 — dynamic custom list + add button:
        'id="addl-custom-list"',
        'id="addl-custom-add"',
    ]:
        assert el in INDEX_HTML, f"index.html missing form element: {el}"
    assert 'id="addl-zones-fs"' in INDEX_HTML, "Missing additional-zones fieldset"


def test_cost_page_renders_additional_zones():
    """The cost-page tbody must include a `.additionalZones.map(additionalRow)` interpolation."""
    pat = re.compile(
        r"\$\{costRow\('A',\s*c\.zones\.A\)\}\s*"
        r"\$\{costRow\('B',\s*c\.zones\.B\)\}.*?"
        r"\$\{\(c\.additionalZones\s*\|\|\s*\[\]\)\.map\(additionalRow\)\.join\(''\)\}",
        re.DOTALL,
    )
    assert pat.search(QUOTE_JS), "Cost page must spread additionalZones via additionalRow"


def test_appendAdditionalZones_present():
    assert "function appendAdditionalZones(c, state)" in QUOTE_JS
    assert "appendAdditionalZones(c, state)" in QUOTE_JS  # called from computeQuote


# ----------------------------------------------------------------------------
# Node shim — reuse the test_phase5 pattern
# ----------------------------------------------------------------------------
def _run_compute(state):
    catalog_json = json.dumps(CAT)
    state_json = json.dumps(state)
    shim = r"""
'use strict';
const QUOTE_SRC = require('fs').readFileSync(process.argv[2], 'utf8');
const CATALOG = JSON.parse(process.argv[3]);
const STATE = JSON.parse(process.argv[4]);

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

const patched = QUOTE_SRC
  .replace("function computeQuote(state) {", "global.computeQuote = function computeQuote(state) {")
  .replace("function applyAreaOverrides(c, state) {", "global.applyAreaOverrides = function applyAreaOverrides(c, state) {")
  .replace("function appendAdditionalZones(c, state) {", "global.appendAdditionalZones = function appendAdditionalZones(c, state) {")
  .replace("function calcPackage(state) {", "global.calcPackage = function calcPackage(state) {")
  .replace("function calcStructure(state) {", "global.calcStructure = function calcStructure(state) {");

try { eval(patched); } catch(e) { console.error('eval err', e.message); process.exit(2); }

const result = computeQuote(STATE);
process.stdout.write(JSON.stringify(result));
"""
    with tempfile.TemporaryDirectory() as td:
        sp = os.path.join(td, "shim.js")
        with open(sp, "w") as f:
            f.write(shim)
        proc = subprocess.run(
            ["node", sp, str(QB / "app/quote.js"), catalog_json, state_json],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"shim rc={proc.returncode}\nSTDERR: {proc.stderr}\nSTDOUT: {proc.stdout[:500]}")
        return json.loads(proc.stdout)


def _state(buildType="stilt", floors=4, hasBasement=False, hasLift=False,
           costPerSqft=2000, structureRate=1500,
           additionalZones=None,
           plotSqYards=240, breadth=36, coverage=75):
    az = {
        "elevation": {"enabled": False, "desc": "", "cost": 0},
        "gst":       {"enabled": False, "desc": "", "cost": 0},
        "custom":    {"enabled": False, "name": "", "desc": "", "cost": 0},
    }
    if additionalZones:
        for k, v in additionalZones.items():
            az[k] = {**az[k], **v}
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
            "additionalZones": az,
        },
        "scope": "structure_only" if buildType == "structure" else "full",
        "rows": [], "notes": "", "draft": False,
        "specsLayout": "grid",
        "_uiCatOpen": {}, "_uiPickerOpen": {},
        "areaOverrides": {},
        "quoteId": "ZUI-2026-TEST",
        "createdAt": "2026-05-04",
    }


# ----------------------------------------------------------------------------
# Invariants
# ----------------------------------------------------------------------------
def test_all_off_total_unchanged():
    """All toggles off → additionalZones is empty, totals unchanged."""
    c = _run_compute(_state())
    assert c["additionalZones"] == [], f"Expected empty; got {c['additionalZones']}"
    base_total = c["grandTotal"]
    base_subtotal = c["zoneSubtotal"]
    assert base_total == base_subtotal + (c["lift"]["cost"] if c.get("lift") else 0)


def test_elevation_only_appended_as_zone_e_no_basement():
    """No basement → static zones are A,B,C,D. Elevation is Zone E."""
    base = _run_compute(_state())
    base_total = base["grandTotal"]
    c = _run_compute(_state(additionalZones={
        "elevation": {"enabled": True, "desc": "Front facade in stone", "cost": 300000},
    }))
    assert len(c["additionalZones"]) == 1
    az = c["additionalZones"][0]
    assert az["id"] == "elevation"
    assert az["letter"] == "E", f"Expected letter E (no basement); got {az['letter']}"
    assert az["name"] == "Elevation"
    assert az["cost"] == 300000
    assert az["desc"] == "Front facade in stone"
    assert c["grandTotal"] == base_total + 300000
    assert sum(it["cost"] for it in az["items"]) == az["cost"]


def test_elevation_with_basement_becomes_zone_f():
    """Basement on → basement is E, Elevation is F."""
    c = _run_compute(_state(hasBasement=True, additionalZones={
        "elevation": {"enabled": True, "desc": "Front", "cost": 200000},
    }))
    assert c["zones"]["E"] is not None, "Basement should produce zone E"
    assert len(c["additionalZones"]) == 1
    assert c["additionalZones"][0]["letter"] == "F"
    assert c["additionalZones"][0]["id"] == "elevation"


def test_all_three_on_sequential_letters():
    """All three on, no basement → letters E, F, G."""
    c = _run_compute(_state(additionalZones={
        "elevation": {"enabled": True, "desc": "d1", "cost": 100000},
        "gst":       {"enabled": True, "desc": "GST 18%", "cost": 200000},
        "custom":    {"enabled": True, "name": "Site Logistics", "desc": "Cranes etc.", "cost": 50000},
    }))
    az = c["additionalZones"]
    assert len(az) == 3
    assert [z["letter"] for z in az] == ["E", "F", "G"]
    assert [z["id"] for z in az] == ["elevation", "gst", "custom-0"]  # Phase 7B Item 16: custom is array; first entry is custom-0
    assert az[2]["name"] == "Site Logistics"


def test_all_three_on_with_basement_letters_f_g_h():
    """Basement + all three → static A,B,C,D,E ; additional F,G,H."""
    c = _run_compute(_state(hasBasement=True, additionalZones={
        "elevation": {"enabled": True, "desc": "", "cost": 1},
        "gst":       {"enabled": True, "desc": "", "cost": 2},
        "custom":    {"enabled": True, "name": "X", "desc": "", "cost": 3},
    }))
    assert [z["letter"] for z in c["additionalZones"]] == ["F", "G", "H"]


def test_grand_total_includes_all_three():
    base = _run_compute(_state())["grandTotal"]
    c = _run_compute(_state(additionalZones={
        "elevation": {"enabled": True, "desc": "", "cost": 300000},
        "gst":       {"enabled": True, "desc": "", "cost": 500000},
        "custom":    {"enabled": True, "name": "Misc", "desc": "", "cost": 75000},
    }))
    expected = base + 300000 + 500000 + 75000
    assert c["grandTotal"] == expected, f"Grand total mismatch: {c['grandTotal']} vs {expected}"
    assert c["zoneSubtotal"] == expected - (c["lift"]["cost"] if c.get("lift") else 0)


def test_disabled_zone_omitted_even_if_cost_set():
    """If enabled=False but cost is non-zero (rep typed then unchecked), zone is OMITTED."""
    c = _run_compute(_state(additionalZones={
        "elevation": {"enabled": False, "desc": "stale", "cost": 999999},
        "gst":       {"enabled": True, "desc": "GST", "cost": 1000},
    }))
    assert len(c["additionalZones"]) == 1
    assert c["additionalZones"][0]["id"] == "gst"


def test_custom_falls_back_to_default_name_when_blank():
    c = _run_compute(_state(additionalZones={
        "custom": {"enabled": True, "name": "  ", "desc": "x", "cost": 100},
    }))
    assert c["additionalZones"][0]["name"] == "Custom Charge"


def test_zone_sum_invariant_for_additional_zones():
    """zone.cost == Σ(items.cost) for each additional zone (Phase 5 invariant)."""
    c = _run_compute(_state(additionalZones={
        "elevation": {"enabled": True, "desc": "d", "cost": 123456},
        "gst":       {"enabled": True, "desc": "gst", "cost": 789},
        "custom":    {"enabled": True, "name": "C", "desc": "c", "cost": 4242},
    }))
    for az in c["additionalZones"]:
        items_sum = sum(it["cost"] for it in az["items"])
        assert items_sum == az["cost"], (
            f"Zone-sum invariant broken for {az['id']}: items_sum={items_sum} cost={az['cost']}"
        )


def test_static_zones_unaffected_by_additional():
    """Toggling additional zones must NOT change Zone A/B/C/D."""
    base = _run_compute(_state())
    c = _run_compute(_state(additionalZones={
        "elevation": {"enabled": True, "desc": "x", "cost": 300000},
        "gst":       {"enabled": True, "desc": "y", "cost": 500000},
    }))
    for k in ["A", "B", "C", "D"]:
        assert base["zones"][k]["cost"] == c["zones"][k]["cost"], (
            f"Zone {k} cost shifted: {base['zones'][k]['cost']} vs {c['zones'][k]['cost']}"
        )
        assert base["zones"][k]["total"] == c["zones"][k]["total"]


def test_structure_mode_no_zone_c_letter_starts_at_e():
    """Structure mode has no Zone C → static letters are A,B,D (E if basement).
       So next available after D is E (not skipping). My implementation finds
       MAX letter present, so D → +1 = E."""
    c = _run_compute(_state(buildType="structure", floors=4, additionalZones={
        "elevation": {"enabled": True, "desc": "x", "cost": 1000},
    }))
    assert c["zones"]["C"] is None
    assert c["additionalZones"][0]["letter"] == "E"
