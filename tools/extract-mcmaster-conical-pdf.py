"""Turn McMaster-Carr's conical ("Tight-Space") compression-spring PDF into rows.

Usage:
    pip install pdfplumber
    python3 tools/extract-mcmaster-conical-pdf.py listing.pdf

A conical spring is listed with two of every diameter -- OD and ID at the large
end (A) and at the small end (B) -- because it tapers. Only OD(A) is the
envelope the spring has to fit inside, so that is what becomes od_mm; the rest
is kept alongside it rather than averaged away.

The vendor's arithmetic check used on the cylindrical listings is deliberately
NOT applied here. A conical spring's coils nest as it compresses, so its rate is
not constant and rate x travel is not supposed to reproduce the max load.
"""
import re, json, sys, collections

IN = r'(?:[\d.,]+"|—)'
LOAD = r'(?:[\d.,]+\s*lb\.|Not Rated)'
NUM = r'[\d.,]+'
END = r'(?:Closed and Ground|Closed|Open and Ground|Open)'
PART = r'\d{3,}[A-Z]\d[0-9A-Z]*'
PRICE = r'(?:\$?[\d,]+\.\d{2})'

ROW = re.compile(
    rf'^({IN})\s+({IN})\s+({IN})\s+({IN})\s+({IN})\s+({IN})\s+({IN})\s+'
    rf'({LOAD})\s+({NUM})\s+({END})\s+(\d+)\s+({PART})\s*({PRICE})?$')

FAMILY = 'Tight-Space Compression Springs'
MATERIAL_HEADINGS = {
    'Corrosion-Resistant 302 Stainless Steel': '302 Stainless Steel',
    'Highly Corrosion-Resistant 316 Stainless Steel': '316 Stainless Steel',
    'Spring Steel': 'Spring Steel',
    'Music Wire': 'Music Wire',
}


def dim(v):
    if v is None or v.strip() in ('—', '', '-'): return None
    return float(v.replace('"', '').replace(',', ''))


def load_lb(v):
    if v is None or 'Not Rated' in v: return None
    m = re.search(r'[\d.,]+', v)
    return float(m.group().replace(',', '')) if m else None


def parse(path):
    lines = [l.split('\t', 1) for l in open(path) if '\t' in l]
    lines = [(int(a), b.rstrip()) for a, b in lines if a.isdigit()]
    mat = None
    out, failed = [], []
    for pg, line in lines:
        t = line.strip()
        if t in MATERIAL_HEADINGS:
            mat = MATERIAL_HEADINGS[t]
            continue
        if not re.match(r'^[\d.]+"', t): continue
        m = ROW.match(t)
        if not m:
            failed.append((pg, t)); continue
        (lg, odA, odB, idA, idB, wd, comp, mload, rate, end, qty, part, price) = m.groups()
        out.append({
            'family': FAMILY, 'shape': 'conical', 'material': mat, 'page': pg,
            'freeLength': dim(lg),
            'od': dim(odA), 'odSmall': dim(odB),
            'id': dim(idA), 'idSmall': dim(idB),
            'wireDia': dim(wd),
            'lengthAtMaxLoad': dim(comp), 'maxLoad': load_lb(mload),
            'rate': float(rate.replace(',', '')),
            'ends': end, 'pkgQty': int(qty), 'partNumber': part,
            'price': (price or '').strip('$') or None,
        })
    return out, failed


def lines_from_pdf(path):
    import pdfplumber
    out = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages):
            for ln in (page.extract_text() or '').split('\n'):
                out.append(f"{i+1}\t{ln.rstrip()}")
    return '\n'.join(out)


src = sys.argv[1] if len(sys.argv) > 1 else 'conical-lines.txt'
cache = 'conical-lines.txt'
if src.lower().endswith('.pdf'):
    open(cache, 'w').write(lines_from_pdf(src))
rows, failed = parse(cache)
print(f"parsed {len(rows)} rows, {len(failed)} unparsed")
for pg, t in failed[:8]: print(f"  UNPARSED p{pg}", t[:110])

# The one geometric check that does hold on a cone: at either end the wall is
# one wire thick, so OD - ID must be twice the wire diameter at both ends.
bad = []
for r in rows:
    for endname, o, i in (('large', r['od'], r['id']), ('small', r['odSmall'], r['idSmall'])):
        if o is None or i is None or r['wireDia'] is None: continue
        if abs((o - i) / 2 - r['wireDia']) > 0.0015:
            bad.append((r['partNumber'], endname, (o - i) / 2, r['wireDia']))
print(f"\nOD - ID = 2 x wire, checked at both ends: {len(bad)} disagreements")
for p, e, implied, published in bad[:10]:
    print(f"   {p:<12} {e} end: implied {implied:.4f} vs published {published}")

print("\nby material:", dict(collections.Counter(str(r['material']) for r in rows)))
print("no max load rating:", sum(1 for r in rows if r['maxLoad'] is None))
missing = [r['partNumber'] for r in rows if r['material'] is None]
if missing: print("NO MATERIAL:", missing[:10])
json.dump(rows, open('rows-conical.json', 'w'))
print("\nwrote rows-conical.json")
