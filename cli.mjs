#!/usr/bin/env node
/**
 * cli.mjs -- the spring calculator from a terminal.
 *
 *   node cli.mjs design  --force 1.5N --max-od 0.5in
 *   node cli.mjs analyze --od 0.36in --wire 0.032in --free 0.75in --rate 3.6 --force 1.5N
 *   node cli.mjs find    --force 1.5N --max-od 0.5in --catalog data/mcmaster.json
 *   node cli.mjs import  pasted.tsv --out data/mcmaster.json
 *
 * Numbers accept units inline (0.5in, 12.7mm, 1.5N, 0.34lb, 3.6lbf/in, 0.63N/mm).
 * Bare numbers use --units us (inch/lbf, the default) or --units si (mm/N).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import * as sm from './spring-math.js';
import * as cat from './catalog.js';

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const die = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

/* --------------------------------------------------------------- format */

const f = (v, n = 3) => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(n));
const len = (mm, n = 3) => (mm == null ? '--' : `${f(mm, 2)} mm (${f(sm.mmToIn(mm), n)} in)`);
const force = (N, n = 3) => (N == null ? '--' : `${f(N, n)} N (${f(sm.nToLbf(N), n)} lbf)`);
const rate = (k) => (k == null ? '--' : `${f(k, 4)} N/mm (${f(sm.nPerMmToLbfPerIn(k), 2)} lbf/in)`);
const pct = (x) => (x == null ? '--' : `${(x * 100).toFixed(0)}%`);

