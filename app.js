/**
 * app.js -- browser front end for the spring calculator.
 * All the physics lives in spring-math.js; this file is display and plumbing.
 */
import * as sm from './spring-math.js';
import * as cat from './catalog.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'springcalc.catalog.v1';

const state = {
  lengthUnit: 'in',
  catalogue: [],
  results: [],
  selected: null,
};

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
  });
});

/* -------------------------------------------------------------- storage */

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state.catalogue = cat.fromCatalogJson(raw);
  } catch (e) { /* private mode, corrupt payload -- start empty */ }
}
function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cat.toCatalogJson(state.catalogue))); }
  catch (e) { /* over quota or blocked; the session still works */ }
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
    <h2>${esc(s.partNumber || 'Spring')} ${verdict}</h2>
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
    maxOD_mm: readLen('f-maxod'),
    minID_mm: readLen('f-minid'),
    maxFreeLength_mm: readLen('f-maxfree'),
    maxInstalledLength_mm: readLen('f-maxinst'),
    positionTol_mm: readLen('f-postol') ?? 0.25,
    rateTol: (rawNum('f-ratetol') ?? 10) / 100,
    maxTravelUsedFraction: (rawNum('f-maxtravel') ?? 100) / 100,
    materials: $('f-material').value ? [$('f-material').value] : null,
    sortBy: $('f-sort').value,
    includeRejected: $('f-showall').checked,
  };
}

function renderShopping(req) {
  const box = $('f-shopping');
  if (!req.targetForce_N || !req.maxOD_mm) { box.innerHTML = ''; return; }
  const F0 = req.targetForce_N;
  const ds = sm.designSpace({
    targetForce_N: F0, maxOD_mm: req.maxOD_mm,
    deflectionRange_mm: [sm.inToMm(0.05), Math.min(sm.inToMm(0.5), req.maxFreeLength_mm ?? sm.inToMm(0.5))],
    steps: 6,
  });
  const [kSoft, kStiff] = ds.rateWindow_Npmm;
  const rows = ds.points.map((p) => {
    const best = p.options[0];
    const band = (p.rate_Npmm * (req.positionTol_mm) + F0 * req.rateTol) / F0;
    return `<tr>
      <td class="num l">${Lnum(p.deflection_mm)}</td>
      <td class="num">${nf(sm.nPerMmToLbfPerIn(p.rate_Npmm), 2)}</td>
      <td class="num">${nf(p.rate_Npmm, 3)}</td>
      <td class="num">&plusmn;${pct(band)}</td>
      <td class="num">${best ? nf(sm.mmToIn(best.wireDia_mm), 3) : '—'}</td>
      <td class="num">${best ? nf(best.activeCoils, 1) : '—'}</td>
      <td class="num">${best ? Lnum(best.minFreeLength_mm) : '—'}</td>
    </tr>`;
  }).join('');

  box.innerHTML = `<h2>What to shop for</h2>
    <div class="callout">
      <p>For <strong>${F(F0)}</strong> (${nf(sm.nToLbf(F0), 3)} lbf, ${nf(F0 / 0.00980665, 0)} gf,
         ${nf(F0 / 0.2780138509, 1)} oz) inside <strong>${L(req.maxOD_mm)}</strong> OD, filter the vendor's
         compression-spring table to this rate window:</p>
      <p class="big">${nf(sm.nPerMmToLbfPerIn(kSoft), 2)} &ndash; ${nf(sm.nPerMmToLbfPerIn(kStiff), 2)} lbf/in
        &nbsp;<span class="muted" style="font-size:13px">(${nf(kSoft, 3)} &ndash; ${nf(kStiff, 3)} N/mm)</span></p>
      <p class="muted" style="font-size:13px">Softer end puts the working load ${L(sm.inToMm(0.5))} down the travel,
        stiffer end ${L(sm.inToMm(0.05))}. Anything stiffer than that window and you are trying to hold a force
        with a few thou of travel.</p>
    </div>
    <div class="scroll"><table>
      <thead><tr><th class="l">compress by</th><th>rate lbf/in</th><th>rate N/mm</th><th>force band</th>
        <th>wire in</th><th>coils</th><th>min free ${Lunit()}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="hint">Right-hand columns are the leanest geometry that delivers each rate inside your OD &mdash;
      what a spring at that rate has to look like. Use it to sanity-check anything a vendor offers you.</p>`;
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
    return;
  }
  const hits = sm.searchCatalog(state.catalogue, req);
  state.results = hits;
  const okCount = hits.filter((h) => h.ok).length;

  const rows = hits.map((h, i) => {
    const w = h.evaluation.working;
    const sev = severity(w?.travelUsedFraction);
    return `<tr data-i="${i}" class="${h.ok ? '' : 'rejected'}">
      <td class="l">${h.ok ? badge(sev, sev === 'ok' ? 'fits' : sev === 'warn' ? 'tight' : 'at limit') : badge('bad', 'no')}</td>
      <td class="l">${esc(h.spring.partNumber || '—')}</td>
      <td class="num">${Lnum(h.spring.od_mm)}</td>
      <td class="num">${Lnum(h.spring.freeLength_mm)}</td>
      <td class="num">${nf(sm.nPerMmToLbfPerIn(h.spring.rate_Npmm), 2)}</td>
      <td class="num">${Lnum(w?.deflection_mm)}</td>
      <td class="num">${Lnum(w?.installedLength_mm)}</td>
      <td class="num">${pct(w?.travelUsedFraction)}</td>
      <td class="num">&plusmn;${pct(w?.sensitivity.worstCaseFraction)}</td>
      <td class="num">${pct(w?.utilisation)}</td>
      <td class="l muted">${esc(h.ok ? '' : (h.rejected[0] || ''))}</td>
    </tr>`;
  }).join('');

  box.innerHTML = `<h2>${okCount} of ${state.catalogue.length} springs can deliver ${F(req.targetForce_N)}</h2>
    <div class="scroll"><table>
      <thead><tr><th class="l"></th><th class="l">part</th><th>OD ${Lunit()}</th><th>free ${Lunit()}</th>
        <th>rate lbf/in</th><th>compress ${Lunit()}</th><th>installed ${Lunit()}</th>
        <th>travel used</th><th>force band</th><th>stress</th><th class="l">why not</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="hint">Click a row for the full working-point report. &ldquo;Force band&rdquo; is what you
      actually get once rate tolerance and assembly position error are counted &mdash; the reason a softer
      spring compressed further beats a stiff one nudged slightly.</p>`;

  box.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => {
    box.querySelectorAll('tbody tr').forEach((x) => x.classList.remove('sel'));
    tr.classList.add('sel');
    showDetail(Number(tr.dataset.i));
  }));
  if (okCount) { box.querySelector('tbody tr').classList.add('sel'); showDetail(0); }
  else $('f-detail').innerHTML = '';
}

