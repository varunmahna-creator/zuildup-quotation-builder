"""Phase 5 — Sales team bug-fix regression tests.

Covers four issues:
  1. Concrete subsection present under Structure category.
  2. Zone subtotal == Σ(line item costs) under any rate/area override permutation.
  3. Lift & staircase counts unified across all 3 calculator modes (mumty always +1).
  4. Manually-area-overridden line items render description "as per design scope".

Strategy: extracts `computeQuote` + `applyAreaOverrides` from app/quote.js using
a regex-bounded slice, wraps it in a tiny Node shim, and runs assertions via JSON
output. This avoids spinning up Chrome for unit-level invariants.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

QB = Path(__file__).parent.parent
QUOTE_JS = (QB / "app/quote.js").read_text()
CAT = json.load(open(QB / "catalog/catalog.json"))


# ----------------------------------------------------------------------------
# Issue 1: catalog has Concrete under Structure
# ----------------------------------------------------------------------------
def test_concrete_in_structure_catalog():
    structure_items = [i for i in CAT["items"] if i.get("category_label") == "Structure"]
    concretes = [i for i in structure_items if i.get("label") == "Concrete"]
    assert len(concretes) == 1, f"Expected exactly 1 Concrete item under Structure; found {len(concretes)}"
    c = concretes[0]
    assert c["id"] == "structure.concrete"
    assert "full" in c["scope"]
    assert "structure_only" in c["scope"]


# ----------------------------------------------------------------------------
# Helper: run computeQuote in Node and return the result
# ----------------------------------------------------------------------------
def _run_compute(state):
    """Boot a Node script that loads quote.js, calls computeQuote(state), and
    JSON-prints the result."""
    catalog_json = json.dumps(CAT)
    state_json = json.dumps(state)

    # Build a Node shim. We need to:
    #   - polyfill window/document/fetch/localStorage minimally so quote.js doesn't crash
    #   - load quote.js source
    #   - intercept loadCatalog to return our in-memory catalog
    #   - call computeQuote(state)
    shim = r"""
'use strict';
const QUOTE_SRC = require('fs').readFileSync(process.argv[2], 'utf8');
const CATALOG = JSON.parse(process.argv[3]);
const STATE = JSON.parse(process.argv[4]);

// Minimal browser shims. quote.js's IIFE checks for #spec-list / #preview-root
// to decide which boot to run; we provide neither, so neither boot runs.
global.window = {};
global.document = { getElementById: () => null };
global.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] || null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
  key(i) { return Object.keys(this._s)[i] || null; },
  get length() { return Object.keys(this._s).length; },
};
global.fetch = () => Promise.resolve({ ok: true, json: async () => CATALOG });
global.CustomEvent = class { constructor(name, opts){ this.type = name; Object.assign(this, opts || {}); } };
global.Event = class { constructor(name){ this.type = name; } };
window.dispatchEvent = () => {};
window.addEventListener = () => {};

// To get at computeQuote we have to expose it. quote.js wraps everything in an
// IIFE that doesn't export its helpers. Strategy: rewrite the IIFE so
// computeQuote, applyAreaOverrides, calcPackage, calcStructure all leak to
// global before the boot guards fire.
const patched = QUOTE_SRC.replace(
  '(function(){',
  "(function(){ const __EXPORTS__ = (typeof module !== 'undefined' && module.exports) || {};"
).replace(
  "function computeQuote(state) {",
  "global.computeQuote = function computeQuote(state) {"
).replace(
  "function applyAreaOverrides(c, state) {",
  "global.applyAreaOverrides = function applyAreaOverrides(c, state) {"
).replace(
  "function calcPackage(state) {",
  "global.calcPackage = function calcPackage(state) {"
).replace(
  "function calcStructure(state) {",
  "global.calcStructure = function calcStructure(state) {"
).replace(
  "function ni(n) {",
  "global.ni = function ni(n) {"
).replace(
  "function fmtINR(n) {",
  "global.fmtINR = function fmtINR(n) {"
);

// Stuff CATALOG in via a global so loadCatalog isn't needed — but the
// calculator doesn't actually call CATALOG; it only reads state.build/pricing
// directly. So we can just eval `patched` and call computeQuote.
try {
  eval(patched);
} catch (e) {
  console.error('eval err', e.message);
  process.exit(2);
}

