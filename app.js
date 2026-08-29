/**
 * app.js -- browser front end for the spring calculator.
 * All the physics lives in spring-math.js; this file is display and plumbing.
 */
import * as sm from './spring-math.js';
import * as cat from './catalog.js';
import * as nlq from './nl-query.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'springcalc.catalog.v1';
// Bumping this clears every browser's stored springs once, on next load.
// Used to wipe the synthetic demo data the tool used to ship with.
const RESET_TOKEN = '2026-08-27-clean-slate';
// Results are ranked, so a window onto the best of them is the useful view.
// The catalogue is a reference list and shows in full.
const MAX_RESULT_ROWS = 100;

const state = {
  lengthUnit: 'in',
  shared: [],        // shipped with the site, same for every visitor
  sharedMeta: null,
  local: [],         // this browser's own additions
  hidden: new Set(), // shipped springs this browser has dismissed
  catalogue: [],     // shared + local, merged for everything downstream
  storeError: null,
  results: [],
  selected: null,
  cat: { sort: { key: null, dir: 'asc' }, filters: {} },
  find: { sort: { key: null, dir: 'asc' }, filters: {} },
  catUnits: 'in',
};

/**
 * Identity of a spring across the shared list and a local one, so a locally
 * edited part supersedes the shipped row rather than duplicating it.
 */
const springName = (s) => s.partNumber || s.label || '—';

const springKey = (s) => (s.partNumber
  ? `${(s.vendor || '').toLowerCase().trim()}|${String(s.partNumber).toLowerCase().replace(/\s+/g, '')}`
  : `geom|${[s.od_mm, s.wireDia_mm, s.freeLength_mm, s.rate_Npmm]
      .map((v) => (v == null ? '' : v.toFixed(4))).join(',')}`);

/* ---------------------------------------------------------------- format */

const nf = (v, n) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(n));
const pct = (x) => (x == null || !Number.isFinite(x) ? '—' : `${Math.round(x * 100)}%`);

/** Length in the unit the user is working in. */
function L(mm, { both = false } = {}) {
  if (mm == null || !Number.isFinite(mm)) return '—';
  const inch = state.lengthUnit === 'in';
  const main = inch ? `${nf(sm.mmToIn(mm), 3)} in` : `${nf(mm, 2)} mm`;
  if (!both) return main;
  return `${main} (${inch ? `${nf(mm, 2)} mm` : `${nf(sm.mmToIn(mm), 3)} in`})`;
}
const Lnum = (mm) => (mm == null ? '—' : state.lengthUnit === 'in' ? nf(sm.mmToIn(mm), 3) : nf(mm, 2));
const Lunit = () => (state.lengthUnit === 'in' ? 'in' : 'mm');

function F(N, { both = false } = {}) {
  if (N == null || !Number.isFinite(N)) return '—';
  const main = `${nf(N, 3)} N`;
  return both ? `${main} (${nf(sm.nToLbf(N), 3)} lbf)` : main;
}
function K(k, { both = true } = {}) {
  if (k == null || !Number.isFinite(k)) return '—';
  const si = `${nf(k, 4)} N/mm`;
  const us = `${nf(sm.nPerMmToLbfPerIn(k), 2)} lbf/in`;
  return state.lengthUnit === 'in' ? (both ? `${us} (${si})` : us) : (both ? `${si} (${us})` : si);
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Read a numeric input, returning null when blank. */
const rawNum = (id) => { const v = $(id).value.trim(); return v === '' ? null : Number(v); };
/** Read a length input in the active display unit, as mm. */
const readLen = (id) => { const v = rawNum(id); return v == null ? null : (state.lengthUnit === 'in' ? sm.inToMm(v) : v); };
const readRate = (id) => {
  const v = rawNum(id);
  if (v == null) return null;
  return state.lengthUnit === 'in' ? sm.lbfPerInToNPerMm(v) : v;
};
const readTemp = (id, unitId) => {
  const v = rawNum(id);
  if (v == null) return null;
  return $(unitId).value === 'F' ? (v - 32) * 5 / 9 : v;
};
const readForce = (id, unitId) => {
  const v = rawNum(id);
  if (v == null) return null;
  return cat.toNewtons(`${v} ${$(unitId).value}`, 'N');
};

/* ------------------------------------------------------------------ tabs */

document.querySelectorAll('nav.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `tab-${b.dataset.tab}`; });
    if (b.dataset.tab === 'catalog' && state.catalogueStale) renderCatalogue();
  });
});

/* -------------------------------------------------------------- storage */

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.resetToken !== RESET_TOKEN) {
      // Everything stored before this token was demo data; start clean.
      localStorage.removeItem(STORE_KEY);
      return;
    }
    state.local = cat.fromCatalogJson(data);
    state.hidden = new Set(Array.isArray(data.hidden) ? data.hidden : []);
  } catch (e) {
    state.local = [];
    state.hidden = new Set();
  }
}

/**
 * Persist this browser's own springs. Storage can genuinely refuse -- a
 * private window, or a full quota -- and a save that silently did nothing
 * is the worst possible outcome here, so the failure is surfaced.
 */
function saveStore() {
  try {
    const payload = cat.toCatalogJson(state.local);
    payload.hidden = [...state.hidden];
    payload.resetToken = RESET_TOKEN;
    localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    state.storeError = null;
  } catch (e) {
    state.storeError = e && /quota/i.test(e.name || e.message || '')
      ? 'This browser is out of storage for the page, so your springs are NOT saved for next time. Download the catalogue as JSON to keep them.'
      : 'This browser is blocking local storage (a private window will do it), so your springs are NOT saved for next time. Download the catalogue as JSON to keep them.';
  }
  return state.storeError;
}

