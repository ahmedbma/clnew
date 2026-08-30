/**
 * spring-math.js -- helical compression spring engine.
 *
 * Pure functions, no DOM, no dependencies. Runs in the browser and in Node.
 *
 * INTERNAL UNITS ARE SI, ALWAYS:
 *   length mm | force N | rate N/mm | stress MPa | modulus GPa
 * Anything that reads a vendor catalog converts on the way in (see catalog.js).
 *
 * References:
 *   Shigley, "Mechanical Engineering Design", ch.10 (Sut = A/d^m, allowable
 *   torsional stress fractions, buckling criterion).
 *   SMI / Associated Spring "Design Handbook" (shear moduli, end-condition
 *   coil counts, commercial rate tolerance).
 */

/* ------------------------------------------------------------------ units */

export const IN_TO_MM = 25.4;
export const LBF_TO_N = 4.4482216152605;
export const PSI_TO_MPA = 0.00689475729316836;
export const LBF_PER_IN_TO_N_PER_MM = LBF_TO_N / IN_TO_MM; // 0.175126...

export const inToMm = (v) => v * IN_TO_MM;
export const mmToIn = (v) => v / IN_TO_MM;
export const lbfToN = (v) => v * LBF_TO_N;
export const nToLbf = (v) => v / LBF_TO_N;
export const lbfPerInToNPerMm = (v) => v * LBF_PER_IN_TO_N_PER_MM;
export const nPerMmToLbfPerIn = (v) => v / LBF_PER_IN_TO_N_PER_MM;
export const psiToMpa = (v) => v * PSI_TO_MPA;
export const mpaToPsi = (v) => v / PSI_TO_MPA;

/**
 * Every unit a catalogue is published in, as a factor onto the SI unit the
 * engine stores (mm, N, N/mm). Vendors mix them within one table -- McMaster's
 * metric springs give lengths in mm but loads in lb and rates in lbf/mm -- so
 * a unit is a property of a quantity, never of a whole spring.
 */
export const UNIT_FACTORS = {
  length: { mm: 1, cm: 10, m: 1000, in: IN_TO_MM },
  force: { N: 1, kN: 1000, lbf: LBF_TO_N, ozf: 0.2780138509, kgf: 9.80665, gf: 0.00980665 },
  rate: { 'N/mm': 1, 'N/m': 0.001, 'lbf/in': LBF_PER_IN_TO_N_PER_MM, 'lbf/mm': LBF_TO_N, 'kgf/mm': 9.80665 },
};
export const toSI = (v, quantity, unit) => {
  const f = UNIT_FACTORS[quantity]?.[unit];
  return f == null || v == null ? null : v * f;
};
export const fromSI = (v, quantity, unit) => {
  const f = UNIT_FACTORS[quantity]?.[unit];
  return f == null || v == null ? null : v / f;
};
export const cToF = (v) => v * 9 / 5 + 32;
export const fToC = (v) => (v - 32) * 5 / 9;

/** The two systems a part is catalogued under, and what each publishes in. */
export const UNIT_SYSTEMS = {
  inch: { name: 'Inch', units: { length: 'in', force: 'lbf', rate: 'lbf/in', temp: 'F' } },
  metric: { name: 'Metric', units: { length: 'mm', force: 'N', rate: 'N/mm', temp: 'C' } },
};

/**
 * Accept whatever a record carries -- 'in', 'mm', or a per-quantity object --
 * and return the full per-quantity form. Anything unstated falls back to the
 * conventional unit for the system the lengths are in.
 */
export function normalizeSourceUnits(u) {
  if (typeof u === 'string') return { ...UNIT_SYSTEMS[u === 'mm' ? 'metric' : 'inch'].units };
  const given = u && typeof u === 'object' ? u : {};
  const base = UNIT_SYSTEMS[given.length === 'mm' ? 'metric' : 'inch'].units;
  const out = { ...base };
  for (const q of ['length', 'force', 'rate', 'temp']) {
    if (given[q]) out[q] = given[q];
  }
  return out;
}

/* ----------------------------------------------------------- coil shapes */

/**
 * The coil form. Only a straight cylindrical spring has one rate all the way
 * down; everything else stiffens as coils close, which the constant-rate maths
 * here cannot follow.
 */
export const SHAPES = {
  straight: { name: 'Straight', constantRate: true, aliases: ['straight', 'cylindrical', 'standard'] },
  conical: { name: 'Conical', constantRate: false, aliases: ['conical', 'tapered', 'cone'] },
  barrel: { name: 'Barrel', constantRate: false, aliases: ['barrel', 'convex'] },
  hourglass: { name: 'Hourglass', constantRate: false, aliases: ['hourglass', 'concave'] },
};

/**
 * The cross-section of what is wound. Only a round wire has the d^4 / d^3 that
 * the rate and stress formulas are built on, so this decides what can be
 * worked out at all rather than being decoration.
 */
export const SECTIONS = {
  round: { name: 'Round wire', roundWire: true },
  square: { name: 'Square wire', roundWire: false },
  rectangular: { name: 'Rectangular wire', roundWire: false },
  moulded: { name: 'Moulded', roundWire: false },
};

/**
 * What the spring is built for. A die spring is a different product class, not
 * a size: rectangular wire, sized by the hole and shaft it runs in rather than
 * by its own OD and ID, and sold against a load rating and a cycle life.
 */
export const DUTIES = {
  general: { name: 'General purpose' },
  die: { name: 'Die spring' },
};

/**
 * Can the textbook helical-spring formulas be applied at all? They assume a
 * cylinder of round wire of a known alloy. A cone, a rectangular section or an
 * unrecognised material each break them, and a number produced anyway would be
 * confidently wrong rather than missing.
 */
export function canUseCoilFormulas(s) {
  return s.shapeKey === 'straight' && s.sectionKey === 'round'
    && s.wireDia_mm != null && s.materialKey != null;
}

export function resolveShape(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (SHAPES[t]) return t;
  for (const [key, sh] of Object.entries(SHAPES)) {
    if (sh.aliases.some((a) => t.includes(a))) return key;
  }
  return null;
}

/* -------------------------------------------------------------- materials */

/**
 * G_GPa   shear modulus, the number that sets spring rate.
 * E_GPa   Young's modulus, only used for the buckling criterion.
 * sut     piecewise Sut = A / d^m with d in mm, giving MPa (Shigley T10-4).
 * tauFrac allowable torsional stress as a fraction of Sut, static service,
 *         set NOT removed (Shigley T10-6). Springs with set removed or shot
 *         peened tolerate more; pass {setRemoved:true} for the higher number.
 */
