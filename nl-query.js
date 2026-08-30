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

import { inToMm, resolveMaterial, resolveEnds, resolveShape, MATERIALS, END_TYPES, SHAPES, SECTIONS } from './spring-math.js';
import { parseNumber, toMm, toNewtons, toNewtonsPerMm } from './catalog.js';

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
 * "1.5N to 15N", "between 1.5 and 15 N", "2-8 lbf", "15N down to 1.5N".
 *
 * The unit is required on the second number, which is what keeps this off
 * length ranges ("0.5 to 0.75 in") and mixed-number fractions ("1-1/2 inch")
 * with no extra guarding. "and" only joins a band behind an opening word, so a
 * plain "1.5N and 2N" stays what it always was: one force and a leftover.
 */
const FORCE_UNIT_ALT = '(?:n|newtons?|lbf?|lbs|pounds?|oz|ozf|ounces?|gf?|grams?|gram-force|kgf?|kilograms?)';
const NUM = '(\\d*\\.\\d+|\\d+)';
const BAND_TAIL = '\\s*' + NUM + '\\s*(' + FORCE_UNIT_ALT + ')(?![a-z/])';
const FORCE_RANGE_RES = [
  // Opened by a word that can only mean a range, so "and" is safe here.
  new RegExp('\\b(?:anywhere\\s+between|between|from|range\\s+of)\\s+' + NUM
    + '\\s*(' + FORCE_UNIT_ALT + ')?\\s*(?:\\bto\\b|\\band\\b|\\bthrough\\b|-|\u2013|\u2014)'
    + BAND_TAIL, 'i'),
  // Bare form: the joining word has to be unambiguous on its own.
  new RegExp(NUM + '\\s*(' + FORCE_UNIT_ALT + ')?\\s*'
    + '(?:(?:down|up)\\s+)?(?:\\bto\\b|\\bthrough\\b|-|\u2013|\u2014)'
    + BAND_TAIL, 'i'),
];

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

/**
 * Cues are matched in order, so the specific ones come first: a "rod" is an
 * inside diameter before "diameter" can claim it, and "wire" before "dia".
 * `directions` is what the search can actually filter on for that dimension,
 * and `fallback` is the direction assumed when no min/max word is present.
 */
const DIMENSION_CUES = [
  ['WireDia', /\bwire\b|\bgauge\b|\bgage\b/, ['min', 'max'], 'max'],
  ['ID', /\b(rod|shaft|pin|mandrel|spindle|post|guide)\b|\bclear(s|ing)?\b|\bover a\b|\baround a\b|\bslip over\b|\bid\b|\binside dia|\binner dia/, ['min', 'max'], 'min'],
  ['Deflection', /\btravel|\bstroke|\bdeflect|\bcompress(es|ed|ion)? by\b|\bsqueeze|\bmovement|\bthrow\b/, ['min'], 'min'],
  ['SolidLength', /\bsolid\b|\bstacked\b|\bfully compressed\b|\bshut height\b/, ['max'], 'max'],
  ['InstalledLength', /\binstalled|\bcompressed (length|lg)|\bworking length|\bat length|\bin place|\bwhen compressed/, ['max'], 'max'],
  ['FreeLength', /\bfree length|\blong(er|est)?\b|\blength\b|\btall(er)?\b|\bheight\b|\bdeep(er)?\b/, ['min', 'max'], 'max'],
  ['OD', /\bod\b|\bo\.d\.|\boutside|\bouter|\bdiameter|\bdia\b|\bbore\b|\bhole\b|\bwide\b|\bwidth\b|\bfits?\b|\binto?\b|\bwithin\b|\bacross\b/, ['min', 'max'], 'max'],
];
const DIMENSION_FIELD = {
  WireDia: 'WireDia_mm', ID: 'ID_mm', Deflection: 'Deflection_mm',
  SolidLength: 'SolidLength_mm', InstalledLength: 'InstalledLength_mm',
  FreeLength: 'FreeLength_mm', OD: 'OD_mm',
};
const DIMENSION_NAME = {
  WireDia: 'wire diameter', ID: 'inside diameter', Deflection: 'travel',
  SolidLength: 'solid length', InstalledLength: 'installed length',
  FreeLength: 'free length', OD: 'outside diameter',
};

/**
 * Spring rate carries a compound unit the plain number scanner cannot see.
 * Unit-bearing forms are matched first so "rate under 2 lbf/in" is claimed
 * whole -- otherwise the keyword form takes "rate under 2" and abandons the
 * "lbf/in", which then reads as a second force.
 */