/** Populate the family filter from whatever is actually loaded. */
function refreshFamilies() {
  const sel = $('f-family');
  const chosen = sel.value;
  const names = [...new Set(state.catalogue.map((s) => s.family).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">any</option>';
  names.forEach((n) => sel.append(new Option(n, n)));
  if (names.includes(chosen)) sel.value = chosen;
}

/** The catalogue everything else reads: shipped rows, minus dismissals, with local ones on top. */
function rebuildCatalogue() {
  const byKey = new Map();
  for (const spring of state.shared) {
    const key = springKey(spring);
    if (state.hidden.has(key)) continue;
    byKey.set(key, { ...spring, _origin: 'shared' });
  }
  for (const spring of state.local) byKey.set(springKey(spring), { ...spring, _origin: 'local' });
  state.catalogue = [...byKey.values()];
  refreshFamilies();
}

/** Load the catalogue committed alongside the site. Absent or empty is fine. */
async function loadShared() {
  try {
    // The standalone build inlines it; the hosted site fetches it.
    let payload = window.SHARED_CATALOGUE;
    if (!payload) {
      const r = await fetch('./data/catalogue.json');
      if (!r.ok) return;
      payload = await r.json();
    }
    state.shared = cat.fromCatalogJson(payload);
    state.sharedMeta = { name: payload.name || 'Shared catalogue', updated: payload.updated || null };
  } catch (e) {
    state.shared = [];
  }
}

/** Add springs the user just supplied, honouring the append/replace choice. */
function addLocal(springs) {
  if ($('c-mode').value === 'replace') {
    state.local = [];
    state.hidden = new Set();
  }
  state.local.push(...springs);
  saveStore();
  rebuildCatalogue();
  renderCatalogue();
}

/* ------------------------------------------------------- select options */

function fillSelect(sel, opts, { blank = null } = {}) {
  sel.innerHTML = '';
  if (blank) sel.append(new Option(blank, ''));
  opts.forEach((o) => sel.append(new Option(o.name, o.key)));
}
fillSelect($('f-material'), cat.MATERIAL_OPTIONS, { blank: 'any' });
fillSelect($('a-material'), cat.MATERIAL_OPTIONS);
fillSelect($('a-ends'), cat.END_OPTIONS);
fillSelect($('f-ends'), cat.END_OPTIONS, { blank: 'any' });

/** Labels carry the unit the box is read in, so no field is ambiguous. */
function refreshUnitLabels() {
  const len = state.lengthUnit === 'in' ? 'in' : 'mm';
  const rate = state.lengthUnit === 'in' ? 'lbf/in' : 'N/mm';
  const force = $('f-force-u').value;
  document.querySelectorAll('[data-unit]').forEach((el) => {
    el.textContent = { length: len, rate, force }[el.dataset.unit] || '';
  });
}
fillSelect($('a-endcond'), Object.entries(sm.END_CONDITIONS).map(([key, v]) => ({ key, name: v.name })));

/* --------------------------------------------------------- shared report */

function badge(kind, text) { return `<span class="pill ${kind}">${esc(text)}</span>`; }

function severity(fraction) {
  if (fraction == null) return 'ok';
  if (fraction > 0.95) return 'bad';
  if (fraction > 0.75) return 'warn';
  return 'ok';
}

function specList(s) {
  const d = (f) => (s.derived.includes(f) ? ' <span class="derived">derived</span>' : '');
  return `<dl class="specs">
    <dt>material</dt><dd>${esc(sm.getMaterial(s.materialKey).name)}</dd>
    <dt>ends</dt><dd>${esc(sm.getEnds(s.endsKey).name)}${d('endsKey')}</dd>
    <dt>OD / ID</dt><dd>${L(s.od_mm)} / ${L(s.id_mm)}${d('id_mm')}</dd>
    <dt>wire</dt><dd>${L(s.wireDia_mm)}${d('wireDia_mm')}</dd>
    <dt>mean dia</dt><dd>${L(s.meanDia_mm)}, index C = ${nf(s.springIndex, 1)}</dd>
    <dt>free length</dt><dd>${L(s.freeLength_mm)}</dd>
    <dt>solid length</dt><dd>${L(s.solidLength_mm)}${d('solidLength_mm')}</dd>
    <dt>active coils</dt><dd>${nf(s.activeCoils, 1)}${d('activeCoils')}</dd>
    <dt>rate</dt><dd>${K(s.rate_Npmm)}${d('rate_Npmm')}</dd>
    <dt>travel to solid</dt><dd>${L(s.travelToSolid_mm)}</dd>
    <dt>usable travel</dt><dd>${L(s.usableTravel_mm)} <span class="derived">${esc(s.usableTravelSource || '')}</span></dd>
    <dt>max usable load</dt><dd>${F(s.maxUsableForce_N, { both: true })}</dd>
  </dl>`;
}

function workingList(ev) {
  const w = ev.working;
  if (!w) return '';
  const sen = w.sensitivity;
  return `<dl class="specs">
    <dt>force</dt><dd>${F(w.targetForce_N, { both: true })}</dd>
    <dt>compress by</dt><dd>${L(w.deflection_mm, { both: true })}</dd>
    <dt>installed length</dt><dd>${L(w.installedLength_mm, { both: true })}</dd>
    <dt>travel used</dt><dd>${pct(w.travelUsedFraction)} of usable, ${L(w.travelHeadroom_mm)} spare</dd>
    <dt>shear stress</dt><dd>${nf(w.tauStatic_MPa, 0)} MPa = ${pct(w.utilisation)} of allowable</dd>
    <dt>force you get</dt><dd>${F(sen.forceRange_N[0])} to ${F(sen.forceRange_N[1])}</dd>
    <dt></dt><dd class="muted">&plusmn;${pct(sen.worstCaseFraction)} worst case, &plusmn;${pct(sen.rssFraction)} RSS</dd>
    <dt>from position</dt><dd>${nf(sen.forceErrFromPosition_N, 3)} N per &plusmn;${L(sen.positionBand_mm)}</dd>
    <dt>from rate tol</dt><dd>${nf(sen.forceErrFromRate_N, 3)} N</dd>
  </dl>`;
}

function renderReport(s, ev) {
  const w = ev.working;
  const verdict = !w ? '' : !ev.feasible
    ? badge('bad', 'will not reach this force')
    : (w.travelUsedFraction ?? 0) > 0.95 ? badge('warn', 'works, no travel margin')
      : (w.travelUsedFraction ?? 0) > 0.75 ? badge('warn', 'works, tight on travel')
        : badge('ok', 'works');
  const notes = [...ev.warnings, ...(ev.feasible ? [] : ev.reasons)];
  const buck = ev.buckling
    ? (ev.buckling.unconditionallyStable
      ? 'Stable at any deflection &mdash; too stubby to buckle.'
      : `Buckles past ${L(ev.buckling.criticalDeflection_mm)} of deflection unless it runs in a bore or over a rod.`)
    : '';

  return `<div class="card">
    <h2>${esc(s.partNumber || s.label || 'Spring')} ${verdict}</h2>
    ${s.url ? `<p class="hint" style="margin-top:-8px"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></p>` : ''}
    <div class="cols">
      <div><h3 style="margin-top:0">The spring</h3>${specList(s)}</div>
      <div><h3 style="margin-top:0">At your working point</h3>${workingList(ev)}</div>
    </div>
    <div id="viz-slot"></div>
    ${buck ? `<p class="hint">${buck}</p>` : ''}
    ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

/* ------------------------------------------------------------- travel meter
 * A meter, not a chart: one span (free length down to solid), the working
 * point sitting somewhere along it. Fill colour carries severity.
 */
function travelMeter(s, ev) {
  const w = ev.working;
  if (s.freeLength_mm == null || s.solidLength_mm == null || !w) return '';
  const W = 720, H = 92, pad = 14;
  const x0 = pad, x1 = W - pad;
  const total = s.freeLength_mm;
  const px = (mm) => x0 + (mm / total) * (x1 - x0);
  const barY = 34, barH = 18, r = 4;

  const instX = px(w.installedLength_mm);
  const solidX = px(s.solidLength_mm);
  const usableX = s.minWorkingLength_mm != null ? px(s.minWorkingLength_mm) : null;
  const sev = severity(w.travelUsedFraction);
  const fillColor = `var(--${sev === 'ok' ? 'accent' : sev})`;

  // Track is the free spring; the fill is the part you compress away.
  return `<figure>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Travel from free length to solid, with the working point marked">
    <rect x="${x0}" y="${barY}" width="${x1 - x0}" height="${barH}" rx="${r}" fill="var(--accent-soft)"/>
    <rect x="${instX + 2}" y="${barY}" width="${Math.max(x1 - instX - 2, 0)}" height="${barH}" rx="${r}" fill="${fillColor}" opacity="0.85"/>
    <rect x="${x0}" y="${barY}" width="${Math.max(solidX - x0, 0)}" height="${barH}" rx="${r}" fill="var(--line)"/>
    ${usableX != null ? `<line x1="${usableX}" y1="${barY - 5}" x2="${usableX}" y2="${barY + barH + 5}" stroke="var(--warn)" stroke-width="1"/>` : ''}
    <line x1="${instX}" y1="${barY - 9}" x2="${instX}" y2="${barY + barH + 9}" stroke="var(--ink)" stroke-width="2"/>
    <circle cx="${instX}" cy="${barY + barH / 2}" r="5" fill="var(--ink)" stroke="var(--panel)" stroke-width="2"/>
    <text x="${x0}" y="${barY - 12}" font-size="11" fill="var(--muted)">solid ${esc(Lnum(s.solidLength_mm))}</text>
    <text x="${x1}" y="${barY - 12}" font-size="11" fill="var(--muted)" text-anchor="end">free ${esc(Lnum(s.freeLength_mm))}</text>
    <text x="${instX}" y="${barY + barH + 24}" font-size="12" fill="var(--ink)" text-anchor="${instX > W * 0.8 ? 'end' : instX < W * 0.2 ? 'start' : 'middle'}">
      installed ${esc(Lnum(w.installedLength_mm))} ${esc(Lunit())}
    </text>
  </svg>
  <figcaption>Grey is the coils stacked solid; shaded is the ${esc(L(w.deflection_mm))} you compress to reach
    ${esc(F(w.targetForce_N))}${usableX != null ? `; the amber rule is the end of usable travel` : ''}.</figcaption>
</figure>`;
}

/* --------------------------------------------------- force vs length chart */

function forceChart(s, ev) {
  const w = ev.working;
  if (s.freeLength_mm == null || !w) return null;
  const W = 720, H = 260;
  const m = { t: 16, r: 16, b: 52, l: 56 };
  const plotW = W - m.l - m.r, plotH = H - m.t - m.b;

  const xMin = s.solidLength_mm ?? s.freeLength_mm - (s.usableTravel_mm ?? 0);
  const xMax = s.freeLength_mm;
  const yMax = Math.max(s.rate_Npmm * (xMax - xMin), w.targetForce_N) * 1.08;
  const X = (mm) => m.l + ((mm - xMin) / (xMax - xMin)) * plotW;
  const Y = (n) => m.t + plotH - (n / yMax) * plotH;

  const ticks = (max, count) => {
    const step = Math.pow(10, Math.floor(Math.log10(max / count)));
    for (const mlt of [1, 2, 2.5, 5, 10]) if (max / (step * mlt) <= count) return { step: step * mlt };
    return { step };
  };
  const yStep = ticks(yMax, 5).step;
  const yTicks = []; for (let v = 0; v <= yMax; v += yStep) yTicks.push(v);
  const xStep = ticks(xMax - xMin, 5).step;
  const xTicks = []; for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax; v += xStep) xTicks.push(v);

  const sen = w.sensitivity;
  const bandLo = Y(Math.min(sen.forceRange_N[1], yMax));
  const bandHi = Y(sen.forceRange_N[0]);
  const usableX = s.minWorkingLength_mm != null ? X(s.minWorkingLength_mm) : null;

  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Force against installed length; the line is linear from free length down to solid">
    <g stroke="var(--line)" stroke-width="1">
      ${yTicks.map((v) => `<line x1="${m.l}" y1="${Y(v)}" x2="${W - m.r}" y2="${Y(v)}"/>`).join('')}
    </g>
    <g font-size="11" fill="var(--muted)" font-variant-numeric="tabular-nums">
      ${yTicks.map((v) => `<text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${nf(v, yStep < 1 ? 1 : 0)}</text>`).join('')}
      ${xTicks.map((v) => `<text x="${X(v)}" y="${H - 30}" text-anchor="middle">${Lnum(v)}</text>`).join('')}
      <text x="${m.l - 8}" y="${m.t - 4}" text-anchor="end">N</text>
      <text x="${m.l + plotW / 2}" y="${H - 10}" text-anchor="middle">installed length, ${Lunit()}</text>
    </g>
    ${usableX != null ? `<line x1="${usableX}" y1="${m.t}" x2="${usableX}" y2="${m.t + plotH}" stroke="var(--warn)" stroke-width="1"/>
      <text x="${usableX + (usableX < m.l + 130 ? 5 : -5)}" y="${m.t + 12}" font-size="11" fill="var(--muted)"
        text-anchor="${usableX < m.l + 130 ? 'start' : 'end'}">usable travel ends</text>` : ''}
    <rect x="${X(w.installedLength_mm) - 22}" y="${bandLo}" width="44" height="${Math.max(bandHi - bandLo, 1)}"
          fill="var(--accent)" opacity="0.10"/>
    <line x1="${X(xMax)}" y1="${Y(0)}" x2="${X(xMin)}" y2="${Y(s.rate_Npmm * (xMax - xMin))}"
          stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/>
    <circle cx="${X(w.installedLength_mm)}" cy="${Y(w.targetForce_N)}" r="5"
            fill="var(--accent)" stroke="var(--panel)" stroke-width="2"/>
    <text x="${X(w.installedLength_mm)}" y="${Y(w.targetForce_N) - 12}" font-size="12" fill="var(--ink)"
          text-anchor="${X(w.installedLength_mm) > W * 0.75 ? 'end' : 'middle'}">${F(w.targetForce_N)}</text>
    <g class="cross" opacity="0">
      <line y1="${m.t}" y2="${m.t + plotH}" stroke="var(--muted)" stroke-width="1"/>
      <circle r="5" fill="var(--ink)" stroke="var(--panel)" stroke-width="2"/>
    </g>
    <rect class="hit" x="${m.l}" y="${m.t}" width="${plotW}" height="${plotH}" fill="transparent"/>
  </svg>`;

  const fig = document.createElement('figure');
  fig.className = 'figwrap';
  fig.innerHTML = `${svg}<div class="tip" hidden></div>
    <figcaption>Drag across the plot to read the load at any length. Shaded band is the
      &plusmn;${pct(sen.worstCaseFraction)} you actually get once rate tolerance and
      &plusmn;${L(sen.positionBand_mm)} of assembly position are counted.</figcaption>`;

  // Crosshair readout -- the chart is a straight line, so the useful
  // interaction is "what do I get at this length", not per-point hover.
  const svgEl = fig.querySelector('svg');
  const cross = fig.querySelector('.cross');
  const tip = fig.querySelector('.tip');
  const move = (evt) => {
    const box = svgEl.getBoundingClientRect();
    const sx = ((evt.clientX - box.left) / box.width) * W;
    const clamped = Math.min(Math.max(sx, m.l), m.l + plotW);
    const mm = xMin + ((clamped - m.l) / plotW) * (xMax - xMin);
    const force = sm.forceAtLength(s.rate_Npmm, s.freeLength_mm, mm);
    cross.setAttribute('opacity', '1');
    cross.querySelector('line').setAttribute('x1', clamped);
    cross.querySelector('line').setAttribute('x2', clamped);
    cross.querySelector('circle').setAttribute('cx', clamped);
    cross.querySelector('circle').setAttribute('cy', Y(Math.min(force, yMax)));
    tip.hidden = false;
    tip.innerHTML = `<strong>${F(force)}</strong><br>${nf(sm.nToLbf(force), 3)} lbf &middot; ${nf(force / 0.00980665, 0)} gf<br>
      <span class="muted">at ${L(mm)}, compressed ${L(s.freeLength_mm - mm)}</span>`;
    tip.style.left = `${(clamped / W) * 100}%`;
    tip.style.top = `${(Y(Math.min(force, yMax)) / H) * 100}%`;
  };
  const leave = () => { cross.setAttribute('opacity', '0'); tip.hidden = true; };
  svgEl.addEventListener('pointermove', move);
  svgEl.addEventListener('pointerdown', move);
  svgEl.addEventListener('pointerleave', leave);
  return fig;
}

function mountViz(container, s, ev) {
  const slot = container.querySelector('#viz-slot');
  if (!slot || !ev.working) return;
  slot.innerHTML = travelMeter(s, ev);
  const chart = forceChart(s, ev);
  if (chart) slot.append(chart);
}

/* ------------------------------------------------------------- FIND tab */

function findRequirements() {
  return {
    targetForce_N: readForce('f-force', 'f-force-u'),
    minOD_mm: readLen('f-minod'),
    maxOD_mm: readLen('f-maxod'),
    minID_mm: readLen('f-minid'),
    maxID_mm: readLen('f-maxid'),
    minWireDia_mm: readLen('f-minwire'),
    maxWireDia_mm: readLen('f-maxwire'),
    minFreeLength_mm: readLen('f-minfree'),
    maxFreeLength_mm: readLen('f-maxfree'),
    maxInstalledLength_mm: readLen('f-maxinst'),
    maxSolidLength_mm: readLen('f-maxsolid'),
    minRate_Npmm: readRate('f-minrate'),
    maxRate_Npmm: readRate('f-maxrate'),
    minRatedLoad_N: readForce('f-minload', 'f-force-u'),
    minTemperature_C: readTemp('f-mintemp', 'f-temp-u'),
    straightOnly: $('f-shape').value === 'straight',
    ends: $('f-ends').value ? [$('f-ends').value] : null,
    families: $('f-family').value ? [$('f-family').value] : null,
    positionTol_mm: readLen('f-postol') ?? sm.inToMm(0.010),
    rateTol: (rawNum('f-ratetol') ?? 10) / 100,
    minDeflection_mm: readLen('f-mintravel'),
    maxTravelUsedFraction: (rawNum('f-maxtravel') ?? 100) / 100,
    materials: $('f-material').value ? [$('f-material').value] : null,
    sortBy: $('f-sort').value,
    includeRejected: $('f-showall').checked,
  };
}

function renderShopping(req) {
  const box = $('f-shopping');
  const F0 = req.targetForce_N;
  if (!F0) { box.innerHTML = ''; return; }

  // The rate window is pure F/x -- it needs no envelope at all. Geometry does,
  // so those columns only appear once a diameter is given.
  const xMin = sm.inToMm(0.05);
  const xMax = Math.min(sm.inToMm(0.5), req.maxFreeLength_mm ?? sm.inToMm(0.5));
  const hasOD = req.maxOD_mm != null;
  const ds = hasOD
    ? sm.designSpace({ targetForce_N: F0, maxOD_mm: req.maxOD_mm, deflectionRange_mm: [xMin, xMax], steps: 6 })
    : null;

  const points = ds ? ds.points : Array.from({ length: 6 }, (_, i) => {
    const x = xMin * Math.pow(xMax / xMin, i / 5);
    return { deflection_mm: x, rate_Npmm: F0 / x, options: [] };
  });
  const [kSoft, kStiff] = [F0 / xMax, F0 / xMin];

  const rows = points.map((p) => {
    const best = p.options[0];
    const band = (p.rate_Npmm * req.positionTol_mm + F0 * req.rateTol) / F0;
    return `<tr>
      <td class="num l">${Lnum(p.deflection_mm)}</td>
      <td class="num">${nf(sm.nPerMmToLbfPerIn(p.rate_Npmm), 2)}</td>
      <td class="num">${nf(p.rate_Npmm, 3)}</td>
      <td class="num">&plusmn;${pct(band)}</td>
      ${hasOD ? `<td class="num">${best ? nf(sm.mmToIn(best.wireDia_mm), 3) : '—'}</td>
      <td class="num">${best ? nf(best.activeCoils, 1) : '—'}</td>
      <td class="num">${best ? Lnum(best.minFreeLength_mm) : '—'}</td>` : ''}
    </tr>`;
  }).join('');

  box.innerHTML = `<h2>What to shop for</h2>
    <div class="callout">
      <p>For <strong>${F(F0)}</strong> (${nf(sm.nToLbf(F0), 3)} lbf, ${nf(F0 / 0.00980665, 0)} gf,
         ${nf(F0 / 0.2780138509, 1)} oz)${hasOD ? ` inside <strong>${L(req.maxOD_mm)}</strong> OD` : ''},
         filter the vendor's compression-spring table to this rate window:</p>
      <p class="big">${nf(sm.nPerMmToLbfPerIn(kSoft), 2)} &ndash; ${nf(sm.nPerMmToLbfPerIn(kStiff), 2)} lbf/in
        &nbsp;<span class="muted" style="font-size:13px">(${nf(kSoft, 3)} &ndash; ${nf(kStiff, 3)} N/mm)</span></p>
      <p class="muted" style="font-size:13px">Softer end puts the working load ${L(xMax)} down the travel,
        stiffer end ${L(xMin)}. Anything stiffer than that window and you are trying to hold a force
        with a few thou of travel.</p>
    </div>
    <div class="scroll"><table>
      <thead><tr><th class="l">compress by</th><th>rate lbf/in</th><th>rate N/mm</th><th>force band</th>
        ${hasOD ? `<th>wire in</th><th>coils</th><th>min free ${Lunit()}</th>` : ''}</tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="hint">${hasOD
      ? 'Right-hand columns are the leanest geometry that delivers each rate inside your OD — what a spring at that rate has to look like. Use it to sanity-check anything a vendor offers you.'
      : 'Give a maximum outside diameter under “narrow it down” and this also shows what a spring at each rate has to look like — wire size, coil count, shortest possible free length.'}</p>`;
}

function renderResults(req) {
  const box = $('f-results');
  if (!state.catalogue.length) {
    box.innerHTML = `<h2>Catalogue</h2>
      <div class="callout warn"><p>No spring data loaded yet. Paste a vendor table on the
        <button class="link" data-goto="catalog">Catalogue tab</button> and this becomes a real search.
        The rate window above works without it.</p></div>`;
    box.querySelector('[data-goto]').addEventListener('click', () =>
      document.querySelector('nav.tabs button[data-tab="catalog"]').click());
    $('f-detail').innerHTML = '';
    return;
  }
  const hits = sm.searchCatalog(state.catalogue, req);
  state.results = hits;
  const okCount = hits.filter((h) => h.ok).length;

  const shown = buildTable(box, {
    columns: FIND_COLUMNS,
    rows: hits,
    tState: state.find,
    prefix: 'f',
    cap: MAX_RESULT_ROWS,
    rowKey: (h) => springKey(h.spring),
    rowClass: (h) => (h.ok ? '' : 'rejected'),
    expand: (h) => notesExpand(h.spring),
    onRowClick: (h) => showDetail(h),
    header: `<h2>${okCount} of ${state.catalogue.length} springs can deliver ${F(req.targetForce_N)}</h2>
      <p class="hint" style="margin-top:-6px">Ranked by &ldquo;${esc($('f-sort').selectedOptions[0].textContent)}&rdquo;.
        Click a row for the full working-point report below. &ldquo;Force band&rdquo; is what you actually get
        once rate tolerance and assembly position error are counted &mdash; the reason a softer spring
        compressed further beats a stiff one nudged slightly.</p>
      ${tableHelpHtml('f', hits.length)}`,
  });

  if (shown.length) {
    const first = box.querySelector('#f-rows tr[data-i]');
    if (first) first.classList.add('sel');
    showDetail(shown[0]);
  } else {
    $('f-detail').innerHTML = '';
  }
}

function showDetail(h) {
  if (!h) return;
  state.selected = h;
  const holder = $('f-detail');
  holder.innerHTML = renderReport(h.spring, h.evaluation);
  mountViz(holder, h.spring, h.evaluation);
}

/** Live restatement of the force in the units people actually quote springs in. */
function renderEquivalents() {
  const N = readForce('f-force', 'f-force-u');
  $('f-equiv').textContent = N
    ? `= ${nf(N, 3)} N  ·  ${nf(sm.nToLbf(N), 4)} lbf  ·  ${nf(N / 0.00980665, 1)} gf  ·  ${nf(N / 0.2780138509, 2)} oz`
    : '';
}

function runFind() {
  refreshUnitLabels();
  const req = findRequirements();
  renderEquivalents();
  if (!req.targetForce_N) {
    $('f-shopping').innerHTML = `<h2>What to shop for</h2>
      <p class="muted">Put in the force you need and this fills in — the spring-rate window to
        filter a vendor's table by, and every catalogue spring that can deliver it.</p>`;
    $('f-results').innerHTML = '';
    $('f-detail').innerHTML = '';
    return;
  }
  renderShopping(req);
  renderResults(req);
}
/* --------------------------------------------------- natural language ---
 * The phrase drives the same form the fields do, so what it did is visible
 * and adjustable rather than hidden behind a black box.
 */
/** Optional controls, so one place knows how to clear them all. */
const OPTIONAL_NUMBERS = ['f-minod', 'f-maxod', 'f-minid', 'f-maxid', 'f-minwire', 'f-maxwire',
  'f-minfree', 'f-maxfree', 'f-maxinst', 'f-maxsolid', 'f-minrate', 'f-maxrate', 'f-minload',
  'f-mintravel', 'f-maxtravel', 'f-mintemp', 'f-postol', 'f-ratetol'];
const OPTIONAL_SELECTS = { 'f-material': '', 'f-ends': '', 'f-shape': '', 'f-family': '', 'f-sort': 'robustness' };

/**
 * Inputs whose meaning depends on the length unit. With one diameter box the
 * old behaviour -- reinterpret on toggle -- was survivable; across twenty
 * boxes it silently changes every constraint, so values are converted.
 */
const LENGTH_INPUTS = ['f-minod', 'f-maxod', 'f-minid', 'f-maxid', 'f-minwire', 'f-maxwire',
  'f-minfree', 'f-maxfree', 'f-maxinst', 'f-maxsolid', 'f-mintravel', 'f-postol',
  'a-od', 'a-id', 'a-wire', 'a-free', 'a-maxdefl', 'a-at', 'a-postol'];
const RATE_INPUTS = ['f-minrate', 'f-maxrate', 'a-rate'];
const ANALYSE_FORCE_INPUTS = ['a-maxload'];

/** Switch display units, carrying every typed value across with them. */
function setLengthUnit(next) {
  if (!next || next === state.lengthUnit) return;
  const toIn = next === 'in';
  const move = (ids, convert) => ids.forEach((id) => {
    const el = $(id);
    if (!el || el.value.trim() === '') return;
    const v = Number(el.value);
    if (!Number.isFinite(v)) return;
    el.value = String(+convert(v).toFixed(6));
  });
  move(LENGTH_INPUTS, (v) => (toIn ? sm.mmToIn(v) : sm.inToMm(v)));
  move(RATE_INPUTS, (v) => (toIn ? sm.nPerMmToLbfPerIn(v) : sm.lbfPerInToNPerMm(v)));
  move(ANALYSE_FORCE_INPUTS, (v) => (toIn ? sm.nToLbf(v) : sm.lbfToN(v)));
  state.lengthUnit = next;
  $('f-len-u').value = next;
  $('a-units').value = next;
  refreshUnitLabels();
  // The catalogue's headings and every numeric cell are unit-dependent.
  renderCatalogue();
}

function clearFilters() {
  OPTIONAL_NUMBERS.forEach((id) => { $(id).value = ''; });
  Object.entries(OPTIONAL_SELECTS).forEach(([id, v]) => { $(id).value = v; });
}

/** Parsed field -> the form control it fills. */
const NL_FIELDS = {
  minOD_mm: 'f-minod', maxOD_mm: 'f-maxod',
  minID_mm: 'f-minid', maxID_mm: 'f-maxid',
  minWireDia_mm: 'f-minwire', maxWireDia_mm: 'f-maxwire',
  minFreeLength_mm: 'f-minfree', maxFreeLength_mm: 'f-maxfree',
  maxInstalledLength_mm: 'f-maxinst', maxSolidLength_mm: 'f-maxsolid',
  minDeflection_mm: 'f-mintravel',
};
const NL_LABELS = {
  force: 'force', maxOD: 'max OD', minID: 'clears a rod of', maxFreeLength: 'max free length',
  maxInstalledLength: 'max installed length', maxSolidLength: 'max solid length',
  minDeflection: 'compress at least', maxID: 'max ID', minOD: 'min OD',
  minWireDia: 'min wire', maxWireDia: 'max wire',
  minRate: 'min rate', maxRate: 'max rate',
  material: 'material', ends: 'end type', sortBy: 'rank by',
};

function applyParse(res) {
  // A new phrase replaces the old one; stale filters left behind would
  // silently narrow a search the words never asked to narrow.
  clearFilters();

  // Filters were just cleared, so nothing of the phrase's is converted; this
  // only carries the Analyse tab's numbers across.
  setLengthUnit(res.lengthUnit);
  const f = res.fields;
  const disp = (mm) => (state.lengthUnit === 'in' ? sm.mmToIn(mm) : mm);
  if (f.force_N != null) {
    $('f-force-u').value = f.forceUnit || 'N';
    $('f-force').value = String(+(f.forceValue ?? sm.nToLbf(f.force_N)).toFixed(6));
  }
  for (const [key, id] of Object.entries(NL_FIELDS)) {
    if (f[key] != null) $(id).value = String(+disp(f[key]).toFixed(4));
  }
  if (f.minRate_Npmm != null) $('f-minrate').value = String(+(state.lengthUnit === 'in' ? sm.nPerMmToLbfPerIn(f.minRate_Npmm) : f.minRate_Npmm).toFixed(4));
  if (f.maxRate_Npmm != null) $('f-maxrate').value = String(+(state.lengthUnit === 'in' ? sm.nPerMmToLbfPerIn(f.maxRate_Npmm) : f.maxRate_Npmm).toFixed(4));
  if (f.materialKey) $('f-material').value = f.materialKey;
  if (f.endsKey) $('f-ends').value = f.endsKey;
  if (f.sortBy) $('f-sort').value = f.sortBy;
  // Show the filters it set, so nothing is applied out of sight.
  if (Object.keys(f).some((k) => k !== 'force_N' && k !== 'forceUnit' && k !== 'forceValue')) {
    $('f-more').open = true;
  }
}

function renderParse(res) {
  const box = $('f-nl-out');
  if (res.empty) { box.innerHTML = ''; return; }
  if (!res.read.length) {
    box.innerHTML = `<div class="callout warn"><p>Nothing in that could be turned into a search.
      Try something like <em>1.5N in a half inch bore</em> — a force, and any limits that matter.</p></div>`;
    return;
  }
  const chips = res.read.map((r) => `<span class="chip"><b>${esc(NL_LABELS[r.field] || r.field)}</b>
    <span>${esc(r.value)}</span></span>`).join('');
  const misses = res.unparsed.map((u) => `<span class="chip miss"><b>skipped</b>
    <span>${esc(u.from)}</span></span>`).join('');
  const why = res.unparsed.length
    ? `<p class="hint">${res.unparsed.map((u) => `<strong>${esc(u.from)}</strong> — ${esc(u.why)}`).join('<br>')}</p>`
    : '';
  const notes = res.read.filter((r) => r.note);
  box.innerHTML = `<div class="chips">${chips}${misses}</div>${why}
    ${notes.length ? `<p class="hint">${notes.map((n) => `<strong>${esc(n.from)}</strong> — ${esc(n.note)}`).join('<br>')}</p>` : ''}`;
}

function runNaturalLanguage() {
  const res = nlq.parseQuery($('f-nl').value, { defaultForceUnit: $('f-force-u').value });
  renderParse(res);
  if (res.empty || !res.read.length) return;
  applyParse(res);
  runFind();
}
$('f-nl-run').addEventListener('click', runNaturalLanguage);
$('f-nl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runNaturalLanguage(); } });

$('f-reset').addEventListener('click', () => { clearFilters(); $('f-nl').value = ''; $('f-nl-out').innerHTML = ''; runFind(); });
$('f-run').addEventListener('click', runFind);
$('f-len-u').addEventListener('change', () => { setLengthUnit($('f-len-u').value); runFind(); runAnalyse(); });
document.querySelectorAll('#tab-find input, #tab-find select').forEach((x) =>
  x.addEventListener('keydown', (e) => { if (e.key === 'Enter') runFind(); }));
$('f-force').addEventListener('input', renderEquivalents);
$('f-force-u').addEventListener('change', () => { renderEquivalents(); refreshUnitLabels(); });

/* ---------------------------------------------------------- ANALYSE tab */

function analyseSpring() {
  return cat.springFromForm({
    partNumber: $('a-part').value || null,
    lengthUnit: state.lengthUnit,
    rateUnit: state.lengthUnit === 'in' ? 'lbf/in' : 'N/mm',
    forceUnit: state.lengthUnit === 'in' ? 'lbf' : 'N',
    od: $('a-od').value, id: $('a-id').value, wireDia: $('a-wire').value,
    freeLength: $('a-free').value, rate: $('a-rate').value,
    totalCoils: $('a-coils').value, maxLoad: $('a-maxload').value,
    maxDeflection: $('a-maxdefl').value,
    materialKey: $('a-material').value, endsKey: $('a-ends').value,
  });
}

function runAnalyse() {
  const out = $('a-out');
  const untouched = ['a-od', 'a-id', 'a-wire', 'a-free', 'a-rate', 'a-coils']
    .every((id) => $(id).value.trim() === '');
  if (untouched) {
    out.innerHTML = `<div class="card"><p class="muted">Type in what the vendor lists for a spring
      you already have — outside diameter, wire diameter, free length, and either a spring rate or a
      coil count. Anything else is worked out for you.</p></div>`;
    return;
  }
  const s = analyseSpring();
  if (s.incomplete) {
    out.innerHTML = `<div class="card"><div class="callout bad"><p>Not enough to work with &mdash; missing
      ${esc(s.missing.join(', '))}. A rate or a coil count will do for the rate.</p></div></div>`;
    return;
  }
  const atLength = readLen('a-at');
  const targetForce_N = atLength != null
    ? sm.forceAtLength(s.rate_Npmm, s.freeLength_mm, atLength)
    : readForce('a-force', 'a-force-u');

  const ev = sm.evaluate(s, {
    targetForce_N,
    positionTol_mm: readLen('a-postol') ?? 0.25,
    rateTol: (rawNum('a-ratetol') ?? 10) / 100,
    endCondition: $('a-endcond').value,
  });
  out.innerHTML = renderReport(s, ev);
  mountViz(out, s, ev);
  if (atLength != null) {
    out.querySelector('.card').insertAdjacentHTML('afterbegin',
      `<div class="callout"><p>Held at ${L(atLength, { both: true })} this spring pushes
        <span class="big">${F(targetForce_N)}</span> &nbsp;<span class="muted">${nf(sm.nToLbf(targetForce_N), 3)} lbf
        &middot; ${nf(targetForce_N / 0.00980665, 0)} gf</span></p></div>`);
  }
}
$('a-run').addEventListener('click', runAnalyse);
$('a-units').addEventListener('change', () => { setLengthUnit($('a-units').value); runAnalyse(); runFind(); });
$('a-save').addEventListener('click', () => {
  const s = analyseSpring();
  if (s.incomplete) { runAnalyse(); return; }
  state.local.push(s); saveStore(); rebuildCatalogue(); renderCatalogue();
  $('a-out').insertAdjacentHTML('afterbegin',
    `<div class="callout"><p>Added to the catalogue (${state.catalogue.length} springs).</p></div>`);
});

/* ---------------------------------------------------- sortable tables ----
 * The Catalogue and the search results are the same thing: a wide table of
 * springs, every column sortable and filterable. One implementation, two
 * column sets. Header and filter row are built once and only the body is
 * redrawn, so typing in a filter never loses focus.
 *
 * Both read in the units the vendor published rather than the working units
 * chosen elsewhere -- these are lists of parts, and they should match the
 * source they came from.
 */

function catalogueUnits() {
  const seen = new Set(state.catalogue.map((s) => s.sourceUnits || state.lengthUnit));
  return seen.size === 1 ? [...seen][0] : state.lengthUnit;
}

/** A numeric column's value, in the units the table is showing. */
function colValue(col, row) {
  if (col.kind !== 'num') return null;
  const raw = col.num(row);
  if (raw == null || !Number.isFinite(raw)) return null;
  const us = state.catUnits === 'in';
  if (col.unit === 'length') return us ? sm.mmToIn(raw) : raw;
  if (col.unit === 'rate') return us ? sm.nPerMmToLbfPerIn(raw) : raw;
  if (col.unit === 'force') return us ? sm.nToLbf(raw) : raw;
  if (col.unit === 'temp') return us ? raw * 9 / 5 + 32 : raw;
  return raw;
}
function colDecimals(col) {
  if (col.dp != null) return col.dp;
  const us = state.catUnits === 'in';
  if (col.unit === 'length') return us ? 3 : 2;
  if (col.unit === 'rate') return us ? 2 : 4;
  if (col.unit === 'force') return us ? 2 : 3;
  if (col.unit === 'temp') return 0;
  return 2;
}
function colUnitLabel(col) {
  const us = state.catUnits === 'in';
  if (col.unit === 'length') return us ? 'in' : 'mm';
  if (col.unit === 'rate') return us ? 'lbf/in' : 'N/mm';
  if (col.unit === 'force') return us ? 'lb' : 'N';
  if (col.unit === 'temp') return us ? '°F' : '°C';
  return '';
}
/** Sorting uses the stored SI value, so a mixed-unit list still orders right. */
function colSortValue(col, row) {
  if (col.kind !== 'num') return null;
  const raw = col.num(row);
  return raw == null || !Number.isFinite(raw) ? null : raw;
}
function colText(col, row) {
  if (col.kind !== 'num') return col.text(row);
  const v = colValue(col, row);
  return v == null ? '' : nf(v, colDecimals(col)) + (col.suffix || '');
}

/** Was this cell worked out rather than read from the vendor? */
function isDerived(col, row) {
  if (col.alwaysDerived) return true;
  if (!col.derivedKey) return false;
  const spring = col.spring ? col.spring(row) : row;
  const keys = Array.isArray(col.derivedKey) ? col.derivedKey : [col.derivedKey];
  return keys.some((k) => (spring.derived || []).includes(k));
}

/**
 * How to label a column's heading. "derived" only when it is true of every
 * row that has a value -- a blanket label on a mixed column would be false.
 */
function derivedLabel(col, rows) {
  if (col.alwaysDerived) return { text: 'derived', title: 'Always worked out by the calculator.' };
  if (!col.derivedKey || !rows.length) return null;
  let withValue = 0;
  let derived = 0;
  for (const r of rows) {
    if (colText(col, r) === '') continue;
    withValue++;
    if (isDerived(col, r)) derived++;
  }
  if (!derived) return null;
  return derived === withValue
    ? { text: 'derived', title: `Worked out by the calculator for all ${withValue} of these.` }
    : { text: 'some derived', title: `Worked out by the calculator for ${derived} of ${withValue}; the rest are as published.` };
}

/**
 * Filters take plain text anywhere, and comparisons on numeric columns:
 * ">2", "<=0.5", "1..3", "1-3". Anything else is a substring match on what
 * the cell actually shows, which is the behaviour people expect.
 */
function makeFilter(col, expr) {
  const t = String(expr || '').trim();
  if (!t) return null;
  if (col.kind === 'select') return (r) => colText(col, r) === t;
  if (col.kind === 'num') {
    let m = t.match(/^(>=|<=|>|<|=)\s*(-?[\d.]+)$/);
    if (m) {
      const v = parseFloat(m[2]);
      const ops = { '>': (x) => x > v, '<': (x) => x < v, '>=': (x) => x >= v, '<=': (x) => x <= v, '=': (x) => x === v };
      return (r) => { const x = colValue(col, r); return x != null && ops[m[1]](x); };
    }
    m = t.match(/^(-?[\d.]+)\s*(?:\.\.|-|to)\s*(-?[\d.]+)$/);
    if (m) {
      const a = Math.min(parseFloat(m[1]), parseFloat(m[2]));
      const b = Math.max(parseFloat(m[1]), parseFloat(m[2]));
      return (r) => { const x = colValue(col, r); return x != null && x >= a && x <= b; };
    }
  }
  const needle = t.toLowerCase();
  return (r) => colText(col, r).toLowerCase().includes(needle);
}

function applyFiltersAndSort(rows, columns, tState) {
  const active = columns
    .map((col) => [col, makeFilter(col, tState.filters[col.key])])
    .filter(([, f]) => f);
  let list = active.length ? rows.filter((r) => active.every(([, f]) => f(r))) : rows.slice();

  if (tState.sort.key) {
    const col = columns.find((c) => c.key === tState.sort.key);
    const dir = tState.sort.dir === 'desc' ? -1 : 1;
    list.sort((a, b) => {
      if (col.kind === 'num') {
        const x = colSortValue(col, a);
        const y = colSortValue(col, b);
        // A blank is never "smallest" -- unknowns sort last either way.
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x - y) * dir;
      }
      return colText(col, a).localeCompare(colText(col, b), undefined, { numeric: true }) * dir;
    });
  }
  return list;
}

/**
 * Build a table into `box` and keep it live. `spec` supplies the columns, the
 * rows, and the per-table extras; only the tbody is rebuilt on sort/filter.
 */
function buildTable(box, spec) {
  const { columns, rows, tState, prefix, trailing, expand, rowKey, rowClass, onRowClick, cap } = spec;
  state.catUnits = catalogueUnits();

  const options = {};
  columns.filter((c) => c.kind === 'select').forEach((col) => {
    options[col.key] = [...new Set(rows.map((r) => colText(col, r)).filter(Boolean))].sort();
  });

  const heads = columns.map((col) => {
    const unit = colUnitLabel(col);
    const der = derivedLabel(col, rows);
    return `<th class="${col.align === 'l' || col.kind !== 'num' ? 'l' : ''}" data-col="${col.key}" aria-sort="none">
      <button class="sortable" data-sort="${col.key}"${der ? ` title="${esc(der.title)}"` : ''}>${esc(col.label)}${
        unit ? ` <span class="u">${esc(unit)}</span>` : ''}${
        der ? ` <span class="derived">${der.text}</span>` : ''}<span class="caret"></span></button>
    </th>`;
  }).join('');

  const filters = columns.map((col) => {
    if (col.kind === 'select') {
      return `<th class="l"><select data-filter="${col.key}"><option value="">any</option>${
        options[col.key].map((o) => `<option${o === tState.filters[col.key] ? ' selected' : ''}>${esc(o)}</option>`).join('')
      }</select></th>`;
    }
    return `<th class="l"><input data-filter="${col.key}" value="${esc(tState.filters[col.key] || '')}"
      placeholder="${col.kind === 'num' ? '>2, 1..3' : 'contains'}"></th>`;
  }).join('');

  const trail = (trailing || []).map(() => '<th class="l"></th>').join('');
  box.innerHTML = `${spec.header || ''}
    <div class="scroll cat-scroll"><table class="cat">
      <thead><tr>${heads}${trail}</tr><tr class="filters">${filters}${trail}</tr></thead>
      <tbody id="${prefix}-rows"></tbody></table></div>${spec.footer || ''}`;

  const span = columns.length + (trailing || []).length;
  const refresh = () => {
    state.catUnits = catalogueUnits();
    const list = applyFiltersAndSort(rows, columns, tState);
    const shown = cap ? list.slice(0, cap) : list;
    document.getElementById(`${prefix}-rows`).innerHTML = shown.map((r, i) => `<tr data-i="${i}"
      class="${rowClass ? rowClass(r) : ''}">
      ${columns.map((col) => `<td class="${col.align === 'l' || col.kind !== 'num' ? 'l' : 'num'}">${
        col.html ? col.html(r) : esc(colText(col, r))}</td>`).join('')}
      ${(trailing || []).map((t) => `<td class="l">${t.html(r)}</td>`).join('')}
    </tr>${expand && expand(r) ? `<tr class="notes-row" data-for="${esc(rowKey(r))}" hidden>
      <td class="l" colspan="${span}">${expand(r)}</td></tr>` : ''}`).join('');

    const countEl = document.getElementById(`${prefix}-count`);
    if (countEl) {
      countEl.textContent = list.length === rows.length ? `all ${rows.length}` : `${list.length} of ${rows.length}`;
    }
    const capEl = document.getElementById(`${prefix}-capnote`);
    if (capEl) {
      capEl.innerHTML = list.length > shown.length
        ? `Drawing the top ${shown.length}; narrow the filters to see the rest.` : '';
    }
    columns.forEach((col) => {
      const th = box.querySelector(`th[data-col="${col.key}"]`);
      if (th) th.setAttribute('aria-sort',
        tState.sort.key === col.key ? (tState.sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');
    });
    wireRowButtons(box);
    if (onRowClick) {
      box.querySelectorAll(`#${prefix}-rows tr[data-i]`).forEach((tr) => tr.addEventListener('click', (e) => {
        if (e.target.closest('button, a')) return;
        box.querySelectorAll('tr[data-i]').forEach((x) => x.classList.remove('sel'));
        tr.classList.add('sel');
        onRowClick(shown[Number(tr.dataset.i)], Number(tr.dataset.i));
      }));
    }
    return shown;
  };

  box.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.sort;
    tState.sort = tState.sort.key === key
      ? { key, dir: tState.sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' };
    refresh();
  }));
  box.querySelectorAll('[data-filter]').forEach((el) => {
    const run = () => { tState.filters[el.dataset.filter] = el.value; refresh(); };
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', run);
  });
  const clear = document.getElementById(`${prefix}-clearfilters`);
  if (clear) clear.addEventListener('click', () => {
    tState.filters = {};
    box.querySelectorAll('[data-filter]').forEach((el) => { el.value = ''; });
    refresh();
  });
  return refresh();
}

function wireRowButtons(box) {
  box.querySelectorAll('[data-notes]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = box.querySelector(`.notes-row[data-for="${CSS.escape(b.dataset.notes)}"]`);
    if (!target) return;
    target.hidden = !target.hidden;
    b.setAttribute('aria-expanded', String(!target.hidden));
  }));
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const key = b.dataset.del;
    // A shipped spring is not ours to delete -- hide it for this browser only.
    if (b.dataset.origin === 'shared') state.hidden.add(key);
    else state.local = state.local.filter((x) => springKey(x) !== key);
    saveStore(); rebuildCatalogue(); renderCatalogue();
  }));
}

