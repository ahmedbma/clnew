/**
 * nl-query.js -- turn a typed phrase into search parameters.
 *
 * Not a language model: a spring request has a small, sharp vocabulary
 * (a force, a bore, a rod, a length, a travel, a material, a preference),
 * so it is parsed rather than guessed at. Everything it understands is
 * reported back with the exact words it came from, and anything it could
 * not place is reported too -- a silent misread would be worse than no
 * parsing at all.
 *
 * Pure functions, no DOM. Output is SI (mm, N) like the rest of the engine.
 */

import { inToMm, resolveMaterial, MATERIALS } from './spring-math.js';
import { parseNumber, toMm, toNewtons } from './catalog.js';

/* ------------------------------------------------------------ normalising */

/** Words people write instead of digits, plus tidying of quotes and spacing. */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[×✕]/g, ' x ')
    .replace(/\bthree[\s-]?quarters?\b/g, '0.75')
    .replace(/\b(a|one)[\s-]?half\b/g, '0.5')
    .replace(/\bhalf\s+(a|an)\b/g, '0.5')
    .replace(/\bhalf\b/g, '0.5')
    .replace(/\b(a|one)[\s-]?quarter\b/g, '0.25')
    .replace(/\bquarter\b/g, '0.25')
    .replace(/\b(an|one)[\s-]?eighth\b/g, '0.125')
    .replace(/\beighth\b/g, '0.125')
    .replace(/\s+/g, ' ')
    .trim();
}

const FORCE_UNITS = /^(n|newtons?|lbf?|lbs|pounds?|oz|ozf|ounces?|g|gf|grams?|gram-force|kg|kgf|kilograms?)$/;

