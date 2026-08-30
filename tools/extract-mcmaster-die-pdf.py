"""Turn McMaster-Carr's die-spring listing PDF into catalogue rows.

Usage:
    pip install pdfplumber
    python3 tools/extract-mcmaster-die-pdf.py listing.pdf

Die springs are a different product class to the compression springs the other
extractors read, and the table says so:

  * They are wound from **rectangular** wire (Thk. and Wd.), not round, so no
    wire diameter exists to put in the usual column.
  * They publish no OD or ID at all. What you get is "For Hole Dia." and
    "For Shaft Dia." -- the bore it drops into and the rod it runs over.
  * The colour is the Raymond load-rating code (Blue = medium, Red = heavy and
    so on), which is the thing people actually order by, so it is kept.

One trap: in this PDF the printed part number is clipped at the column edge for
16 rows, so seven different springs appear to share "9588K43". The hyperlink
behind each row carries the real number, so that is what is used, and the two
are compared on every row. (The inch, metric and conical listings were checked
the same way and have no such truncation.)

Four sub-families print four different column sets, including a rubber one that
is a moulded polyurethane slug with no spring rate at all. Each gets its own
pattern; a single pattern would shift values between fields silently.
"""
import re, json, sys, collections

FR = r'(?:\d+\s+\d+/\d+"|\d+/\d+"|[\d.,]+"|[\d.,]+)'
NUM = r'[\d.,]+'
PCT = r'\d+%'
LOAD = r'(?:[\d.,]+|Not Rated)'
END = r'(?:Closed and Ground|Closed|Open and Ground|Open|Open and Squared)'
MAT = r'(?:[A-Z][A-Za-z ]+?)'
PART = r'\d{3,}[A-Z]\d[0-9A-Z]*'
PRICE = r'(?:\$?[\d,]+\.\d{2})'

SHAPES = {
    # inch colour-coded and plain die springs
    'inch': re.compile(rf'^({FR})\s+({FR})\s+({FR})\s+({FR})\s+({FR})\s+({FR})\s+({PCT})\s+'
                       rf'({LOAD})\s+({NUM})\s+({MAT})\s+({END})\s+({PART})\s*({PRICE})?$'),
    # metric colour-coded: an extra "Specs. Met" column before the part number
    'metric': re.compile(rf'^({FR})\s+({FR})\s+({FR})\s+({FR})\s+({FR})\s+({FR})\s+({PCT})\s+'
                         rf'({LOAD})\s+({NUM})\s+({MAT})\s+({END})\s+(.+?)\s+({PART})\s*({PRICE})?$'),
    # cut-to-length: no compressed length, deflection or max load at all
    'cut': re.compile(rf'^({FR})\s+({FR})\s+({FR})\s+({FR})\s+({FR})\s+({NUM})\s+'
                      rf'({MAT})\s+({END})\s+({PART})\s*({PRICE})?$'),
    # rubber: no wire, no rate; a hardness and a temperature range instead
    'rubber': re.compile(rf'^({FR})\s+({FR})\s+({FR})\s+({FR})\s+({PCT})\s+({LOAD})\s+'
                         rf'({MAT})\s+(Durometer \S+)\s+(-?\d+ to \d+)\s+({PART})\s*({PRICE})?$'),
}

FAMILIES = {
    'Color-Coded Die Springs': 'inch',
    'Die Springs': 'inch',
    'Cut-to-Length Die Springs': 'cut',
    'Rubber Die Springs': 'rubber',
}
COLOUR = re.compile(r'^(Blue|Red|Gold|Green|Yellow|Black|Orange|Purple|Brown|Silver)\s+\(([^)]+)\)$')


def dim(v):
    """0.039" | 3/8" | 1 3/8" | 12.5  ->  float, in whatever unit the column is."""
    if v is None: return None
    t = v.strip().replace('"', '').replace(',', '')
    if t in ('—', '', '-'): return None
    m = re.match(r'^(?:(\d+)\s+)?(\d+)/(\d+)$', t)
    if m:
        whole = float(m.group(1) or 0)
        return whole + float(m.group(2)) / float(m.group(3))
    return float(t)


def load_lb(v):
    if v is None or 'Not Rated' in v: return None
    m = re.search(r'[\d.,]+', v)
    return float(m.group().replace(',', '')) if m else None


