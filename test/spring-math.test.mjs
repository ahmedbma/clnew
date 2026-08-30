import test from 'node:test';
import assert from 'node:assert/strict';
import * as sm from '../spring-math.js';
import * as cat from '../catalog.js';

const close = (a, b, tol = 1e-6, msg) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), msg || `${a} !~= ${b}`);

/* ------------------------------------------------------------------ units */

test('unit conversions round-trip', () => {
  close(sm.mmToIn(sm.inToMm(1.234)), 1.234);
  close(sm.nToLbf(sm.lbfToN(3.5)), 3.5);
  close(sm.lbfToN(1), 4.4482216152605);
  close(sm.lbfPerInToNPerMm(1), 0.1751268, 1e-5);
  // The headline number the whole tool exists to serve.
  close(sm.lbfToN(0.337), 1.499, 1e-3);
});

/* -------------------------------------------------------------- materials */

test('Sut follows A/d^m and allowable is the right fraction', () => {
  // Music wire at d = 1 mm: A = 2211, so Sut = 2211 MPa exactly.
  close(sm.ultimateTensileStrength('music-wire', 1).sut_MPa, 2211);
  close(sm.ultimateTensileStrength('music-wire', 2).sut_MPa, 2211 / Math.pow(2, 0.145), 1e-9);
  const a = sm.allowableShearStress('music-wire', 1);
  close(a.tauAllow_MPa, 2211 * 0.45);
  // Austenitic stainless is held to a lower fraction of Sut.
  assert.equal(sm.allowableShearStress('stainless-302', 1).fraction, 0.35);
  // Set removed buys headroom.
  assert.ok(sm.allowableShearStress('music-wire', 1, { setRemoved: true }).tauAllow_MPa > a.tauAllow_MPa);
});

test('302 stainless Sut is piecewise in wire diameter', () => {
  close(sm.ultimateTensileStrength('stainless-302', 2).sut_MPa, 1867 / Math.pow(2, 0.146), 1e-9);
  close(sm.ultimateTensileStrength('stainless-302', 4).sut_MPa, 2065 / Math.pow(4, 0.263), 1e-9);
});

test('material and end-type names resolve from vendor text', () => {
  assert.equal(sm.resolveMaterial('Zinc-Plated Music Wire'), 'music-wire');
  // "302 stainless steel" must not be swallowed by the bare "steel" alias.
  assert.equal(sm.resolveMaterial('302 Stainless Steel'), 'stainless-302');
  assert.equal(sm.resolveMaterial('316 Stainless Steel'), 'stainless-316');
  assert.equal(sm.resolveMaterial('Passivated 18-8 Stainless Steel'), 'stainless-302');
  assert.equal(sm.resolveMaterial('unobtainium'), null);
  assert.equal(sm.resolveEnds('Closed & Ground'), 'closed-and-ground');
  assert.equal(sm.resolveEnds('Open'), 'open');
  assert.equal(sm.resolveEnds('Squared and Ground'), 'closed-and-ground');
});

/* --------------------------------------------------------------- geometry */

test('end types set active coils and solid length', () => {
  assert.equal(sm.activeFromTotal(10, 'closed-and-ground'), 8);
  assert.equal(sm.activeFromTotal(10, 'open'), 10);
  assert.equal(sm.activeFromTotal(10, 'open-and-ground'), 9);
  close(sm.solidLength(10, 1, 'closed-and-ground'), 10);
  close(sm.solidLength(10, 1, 'closed'), 11);
  close(sm.solidLength(10, 1, 'open'), 11);
  close(sm.solidLength(10, 1, 'open-and-ground'), 10);
});

test('rate equation and its inverse agree', () => {
  // k = G d^4 / (8 D^3 Na); G = 79.3 GPa, d = 1, D = 10, Na = 10
  const k = sm.rateFromGeometry({ G_GPa: 79.3, d_mm: 1, D_mm: 10, activeCoils: 10 });
  close(k, 79300 / (8 * 1000 * 10), 1e-9);
  close(sm.activeCoilsFromRate({ G_GPa: 79.3, d_mm: 1, D_mm: 10, rate_Npmm: k }), 10, 1e-9);
});

test('rate scales as d^4 and 1/D^3', () => {
  const base = { G_GPa: 79.3, d_mm: 1, D_mm: 10, activeCoils: 10 };
  close(sm.rateFromGeometry({ ...base, d_mm: 2 }) / sm.rateFromGeometry(base), 16, 1e-9);
  close(sm.rateFromGeometry({ ...base, D_mm: 20 }) / sm.rateFromGeometry(base), 1 / 8, 1e-9);
});

test('stress factors match the textbook forms', () => {
  close(sm.wahlFactor(6), (4 * 6 - 1) / (4 * 6 - 4) + 0.615 / 6, 1e-12);
  close(sm.staticShearFactor(6), 1 + 0.5 / 6, 1e-12);
  // Wahl exceeds the direct-shear-only factor; both tend to 1 at high index.
  assert.ok(sm.wahlFactor(6) > sm.staticShearFactor(6));
  close(sm.wahlFactor(1000), 1, 1e-2);
  close(sm.shearStress({ force_N: 100, D_mm: 10, d_mm: 1, factor: 1 }),
    (8 * 100 * 10) / Math.PI, 1e-9);
});

test('buckling: short springs are unconditionally stable, slender ones are not', () => {
  const stubby = sm.bucklingAnalysis({ freeLength_mm: 10, D_mm: 10, materialKey: 'music-wire' });
  assert.equal(stubby.unconditionallyStable, true);
  const slender = sm.bucklingAnalysis({ freeLength_mm: 200, D_mm: 10, materialKey: 'music-wire' });
  assert.equal(slender.unconditionallyStable, false);
  assert.ok(slender.criticalDeflection_mm < 200);
  // A free end is far worse than parallel guided plates.
  const free = sm.bucklingAnalysis({ freeLength_mm: 60, D_mm: 10, materialKey: 'music-wire', endCondition: 'fixed-free' });
  const guided = sm.bucklingAnalysis({ freeLength_mm: 60, D_mm: 10, materialKey: 'music-wire', endCondition: 'fixed-fixed' });
  assert.ok(free.criticalDeflection_mm < guided.criticalDeflection_mm);
});

