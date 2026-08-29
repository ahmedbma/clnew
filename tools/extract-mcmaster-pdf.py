"""Turn a McMaster-Carr compression-spring listing PDF into catalogue rows.

Usage:
    pip install pdfplumber
    python3 tools/extract-mcmaster-pdf.py listing.pdf > rows.json

Print the vendor's filtered listing to PDF from the browser, then run this.
It exists so the catalogue can be regenerated and audited rather than taken
on trust.

One pattern per product family -- the five families print different columns,
and a single pattern would silently shift values into the wrong fields.
Every parsed row is then checked against the vendor's own arithmetic:
rate x (free length - compressed length at max load) must reproduce the
published max load. A row that fails is reported, never quietly kept.
"""
import re, json, sys, collections

IN = r'(?:[\d.,]+"|—)'                       # an inch dimension, or absent
TOL = r'-[\d.]+"?\s+to\s+[\d.]+"?'           # "-0.002" to 0.002""
LOAD = r'(?:[\d.,]+\s*lbs?\.|Not Rated|[\d.,]+)'
NUM = r'[\d.,]+'
END = r'(?:Closed and Ground|Closed|Open and Ground|Open)'
PART = r'[0-9]{3,}[A-Z][0-9A-Z]*'
PRICE = r'(?:\$?[\d,]+\.\d{2})'

FAMILIES = {
 'Compression Springs': re.compile(
   rf'^({IN})\s+({IN})\s+({IN})\s+({IN})\s+({IN})\s+({IN})\s+({IN})\s+({LOAD})\s+({NUM})\s+({END})\s+(\d+)\s+({PART})\s*({PRICE})?$'),
 'Precision Compression Springs': re.compile(
   rf'^({IN})\s+({IN})\s+({TOL})\s+({IN})\s+({IN})\s+({IN})\s+({NUM})\s+({NUM})\s+({TOL})\s+({END})\s+(\d+)\s+({PART})\s*({PRICE})?$'),
 'Cut-to-Length Compression Springs': re.compile(
   rf'^({IN})\s+({IN})\s+({IN})\s+({IN})\s+({IN})\s+({LOAD})\s+({NUM})\s+({END})\s+(\d+)\s+({PART})\s*({PRICE})?$'),
 'Mil. Spec. Compression Springs': re.compile(
   rf'^({IN})\s+({IN})\s+({IN})\s+({IN})\s+({IN})\s+({NUM})\s+({NUM})\s+({END})\s+(\S+)\s+(.+?)\s+(\d+)\s+({PART})\s*({PRICE})?$'),
 'Plastic Compression Springs': re.compile(
   rf'^({IN})\s+({IN})\s+({IN})\s+({IN})\s+({IN})\s+({IN})\s+({NUM})\s+({NUM})\s+(\S+)\s+(.+?)\s+({END})\s+({NUM})\s+({PART})\s*({PRICE})?$'),
}

def dim(v):
    if v is None or v.strip() in ('—', '', '-'): return None
    return float(v.replace('"', '').replace(',', ''))

def load_lb(v):
    if v is None or 'Not Rated' in v: return None
    m = re.search(r'[\d.,]+', v)
    return float(m.group().replace(',', '')) if m else None

def tol_half(v):
    if not v: return None
    nums = [abs(float(x.replace('"', ''))) for x in re.findall(r'-?[\d.]+', v)]
    return max(nums) if nums else None

def parse(path):
    lines = [l.split('\t', 1) for l in open(path).read().split('\n')]
    lines = [(int(a), b) for a, b in lines if a.isdigit()]
    rowish = re.compile(r'^\S+"\s')
    MATERIALS = ('Spring Steel', 'Chrome Silicon', 'Stainless Steel', 'Brass',
                 'Phosphor Bronze', 'Cobalt Nickel', 'Music Wire')
    fam = mat = None
    out, failed = [], []
    for pg, line in lines:
        t = line.strip()
        if t in FAMILIES: fam, mat = t, None; continue
        if any(m in t for m in MATERIALS) and len(t) < 70 and not t.endswith('.') and not rowish.match(line):
            mat = t; continue
        if not rowish.match(line) or not fam: continue

        m = FAMILIES[fam].match(t)
        if not m:
            failed.append((fam, pg, t)); continue
        g = m.groups()
        r = {'family': fam, 'material': mat, 'page': pg}
        if fam == 'Compression Springs':
            (lg, od, idd, wd, wdt, thk, comp, mload, rate, end, qty, part, price) = g
            r.update(wireWidth=dim(wdt), wireThickness=dim(thk))
        elif fam == 'Precision Compression Springs':
            (lg, od, odtol, idd, wd, comp, mload, rate, ratetol, end, qty, part, price) = g
            r.update(odTol=tol_half(odtol), rateTol=tol_half(ratetol))
        elif fam == 'Cut-to-Length Compression Springs':
            (lg, od, idd, wd, comp, mload, rate, end, qty, part, price) = g
        elif fam == 'Mil. Spec. Compression Springs':
            (lg, od, idd, wd, comp, mload, rate, end, milspec, cert, qty, part, price) = g
            r.update(milSpec=milspec)
        else:
            (lg, od, idd, wdt, thk, comp, mload, rate, colour, material, end, temp, part, price) = g
            r.update(wireWidth=dim(wdt), wireThickness=dim(thk), colour=colour,
                     material=material, maxTempF=dim(temp))
            wd = None
        r.update(freeLength=dim(lg), od=dim(od), id=dim(idd), wireDia=dim(wd),
                 lengthAtMaxLoad=dim(comp), maxLoad=load_lb(mload),
                 rate=float(rate.replace(',', '')), ends=end, pkgQty=int(qty),
                 partNumber=part, price=price)
        out.append(r)
    return out, failed

def lines_from_pdf(path):
    import pdfplumber
    out = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages):
            for ln in (page.extract_text() or '').split('\n'):
                out.append(f"{i+1}\t{ln.rstrip()}")
    return '\n'.join(out)


src = sys.argv[1] if len(sys.argv) > 1 else 'all-lines.txt'
if src.lower().endswith('.pdf'):
    open('all-lines.txt', 'w').write(lines_from_pdf(src))
rows, failed = parse('all-lines.txt')
print(f"parsed {len(rows)} rows, {len(failed)} unparsed")
for f in failed[:8]: print("  UNPARSED:", f[0], "p%d" % f[1], f[2][:110])

# --- the vendor's own arithmetic must close -----------------------------
bad = []
for r in rows:
    if r['maxLoad'] is None or r['lengthAtMaxLoad'] is None: continue
    travel = r['freeLength'] - r['lengthAtMaxLoad']
    if travel <= 0: bad.append((r, 'compressed length >= free length', None)); continue
    implied = r['rate'] * travel
    err = (implied - r['maxLoad']) / r['maxLoad']
    if abs(err) > 0.12: bad.append((r, f"rate x travel = {implied:.2f} lb vs published {r['maxLoad']} lb", err))
checked = sum(1 for r in rows if r['maxLoad'] is not None and r['lengthAtMaxLoad'] is not None)
print(f"\nphysics cross-check: {checked} rows had all three of rate, travel and max load")
print(f"  disagree by more than 12%: {len(bad)}")
for r, why, err in bad[:10]:
    print(f"   {r['partNumber']:<12} {why}")
print("\nby family:", dict(collections.Counter(r['family'] for r in rows)))
print("by material:", dict(collections.Counter(str(r['material']) for r in rows)))
json.dump(rows, open('rows.json', 'w'))
print("\nwrote rows.json -- convert to SI and load with catalog.js fromCatalogJson")
