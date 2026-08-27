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

test('incomplete rows report what is missing instead of guessing', () => {
  const s = sm.normalizeSpring({ od_mm: 10 });
  assert.equal(s.incomplete, true);
  assert.ok(s.missing.includes('wire diameter'));
  const noRate = sm.normalizeSpring({ od_mm: 10, wireDia_mm: 1 });
  assert.equal(noRate.incomplete, true);
  assert.match(noRate.missing[0], /spring rate/);
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