export const MATERIALS = {
  'music-wire': {
    name: 'Music wire (ASTM A228)',
    G_GPa: 79.3, E_GPa: 203.4, tauFrac: 0.45, tauFracSet: 0.60,
    sut: [{ dMax: 6.5, A: 2211, m: 0.145 }],
    aliases: ['music wire', 'music-wire', 'zinc-plated music wire', 'a228',
      'music-wire steel', 'piano wire'],
  },
  'hard-drawn': {
    name: 'Hard-drawn carbon steel (ASTM A227)',
    G_GPa: 79.3, E_GPa: 200.0, tauFrac: 0.45, tauFracSet: 0.60,
    sut: [{ dMax: 12.7, A: 1783, m: 0.190 }],
    aliases: ['hard drawn', 'hard-drawn', 'a227', 'carbon steel', 'steel',
      'zinc-plated steel', 'spring steel'],
  },
  'oil-tempered': {
    name: 'Oil-tempered carbon steel (ASTM A229)',
    G_GPa: 77.2, E_GPa: 200.0, tauFrac: 0.50, tauFracSet: 0.65,
    sut: [{ dMax: 12.7, A: 1855, m: 0.187 }],
    aliases: ['oil tempered', 'oil-tempered', 'a229', 'oq&t'],
  },
  'chrome-vanadium': {
    name: 'Chrome-vanadium alloy steel (ASTM A232)',
    G_GPa: 77.2, E_GPa: 203.4, tauFrac: 0.50, tauFracSet: 0.65,
    sut: [{ dMax: 11.1, A: 2005, m: 0.168 }],
    aliases: ['chrome vanadium', 'chrome-vanadium', 'a232', 'chromium vanadium'],
  },
  'chrome-silicon': {
    name: 'Chrome-silicon alloy steel (ASTM A401)',
    G_GPa: 77.2, E_GPa: 203.4, tauFrac: 0.50, tauFracSet: 0.65,
    sut: [{ dMax: 9.5, A: 1974, m: 0.108 }],
    aliases: ['chrome silicon', 'chrome-silicon', 'a401', 'chromium silicon'],
  },
  'stainless-302': {
    name: '302 / 304 stainless (ASTM A313)',
    G_GPa: 69.0, E_GPa: 193.0, tauFrac: 0.35, tauFracSet: 0.50,
    sut: [
      { dMax: 2.5, A: 1867, m: 0.146 },
      { dMax: 5.0, A: 2065, m: 0.263 },
      { dMax: 10.0, A: 2911, m: 0.478 },
    ],
    aliases: ['302 stainless steel', '302 stainless', '304 stainless steel',
      '304 stainless', 'stainless steel', 'stainless', 'a313', '18-8'],
  },
  'stainless-316': {
    name: '316 stainless',
    G_GPa: 69.0, E_GPa: 193.0, tauFrac: 0.35, tauFracSet: 0.50,
    sut: [{ dMax: 10.0, A: 1725, m: 0.146, approx: true }],
    aliases: ['316 stainless steel', '316 stainless', '316'],
  },
  'stainless-17-7': {
    name: '17-7 PH stainless',
    G_GPa: 75.8, E_GPa: 203.4, tauFrac: 0.45, tauFracSet: 0.60,
    sut: [{ dMax: 10.0, A: 2065, m: 0.146, approx: true }],
    aliases: ['17-7 ph', '17-7ph', '17-7 stainless', '631'],
  },
  'brass': {
    name: 'Spring brass',
    G_GPa: 34.5, E_GPa: 110.0, tauFrac: 0.35, tauFracSet: 0.50,
    sut: [{ dMax: 7.5, A: 800, m: 0, approx: true }],
    aliases: ['brass', 'cartridge brass', 'spring brass'],
  },
  'phosphor-bronze': {
    name: 'Phosphor bronze (ASTM B159)',
    G_GPa: 41.4, E_GPa: 103.4, tauFrac: 0.35, tauFracSet: 0.50,
    sut: [
      { dMax: 0.6, A: 1000, m: 0 },
      { dMax: 2.0, A: 913, m: 0.028 },
      { dMax: 7.5, A: 932, m: 0.064 },
    ],
    aliases: ['phosphor bronze', 'phosphor-bronze', 'b159', 'bronze'],
  },
  'beryllium-copper': {
    name: 'Beryllium copper (ASTM B197)',
    G_GPa: 48.3, E_GPa: 128.0, tauFrac: 0.35, tauFracSet: 0.50,
    sut: [{ dMax: 7.5, A: 1240, m: 0, approx: true }],
    aliases: ['beryllium copper', 'beryllium-copper', 'becu', 'b197'],
  },
  'cobalt-nickel': {
    name: 'Cobalt-nickel alloy (Elgiloy / MP35N type)',
    G_GPa: 76.0, E_GPa: 193.0, tauFrac: 0.35, tauFracSet: 0.50,
    sut: [{ dMax: 7.5, A: 2200, m: 0.10, approx: true }],
    aliases: ['cobalt nickel', 'cobalt-nickel', 'elgiloy', 'mp35n', 'conichrome',
      'cobalt chromium', 'co-cr-ni'],
  },
  'monel-400': {
    name: 'Monel 400 (nickel-copper)',
    G_GPa: 65.5, E_GPa: 179.0, tauFrac: 0.35, tauFracSet: 0.50,
    sut: [{ dMax: 7.5, A: 1100, m: 0, approx: true }],
    aliases: ['monel', 'nickel-copper', 'nickel copper', 'monel 400'],
  },
  'inconel-x750': {
    name: 'Inconel X-750',
    G_GPa: 72.4, E_GPa: 213.7, tauFrac: 0.35, tauFracSet: 0.50,
    sut: [{ dMax: 7.5, A: 1450, m: 0, approx: true }],
    aliases: ['inconel x-750', 'inconel x750', 'inconel', 'x-750'],
  },
};

export const DEFAULT_MATERIAL = 'music-wire';

/** Resolve a free-text material name (a vendor column) to a MATERIALS key. */
export function resolveMaterial(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().trim();
  if (MATERIALS[t]) return t;
  // Longest alias wins, so "302 stainless steel" beats bare "steel".
  let best = null;
  let bestLen = 0;
  for (const [key, mat] of Object.entries(MATERIALS)) {
    for (const alias of mat.aliases) {
      if (t.includes(alias) && alias.length > bestLen) {
        best = key;
        bestLen = alias.length;
      }
    }
  }
  return best;
}

export function getMaterial(key) {
  return MATERIALS[key] || MATERIALS[DEFAULT_MATERIAL];
}

/** Ultimate tensile strength (MPa) for a wire diameter, Sut = A/d^m. */
export function ultimateTensileStrength(materialKey, d_mm) {
  const mat = getMaterial(materialKey);
  const band = mat.sut.find((b) => d_mm <= b.dMax) || mat.sut[mat.sut.length - 1];
  return {
    sut_MPa: band.A / Math.pow(d_mm, band.m),
    extrapolated: d_mm > mat.sut[mat.sut.length - 1].dMax,
    approx: !!band.approx,
  };
}

/** Allowable torsional (shear) stress, MPa, static service. */
export function allowableShearStress(materialKey, d_mm, { setRemoved = false } = {}) {
  const mat = getMaterial(materialKey);
  const { sut_MPa, extrapolated, approx } = ultimateTensileStrength(materialKey, d_mm);
  const frac = setRemoved ? mat.tauFracSet : mat.tauFrac;
  return { tauAllow_MPa: sut_MPa * frac, sut_MPa, fraction: frac, extrapolated, approx };
}