/** Map a spoken force unit onto the one the form's selector offers. */
function forceUnitOption(unit) {
  if (/^(lbf?|lbs|pounds?)$/.test(unit)) return 'lbf';
  if (/^(oz|ozf|ounces?)$/.test(unit)) return 'ozf';
  if (/^(g|gf|grams?|gram-force)$/.test(unit)) return 'gf';
  if (/^(kg|kgf|kilograms?)$/.test(unit)) return 'kgf';
  return 'N';
}
const LENGTH_UNITS = /^("|''|in|ins|inch|inches|mm|millimet(er|re)s?|cm|thou|mil|mils)$/;

/**
 * Split on clause boundaries. Without this a cue leaks across a comma --
 * "over a 1/8 shaft, max installed length 0.4in" would read the second
 * number as another shaft, because "shaft" is still in the look-behind.
 */
function clauses(text) {
  return text.split(/\s*(?:[,;]|\band\b|\bplus\b|\bbut\b)\s*/).map((c) => c.trim()).filter(Boolean);
}

/** Every number in one clause, with its unit and the words around it. */
function measurementsIn(text) {
  const re = /(\d+\s*-\s*\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d*\.\d+|\d+)\s*("|''|[a-z]+)?/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const rawUnit = (m[2] || '').trim();
    const isForce = FORCE_UNITS.test(rawUnit);
    const isLength = LENGTH_UNITS.test(rawUnit);
    // A trailing word that is not a unit belongs to the context, not the number.
    const unit = isForce || isLength ? rawUnit : '';
    const end = m.index + (unit ? m[0].length : m[1].length);
    out.push({
      text: text.slice(m.index, end).trim(),
      value: parseNumber(m[1]),
      unit,
      kind: isForce ? 'force' : isLength ? 'length' : 'bare',
      before: text.slice(0, m.index),
      after: text.slice(end),
    });
  }
  return out;
}

const measurements = (text) => clauses(text).flatMap(measurementsIn);

/* ------------------------------------------------------------ classifying */

// Checked in order; the first cue that matches a measurement's surroundings wins.
const LENGTH_CUES = [
  ['minID', /\b(rod|shaft|pin|mandrel|spindle|post|bolt|screw|guide)\b|\bclear(s|ing)?\b|\bover a\b|\baround a\b|\bslip over\b|\bid\b|\binside dia|\binner dia/],
  ['minDeflection', /\btravel|\bstroke|\bdeflect|\bcompress(es|ed|ion)? by\b|\bsqueeze|\bmovement|\bthrow\b/],
  ['maxInstalledLength', /\binstalled|\bcompressed (length|lg)|\bworking length|\bat length|\bin place|\bwhen compressed/],
  ['maxFreeLength', /\bfree length|\blong(er|est)?\b|\blength\b|\btall(er)?\b|\bheight\b|\bdeep(er)?\b/],
  ['maxOD', /\bod\b|\bo\.d\.|\boutside|\bouter|\bdiameter|\bdia\b|\bbore\b|\bhole\b|\bwide\b|\bwidth\b|\bfits?\b|\binto?\b|\bwithin\b|\bacross\b/],
];

const MIN_CUE = /\b(at least|minimum|min\.?|no less than|more than|greater than|over)\b\s*$/;
const MAX_CUE = /\b(at most|maximum|max\.?|no more than|under|less than|below|up to|no bigger than|no longer than|smaller than|within)\b\s*$/;

const SORT_CUES = [
  ['force-precision', /\b(most )?(precise|accurate|repeatable|consistent|tightest|tight tolerance|least variation|best control)\b/],
  ['travel', /\b(most|max(imum)?|more|lots of|plenty of|as much) (travel|stroke|headroom)\b/],
  ['compact', /\b(smallest|most compact|tiniest|shortest|least space|minimum (size|package))\b/],
  ['rate', /\b(softest|soft(est)? as|lowest rate|gentlest|weakest|most compliant)\b/],
];

/**
 * Parse a phrase into search parameters.
 *
 * Returns { fields, read, unparsed, lengthUnit }, where `fields` uses the same
 * names the search form does and `read` explains every decision.
 */
export function parseQuery(input, { defaultForceUnit = 'N' } = {}) {
  const text = normalise(input);
  const fields = {};
  const read = [];
  const unparsed = [];
  if (!text) return { fields, read, unparsed, lengthUnit: null, empty: true };

  const found = measurements(text);

  // Which unit system is the person speaking in? Decide from the lengths they
  // actually quoted -- the bare preposition "in" is not a unit, and a force
  // given in ounces says nothing about how they measure a bore.
  const lengthUnits = found.filter((m) => m.kind === 'length').map((m) => m.unit);
  const lengthUnit = lengthUnits.some((u) => /^(mm|cm|millimet)/.test(u)) ? 'mm'
    : lengthUnits.length ? 'in'
      : /millimet|\bmetric\b/.test(text) ? 'mm' : null;
  const fallbackLength = lengthUnit || 'in';
  const forceish = found.filter((m) => m.kind === 'force');
  const bare = found.filter((m) => m.kind === 'bare');

  const note = (field, m, valueText, extra) =>
    read.push({ field, from: m.text.trim(), value: valueText, note: extra || null });

  // --- force -----------------------------------------------------------
  let forceTaken = null;
  if (forceish.length) {
    forceTaken = forceish[0];
    const N = toNewtons(forceTaken.text, defaultForceUnit);
    if (N != null && N > 0) {
      fields.force_N = N;
      fields.forceUnit = forceUnitOption(forceTaken.unit);
      fields.forceValue = forceTaken.value;
      note('force', forceTaken, `${N.toFixed(3)} N`);
    }
    forceish.slice(1).forEach((m) => unparsed.push({ from: m.text, why: 'a second force — only the first is used' }));
  } else if (bare.length === 1 && !found.some((m) => m.kind === 'length')) {
    // A phrase that is just a number is a force in whatever unit is selected.
    const only = bare[0];
    const N = toNewtons(`${only.value} ${defaultForceUnit}`, defaultForceUnit);
    if (N != null && N > 0) {
      forceTaken = only;
      fields.force_N = N;
      fields.forceUnit = defaultForceUnit;
      fields.forceValue = only.value;
      note('force', only, `${N.toFixed(3)} N`, `no unit given, read as ${defaultForceUnit}`);
    }
  }

  // --- lengths ---------------------------------------------------------
  for (const m of found) {
    if (m === forceTaken || m.kind === 'force') continue;
    if (m.kind === 'bare' && !LENGTH_CUES.some(([, re]) => re.test(m.before) || re.test(m.after))) {
      unparsed.push({ from: m.text, why: 'no unit and nothing nearby saying what it measures' });
      continue;
    }
    const context = `${m.before} ${m.after}`;
    const hit = LENGTH_CUES.find(([, re]) => re.test(context));
    const field = hit ? hit[0] : 'maxOD';
    const mm = toMm(m.unit ? m.text : `${m.value} ${fallbackLength}`, fallbackLength);
    if (mm == null || !(mm > 0)) { unparsed.push({ from: m.text, why: 'could not read that as a length' }); continue; }

    // "at least 5mm OD" is a minimum on a field this only filters as a
    // maximum -- say so rather than quietly reversing the meaning.
    const wantsMin = MIN_CUE.test(m.before);
    if (wantsMin && field !== 'minDeflection' && field !== 'minID') {
      unparsed.push({ from: m.text, why: `read as a minimum, but ${field === 'maxOD' ? 'diameter' : 'length'} is only filtered as a maximum` });
      continue;
    }
    if (MAX_CUE.test(m.before) && field === 'minDeflection') {
      unparsed.push({ from: m.text, why: 'travel is only filtered as a minimum' });
      continue;
    }
    if (fields[`${field}_mm`] != null) { unparsed.push({ from: m.text, why: 'a second value for the same thing' }); continue; }

    fields[`${field}_mm`] = mm;
    const shown = fallbackLength === 'mm' ? `${mm.toFixed(2)} mm` : `${(mm / 25.4).toFixed(3)} in`;
    note(field, m, shown, hit ? null : 'no cue nearby, taken as the outside diameter');
  }

  // --- material --------------------------------------------------------
  const materialKey = resolveMaterial(text);
  if (materialKey) {
    fields.materialKey = materialKey;
    read.push({ field: 'material', from: materialKey.replace(/-/g, ' '), value: MATERIALS[materialKey].name });
  }

  // --- what to optimise for -------------------------------------------
  for (const [key, re] of SORT_CUES) {
    const hit = text.match(re);
    if (hit) {
      fields.sortBy = key;
      read.push({ field: 'sortBy', from: hit[0], value: key.replace(/-/g, ' ') });
      break;
    }
  }

  return { fields, read, unparsed, lengthUnit, empty: false };
}

/** One-line restatement of what a parse understood, for a receipt. */
export function describeParse(result) {
  if (result.empty) return 'Nothing typed.';
  if (!result.read.length) return 'Nothing in that could be turned into a search.';
  return result.read.map((r) => `${r.field}: ${r.value}`).join(' · ');
}
