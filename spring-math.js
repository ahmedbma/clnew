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
export function normalizeSpring(raw) {
  const s = { ...raw };
  const derived = [];
  const warnings = [];

  s.materialKey = s.materialKey || resolveMaterial(s.material) || DEFAULT_MATERIAL;
  if (s.material && !resolveMaterial(s.material)) {
    warnings.push(`Material "${s.material}" not recognised; assumed ${getMaterial(s.materialKey).name}.`);
  }
  s.endsKey = s.endsKey || resolveEnds(s.ends) || null;
  if (!s.endsKey) {
    s.endsKey = DEFAULT_ENDS;
    if (s.ends) warnings.push(`End type "${s.ends}" not recognised; assumed closed and ground.`);
    else derived.push('endsKey');
  }
  const mat = getMaterial(s.materialKey);
  s.G_GPa = num(s.G_GPa) ?? mat.G_GPa;

  // --- wire / diameters: any two of OD, ID, wire dia give the third.
  let od = num(s.od_mm), id = num(s.id_mm), d = num(s.wireDia_mm);
  if (d == null && od != null && id != null) { d = (od - id) / 2; derived.push('wireDia_mm'); }
  if (id == null && od != null && d != null) { id = od - 2 * d; derived.push('id_mm'); }
  if (od == null && id != null && d != null) { od = id + 2 * d; derived.push('od_mm'); }
  s.od_mm = od; s.id_mm = id; s.wireDia_mm = d;

  if (od == null || d == null) {
    return { ...s, derived, warnings, incomplete: true,
      missing: [od == null && 'outside diameter', d == null && 'wire diameter'].filter(Boolean) };
  }

  s.meanDia_mm = meanDiameter(od, d);
  s.springIndex = springIndex(s.meanDia_mm, d);
  if (s.springIndex < 4) warnings.push(`Spring index C=${s.springIndex.toFixed(1)} is below 4 - tightly wound, high stress concentration, hard to manufacture.`);
  if (s.springIndex > 14) warnings.push(`Spring index C=${s.springIndex.toFixed(1)} is above 14 - loose, prone to tangling and buckling.`);

  // --- coils <-> rate: whichever is missing comes from the other.
  let Na = num(s.activeCoils), Nt = num(s.totalCoils), k = num(s.rate_Npmm);
  if (Na == null && Nt != null) { Na = activeFromTotal(Nt, s.endsKey); derived.push('activeCoils'); }
  if (Na != null && k == null) {
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
  if (Nt == null && Na != null) { Nt = totalFromActive(Na, s.endsKey); derived.push('totalCoils'); }
  s.activeCoils = Na; s.totalCoils = Nt; s.rate_Npmm = k;

  if (k == null) {
    return { ...s, derived, warnings, incomplete: true,
      missing: ['spring rate (or coil count, to derive it)'] };
  }
  if (Na != null && Na < 2) warnings.push(`Only ${Na.toFixed(1)} active coils - the rate equation is unreliable this low.`);

  // --- lengths and travel
  let L0 = num(s.freeLength_mm);
  let Ls = num(s.solidLength_mm);
  if (Ls == null && Nt != null) { Ls = solidLength(Nt, d, s.endsKey); derived.push('solidLength_mm'); }
  s.solidLength_mm = Ls;
  s.freeLength_mm = L0;

  if (L0 != null && Ls != null) {
    s.travelToSolid_mm = L0 - Ls;
    if (s.travelToSolid_mm <= 0) {
      warnings.push('Derived solid length exceeds free length - the input data is inconsistent.');
      s.travelToSolid_mm = null;
    }
  }

  // Usable travel. Prefer what the vendor rates; otherwise take a fraction of
  // travel-to-solid, because running a stock spring to solid is where it
  // takes a set and stops being the spring you specified.
  const vendorMaxDefl = num(s.maxDeflection_mm);
  const vendorMaxLoad = num(s.maxLoad_N);
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
    rateTol = 0.10,
    freeLengthTol_mm = 0,
    endCondition = 'fixed-fixed',
    setRemoved = false,
  } = opts;

  const k = s.rate_Npmm;
  const C = s.springIndex;
  const Ks = staticShearFactor(C);
  const Kw = wahlFactor(C);
  const allow = allowableShearStress(s.materialKey, s.wireDia_mm, { setRemoved });
  out.allowable = allow;
  out.factors = { Ks, Kw, springIndex: C };

  const stressAt = (F) => {
    const tauStatic = shearStress({ force_N: F, D_mm: s.meanDia_mm, d_mm: s.wireDia_mm, factor: Ks });
    const tauCyclic = shearStress({ force_N: F, D_mm: s.meanDia_mm, d_mm: s.wireDia_mm, factor: Kw });
    return { tauStatic_MPa: tauStatic, tauCyclic_MPa: tauCyclic, utilisation: tauStatic / allow.tauAllow_MPa };
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

  if (s.freeLength_mm != null && s.meanDia_mm != null) {
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
  if (stress.utilisation > 1) {
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
 *   sortBy                   'robustness' | 'travel' | 'compact' | 'rate' | 'force-precision'
 */
export function searchCatalog(springs, req = {}) {
  const {
    targetForce_N,
    maxOD_mm = null, minOD_mm = null, minID_mm = null,
    maxFreeLength_mm = null, minFreeLength_mm = null,
    maxInstalledLength_mm = null, maxSolidLength_mm = null,
    materials = null,
    minTravelHeadroom_mm = 0,
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
    if (maxFreeLength_mm != null && s.freeLength_mm != null && s.freeLength_mm > maxFreeLength_mm) rejected.push('Free length too long.');
    if (minFreeLength_mm != null && s.freeLength_mm != null && s.freeLength_mm < minFreeLength_mm) rejected.push('Free length too short.');
    if (maxSolidLength_mm != null && s.solidLength_mm != null && s.solidLength_mm > maxSolidLength_mm) rejected.push('Solid length too long.');
    if (materials && materials.length && !materials.includes(s.materialKey)) rejected.push('Material excluded.');

    const ev = evaluate(s, { targetForce_N, ...evalOpts });
    if (!ev.feasible) rejected.push(...ev.reasons);
    if (ev.working) {
      if (ev.working.travelHeadroom_mm != null && ev.working.travelHeadroom_mm < minTravelHeadroom_mm) {
        rejected.push(`Only ${ev.working.travelHeadroom_mm.toFixed(2)} mm of travel left past the working point.`);
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