/* ------------------------------------------------------------ derivation */

test('normalizeSpring completes the diameter triangle', () => {
  const a = sm.normalizeSpring({ od_mm: 10, id_mm: 8, rate_Npmm: 1 });
  close(a.wireDia_mm, 1);
  assert.ok(a.derived.includes('wireDia_mm'));
  const b = sm.normalizeSpring({ od_mm: 10, wireDia_mm: 1, rate_Npmm: 1 });
  close(b.id_mm, 8);
  const c = sm.normalizeSpring({ id_mm: 8, wireDia_mm: 1, rate_Npmm: 1 });
  close(c.od_mm, 10);
  close(c.meanDia_mm, 9);
  close(c.springIndex, 9);
});

test('a published rate recovers the coil count the vendor did not print', () => {
  // Build a spring forwards, then hand the tool only what McMaster prints.
  const truth = sm.normalizeSpring({
    od_mm: 10, wireDia_mm: 1, totalCoils: 12, freeLength_mm: 20,
    materialKey: 'music-wire', endsKey: 'closed-and-ground',
  });
  close(truth.activeCoils, 10);
  close(truth.solidLength_mm, 12);
  close(truth.travelToSolid_mm, 8);

  const asListed = sm.normalizeSpring({
    od_mm: 10, wireDia_mm: 1, freeLength_mm: 20, rate_Npmm: truth.rate_Npmm,
    materialKey: 'music-wire', endsKey: 'closed-and-ground',
  });
  close(asListed.activeCoils, 10, 1e-9);
  close(asListed.totalCoils, 12, 1e-9);
  close(asListed.solidLength_mm, 12, 1e-9);
  close(asListed.travelToSolid_mm, 8, 1e-9);
  assert.ok(asListed.derived.includes('activeCoils'));
  assert.ok(asListed.derived.includes('solidLength_mm'));
});

test('published rate that contradicts the geometry raises a warning', () => {
  const s = sm.normalizeSpring({
    od_mm: 10, wireDia_mm: 1, totalCoils: 12, freeLength_mm: 20, rate_Npmm: 99,
  });
  assert.ok(s.warnings.some((w) => /disagree/.test(w)));
  assert.ok(Math.abs(s.rateCheck.error) > 0.25);
});

test('usable travel prefers vendor data, then derates travel to solid', () => {
  const vendor = sm.normalizeSpring({ od_mm: 10, wireDia_mm: 1, freeLength_mm: 20, totalCoils: 12, maxDeflection_mm: 5 });
  close(vendor.usableTravel_mm, 5);
  assert.match(vendor.usableTravelSource, /vendor max deflection/);

  const byLoad = sm.normalizeSpring({ od_mm: 10, wireDia_mm: 1, freeLength_mm: 20, totalCoils: 12, maxLoad_N: 10 });
  close(byLoad.usableTravel_mm, 10 / byLoad.rate_Npmm);

  const derated = sm.normalizeSpring({ od_mm: 10, wireDia_mm: 1, freeLength_mm: 20, totalCoils: 12 });
  close(derated.usableTravel_mm, 8 * 0.85);
});

test('what a spring cannot do without is the rate and the free length', () => {
  // Neither is derivable here, so both are named.
  const bare = sm.normalizeSpring({ od_mm: 10 });
  assert.equal(bare.incomplete, true);
  assert.match(bare.missing.join(' '), /spring rate/);
  assert.match(bare.missing.join(' '), /free length/);

  // Geometry alone still cannot give a rate without a coil count.
  assert.equal(sm.normalizeSpring({ od_mm: 10, wireDia_mm: 1, freeLength_mm: 20 }).incomplete, true);

  // Rate plus free length is enough, even with no wire diameter at all --
  // that is what rectangular-wire and moulded springs give you.
  const rect = sm.normalizeSpring({
    od_mm: 10, id_mm: 7, wireWidth_mm: 1.5, wireThickness_mm: 1.5,
    freeLength_mm: 25, rate_Npmm: 2, lengthAtMaxLoad_mm: 18, material: 'Spring Steel',
  });
  assert.equal(rect.incomplete, false);
  assert.equal(rect.wireDia_mm, null, 'radial thickness is not a round wire diameter');
  assert.equal(rect.activeCoils, null);
  assert.equal(rect.solidLength_mm, null);
  close(rect.usableTravel_mm, 7);
  assert.ok(rect.warnings.some((w) => /Square wire, not round/.test(w)));
  // Force at length still comes straight off the published rate.
  close(sm.evaluate(rect, { targetForce_N: 4 }).working.installedLength_mm, 23);
});

test('a non-round section is named for what it actually is', () => {
  // "Rectangular" was being said of three different things. Square wire,
  // genuinely rectangular wire and a moulded plastic spring are not the
  // same object, and the warning should not pretend otherwise.
  const warn = (s) => sm.normalizeSpring(s).warnings.join(' | ');
  const base = { od_mm: 10, id_mm: 7, freeLength_mm: 25, rate_Npmm: 2 };

  const key = (o) => sm.normalizeSpring(o).sectionKey;
  const square = warn({ ...base, wireWidth_mm: 1.5, wireThickness_mm: 1.5, material: 'Music Wire' });
  assert.match(square, /Square wire, not round/);
  assert.equal(key({ ...base, wireWidth_mm: 1.5, wireThickness_mm: 1.5, material: 'Music Wire' }), 'square');

  const oblong = warn({ ...base, wireWidth_mm: 1.5, wireThickness_mm: 0.9, material: 'Music Wire' });
  assert.match(oblong, /Rectangular wire, not round/);
  assert.equal(key({ ...base, wireWidth_mm: 1.5, wireThickness_mm: 0.9, material: 'Music Wire' }), 'rectangular');

  // Ultem PEI has no spring properties in the table, and is moulded rather
  // than wound, so calling any of it "wire" is simply wrong.
  const moulded = warn({ ...base, wireWidth_mm: 1.5, wireThickness_mm: 0.9, material: 'Ultem PEI' });
  assert.match(moulded, /Moulded rather than wound from wire/);
  assert.doesNotMatch(moulded, /wire, not round/);

  // A urethane die spring has no section columns at all -- it is a solid slug.
  // Reading the absence of a width as "round wire" would be exactly wrong.
  const slug = sm.normalizeSpring({ ...base, material: 'Polyurethane Rubber' });
  assert.equal(slug.sectionKey, 'moulded');
  assert.match(slug.warnings.join(' | '), /Moulded rather than wound from wire/);
  assert.equal(key({ ...base, wireDia_mm: 1, material: 'Music Wire' }), 'round');

  // Whatever the section, the same consequence is spelled out: the derived
  // columns are skipped, the published rate is not affected.
  for (const w of [square, oblong, moulded]) {
    assert.match(w, /coil count, solid length and stress are not worked out/);
    assert.match(w, /straight from the published rate/);
  }
});