/* ------------------------------------------------------- the column sets */

const notesCell = (s) => (s.incomplete
  ? badge('bad', 'incomplete')
  : s.warnings.length
    ? `<button class="pill warn as-button" data-notes="${esc(springKey(s))}"
         aria-expanded="false">${s.warnings.length} note${s.warnings.length === 1 ? '' : 's'}</button>`
    : '');
const notesExpand = (s) => (s.warnings.length
  ? `<ul class="notes">${s.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : null);

/** Columns describing the spring itself. `pick` maps a row to its spring. */
function springColumns(pick) {
  const p = pick || ((r) => r);
  const col = (o) => ({ ...o, spring: p });
  return [
    col({ key: 'part', label: 'part', kind: 'text', align: 'l',
      text: (r) => springName(p(r)),
      html: (r) => (p(r).url
        ? `<a href="${esc(p(r).url)}" target="_blank" rel="noopener">${esc(springName(p(r)))}</a>`
        : esc(springName(p(r)))) }),
    col({ key: 'family', label: 'family', kind: 'select', align: 'l', text: (r) => p(r).family || '' }),
    col({ key: 'material', label: 'material', kind: 'select', align: 'l',
      derivedKey: 'materialKey', text: (r) => p(r).material || '' }),
    col({ key: 'ends', label: 'ends', kind: 'select', align: 'l',
      text: (r) => p(r).ends || (p(r).endsKey ? sm.getEnds(p(r).endsKey).name : '') }),
    col({ key: 'od', label: 'OD', unit: 'length', kind: 'num', num: (r) => p(r).od_mm }),
    col({ key: 'id', label: 'ID', unit: 'length', kind: 'num', derivedKey: 'id_mm', num: (r) => p(r).id_mm }),
    col({ key: 'wire', label: 'wire', unit: 'length', kind: 'num', derivedKey: 'wireDia_mm', num: (r) => p(r).wireDia_mm }),
    col({ key: 'free', label: 'free lg', unit: 'length', kind: 'num', num: (r) => p(r).freeLength_mm }),
    col({ key: 'solid', label: 'solid lg', unit: 'length', kind: 'num',
      derivedKey: 'solidLength_mm', num: (r) => p(r).solidLength_mm }),
    col({ key: 'atload', label: 'lg at max load', unit: 'length', kind: 'num', num: (r) => p(r).lengthAtMaxLoad_mm }),
    col({ key: 'travel', label: 'usable travel', unit: 'length', kind: 'num',
      derivedKey: ['usableTravel_mm', 'maxDeflection_mm'], num: (r) => p(r).usableTravel_mm }),
    col({ key: 'rate', label: 'rate', unit: 'rate', kind: 'num', derivedKey: 'rate_Npmm', num: (r) => p(r).rate_Npmm }),
    col({ key: 'ratetol', label: 'rate tol', kind: 'num', dp: 1, suffix: '%',
      num: (r) => (p(r).rateTol == null ? null : p(r).rateTol * 100) }),
    col({ key: 'maxload', label: 'vendor max load', unit: 'force', kind: 'num', num: (r) => p(r).maxLoad_N }),
    col({ key: 'maxusable', label: 'max usable load', unit: 'force', kind: 'num',
      alwaysDerived: true, num: (r) => p(r).maxUsableForce_N }),
    col({ key: 'coils', label: 'total coils', kind: 'num', dp: 1, derivedKey: 'totalCoils', num: (r) => p(r).totalCoils }),
    col({ key: 'index', label: 'index C', kind: 'num', dp: 1, alwaysDerived: true, num: (r) => p(r).springIndex }),
    col({ key: 'temp', label: 'max temp', unit: 'temp', kind: 'num', num: (r) => p(r).maxTemp_C }),
    col({ key: 'milspec', label: 'mil spec', kind: 'text', align: 'l', text: (r) => p(r).milSpec || '' }),
    col({ key: 'colour', label: 'colour', kind: 'select', align: 'l', text: (r) => p(r).colour || '' }),
    col({ key: 'pkg', label: 'pkg qty', kind: 'num', dp: 0, num: (r) => p(r).pkgQty }),
    col({ key: 'price', label: 'price/pkg', kind: 'num', dp: 2,
      num: (r) => (p(r).price == null ? null : parseFloat(String(p(r).price).replace(/[^0-9.]/g, ''))) }),
    col({ key: 'notes', label: 'notes', kind: 'num', dp: 0, align: 'l',
      num: (r) => p(r).warnings.length, html: (r) => notesCell(p(r)) }),
  ];
}

const CAT_COLUMNS = [
  { key: 'source', label: 'source', kind: 'select', align: 'l',
    text: (s) => (s._origin === 'shared' ? 'shipped' : 'yours'),
    html: (s) => (s._origin === 'shared' ? badge('ok', 'shipped') : badge('warn', 'yours')) },
  ...springColumns(),
];

/** The search results: the working point first, then the spring itself. */
const FIND_COLUMNS = [
  { key: 'fits', label: 'fits', kind: 'select', align: 'l',
    text: (h) => (h.ok ? (severity(h.evaluation.working?.travelUsedFraction) === 'ok' ? 'fits'
      : severity(h.evaluation.working?.travelUsedFraction) === 'warn' ? 'tight' : 'at limit') : 'no'),
    html: (h) => {
      const sev = severity(h.evaluation.working?.travelUsedFraction);
      return h.ok ? badge(sev, sev === 'ok' ? 'fits' : sev === 'warn' ? 'tight' : 'at limit') : badge('bad', 'no');
    } },
  { key: 'compress', label: 'compress by', unit: 'length', kind: 'num', alwaysDerived: true,
    num: (h) => h.evaluation.working?.deflection_mm },
  { key: 'installed', label: 'installed lg', unit: 'length', kind: 'num', alwaysDerived: true,
    num: (h) => h.evaluation.working?.installedLength_mm },
  { key: 'used', label: 'travel used', kind: 'num', dp: 0, suffix: '%', alwaysDerived: true,
    num: (h) => (h.evaluation.working?.travelUsedFraction == null ? null : h.evaluation.working.travelUsedFraction * 100) },
  { key: 'band', label: 'force band ±', kind: 'num', dp: 0, suffix: '%', alwaysDerived: true,
    num: (h) => (h.evaluation.working?.sensitivity == null ? null : h.evaluation.working.sensitivity.worstCaseFraction * 100) },
  { key: 'stress', label: 'stress', kind: 'num', dp: 0, suffix: '%', alwaysDerived: true,
    num: (h) => (h.evaluation.working?.utilisation == null ? null : h.evaluation.working.utilisation * 100) },
  ...springColumns((h) => h.spring),
  { key: 'why', label: 'why not', kind: 'text', align: 'l', text: (h) => (h.ok ? '' : h.rejected[0] || '') },
];

/* --------------------------------------------------------- the catalogue */

function renderCatalogue() {
  $('c-restore').hidden = state.hidden.size === 0;
  if ($('tab-catalog').hidden) { state.catalogueStale = true; return; }
  state.catalogueStale = false;
  drawCatalogue();
}

function drawCatalogue() {
  const box = $('c-list');
  state.catUnits = catalogueUnits();
  const shipped = state.catalogue.filter((x) => x._origin === 'shared').length;
  const mine = state.catalogue.filter((x) => x._origin === 'local').length;
  const warn = state.storeError ? `<div class="callout bad"><p>${esc(state.storeError)}</p></div>` : '';
  const hiddenNote = state.hidden.size
    ? `<p class="hint">${state.hidden.size} shipped spring${state.hidden.size === 1 ? '' : 's'} hidden on this browser.</p>` : '';

  if (!state.catalogue.length) {
    box.innerHTML = `<h2>Loaded springs</h2>${warn}
      <p class="muted">Nothing loaded yet. Paste a vendor table above, or open a saved .json file.</p>${hiddenNote}`;
    return;
  }

  buildTable(box, {
    columns: CAT_COLUMNS,
    rows: state.catalogue,
    tState: state.cat,
    prefix: 'c',
    rowKey: (s) => springKey(s),
    expand: notesExpand,
    trailing: [{ html: (s) => `<button class="link" data-del="${esc(springKey(s))}" data-origin="${s._origin}">remove</button>` }],
    header: `<h2>Loaded springs (${state.catalogue.length})</h2>${warn}
      <p class="hint" style="margin-top:-6px">${shipped} shipped with the site &mdash; everyone who opens
        it sees these. ${mine} added on this browser only.
        ${state.catalogue.filter((x) => x.warnings.length).length} carry notes &mdash; things worth knowing
        about a spring, not faults. Click a note badge to read them.</p>
      ${tableHelpHtml('c', state.catalogue.length)}`,
    footer: hiddenNote,
  });
}

/** The shared explainer above both tables. */
function tableHelpHtml(prefix, total) {
  return `<p class="hint">Shown in the units the vendor publishes
    (${state.catUnits === 'in' ? 'inches, pounds, lbf/in, &deg;F' : 'mm, newtons, N/mm, &deg;C'}), whatever
    the working units are set to elsewhere. A heading marked
    <span class="derived">derived</span> is worked out by the calculator; everything else is as published.
    <br>Click any heading to sort. The row under the headings filters: type text to match, or a comparison
    on a number column &mdash; <code>&gt;2</code>, <code>&lt;=0.5</code>, <code>1..3</code>.
    Showing <strong id="${prefix}-count">all ${total}</strong>.
    <button class="link" id="${prefix}-clearfilters">clear table filters</button>
    <span id="${prefix}-capnote"></span></p>`;
}

function importText(text, { vendor, us }) {
  const res = cat.importAny(text, {
    vendor,
    partNumber: $('c-part').value.trim() || null,
    lengthUnit: us ? 'in' : 'mm',
    rateUnit: us ? 'lbf/in' : 'N/mm',
    forceUnit: us ? 'lbf' : 'N',
    urlTemplate: /mcmaster/i.test(vendor) ? 'https://www.mcmaster.com/{part}/' : null,
  });
  if (res.error) {
    $('c-status').innerHTML = `<div class="callout bad"><p>${esc(res.error)}</p>
      <p class="muted" style="font-size:12px">Paste either a catalogue table including its header row,
        or a product page's specification list.</p></div>`;
    return;
  }
  addLocal(res.springs);
  renderImportReview(res, res.springs);
  if (res.springs.length) $('c-part').value = '';
}