function showDetail(i) {
  const h = state.results[i];
  if (!h) return;
  state.selected = h;
  const holder = $('f-detail');
  holder.innerHTML = renderReport(h.spring, h.evaluation);
  mountViz(holder, h.spring, h.evaluation);
}

function runFind() {
  const req = findRequirements();
  if (!req.targetForce_N) { $('f-shopping').innerHTML = '<div class="callout bad"><p>Enter the force you need.</p></div>'; return; }
  renderShopping(req);
  renderResults(req);
}
$('f-run').addEventListener('click', runFind);
$('f-len-u').addEventListener('change', () => {
  state.lengthUnit = $('f-len-u').value;
  $('a-units').value = state.lengthUnit;
  runFind();
});
document.querySelectorAll('#tab-find input, #tab-find select').forEach((x) =>
  x.addEventListener('keydown', (e) => { if (e.key === 'Enter') runFind(); }));

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
$('a-units').addEventListener('change', () => {
  state.lengthUnit = $('a-units').value;
  $('f-len-u').value = state.lengthUnit;
  runAnalyse();
});
$('a-save').addEventListener('click', () => {
  const s = analyseSpring();
  if (s.incomplete) { runAnalyse(); return; }
  state.catalogue.push(s); saveStore(); renderCatalogue();
  $('a-out').insertAdjacentHTML('afterbegin',
    `<div class="callout"><p>Added to the catalogue (${state.catalogue.length} springs).</p></div>`);
});

/* ---------------------------------------------------------- CATALOG tab */