test('an unrecognised material is left unknown, an unstated one is assumed', () => {
  // Naming a material the tool has no properties for must not silently
  // become music wire -- the stress number that follows would be nonsense.
  const plastic = sm.normalizeSpring({
    od_mm: 9, freeLength_mm: 10, rate_Npmm: 0.65, material: 'Ultem PEI',
  });
  assert.equal(plastic.materialKey, null);
  assert.equal(plastic.incomplete, false);
  assert.ok(plastic.warnings.some((w) => /not one the calculator has properties for/.test(w)));
  const ev = sm.evaluate(plastic, { targetForce_N: 1.5 });
  assert.equal(ev.working.utilisation, null, 'stress is not guessed at');
  assert.equal(ev.allowable, null);
  assert.equal(ev.feasible, true, 'the published rate still answers the question');

  // No material named at all falls back to the default, and says so.
  const assumed = sm.normalizeSpring({ od_mm: 10, wireDia_mm: 1, totalCoils: 12, freeLength_mm: 20 });
  assert.equal(assumed.materialKey, sm.DEFAULT_MATERIAL);
  assert.ok(assumed.derived.includes('materialKey'));
  assert.ok(assumed.rate_Npmm > 0);
});

test('cut-to-length stock is flagged, because cutting it changes the rate', () => {
  const s = sm.normalizeSpring({
    od_mm: 5, wireDia_mm: 0.5, freeLength_mm: 254, rate_Npmm: 0.05,
    family: 'Cut-to-Length Compression Springs', material: 'Spring Steel',
  });
  assert.ok(s.warnings.some((w) => /cut-to-length stock/i.test(w)));
  // ...and it can be filtered out entirely.
  const other = sm.normalizeSpring({ od_mm: 5, wireDia_mm: 0.5, freeLength_mm: 25, rate_Npmm: 0.5, family: 'Compression Springs', material: 'Spring Steel' });
  const ok = sm.searchCatalog([s, other], { targetForce_N: 1, families: ['Compression Springs'] })
    .filter((h) => h.ok);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].spring.family, 'Compression Springs');
});

test('out-of-range spring index is flagged', () => {
  assert.ok(sm.normalizeSpring({ od_mm: 4, wireDia_mm: 1, rate_Npmm: 1 }).warnings.some((w) => /below 4/.test(w)));
  assert.ok(sm.normalizeSpring({ od_mm: 20, wireDia_mm: 1, rate_Npmm: 1 }).warnings.some((w) => /above 14/.test(w)));
});

/* ------------------------------------------------------------- evaluation */

test('forward: force at a length, and the length for a force', () => {
  close(sm.forceAtLength(2, 20, 15), 10);
  close(sm.lengthForForce(2, 20, 10), 15);
  close(sm.deflectionForForce(2, 10), 5);
});

test('evaluate places the working point and reports headroom', () => {
  const s = sm.normalizeSpring({ od_mm: 10, wireDia_mm: 1, freeLength_mm: 20, totalCoils: 12 });
  const ev = sm.evaluate(s, { targetForce_N: 1.5 });
  close(ev.working.deflection_mm, 1.5 / s.rate_Npmm);
  close(ev.working.installedLength_mm, 20 - 1.5 / s.rate_Npmm);
  assert.equal(ev.feasible, true);
  assert.ok(ev.working.travelUsedFraction < 1);
  // Asking for more than the spring can give must fail with a reason.
  const tooMuch = sm.evaluate(s, { targetForce_N: s.maxUsableForce_N * 3 });
  assert.equal(tooMuch.feasible, false);
  assert.ok(tooMuch.reasons.some((r) => /travel/.test(r)));
});

test('tolerance band: a soft spring holds force better than a stiff one', () => {
  const soft = sm.normalizeSpring({ od_mm: 10, wireDia_mm: 0.7, freeLength_mm: 25, totalCoils: 20 });
  const stiff = sm.normalizeSpring({ od_mm: 10, wireDia_mm: 1.2, freeLength_mm: 25, totalCoils: 20 });
  assert.ok(stiff.rate_Npmm > soft.rate_Npmm);
  const opts = { targetForce_N: 1.5, positionTol_mm: 0.25, rateTol: 0.10 };
  const a = sm.evaluate(soft, opts).working.sensitivity;
  const b = sm.evaluate(stiff, opts).working.sensitivity;
  assert.ok(a.rssFraction < b.rssFraction, 'lower rate must give tighter force control');
  // Rate tolerance alone is a floor on how well you can hold the force.
  assert.ok(a.rssFraction >= 0.10);
  close(a.forceErrFromPosition_N, soft.rate_Npmm * 0.25);
});

