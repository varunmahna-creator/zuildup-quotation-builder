#!/usr/bin/env python3
"""
Phase 8A — Extract tier-specific rates + brands from 3 reference PDF text dumps.
Output: catalog/catalog.tiered.json (existing 94-item catalog + new `tiers` block per item + top-level `zones`/`fixed_costs`).
Validates by recomputing the 3 PDF totals from zones+lift+E and comparing to extracted totals.
"""
import json, re, os, sys
from pathlib import Path

ROOT = Path('/opt/openclaw/workspace/zuildup/quotation-builder')
REF = ROOT / 'reference_quotes'
CAT_IN = ROOT / 'catalog' / 'catalog.json'
CAT_OUT = ROOT / 'catalog' / 'catalog.tiered.json'

# Hard-coded zone rates + fixed costs — extracted by manual review of Cost Calculation pages.
ZONES = {
    'A': {'basic': 2300, 'mid_luxury': 2850, 'luxury': 3850, 'unit': 'per_sqft',
          'applies_to': 'covered area incl lift+staircase'},
    'B': {'basic': 1200, 'mid_luxury': 1425, 'luxury': 1925, 'unit': 'per_sqft',
          'applies_to': 'semi-covered (stilt, balcony, staircase)'},
    'C': {'basic': 600, 'mid_luxury': 600, 'luxury': 600, 'unit': 'per_sqft',
          'applies_to': 'open (terrace, ramp, setback)'},
    'D': {'basic': 15, 'mid_luxury': 25, 'luxury': 25, 'unit': 'per_litre',
          'applies_to': 'underground water tank capacity'},
    'E': {'basic': None, 'mid_luxury': 500000, 'luxury': 1000000, 'unit': 'lump_sum',
          'applies_to': 'elevation wallet'},
}
FIXED = {
    'lift_machine': {'basic': 1000000, 'mid_luxury': 1000000, 'luxury': 1350000, 'unit': 'lump_sum'},
}

# Expected totals (from PDFs, used for validation)
PDF_TOTALS = {
    'basic': {'zone_A': 11385000, 'zone_B': 3378000, 'zone_C': 938400, 'zone_D': 120000, 'zone_E': 0,
              'subtotal': 15821400, 'lift': 1000000, 'construction_total': 16821400},
    'mid_luxury': {'zone_A': 14107500, 'zone_B': 3954375, 'zone_C': 938400, 'zone_D': 200000, 'zone_E': 500000,
              'subtotal': 19700275, 'lift': 1000000, 'construction_total': 20700275},
    'luxury': {'zone_A': 19057500, 'zone_B': 5418875, 'zone_C': 938400, 'zone_D': 200000, 'zone_E': 1000000,
              'subtotal': 26614775, 'lift': 1350000, 'construction_total': 27964775},
}

# Sample plot used in all 3 PDFs
SAMPLE_PLOT = {
    'plot_sqyd': 170, 'plot_dims': '27x57',
    'floors': 'Stilt + 4',
    'zone_A_area': 4950.0,   # G+1+2+3 (1200 each) + lift 150
    'zone_B_area_basic': 2815.0,  # stilt 1200 + balcony 865 + staircase 750
    'zone_B_area_mid': 2775.0,    # stilt 1160 (mid uses 1160, not 1200) — discrepancy noted
    'zone_B_area_lux': 2815.0,    # luxury uses 1200 again
    'zone_C_area': 1564.0,   # terrace 1267 + ramp 135 + setback 162
    'zone_D_litres': 8000,
    'lift_yes': True,
}

def parse_rate_field(text):
    """Parse a rate field like '₹25,000 per Bathroom' or '₹50 per sq ft' or '—'.
    Returns (numeric_rate or None, unit_string).
    """
    if not text or text.strip() in ('—', '-', ''):
        return None, 'descriptive'
    t = text.strip().replace(',', '').replace('₹', '').strip()
    m = re.match(r'^(\d+(?:\.\d+)?)\s*(?:per\s+)?(.*)$', t, re.IGNORECASE)
    if m:
        try:
            rate = float(m.group(1))
            unit_raw = m.group(2).strip().lower()
            unit_map = {
                'sq ft': 'per_sqft', 'sqft': 'per_sqft', 'sq.ft': 'per_sqft',
                'bathroom': 'per_bathroom', 'kitchen': 'per_kitchen',
                'door': 'per_door', 'window': 'per_window',
                'floor': 'per_floor', 'l': 'per_litre', 'litre': 'per_litre',
                'rft': 'per_running_ft', 'running ft': 'per_running_ft',
                'lump sum': 'lump_sum', '': 'lump_sum',
            }
            unit = unit_map.get(unit_raw, f'per_{unit_raw}' if unit_raw else 'lump_sum')
            return rate, unit
        except ValueError:
            return None, 'descriptive'
    return None, 'descriptive'