$('c-import').addEventListener('click', () =>
  importText($('c-paste').value, { vendor: $('c-vendor').value, us: $('c-units').value === 'us' }));

$('c-file').addEventListener('click', () => $('c-fileinput').click());
$('c-fileinput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  if (file.name.endsWith('.json')) {
    try {
      const springs = cat.fromCatalogJson(text);
      addLocal(springs);
      $('c-status').innerHTML = `<div class="callout"><p>Loaded ${springs.length} springs from ${esc(file.name)}.</p></div>`;
    } catch (err) {
      $('c-status').innerHTML = `<div class="callout bad"><p>${esc(file.name)} is not a catalogue file: ${esc(err.message)}</p></div>`;
    }
  } else {
    importText(text, { vendor: $('c-vendor').value, us: $('c-units').value === 'us' });
  }
  e.target.value = '';
});

/**
 * Saving the catalogue out. A plain page can hand the browser a blob link;
 * inside a hosted viewer that link is inert, so ask the host to save instead.
 */
async function downloadCatalogue() {
  const filename = 'spring-catalogue.json';
  const json = JSON.stringify(cat.toCatalogJson(state.catalogue, { vendor: $('c-vendor').value }), null, 2);
  const say = (kind, msg) => { $('c-status').innerHTML = `<div class="callout ${kind}"><p>${esc(msg)}</p></div>`; };

  const host = typeof window.claude?.use === 'function'
    ? await window.claude.use('downloads').catch(() => null)
    : null;

  if (host) {
    try {
      await host.save({ filename, data: json });
      say('', `Saved ${filename} — ${state.catalogue.length} springs.`);
    } catch (err) {
      const code = err && err.code;
      if (code === 'declined') say('warn', 'Save cancelled.');
      else if (code === 'rate_limited') say('warn', 'A save prompt is already open — finish that one first.');
      else say('bad', `Could not save the file${code ? ` (${code})` : ''}.`);
    }
    return;
  }

  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
$('c-download').addEventListener('click', downloadCatalogue);

$('c-clear').addEventListener('click', () => {
  // Only this browser's springs are ours to clear; shipped rows come back.
  state.local = [];
  state.hidden = new Set();
  saveStore(); rebuildCatalogue(); renderCatalogue();
  $('c-status').innerHTML = `<div class="callout"><p>Cleared your additions. The
    ${state.catalogue.length} spring${state.catalogue.length === 1 ? '' : 's'} shipped with the
    site are still here.</p></div>`;
});

$('c-restore').addEventListener('click', () => {
  state.hidden = new Set();
  saveStore(); rebuildCatalogue(); renderCatalogue();
});

/* ------------------------------------------------------------------ boot */

loadStore();
rebuildCatalogue();
renderCatalogue();
runFind();
runAnalyse();

// The shipped catalogue arrives asynchronously; fold it in when it lands.
loadShared().then(() => {
  if (!state.shared.length) return;
  rebuildCatalogue();
  renderCatalogue();
  runFind();
});
