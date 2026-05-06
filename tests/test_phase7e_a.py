"""Phase 7E-A — sales feedback batch C, quick fixes (items 1, 2, 8, 9, 10).

Items:
1.  Floor area summary nomenclature parity — summary uses canonical
    'Ground Floor', 'First Floor', ... matching calc engine zone-A names.
2.  Removed 'Premium Package' sublabel from floor + basement rows.
8.  Removed 'Coverage:' and 'Floor Area:' from Area Calculation params-row.
9.  #bpf-rate-list inherits the price-override panel CSS styling.
10. Editor field label 'Brand Name & Rate' renamed to 'Rate'.
"""
from pathlib import Path

QB = Path(__file__).parent.parent
QUOTE_JS = (QB / "app/quote.js").read_text()
INDEX_HTML = (QB / "app/index.html").read_text()


# --- Item 1: single source of truth for floor labels ---
def test_floor_display_names_constant_exists():
    assert "const FLOOR_DISPLAY_NAMES = ['Ground Floor','First Floor','Second Floor','Third Floor','Fourth Floor'];" in QUOTE_JS

def test_legacy_first_floor_array_removed_from_summary():
    # The old '1st Floor' literal should NOT appear as the floor-summary array.
    assert "['1st Floor','2nd Floor','3rd Floor'" not in QUOTE_JS

def test_calc_uses_floor_display_names():
    # Both calcPackage and calcStructure should reference the constant.
    assert QUOTE_JS.count("const fn = FLOOR_DISPLAY_NAMES;") == 2


# --- Item 2: pkgLabel removed from per-floor + basement rows in summary ---
def test_floor_row_sublabel_empty_marker_present():
    assert "// Phase 7E-A Item 2: drop pkgLabel" in QUOTE_JS

def test_basement_row_sublabel_empty():
    # The basement rows.push block should now have sublabel: '' (NOT pkgLabel).
    snippet = "    rows.push({\n      label: 'Basement',\n      // Phase 7E-A Item 2: drop pkgLabel from basement row in summary too.\n      sublabel: '',"
    assert snippet in QUOTE_JS


# --- Item 8: Coverage + Floor Area spans removed from area-page params-row ---
def test_coverage_span_removed_from_params_row():
    assert "<b>Coverage:</b> ${c.coverage}%" not in QUOTE_JS
    assert "<b>Floor Area:</b> ${ni(c.floorArea)} sq.ft" not in QUOTE_JS

def test_params_row_marker_present():
    assert "Phase 7E-A Item 8: hide Coverage % and Floor Area" in QUOTE_JS


# --- Item 9: BPF panel inherits price-override CSS ---
def test_bpf_rate_list_css_selectors_extended():
    # Each shared selector must now include #bpf-rate-list.
    expected = [
        "#area-ovr-list .aov-zone, #item-rate-list .aov-zone, #bpf-rate-list .aov-zone {",
        "#area-ovr-list .aov-zone-hdr, #item-rate-list .aov-zone-hdr, #bpf-rate-list .aov-zone-hdr {",
        "#area-ovr-list .aov-row, #item-rate-list .aov-row, #bpf-rate-list .aov-row {",
        "#area-ovr-list .aov-name, #item-rate-list .aov-name, #bpf-rate-list .aov-name {",
        "#area-ovr-list .aov-unit, #item-rate-list .aov-unit, #bpf-rate-list .aov-unit {",
        "#area-ovr-list input, #item-rate-list input, #bpf-rate-list input {",
    ]
    for s in expected:
        assert s in INDEX_HTML, f"missing CSS rule: {s[:80]}"


# --- Item 10: spec editor label renamed ---
def test_spec_editor_brand_name_label_renamed_to_rate():
    # The HTML built in JS for the editor row.
    assert '<label>Brand Name &amp; Rate ' not in QUOTE_JS
    assert '<div class="full"><label>Rate <span style="font-weight:400;color:var(--muted);">(rendered bold in PDF)</span></label><input data-f="brand_rate"' in QUOTE_JS
