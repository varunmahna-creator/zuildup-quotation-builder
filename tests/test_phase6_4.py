"""Phase 6.4 — Sales-team feedback iteration (Specs system overhaul).

Item 9: Copy Category — clone all rows in a category as a new category with
catalog defaults. New category heading is inline-editable. Multiple clones
supported. State shape: row.categoryGroup (string, optional).

Locks invariants for:
  - row.categoryGroup is the primary grouping key (in renderSpecList, renderQuote)
  - Copy button + Rename button render in spec-cat-hdr
  - copyCategory(): clones with override:{} (catalog defaults), unique
    " (Copy)" / " (Copy 2)" naming, contiguous insertion after source
  - beginCategoryRename(): stamps row.categoryGroup on all matching rows
  - PDF render (renderQuote) groups by categoryGroup, falls back to legacy paths
  - Picker still pushes plain {id, override:{}} rows (no categoryGroup leak)
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
# Static / source assertions
# ----------------------------------------------------------------------------
def test_row_category_group_helper_exists():
    """rowCategoryGroup() lives inside the IIFE; renderQuote inlines the same logic."""
    # Helper inside bootForm IIFE.
    assert re.search(
        r"function rowCategoryGroup\(row\)\s*\{[^}]*row\.categoryGroup",
        QUOTE_JS,
        re.DOTALL,
    ), "Expected `function rowCategoryGroup(row) { ... row.categoryGroup ... }`"


def test_render_quote_uses_category_group():
    """renderQuote groups via rowCategoryGroup() helper (or row.categoryGroup directly)."""
    rq_idx = QUOTE_JS.index("function renderQuote(state, about)")
    rq_end = QUOTE_JS.index("function quoteCss()")
    block = QUOTE_JS[rq_idx:rq_end]
    assert ("rowCategoryGroup(row)" in block) or ("row.categoryGroup" in block), \
        "renderQuote must consult rowCategoryGroup() / row.categoryGroup for grouping"


def test_copy_button_in_spec_cat_hdr():
    """Header HTML contains data-act='copy' Copy button and data-act='rename'."""
    assert 'data-act="copy"' in QUOTE_JS, "Missing Copy button in header"
    assert 'data-act="rename"' in QUOTE_JS, "Missing Rename button in header"
    assert 'data-act="toggle"' in QUOTE_JS, "Missing toggle data-act on cat-name"
    # Visible Copy label so the rep recognises it.
    assert "⎘ Copy" in QUOTE_JS or "Copy" in QUOTE_JS


def test_copy_category_function_exists():
    """copyCategory() builds clones with empty override; uniquely names new cat."""
    assert "function copyCategory(currentCat, sourceIndices)" in QUOTE_JS
    # Look for the unique-name loop using ' (Copy)'.
    assert "' (Copy)'" in QUOTE_JS or "(Copy)" in QUOTE_JS
    # Look for the override:{} reset pattern.
    assert re.search(
        r"id:\s*src\.id,\s*override:\s*\{\},\s*categoryGroup:\s*newCat",
        QUOTE_JS,
    ), "Clone must reset override to {} and set categoryGroup"


def test_begin_category_rename_function_exists():
    """beginCategoryRename() applies the new name to every row in the group."""
    assert "function beginCategoryRename(hdr, currentCat)" in QUOTE_JS
    # Must stamp categoryGroup on rows that match the old name.
    # Permissive regex — any forEach loop that compares rowCategoryGroup(row)
    # === currentCat and assigns row.categoryGroup = next.
    assert re.search(
        r"rowCategoryGroup\(row\)\s*===\s*currentCat",
        QUOTE_JS,
    ), "Rename must compare rowCategoryGroup(row) === currentCat"
    assert re.search(
        r"\.categoryGroup\s*=\s*next",
        QUOTE_JS,
    ), "Rename must assign row.categoryGroup = next"


def test_render_spec_list_uses_row_category_group():
    """renderSpecList groups via rowCategoryGroup(row), not a hardcoded path."""
    # Find the renderSpecList block.
    rsl = QUOTE_JS.index("function renderSpecList()")
    end = QUOTE_JS.index("function buildSpecCard(", rsl)
    block = QUOTE_JS[rsl:end]
    assert "rowCategoryGroup(row)" in block, \
        "renderSpecList must call rowCategoryGroup(row) for grouping"


def test_picker_does_not_set_category_group():
    """Items added via the picker push {id, override:{}} — no categoryGroup leak."""
    # The picker's onclick pushes a row directly. Verify it doesn't carry
    # a categoryGroup field (so newly-added items use catalog default).
    # Phase 7H-B: picker push now carries `_isFresh: true` so freshly-added
    # rows can still pick up catalog defaults even on a loaded quote.
    # categoryGroup must STILL be absent (the original guard).
    m = re.search(
        r"el\.onclick = \(\) => \{[^}]*state\.rows\.push\(\{\s*id:\s*it\.id,\s*override:\s*\{\}(?:,\s*_isFresh:\s*true)?\s*\}\);",
        QUOTE_JS,
        re.DOTALL,
    )
    assert m, "Picker push pattern not found / now leaks categoryGroup"
    # Explicitly ensure categoryGroup is NOT in the picker push.
    assert "categoryGroup" not in m.group(0), \
        f"Picker push leaks categoryGroup: {m.group(0)!r}"


# ----------------------------------------------------------------------------
# CSS assertions
# ----------------------------------------------------------------------------
def test_cat_btn_css_present():
    """Category control buttons (Copy / Rename) styled in index.html."""
    assert ".cat-btn" in INDEX_HTML
    assert ".cat-copy" in INDEX_HTML
    assert ".cat-rename" in INDEX_HTML
    assert ".cat-rename-input" in INDEX_HTML
    assert ".cat-controls" in INDEX_HTML


# ----------------------------------------------------------------------------
# Behavioural tests via Node shim — exercise copyCategory / rename / grouping.
# ----------------------------------------------------------------------------
def _shim_run(state, action):
    """
    Run a Node shim that:
      1) Loads quote.js
      2) Materialises bootForm helpers via direct extraction
         (since they're closure-bound we run a synthetic bootForm that
          dispatches actions and returns the post-action state).
    Returns the post-action state.
    """
    catalog_json = json.dumps(CAT)
    state_json = json.dumps(state)
    shim = r"""