test('stress utilisation rises with load and flags overload', () => {
  const s = sm.normalizeSpring({ od_mm: 10, wireDia_mm: 1, freeLength_mm: 40, totalCoils: 12, maxDeflection_mm: 30 });
  const low = sm.evaluate(s, { targetForce_N: 1 });
  const high = sm.evaluate(s, { targetForce_N: 60 });
  assert.ok(high.working.utilisation > low.working.utilisation);
  assert.ok(high.working.utilisation > 1);
  assert.equal(high.feasible, false);
  assert.ok(high.reasons.some((r) => /stress/.test(r)));
});

/* ----------------------------------------------------------------- search */

test('searchCatalog honours the envelope and ranks the survivors', () => {
  const catalogue = [
    // Too fat.
    { partNumber: 'BIG', od_mm: 20, wireDia_mm: 1, freeLength_mm: 30, totalCoils: 12 },
    // Fits, comfortable working point.
    { partNumber: 'GOOD', od_mm: 9, wireDia_mm: 0.8, freeLength_mm: 20, totalCoils: 16 },
    // Fits, but far too stiff to reach 1.5 N with any real travel.
    { partNumber: 'STIFF', od_mm: 9, wireDia_mm: 2.0, freeLength_mm: 20, totalCoils: 16 },
  ].map(sm.normalizeSpring);

  const hits = sm.searchCatalog(catalogue, { targetForce_N: 1.5, maxOD_mm: 12.7 });
  const parts = hits.filter((h) => h.ok).map((h) => h.spring.partNumber);
  assert.ok(!parts.includes('BIG'), 'oversize spring must be filtered out');
  assert.ok(parts.includes('GOOD'));
  assert.equal(hits[0].spring.partNumber, 'GOOD');

  const withRejects = sm.searchCatalog(catalogue, { targetForce_N: 1.5, maxOD_mm: 12.7, includeRejected: true });
  const big = withRejects.find((h) => h.spring.partNumber === 'BIG');
  assert.equal(big.ok, false);
  assert.ok(big.rejected.some((r) => /OD/.test(r)));
});

test('search filters on rod clearance and travel headroom', () => {
  const s = [sm.normalizeSpring({ partNumber: 'A', od_mm: 9, id_mm: 7, freeLength_mm: 20, totalCoils: 16 })];
  assert.equal(sm.searchCatalog(s, { targetForce_N: 1.5, minID_mm: 8, includeRejected: true })[0].ok, false);
  assert.equal(sm.searchCatalog(s, { targetForce_N: 1.5, minID_mm: 6 })[0].ok, true);
  const tight = sm.searchCatalog(s, { targetForce_N: 1.5, maxTravelUsedFraction: 0.01, includeRejected: true });
  assert.equal(tight[0].ok, false);
});

test('sort modes actually reorder', () => {
  const catalogue = [
    { partNumber: 'SOFT', od_mm: 9, wireDia_mm: 0.7, freeLength_mm: 25, totalCoils: 20 },
    { partNumber: 'HARD', od_mm: 9, wireDia_mm: 1.0, freeLength_mm: 25, totalCoils: 20 },
  ].map(sm.normalizeSpring);
  assert.equal(sm.searchCatalog(catalogue, { targetForce_N: 1.5, sortBy: 'rate' })[0].spring.partNumber, 'SOFT');
  assert.equal(sm.searchCatalog(catalogue, { targetForce_N: 1.5, sortBy: 'force-precision' })[0].spring.partNumber, 'SOFT');
});

/* ------------------------------------------------------------ design space */

test('designSpace brackets the rate window for a target force', () => {
  const ds = sm.designSpace({ targetForce_N: 1.5, maxOD_mm: sm.inToMm(0.5), maxIndex: 14 });
  close(ds.rateWindow_Npmm[0], 1.5 / sm.inToMm(0.5), 1e-9);
  close(ds.rateWindow_Npmm[1], 1.5 / sm.inToMm(0.05), 1e-9);
  assert.ok(ds.points.length > 1);
  const withOptions = ds.points.filter((p) => p.options.length);
  assert.ok(withOptions.length, 'at least some deflections must be buildable');
  // Options come back most-compact first, which is what the pickers rely on.
  for (const p of withOptions) {
    for (let i = 1; i < p.options.length; i++) {
      assert.ok(p.options[i].minFreeLength_mm >= p.options[i - 1].minFreeLength_mm);
    }
  }
  for (const p of withOptions) {
    for (const o of p.options) {
      assert.ok(o.springIndex >= 4 && o.springIndex <= 14);
      assert.ok(o.activeCoils >= 3);
      assert.ok(o.od_mm <= sm.inToMm(0.5) + 1e-9);
      // Each candidate must reproduce the rate it was designed for.
      const k = sm.rateFromGeometry({
        G_GPa: sm.MATERIALS['music-wire'].G_GPa, d_mm: o.wireDia_mm,
        D_mm: o.meanDia_mm, activeCoils: o.activeCoils,
      });
      close(k, p.rate_Npmm, 1e-9);
    }
  }
});

/* -------------------------------------------------------- catalog parsing */

test('parseNumber handles decimals and shop fractions', () => {
  close(cat.parseNumber('0.36'), 0.36);
  close(cat.parseNumber('.36'), 0.36);
  close(cat.parseNumber('3/8'), 0.375);
  close(cat.parseNumber('1-1/2'), 1.5);
  close(cat.parseNumber('1 1/2'), 1.5);
  close(cat.parseNumber('1,250'), 1250);
  assert.equal(cat.parseNumber(''), null);
  assert.equal(cat.parseNumber('Each'), null);
});

test('detectUnit picks the most specific unit', () => {
  assert.equal(cat.detectUnit('Spring Rate, lbs./in.'), 'lbf/in');
  assert.equal(cat.detectUnit('Rate, N/mm'), 'N/mm');
  assert.equal(cat.detectUnit('0.36"'), 'in');
  assert.equal(cat.detectUnit('12.7 mm'), 'mm');
  assert.equal(cat.detectUnit('Max. Load, lbs.'), 'lbf');
  // "Inconel" must not read as inches.
  assert.equal(cat.detectUnit('Inconel X-750'), null);
});

