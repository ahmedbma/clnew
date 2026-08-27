/**
 * catalog.js -- get real vendor data into the engine.
 *
 * The point of this file is that nobody should be retyping spring specs.
 * McMaster (and Lee, Century, MISUMI, Associated) all render their catalogue
 * as an HTML table; select it, copy, paste it in here and this parses the
 * tab-separated clipboard payload into normalised SI spring objects.
 *
 * It also reads CSV, and it is deliberately forgiving about the ways vendors
 * write numbers: 0.36", .36, 3/8", 1-1/2", 12.7 mm, "4.5 lbs./in.", "1.5 N".
 */

import {
  inToMm, lbfToN, lbfPerInToNPerMm, resolveMaterial, resolveEnds,
  normalizeSpring, MATERIALS, END_TYPES,
} from './spring-math.js';

/* ---------------------------------------------------------- value parsing */

const FRACTION = /^(\d+)?[\s-]*(\d+)\s*\/\s*(\d+)$/;

/** "1-1/2" -> 1.5, "3/8" -> 0.375, ".36" -> 0.36 */
export function parseNumber(text) {
  if (text == null) return null;
  let t = String(text).trim().replace(/,/g, '');
  if (!t) return null;
  const frac = t.match(FRACTION);
  if (frac) {
    const whole = frac[1] ? parseInt(frac[1], 10) : 0;
    const n = parseInt(frac[2], 10);
    const dnm = parseInt(frac[3], 10);
    if (!dnm) return null;
    return whole + n / dnm;
  }
  const m = t.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/);
  if (!m) return null;
  const v = parseFloat(m[0]);
  return Number.isFinite(v) ? v : null;
}

/**
 * Pull a unit out of a string. Checks longest/most specific first so that
 * "lbs./in." is a rate and not a force, and "in" is not found inside "Inconel".
 */