function table(rows, cols) {
  if (!rows.length) return '  (none)';
  const w = cols.map((c) => Math.max(c.head.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ');
  return [line(cols.map((c) => c.head)), line(w.map((n) => '-'.repeat(n))),
    ...rows.map((r) => line(cols.map((c) => c.get(r))))].join('\n');
}

/* --------------------------------------------------- unit-aware readers */

const usUnits = (a) => String(a.units || 'us').toLowerCase() !== 'si';
const readLen = (v, a) => (v == null ? null : cat.toMm(String(v), usUnits(a) ? 'in' : 'mm'));
const readForce = (v, a) => (v == null ? null : cat.toNewtons(String(v), usUnits(a) ? 'lbf' : 'N'));
const readRate = (v, a) => (v == null ? null : cat.toNewtonsPerMm(String(v), usUnits(a) ? 'lbf/in' : 'N/mm'));

/* -------------------------------------------------------------- commands */

function cmdDesign(a) {
  const F = readForce(a.force, a) ?? die('--force is required');
  const maxOD = readLen(a['max-od'], a) ?? die('--max-od is required');
  const material = a.material || 'music-wire';
  const range = [
    readLen(a['min-travel'], a) ?? sm.inToMm(0.05),
    readLen(a['max-travel'], a) ?? sm.inToMm(0.5),
  ];
  const ds = sm.designSpace({
    targetForce_N: F, maxOD_mm: maxOD, materialKey: material,
    deflectionRange_mm: range, steps: Number(a.steps || 8),
  });

  console.log(`\nTarget ${force(F)} in an envelope of ${len(maxOD)} OD, ${sm.getMaterial(material).name}\n`);
  console.log('Filter the vendor catalogue to this spring-rate window:');
  console.log(`  ${rate(ds.rateWindow_Npmm[0])}  ..  ${rate(ds.rateWindow_Npmm[1])}`);
  console.log(`  (softer end = ${len(range[1])} of travel at the working load, stiffer end = ${len(range[0])})\n`);
  console.log('Working point vs. how tightly you can hold the force');
  console.log('(assumes +/-10% rate tolerance and +/-0.25 mm of assembly position error):\n');

  const rows = ds.points.map((p) => {
    const dx = 0.25;
    const err = (p.rate_Npmm * dx + F * 0.10) / F;
    const best = p.options[0]; // designSpace sorts most-compact first
    return { p, err, best };
  });
  console.log(table(rows, [
    { head: 'deflection', get: (r) => len(r.p.deflection_mm) },
    { head: 'rate', get: (r) => rate(r.p.rate_Npmm) },
    { head: 'force band', get: (r) => `+/-${pct(r.err)}` },
    { head: 'wire in', get: (r) => (r.best ? f(r.best.wireDia_in, 3) : '--') },
    { head: 'C', get: (r) => (r.best ? f(r.best.springIndex, 1) : '--') },
    { head: 'coils', get: (r) => (r.best ? f(r.best.activeCoils, 1) : '--') },
    { head: 'min free in', get: (r) => (r.best ? f(sm.mmToIn(r.best.minFreeLength_mm), 3) : '--') },
    { head: 'stress@solid', get: (r) => (r.best ? pct(r.best.stressUtilisationAtSolid) : '--') },
  ]));
  console.log('\nMore travel at the working load means a softer spring, which means');
  console.log('position error costs you less force. That is the whole trade.\n');
}

function springFromArgs(a) {
  return cat.springFromForm({
    partNumber: a.part || 'spring', lengthUnit: usUnits(a) ? 'in' : 'mm',
    rateUnit: usUnits(a) ? 'lbf/in' : 'N/mm', forceUnit: usUnits(a) ? 'lbf' : 'N',
    od: a.od, id: a.id, wireDia: a.wire, freeLength: a.free, solidLength: a.solid,
    rate: a.rate, maxLoad: a['max-load'], maxDeflection: a['max-deflection'],
    totalCoils: a.coils, activeCoils: a['active-coils'],
    materialKey: a.material || undefined, endsKey: a.ends || undefined,
  });
}

function reportSpring(s, ev, a) {
  console.log(`\n${s.partNumber || '(unnamed spring)'}${s.vendor ? '  --  ' + s.vendor : ''}`);
  if (s.url) console.log(s.url);
  console.log('-'.repeat(64));
  console.log(`  material        ${sm.getMaterial(s.materialKey).name}`);
  console.log(`  ends            ${sm.getEnds(s.endsKey).name}`);
  console.log(`  OD / ID         ${len(s.od_mm)} / ${len(s.id_mm)}`);
  console.log(`  wire dia        ${len(s.wireDia_mm, 4)}`);
  console.log(`  mean dia        ${len(s.meanDia_mm)}   index C = ${f(s.springIndex, 2)}`);
  console.log(`  free length     ${len(s.freeLength_mm)}`);
  console.log(`  solid length    ${len(s.solidLength_mm)}${s.derived.includes('solidLength_mm') ? '  [derived]' : ''}`);
  console.log(`  active coils    ${f(s.activeCoils, 2)}${s.derived.includes('activeCoils') ? '  [derived]' : ''}`);
  console.log(`  rate            ${rate(s.rate_Npmm)}${s.derived.includes('rate_Npmm') ? '  [derived]' : ''}`);
  console.log(`  travel to solid ${len(s.travelToSolid_mm)}`);
  console.log(`  usable travel   ${len(s.usableTravel_mm)}  (${s.usableTravelSource || '--'})`);
  console.log(`  max usable load ${force(s.maxUsableForce_N)}`);
  if (ev.atSolid) console.log(`  load at solid   ${force(ev.atSolid.force_N)}  (${pct(ev.atSolid.utilisation)} of allowable stress)`);

  const w = ev.working;
  if (w) {
    console.log(`\n  AT ${force(w.targetForce_N)}`);
    console.log(`  compress by     ${len(w.deflection_mm)}`);
    console.log(`  installed lg    ${len(w.installedLength_mm)}`);
    console.log(`  travel used     ${pct(w.travelUsedFraction)} of usable, headroom ${len(w.travelHeadroom_mm)}`);
    console.log(`  shear stress    ${f(w.tauStatic_MPa, 0)} MPa = ${pct(w.utilisation)} of allowable ${f(ev.allowable.tauAllow_MPa, 0)} MPa`);
    const sen = w.sensitivity;
    console.log(`  force band      ${force(sen.forceRange_N[0])} .. ${force(sen.forceRange_N[1])}`);
    console.log(`                  +/-${pct(sen.worstCaseFraction)} worst case, +/-${pct(sen.rssFraction)} RSS`);
    console.log(`                  ${f(sen.forceErrFromPosition_N, 3)} N from +/-${f(sen.positionBand_mm, 3)} mm position, ${f(sen.forceErrFromRate_N, 3)} N from rate tolerance`);
    console.log(`  verdict         ${ev.feasible ? 'WORKS' : 'NO'}`);
    ev.reasons.forEach((r) => console.log(`                  - ${r}`));
  }
  if (ev.buckling) {
    console.log(`\n  buckling        ${ev.buckling.unconditionallyStable
      ? 'stable at any deflection'
      : `buckles past ${len(ev.buckling.criticalDeflection_mm)} unless guided`}`);
  }
  if (ev.warnings.length) {
    console.log('\n  notes');
    ev.warnings.forEach((x) => console.log(`    - ${x}`));
  }
  console.log('');
}

function cmdAnalyze(a) {
  const s = springFromArgs(a);
  if (s.incomplete) die(`not enough data: missing ${s.missing.join(', ')}`);
  const F = readForce(a.force, a);
  const ev = sm.evaluate(s, {
    targetForce_N: F,
    positionTol_mm: readLen(a['position-tol'], a) ?? 0.25,
    rateTol: Number(a['rate-tol'] ?? 0.10),
    endCondition: a['end-condition'] || 'fixed-fixed',
    setRemoved: !!a['set-removed'],
  });
  reportSpring(s, ev, a);
  if (a.at) {
    const L = readLen(a.at, a);
    console.log(`  at installed length ${len(L)}: ${force(sm.forceAtLength(s.rate_Npmm, s.freeLength_mm, L))}\n`);
  }
}

function loadCatalog(path) {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) return cat.fromCatalogJson(text);
  return cat.importTable(text).springs;
}

function cmdFind(a) {
  const path = a.catalog || die('--catalog <file.json|file.tsv> is required');
  const springs = loadCatalog(path);
  const F = readForce(a.force, a) ?? die('--force is required');
  const hits = sm.searchCatalog(springs, {
    targetForce_N: F,
    maxOD_mm: readLen(a['max-od'], a),
    minID_mm: readLen(a['min-id'], a),
    maxFreeLength_mm: readLen(a['max-free'], a),
    maxInstalledLength_mm: readLen(a['max-installed'], a),
    materials: a.material ? String(a.material).split(',') : null,
    maxTravelUsedFraction: Number(a['max-travel-used'] ?? 1),
    positionTol_mm: readLen(a['position-tol'], a) ?? 0.25,
    rateTol: Number(a['rate-tol'] ?? 0.10),
    sortBy: a.sort || 'robustness',
    includeRejected: !!a.all,
  });
  const shown = hits.slice(0, Number(a.limit || 20));
  console.log(`\n${springs.length} springs in ${path}; ${hits.filter((h) => h.ok).length} can deliver ${force(F)}.\n`);
  console.log(table(shown, [
    { head: '', get: (h) => (h.ok ? 'ok' : 'no') },
    { head: 'part', get: (h) => h.spring.partNumber || '--' },
    { head: 'OD in', get: (h) => f(sm.mmToIn(h.spring.od_mm), 3) },
    { head: 'free in', get: (h) => f(sm.mmToIn(h.spring.freeLength_mm), 3) },
    { head: 'rate lbf/in', get: (h) => f(sm.nPerMmToLbfPerIn(h.spring.rate_Npmm), 2) },
    { head: 'compress in', get: (h) => f(sm.mmToIn(h.evaluation.working?.deflection_mm), 3) },
    { head: 'installed in', get: (h) => f(sm.mmToIn(h.evaluation.working?.installedLength_mm), 3) },
    { head: 'travel used', get: (h) => pct(h.evaluation.working?.travelUsedFraction) },
    { head: 'force band', get: (h) => (h.evaluation.working ? `+/-${pct(h.evaluation.working.sensitivity.worstCaseFraction)}` : '--') },
    { head: 'stress', get: (h) => pct(h.evaluation.working?.utilisation) },
    { head: 'why not', get: (h) => (h.ok ? '' : h.rejected[0]) },
  ]));
  console.log('');
  if (a.detail && shown.length) reportSpring(shown[0].spring, shown[0].evaluation, a);
}

function cmdImport(a) {
  const path = a._[1] || die('usage: cli.mjs import <file.tsv|file.csv> [--out catalog.json]');
  const res = cat.importTable(readFileSync(path, 'utf8'), {
    vendor: a.vendor || 'McMaster-Carr',
    lengthUnit: usUnits(a) ? 'in' : 'mm',
    rateUnit: usUnits(a) ? 'lbf/in' : 'N/mm',
    forceUnit: usUnits(a) ? 'lbf' : 'N',
    source: path,
  });
  if (res.error) die(res.error);
  const usable = res.springs.filter((s) => !s.incomplete);
  console.log(`parsed ${res.rows.length} rows -> ${usable.length} usable springs (${res.springs.length - usable.length} incomplete, ${res.skipped.length} lines skipped)`);
  console.log(`columns recognised: ${res.mapping.filter((m) => m.field).map((m) => `${m.header} -> ${m.field}`).join(', ')}`);
  if (res.unmapped.length) console.log(`columns ignored: ${res.unmapped.map((m) => m.header).join(', ')}`);
  if (a.out) {
    writeFileSync(a.out, JSON.stringify(cat.toCatalogJson(res.springs, { vendor: a.vendor || 'McMaster-Carr', source: path }), null, 2));
    console.log(`wrote ${a.out}`);
  }
}

/* ------------------------------------------------------------------ main */

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const commands = { design: cmdDesign, analyze: cmdAnalyze, find: cmdFind, import: cmdImport };
if (!cmd || args.help || !commands[cmd]) {
  console.log(readFileSync(new URL(import.meta.url).pathname, 'utf8').split('\n').slice(2, 15).join('\n').replace(/^ \* ?/gm, ''));
  process.exit(cmd && !commands[cmd] ? 1 : 0);
}
commands[cmd](args);