test('toMm / toNewtons respect the cell unit over the fallback', () => {
  close(cat.toMm('0.5"', 'mm'), 12.7);
  close(cat.toMm('0.5', 'in'), 12.7);
  close(cat.toMm('12.7 mm', 'in'), 12.7);
  close(cat.toNewtons('1 lb', 'N'), 4.4482216152605);
  close(cat.toNewtons('1.5', 'N'), 1.5);
  close(cat.toNewtonsPerMm('1', 'lbf/in'), 0.1751268, 1e-5);
});

test('a pasted McMaster-style table imports and derives travel', () => {
  const pasted = [
    'Part #\tOD\tID\tWire Dia.\tLg.\tSpring Rate, lbs./in.\tMaterial\tEnds\tEach',
    '9657K304\t0.36"\t0.296"\t0.032"\t0.471"\t4.5\tZinc-Plated Music Wire\tClosed & Ground\t$1.23',
    'A NOTE ROW',
    '9657K999\t0.5"\t0.42"\t0.04"\t1"\t2.1\t302 Stainless Steel\tClosed & Ground\t$2.00',
  ].join('\n');
  const res = cat.importTable(pasted);
  assert.equal(res.springs.length, 2);
  assert.equal(res.skipped.length, 1);
  const a = res.springs[0];
  assert.equal(a.partNumber, '9657K304');
  assert.equal(a.materialKey, 'music-wire');
  assert.equal(a.endsKey, 'closed-and-ground');
  close(a.od_mm, 9.144, 1e-6);
  close(a.wireDia_mm, 0.8128, 1e-6);
  close(a.rate_Npmm, sm.lbfPerInToNPerMm(4.5), 1e-9);
  assert.ok(a.solidLength_mm > 0 && a.solidLength_mm < a.freeLength_mm);
  assert.equal(res.springs[1].materialKey, 'stainless-302');
  assert.match(a.url, /9657K304/);
});

test('CSV and metric tables import too', () => {
  const csv = 'Part #,OD (mm),Wire Dia. (mm),Free Length (mm),Rate (N/mm),Material\nX1,10,1,20,0.99,Music Wire';
  const res = cat.importTable(csv, { lengthUnit: 'mm', rateUnit: 'N/mm', vendor: 'Test' });
  assert.equal(res.springs.length, 1);
  close(res.springs[0].od_mm, 10);
  close(res.springs[0].rate_Npmm, 0.99);
});

test('a table with no header is refused rather than misread', () => {
  const res = cat.importTable('9657K304\t0.36\t0.296\t0.032\t0.471\t4.5');
  assert.ok(res.error);
  assert.equal(res.springs.length, 0);
});

test('catalog JSON survives a save/load round trip', () => {
  const springs = cat.importTable([
    'Part #\tOD\tWire Dia.\tLg.\tSpring Rate, lbs./in.\tMaterial',
    'P1\t0.36"\t0.032"\t0.471"\t4.5\tMusic Wire',
  ].join('\n')).springs;
  const json = JSON.stringify(cat.toCatalogJson(springs, { vendor: 'McMaster-Carr' }));
  const back = cat.fromCatalogJson(json);
  assert.equal(back.length, 1);
  close(back[0].rate_Npmm, springs[0].rate_Npmm, 1e-12);
  close(back[0].solidLength_mm, springs[0].solidLength_mm, 1e-9);
  assert.equal(back[0].partNumber, 'P1');
});

test('hand entry accepts mixed units', () => {
  const s = cat.springFromForm({
    partNumber: 'HAND', lengthUnit: 'in', rateUnit: 'lbf/in',
    od: '0.5', wireDia: '0.04', freeLength: '1', rate: '2.1',
    materialKey: 'stainless-302', endsKey: 'closed-and-ground',
  });
  close(s.od_mm, 12.7);
  close(s.rate_Npmm, sm.lbfPerInToNPerMm(2.1), 1e-9);
  assert.equal(s.incomplete, false);
});

/* --------------------------------------------------- the actual use case */

test('end to end: 1.5 N inside a 0.5 in bore', () => {
  const targetForce_N = 1.5;
  const maxOD_mm = sm.inToMm(0.5);
  // Three physically consistent candidates: one well matched, one that busts
  // the bore, and one that fits but is far too stiff to hold 1.5 N precisely.
  const catalogue = cat.importTable([
    'Part #\tOD\tWire Dia.\tLg.\tSpring Rate, lbs./in.\tMaterial\tEnds',
    'FITS\t0.36"\t0.032"\t0.75"\t3.6\tMusic Wire\tClosed & Ground',
    'TOOBIG\t0.75"\t0.04"\t1"\t1.5\tMusic Wire\tClosed & Ground',
    'STIFF\t0.36"\t0.051"\t0.75"\t41\tMusic Wire\tClosed & Ground',
  ].join('\n')).springs;
  for (const s of catalogue) {
    assert.equal(s.incomplete, false);
    assert.ok(s.travelToSolid_mm > 0, `${s.partNumber} must have travel`);
  }

  const hits = sm.searchCatalog(catalogue, { targetForce_N, maxOD_mm, positionTol_mm: 0.25 });
  const ok = hits.filter((h) => h.ok);
  const parts = ok.map((h) => h.spring.partNumber);
  assert.ok(!parts.includes('TOOBIG'), 'oversize spring must not survive the bore filter');

  const best = ok[0];
  assert.equal(best.spring.partNumber, 'FITS');
  assert.ok(best.spring.od_mm <= maxOD_mm);
  // Compressing by the reported amount really does give 1.5 N.
  close(sm.forceAtDeflection(best.spring.rate_Npmm, best.evaluation.working.deflection_mm), 1.5, 1e-9);
  // The working point sits inside the spring's own travel, not past solid.
  assert.ok(best.evaluation.working.installedLength_mm > best.spring.solidLength_mm);
  assert.ok(best.evaluation.working.travelUsedFraction < 1);

  // The stiff spring can technically reach 1.5 N, but 0.25 mm of assembly
  // slop swings the load by more than the load itself -- that is the whole
  // reason ranking is not just "does it fit".
  const stiff = ok.find((h) => h.spring.partNumber === 'STIFF');
  assert.ok(stiff, 'a stiff spring still physically reaches the force');
  assert.ok(stiff.evaluation.working.sensitivity.rssFraction >
    best.evaluation.working.sensitivity.rssFraction * 3);
  assert.ok(stiff.evaluation.working.sensitivity.worstCase_N > targetForce_N);
});

