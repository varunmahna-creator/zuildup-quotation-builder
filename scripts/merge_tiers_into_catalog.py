#!/usr/bin/env python3
"""
Phase 8A.2 — Merge extracted tier specs into the existing 94-item catalog.

Strategy:
- Read catalog.json (existing 94-item tier-less template, rates=0, rep edits manually)
- Read extracted_specs_by_tier.json (3 tiers × ~85 items with rate_text + description)
- Match items by label normalization (lowercase, strip punctuation)
- For each catalog item, add a `tiers` block:
    {
      "basic":      { "rate": float|null, "rate_text": "...", "unit": "...", "brand": "...", "spec": "..." },
      "mid_luxury": { ... },
      "luxury":     { ... }
    }
- Also add top-level `zones` and `fixed_costs` blocks (zone A/B/C/D/E rates + lift_machine).
- Output catalog/catalog.tiered.json (NEW FILE — does NOT overwrite existing catalog.json)

Modularity preserved: each item keeps its original `rate=0`, `description`, etc. The `tiers`
block is purely additive — current code that reads catalog.json continues to work; new code
that wants tier defaults reads the new `tiers` block.
"""
import json, re, os
from pathlib import Path

ROOT = Path('/opt/openclaw/workspace/zuildup/quotation-builder')
CAT_IN = ROOT / 'catalog' / 'catalog.json'
SPECS_IN = ROOT / 'reference_quotes' / 'extracted_specs_by_tier.json'
CAT_OUT = ROOT / 'catalog' / 'catalog.tiered.json'

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

def normalize(s):
    """Normalize an item label for matching."""
    s = s.lower()
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    s = s.strip()
    return s

def parse_rate(rate_text):
    """Parse '₹25,000 per Bathroom' → (25000.0, 'per_bathroom').
    Returns (None, 'descriptive') for '—' / empty."""
    if not rate_text or rate_text.strip() in ('—', '-', ''):
        return None, 'descriptive'
    t = rate_text.strip().replace(',', '').replace('₹', '').strip()
    m = re.match(r'^(\d+(?:\.\d+)?)\s*(?:per\s+)?(.*)$', t, re.IGNORECASE)
    if not m:
        return None, 'descriptive'
    try:
        rate = float(m.group(1))
        unit_raw = m.group(2).strip().lower()
        unit_map = {
            'sq ft': 'per_sqft', 'sqft': 'per_sqft', 'sq.ft': 'per_sqft',
            'bathroom': 'per_bathroom', 'kitchen': 'per_kitchen',
            'door': 'per_door', 'window': 'per_window', 'floor': 'per_floor',
            'l': 'per_litre', 'litre': 'per_litre', 'liter': 'per_litre',
            'rft': 'per_running_ft', 'running ft': 'per_running_ft',
            '': 'lump_sum',
        }
        unit = unit_map.get(unit_raw, f'per_{unit_raw.replace(" ", "_")}' if unit_raw else 'lump_sum')
        return rate, unit
    except ValueError:
        return None, 'descriptive'

def split_brand_spec(description, item_label):
    """Heuristic: first non-empty line is brand IF it looks like a brand catalog string.
    Brand string = SHORT (≤40 chars), no spec-sentence verbs, no measurement/size patterns,
    typically Title Case proper nouns possibly slash-separated."""
    if not description:
        return '', ''
    lines = [l.strip() for l in description.split('\n') if l.strip()]
    if not lines:
        return '', ''
    first = lines[0]
    # Reject if too long
    if len(first) > 40:
        return '', '\n'.join(lines)
    # Reject if ends with period/colon
    if first.endswith('.') or first.endswith(':'):
        return '', '\n'.join(lines)
    # Reject if has spec-sentence verbs/markers
    SPEC_MARKERS = [
        r'\b(is|are|will|shall|would|to be|including|includes|provided|installed|installation)\b',
        r'\bsizes?:?\b', r'\bup to\b', r'\bmaximum\b', r'\bminimum\b',
        r'\bthick\b', r'\bthickness\b', r'\bmm\b', r'\binch\b', r'\bfor (the )?[a-z]',
        r'\baccessories\b', r'\bensure\b', r'\bproper\b', r'\bquality\b',
        r'\b(with|using|from|for)\b.*\b(brand|finish|cement|design)\b',
    ]
    low = first.lower()
    for pat in SPEC_MARKERS:
        if re.search(pat, low):
            return '', '\n'.join(lines)
    # Reject "Provision for ..." kind of phrases
    if low.startswith('provision') or low.startswith('site ') or low.startswith('done '):
        return '', '\n'.join(lines)
    # Reject if first char not uppercase
    if not first[0].isupper():
        return '', '\n'.join(lines)
    return first, '\n'.join(lines[1:])