/* -------------------------------------------------------------- end types */

/**
 * activeFromTotal / totalFromActive and the solid-length rule for each end
 * treatment. "closed" is also called "squared".
 */
export const END_TYPES = {
  'closed-and-ground': {
    name: 'Closed and ground',
    inactiveCoils: 2,
    solid: (Nt, d) => Nt * d,
    aliases: ['closed & ground', 'closed and ground', 'squared and ground',
      'squared & ground', 'c&g', 'ground'],
  },
  'closed': {
    name: 'Closed (squared), not ground',
    inactiveCoils: 2,
    solid: (Nt, d) => (Nt + 1) * d,
    aliases: ['closed', 'squared', 'closed not ground', 'squared not ground'],
  },
  'open-and-ground': {
    name: 'Open and ground',
    inactiveCoils: 1,
    solid: (Nt, d) => Nt * d,
    aliases: ['open & ground', 'open and ground', 'plain and ground',
      'plain & ground'],
  },
  'open': {
    name: 'Open (plain)',
    inactiveCoils: 0,
    solid: (Nt, d) => (Nt + 1) * d,
    aliases: ['open', 'plain', 'open not ground'],
  },
};

export const DEFAULT_ENDS = 'closed-and-ground';

export function resolveEnds(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().trim();
  if (END_TYPES[t]) return t;
  let best = null;
  let bestLen = 0;
  for (const [key, e] of Object.entries(END_TYPES)) {
    for (const alias of e.aliases) {
      if (t.includes(alias) && alias.length > bestLen) {
        best = key;
        bestLen = alias.length;
      }
    }
  }
  return best;
}

export function getEnds(key) {
  return END_TYPES[key] || END_TYPES[DEFAULT_ENDS];
}

export const activeFromTotal = (Nt, endsKey) => Nt - getEnds(endsKey).inactiveCoils;
export const totalFromActive = (Na, endsKey) => Na + getEnds(endsKey).inactiveCoils;
export const solidLength = (Nt, d_mm, endsKey) => getEnds(endsKey).solid(Nt, d_mm);

/* ---------------------------------------------------------- core mechanics */

export const meanDiameter = (od_mm, d_mm) => od_mm - d_mm;
export const springIndex = (D_mm, d_mm) => D_mm / d_mm;

/** Rate, N/mm.  k = G d^4 / (8 D^3 Na) */
export function rateFromGeometry({ G_GPa, d_mm, D_mm, activeCoils }) {
  const G_MPa = G_GPa * 1000; // GPa -> MPa == N/mm^2
  return (G_MPa * Math.pow(d_mm, 4)) / (8 * Math.pow(D_mm, 3) * activeCoils);
}

/** Active coils implied by a published rate -- the inverse of the above. */
export function activeCoilsFromRate({ G_GPa, d_mm, D_mm, rate_Npmm }) {
  const G_MPa = G_GPa * 1000;
  return (G_MPa * Math.pow(d_mm, 4)) / (8 * Math.pow(D_mm, 3) * rate_Npmm);
}

/** Wahl correction factor -- curvature + direct shear, use for cyclic duty. */
export const wahlFactor = (C) => (4 * C - 1) / (4 * C - 4) + 0.615 / C;

/** Direct-shear factor only -- the correct one for static duty (Shigley). */
export const staticShearFactor = (C) => 1 + 0.5 / C;

/** Torsional stress in the wire, MPa.  tau = K * 8 F D / (pi d^3) */
export function shearStress({ force_N, D_mm, d_mm, factor = 1 }) {
  return (factor * 8 * force_N * D_mm) / (Math.PI * Math.pow(d_mm, 3));
}

export const forceAtDeflection = (rate_Npmm, deflection_mm) => rate_Npmm * deflection_mm;
export const deflectionForForce = (rate_Npmm, force_N) => force_N / rate_Npmm;
export const forceAtLength = (rate_Npmm, freeLength_mm, length_mm) =>
  rate_Npmm * (freeLength_mm - length_mm);
export const lengthForForce = (rate_Npmm, freeLength_mm, force_N) =>
  freeLength_mm - force_N / rate_Npmm;

/**
 * Buckling of a compression spring (Shigley 10-6).
 * endCondition alpha: 0.5 both ends squared+guided against flat parallel
 * plates, 0.707 one end pivoted, 1.0 both ends pivoted, 2.0 one end clamped
 * and the other free.
 */
export const END_CONDITIONS = {
  'fixed-fixed': { name: 'Both ends on parallel flat plates (guided)', alpha: 0.5 },
  'fixed-pivot': { name: 'One end plate, one end pivoted', alpha: 0.707 },
  'pivot-pivot': { name: 'Both ends pivoted / free to tilt', alpha: 1.0 },
  'fixed-free': { name: 'One end clamped, other end free', alpha: 2.0 },
};

export function bucklingAnalysis({ freeLength_mm, D_mm, materialKey, endCondition = 'fixed-fixed' }) {
  const mat = getMaterial(materialKey);
  const E = mat.E_GPa;
  const G = mat.G_GPa;
  const alpha = (END_CONDITIONS[endCondition] || END_CONDITIONS['fixed-fixed']).alpha;

  // Absolutely stable at any deflection below this free length.
  const stableBelow_mm = (Math.PI * D_mm / alpha) * Math.sqrt((2 * (E - G)) / (2 * G + E));
  if (freeLength_mm <= stableBelow_mm) {
    return { alpha, stableBelow_mm, unconditionallyStable: true, criticalDeflection_mm: Infinity };
  }
  const C1 = E / (2 * (E - G));
  const C2 = (2 * Math.PI * Math.PI * (E - G)) / (2 * G + E);
  const lambda = (alpha * freeLength_mm) / D_mm;
  const inner = 1 - C2 / (lambda * lambda);
  const ratio = C1 * (1 - Math.sqrt(Math.max(inner, 0)));
  return {
    alpha,
    stableBelow_mm,
    unconditionallyStable: false,
    slenderness: lambda,
    criticalDeflection_mm: ratio * freeLength_mm,
  };
}

/* ------------------------------------------------------ spring derivation */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Fill in whatever a sparse vendor listing left out.
 *
 * This is the part that makes a McMaster row usable: McMaster publishes OD,
 * ID, wire diameter, free length and rate, but not coil count or solid
 * length -- so travel-to-solid, the thing that decides whether your working
 * point is reachable, is not in the table. Inverting the rate equation for
 * active coils recovers it.
 *
 * Every derived field is recorded in `derived` so the UI can mark it as
 * calculated rather than vendor-published.
 *
 * Input is SI and may be sparse:
 *   { partNumber, vendor, url, material, ends, od_mm, id_mm, wireDia_mm,
 *     freeLength_mm, solidLength_mm, rate_Npmm, maxLoad_N, maxDeflection_mm,
 *     totalCoils, activeCoils, G_GPa }
 */
