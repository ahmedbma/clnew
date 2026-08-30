"""Turn McMaster-Carr's *metric* compression-spring listing PDF into rows.

Usage:
    pip install pdfplumber
    python3 tools/extract-mcmaster-metric-pdf.py listing.pdf > rows-metric.json

The companion to extract-mcmaster-pdf.py, which reads the inch listing. The
metric listing is a different document with different columns, so it gets its
own patterns rather than a flag on the other script.

Two things to know about these tables:

  * They are not metric throughout. Lengths are millimetres, but max load is
    still in pounds and spring rate in *lbf per mm*. That mixed unit is real
    and is recorded as published, not quietly converted away.
  * The standard family carries a "Specs. Met" column of DIN standards, which
    contains commas and spaces; the precision family has no such column but
    does carry OD and rate tolerances written as "-0.4 to 0.4".

Every parsed row is checked against the vendor's own arithmetic, exactly as in
the inch script: rate x (free length - compressed length at max load) must
reproduce the published max load.
"""
import re, json, sys, collections

NUM = r'[\d.,]+'
TOL = r'-?[\d.]+\s+to\s+-?[\d.]+'
END = r'(?:Closed and Ground|Closed|Open and Ground|Open|Plain and Ground|Plain)'
PART = r'\d{3,}[A-Z]\d[0-9A-Z]*'
PRICE = r'(?:\$?[\d,]*\.?\d*)'

FAMILIES = {
 'Compression Springs': re.compile(
   rf'^({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s+'
   rf'({END})\s+(.+?)\s+(\d+)\s+({PART})\s*({PRICE})?$'),
 'Precision Compression Springs': re.compile(
   rf'^({NUM})\s+({NUM})\s+({TOL})\s+({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s+'
   rf'({TOL})\s+({END})\s+(\d+)\s+({PART})\s*({PRICE})?$'),
}

# Section headings that switch the material. Written out rather than pattern
# matched so a new heading fails loudly instead of being read as a row.
MATERIAL_HEADINGS = {
    'Spring Steel': 'Spring Steel',
    'Corrosion-Resistant 302 Stainless Steel': '302 Stainless Steel',
    'Highly Corrosion-Resistant 316 Stainless Steel': '316 Stainless Steel',
    'Ultra-Corrosion-Resistant Cobalt Nickel': 'Cobalt Nickel',
}

def num(v):
    if v is None or v.strip() in ('—', '', '-'): return None
    return float(v.replace(',', ''))

def tol_half(v):
    if not v: return None
    nums = [abs(float(x)) for x in re.findall(r'-?[\d.]+', v)]
    return max(nums) if nums else None

def specs(v):
    v = (v or '').strip()
    return None if v in ('—', '', '-') else v

def parse(path):
    lines = [l.split('\t', 1) for l in open(path).read().split('\n') if '\t' in l]
    lines = [(int(a), b) for a, b in lines if a.isdigit()]
    fam = mat = None
    out, failed = [], []
    for pg, line in lines:
        t = line.strip()
        if t in FAMILIES:
            fam, mat = t, None
            continue
        if t in MATERIAL_HEADINGS:
            mat = MATERIAL_HEADINGS[t]
            continue
        # Page furniture and prose: only lines that open with a number can be rows.
        if not re.match(r'^[\d.]+\s', t): continue
        if re.match(r'^\d+/\d+/\d+,', t) or 'mcmaster.com' in t: continue
        if not fam:
            failed.append(('(no family yet)', pg, t)); continue

        m = FAMILIES[fam].match(t)
        if not m:
            failed.append((fam, pg, t)); continue
        g = m.groups()
        r = {'family': fam, 'material': mat, 'page': pg, 'system': 'metric'}
        if fam == 'Compression Springs':
            (lg, od, idd, wd, comp, mload, rate, end, spec, qty, part, price) = g
            r['specsMet'] = specs(spec)
        else:
            (lg, od, odtol, idd, wd, comp, mload, rate, ratetol, end, qty, part, price) = g
            r.update(odTol=tol_half(odtol), rateTolAbs=tol_half(ratetol))
        r.update(freeLength=num(lg), od=num(od), id=num(idd), wireDia=num(wd),
                 lengthAtMaxLoad=num(comp), maxLoad=num(mload), rate=num(rate),
                 ends=end, pkgQty=int(qty), partNumber=part,
                 price=(price or '').strip('$') or None)
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


src = sys.argv[1] if len(sys.argv) > 1 else 'metric-lines.txt'
cache = 'metric-lines.txt'
if src.lower().endswith('.pdf'):
    open(cache, 'w').write(lines_from_pdf(src))
rows, failed = parse(cache)
print(f"parsed {len(rows)} rows, {len(failed)} unparsed")
for f in failed[:8]: print("  UNPARSED:", f[0], "p%d" % f[1], f[2][:110])

# --- the vendor's own arithmetic must close -----------------------------
# Lengths are mm and the rate is lbf/mm, so rate x travel lands in lb, the
# same unit as the published max load. No conversion needed to compare them.
bad = []
for r in rows:
    if r['maxLoad'] is None or r['lengthAtMaxLoad'] is None: continue
    travel = r['freeLength'] - r['lengthAtMaxLoad']
    if travel <= 0:
        bad.append((r, 'compressed length >= free length')); continue
    implied = r['rate'] * travel
    if abs(implied - r['maxLoad']) / r['maxLoad'] > 0.12:
        bad.append((r, f"rate x travel = {implied:.2f} lb vs published {r['maxLoad']} lb"))
checked = sum(1 for r in rows if r['maxLoad'] is not None and r['lengthAtMaxLoad'] is not None)
print(f"\nphysics cross-check: {checked} rows had all three of rate, travel and max load")
print(f"  disagree by more than 12%: {len(bad)}")
for r, why in bad[:10]:
    print(f"   {r['partNumber']:<12} {why}")
print("\nby family:", dict(collections.Counter(r['family'] for r in rows)))
print("by material:", dict(collections.Counter(str(r['material']) for r in rows)))
missing = [r['partNumber'] for r in rows if r['material'] is None]
if missing: print("NO MATERIAL:", missing[:10])
json.dump(rows, open('rows-metric.json', 'w'))
print("\nwrote rows-metric.json")