def extract_specs(txt_path):
    """Parse the 'Detailed Specifications' section of a tier's text dump.
    Returns dict {item_label_normalized: (rate_text, raw_brand_desc)}
    """
    text = txt_path.read_text()
    # Find start of Detailed Specifications
    start = text.find('Detailed Specifications')
    if start < 0:
        start = text.find('S T E P  3')
    specs_text = text[start:]
    # Each category section has structure:
    # CategoryName\n N  I T E M S\n ITEM\n RATE\n DESCRIPTION\n
    # Then triples: item_name \n rate \n description (multiline)
    # We'll split by lines and walk forward.
    lines = [l.rstrip() for l in specs_text.split('\n')]
    items = {}
    i = 0
    # Skip header
    while i < len(lines) and 'DESCRIPTION' not in lines[i]:
        i += 1
    i += 1
    while i < len(lines):
        # Skip blank lines & section headers
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        # Detect new category page (e.g. "Bathroom & Toilet" followed by " N  I T E M S")
        if i + 1 < len(lines) and re.match(r'^\d+\s+I T E M S\s*$', lines[i+1].strip()):
            # category header, skip 4 lines (cat name, items count, ITEM, RATE then DESCRIPTION)
            # walk to DESCRIPTION line
            j = i
            while j < len(lines) and 'DESCRIPTION' not in lines[j]:
                j += 1
            i = j + 1
            continue
        # Detect page footer
        if 'I N F O @ Z U I L D U P' in line or '=== PAGE' in line or line.startswith('ZuildUp'):
            i += 1
            continue
        # Skip "S T E P 3" / "D E TA I L E D" decorative
        if re.match(r'^[A-Z]( [A-Z])+$', line) or 'S T E P' in line:
            i += 1
            continue
        # This line should be an item name
        item_name = line
        # Some item names span 2 lines (e.g. "PCC in Foundation / Stilt and\nTerrace")
        if i + 1 < len(lines) and lines[i+1].strip() and not lines[i+1].strip().startswith('₹') and lines[i+1].strip() != '—':
            # Heuristic: if next line is short and not a rate, append to item name
            nxt = lines[i+1].strip()
            if (re.match(r'^[A-Z][a-z]', nxt) or nxt.startswith('and ') or nxt.startswith('& ')) and len(nxt) < 40 and not any(c in nxt for c in ('per ', '/sq', 'mm', 'inch')):
                # Heuristic continuation
                # But careful: most cases next line IS the rate. Don't join unless clear.
                pass
        # Next line should be RATE
        if i + 1 >= len(lines):
            break
        rate = lines[i+1].strip()
        # Description: collect until next item name pattern
        desc_lines = []
        j = i + 2
        while j < len(lines):
            l = lines[j].strip()
            if not l:
                j += 1
                if j < len(lines) and lines[j].strip() and not lines[j].strip().startswith('₹') and lines[j].strip() != '—':
                    # Peek: is this another item?
                    # Check if line after THIS one looks like a rate
                    if j + 1 < len(lines):
                        nxt_rate = lines[j+1].strip()
                        if nxt_rate.startswith('₹') or nxt_rate == '—':
                            break
                continue
            # Heuristic: new item if this line is short title-case and next is a rate
            if j + 1 < len(lines):
                nxt = lines[j+1].strip()
                if (nxt.startswith('₹') or nxt == '—') and len(l) < 60 and not l[0].islower():
                    break
            # Page break / footer
            if 'I N F O @ Z U I L D U P' in l or '=== PAGE' in l or l.startswith('ZuildUp') or re.match(r'^\d+\s+I T E M S', l):
                break
            desc_lines.append(l)
            j += 1
        items[item_name] = {'rate_text': rate, 'description': '\n'.join(desc_lines).strip()}
        i = j
    return items

def main():
    print('=== Phase 8A: Extracting tier specs from 3 PDFs ===')
    specs = {}
    for tier, fname in [('basic', 'basic.txt'), ('mid_luxury', 'mid_luxury.txt'), ('luxury', 'luxury.txt')]:
        path = REF / fname
        s = extract_specs(path)
        specs[tier] = s
        print(f'{tier}: {len(s)} items parsed from spec section')
    # Sanity dump for review
    out_dbg = REF / 'extracted_specs_by_tier.json'
    out_dbg.write_text(json.dumps(specs, indent=2))
    print(f'Debug dump: {out_dbg}')

    # Validation: compute totals from zones + areas + lift + E
    print('\n=== Validation: zone-driven totals ===')
    for tier in ['basic', 'mid_luxury', 'luxury']:
        # Pick correct B area
        if tier == 'basic':
            b_area = SAMPLE_PLOT['zone_B_area_basic']
        elif tier == 'mid_luxury':
            b_area = SAMPLE_PLOT['zone_B_area_mid']
        else:
            b_area = SAMPLE_PLOT['zone_B_area_lux']
        za = SAMPLE_PLOT['zone_A_area'] * ZONES['A'][tier]
        zb = b_area * ZONES['B'][tier]
        zc = SAMPLE_PLOT['zone_C_area'] * ZONES['C'][tier]
        zd = SAMPLE_PLOT['zone_D_litres'] * ZONES['D'][tier]
        ze = ZONES['E'][tier] or 0
        lift = FIXED['lift_machine'][tier]
        sub = za + zb + zc + zd + ze
        total = sub + lift
        pdf = PDF_TOTALS[tier]
        delta_pct = abs(total - pdf['construction_total']) / pdf['construction_total'] * 100
        print(f"{tier:12}: Computed=₹{total:>12,} | PDF=₹{pdf['construction_total']:>12,} | Δ={delta_pct:.3f}%")
        # Per-zone check
        for z, val in [('A', za), ('B', zb), ('C', zc), ('D', zd), ('E', ze), ('lift', lift)]:
            pdf_key = 'lift' if z == 'lift' else f'zone_{z}'
            pdf_val = pdf[pdf_key]
            ok = '✓' if val == pdf_val else '✗'
            print(f"   {ok} Zone {z}: ₹{val:>10,} (PDF: ₹{pdf_val:>10,})")

if __name__ == '__main__':
    main()