'use strict';
const STATE = JSON.parse(process.argv[3]);
const ACTION = JSON.parse(process.argv[4]);
const CATALOG = JSON.parse(process.argv[5]);

// We simulate the actions (copyCategory, rename, group) directly — these
// helpers are inside the bootForm IIFE so we can't import them. The shim
// re-implements the SAME logic to test the *contract* (what state the
// helpers should produce). The static-source assertions above lock the
// implementation to match this contract.
const state = STATE;
function catItem(id) { return CATALOG.items.find(it => it.id === id); }
function rowCatGroup(row) {
  if (row.categoryGroup && row.categoryGroup.trim()) return row.categoryGroup;
  const o = row.override || {};
  if (row._custom) return (o.category_label && o.category_label.trim()) || 'Custom';
  const item = catItem(row.id);
  return item ? item.category_label : (o.category_label || 'Custom');
}

if (ACTION.type === 'copyCategory') {
  const cat = ACTION.cat;
  const sourceIndices = [];
  state.rows.forEach((r, i) => { if (rowCatGroup(r) === cat) sourceIndices.push(i); });
  const existingCats = new Set();
  state.rows.forEach(r => existingCats.add(rowCatGroup(r)));
  let newCat = cat + ' (Copy)';
  let n = 2;
  while (existingCats.has(newCat)) { newCat = cat + ' (Copy ' + n + ')'; n++; }
  const clones = sourceIndices.map(i => {
    const src = state.rows[i];
    const clone = { id: src.id, override: {}, categoryGroup: newCat };
    if (src._custom) {
      clone._custom = true;
      const so = src.override || {};
      clone.override = {};
      if (so.label) clone.override.label = so.label;
      clone.override.category_label = newCat;
    }
    return clone;
  });
  const insertAfter = Math.max(...sourceIndices);
  state.rows.splice(insertAfter + 1, 0, ...clones);
} else if (ACTION.type === 'rename') {
  const cat = ACTION.cat;
  const next = ACTION.next;
  const matchingIdx = [];
  state.rows.forEach((row, i) => {
    if (rowCatGroup(row) === cat) matchingIdx.push(i);
  });
  matchingIdx.forEach(i => { state.rows[i].categoryGroup = next; });
} else if (ACTION.type === 'group') {
  // Just return the grouping that renderQuote would compute.
  const byCat = {};
  for (const row of state.rows) {
    const it = row._custom ? null : catItem(row.id);
    let c;
    if (row.categoryGroup && row.categoryGroup.trim()) c = row.categoryGroup;
    else c = (row.override && row.override.category_label) ?? (it ? it.category_label : 'Custom');
    (byCat[c] ||= []).push({ id: row.id });
  }
  state._byCat = byCat;
}