const CUT_TO_LENGTH_RE = /cut[\s-]*to[\s-]*length/i;

export function normalizeSpring(raw) {
  const s = { ...raw };
  const derived = [];
  const warnings = [];

  // Units, and the system the part is catalogued under. Both are recorded so
  // a table can show the vendor's own numbers next to the converted ones.
  s.sourceUnits = normalizeSourceUnits(s.sourceUnits);
  if (!s.system) {
    s.system = s.sourceUnits.length === 'mm' ? 'metric' : 'inch';
    derived.push('system');
  }

  // Coil form. `nonLinearShape` was the old free-text field and still works as
  // an input; everything downstream now reads shapeKey.
  s.shapeKey = resolveShape(s.shape) || resolveShape(s.nonLinearShape)
    || resolveShape(s.family) || 'straight';
  if (!s.shape && !s.nonLinearShape) derived.push('shapeKey');
  if (s.shapeKey !== 'straight' && !s.nonLinearShape) s.nonLinearShape = SHAPES[s.shapeKey].name;

  // Cut-to-length stock is a different thing to buy: you get a long coil and
  // cut what you need. Vendors do not flag it in a field, only in the product
  // family, so read it from there unless the record says outright.
  if (s.cutToLength == null) {
    // Read off the family name either way round -- a "no" is just as much an
    // inference as a "yes", so both are marked as worked out, not published.
    s.cutToLength = CUT_TO_LENGTH_RE.test(String(s.family || ''));
    derived.push('cutToLength');
  } else {
    s.cutToLength = Boolean(s.cutToLength);
  }

  // A material named but not recognised is left unknown: inventing properties
  // for it would put a confident wrong stress number on the screen. A material
  // simply not stated falls back to the default, which is only ever an
  // assumption about steel, and is declared as one.
  s.materialKey = s.materialKey || resolveMaterial(s.material) || (s.material ? null : DEFAULT_MATERIAL);
  if (s.material && !s.materialKey) {
    warnings.push(`Material "${s.material}" is not one the calculator has properties for, so stress is not `
      + 'checked and coil count is not worked out. Everything that follows from the published rate still holds.');
  } else if (!s.material) {
    derived.push('materialKey');
  }
  s.endsKey = s.endsKey || resolveEnds(s.ends) || null;
  if (!s.endsKey) {
    s.endsKey = DEFAULT_ENDS;
    if (s.ends) warnings.push(`End type "${s.ends}" not recognised; assumed closed and ground.`);
    else derived.push('endsKey');
  }
  s.G_GPa = num(s.G_GPa) ?? (s.materialKey ? MATERIALS[s.materialKey].G_GPa : null);

  // --- wire / diameters: any two of OD, ID, wire dia give the third.
  const rectangularWire = num(s.wireWidth_mm) != null || num(s.wireThickness_mm) != null;
  if (!s.sectionKey) {
    const w = num(s.wireWidth_mm);
    const t = num(s.wireThickness_mm);
    // A polymer part is moulded whether or not the listing gives it a section:
    // the urethane die springs are a solid slug with no wire in them at all.
    const polymer = /plastic|pei|nylon|acetal|peek|rubber|urethane|elastomer/i.test(s.material || '');
    s.sectionKey = polymer ? 'moulded'
      : !rectangularWire ? 'round'
        : s.materialKey == null ? 'moulded'
          : (w != null && t != null && Math.abs(w - t) < 1e-9) ? 'square' : 'rectangular';
    derived.push('sectionKey');
  }
  if (!s.dutyKey) {
    s.dutyKey = /\bdie spring/i.test(s.family || '') ? 'die' : 'general';
    derived.push('dutyKey');
  }
  let od = num(s.od_mm), id = num(s.id_mm), d = num(s.wireDia_mm);
  // (OD - ID)/2 is the radial thickness, which is only the wire diameter when
  // the wire is round. Deriving it for rectangular wire would feed a wrong
  // number into the round-wire rate equation.
  if (d == null && od != null && id != null && !rectangularWire) { d = (od - id) / 2; derived.push('wireDia_mm'); }
  if (id == null && od != null && d != null) { id = od - 2 * d; derived.push('id_mm'); }
  if (od == null && id != null && d != null) { od = id + 2 * d; derived.push('od_mm'); }
  s.od_mm = od; s.id_mm = id; s.wireDia_mm = d;

  // Rectangular-wire and moulded springs have no round wire diameter, and an
  // unknown alloy has no shear modulus. Their published rate still gives exact
  // force at length; only what the rate equation would infer is out of reach.
  // The coil formulas assume a straight cylinder of round wire. A conical or
  // barrel spring fails that just as surely as a rectangular section does: its
  // coils nest, so neither the inverted coil count nor Nt x d means anything.
  const roundWire = od != null && d != null && s.materialKey != null && s.shapeKey === 'straight';
  // Cut-to-length stock is sold by the metre and cut to suit; its published
  // rate belongs to the full uncut length, and cutting it changes the rate.
  if (s.cutToLength) {
    warnings.push('Sold as cut-to-length stock: the free length is the length of the coil you buy, and '
      + 'the published rate is for that whole length. Cutting it removes active coils and stiffens the '
      + 'spring in proportion - half the length is about twice the rate.');
  }
  if (s.sectionKey !== 'round') {
    // Say what the section actually is: square, rectangular or moulded are
    // three different objects, and "wire" is simply wrong for a moulded one.
    const shape = s.sectionKey === 'moulded'
      ? 'Moulded rather than wound from wire'
      : `${SECTIONS[s.sectionKey].name}, not round`;
    warnings.push(`${shape}, so coil count, solid length and stress are not worked out - `
      + 'those all assume a round wire. Force at length comes straight from the published rate and is unaffected.');
  }

  if (od != null && d != null) {
    s.meanDia_mm = meanDiameter(od, d);
    s.springIndex = springIndex(s.meanDia_mm, d);
  }
  if (s.shapeKey !== 'straight') {
    warnings.push(`${SHAPES[s.shapeKey].name} rather than a straight cylindrical spring. Its coils nest as `
      + 'it compresses, so the rate is not constant and neither coil count, solid length nor stress is '
      + 'worked out here - all three assume a cylinder. The published rate is a nominal figure; force '
      + 'near the end of travel will run above it.');
  }
  if (s.springIndex != null && s.springIndex < 4) warnings.push(`Spring index C=${s.springIndex.toFixed(1)} is below 4 - tightly wound, high stress concentration, hard to manufacture.`);
  if (s.springIndex != null && s.springIndex > 14) warnings.push(`Spring index C=${s.springIndex.toFixed(1)} is above 14 - loose, prone to tangling and buckling.`);

  // --- coils <-> rate: whichever is missing comes from the other.
  let Na = num(s.activeCoils), Nt = num(s.totalCoils), k = num(s.rate_Npmm);
  if (Na == null && Nt != null) { Na = activeFromTotal(Nt, s.endsKey); derived.push('activeCoils'); }
  if (!roundWire) {
    // Nothing to invert without a round wire diameter and a shear modulus.
    s.activeCoils = Na; s.totalCoils = Nt; s.rate_Npmm = k;
  } else if (Na != null && k == null) {
    k = rateFromGeometry({ G_GPa: s.G_GPa, d_mm: d, D_mm: s.meanDia_mm, activeCoils: Na });
    derived.push('rate_Npmm');
  } else if (Na == null && k != null) {
    Na = activeCoilsFromRate({ G_GPa: s.G_GPa, d_mm: d, D_mm: s.meanDia_mm, rate_Npmm: k });
    derived.push('activeCoils');
  } else if (Na != null && k != null) {
    // Both published. Cross-check them; a big gap means a bad row.
    const kCalc = rateFromGeometry({ G_GPa: s.G_GPa, d_mm: d, D_mm: s.meanDia_mm, activeCoils: Na });
    s.rateCheck = { calculated_Npmm: kCalc, published_Npmm: k, error: (kCalc - k) / k };
    if (Math.abs(s.rateCheck.error) > 0.25) {
      warnings.push(`Published rate and coil geometry disagree by ${(s.rateCheck.error * 100).toFixed(0)}% - check the data.`);
    }
  }
  if (roundWire) {
    if (Nt == null && Na != null) { Nt = totalFromActive(Na, s.endsKey); derived.push('totalCoils'); }
    s.activeCoils = Na; s.totalCoils = Nt; s.rate_Npmm = k;
  }

  // Last resort for the rate: a published load at a published length is two
  // points on the force-deflection line, and the line goes through the origin,
  // so their ratio is the rate. It is the only thing some listings give -- the
  // moulded urethane die springs publish no rate at all -- and for anything
  // that is not truly linear it is an average across that travel, said so below.
  if (s.rate_Npmm == null) {
    const F = num(s.maxLoad_N);
    const L0v = num(s.freeLength_mm);
    const Lv = num(s.lengthAtMaxLoad_mm);
    const travel = L0v != null && Lv != null ? L0v - Lv : num(s.maxDeflection_mm);
    if (F != null && travel != null && travel > 0) {
      s.rate_Npmm = F / travel;
      k = s.rate_Npmm;
      derived.push('rate_Npmm');
      warnings.push('No spring rate is published for this one. It is taken as the max load divided by '
        + 'the travel to reach it, which is exact for a linear spring and an average across that '
        + 'travel for anything else.');
    }
  }

  // The rate and the free length are what the tool cannot work without.
  const missing = [
    s.rate_Npmm == null && 'spring rate (or coil count and material, to derive it)',
    num(s.freeLength_mm) == null && 'free length',
  ].filter(Boolean);
  if (missing.length) return { ...s, derived, warnings, incomplete: true, missing };
  k = s.rate_Npmm;
  if (Na != null && Na < 2) warnings.push(`Only ${Na.toFixed(1)} active coils - the rate equation is unreliable this low.`);

  // --- lengths and travel
  let L0 = num(s.freeLength_mm);
  let Ls = num(s.solidLength_mm);
  if (Ls == null && Nt != null && roundWire) { Ls = solidLength(Nt, d, s.endsKey); derived.push('solidLength_mm'); }
  s.solidLength_mm = Ls;
  s.freeLength_mm = L0;

  if (L0 != null && Ls != null) {
    s.travelToSolid_mm = L0 - Ls;
    if (s.travelToSolid_mm <= 0) {
      // Blame the right thing: when the coil count came from inverting a
      // published rate, the shear modulus is the shaky input, not the vendor.
      warnings.push(derived.includes('solidLength_mm') && derived.includes('activeCoils')
        ? `Coil count worked back from the published rate puts the solid length past the free length. `
          + `That normally means the shear modulus assumed for ${getMaterial(s.materialKey).name} `
          + `is off for this wire, not that the listing is wrong. Solid length is left unknown; `
          + `vendor travel figures are used instead where they exist.`
        : 'Solid length exceeds free length - the input data is inconsistent.');
      s.travelToSolid_mm = null;
      s.solidLength_mm = null;
      Ls = null;
    }
  }

  // Usable travel. Prefer what the vendor rates; otherwise take a fraction of
  // travel-to-solid, because running a stock spring to solid is where it
  // takes a set and stops being the spring you specified.
  let vendorMaxDefl = num(s.maxDeflection_mm);
  const vendorMaxLoad = num(s.maxLoad_N);

  // Vendors often publish "compressed length at maximum load" rather than a
  // deflection. That length is authoritative -- it beats anything derived
  // from an assumed shear modulus.
  const atMaxLoad = num(s.lengthAtMaxLoad_mm);
  if (vendorMaxDefl == null && atMaxLoad != null && L0 != null && atMaxLoad < L0) {
    vendorMaxDefl = L0 - atMaxLoad;
    s.maxDeflection_mm = vendorMaxDefl;
    derived.push('maxDeflection_mm');
  }
  // A published compressed length below the spring's own solid height is an
  // impossibility, not a disagreement. The solid height here is usually
  // derived by inverting the published rate, so it inherits that rate's
  // rounding -- a few percent means nothing. Ten percent does.
  if (atMaxLoad != null && Ls != null && atMaxLoad < Ls * 0.9) {
    const gap = ((Ls - atMaxLoad) / Ls * 100).toFixed(0);
    const approx = derived.includes('solidLength_mm')
      && (getMaterial(s.materialKey).sut || []).some((b) => b.approx);
    warnings.push(`Published compressed length is ${gap}% shorter than the coils stacked solid, which `
      + `cannot happen. ${approx
        ? `Solid height here is worked back from the published rate using approximate properties for `
          + `${getMaterial(s.materialKey).name}, so this may be the estimate rather than the listing.`
        : 'One of the published figures for this spring is wrong.'}`);
  }
  // Cross-check the vendor against itself: rate x travel should be max load.
  if (vendorMaxDefl != null && vendorMaxLoad != null) {
    const implied = k * vendorMaxDefl;
    const err = (implied - vendorMaxLoad) / vendorMaxLoad;
    if (Math.abs(err) > 0.15) {
      warnings.push(`Published max load and travel disagree by ${(err * 100).toFixed(0)}% at the published rate - check the figures.`);
    }
  }
  if (vendorMaxDefl != null) {
    s.usableTravel_mm = vendorMaxDefl;
    s.usableTravelSource = 'vendor max deflection';
  } else if (vendorMaxLoad != null) {
    s.usableTravel_mm = vendorMaxLoad / k;
    s.usableTravelSource = 'vendor max load / rate';
    derived.push('usableTravel_mm');
  } else if (s.travelToSolid_mm != null) {
    s.usableTravel_mm = s.travelToSolid_mm * (s.travelDerate ?? 0.85);
    s.usableTravelSource = `${((s.travelDerate ?? 0.85) * 100).toFixed(0)}% of travel to solid`;
    derived.push('usableTravel_mm');
  } else {
    s.usableTravel_mm = null;
    s.usableTravelSource = null;
  }
  if (s.usableTravel_mm != null) {
    s.maxUsableForce_N = k * s.usableTravel_mm;
    if (L0 != null) s.minWorkingLength_mm = L0 - s.usableTravel_mm;
  }
  if (s.travelToSolid_mm != null) s.forceAtSolid_N = k * s.travelToSolid_mm;
  if (num(s.maxTemp_C) != null) s.maxTemp_F = s.maxTemp_C * 9 / 5 + 32;

  // A vendor rating that sits above the allowable stress is worth explaining
  // rather than just flagging. The default allowable here is Shigley's static
  // figure for wire with the set NOT removed; a spring pre-set at the factory
  // takes appreciably more, and a rating this high is itself the evidence the
  // spring is pre-set. Both readings are given, so the number can be judged.
  if (vendorMaxLoad != null && s.meanDia_mm != null && canUseCoilFormulas(s)) {
    const tau = shearStress({ force_N: vendorMaxLoad, D_mm: s.meanDia_mm, d_mm: d,
      factor: staticShearFactor(s.springIndex) });
    const plain = allowableShearStress(s.materialKey, d).tauAllow_MPa;
    const preset = allowableShearStress(s.materialKey, d, { setRemoved: true }).tauAllow_MPa;
    s.vendorRatingUtilisation = tau / plain;
    s.vendorRatingUtilisationSet = tau / preset;
    if (tau > plain) {
      warnings.push(`At the vendor's own max load the wire sees ${(tau / plain * 100).toFixed(0)}% of the `
        + 'stress allowed for spring wire with the set not removed, which is what this calculator assumes '
        + `by default. Rating it that high implies the spring is pre-set at the factory; on that basis it is `
        + `${(tau / preset * 100).toFixed(0)}%. Treat the stress figures as the conservative reading.`);
    }
  }

  return { ...s, derived, warnings, incomplete: false };
}