/* --------------------------------------- the fuller catalogue filter set */

test('every published field can be filtered on', () => {
  const base = { od_mm: 9, id_mm: 7, wireDia_mm: 1, freeLength_mm: 25, totalCoils: 20 };
  const a = sm.normalizeSpring({ partNumber: 'A', ...base });
  const b = sm.normalizeSpring({ partNumber: 'B', ...base, wireDia_mm: 0.7, id_mm: 7.6 });
  const hot = sm.normalizeSpring({ partNumber: 'HOT', ...base, maxTemp_C: 400 });
  const cold = sm.normalizeSpring({ partNumber: 'COLD', ...base, maxTemp_C: 80 });
  const cone = sm.normalizeSpring({ partNumber: 'CONE', ...base, nonLinearShape: 'Conical' });
  const open = sm.normalizeSpring({ partNumber: 'OPEN', ...base, endsKey: 'open' });

  const ok = (list, req) => sm.searchCatalog(list, { targetForce_N: 1.5, ...req })
    .filter((h) => h.ok).map((h) => h.spring.partNumber).sort();

  assert.deepEqual(ok([a, b], { maxWireDia_mm: 0.8 }), ['B']);
  assert.deepEqual(ok([a, b], { minWireDia_mm: 0.8 }), ['A']);
  assert.deepEqual(ok([a, b], { maxID_mm: 7.2 }), ['A']);
  assert.deepEqual(ok([a, b], { minID_mm: 7.4 }), ['B']);
  assert.deepEqual(ok([a], { minOD_mm: 10 }), []);
  assert.deepEqual(ok([a], { maxSolidLength_mm: 1 }), []);
  assert.deepEqual(ok([a, b], { minRate_Npmm: a.rate_Npmm }), ['A']);
  assert.deepEqual(ok([a, b], { maxRate_Npmm: b.rate_Npmm }), ['B']);
  assert.deepEqual(ok([a], { minRatedLoad_N: a.maxUsableForce_N * 2 }), []);
  assert.deepEqual(ok([a, open], { ends: ['open'] }), ['OPEN']);
  assert.deepEqual(ok([a, cone], { straightOnly: true }), ['A']);

  // Temperature: rated-too-low is excluded, but an unpublished rating is not
  // a failure -- most catalogue tables never carry one.
  assert.deepEqual(ok([hot, cold, a], { minTemperature_C: 200 }), ['A', 'HOT']);
});

test('a Fahrenheit rating converts on the way in', () => {
  const s = sm.normalizeSpring({ od_mm: 9, wireDia_mm: 1, freeLength_mm: 25, totalCoils: 20, maxTemp_C: 454.4 });
  close(s.maxTemp_F, 850, 1e-3);
  close(cat.toCelsius('850° F'), 454.44, 1e-4);
  close(cat.toCelsius('200 C'), 200);
});

test('cut-to-length stock is flagged, warned about and filterable', () => {
  // Nothing in a vendor record says "cut to length" except the product
  // family, so that is where it has to be read from.
  const stock = sm.normalizeSpring({
    partNumber: 'X1', family: 'Cut-to-Length Compression Springs',
    od_mm: 10, wireDia_mm: 1, freeLength_mm: 900, rate_Npmm: 0.15,
  });
  assert.equal(stock.cutToLength, true);
  assert.ok(stock.derived.includes('cutToLength'));
  // The rate is only the rate at the length you buy -- cutting changes it,
  // and a search that hid that would be lying about the force.
  const cutNotes = stock.warnings.filter((w) => /cut-to-length stock/i.test(w));
  assert.equal(cutNotes.length, 1, 'said once, not twice');
  assert.match(cutNotes[0], /half the length is about twice the rate/);

  const made = sm.normalizeSpring({
    partNumber: 'X2', family: 'Compression Springs',
    od_mm: 10, wireDia_mm: 1, freeLength_mm: 40, rate_Npmm: 2,
  });
  assert.equal(made.cutToLength, false);
  assert.ok(made.derived.includes('cutToLength'), 'a "no" is inferred from the family too');
  assert.ok(!made.warnings.some((w) => /cut-to-length/i.test(w)));

  // An explicit flag beats the family name either way round.
  assert.equal(sm.normalizeSpring({ family: 'Compression Springs', cutToLength: true, od_mm: 5 }).cutToLength, true);
  assert.equal(sm.normalizeSpring({ family: 'Cut-to-Length Compression Springs', cutToLength: false, od_mm: 5 }).cutToLength, false);

  const springs = [stock, made];
  const keys = (req) => sm.searchCatalog(springs, { targetForce_N: 2, ...req })
    .filter((r) => r.ok).map((r) => r.spring.partNumber);
  assert.deepEqual(keys({}).sort(), ['X1', 'X2']);
  assert.deepEqual(keys({ cutToLength: 'exclude' }), ['X2']);
  assert.deepEqual(keys({ cutToLength: 'only' }), ['X1']);

  // Excluded is not the same as unexplained: the row still says why.
  const [why] = sm.searchCatalog([stock], { targetForce_N: 2, cutToLength: 'exclude', includeRejected: true });
  assert.match(why.rejected.join(' '), /Cut-to-length stock, excluded/);
});

