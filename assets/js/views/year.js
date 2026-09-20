// Year view: 12 x 31 heatmap of daily anomalies for the selected year.

import { parseISO, toISO, daysInMonth, MONTHS_FR, mmdd, keyIndex, formatLongFR } from '../dates.js';
import { resolveDay } from '../weather.js';
import { colorFor, renderLegend } from '../stripes.js';
import { el, fmtSigned, fmtTemp } from '../ui.js';

const DAILY_DOMAIN = 8;

export function renderYear(ctx) {
  const { date, baseline } = ctx.state;
  const { y } = parseISO(date);
  const clim = ctx.clim;
  const shift = baseline === 'preindustrial' && ctx.regionDelta && typeof ctx.regionDelta.delta_c === 'number'
    ? ctx.regionDelta.delta_c : 0;
  const root = el('div', { class: 'view view-year' });
  root.appendChild(el('h1', { class: 'day-title', text: `Année ${y}` }));
  const annual = clim ? clim.annualSeries().find((a) => a.year === y) : null;
  root.appendChild(el('p', { class: 'muted small', text: annual && annual.anomaly !== null
    ? `Écart annuel à la normale : ${fmtSigned(annual.anomaly)}${annual.partial ? ` (année partielle, ${annual.days} jours)` : ''} · moyenne ${fmtTemp(annual.mean)}`
    : 'Pas de bilan annuel pour cette année.' }));

  const table = el('table', { class: 'year-grid', 'aria-label': `Écarts journaliers à la normale, ${y}` });
  const head = el('tr', {}, [el('th', { text: '' })]);
  for (let d = 1; d <= 31; d++) head.appendChild(el('th', { scope: 'col', text: d % 5 === 0 || d === 1 ? String(d) : '' }));
  table.appendChild(el('thead', {}, [head]));
  const body = el('tbody');
  for (let m = 1; m <= 12; m++) {
    const tr = el('tr', {}, [el('th', { scope: 'row', text: MONTHS_FR[m - 1].slice(0, 4) })]);
    for (let d = 1; d <= 31; d++) {
      if (d > daysInMonth(y, m)) {
        tr.appendChild(el('td', { class: 'ycell ycell-empty' }));
        continue;
      }
      const iso = toISO(y, m, d);
      const forecastDay = ctx.forecastIndex.get(iso);
      const era5 = clim ? clim.valueOn(iso) : null;
      const resolved = resolveDay(iso, ctx.today, era5, forecastDay);
      const anomaly = clim && resolved.value !== null ? clim.anomaly(keyIndex(mmdd(iso)), resolved.value) : null;
      const color = anomaly === null ? null : colorFor(anomaly + shift, DAILY_DOMAIN);
      const title = `${formatLongFR(iso)} · ${resolved.value === null ? 'hors données' : `${fmtTemp(resolved.value)}, écart ${fmtSigned(anomaly)} (${resolved.label})`}`;
      const btn = el('button', { type: 'button', class: 'ycell-btn', title, 'aria-label': title, onclick: () => ctx.actions.goTo(iso) });
      if (color) btn.style.background = color;
      tr.appendChild(el('td', { class: `ycell${color ? '' : ' no-data'}${iso === date ? ' is-selected' : ''}` }, [btn]));
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  root.appendChild(el('div', { class: 'year-scroll' }, [table]));
  if (clim) {
    const legend = el('div');
    renderLegend(legend, DAILY_DOMAIN, { zeroLabel: baseline === 'preindustrial' ? '1850-1900' : 'normale' });
    root.appendChild(legend);
  }
  return root;
}
