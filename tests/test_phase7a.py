"""Phase 7A — cosmetic + UI fixes (Batch A)

Locks in:
- Item 1: 'Ar.' salutation present in dropdown
- Item 6: copyCategory inserts cloned rows immediately AFTER source category,
          not at the end of state.rows (already implemented; test guards
          against regression).
- Item 7: cat-rename-input has explicit visible color/background (visibility fix)
- Item 8: cover logo size > prior baseline (size==='cover' width bumped)
- Item 9: cover tagline ends with '!'
- Item 10: 'Delhi NCR · Estd 2024' tag fully removed (no markup, no CSS rule)
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
QJS = ROOT / "app" / "quote.js"
HTML = ROOT / "app" / "index.html"


def test_item_1_ar_salutation_in_dropdown():
    s = HTML.read_text(encoding="utf-8")
    assert "<option>Ar.</option>" in s, "Architect 'Ar.' salutation missing from dropdown"
    # Other salutations preserved
    for sal in ("Mr.", "Ms.", "Mr. & Mrs.", "Dr."):
        assert f"<option>{sal}</option>" in s


def test_item_7_rename_input_has_explicit_visible_color_and_bg():
    s = HTML.read_text(encoding="utf-8")
    # Find the .cat-rename-input rule line.
    m = re.search(r"\.spec-list \.spec-cat-hdr \.cat-rename-input\s*\{([^}]+)\}", s)
    assert m, ".cat-rename-input CSS rule missing"
    body = m.group(1)
    # Must explicitly set a dark color (navy) and white background — both
    # important because the parent .cat-name has color:gold which would
    # otherwise inherit through.
    assert "color: #0A1F44" in body or "color: var(--navy)" in body, body
    assert "background: #fff" in body or "background-color: #fff" in body or "background: white" in body, body
    # text-transform must be reset (parent has uppercase).
    assert "text-transform: none" in body


def test_item_7_renaming_state_overrides_parent_overflow():
    s = HTML.read_text(encoding="utf-8")
    # When renaming, .cat-name parent must allow overflow so the input isn't clipped.
    assert ".spec-cat-hdr.renaming .cat-name" in s
    m = re.search(r"\.spec-cat-hdr\.renaming \.cat-name\s*\{([^}]+)\}", s)
    assert m
    assert "overflow: visible" in m.group(1)


def test_item_8_cover_logo_size_bumped():
    s = QJS.read_text(encoding="utf-8")
    # Width when size==='cover' must be > old baseline (220).
    m = re.search(r"const w\s*=\s*\(size===\s*'cover'\)\s*\?\s*(\d+)", s)
    assert m, "logoSvg width line not found"
    w = int(m.group(1))
    assert w >= 300, f"cover logo width should be >= 300 (was 220), got {w}"


def test_item_9_tagline_has_exclamation():
    s = QJS.read_text(encoding="utf-8")
    assert 'Don\'t just build, Zuild!' in s, "tagline must end with '!'"
    # Old period-ending must be gone.
    assert 'Don\'t just build, Zuild.</p>' not in s


def test_item_10_delhi_ncr_tag_removed():
    s = QJS.read_text(encoding="utf-8")
    assert "Delhi NCR" not in s, "Delhi NCR text still present in quote.js"
    assert "Estd 2024" not in s
    # cover-meta-tag class should be fully orphan-free (no markup, no CSS rule).
    assert "cover-meta-tag" not in s, "cover-meta-tag class still referenced (markup or CSS)"


def test_item_6_copy_category_inserts_after_source_not_at_end():
    """Smoke-test the copyCategory function via Node shim. Confirms the
    splice-after-max-source-index semantic — clones land contiguously
    after the original group, NOT appended to the end of state.rows.
    """
    shim = r"""
const fs = require('fs');
const code = fs.readFileSync('app/quote.js', 'utf8');

// We need just the copyCategory function + rowCategoryGroup helper. Both
// are defined inside bootForm()'s closure (copyCategory) and at top level
// (rowCategoryGroup). Pull them out by regex.

function extractFn(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = code.match(re);
  if (!m) throw new Error('cannot find ' + name);
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < code.length && depth > 0) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return code.slice(m.index, i);
}

const rowCatGroupSrc = extractFn('rowCategoryGroup');
const copyCatSrc = extractFn('copyCategory');

// Build a minimal harness. catalogItem stub returns label/category for ids.
const STATE = { rows: [], _uiCatOpen: {} };
function catalogItem(id) {
  if (id.startsWith('bath.')) return { id, label: id, category_label: 'Bathroom & Toilet' };
  if (id.startsWith('kitchen.')) return { id, label: id, category_label: 'Kitchen' };
  return null;
}
function flush() {}
const state = STATE;

eval(rowCatGroupSrc);
eval(copyCatSrc);

// Seed: Bathroom (3 rows) + Kitchen (2 rows) — interleaved.
state.rows = [
  { id: 'bath.tiles', override: {} },     // 0 -> Bathroom & Toilet
  { id: 'bath.fittings', override: {} },  // 1 -> Bathroom & Toilet
  { id: 'kitchen.cabinet', override: {} },// 2 -> Kitchen
  { id: 'bath.shower', override: {} },    // 3 -> Bathroom & Toilet
  { id: 'kitchen.counter', override: {} },// 4 -> Kitchen
];

const bathIndices = [0, 1, 3];
copyCategory('Bathroom & Toilet', bathIndices);

// Expectation: 3 cloned rows insert at index 4 (max source index 3, +1 = 4).
// New length = 8. Indices 4,5,6 are clones with categoryGroup='Bathroom & Toilet (Copy)'.
const r = state.rows;
const out = {
  len: r.length,
  cats: r.map(rowCategoryGroup),
  cloneCat: r[4]?.categoryGroup,
};
console.log(JSON.stringify(out));
"""
    proc = subprocess.run(
        ["node", "-e", shim],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert proc.returncode == 0, f"shim failed: {proc.stderr}"
    import json
    out = json.loads(proc.stdout.strip().splitlines()[-1])
    assert out["len"] == 8, out
    # Indices 4, 5, 6 are the clones — directly after the last source row (index 3)
    # and BEFORE the trailing kitchen row at original index 4 (now shifted to index 7).
    assert out["cats"][4] == "Bathroom & Toilet (Copy)", out
    assert out["cats"][5] == "Bathroom & Toilet (Copy)", out
    assert out["cats"][6] == "Bathroom & Toilet (Copy)", out
    # Kitchen row that was at index 4 must now be the LAST row (index 7) —
    # i.e. clones did NOT get appended after it.
    assert out["cats"][7] == "Kitchen", out