test('a spring keeps the units it was published in, per quantity', () => {
  // McMaster's metric tables are not metric throughout: millimetres for
  // lengths, but pounds for load and lbf per millimetre for rate. Collapsing
  // that to one "metric" flag would misreport every load in the listing.
  const u = sm.normalizeSourceUnits({ length: 'mm', force: 'lbf', rate: 'lbf/mm' });
  assert.deepEqual(u, { length: 'mm', force: 'lbf', rate: 'lbf/mm', temp: 'C' });
  // The old shorthand still means what it always did.
  assert.deepEqual(sm.normalizeSourceUnits('in'), { length: 'in', force: 'lbf', rate: 'lbf/in', temp: 'F' });
  assert.deepEqual(sm.normalizeSourceUnits('mm'), { length: 'mm', force: 'N', rate: 'N/mm', temp: 'C' });
  assert.deepEqual(sm.normalizeSourceUnits(undefined), sm.normalizeSourceUnits('in'));

  // 1 lbf/mm is a pound per millimetre, not per inch.
  assert.equal(sm.toSI(1, 'rate', 'lbf/mm'), sm.LBF_TO_N);
  assert.equal(sm.toSI(1, 'rate', 'lbf/in'), sm.LBF_PER_IN_TO_N_PER_MM);
  // Every factor round-trips, which is all the display layer relies on.
  for (const [q, table] of Object.entries(sm.UNIT_FACTORS)) {
    for (const unit of Object.keys(table)) {
      assert.ok(Math.abs(sm.fromSI(sm.toSI(7, q, unit), q, unit) - 7) < 1e-9, `${q}/${unit}`);
    }
  }

  const metric = sm.normalizeSpring({
    od_mm: 5.5, id_mm: 4.5, wireDia_mm: 0.5, freeLength_mm: 9.4,
    rate_Npmm: 0.33 * sm.LBF_TO_N, material: 'Music Wire',
    sourceUnits: { length: 'mm', force: 'lbf', rate: 'lbf/mm' },
  });
  assert.equal(metric.system, 'metric');
  assert.equal(metric.sourceUnits.force, 'lbf');
  // The engine stores SI regardless, so the physics is untouched by any of it.
  assert.ok(Math.abs(metric.rate_Npmm - 1.4679) < 1e-3);
  assert.equal(sm.normalizeSpring({ od_mm: 5, sourceUnits: 'in' }).system, 'inch');
  // A stated system is never overridden by the units.
  assert.equal(sm.normalizeSpring({ od_mm: 5, system: 'metric', sourceUnits: 'in' }).system, 'metric');
});

test('coil shape is a category, and searchable as one', () => {
  const straight = sm.normalizeSpring({ od_mm: 10, wireDia_mm: 1, freeLength_mm: 40, rate_Npmm: 2, partNumber: 'S' });
  assert.equal(straight.shapeKey, 'straight');
  assert.ok(!straight.warnings.some((w) => /rather than a straight/.test(w)));

  // Whether the form is named in a field or only in the family, it is read.
  const cone = sm.normalizeSpring({
    od_mm: 10, wireDia_mm: 1, freeLength_mm: 40, rate_Npmm: 2,
    partNumber: 'C', family: 'Conical Compression Springs',
  });
  assert.equal(cone.shapeKey, 'conical');
  assert.equal(sm.normalizeSpring({ od_mm: 10, shape: 'Tapered' }).shapeKey, 'conical');
  assert.equal(sm.normalizeSpring({ od_mm: 10, nonLinearShape: 'barrel' }).shapeKey, 'barrel');
  // A conical spring does not have one rate, and the report has to say so --
  // and must not quietly report a coil count or solid length that assumes one.
  assert.ok(cone.warnings.some((w) => /Conical rather than a straight cylindrical spring/.test(w)));
  assert.equal(cone.solidLength_mm, null);
  assert.equal(cone.totalCoils, null);
  assert.equal(straight.solidLength_mm != null, true, 'a straight one still gets both');

  const springs = [straight, cone];
  const keys = (req) => sm.searchCatalog(springs, { targetForce_N: 2, ...req })
    .filter((r) => r.ok).map((r) => r.spring.partNumber);
  assert.deepEqual(keys({}).sort(), ['C', 'S']);
  assert.deepEqual(keys({ shapes: ['straight'] }), ['S']);
  assert.deepEqual(keys({ shapes: ['conical'] }), ['C']);
  assert.deepEqual(keys({ straightOnly: true }), ['S']);
  assert.deepEqual(keys({ systems: ['metric'] }), []);
});

test('a vendor rating above allowable is explained, not just flagged', () => {
  // 2006N234's shape: McMaster rates this series essentially to solid height,
  // which only works for pre-set wire. Saying "156% of allowable" and stopping
  // there reads as a data fault; it is a different design basis.
  const s = sm.normalizeSpring({
    partNumber: '2006N234', material: '302 Stainless Steel', ends: 'Closed and Ground',
    od_mm: 9.6, id_mm: 6.4, wireDia_mm: 1.6, freeLength_mm: 14.5,
    lengthAtMaxLoad_mm: 9.0, maxLoad_N: 39 * sm.LBF_TO_N, rate_Npmm: 7 * sm.LBF_TO_N,
  });
  assert.ok(s.vendorRatingUtilisation > 1.5);
  assert.ok(s.vendorRatingUtilisationSet < s.vendorRatingUtilisation);
  const note = s.warnings.find((w) => /pre-set at the factory/.test(w));
  assert.ok(note, 'the note is there');
  assert.match(note, /156%/);
  assert.match(note, /109%/);

  // A spring rated well inside allowable says nothing at all about set.
  const easy = sm.normalizeSpring({
    material: '302 Stainless Steel', od_mm: 9.6, wireDia_mm: 1.6,
    freeLength_mm: 14.5, rate_Npmm: 7 * sm.LBF_TO_N, maxLoad_N: 5,
  });
  assert.ok(easy.vendorRatingUtilisation < 1);
  assert.ok(!easy.warnings.some((w) => /pre-set/.test(w)));

  // And the search can be told to work on the pre-set basis instead.
  const strict = sm.evaluate(s, { targetForce_N: s.maxLoad_N }).working.utilisation;
  const preset = sm.evaluate(s, { targetForce_N: s.maxLoad_N, setRemoved: true }).working.utilisation;
  assert.ok(preset < strict);
  assert.ok(Math.abs(preset / strict - 0.35 / 0.50) < 1e-9, 'the two allowable fractions, nothing else');
});