def parse(path):
    lines = []
    for l in open(path):
        parts = l.rstrip('\n').split('\t')
        if len(parts) >= 2 and parts[0].isdigit():
            lines.append((int(parts[0]), parts[1], parts[2] if len(parts) > 2 else ''))
    fam = shape = None
    system = 'inch'
    colour = rating = None
    out, failed, clipped = [], [], []
    for pg, line, linked in lines:
        t = line.strip()
        if t in FAMILIES:
            fam, shape = t, FAMILIES[t]
            system, colour, rating = 'inch', None, None
            continue
        if t in ('Inch', 'Metric'):
            system = t.lower()
            continue
        m = COLOUR.match(t)
        if m:
            colour, rating = m.group(1), m.group(2)
            continue
        if not re.match(r'^(\d+\s+)?[\d.]+(/\d+)?"?\s', t): continue
        if 'products' in t or 'mcmaster.com' in t: continue
        if re.match(r'^\d+/\d+/\d+,', t): continue
        if not fam:
            failed.append((pg, t)); continue

        # The colour-coded family is the only one printed in both systems.
        kind = 'metric' if (shape == 'inch' and system == 'metric') else shape
        g = SHAPES[kind].match(t)
        if not g:
            failed.append((pg, t)); continue
        g = g.groups()
        r = {'family': fam, 'page': pg, 'system': system,
             'colour': colour, 'loadRating': rating}
        if kind in ('inch', 'metric'):
            if kind == 'inch':
                (hole, shaft, lg, thk, wd, comp, defl, mload, rate, mat, end, part, price) = g
                spec = None
            else:
                (hole, shaft, lg, thk, wd, comp, defl, mload, rate, mat, end, spec, part, price) = g
            r.update(lengthAtMaxLoad=dim(comp), deflectionPct=int(defl.rstrip('%')),
                     maxLoad=load_lb(mload), rate=float(rate.replace(',', '')), specsMet=spec)
        elif kind == 'cut':
            (hole, shaft, lg, thk, wd, rate, mat, end, part, price) = g
            r.update(rate=float(rate.replace(',', '')), cutToLength=True)
        else:
            (hole, shaft, lg, comp, defl, mload, mat, hardness, temp, part, price) = g
            thk = wd = None
            lo, hi = temp.split(' to ')
            r.update(lengthAtMaxLoad=dim(comp), deflectionPct=int(defl.rstrip('%')),
                     maxLoad=load_lb(mload), rate=None, hardness=hardness,
                     minTempF=float(lo), maxTempF=float(hi))
        # The link is authoritative; the printed cell can be a character short.
        if linked and linked != part:
            clipped.append((part, linked))
        r.update(forHoleDia=dim(hole), forShaftDia=dim(shaft), freeLength=dim(lg),
                 wireThickness=dim(thk), wireWidth=dim(wd), material=mat.strip(),
                 ends=end if kind != 'rubber' else None,
                 partNumber=linked or part, price=(price or '').strip('$') or None)
        out.append(r)
    return out, failed, clipped


def lines_from_pdf(path):
    """page <TAB> line text <TAB> part number taken from the row's hyperlink."""
    import pdfplumber
    out = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages):
            links = []
            for h in page.hyperlinks:
                m = re.search(r'mcmaster\.com/([0-9A-Z]+)/', h.get('uri') or '')
                if m:
                    links.append((h['top'], m.group(1)))
            for ln in page.extract_text_lines():
                # Rows sit about 7 points apart and the annotation box is offset
                # from the glyph box by about one, so match on the nearest top
                # rather than on overlap -- an overlap window catches neighbours.
                near = sorted(((abs(top - ln['top']), p) for top, p in links), key=lambda x: x[0])
                hit = near[0][1] if near and near[0][0] <= 3 else ''
                out.append(f"{i+1}\t{ln['text'].rstrip()}\t{hit}")
    return '\n'.join(out)


src = sys.argv[1] if len(sys.argv) > 1 else 'die-lines.txt'
cache = 'die-lines.txt'
if src.lower().endswith('.pdf'):
    open(cache, 'w').write(lines_from_pdf(src))
rows, failed, clipped = parse(cache)
print(f"parsed {len(rows)} rows, {len(failed)} unparsed")
for pg, t in failed[:8]: print(f"  UNPARSED p{pg}", t[:110])
print(f"part numbers clipped in the printed table, taken from the link instead: {len(clipped)}")
for shown, real in clipped[:20]: print(f"   printed {shown:<10} actually {real}")
dupes = [p for p, n in collections.Counter(r['partNumber'] for r in rows).items() if n > 1]
print(f"duplicate part numbers after the fix: {len(dupes)} {dupes[:6]}")

# --- the vendor's own arithmetic ---------------------------------------
# These tables publish the deflection at max load as a percentage of free
# length as well as the compressed length, so the two must agree, and
# rate x that deflection must reproduce the max load. Inch rows are in
# inches with lbf/in; metric rows in mm with lbf/mm. Either way the product
# lands in pounds.
bad_defl, bad_load = [], []
for r in rows:
    if r.get('deflectionPct') is None or r.get('lengthAtMaxLoad') is None: continue
    travel = r['freeLength'] - r['lengthAtMaxLoad']
    implied_pct = travel / r['freeLength'] * 100
    if abs(implied_pct - r['deflectionPct']) > 2.5:
        bad_defl.append((r, implied_pct))
    if r.get('rate') and r.get('maxLoad'):
        implied = r['rate'] * travel
        if abs(implied - r['maxLoad']) / r['maxLoad'] > 0.12:
            bad_load.append((r, implied))
print(f"\ndeflection % vs the two lengths: {len(bad_defl)} disagree by more than 2.5 points")
for r, p in bad_defl[:8]:
    print(f"   {r['partNumber']:<12} published {r['deflectionPct']}%  lengths imply {p:.1f}%")
print(f"rate x travel vs published max load: {len(bad_load)} disagree by more than 12%")
for r, i in bad_load[:8]:
    print(f"   {r['partNumber']:<12} {i:.1f} lb vs published {r['maxLoad']} lb")

print("\nby family/system:", dict(collections.Counter(f"{r['family']} ({r['system']})" for r in rows)))
print("by material:", dict(collections.Counter(str(r['material']) for r in rows)))
print("by load rating:", dict(collections.Counter(f"{r['colour']} {r['loadRating']}" for r in rows)))
json.dump(rows, open('rows-die.json', 'w'))
print("\nwrote rows-die.json")