const result = computeQuote(STATE);
process.stdout.write(JSON.stringify(result, null, 2));
"""
    with tempfile.TemporaryDirectory() as td:
        shim_path = os.path.join(td, "shim.js")
        with open(shim_path, "w") as f:
            f.write(shim)
        proc = subprocess.run(
            ["node", shim_path, str(QB / "app/quote.js"), catalog_json, state_json],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"node shim failed: rc={proc.returncode}\nSTDERR: {proc.stderr}\nSTDOUT: {proc.stdout[:1000]}")
        return json.loads(proc.stdout)


def _state(buildType="stilt", floors=4, hasBasement=False, hasLift=False,
           costPerSqft=2000, structureRate=1500, itemRates=None, areaOverrides=None,
           plotSqYards=240, breadth=36, coverage=75):
    return {
        "customer": {"salutation": "", "name": "Test", "address": ""},
        "build": {
            "plotSqYards": plotSqYards, "breadth": breadth, "coverage": coverage,
            "buildType": buildType, "floors": floors,
            "hasBasement": hasBasement, "hasLift": hasLift,
        },
        "pricing": {
            "costPerSqft": costPerSqft, "structureRate": structureRate,
            "zoneARate": None, "zoneBRate": None, "zoneCRate": None,
            "zoneDRate": None, "basementRate": None,
            "itemRates": itemRates or {},
            "liftCost": None,
        },
        "scope": "structure_only" if buildType == "structure" else "full",
        "rows": [], "notes": "", "draft": False,
        "specsLayout": "grid",
        "_uiCatOpen": {}, "_uiPickerOpen": {},
        "areaOverrides": areaOverrides or {},
        "quoteId": "ZUI-2026-TEST",
        "createdAt": "2026-05-02",
    }


# ----------------------------------------------------------------------------
# Issue 3: lift & staircase count fixtures
# ----------------------------------------------------------------------------
def test_staircase_stilt_4_floors():
    """Stilt + 4 floors → 6 levels (S + 4 + mumty)"""
    c = _run_compute(_state(buildType="stilt", floors=4, hasLift=True))
    # Lift area = LIFT_PER_FLOOR (25) * staircaseLevels. We expect levels=6.
    lift_item = next((it for it in c["zones"]["A"]["items"] if it["name"] == "Lift"), None)
    assert lift_item is not None, "Lift item missing"
    assert lift_item["area"] == 25 * 6, f"Stilt+4: expected 150 (25×6), got {lift_item['area']}"
    # Cross-check via Zone B Staircase line
    sc_item = next(it for it in c["zones"]["B"]["items"] if it["name"] == "Staircase")
    assert sc_item["area"] == 125 * 6, f"Stilt+4 staircase: expected 750 (125×6), got {sc_item['area']}"


def test_staircase_basement_stilt_4():
    """Basement + Stilt + 4 → 7 levels"""
    c = _run_compute(_state(buildType="stilt", floors=4, hasBasement=True, hasLift=True))
    lift_item = next(it for it in c["zones"]["A"]["items"] if it["name"] == "Lift")
    assert lift_item["area"] == 25 * 7, f"B+S+4: expected 175, got {lift_item['area']}"


def test_staircase_ground_4():
    """Ground + 3 (i.e. floors=4, no stilt) → 5 levels (4 floors + mumty)"""
    c = _run_compute(_state(buildType="nostilt", floors=4, hasLift=True))
    lift_item = next(it for it in c["zones"]["A"]["items"] if it["name"] == "Lift")
    assert lift_item["area"] == 25 * 5, f"G+3: expected 125 (25×5), got {lift_item['area']}"


def test_staircase_structure_mode():
    """Structure mode: Stilt + 4 → 6 levels (must match calcPackage)"""
    c = _run_compute(_state(buildType="structure", floors=4, hasLift=True))
    lift_item = next(it for it in c["zones"]["A"]["items"] if it["name"] == "Lift")
    assert lift_item["area"] == 25 * 6, f"Structure S+4: expected 150, got {lift_item['area']}"


def test_staircase_consistency_across_modes():
    """Stilt+4 should produce the same staircase count in all modes that support stilt+4."""
    pkg = _run_compute(_state(buildType="stilt", floors=4, hasLift=True))
    struc = _run_compute(_state(buildType="structure", floors=4, hasLift=True))
    pkg_lift = next(it for it in pkg["zones"]["A"]["items"] if it["name"] == "Lift")
    struc_lift = next(it for it in struc["zones"]["A"]["items"] if it["name"] == "Lift")
    assert pkg_lift["area"] == struc_lift["area"], \
        f"Lift count mismatch: package={pkg_lift['area']}, structure={struc_lift['area']}"


# ----------------------------------------------------------------------------
# Issue 2: zone subtotal == Σ(item costs) under override permutations
# ----------------------------------------------------------------------------
def _assert_zone_invariant(c, label=""):
    """Σ(item.cost) across all zones must equal c.zoneSubtotal,
       and c.grandTotal == c.zoneSubtotal + (lift cost if any)."""
    zone_sum = 0
    for k in ['A','B','C','D','E']:
        z = c["zones"].get(k)
        if not z: continue
        items_sum = sum(it.get("cost", 0) for it in z["items"])
        # Allow tiny rounding drift
        assert abs(items_sum - z["cost"]) < 1, \
            f"{label} Zone {k}: Σ(items.cost)={items_sum} vs z.cost={z['cost']}"
        zone_sum += z["cost"]
    assert abs(zone_sum - c["zoneSubtotal"]) < 1, \
        f"{label} zoneSubtotal mismatch: Σ(zones)={zone_sum} vs c.zoneSubtotal={c['zoneSubtotal']}"
    lift_cost = (c.get("lift") or {}).get("cost", 0)
    assert abs(c["grandTotal"] - (c["zoneSubtotal"] + lift_cost)) < 1, \
        f"{label} grandTotal mismatch"


def test_zone_invariant_baseline():
    c = _run_compute(_state(buildType="stilt", floors=4, hasLift=True))
    _assert_zone_invariant(c, "baseline")


def test_zone_invariant_with_rate_override():
    """Set Zone A 'Lift' line item to ₹3000/sqft (default ₹2000)."""
    c = _run_compute(_state(
        buildType="stilt", floors=4, hasLift=True,
        itemRates={"A:Lift": 3000},
    ))
    _assert_zone_invariant(c, "rate-override")
    lift = next(it for it in c["zones"]["A"]["items"] if it["name"] == "Lift")
    assert lift["rate"] == 3000
    assert lift["cost"] == lift["area"] * 3000
    assert c["zones"]["A"]["varies"] is True


def test_zone_invariant_with_area_override():
    """Override Zone A 'First Floor' area."""
    c = _run_compute(_state(
        buildType="stilt", floors=4, hasLift=True,
        areaOverrides={"A:First Floor": 1000},
    ))
    _assert_zone_invariant(c, "area-override")
    ff = next(it for it in c["zones"]["A"]["items"] if it["name"] == "First Floor")
    assert ff["area"] == 1000
    assert ff["cost"] == 1000 * ff["rate"]


def test_zone_invariant_combined_overrides():
    """Both rate AND area overrides — the worst case that exposed Bug 2.3."""
    c = _run_compute(_state(
        buildType="stilt", floors=4, hasLift=True,
        itemRates={"A:Lift": 3000, "B:Balcony": 1500},
        areaOverrides={"A:First Floor": 1500, "B:Balcony": 800},
    ))
    _assert_zone_invariant(c, "combined")
    # Spot check Zone A
    lift = next(it for it in c["zones"]["A"]["items"] if it["name"] == "Lift")
    assert lift["rate"] == 3000, "Per-item rate must survive area-override pass"
    assert lift["cost"] == lift["area"] * 3000, \
        "Per-item cost must reflect rate override after area override"


def test_zone_invariant_multi_zone_overrides():
    """Override areas in multiple zones — Bug 2.1 scenario (dirty-flag leak)."""
    c = _run_compute(_state(
        buildType="stilt", floors=4, hasLift=True, hasBasement=True,
        itemRates={"C:Terrace": 700, "E:Basement": 2900},
        areaOverrides={"B:Balcony": 700, "C:Ramp": 100},
    ))
    _assert_zone_invariant(c, "multi-zone")
    # Verify zone C still respects per-item rate after zones B was processed.
    terrace = next(it for it in c["zones"]["C"]["items"] if it["name"] == "Terrace")
    assert terrace["rate"] == 700, "Zone C rate override must survive Zone B area override"
    assert terrace["cost"] == terrace["area"] * 700
    # Same for Zone E
    bm = next(it for it in c["zones"]["E"]["items"] if it["name"] == "Basement")
    assert bm["rate"] == 2900


# ----------------------------------------------------------------------------
# Issue 4: area-overridden item description
# ----------------------------------------------------------------------------
def test_area_override_replaces_description():
    c = _run_compute(_state(
        buildType="stilt", floors=4, hasLift=True,
        areaOverrides={"A:First Floor": 1234, "C:Terrace": 500},
    ))
    ff = next(it for it in c["zones"]["A"]["items"] if it["name"] == "First Floor")
    terr = next(it for it in c["zones"]["C"]["items"] if it["name"] == "Terrace")
    assert ff["desc"] == "as per design scope", f"Got {ff['desc']!r}"
    assert terr["desc"] == "as per design scope", f"Got {terr['desc']!r}"
    assert ff.get("areaOverridden") is True


def test_non_overridden_keeps_formula_description():
    """Items WITHOUT an override should keep the original formula desc."""
    c = _run_compute(_state(buildType="stilt", floors=4, hasLift=True,
                            areaOverrides={"A:First Floor": 1234}))
    # Other rows not touched
    gf = next(it for it in c["zones"]["A"]["items"] if it["name"] == "Ground Floor")
    assert "Floor Area" in gf["desc"], f"Non-overridden GF must keep formula desc; got {gf['desc']!r}"
    assert gf.get("areaOverridden") is not True


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
        print(f"\n{failed}/{len(fns)} failed")
        sys.exit(1)
    print(f"\nAll {len(fns)} tests passed")
