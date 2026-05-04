"""Phase 7D — move category up/down.

A new ↑/↓ pair on each category header swaps the category with its neighbor
in the rendered order. Order is derived from first-occurrence in state.rows
(see Phase 7C), so reordering state.rows reorders BOTH the editor spec list
AND the PDF render.

We exercise the moveCategory() helper directly via a Node shim, the same
pattern as Phase 7A's copyCategory test. The shim extracts moveCategory,
rowCategoryGroup, and a stub catalogItem, then asserts:

  T1: move down on first cat — first and second cats swap
  T2: move up on second cat — same result as T1 from opposite direction
  T3: move up on first cat — no-op (boundary)
  T4: move down on last cat — no-op (boundary)
  T5: interleaved input — moveCategory still produces the correct outer
      order; the "intruder" rows stay grouped at the end of their slice.

Markup-level assertions (button rendering, disabled-at-boundary attribute)
live in the marker test below.
"""

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).parent.parent


SHIM_PRELUDE = r"""
const fs = require('fs');
const code = fs.readFileSync('app/quote.js', 'utf8');

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
const moveCatSrc = extractFn('moveCategory');

function catalogItem(id) {
  if (id.startsWith('bath.')) return { id, label: id, category_label: 'Bathroom & Toilet' };
  if (id.startsWith('kitchen.')) return { id, label: id, category_label: 'Kitchen' };
  if (id.startsWith('bed.')) return { id, label: id, category_label: 'Bedroom' };
  return null;
}
function flush() {}

eval(rowCatGroupSrc);
eval(moveCatSrc);
"""


def _run_shim(rows_init: str, action: str) -> dict:
    shim = SHIM_PRELUDE + f"""
const state = {{ rows: {rows_init}, _uiCatOpen: {{}} }};
{action}
const cats = state.rows.map(r => rowCategoryGroup(r));
console.log(JSON.stringify({{ cats, ids: state.rows.map(r => r.id) }}));
"""
    proc = subprocess.run(
        ["node", "-e", shim],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert proc.returncode == 0, f"shim failed: {proc.stderr}"
    return json.loads(proc.stdout.strip().splitlines()[-1])


def test_phase7d_move_down_swaps_first_two_categories():
    rows = (
        "[{id:'bath.tiles', override:{}},"
        " {id:'bath.fittings', override:{}},"
        " {id:'kitchen.cabinet', override:{}},"
        " {id:'kitchen.counter', override:{}}]"
    )
    out = _run_shim(rows, "moveCategory('Bathroom & Toilet', +1);")
    assert out["cats"] == [
        "Kitchen", "Kitchen", "Bathroom & Toilet", "Bathroom & Toilet"
    ], out
    # Internal order within each block preserved.
    assert out["ids"] == [
        "kitchen.cabinet", "kitchen.counter", "bath.tiles", "bath.fittings"
    ], out


def test_phase7d_move_up_is_inverse_of_move_down():
    rows = (
        "[{id:'bath.tiles', override:{}},"
        " {id:'bath.fittings', override:{}},"
        " {id:'kitchen.cabinet', override:{}},"
        " {id:'kitchen.counter', override:{}}]"
    )
    out = _run_shim(rows, "moveCategory('Kitchen', -1);")
    assert out["cats"] == [
        "Kitchen", "Kitchen", "Bathroom & Toilet", "Bathroom & Toilet"
    ], out


def test_phase7d_move_up_at_top_is_noop():
    rows = (
        "[{id:'bath.tiles', override:{}},"
        " {id:'kitchen.cabinet', override:{}}]"
    )
    out = _run_shim(rows, "moveCategory('Bathroom & Toilet', -1);")
    assert out["cats"] == ["Bathroom & Toilet", "Kitchen"], out


def test_phase7d_move_down_at_bottom_is_noop():
    rows = (
        "[{id:'bath.tiles', override:{}},"
        " {id:'kitchen.cabinet', override:{}}]"
    )
    out = _run_shim(rows, "moveCategory('Kitchen', +1);")
    assert out["cats"] == ["Bathroom & Toilet", "Kitchen"], out


def test_phase7d_three_categories_middle_moves_independently():
    rows = (
        "[{id:'bath.tiles', override:{}},"
        " {id:'kitchen.cabinet', override:{}},"
        " {id:'bed.bedframe', override:{}}]"
    )
    # Move middle category down past Bedroom.
    out = _run_shim(rows, "moveCategory('Kitchen', +1);")
    assert out["cats"] == ["Bathroom & Toilet", "Bedroom", "Kitchen"], out


def test_phase7d_interleaved_rows_swap_correctly():
    """When rows of two categories are interleaved (legacy quotes, custom rows),
    moveCategory should still produce the correct outer order: the moved
    category's rows come first as a block (insertion order preserved), the
    other category's rows next, intruders (rows from a third category)
    appended at the end of the contiguous slice.
    """
    # Bath 0,1; Kitchen at 2; Bath at 3; Kitchen at 4 — Kitchen and Bath
    # are interleaved. (No third-category intruders here, so test pure
    # interleave.)
    rows = (
        "[{id:'bath.tiles', override:{}},"
        " {id:'bath.fittings', override:{}},"
        " {id:'kitchen.cabinet', override:{}},"
        " {id:'bath.shower', override:{}},"
        " {id:'kitchen.counter', override:{}}]"
    )
    out = _run_shim(rows, "moveCategory('Bathroom & Toilet', +1);")
    # New outer order: Kitchen first (its 2 rows), Bath second (its 3 rows).
    assert out["cats"] == [
        "Kitchen", "Kitchen",
        "Bathroom & Toilet", "Bathroom & Toilet", "Bathroom & Toilet"
    ], out
    # Insertion order within each block preserved.
    assert out["ids"] == [
        "kitchen.cabinet", "kitchen.counter",
        "bath.tiles", "bath.fittings", "bath.shower"
    ], out


def test_phase7d_markers_present_in_quote_js():
    """Sanity check that the move-up/down markup made it into the bundle."""
    js = (ROOT / "app" / "quote.js").read_text()
    assert "data-act=\"move-up\"" in js
    assert "data-act=\"move-down\"" in js
    assert "function moveCategory(" in js
    assert "cat-move-up" in js
    assert "cat-move-down" in js


def test_phase7d_disabled_at_boundary_in_markup():
    """First category gets ↑ disabled, last category gets ↓ disabled.
    The header builder uses `${isFirst ? ' disabled' : ''}`, so we just
    check the source has the boundary guard.
    """
    js = (ROOT / "app" / "quote.js").read_text()
    assert "isFirst ? ' disabled' : ''" in js
    assert "isLast ? ' disabled' : ''" in js


def test_phase7d_css_present_in_index_html():
    html = (ROOT / "app" / "index.html").read_text()
    assert ".cat-btn.cat-move" in html
    assert "cat-move[disabled]" in html