test('a die spring is its own class, sized by the hole and shaft it runs in', () => {
  // Die springs publish no OD or ID at all, so nothing may be invented for
  // them; what they do publish is the bore and the rod, plus a load rating.
  const die = sm.normalizeSpring({
    partNumber: '9588K431', family: 'Color-Coded Die Springs', material: 'Chrome Silicon Steel',
    ends: 'Closed and Ground', colour: 'Gold', loadRating: 'Heavy Load',
    forHoleDia_mm: 9.525, forRodDia_mm: 4.7625,
    wireThickness_mm: 1.3716, wireWidth_mm: 1.8288,
    freeLength_mm: 31.75, lengthAtMaxLoad_mm: 23.876,
    maxLoad_N: 30 * sm.LBF_TO_N, rate_Npmm: 98 * sm.LBF_PER_IN_TO_N_PER_MM,
  });
  assert.equal(die.dutyKey, 'die');
  assert.equal(die.sectionKey, 'rectangular');
  assert.equal(die.shapeKey, 'straight');
  assert.equal(die.od_mm ?? null, null, 'no OD is published and none is invented');
  assert.equal(die.springIndex ?? null, null, 'and no spring index follows from one');
  assert.equal(die.solidLength_mm, null);
  assert.equal(sm.canUseCoilFormulas(die), false);
  assert.equal(sm.evaluate(die, { targetForce_N: 50 }).working.utilisation, null);
  // Force at length is unaffected -- it is the published rate and nothing else.
  close(sm.evaluate(die, { targetForce_N: 50 }).working.deflection_mm, 50 / die.rate_Npmm);

  // A general-purpose spring is not swept up by the die filter, and vice versa.
  const plain = sm.normalizeSpring({
    partNumber: 'P', family: 'Compression Springs', material: 'Music Wire',
    od_mm: 10, wireDia_mm: 1, freeLength_mm: 40, rate_Npmm: 2,
  });
  assert.equal(plain.dutyKey, 'general');
  const keys = (req) => sm.searchCatalog([die, plain], { targetForce_N: 20, ...req })
    .filter((r) => r.ok).map((r) => r.spring.partNumber);
  assert.deepEqual(keys({}).sort(), ['9588K431', 'P']);
  assert.deepEqual(keys({ duties: ['die'] }), ['9588K431']);
  assert.deepEqual(keys({ duties: ['general'] }), ['P']);
  assert.deepEqual(keys({ sections: ['round'] }), ['P']);
  assert.deepEqual(keys({ sections: ['rectangular'] }), ['9588K431']);
});

test('a rate is recovered from a published load at a published length', () => {
  // The urethane die springs publish no rate. Load over travel is exactly the
  // rate for a linear spring, and an average across that travel for a slug of
  // rubber -- which has to be said rather than assumed away.
  const slug = sm.normalizeSpring({
    partNumber: '1578T1', family: 'Rubber Die Springs', material: 'Polyurethane Rubber',
    forHoleDia_mm: 17.4625, forRodDia_mm: 4.7625,
    freeLength_mm: 25.4, lengthAtMaxLoad_mm: 19.05, maxLoad_N: 1280 * sm.LBF_TO_N,
  });
  assert.equal(slug.incomplete, false, 'it is usable, not discarded');
  close(slug.rate_Npmm, (1280 * sm.LBF_TO_N) / 6.35);
  assert.ok(slug.derived.includes('rate_Npmm'));
  assert.match(slug.warnings.join(' | '), /No spring rate is published/);
  assert.equal(slug.sectionKey, 'moulded');

  // A published rate is never overwritten by the inference.
  const given = sm.normalizeSpring({
    od_mm: 10, wireDia_mm: 1, freeLength_mm: 40, lengthAtMaxLoad_mm: 30,
    maxLoad_N: 100, rate_Npmm: 2, material: 'Music Wire',
  });
  close(given.rate_Npmm, 2);
  assert.ok(!given.derived.includes('rate_Npmm'));
});

test('a spring is held to its own published rate tolerance, not a blanket 10%', () => {
  const precision = {
    partNumber: 'P', material: 'Music Wire', od_mm: 10, wireDia_mm: 1,
    freeLength_mm: 40, rate_Npmm: 2, rateTol: 0.05,
  };
  const plain = { ...precision, partNumber: 'C', rateTol: undefined };

  // Nothing passed: the vendor's figure wins where there is one, and 10%
  // stands in where there is not. Getting this backwards overstates the
  // force band on exactly the springs bought for their tight tolerance.
  const a = sm.evaluate(precision, { targetForce_N: 10 }).working.sensitivity;
  assert.equal(a.rateTol, 0.05);
  assert.equal(a.rateTolSource, 'published');
  close(a.forceErrFromRate_N, 0.5);

  const b = sm.evaluate(plain, { targetForce_N: 10 }).working.sensitivity;
  assert.equal(b.rateTol, 0.10);
  assert.equal(b.rateTolSource, 'assumed');
  close(b.forceErrFromRate_N, 1.0);

  // An explicit figure still overrides both.
  const c = sm.evaluate(precision, { targetForce_N: 10, rateTol: 0.02 }).working.sensitivity;
  assert.equal(c.rateTol, 0.02);
  assert.equal(c.rateTolSource, 'entered');

  // And it survives the search path, which is where the UI actually goes.
  const [hit] = sm.searchCatalog([precision], { targetForce_N: 10 });
  assert.equal(hit.evaluation.working.sensitivity.rateTol, 0.05);

  // A tolerance no spring is made to is called out rather than believed.
  const silly = sm.normalizeSpring({ ...precision, rateTol: 0.5 });
  assert.match(silly.warnings.join(' | '), /far outside what any spring is made to/);
  assert.ok(!sm.normalizeSpring(precision).warnings.some((w) => /far outside/.test(w)));
});