/* -------------------------------------------------------------- evaluation */

/**
 * Everything you want to know about running one spring at one target force.
 *
 * opts:
 *   targetForce_N      the working load you care about
 *   positionTol_mm     assembly/travel tolerance at the working point
 *   rateTol            fractional rate tolerance, default 0.10 (commercial)
 *   freeLengthTol_mm   only matters if you cannot adjust at assembly
 *   endCondition       buckling end restraint key
 *   setRemoved         allow the higher static stress fraction
 */
export function evaluate(springIn, opts = {}) {
  const s = springIn.incomplete === undefined ? normalizeSpring(springIn) : springIn;
  const out = { spring: s, warnings: [...(s.warnings || [])], feasible: false, reasons: [] };
  if (s.incomplete) {
    out.reasons.push(`Incomplete data: missing ${s.missing.join(', ')}.`);
    return out;
  }

  const {
    targetForce_N,
    positionTol_mm = 0.25,
    // A spring that publishes its own rate tolerance knows better than any
    // blanket default.
    rateTol = s.rateTol ?? 0.10,
    freeLengthTol_mm = 0,
    endCondition = 'fixed-fixed',
    setRemoved = false,
  } = opts;

  const k = s.rate_Npmm;
  const C = s.springIndex;
  // Stress needs a round wire and a known alloy; without either, it is left
  // unreported rather than computed from a stand-in.
  const canStress = C != null && canUseCoilFormulas(s);
  const Ks = canStress ? staticShearFactor(C) : null;
  const Kw = canStress ? wahlFactor(C) : null;
  const allow = canStress ? allowableShearStress(s.materialKey, s.wireDia_mm, { setRemoved }) : null;
  out.allowable = allow;
  out.factors = { Ks, Kw, springIndex: C };

  const stressAt = (F) => {
    if (!canStress) return { tauStatic_MPa: null, tauCyclic_MPa: null, utilisation: null };
    return {
      tauStatic_MPa: shearStress({ force_N: F, D_mm: s.meanDia_mm, d_mm: s.wireDia_mm, factor: Ks }),
      tauCyclic_MPa: shearStress({ force_N: F, D_mm: s.meanDia_mm, d_mm: s.wireDia_mm, factor: Kw }),
      utilisation: shearStress({ force_N: F, D_mm: s.meanDia_mm, d_mm: s.wireDia_mm, factor: Ks }) / allow.tauAllow_MPa,
    };
  };

  if (s.travelToSolid_mm != null) {
    out.atSolid = { deflection_mm: s.travelToSolid_mm, force_N: s.forceAtSolid_N, ...stressAt(s.forceAtSolid_N) };
  }
  if (s.usableTravel_mm != null) {
    out.maxUsable = {
      deflection_mm: s.usableTravel_mm,
      force_N: s.maxUsableForce_N,
      length_mm: s.minWorkingLength_mm ?? null,
      source: s.usableTravelSource,
      ...stressAt(s.maxUsableForce_N),
    };
  }

  if (s.freeLength_mm != null && s.meanDia_mm != null && s.materialKey != null) {
    out.buckling = bucklingAnalysis({
      freeLength_mm: s.freeLength_mm, D_mm: s.meanDia_mm,
      materialKey: s.materialKey, endCondition,
    });
    out.buckling.slendernessRatio = s.freeLength_mm / s.meanDia_mm;
  }

  if (targetForce_N == null) return out;

  const x = deflectionForForce(k, targetForce_N);
  const stress = stressAt(targetForce_N);
  const work = {
    targetForce_N,
    deflection_mm: x,
    installedLength_mm: s.freeLength_mm != null ? s.freeLength_mm - x : null,
    ...stress,
  };
  if (s.usableTravel_mm != null) {
    work.travelUsedFraction = x / s.usableTravel_mm;
    work.travelHeadroom_mm = s.usableTravel_mm - x;
  }
  if (s.travelToSolid_mm != null) work.solidTravelUsedFraction = x / s.travelToSolid_mm;

  // How hard is it to actually hit this force?  dF/dx is the rate itself,
  // so a stiff spring turns a small assembly error into a big force error.
  const dx = positionTol_mm + freeLengthTol_mm;
  const forceErrFromPosition = k * dx;
  const forceErrFromRate = targetForce_N * rateTol;
  work.sensitivity = {
    dFdx_NperMm: k,
    positionBand_mm: dx,
    forceErrFromPosition_N: forceErrFromPosition,
    forceErrFromRate_N: forceErrFromRate,
    worstCase_N: forceErrFromPosition + forceErrFromRate,
    rss_N: Math.hypot(forceErrFromPosition, forceErrFromRate),
    worstCaseFraction: (forceErrFromPosition + forceErrFromRate) / targetForce_N,
    rssFraction: Math.hypot(forceErrFromPosition, forceErrFromRate) / targetForce_N,
    forceRange_N: [
      Math.max(0, targetForce_N - forceErrFromPosition - forceErrFromRate),
      targetForce_N + forceErrFromPosition + forceErrFromRate,
    ],
  };
  out.working = work;

  // Feasibility
  const reasons = [];
  if (x <= 0) reasons.push('Target force is zero or negative.');
  if (s.usableTravel_mm != null && x > s.usableTravel_mm) {
    reasons.push(`Needs ${x.toFixed(2)} mm of travel but only ${s.usableTravel_mm.toFixed(2)} mm is usable (${s.usableTravelSource}).`);
  }
  if (s.freeLength_mm != null && work.installedLength_mm != null && s.solidLength_mm != null &&
      work.installedLength_mm < s.solidLength_mm) {
    reasons.push('Working point is past the solid length - the spring is fully collapsed before it reaches this force.');
  }
  if (stress.utilisation != null && stress.utilisation > 1) {
    reasons.push(`Shear stress at the working load is ${(stress.utilisation * 100).toFixed(0)}% of allowable.`);
  }
  if (out.buckling && !out.buckling.unconditionallyStable &&
      out.buckling.criticalDeflection_mm != null && x > out.buckling.criticalDeflection_mm) {
    out.warnings.push(`Buckles at ${out.buckling.criticalDeflection_mm.toFixed(2)} mm deflection unless guided in a bore or over a rod.`);
  }
  out.feasible = reasons.length === 0;
  out.reasons = reasons;
  return out;
}

