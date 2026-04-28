"""P1.2 — Catalog Fidelity Regression Guard.

For every catalog item that the audit (CATALOG_AUDIT_2026-04-28.md) flagged as
missing a price cap, assert the catalog now exposes the cap via rate_text.

This is the "negative-test bidirectionally" pattern that should have been in place
from day one — same pattern as the data-URL inlining negative test in P1.1.
"""
import json, re, sys
from pathlib import Path

QB = Path(__file__).parent.parent
CAT = json.load(open(QB / "catalog/catalog.json"))
items_by_id = {i["id"]: i for i in CAT["items"]}

# Audit's 24 cap-stripped items — must each now have rate_text and a sane rate.
AUDIT_REQUIRED = {
    "structure.steel":                      ("55000", "Rathi"),
    "structure.cement":                     ("380",   "Ultratech"),
    "structure.bricks":                     ("7",     "brick"),
    "bathroom.shower_partition_cubicles":   ("10,000", "bathroom"),
    "bathroom.bathroom_accessories":        ("12,000", "bathroom"),
    "bathroom.bathroom_flooring":           ("40",    "sq.ft."),
    "bathroom.cpvc_fittings":               ("20,000", "bathroom"),
    "kitchen.cpvc_fittings":                ("20,000", "bathroom"),
    "kitchen.modular_kitchen":              ("2,50,000", "kitchen"),
    "doors_windows.main_entry_door":        ("20,000", "door"),
    "doors_windows.main_door_lock":         ("12,000", "Godrej"),
    "doors_windows.terrace_door":           ("26,000", "Tata"),
    "flooring.floor_flooring":              ("250",   "sq.ft."),
    "flooring.balcony_flooring":            ("100",   "sq.ft."),
    "flooring.terrace_flooring":            ("40",    "sq.ft."),
    "flooring.lift_fa_ade":                 ("100",   "sq.ft."),
    "electrical.switch_sockets":            ("50,000", "floor"),
    "electrical.ceiling_fans":              ("1,800", "fan"),
    "electrical.pillar_fancy_light":        ("2,500", "light"),
    "water.overhead_water_tank":            ("8,500", "1000"),
    "water.water_motor":                    ("8,500", "Crompton"),
    "safety.cctv_camera":                   ("50,000", "cap"),
    "safety.video_door_phone":              ("50,000", "cap"),
    "general.staircase_balcony_railing":    ("400",   "sq.ft."),
}

failures = []
for item_id, (price_substring, marker_substring) in AUDIT_REQUIRED.items():
    item = items_by_id.get(item_id)
    if not item:
        failures.append(f"MISSING: {item_id}")
        continue
    rate_text = item.get("rate_text", "") or ""
    rate = item.get("rate", 0)
    desc = item.get("description", "") or ""
    blob = (rate_text + " " + desc).lower()
    if not rate_text:
        failures.append(f"NO rate_text: {item_id}")
        continue
    if rate == 0:
        failures.append(f"NO rate: {item_id}")
        continue
    # Check the price substring is in rate_text or description (digits-only compare too)
    digits_blob = re.sub(r"[^\d]", "", rate_text + " " + desc)
    digits_expected = re.sub(r"[^\d]", "", price_substring)
    if digits_expected not in digits_blob:
        failures.append(
            f"PRICE_MISSING: {item_id} expected '{price_substring}' not in rate_text='{rate_text}' / desc='{desc[:80]}'"
        )
        continue
    # Check the marker word is somewhere in rate_text or description
    if marker_substring.lower() not in blob:
        failures.append(
            f"MARKER_MISSING: {item_id} expected '{marker_substring}' not in rate_text+desc"
        )

# Item count check
total = len(CAT["items"])
with_rate_text = sum(1 for i in CAT["items"] if i.get("rate_text"))
print(f"Catalog: {total} items, {with_rate_text} with rate_text.")
print(f"Audit required: {len(AUDIT_REQUIRED)} items checked.")
print(f"Failures: {len(failures)}")
for f in failures:
    print(f"  - {f}")

if failures:
    sys.exit(1)
print("PASS ✅")
sys.exit(0)