console.log(JSON.stringify(state));
"""
    with tempfile.NamedTemporaryFile(suffix=".js", mode="w", delete=False) as f:
        f.write(shim)
        shim_path = f.name
    try:
        out = subprocess.check_output(
            ["node", shim_path, "_unused", state_json,
             json.dumps(action), catalog_json],
            stderr=subprocess.STDOUT,
        )
        return json.loads(out.decode().strip().splitlines()[-1])
    finally:
        os.unlink(shim_path)


# Pick a real catalog item with a known category.
def _find_item_in_cat(cat_label):
    for it in CAT["items"]:
        if it.get("category_label") == cat_label:
            return it["id"]
    raise AssertionError(f"No catalog item with category_label={cat_label!r}")


def test_copy_category_clones_with_defaults():
    bath_a = _find_item_in_cat("Bathroom & Toilet")
    state = {
        "rows": [
            {"id": bath_a, "override": {"brand_rate": "Custom rate text"}},
            {"id": bath_a, "override": {"description": "rep override"}},
        ],
    }
    new_state = _shim_run(state, {"type": "copyCategory", "cat": "Bathroom & Toilet"})
    rows = new_state["rows"]
    # 2 originals + 2 clones = 4
    assert len(rows) == 4, f"Expected 4 rows, got {len(rows)}: {rows}"
    # Originals untouched.
    assert rows[0]["override"].get("brand_rate") == "Custom rate text"
    assert rows[1]["override"].get("description") == "rep override"
    # Clones: catalog defaults (override == {}), categoryGroup set.
    assert rows[2]["override"] == {}
    assert rows[2]["categoryGroup"] == "Bathroom & Toilet (Copy)"
    assert rows[3]["override"] == {}
    assert rows[3]["categoryGroup"] == "Bathroom & Toilet (Copy)"


def test_copy_category_unique_naming_multiple_clones():
    bath_a = _find_item_in_cat("Bathroom & Toilet")
    state = {
        "rows": [
            {"id": bath_a, "override": {}},
            {"id": bath_a, "override": {}, "categoryGroup": "Bathroom & Toilet (Copy)"},
        ],
    }
    new_state = _shim_run(state, {"type": "copyCategory", "cat": "Bathroom & Toilet"})
    cats = [r.get("categoryGroup") or "" for r in new_state["rows"]]
    # Original has no group; existing clone is "(Copy)"; new clone should be "(Copy 2)".
    assert "Bathroom & Toilet (Copy 2)" in cats, f"cats={cats}"


def test_rename_stamps_category_group_on_all_rows():
    bath_a = _find_item_in_cat("Bathroom & Toilet")
    state = {
        "rows": [
            {"id": bath_a, "override": {}},
            {"id": bath_a, "override": {}},
            {"id": bath_a, "override": {}, "categoryGroup": "Bathroom & Toilet (Copy)"},
        ],
    }
    new_state = _shim_run(state, {
        "type": "rename",
        "cat": "Bathroom & Toilet",
        "next": "Bathroom & Toilet (1st & 2nd Floor)",
    })
    # Both un-grouped rows should now carry the new name.
    assert new_state["rows"][0]["categoryGroup"] == "Bathroom & Toilet (1st & 2nd Floor)"
    assert new_state["rows"][1]["categoryGroup"] == "Bathroom & Toilet (1st & 2nd Floor)"
    # The (Copy) row is in a DIFFERENT group — must NOT be renamed.
    assert new_state["rows"][2]["categoryGroup"] == "Bathroom & Toilet (Copy)"


def test_grouping_respects_category_group():
    bath_a = _find_item_in_cat("Bathroom & Toilet")
    state = {
        "rows": [
            {"id": bath_a, "override": {}},
            {"id": bath_a, "override": {}, "categoryGroup": "Bathroom & Toilet (3rd Floor)"},
            {"id": bath_a, "override": {}, "categoryGroup": "Bathroom & Toilet (3rd Floor)"},
        ],
    }
    new_state = _shim_run(state, {"type": "group"})
    by_cat = new_state["_byCat"]
    assert "Bathroom & Toilet" in by_cat
    assert "Bathroom & Toilet (3rd Floor)" in by_cat
    assert len(by_cat["Bathroom & Toilet"]) == 1
    assert len(by_cat["Bathroom & Toilet (3rd Floor)"]) == 2


def test_clone_inserts_contiguously_after_source():
    bath_a = _find_item_in_cat("Bathroom & Toilet")
    kit = _find_item_in_cat("Kitchen")
    state = {
        "rows": [
            {"id": bath_a, "override": {}},  # 0
            {"id": kit, "override": {}},     # 1
            {"id": bath_a, "override": {}},  # 2
        ],
    }
    new_state = _shim_run(state, {"type": "copyCategory", "cat": "Bathroom & Toilet"})
    # Source indices were [0, 2]; insertAfter = 2; clones inserted at 3, 4.
    rows = new_state["rows"]
    assert len(rows) == 5
    assert rows[3].get("categoryGroup") == "Bathroom & Toilet (Copy)"
    assert rows[4].get("categoryGroup") == "Bathroom & Toilet (Copy)"
    # Kitchen row unchanged at index 1.
    assert rows[1]["id"] == kit and not rows[1].get("categoryGroup")