/* ----------------------------------------------------------- catalog search */

/**
 * Rank a catalog against a working-point requirement.
 *
 * req:
 *   targetForce_N            required
 *   forceTolerance           fractional band the force must land in (unused for
 *                            search since deflection is solved exactly, but
 *                            kept for the tolerance report), default 0.10
 *   maxOD_mm, minOD_mm, minID_mm, maxFreeLength_mm, minFreeLength_mm
 *   maxInstalledLength_mm    envelope at the working point
 *   maxSolidLength_mm
 *   materials                array of material keys to allow
 *   minTravelHeadroom_mm     insist on this much unused travel
 *   maxTravelUsedFraction    e.g. 0.8 -- do not sit near the travel limit
 *   shapes                   ['straight', 'conical', ...] -- coil forms to keep
 *   systems                  ['inch'] or ['metric'] -- how the part is catalogued
 *   sections                 ['round', 'rectangular', ...] -- the wire section
 *   duties                   ['general'] or ['die'] -- general purpose or die spring
 *   cutToLength              'any' | 'exclude' | 'only' -- long stock you cut yourself
 *   sortBy                   'robustness' | 'travel' | 'compact' | 'rate' | 'force-precision'
 */
export function searchCatalog(springs, req = {}) {
  const {
    targetForce_N,
    maxOD_mm = null, minOD_mm = null,
    minID_mm = null, maxID_mm = null,
    minWireDia_mm = null, maxWireDia_mm = null,
    maxFreeLength_mm = null, minFreeLength_mm = null,
    maxInstalledLength_mm = null, maxSolidLength_mm = null,
    minRate_Npmm = null, maxRate_Npmm = null,
    minRatedLoad_N = null,
    minTemperature_C = null,
    straightOnly = false,
    shapes = null, systems = null, sections = null, duties = null,
    cutToLength = 'any',
    materials = null, ends = null, families = null,
    minTravelHeadroom_mm = 0,
    minDeflection_mm = null,
    maxTravelUsedFraction = 1,
    sortBy = 'robustness',
    includeRejected = false,
    ...evalOpts
  } = req;

  const results = [];
  for (const raw of springs) {
    const s = raw.incomplete === undefined ? normalizeSpring(raw) : raw;
    const rejected = [];

    if (s.incomplete) rejected.push(`Incomplete data: missing ${s.missing.join(', ')}.`);
    if (maxOD_mm != null && s.od_mm != null && s.od_mm > maxOD_mm + 1e-9) rejected.push(`OD ${s.od_mm.toFixed(2)} mm exceeds ${maxOD_mm.toFixed(2)} mm.`);
    if (minOD_mm != null && s.od_mm != null && s.od_mm < minOD_mm) rejected.push(`OD below minimum.`);
    if (minID_mm != null && s.id_mm != null && s.id_mm < minID_mm) rejected.push(`ID ${s.id_mm.toFixed(2)} mm will not clear a ${minID_mm.toFixed(2)} mm rod.`);
    if (maxID_mm != null && s.id_mm != null && s.id_mm > maxID_mm) rejected.push(`ID ${s.id_mm.toFixed(2)} mm exceeds ${maxID_mm.toFixed(2)} mm.`);
    if (minWireDia_mm != null && s.wireDia_mm != null && s.wireDia_mm < minWireDia_mm) rejected.push('Wire is thinner than asked for.');
    if (maxWireDia_mm != null && s.wireDia_mm != null && s.wireDia_mm > maxWireDia_mm) rejected.push('Wire is thicker than asked for.');
    if (maxFreeLength_mm != null && s.freeLength_mm != null && s.freeLength_mm > maxFreeLength_mm) rejected.push('Free length too long.');
    if (minFreeLength_mm != null && s.freeLength_mm != null && s.freeLength_mm < minFreeLength_mm) rejected.push('Free length too short.');
    if (maxSolidLength_mm != null && s.solidLength_mm != null && s.solidLength_mm > maxSolidLength_mm) rejected.push('Solid length too long.');
    if (minRate_Npmm != null && s.rate_Npmm != null && s.rate_Npmm < minRate_Npmm) rejected.push('Softer than the rate asked for.');
    if (maxRate_Npmm != null && s.rate_Npmm != null && s.rate_Npmm > maxRate_Npmm) rejected.push('Stiffer than the rate asked for.');
    if (minRatedLoad_N != null && s.maxUsableForce_N != null && s.maxUsableForce_N < minRatedLoad_N) {
      rejected.push(`Rated to ${s.maxUsableForce_N.toFixed(2)} N, below the ${minRatedLoad_N.toFixed(2)} N asked for.`);
    }
    // An unknown rating is not a failed one -- most catalogue tables never
    // publish a temperature, and excluding those would hide good springs.
    if (minTemperature_C != null && s.maxTemp_C != null && s.maxTemp_C < minTemperature_C) {
      rejected.push(`Rated to ${s.maxTemp_C.toFixed(0)} C, below the ${minTemperature_C.toFixed(0)} C asked for.`);
    }
    if (straightOnly && s.shapeKey !== 'straight') rejected.push(`Listed as ${SHAPES[s.shapeKey].name}, not a straight cylindrical spring.`);
    if (shapes && shapes.length && !shapes.includes(s.shapeKey)) rejected.push(`${SHAPES[s.shapeKey].name} coil shape excluded.`);
    if (systems && systems.length && !systems.includes(s.system)) rejected.push(`${UNIT_SYSTEMS[s.system]?.name || s.system} parts excluded.`);
    if (sections && sections.length && !sections.includes(s.sectionKey)) rejected.push(`${SECTIONS[s.sectionKey].name} excluded.`);
    if (duties && duties.length && !duties.includes(s.dutyKey)) rejected.push(`${DUTIES[s.dutyKey].name} excluded.`);
    if (cutToLength === 'exclude' && s.cutToLength) rejected.push('Cut-to-length stock, excluded.');
    if (cutToLength === 'only' && !s.cutToLength) rejected.push('Not cut-to-length stock.');
    if (materials && materials.length && !materials.includes(s.materialKey)) rejected.push('Material excluded.');
    if (ends && ends.length && !ends.includes(s.endsKey)) rejected.push('End type excluded.');
    if (families && families.length && !families.includes(s.family)) rejected.push(`${s.family || 'Unlisted product family'} excluded.`);

    const ev = evaluate(s, { targetForce_N, ...evalOpts });
    if (!ev.feasible) rejected.push(...ev.reasons);
    if (ev.working) {
      if (ev.working.travelHeadroom_mm != null && ev.working.travelHeadroom_mm < minTravelHeadroom_mm) {
        rejected.push(`Only ${ev.working.travelHeadroom_mm.toFixed(2)} mm of travel left past the working point.`);
      }
      if (minDeflection_mm != null && ev.working.deflection_mm < minDeflection_mm) {
        rejected.push(`Reaches the force after only ${ev.working.deflection_mm.toFixed(2)} mm - too stiff for the travel asked for.`);
      }
      if (ev.working.travelUsedFraction != null && ev.working.travelUsedFraction > maxTravelUsedFraction) {
        rejected.push(`Uses ${(ev.working.travelUsedFraction * 100).toFixed(0)}% of usable travel.`);
      }
      if (maxInstalledLength_mm != null && ev.working.installedLength_mm != null &&
          ev.working.installedLength_mm > maxInstalledLength_mm) {
        rejected.push('Installed length exceeds the envelope.');
      }
    }

    const entry = { spring: s, evaluation: ev, ok: rejected.length === 0, rejected };
    if (entry.ok || includeRejected) results.push(entry);
  }

  const scored = results.map((r) => ({ ...r, score: scoreResult(r, sortBy) }));
  scored.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return b.score - a.score;
  });
  return scored;
}