const RATE_UNIT_RE = /(?:(?:spring\s*)?(?:rate|stiffness)\D{0,16}?)?(\d*\.?\d+)\s*(lbf?\s*\/\s*in|lbs?\.?\s*\/\s*in\.?|n\s*\/\s*mm)/g;
const RATE_WORD_RE = /(?:spring\s*)?(?:rate|stiffness)\D{0,16}?(\d*\.?\d+)/g;

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

  // Rates first. Their spans are blanked out of the text the number scanner
  // sees, so a rate's digits and unit are never re-read as a force or a size.
  let scrubbed = text;
  const takeRates = (re, unitRequired) => {
    re.lastIndex = 0;
    let r;
    while ((r = re.exec(scrubbed)) !== null) {
      const raw = r[0];
      const value = parseNumber(r[1]);
      const unit = (r[2] || '').replace(/\s+/g, '') || null;
      if (value == null || (unitRequired && !unit)) continue;

      // The direction word usually sits inside the match ("rate at least 2"),
      // so look at everything up to the number, back to the clause boundary.
      const numberAt = raw.lastIndexOf(String(r[1]));
      const head = scrubbed.slice(0, r.index + numberAt);
      const clauseHead = head.slice(Math.max(head.lastIndexOf(','), head.lastIndexOf(';')) + 1);
      const dir = MIN_CUE.test(clauseHead) ? 'min' : 'max';

      const npmm = unit
        ? toNewtonsPerMm(`${value} ${unit}`, 'lbf/in')
        : toNewtonsPerMm(`${value}`, /n\s*\/\s*mm|\bmm\b/.test(scrubbed) ? 'N/mm' : 'lbf/in');
      if (npmm == null || !(npmm > 0)) continue;

      const key = `${dir}Rate_Npmm`;
      if (fields[key] == null) {
        fields[key] = npmm;
        read.push({ field: `${dir}Rate`, from: raw.trim(),
          value: `${npmm.toFixed(4)} N/mm`, note: unit ? null : 'no unit given, read as a spring rate' });
      }
      scrubbed = scrubbed.slice(0, r.index) + ' '.repeat(raw.length) + scrubbed.slice(r.index + raw.length);
      re.lastIndex = r.index + raw.length;
    }
  };
  takeRates(RATE_UNIT_RE, true);
  takeRates(RATE_WORD_RE, false);

  // A force band is read off the whole phrase before it is chopped into
  // clauses, because "between 1.5 and 15 N" straddles an "and" boundary. Like a
  // rate, the span is blanked out so its digits are not read a second time.
  let forceRange = null;
  const fr = FORCE_RANGE_RES.reduce((hit, re) => hit || re.exec(scrubbed), null);
  if (fr) {
    const unitB = fr[4].toLowerCase();
    const unitA = (fr[2] || unitB).toLowerCase();
    const a = toNewtons(`${fr[1]} ${unitA}`, defaultForceUnit);
    const b = toNewtons(`${fr[3]} ${unitB}`, defaultForceUnit);
    if (a != null && b != null && a > 0 && b > 0 && a !== b) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      forceRange = { lo, hi };
      fields.force_N = lo;
      fields.forceHigh_N = hi;
      fields.forceUnit = forceUnitOption(unitB);
      // The boxes are both read in one unit, so both values are restated in it
      // rather than each keeping the unit it happened to be spoken in.
      const per = toNewtons(`1 ${unitB}`, defaultForceUnit);
      fields.forceValue = lo / per;
      fields.forceHighValue = hi / per;
      read.push({ field: 'force band', from: fr[0].trim(),
        value: `${lo.toFixed(3)} N to ${hi.toFixed(3)} N`,
        note: 'springs must cover the whole band' });
      scrubbed = scrubbed.slice(0, fr.index) + ' '.repeat(fr[0].length) + scrubbed.slice(fr.index + fr[0].length);
    }
  }

  const found = measurements(scrubbed);

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
  if (forceRange) {
    // Already taken as a band above; any further force is spare.
    forceish.forEach((m) => unparsed.push({ from: m.text, why: 'a force band was already read from this' }));
  } else if (forceish.length) {
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

  // --- dimensions ------------------------------------------------------
  for (const m of found) {
    if (m === forceTaken || m.kind === 'force') continue;
    const context = `${m.before} ${m.after}`;
    const hit = DIMENSION_CUES.find(([, re]) => re.test(context));
    if (m.kind === 'bare' && !hit) {
      unparsed.push({ from: m.text, why: 'no unit and nothing nearby saying what it measures' });
      continue;
    }
    const [dim, , directions, fallback] = hit || DIMENSION_CUES.find(([d]) => d === 'OD');
    const mm = toMm(m.unit ? m.text : `${m.value} ${fallbackLength}`, fallbackLength);
    if (mm == null || !(mm > 0)) { unparsed.push({ from: m.text, why: 'could not read that as a length' }); continue; }

    // Direction comes from the words, and is refused rather than reversed
    // when the search cannot filter that way round.
    let dir = fallback;
    if (MIN_CUE.test(m.before)) dir = 'min';
    else if (MAX_CUE.test(m.before)) dir = 'max';
    if (!directions.includes(dir)) {
      unparsed.push({ from: m.text,
        why: `read as a ${dir}imum, but ${DIMENSION_NAME[dim]} is only filtered as a ${directions[0]}imum` });
      continue;
    }
    const field = `${dir}${DIMENSION_FIELD[dim]}`;
    if (fields[field] != null) { unparsed.push({ from: m.text, why: 'a second value for the same thing' }); continue; }

    fields[field] = mm;
    const shown = fallbackLength === 'mm' ? `${mm.toFixed(2)} mm` : `${(mm / 25.4).toFixed(3)} in`;
    note(`${dir}${dim}`, m, shown, hit ? null : 'no cue nearby, taken as the outside diameter');
  }

  // --- material --------------------------------------------------------
  const materialKey = resolveMaterial(text);
  if (materialKey) {
    fields.materialKey = materialKey;
    read.push({ field: 'material', from: materialKey.replace(/-/g, ' '), value: MATERIALS[materialKey].name });
  }

  // --- end treatment ---------------------------------------------------
  if (/\bends?\b|\bground\b|\bsquared\b/.test(text)) {
    const phrase = text.match(/\b(closed|squared|open|plain)(\s*(?:and|&)\s*ground)?(\s+ends?)?\b/);
    const endsKey = phrase ? resolveEnds(phrase[0]) : null;
    if (endsKey) {
      fields.endsKey = endsKey;
      read.push({ field: 'ends', from: phrase[0].trim(), value: END_TYPES[endsKey].name });
    }
  }

  // --- cut-to-length stock ---------------------------------------------
  // Worth its own cue: it is the difference between a finished spring and a
  // coil of stock, and people say so plainly one way or the other.
  const CUT = /cut[\s-]*to[\s-]*length|cut[\s-]*to[\s-]*fit|cuttable/;
  const cut = text.match(CUT);
  if (cut) {
    const head = text.slice(0, cut.index);
    const negated = /\b(no|not|non|without|exclude|excluding|avoid|skip|except|other than|besides)\b[^.]{0,20}$/.test(head)
      || /\b(ready[\s-]*made|finished|off[\s-]*the[\s-]*shelf)\b/.test(text);
    fields.cutToLength = negated ? 'exclude' : 'only';
    read.push({ field: 'cutToLength', from: cut[0],
      value: negated ? 'excluded' : 'cut-to-length stock only' });
  } else if (/\b(ready[\s-]*made|finished|off[\s-]*the[\s-]*shelf)\b/.test(text)) {
    fields.cutToLength = 'exclude';
    read.push({ field: 'cutToLength', from: text.match(/\b(ready[\s-]*made|finished|off[\s-]*the[\s-]*shelf)\b/)[0],
      value: 'excluded' });
  }

  // --- measurement system and coil shape -------------------------------
  // "metric" here means how the part is catalogued, not what units the answer
  // comes back in -- those are set by the unit pickers and are independent.
  // "metric" is never a unit, so it stands alone. "inch" nearly always is one
  // -- "a half inch bore" is a dimension, not a request for inch parts -- so it
  // only counts as a system when a word like parts or sizes follows it.
  const INCH_AS_SYSTEM = /\bimperial\b|\binch(?:es)?\b(?=\s+(?:parts?|sizes?|springs?|series|stock|only|catalogue?|listing))/;
  const sys = text.match(/\bmetric\b/) || text.match(INCH_AS_SYSTEM);
  if (sys) {
    fields.system = /metric/.test(sys[0]) ? 'metric' : 'inch';
    read.push({ field: 'system', from: sys[0], value: fields.system === 'metric' ? 'metric parts' : 'inch parts' });
  }
  const shapeWord = text.match(/\bconical\b|\btapered\b|\bbarrel\b|\bhourglass\b|\bstraight\b|\bcylindrical\b/);
  if (shapeWord) {
    const key = resolveShape(shapeWord[0]);
    if (key) {
      fields.shapeKey = key;
      read.push({ field: 'shape', from: shapeWord[0], value: SHAPES[key].name });
    }
  }

  // --- spring class and wire section ------------------------------------
  const die = text.match(/\bdie[\s-]*springs?\b|\bdie[\s-]*set\b/);
  if (die) {
    const negated = /\b(no|not|non|without|exclude|excluding|avoid|skip|except)\b[^.]{0,20}$/
      .test(text.slice(0, die.index));
    fields.duty = negated ? 'general' : 'die';
    read.push({ field: 'duty', from: die[0], value: negated ? 'general purpose only' : 'die springs only' });
  }
  const sect = text.match(/\bround[\s-]*wire\b|\brectangular[\s-]*wire\b|\bsquare[\s-]*wire\b|\bmoulded\b|\bmolded\b/);
  if (sect) {
    const key = /round/.test(sect[0]) ? 'round' : /rectangular/.test(sect[0]) ? 'rectangular'
      : /square/.test(sect[0]) ? 'square' : 'moulded';
    fields.sectionKey = key;
    read.push({ field: 'section', from: sect[0], value: SECTIONS[key].name });
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
