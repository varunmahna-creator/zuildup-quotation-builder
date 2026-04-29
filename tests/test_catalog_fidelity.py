"""P1.3 — Inverted Catalog Fidelity Guard (subtractive pivot).

The architectural rule (Varun, 2026-04-28): "No spec cost or description should be
hardcoded." The catalog is a TEMPLATE/DICTIONARY (item set, categories, canonical
labels, suggested brands as hints) — pricing is per-quote, set by sales via
`state.rows[].override`.

This test enforces that rule as a regression guard: every catalog item must have
`rate == 0` and `rate_text == ""`. If a future change accidentally re-introduces
hardcoded pricing in the catalog (via OVERRIDES, parse_rate output, etc.), this
test fails loudly.

History:
  - P1.2 introduced an *additive* fidelity test that asserted 24 audit items had
    cap-bearing text in `rate_text + description`. That test was correct under
    the catalog-as-truth model.
  - P1.3 deleted that model. Catalog = structure, quote = values. So this test
    is the *negative* of P1.2's: zero items may have hardcoded prices.

Run: `python3 tests/test_catalog_fidelity.py` from repo root.
"""
import json
import sys
from pathlib import Path

QB = Path(__file__).parent.parent
CAT = json.load(open(QB / "catalog/catalog.json"))
items = CAT["items"]

failures = []

# 1. Zero items should have a non-zero rate.
items_with_rate = [i for i in items if i.get("rate", 0) not in (0, None)]
if items_with_rate:
    failures.append(
        f"HARDCODED_PRICE: {len(items_with_rate)} item(s) have non-zero `rate`. "
        f"Catalog must be template-only; pricing belongs in per-row overrides. "
        f"Offenders (first 5): " + ", ".join(i["id"] for i in items_with_rate[:5])
    )

# 2. Zero items should have a non-empty rate_text.
items_with_rate_text = [i for i in items if (i.get("rate_text") or "").strip()]
if items_with_rate_text:
    failures.append(
        f"HARDCODED_PRICE_TEXT: {len(items_with_rate_text)} item(s) have non-empty `rate_text`. "
        f"Catalog must be template-only; rate_text belongs in per-row overrides. "
        f"Offenders (first 5): " + ", ".join(
            f"{i['id']}='{(i.get('rate_text') or '')[:40]}'" for i in items_with_rate_text[:5]
        )
    )

# 3. Every item must have stable structural fields (id, category, label, scope, description).
for it in items:
    for fld in ("id", "category", "category_label", "label", "scope"):
        if not it.get(fld):
            failures.append(f"MISSING_STRUCTURE: {it.get('id', '???')} missing required field '{fld}'")

# 4. Schema must declare the template/dictionary intent.
schema_decl = (CAT.get("_meta", {}).get("schema") or "").lower()
if "template" not in schema_decl and "dictionary" not in schema_decl:
    failures.append(
        f"SCHEMA_DRIFT: catalog._meta.schema does not declare template/dictionary intent. "
        f"Got: '{CAT['_meta'].get('schema')}'"
    )
# 5. P1.5.1 — descriptions must NOT contain rate/price prose.
#    Catalog describes WHAT items are. HOW MUCH lives in per-quote overrides.
#
# Regex note: the original brief specified `[\d,]+` for the digit class.
# That is a defect — `,` alone matches, so prose like "doors, ensuring"
# falsely matches "rs,". We tighten to require at least one actual digit.
import re as _re
_PROSE_RATE_RE = _re.compile(
    r'(Rs\.?\s*\d[\d,]*|₹\s*\d[\d,]*|INR\s+\d[\d,]*|upto\s+INR)',
    _re.IGNORECASE,
)
prose_violations = []
for it in items:
    desc = it.get("description") or ""
    m = _PROSE_RATE_RE.search(desc)
    if m:
        prose_violations.append((it["id"], m.group(0), desc[:80]))
if prose_violations:
    failures.append(
        f"PROSE_RATE: {len(prose_violations)} item(s) have rate/price prose in description. "
        f"Catalog must describe WHAT, not HOW MUCH. "
        f"Offenders (first 5): " + ", ".join(
            f"{i}='{m}'" for i, m, _ in prose_violations[:5]
        )
    )

# Summary
total = len(items)
items_with_brand_suggestions = sum(1 for i in items if i.get("brands"))
print(f"Catalog: {total} items.")
print(f"  items with hardcoded rate>0 : {len(items_with_rate)}  (target: 0)")
print(f"  items with hardcoded rate_text: {len(items_with_rate_text)}  (target: 0)")
print(f"  items with brand suggestions : {items_with_brand_suggestions}  (informational; surfaced as hints in edit panel)")
print(f"  schema declared              : {CAT['_meta'].get('schema')!r}")
print(f"  items with prose rates       : {len(prose_violations)}  (target: 0)")
print(f"")
print(f"Failures: {len(failures)}")
for f in failures:
    print(f"  - {f}")

if failures:
    sys.exit(1)

print("PASS \u2705 — catalog is template-only; all pricing flows from per-row overrides.")
sys.exit(0)