function scoreResult(r, sortBy) {
  const w = r.evaluation.working;
  const s = r.spring;
  if (!w) return -Infinity;
  switch (sortBy) {
    case 'travel':
      return w.travelHeadroom_mm ?? 0;
    case 'compact':
      return -((s.od_mm ?? 0) * (w.installedLength_mm ?? s.freeLength_mm ?? 0));
    case 'rate':
      return -(s.rate_Npmm ?? Infinity);
    case 'force-precision':
      return -(w.sensitivity?.rssFraction ?? Infinity);
    case 'robustness':
    default: {
      // Favour a working point that sits mid-travel with low force sensitivity
      // and comfortable stress -- the spring you can actually build around.
      const sens = w.sensitivity?.rssFraction ?? 1;
      const used = w.travelUsedFraction ?? 0.5;
      const midTravel = 1 - Math.abs(used - 0.45) / 0.55; // 1 at 45% of travel
      const stressMargin = 1 - Math.min(w.utilisation ?? 0.5, 1);
      return 0.5 * (1 - Math.min(sens, 1)) + 0.35 * Math.max(midTravel, 0) + 0.15 * stressMargin;
    }
  }
}

/* ---------------------------------------------------- catalog-free design */

/** Music wire / spring wire diameters commonly stocked, inches. */
export const STANDARD_WIRE_DIA_IN = [
  0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.010, 0.011, 0.012, 0.013, 0.014,
  0.015, 0.016, 0.017, 0.018, 0.019, 0.020, 0.022, 0.024, 0.026, 0.028, 0.029,
  0.030, 0.031, 0.032, 0.033, 0.034, 0.035, 0.036, 0.038, 0.040, 0.041, 0.043,
  0.045, 0.047, 0.048, 0.051, 0.055, 0.059, 0.063, 0.067, 0.072, 0.076, 0.080,
  0.085, 0.090, 0.095, 0.100, 0.106, 0.112, 0.118, 0.125,
];