def main():
    cat = json.load(CAT_IN.open())
    specs = json.load(SPECS_IN.open())

    items = cat['items']
    print(f"Catalog: {len(items)} items")
    for tier in ('basic', 'mid_luxury', 'luxury'):
        print(f"Specs[{tier}]: {len(specs[tier])} items")

    # Build normalized spec lookups per tier
    spec_lookup = {}
    for tier in ('basic', 'mid_luxury', 'luxury'):
        spec_lookup[tier] = {normalize(k): (k, v) for k, v in specs[tier].items()}

    matched = 0
    unmatched_per_tier = {'basic': [], 'mid_luxury': [], 'luxury': []}
    enriched_items = []

    for item in items:
        label = item['label']
        norm = normalize(label)
        tiers_block = {}
        any_match = False
        for tier in ('basic', 'mid_luxury', 'luxury'):
            # Direct match
            hit = spec_lookup[tier].get(norm)
            if not hit:
                # Fuzzy: token-overlap match (avoid false positives like basement.flooring → ceiling fans)
                norm_tokens = set(norm.split())
                best = None
                best_overlap = 0
                for k, v in spec_lookup[tier].items():
                    k_tokens = set(k.split())
                    overlap = len(norm_tokens & k_tokens)
                    min_required = 2 if len(norm_tokens) >= 2 else 1
                    if overlap >= min_required and overlap > best_overlap:
                        if abs(len(norm) - len(k)) < 15:
                            best = (v[0], v[1])
                            best_overlap = overlap
                if best:
                    hit = best
            if hit:
                spec_key, spec_val = hit
                rate, unit = parse_rate(spec_val['rate_text'])
                brand, spec_text = split_brand_spec(spec_val['description'], label)
                tiers_block[tier] = {
                    'rate': rate,
                    'rate_text': spec_val['rate_text'],
                    'unit': unit,
                    'brand': brand,
                    'spec': spec_text,
                    'source_label': spec_key,
                }
                any_match = True
            else:
                tiers_block[tier] = None
                unmatched_per_tier[tier].append(label)
        if any_match:
            matched += 1
        new_item = dict(item)
        new_item['tiers'] = tiers_block
        enriched_items.append(new_item)

    out = {
        '_meta': {
            **cat.get('_meta', {}),
            'phase_8a_tiered': '2026-05-18',
            'schema': 'tier-less catalog (existing) PLUS additive tiers block per item + top-level zones + fixed_costs',
            'tiers_added': ['basic', 'mid_luxury', 'luxury'],
            'sources': ['reference_quotes/basic.pdf', 'reference_quotes/mid_luxury.pdf', 'reference_quotes/luxury.pdf'],
            'items_matched': matched,
            'items_total': len(items),
        },
        'zones': ZONES,
        'fixed_costs': FIXED,
        'items': enriched_items,
    }

    CAT_OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"\n✓ Written: {CAT_OUT}")
    print(f"✓ Matched {matched}/{len(items)} catalog items to spec data")

    # Report unmatched items (only the ones missing in ALL 3 tiers)
    truly_unmatched = []
    for item in items:
        norm = normalize(item['label'])
        if all(not (norm in spec_lookup[t] or any(norm in k or k in norm for k in spec_lookup[t])) for t in ('basic', 'mid_luxury', 'luxury')):
            truly_unmatched.append(item['label'])
    print(f"\nCatalog items with NO match in any tier: {len(truly_unmatched)}")
    for x in truly_unmatched[:20]:
        print(f"  - {x}")
    if len(truly_unmatched) > 20:
        print(f"  ... and {len(truly_unmatched) - 20} more")

    # Spec items present in PDFs but NOT in catalog (potential new line items)
    cat_norms = {normalize(i['label']) for i in items}
    spec_extras = {}
    for tier in ('basic', 'mid_luxury', 'luxury'):
        for k in spec_lookup[tier]:
            if k not in cat_norms and not any(k in cn or cn in k for cn in cat_norms if cn):
                spec_extras.setdefault(k, []).append(tier)
    print(f"\nSpec items in PDFs but NOT in catalog: {len(spec_extras)}")
    for k, tiers in list(spec_extras.items())[:15]:
        print(f"  - [{','.join(tiers)}] {k}")

if __name__ == '__main__':
    main()
