import test from 'node:test';
import assert from 'node:assert/strict';
import * as sm from '../spring-math.js';
import * as cat from '../catalog.js';

const close = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} !~= ${b}`);

/** The real McMaster product-page paste, boilerplate and all. */
const SAMPLE = [
  'Material\tCobalt Nickel',
  'Length\t0.05"',
  'OD\t0.025"',
  'OD Tolerance\t-0.002" to 0.002"',
  'ID\t0.016"',
  'Wire Diameter\t0.005"',
  'Compressed Length @ Maximum Load\t0.037"',
  'Maximum Load\t0.2 lb.',
  'Spring Rate\t15 lbf/in',
  'Spring Rate Tolerance\t-1.54 lbf/in to 1.54 lbf/in',
  'End Type\tClosed',
  'Compression Spring Type\tStraight',
  'Maximum Temperature\t850° F',
  'Performance\tUltra Corrosion Resistant',
  'Spring Type\tCompression',
  'System of Measurement\tInch',
  'Country of Origin\tUnited States, China, Germany, India, Mexico, United Kingdom',
  'DFARS Compliance\tSpecialty Metals COTS-Exempt',
  'Export Control Classification Number (ECCN)\tEAR99',
  'REACH Compliance\tREACH (EC 1907/2006) (01/23/2024, 240 SVHC) Compliant',
  'RoHS Compliance\tRoHS 3 (2015/863/EU) Compliant',
  'Schedule B Number\t732020.5000',
  'U.S.–Mexico–Canada Agreement (USMCA) Qualifying\tNo',
].join('\n');

const TABLE = [
  'Part #\tOD\tWire Dia.\tLg.\tSpring Rate, lbs./in.\tMaterial\tEnds',
  '9657K304\t0.36"\t0.032"\t0.471"\t4.5\tMusic Wire\tClosed & Ground',
].join('\n');

test('a spec sheet and a table are told apart', () => {
  assert.equal(cat.looksLikeSpecSheet(SAMPLE), true);
  assert.equal(cat.looksLikeSpecSheet(TABLE), false);
  assert.equal(cat.importAny(SAMPLE).format, 'spec-sheet');
  assert.equal(cat.importAny(TABLE).format, 'table');
  assert.equal(cat.importAny('   ').format, 'empty');
});

test('every usable field is pulled out of the sample sheet', () => {
  const { blocks } = cat.importAny(SAMPLE, { vendor: 'McMaster-Carr' });
  assert.equal(blocks.length, 1);
  const s = blocks[0].spring;
  assert.equal(s.incomplete, false);
  close(s.od_mm, sm.inToMm(0.025));
  close(s.id_mm, sm.inToMm(0.016));
  close(s.wireDia_mm, sm.inToMm(0.005));
  close(s.freeLength_mm, sm.inToMm(0.05));
  close(s.rate_Npmm, sm.lbfPerInToNPerMm(15));
  close(s.maxLoad_N, sm.lbfToN(0.2));
  assert.equal(s.materialKey, 'cobalt-nickel');
  assert.equal(s.endsKey, 'closed');
  assert.equal(s.vendor, 'McMaster-Carr');
});

test('compressed-length-at-max-load becomes the usable travel', () => {
  const s = cat.importAny(SAMPLE).blocks[0].spring;
  // 0.050 free - 0.037 compressed = 0.013 in of travel.
  close(sm.mmToIn(s.usableTravel_mm), 0.013, 1e-6);
  // ...and that travel at the published rate reproduces the published load.
  close(sm.nToLbf(s.maxUsableForce_N), 0.195, 1e-3);
});

test('the sheet’s own rate tolerance is used instead of the 10% default', () => {
  const s = cat.importAny(SAMPLE).blocks[0].spring;
  close(s.rateTol, 1.54 / 15, 1e-9);
  const ev = sm.evaluate(s, { targetForce_N: 0.5, positionTol_mm: 0 });
  // With no position error the whole band is the spring's own rate tolerance.
  close(ev.working.sensitivity.rssFraction, 1.54 / 15, 1e-9);
});

test('a sheet with no part number still gets a usable name', () => {
  const s = cat.importAny(SAMPLE).blocks[0].spring;
  assert.equal(s.partNumber, undefined);
  assert.match(s.label, /0\.025" OD/);
  assert.match(s.label, /0\.005" wire/);
  assert.match(s.label, /0\.050" long/);
  // No part number means no invented vendor link.
  assert.equal(s.url, undefined);
});

test('a part number supplied by hand is used, and drives the vendor link', () => {
  const s = cat.importAny(SAMPLE, {
    vendor: 'McMaster-Carr', partNumber: '9001K11',
    urlTemplate: 'https://www.mcmaster.com/{part}/',
  }).blocks[0].spring;
  assert.equal(s.partNumber, '9001K11');
  assert.equal(s.label, undefined);
});

test('a part number printed on the sheet is picked up', () => {
  const s = cat.importAny(`Part #\t9657K304\n${SAMPLE}`, {
    vendor: 'McMaster-Carr', urlTemplate: 'https://www.mcmaster.com/{part}/',
  }).blocks[0].spring;
  assert.equal(s.partNumber, '9657K304');
  assert.match(s.url, /9657K304/);
});