function renderCatalogue() {
  const box = $('c-list');
  if (!state.catalogue.length) {
    box.innerHTML = '<h2>Loaded springs</h2><p class="muted">Nothing loaded.</p>';
    return;
  }
  const rows = state.catalogue.map((s, i) => `<tr>
    <td class="l">${esc(s.partNumber || '—')}</td>
    <td class="l muted">${esc(s.vendor || '')}</td>
    <td class="num">${Lnum(s.od_mm)}</td>
    <td class="num">${Lnum(s.wireDia_mm)}</td>
    <td class="num">${Lnum(s.freeLength_mm)}</td>
    <td class="num">${nf(sm.nPerMmToLbfPerIn(s.rate_Npmm), 2)}</td>
    <td class="num">${Lnum(s.solidLength_mm)}</td>
    <td class="num">${F(s.maxUsableForce_N)}</td>
    <td class="l">${s.incomplete ? badge('bad', 'incomplete') : s.warnings.length ? badge('warn', String(s.warnings.length)) : ''}</td>
    <td class="l"><button class="link" data-del="${i}">remove</button></td>
  </tr>`).join('');
  box.innerHTML = `<h2>Loaded springs (${state.catalogue.length})</h2>
    <div class="scroll"><table>
      <thead><tr><th class="l">part</th><th class="l">vendor</th><th>OD ${Lunit()}</th><th>wire ${Lunit()}</th>
        <th>free ${Lunit()}</th><th>rate lbf/in</th><th>solid ${Lunit()}</th><th>max load</th>
        <th class="l"></th><th class="l"></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    state.catalogue.splice(Number(b.dataset.del), 1); saveStore(); renderCatalogue();
  }));
}

function importText(text, { vendor, us }) {
  const res = cat.importTable(text, {
    vendor,
    lengthUnit: us ? 'in' : 'mm',
    rateUnit: us ? 'lbf/in' : 'N/mm',
    forceUnit: us ? 'lbf' : 'N',
    urlTemplate: /mcmaster/i.test(vendor) ? 'https://www.mcmaster.com/{part}/' : null,
  });
  const status = $('c-status');
  if (res.error) {
    status.innerHTML = `<div class="callout bad"><p>${esc(res.error)}</p></div>`;
    return;
  }
  if ($('c-mode').value === 'replace') state.catalogue = [];
  const usable = res.springs.filter((s) => !s.incomplete);
  state.catalogue.push(...res.springs);
  saveStore(); renderCatalogue();

  const mapped = res.mapping.filter((m) => m.field);
  status.innerHTML = `<div class="callout ${usable.length ? '' : 'warn'}">
    <p>Parsed <strong>${res.rows.length}</strong> rows &rarr; <strong>${usable.length}</strong> usable
      ${res.springs.length - usable.length ? `, ${res.springs.length - usable.length} short of data` : ''}
      ${res.skipped.length ? `, ${res.skipped.length} lines ignored` : ''}.</p>
    <p class="muted" style="font-size:12px">Columns read: ${mapped.map((m) => `${esc(m.header)} &rarr; ${m.field}`).join(', ') || 'none'}
      ${res.unmapped.length ? `<br>Ignored: ${res.unmapped.map((m) => esc(m.header)).join(', ')}` : ''}</p>
  </div>`;
}

$('c-import').addEventListener('click', () =>
  importText($('c-paste').value, { vendor: $('c-vendor').value, us: $('c-units').value === 'us' }));

$('c-example').addEventListener('click', async () => {
  try {
    // The standalone build inlines the file; the hosted version fetches it.
    let payload = window.EXAMPLE_CATALOGUE;
    if (!payload) {
      const r = await fetch('./data/example-catalogue.json');
      if (!r.ok) throw new Error(r.status);
      payload = await r.json();
    }
    const springs = cat.fromCatalogJson(payload);
    if ($('c-mode').value === 'replace') state.catalogue = [];
    state.catalogue.push(...springs);
    saveStore(); renderCatalogue();
    $('c-status').innerHTML = `<div class="callout warn"><p>Loaded ${springs.length} <strong>synthetic</strong>
      springs. They are geometrically consistent and fine for trying the tool, but they are
      <strong>not real parts</strong> &mdash; do not order from them.</p></div>`;
  } catch (e) {
    $('c-status').innerHTML = `<div class="callout bad"><p>Could not load the example catalogue (${esc(e.message)}).
      If you opened this file directly from disk, serve the folder over HTTP instead.</p></div>`;
  }
});

$('c-file').addEventListener('click', () => $('c-fileinput').click());
$('c-fileinput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  if (file.name.endsWith('.json')) {
    try {
      const springs = cat.fromCatalogJson(text);
      if ($('c-mode').value === 'replace') state.catalogue = [];
      state.catalogue.push(...springs); saveStore(); renderCatalogue();
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
  state.catalogue = []; saveStore(); renderCatalogue();
  $('c-status').innerHTML = '';
});

/* ------------------------------------------------------------------ boot */

loadStore();
renderCatalogue();
runFind();
runAnalyse();