export function detectUnit(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (/n\s*\/\s*mm/.test(t)) return 'N/mm';
  if (/(lbs?f?|pounds?)\s*\.?\s*\/\s*(in|inch)/.test(t)) return 'lbf/in';
  if (/n\s*\/\s*m\b/.test(t)) return 'N/m';
  if (/\bkgf?\s*\/\s*mm/.test(t)) return 'kgf/mm';
  // A trailing unit may be glued to the number ("12.7mm", "0.5in", "1.5N"),
  // so match the suffix as well as the standalone word.
  if (/mm\b|millimet/.test(t)) return 'mm';
  if (/["”]|inch(es)?\b|(?:^|[\d\s.])in\.?\s*$|\bin\b(?!con)/.test(t)) return 'in';
  if (/lbs?f?\b|pounds?\b/.test(t)) return 'lbf';
  if (/(?:^|[\d\s.])ozf?\b|ounces?\b/.test(t)) return 'ozf';
  if (/(?:^|[\d\s.])kgf?\b|kilogram/.test(t)) return 'kgf';
  if (/(?:^|[\d\s.])gf\b|gram(s|-force)?\b/.test(t)) return 'gf';
  if (/(?:^|[\d\s.])n\.?\s*$|newton/.test(t)) return 'N';
  return null;
}

const LENGTH_TO_MM = { mm: 1, cm: 10, m: 1000, in: 25.4 };
const FORCE_TO_N = {
  N: 1, kN: 1000, lbf: 4.4482216152605, ozf: 0.2780138509,
  kgf: 9.80665, gf: 0.00980665,
};
const RATE_TO_N_PER_MM = {
  'N/mm': 1, 'N/m': 0.001, 'lbf/in': lbfPerInToNPerMm(1), 'kgf/mm': 9.80665,
};

/** value + unit -> mm.  `fallbackUnit` is used when the cell carries none. */
export function toMm(text, fallbackUnit = 'in') {
  const v = parseNumber(text);
  if (v == null) return null;
  const u = detectUnit(text) || fallbackUnit;
  const f = LENGTH_TO_MM[u];
  return f == null ? null : v * f;
}

export function toNewtons(text, fallbackUnit = 'lbf') {
  const v = parseNumber(text);
  if (v == null) return null;
  const u = detectUnit(text) || fallbackUnit;
  const f = FORCE_TO_N[u];
  return f == null ? null : v * f;
}

export function toNewtonsPerMm(text, fallbackUnit = 'lbf/in') {
  const v = parseNumber(text);
  if (v == null) return null;
  const u = detectUnit(text) || fallbackUnit;
  const f = RATE_TO_N_PER_MM[u];
  return f == null ? null : v * f;
}

/* --------------------------------------------------------- column mapping */

/**
 * Vendor header text -> canonical field. Patterns are tested in order, so put
 * the specific ones (inside diameter, solid length) above the generic ones
 * (diameter, length).
 */
const COLUMN_PATTERNS = [
  ['partNumber', /part\s*(#|no|num|number)|^part$|item\s*(#|no)|catalog|mcmaster|sku|model/],
  ['url', /^(url|link|href)$/],
  ['wireDia', /wire\s*(dia|diameter|size|gauge|ga\b)|^wire$/],
  ['id', /\b(id|i\.d\.)\b|inside\s*(dia|diameter)|inner\s*(dia|diameter)|bore/],
  ['forRodDia', /for\s*rod|rod\s*dia|over\s*rod|shaft\s*dia/],
  ['forHoleDia', /for\s*hole|in\s*hole|hole\s*dia|bore\s*dia/],
  ['od', /\b(od|o\.d\.)\b|outside\s*(dia|diameter)|outer\s*(dia|diameter)|^dia(meter)?\.?$/],
  ['solidLength', /solid\s*(length|lg|height|ht)|compressed\s*(length|lg)|closed\s*(length|lg|height)/],
  ['maxDeflection', /max.*(deflect|travel|compress|stroke)|(deflect|travel|stroke).*max|working\s*(travel|stroke)/],
  ['maxLoad', /max.*(load|force)|(load|force).*max|rated\s*(load|force)|load\s*@|load\s*at/],
  ['freeLength', /free\s*(length|lg|ht|height)|overall\s*(length|lg)|^(length|lg|lg\.|ht)\.?$|uncompressed/],
  ['rate', /spring\s*rate|^rate\b|load\s*rate|lbs?\.?\s*\/\s*in|n\s*\/\s*mm|stiffness/],
  ['totalCoils', /total\s*coils|^coils?$|number\s*of\s*coils/],
  ['activeCoils', /active\s*coils/],
  ['material', /material|\balloy\b|^made\s*of/],
  ['finish', /finish|plating|coating/],
  ['ends', /\bends?\b|end\s*type|end\s*style/],
  ['packQty', /pack|qty|quantity|each\s*pack|per\s*pack/],
  ['price', /price|each|\$|cost/],
];

export function mapHeader(headerCells) {
  const mapping = [];
  const used = new Set();
  headerCells.forEach((cell, i) => {
    const h = String(cell || '').toLowerCase().trim();
    let field = null;
    for (const [name, re] of COLUMN_PATTERNS) {
      if (re.test(h) && !used.has(name)) { field = name; break; }
    }
    if (field) used.add(field);
    mapping.push({ index: i, header: cell, field, unit: detectUnit(h) });
  });
  return mapping;
}

/* ----------------------------------------------------------- table parsing */

function splitRow(line) {
  if (line.includes('\t')) return line.split('\t');
  // Quote-aware CSV, falling back to 2+ spaces for pasted fixed-width text.
  if (line.includes(',')) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
      } else if (ch === ',' && !inQ) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  }
  return line.split(/\s{2,}/);
}

const looksLikeHeader = (cells) =>
  cells.some((c) => /[a-z]{3,}/i.test(String(c))) &&
  cells.filter((c) => parseNumber(c) != null).length < cells.length / 2;

/**
 * Parse a pasted table into rows keyed by canonical field name.
 * Returns { mapping, rows, skipped, unmapped }.
 */
export function parseTable(text, { columns = null } = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
    .map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  if (!lines.length) return { mapping: [], rows: [], skipped: [], unmapped: [] };

  let mapping;
  let start = 0;
  const first = splitRow(lines[0]).map((c) => c.trim());
  if (columns) {
    mapping = columns.map((field, i) => ({ index: i, header: field, field, unit: null }));
    if (looksLikeHeader(first)) start = 1;
  } else if (looksLikeHeader(first)) {
    mapping = mapHeader(first);
    start = 1;
  } else {
    return {
      mapping: [], rows: [], skipped: lines,
      unmapped: [],
      error: 'No header row found. Include the vendor’s header line, or pass an explicit column list.',
    };
  }

  const rows = [];
  const skipped = [];
  for (let i = start; i < lines.length; i++) {
    const cells = splitRow(lines[i]).map((c) => c.trim());
    // McMaster tables carry section banners and footnotes as single-cell rows.
    if (cells.filter((c) => c !== '').length < 2) { skipped.push(lines[i]); continue; }
    const row = { _raw: lines[i] };
    mapping.forEach((m) => {
      if (!m.field) return;
      const v = cells[m.index];
      if (v == null || v === '') return;
      row[m.field] = v;
      if (m.unit) row[`${m.field}_headerUnit`] = m.unit;
    });
    if (Object.keys(row).length <= 1) { skipped.push(lines[i]); continue; }
    rows.push(row);
  }
  const unmapped = mapping.filter((m) => !m.field && String(m.header || '').trim() !== '');
  return { mapping, rows, skipped, unmapped };
}

/* ------------------------------------------------------- rows -> springs */

/**
 * Convert parsed rows to normalised SI springs.
 *
 * opts.lengthUnit / forceUnit / rateUnit are the fallbacks for cells that do
 * not spell out their own unit -- McMaster's US tables are in inches and
 * lbs./in., its metric tables in mm and N/mm.
 */
export function rowsToSprings(rows, opts = {}) {
  const {
    lengthUnit = 'in', forceUnit = 'lbf', rateUnit = 'lbf/in',
    vendor = 'McMaster-Carr', urlTemplate = 'https://www.mcmaster.com/{part}/',
    defaultMaterial = null, defaultEnds = null, source = null,
  } = opts;

  return rows.map((row, i) => {
    const lu = row.od_headerUnit === 'mm' || row.freeLength_headerUnit === 'mm' ? 'mm' : lengthUnit;
    const ru = row.rate_headerUnit || rateUnit;
    const fu = row.maxLoad_headerUnit || forceUnit;

    const part = row.partNumber ? String(row.partNumber).replace(/\s+/g, '') : null;
    const materialText = [row.material, row.finish].filter(Boolean).join(' ');
    const raw = {
      partNumber: part,
      vendor,
      url: row.url || (part && urlTemplate ? urlTemplate.replace('{part}', encodeURIComponent(part)) : null),
      type: 'compression',
      material: materialText || defaultMaterial,
      materialKey: resolveMaterial(materialText) || (defaultMaterial ? resolveMaterial(defaultMaterial) : null) || undefined,
      ends: row.ends || defaultEnds,
      endsKey: resolveEnds(row.ends) || (defaultEnds ? resolveEnds(defaultEnds) : null) || undefined,
      od_mm: toMm(row.od, lu),
      id_mm: toMm(row.id, lu),
      wireDia_mm: toMm(row.wireDia, lu),
      freeLength_mm: toMm(row.freeLength, lu),
      solidLength_mm: toMm(row.solidLength, lu),
      maxDeflection_mm: toMm(row.maxDeflection, lu),
      rate_Npmm: toNewtonsPerMm(row.rate, ru),
      maxLoad_N: toNewtons(row.maxLoad, fu),
      totalCoils: parseNumber(row.totalCoils),
      activeCoils: parseNumber(row.activeCoils),
      forRodDia_mm: toMm(row.forRodDia, lu),
      forHoleDia_mm: toMm(row.forHoleDia, lu),
      packQty: parseNumber(row.packQty),
      price: row.price || null,
      source: source || `pasted table row ${i + 1}`,
      provenance: 'vendor-table-import',
    };
    Object.keys(raw).forEach((k) => { if (raw[k] === undefined) delete raw[k]; });
    return normalizeSpring(raw);
  });
}

/** One-call convenience: paste text in, normalised springs out. */
export function importTable(text, opts = {}) {
  const parsed = parseTable(text, opts);
  if (parsed.error) return { ...parsed, springs: [] };
  const springs = rowsToSprings(parsed.rows, opts);
  return { ...parsed, springs };
}

/* ------------------------------------------------------------- hand entry */

/** Build a spring from a units-tagged form object (the "add one" UI path). */
export function springFromForm(f) {
  const L = (v) => (v === '' || v == null ? null : toMm(String(v), f.lengthUnit || 'in'));
  const raw = {
    partNumber: f.partNumber || null,
    vendor: f.vendor || null,
    url: f.url || null,
    type: 'compression',
    materialKey: f.materialKey || undefined,
    endsKey: f.endsKey || undefined,
    od_mm: L(f.od), id_mm: L(f.id), wireDia_mm: L(f.wireDia),
    freeLength_mm: L(f.freeLength), solidLength_mm: L(f.solidLength),
    maxDeflection_mm: L(f.maxDeflection),
    rate_Npmm: f.rate === '' || f.rate == null ? null
      : toNewtonsPerMm(String(f.rate), f.rateUnit || 'lbf/in'),
    maxLoad_N: f.maxLoad === '' || f.maxLoad == null ? null
      : toNewtons(String(f.maxLoad), f.forceUnit || 'lbf'),
    totalCoils: f.totalCoils === '' || f.totalCoils == null ? null : parseNumber(String(f.totalCoils)),
    activeCoils: f.activeCoils === '' || f.activeCoils == null ? null : parseNumber(String(f.activeCoils)),
    provenance: 'hand-entered',
  };
  Object.keys(raw).forEach((k) => { if (raw[k] === undefined) delete raw[k]; });
  return normalizeSpring(raw);
}

/* ------------------------------------------------------------ persistence */

const CATALOG_VERSION = 1;

export function toCatalogJson(springs, meta = {}) {
  return {
    version: CATALOG_VERSION,
    generated: new Date().toISOString(),
    units: 'SI (mm, N, N/mm)',
    ...meta,
    springs: springs.map(stripDerived),
  };
}

/** Keep only what was actually supplied, so a reload re-derives cleanly. */
function stripDerived(s) {
  const drop = new Set([...(s.derived || []), 'warnings', 'derived', 'incomplete', 'missing',
    'meanDia_mm', 'springIndex', 'travelToSolid_mm', 'usableTravel_mm', 'usableTravelSource',
    'maxUsableForce_N', 'minWorkingLength_mm', 'forceAtSolid_N', 'rateCheck', 'G_GPa']);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (drop.has(k) || v == null) continue;
    out[k] = v;
  }
  return out;
}

export function fromCatalogJson(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const list = Array.isArray(data) ? data : data.springs || [];
  return list.map((s) => normalizeSpring(s));
}

export const MATERIAL_OPTIONS = Object.entries(MATERIALS).map(([key, m]) => ({ key, name: m.name }));
export const END_OPTIONS = Object.entries(END_TYPES).map(([key, e]) => ({ key, name: e.name }));
