// Month view: a calendar grid whose cells are coloured by the daily temperature anomaly
// (observed, provisional or forecast), with holidays, quote markers and today's outline.

import { monthGrid, monthTitleFR, WEEKDAYS_SHORT_FR, parseISO, mmdd, keyIndex, holidaysOn, formatLongFR } from '../dates.js';
import { resolveDay } from '../weather.js';
import { colorFor, contrastText, renderLegend } from '../stripes.js';
import { el, fmtSigned, fmtTemp } from '../ui.js';

const DAILY_DOMAIN = 8;

export function renderMonth(ctx) {
  const { date, baseline } = ctx.state;
  const { y, m } = parseISO(date);
  const clim = ctx.clim;
  const shift = baseline === 'preindustrial' && ctx.regionDelta && typeof ctx.regionDelta.delta_c === 'number'
    ? ctx.regionDelta.delta_c : 0;
  const root = el('div', { class: 'view view-month' });
  root.appendChild(el('h1', { class: 'day-title', text: monthTitleFR(y, m) }));
  root.appendChild(el('p', { class: 'muted small', text: clim
    ? 'Couleur = écart de la moyenne journalière à la normale (observé ERA5, provisoire ou prévu). Hachuré : hors données. Point : citation vérifiée disponible.'
    : 'Climatologie non chargée : les cases ne sont pas colorées.' }));

  const table = el('table', { class: 'month-grid', role: 'grid', 'aria-label': `Calendrier ${monthTitleFR(y, m)}` });
  const head = el('tr', {}, WEEKDAYS_SHORT_FR.map((d) => el('th', { scope: 'col', text: d })));
  table.appendChild(el('thead', {}, [head]));
  const body = el('tbody');
  for (const week of monthGrid(y, m)) {
    const tr = el('tr');
    for (const iso of week) {
      if (!iso) {
        tr.appendChild(el('td', { class: 'cell cell-empty', 'aria-hidden': 'true' }));
        continue;
      }
      const idx = keyIndex(mmdd(iso));
      const forecastDay = ctx.forecastIndex.get(iso);
      const era5 = clim ? clim.valueOn(iso) : null;
      const resolved = resolveDay(iso, ctx.today, era5, forecastDay);
      const anomaly = clim && resolved.value !== null ? clim.anomaly(idx, resolved.value) : null;
      const color = anomaly === null ? null : colorFor(anomaly + shift, DAILY_DOMAIN);
      const holidays = holidaysOn(iso);
      const hasQuote = ctx.data.quotesIndex.has(mmdd(iso));
      const classes = ['cell'];
      if (iso === ctx.today) classes.push('is-today');
      if (iso === date) classes.push('is-selected');
      if (holidays.length) classes.push('is-holiday');
      if (color === null) classes.push('no-data');
      if (resolved.source === 'forecast' || resolved.source === 'today') classes.push('is-forecast');
      const title = [
        formatLongFR(iso),
        resolved.value === null ? 'hors données' : `${fmtTemp(resolved.value)} (${resolved.label})`,
        anomaly === null ? null : `écart ${fmtSigned(anomaly)}`,
        holidays.length ? holidays.join(', ') : null,
        hasQuote ? 'citation disponible' : null,
      ].filter(Boolean).join(' · ');
      const button = el('button', {
        type: 'button', class: 'cell-btn', title, 'aria-label': title,
        onclick: () => ctx.actions.goTo(iso),
      }, [
        el('span', { class: 'cell-day', text: String(parseISO(iso).d) }),
        anomaly === null ? null : el('span', { class: 'cell-anomaly', text: fmtSigned(anomaly, 0).replace(' °C', '') }),
        hasQuote ? el('span', { class: 'cell-dot', 'aria-hidden': 'true', text: '•' }) : null,
      ]);
      if (color) {
        button.style.background = color;
        button.style.color = contrastText(color);
      }
      tr.appendChild(el('td', { class: classes.join(' ') }, [button]));
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  root.appendChild(table);
  if (clim) {
    const legend = el('div');
    renderLegend(legend, DAILY_DOMAIN, { zeroLabel: baseline === 'preindustrial' ? '1850-1900' : 'normale' });
    root.appendChild(legend);
  }
  return root;
}