/**
 * What should you even be shopping for?
 *
 * Given a target force and an OD ceiling, sweep working deflection and report
 * the spring rate window that lands the force there, plus a buildable
 * geometry at each point. This is what you type into a vendor's rate filter
 * before you have any catalog data at all.
 */
export function designSpace({
  targetForce_N,
  maxOD_mm,
  deflectionRange_mm = [1.27, 12.7], // 0.05" .. 0.5"
  steps = 8,
  materialKey = DEFAULT_MATERIAL,
  endsKey = DEFAULT_ENDS,
  minIndex = 4,
  maxIndex = 16,
  minActiveCoils = 3,
  solidStressLimit = 1.0,
}) {
  const mat = getMaterial(materialKey);
  const [xMin, xMax] = deflectionRange_mm;
  const points = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const x = xMin * Math.pow(xMax / xMin, t); // log spacing
    const k = targetForce_N / x;
    const options = [];
    for (const dIn of STANDARD_WIRE_DIA_IN) {
      const d = inToMm(dIn);
      const D = maxOD_mm - d;
      if (D <= 0) continue;
      const C = D / d;
      if (C < minIndex || C > maxIndex) continue;
      const Na = activeCoilsFromRate({ G_GPa: mat.G_GPa, d_mm: d, D_mm: D, rate_Npmm: k });
      if (!Number.isFinite(Na) || Na < minActiveCoils) continue;
      const Nt = totalFromActive(Na, endsKey);
      const Ls = solidLength(Nt, d, endsKey);
      const travelToSolid = x / 0.85; // put the working point at 85% of usable
      const L0 = Ls + travelToSolid;
      const allow = allowableShearStress(materialKey, d);
      const Ks = staticShearFactor(C);
      const tauWork = shearStress({ force_N: targetForce_N, D_mm: D, d_mm: d, factor: Ks });
      const forceAtSolidN = k * (L0 - Ls);
      const tauSolid = shearStress({ force_N: forceAtSolidN, D_mm: D, d_mm: d, factor: Ks });
      if (tauSolid / allow.tauAllow_MPa > solidStressLimit) continue;
      options.push({
        wireDia_mm: d, wireDia_in: dIn, meanDia_mm: D, od_mm: maxOD_mm,
        springIndex: C, activeCoils: Na, totalCoils: Nt,
        solidLength_mm: Ls, minFreeLength_mm: L0,
        stressUtilisationAtWork: tauWork / allow.tauAllow_MPa,
        stressUtilisationAtSolid: tauSolid / allow.tauAllow_MPa,
      });
    }
    // Fewest coils wins: for a light spring in a small bore, thin wire beats
    // "textbook" index 8 by an order of magnitude in length.
    options.sort((a, b) => a.minFreeLength_mm - b.minFreeLength_mm);
    points.push({ deflection_mm: x, rate_Npmm: k, options });
  }
  return {
    targetForce_N, maxOD_mm, materialKey,
    rateWindow_Npmm: [targetForce_N / xMax, targetForce_N / xMin],
    points,
  };
}
