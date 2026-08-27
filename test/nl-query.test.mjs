import test from 'node:test';
import assert from 'node:assert/strict';
import * as sm from '../spring-math.js';
import { parseQuery } from '../nl-query.js';

const close = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} !~= ${b}`);
const f = (q, opts) => parseQuery(q, opts).fields;

test('a bare force in any unit', () => {
  close(f('1.5N').force_N, 1.5);
  close(f('1.5 newtons').force_N, 1.5);
  close(f('0.337 lb').force_N, 1.4991, 1e-3);
  close(f('5.4oz').force_N, 1.5013, 1e-3);
  close(f('153 grams').force_N, 1.5004, 1e-3);
  // The unit typed is carried back so the form can show it unchanged.
  assert.equal(f('0.337 lb').forceUnit, 'lbf');
  assert.equal(f('153 grams').forceUnit, 'gf');
  assert.equal(f('1.5N').forceUnit, 'N');
});

test('a lone number takes the unit the form is already set to', () => {
  const r = parseQuery('1.5', { defaultForceUnit: 'lbf' });
  close(r.fields.force_N, sm.lbfToN(1.5));
  assert.match(r.read[0].note, /read as lbf/);
  // ...but only when it is genuinely the only number.
  assert.equal(f('1.5 in a 12mm hole').force_N, undefined);
});

test('spoken fractions and halves', () => {
  close(f('1.5N in a half inch bore').maxOD_mm, sm.inToMm(0.5));
  close(f('1.5N in a 1/2 inch bore').maxOD_mm, sm.inToMm(0.5));
  close(f('2N over a 1/8 inch shaft').minID_mm, sm.inToMm(0.125));
  close(f('2N, no longer than 1-1/2 inches').maxFreeLength_mm, sm.inToMm(1.5));
  close(f('1.5N in a quarter inch hole').maxOD_mm, sm.inToMm(0.25));
});

test('each kind of dimension lands in its own field', () => {
  const r = f('1.5N in a 12mm bore, over a 3mm rod, no longer than 25mm, '
    + 'installed length 18mm, at least 2mm of travel');
  close(r.maxOD_mm, 12);
  close(r.minID_mm, 3);
  close(r.maxFreeLength_mm, 25);
  close(r.maxInstalledLength_mm, 18);
  close(r.minDeflection_mm, 2);
});

test('a cue does not leak across a clause boundary', () => {
  // "shaft" belongs to the first clause only; without clause splitting the
  // second number reads as another shaft diameter.
  const r = f('2N over a 1/8 inch shaft, max installed length 0.4 in');
  close(r.minID_mm, sm.inToMm(0.125));
  close(r.maxInstalledLength_mm, sm.inToMm(0.4));
  assert.equal(r.maxOD_mm, undefined);
});

test('the unit system follows the lengths quoted, not the prose', () => {
  // The preposition "in" is not a unit, and ounces say nothing about bores.
  assert.equal(parseQuery('5oz, at least 3mm of travel').lengthUnit, 'mm');
  assert.equal(parseQuery('1.5N in a 12mm hole').lengthUnit, 'mm');
  assert.equal(parseQuery('1.5N in a 0.5 inch hole').lengthUnit, 'in');
  assert.equal(parseQuery('1.5N').lengthUnit, null);
});

test('a length with no cue is taken as the bore, and says so', () => {
  const r = parseQuery('1.5N, 0.5 inch');
  close(r.fields.maxOD_mm, sm.inToMm(0.5));
  assert.match(r.read.find((x) => x.field === 'maxOD').note, /taken as the outside diameter/);
});

test('materials and ranking intent', () => {
  assert.equal(f('1.5N stainless').materialKey, 'stainless-302');
  assert.equal(f('1.5N in 316 stainless').materialKey, 'stainless-316');
  assert.equal(f('1.5N music wire').materialKey, 'music-wire');
  assert.equal(f('1.5N, as precise as possible').sortBy, 'force-precision');
  assert.equal(f('1.5N, softest possible').sortBy, 'rate');
  assert.equal(f('1.5N, smallest possible').sortBy, 'compact');
  assert.equal(f('1.5N, most travel').sortBy, 'travel');
});

test('a minimum on a max-only field is refused, not silently reversed', () => {
  // Installed length is only ever an upper bound.
  const r = parseQuery('1.5N, installed length at least 5mm');
  assert.equal(r.fields.maxInstalledLength_mm, undefined);
  assert.equal(r.fields.minInstalledLength_mm, undefined);
  assert.match(r.unparsed[0].why, /only filtered as a maximum/);
  // Travel is the one dimension where a minimum is the natural reading.
  close(f('1.5N at least 3mm of travel').minDeflection_mm, 3);
  assert.equal(parseQuery('1.5N, at most 3mm of travel').fields.minDeflection_mm, undefined);
});

test('nothing understood is reported rather than guessed at', () => {
  const r = parseQuery('something springy please');
  assert.equal(r.read.length, 0);
  assert.equal(Object.keys(r.fields).length, 0);
  assert.equal(parseQuery('').empty, true);
});

test('duplicates and extra forces are flagged, never averaged', () => {
  const r = parseQuery('1.5N and 2N');
  close(r.fields.force_N, 1.5);
  assert.match(r.unparsed[0].why, /only the first is used/);
  const d = parseQuery('1.5N in a 10mm bore and a 12mm bore');
  close(d.fields.maxOD_mm, 10);
  assert.match(d.unparsed[0].why, /same thing/);
});

test('a parsed phrase actually drives a search', () => {
  const catalogue = [
    { partNumber: 'FITS', od_mm: 9, wireDia_mm: 0.7, freeLength_mm: 25, totalCoils: 20, material: '302 Stainless Steel' },
    { partNumber: 'TOOBIG', od_mm: 20, wireDia_mm: 0.7, freeLength_mm: 25, totalCoils: 20, material: '302 Stainless Steel' },
    { partNumber: 'WRONGMAT', od_mm: 9, wireDia_mm: 0.7, freeLength_mm: 25, totalCoils: 20, material: 'Music Wire' },
  ].map(sm.normalizeSpring);
  const q = parseQuery('1.5N in a 12mm bore, stainless');
  const hits = sm.searchCatalog(catalogue, {
    targetForce_N: q.fields.force_N,
    maxOD_mm: q.fields.maxOD_mm,
    materials: q.fields.materialKey ? [q.fields.materialKey] : null,
  }).filter((h) => h.ok).map((h) => h.spring.partNumber);
  assert.deepEqual(hits, ['FITS']);
});

/* ------------------------------------ the fuller McMaster field surface */

test('inside diameter reads in both directions', () => {
  close(f('1.5N, ID at least 4mm').minID_mm, 4);
  close(f('1.5N with ID under 6mm').maxID_mm, 6);
  // A rod is a minimum by its nature, with no min/max word needed.
  close(f('1.5N over a 3mm rod').minID_mm, 3);
});

test('wire diameter, solid length and free-length minimums', () => {
  close(f('1.5N, 0.03 inch wire or thinner').maxWireDia_mm, sm.inToMm(0.03));
  close(f('1.5N, wire at least 0.5mm').minWireDia_mm, 0.5);
  close(f('1.5N, solid length under 10mm').maxSolidLength_mm, 10);
  close(f('1.5N, free length at least 20mm').minFreeLength_mm, 20);
  close(f('1.5N, at least 5mm OD').minOD_mm, 5);
});

test('spring rate, with its compound unit and its direction', () => {
  close(f('1.5N, rate under 2 lbf/in').maxRate_Npmm, sm.lbfPerInToNPerMm(2));
  close(f('1.5N, spring rate at least 0.5 N/mm').minRate_Npmm, 0.5);
  // A rate must not leave its unit behind to be re-read as a second force.
  const r = parseQuery('1.5N, rate under 2 lbf/in');
  close(r.fields.force_N, 1.5);
  assert.equal(r.unparsed.length, 0);
});

test('end type is read only when the words are about spring ends', () => {
  assert.equal(f('1.5N, closed and ground ends').endsKey, 'closed-and-ground');
  assert.equal(f('1.5N, squared ends').endsKey, 'closed');
  assert.equal(f('1.5N, open ends').endsKey, 'open');
  // "open" on its own is an ordinary English word, not an end treatment.
  assert.equal(f("1.5N, I'm open to anything").endsKey, undefined);
});

test('a long phrase fills many filters at once without collisions', () => {
  const r = f('1.5N in a 12mm bore, over a 3mm rod, wire at least 0.5mm, '
    + 'free length under 25mm, rate under 2 N/mm, closed and ground ends, stainless');
  close(r.force_N, 1.5);
  close(r.maxOD_mm, 12);
  close(r.minID_mm, 3);
  close(r.minWireDia_mm, 0.5);
  close(r.maxFreeLength_mm, 25);
  close(r.maxRate_Npmm, 2);
  assert.equal(r.endsKey, 'closed-and-ground');
  assert.equal(r.materialKey, 'stainless-302');
});