test('boilerplate is reported as ignored, not silently dropped', () => {
  const { ignored, read } = cat.importAny(SAMPLE).blocks[0];
  assert.ok(ignored.some((x) => /Country of Origin/.test(x)));
  assert.ok(ignored.some((x) => /RoHS/.test(x)));
  assert.ok(ignored.some((x) => /ECCN/i.test(x)));
  // Everything actually used is listed back with its original label.
  assert.ok(read.some((r) => r.label === 'Wire Diameter' && r.field === 'wireDia_mm'));
  assert.ok(read.some((r) => r.field === 'rateTol' && /10\.3/.test(r.note)));
  assert.ok(read.some((r) => r.field === 'units'));
});

test('the wrong kind of spring is refused', () => {
  const res = cat.importAny([
    'Spring Type\tExtension', 'Material\tMusic Wire', 'OD\t0.3"',
    'Wire Diameter\t0.03"', 'Length\t1"', 'Spring Rate\t2 lbf/in',
  ].join('\n'));
  assert.equal(res.springs.length, 0);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].rejected, /an extension spring/);
});

test('a non-cylindrical spring warns that the rate is not linear', () => {
  const sheet = (shape) => [
    'Material\t302 Stainless Steel', 'Length\t1"', 'OD\t0.3"', 'Wire Diameter\t0.03"',
    'Spring Rate\t2 lbf/in', 'End Type\tClosed and Ground', 'Spring Type\tCompression',
    `Compression Spring Type\t${shape}`, 'System of Measurement\tInch',
  ].join('\n');
  assert.equal(cat.importAny(sheet('Straight')).springs[0].warnings.length, 0);
  const conical = cat.importAny(sheet('Conical')).springs[0];
  assert.ok(conical.warnings.some((w) => /Conical rather than a straight cylindrical spring/.test(w)));
  assert.equal(conical.shapeKey, 'conical');
  // The cylinder formulas are off, not just caveated.
  assert.equal(conical.solidLength_mm, null);
  assert.equal(conical.totalCoils, null);
});

test('two sheets pasted back to back split into two springs', () => {
  const one = ['Material\tMusic Wire', 'OD\t0.3"', 'Wire Diameter\t0.03"', 'Length\t1"', 'Spring Rate\t2 lbf/in'];
  const two = ['Material\tMusic Wire', 'OD\t0.4"', 'Wire Diameter\t0.035"', 'Length\t1.2"', 'Spring Rate\t3 lbf/in'];
  // No blank line between them -- the repeated "Material" is the boundary.
  const res = cat.importAny([...one, ...two].join('\n'));
  assert.equal(res.springs.length, 2);
  close(res.springs[0].od_mm, sm.inToMm(0.3));
  close(res.springs[1].od_mm, sm.inToMm(0.4));
  // A blank line works as a separator too.
  assert.equal(cat.importAny([one.join('\n'), two.join('\n')].join('\n\n')).springs.length, 2);
});

test('a metric sheet is read in millimetres', () => {
  const s = cat.importAny([
    'Material\t302 Stainless Steel', 'Length\t25', 'OD\t10', 'Wire Diameter\t1',
    'Spring Rate\t0.5 N/mm', 'End Type\tClosed and Ground',
    'System of Measurement\tMetric',
  ].join('\n')).springs[0];
  close(s.od_mm, 10);
  close(s.freeLength_mm, 25);
  close(s.rate_Npmm, 0.5);
});

test('labels are matched to the right field, not a longer one containing it', () => {
  const { blocks } = cat.importAny(SAMPLE);
  const byField = Object.fromEntries(blocks[0].read.map((r) => [r.field, r.label]));
  // "OD Tolerance" must not be read as OD, nor "Compressed Length @ Maximum
  // Load" as Maximum Load.
  assert.equal(byField.od_mm, 'OD');
  assert.equal(byField.odTol_mm, 'OD Tolerance');
  assert.equal(byField.maxLoad_N, 'Maximum Load');
  assert.equal(byField.lengthAtMaxLoad_mm, 'Compressed Length @ Maximum Load');
  assert.equal(byField.freeLength_mm, 'Length');
});

test('a colon-separated sheet parses too', () => {
  const s = cat.importAny([
    'Material: Music Wire', 'OD: 0.3"', 'Wire Diameter: 0.03"',
    'Length: 1"', 'Spring Rate: 2 lbf/in',
  ].join('\n')).springs[0];
  close(s.od_mm, sm.inToMm(0.3));
  close(s.rate_Npmm, sm.lbfPerInToNPerMm(2));
});
