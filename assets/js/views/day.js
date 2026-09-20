// Day view: block A (ephemeris), block B (dated quote), block C (weather and climate).
// Each block is rendered inside its own try/catch so that one failure never hides the others.

import {
  dayOfYear, daysInYear, isoWeek, formatLongFR, formatShortFR, formatDayMonthFR, holidaysOn,
  calendarEvents, mmdd, keyIndex, addDays, quarter, isLeap, parseISO, toISO, daysInMonth,
} from '../dates.js';
import { sunTimes, moonInfo, seasonInfo, zonedToUTC } from '../astro.js';
import { toRepublican, formatRepublican } from '../republican.js';
import { selectQuote, authorName, mediumLabel, yearsAgo, AUTHORS } from '../quotes.js';
import { resolveDay, weatherCodeInfo, SOURCE_LABELS } from '../weather.js';
import { renderStripes, renderLegend, renderStripesTable } from '../stripes.js';
import {
  el, fmtTemp, fmtSigned, fmtDuration, fmtMinutesDelta, fmtTime, fmtDateShort, fmtNumber, ordinalFR, percent, kv,
} from '../ui.js';

const ANNUAL_DOMAIN = 2.5;
const DAILY_DOMAIN = 8;

/** Same month/day in another year (29 February falls back to 28). */
export function sameDayInYear(iso, year) {
  const { m, d } = parseISO(iso);
  return toISO(year, m, Math.min(d, daysInMonth(year, m)));
}

function safeBlock(title, id, renderFn) {
  const section = el('section', { class: 'card', id, 'aria-labelledby': `${id}-title` });
  section.appendChild(el('h2', { id: `${id}-title`, class: 'card-title', text: title }));
  try {
    section.appendChild(renderFn());
  } catch (err) {
    console.error(`bloc ${id}`, err);
    section.appendChild(el('p', { class: 'error', text: `Ce bloc n’a pas pu être affiché (${err.message}).` }));
  }
  return section;
}

// ---------------------------------------------------------------- header line

export function renderDayHeader(ctx) {
  const { date, location } = ctx.state;
  const { y } = parseISO(date);
  const doy = dayOfYear(date);
  const total = daysInYear(y);
  const week = isoWeek(date);
  const rep = formatRepublican(toRepublican(date), ctx.data.republican);
  const bits = [
    `jour ${doy}/${total}`,
    `${total - doy} restant${total - doy > 1 ? 's' : ''}`,
    `semaine ${week.week}`,
    `T${quarter(parseISO(date).m)}`,
    isLeap(y) ? 'année bissextile' : null,
  ].filter(Boolean);
  return el('div', { class: 'day-header' }, [
    el('h1', { class: 'day-title', text: formatLongFR(date) }),
    el('p', { class: 'day-meta', text: bits.join(' · ') }),
    rep ? el('p', { class: 'day-republican' }, [
      el('span', { text: rep.text }),
      rep.dayLabel ? el('span', { class: 'muted', text: ` · ${rep.dayLabel}` }) : null,
      rep.decadeName ? el('span', { class: 'muted', text: ` · ${rep.decadeName.toLowerCase()}` }) : null,
    ]) : el('p', { class: 'day-republican muted', text: 'avant le calendrier républicain (22 septembre 1792)' }),
    el('p', { class: 'day-location muted', text: `${location.label}${location.admin1 ? `, ${location.admin1}` : ''}${location.country ? ` (${location.country})` : ''}` }),
  ]);
}

// ---------------------------------------------------------------- block A

function renderEphemeris(ctx) {
  const { date, location } = ctx.state;
  const tz = location.timezone || 'UTC';
  const wrap = el('div', { class: 'block-grid' });

  // Sun
  const sun = sunTimes(date, location.lat, location.lon, tz);
  const yesterday = sunTimes(addDays(date, -1), location.lat, location.lon, tz);
  const deltaDaylight = sun.daylightMinutes !== null && yesterday.daylightMinutes !== null
    ? sun.daylightMinutes - yesterday.daylightMinutes : null;
  const sunItems = [];
  if (sun.polar === 'day') sunItems.push(kv('Soleil', 'jour polaire : le soleil ne se couche pas'));
  else if (sun.polar === 'night') sunItems.push(kv('Soleil', 'nuit polaire : le soleil ne se lève pas'));
  else {
    sunItems.push(kv('Lever', fmtTime(sun.sunrise, tz)));
    sunItems.push(kv('Coucher', fmtTime(sun.sunset, tz)));
    sunItems.push(kv('Durée du jour', `${fmtDuration(sun.daylightMinutes)}${deltaDaylight !== null ? ` (${fmtMinutesDelta(deltaDaylight)} / veille)` : ''}`));
    sunItems.push(kv('Midi solaire', fmtTime(sun.solarNoon, tz)));
    sunItems.push(kv('Aube / crépuscule civils', `${fmtTime(sun.civilDawn, tz)} / ${fmtTime(sun.civilDusk, tz)}`));
  }
  wrap.appendChild(el('div', { class: 'block-col' }, [
    el('h3', { text: '☀️ Soleil' }),
    el('dl', {}, sunItems),
  ]));

  // Moon
  const noon = zonedToUTC(date, '12:00', tz);
  const moon = moonInfo(noon);
  wrap.appendChild(el('div', { class: 'block-col' }, [
    el('h3', { text: `${moon.emoji} Lune` }),
    el('dl', {}, [
      kv('Phase', `${moon.name} (${percent(moon.illumination)} éclairée, ${fmtNumber(moon.ageDays, 1)} j)`),
      kv('Prochaine pleine lune', fmtDateShort(moon.nextFullMoon, tz)),
      kv('Prochaine nouvelle lune', fmtDateShort(moon.nextNewMoon, tz)),
    ]),
  ]));

  // Saint, holidays, events, season
  const key = mmdd(date);
  const saint = ctx.data.saints.days[key];
  const holidays = holidaysOn(date);
  const events = calendarEvents(date);
  const season = seasonInfo(date, tz, location.lat < 0 ? 'south' : 'north');
  const items = [];
  if (saint) {
    const names = saint.names && saint.names.length ? saint.names.join(', ') : saint.saint;
    items.push(kv('Fête', `${names}${saint.feast ? ` · ${saint.feast}` : ''}`));
  }
  items.push(kv('Férié', holidays.length ? holidays.join(', ') : 'pas de jour férié'));
  if (events.length) items.push(kv('Événements', events.join(', ')));
  items.push(kv('Saison', `${season.season} · ${season.next.name} ${season.daysUntilNext === 0 ? 'aujourd’hui' : `dans ${season.daysUntilNext} jour${season.daysUntilNext > 1 ? 's' : ''}`} (${fmtDateShort(season.next.date, tz)})`));
  wrap.appendChild(el('div', { class: 'block-col' }, [
    el('h3', { text: '📅 Calendrier' }),
    el('dl', {}, items),
  ]));
  return wrap;
}

// ---------------------------------------------------------------- block B

function renderQuote(ctx) {
  const { date, authors, quoteOffset } = ctx.state;
  const wrap = el('div', { class: 'quote-block' });
  const result = selectQuote(ctx.data.quotesIndex, date, { authors, offset: quoteOffset });

  const filters = el('div', { class: 'quote-filters', role: 'group', 'aria-label': 'Auteurs' },
    Object.entries(AUTHORS).map(([id, info]) => el('label', { class: 'chip' }, [
      el('input', {
        type: 'checkbox', checked: authors.includes(id), onchange: (e) => ctx.actions.toggleAuthor(id, e.target.checked),
      }),
      ` ${info.name}`,
    ])));
  wrap.appendChild(filters);

  if (!result.quote) {
    wrap.appendChild(el('div', { class: 'empty' }, [
      el('p', { text: `Aucune citation vérifiée autour du ${formatDayMonthFR(date)} dans la base.` }),
      el('p', { class: 'muted' }, [
        'Pour en ajouter une : ',
        el('a', { href: 'CONTRIBUTING.md', text: 'guide de contribution' }),
        '. Une citation vérifiée porte sa source et le texte exact de celle-ci.',
      ]),
    ]));
    return wrap;
  }

  const q = result.quote;
  const quoteYears = yearsAgo(date, q.date);
  const showFr = ctx.state.showTranslation && q.text_fr;
  const fallbackNotes = [];
  if (result.fallback.days !== 0) {
    fallbackNotes.push(`citation du ${formatDayMonthFR(toISO(2000, Number(result.fallback.key.slice(0, 2)), Number(result.fallback.key.slice(3))))} (aucune pour ce jour)`);
  }
  if (result.fallback.allAuthors) fallbackNotes.push('filtre d’auteur élargi (aucune citation pour la sélection)');

  wrap.appendChild(el('blockquote', { class: 'quote', lang: showFr ? 'fr' : q.lang }, [
    el('p', { class: 'quote-text', text: showFr ? q.text_fr : q.text }),
    el('footer', {}, [
      el('cite', { text: `${authorName(q.author)}` }),
      ` · ${formatShortFR(q.date)}`,
      quoteYears > 0 ? ` (il y a ${quoteYears} an${quoteYears > 1 ? 's' : ''})` : quoteYears === 0 ? ' (cette année)' : '',
      ` · ${mediumLabel(q.medium)}`,
    ]),
  ]));
  if (q.context) wrap.appendChild(el('p', { class: 'quote-context muted', text: q.context }));
  if (fallbackNotes.length) wrap.appendChild(el('p', { class: 'quote-fallback muted', text: fallbackNotes.join(' · ') }));

  const actions = el('div', { class: 'quote-actions' }, [
    el('a', { class: 'btn', href: q.source_url, target: '_blank', rel: 'noopener noreferrer', text: 'Source ↗' }),
    q.text_fr ? el('button', {
      type: 'button', class: 'btn', onclick: () => ctx.actions.toggleTranslation(),
      text: showFr ? 'Texte original' : `Traduction FR${q.translation === 'machine' ? ' (automatique)' : ''}`,
    }) : null,
    result.candidates.length > 1 ? el('button', {
      type: 'button', class: 'btn', onclick: () => ctx.actions.nextQuote(),
      text: `Autre citation (${result.position + 1}/${result.candidates.length})`,
    }) : null,
  ]);
  wrap.appendChild(actions);
  return wrap;
}

// ---------------------------------------------------------------- block C

function baselineShift(ctx) {
  if (ctx.state.baseline !== 'preindustrial') return 0;
  const delta = ctx.regionDelta;
  return delta && typeof delta.delta_c === 'number' ? delta.delta_c : 0;
}

function renderWeatherNow(ctx, dayInfo) {
  const { location } = ctx.state;
  const current = ctx.forecast && ctx.forecast.current;
  const parts = [];
  if (current) {
    const info = weatherCodeInfo(current.weather_code, current.is_day === 1);
    parts.push(el('div', { class: 'now' }, [
      el('span', { class: 'now-icon', 'aria-hidden': 'true', text: info.icon }),
      el('span', { class: 'now-temp', text: fmtTemp(current.temperature_2m) }),
      el('span', { class: 'now-label', text: info.label }),
    ]));
    parts.push(el('p', { class: 'muted small', text: `Humidité ${current.relative_humidity_2m} % · vent ${fmtNumber(current.wind_speed_10m, 0)} km/h · relevé ${current.time ? current.time.slice(11, 16) : ''} (${location.timezone})` }));
  }
  if (dayInfo) {
    const info = dayInfo.code !== null && dayInfo.code !== undefined ? weatherCodeInfo(dayInfo.code, true) : null;
    parts.push(el('dl', { class: 'inline-dl' }, [
      kv('Moyenne journalière', `${fmtTemp(dayInfo.mean)}${dayInfo.meanApprox ? ' (≈ (max+min)/2)' : ''}`),
      kv('Min / max', `${fmtTemp(dayInfo.min)} / ${fmtTemp(dayInfo.max)}`),
      kv('Précipitations', dayInfo.precipitation === null || dayInfo.precipitation === undefined ? '–' : `${fmtNumber(dayInfo.precipitation, 1)} mm`),
      info ? kv('Temps', info.label) : null,
    ].filter(Boolean)));
  }
  return parts;
}

function anomalyChip(label, value, title) {
  const cls = value === null ? 'chip-neutral' : value > 0.05 ? 'chip-warm' : value < -0.05 ? 'chip-cold' : 'chip-neutral';
  return el('span', { class: `anomaly-chip ${cls}`, title: title || '' }, [
    el('span', { class: 'chip-value', text: value === null ? 'indisponible' : fmtSigned(value) }),
    el('span', { class: 'chip-label', text: ` ${label}` }),
  ]);
}

function renderClimate(ctx) {
  const { date, location, baseline } = ctx.state;
  const wrap = el('div', { class: 'climate-block' });
  const clim = ctx.clim;
  const idx = keyIndex(mmdd(date));
  const year = parseISO(date).y;
  const forecastDay = ctx.forecastIndex.get(date);
  const era5Value = clim ? clim.valueOn(date) : null;
  const resolved = resolveDay(date, ctx.today, era5Value, forecastDay);
  const isToday = date === ctx.today;

  // Weather status / now
  if (ctx.forecastStatus === 'error') {
    wrap.appendChild(el('p', { class: 'error' }, [
      `Météo indisponible : ${ctx.forecastError || 'Open-Meteo injoignable'}. `,
      el('button', { type: 'button', class: 'btn btn-small', onclick: () => ctx.actions.retryWeather(), text: 'Réessayer' }),
    ]));
  } else if (ctx.forecastStatus === 'loading') {
    wrap.appendChild(el('p', { class: 'muted', text: 'Chargement de la météo…' }));
  }

  let dayInfo = forecastDay || null;
  if (!dayInfo && ctx.archiveDay) dayInfo = ctx.archiveDay;
  if (isToday || dayInfo) {
    for (const node of renderWeatherNow(isToday ? ctx : { ...ctx, forecast: null }, dayInfo)) wrap.appendChild(node);
  }

  // Source label of the daily mean used for anomalies
  const valueLine = el('p', { class: 'value-line' }, [
    el('strong', { text: resolved.value === null ? 'Température moyenne du jour : indisponible' : `Moyenne du jour : ${fmtTemp(resolved.value)}` }),
    el('span', { class: 'muted', text: ` · ${resolved.label}` }),
  ]);
  wrap.appendChild(valueLine);

  if (!clim) {
    if (ctx.climStatus === 'loading') {
      wrap.appendChild(el('p', { class: 'muted' }, [
        `Calcul de la climatologie (${ctx.climProgress || 'téléchargement ERA5 1940 → aujourd’hui'})…`,
      ]));
    } else if (ctx.climStatus === 'error') {
      wrap.appendChild(el('p', { class: 'error' }, [
        `Climatologie indisponible : ${ctx.climError || 'erreur'}. `,
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => ctx.actions.retryClimatology(), text: 'Réessayer' }),
      ]));
    } else {
      wrap.appendChild(el('p', { class: 'muted', text: 'Climatologie non chargée.' }));
    }
    return wrap;
  }

  // Anomalies
  const normal = clim.normal(idx);
  const anomaly = resolved.value === null ? null : clim.anomaly(idx, resolved.value);
  const delta = ctx.regionDelta;
  const preAnomaly = anomaly === null || !delta || typeof delta.delta_c !== 'number' ? null : anomaly + delta.delta_c;
  const chips = el('div', { class: 'chips' }, [
    anomalyChip(`vs normale ${clim.normalPeriod[0]}-${clim.normalPeriod[1]} (${fmtTemp(normal)})`, anomaly,
      'Écart de la moyenne journalière à la normale de saison (fenêtre ± 7 jours)'),
    anomalyChip('vs pré-industriel 1850-1900 (est.)', preAnomaly,
      delta && typeof delta.delta_c === 'number'
        ? `Anomalie du jour + ${fmtSigned(delta.delta_c)} de réchauffement régional (${delta.label}, Berkeley Earth)`
        : 'Référence pré-industrielle indisponible pour cette région'),
  ]);
  wrap.appendChild(chips);
  if (delta && typeof delta.delta_c !== 'number' && delta.note) {
    wrap.appendChild(el('p', { class: 'muted small', text: `Pré-industriel : ${delta.note}` }));
  }

  // Rank and records for this calendar day
  const rec = clim.records(idx);
  const rankLine = [];
  if (resolved.value !== null && resolved.source === 'era5') {
    const { rank, n } = clim.rank(idx, resolved.value);
    rankLine.push(`${ordinalFR(rank)} ${formatDayMonthFR(date)} le plus chaud sur ${n} années`);
  } else if (resolved.value !== null) {
    const { rank, n } = clim.rank(idx, resolved.value);
    rankLine.push(`serait le ${ordinalFR(rank)} ${formatDayMonthFR(date)} le plus chaud sur ${n} années (valeur ${resolved.source === 'today' ? 'prévue' : 'provisoire'})`);
  }
  if (rec.max.value !== null) rankLine.push(`record chaud ${fmtTemp(rec.max.value)} (${rec.max.year})`);
  if (rec.min.value !== null) rankLine.push(`record froid ${fmtTemp(rec.min.value)} (${rec.min.year})`);
  if (rankLine.length) wrap.appendChild(el('p', { class: 'rank-line', text: rankLine.join(' · ') }));

  // Baseline toggle
  wrap.appendChild(el('div', { class: 'baseline-toggle', role: 'group', 'aria-label': 'Référence des couleurs' }, [
    el('span', { class: 'muted small', text: 'Zéro des couleurs : ' }),
    el('button', {
      type: 'button', class: `btn btn-small${baseline === 'normal' ? ' is-active' : ''}`,
      'aria-pressed': baseline === 'normal' ? 'true' : 'false',
      onclick: () => ctx.actions.setBaseline('normal'), text: `normale ${clim.normalPeriod[0]}-${clim.normalPeriod[1]}`,
    }),
    el('button', {
      type: 'button', class: `btn btn-small${baseline === 'preindustrial' ? ' is-active' : ''}`,
      'aria-pressed': baseline === 'preindustrial' ? 'true' : 'false',
      disabled: !(delta && typeof delta.delta_c === 'number'),
      onclick: () => ctx.actions.setBaseline('preindustrial'), text: 'pré-industriel 1850-1900',
    }),
  ]));
  const shift = baselineShift(ctx);

  // Stripes: this calendar day since first year
  const daySeries = clim.daySeries(idx).map((d) => ({
    id: d.year, value: d.anomaly, label: String(d.year), selected: d.year === year,
    secondary: d.value === null ? null : fmtTemp(d.value),
  }));
  // Add the selected year when it is not in the series (forecast / provisional value).
  if (!clim.daily.has(year) && resolved.value !== null && anomaly !== null) {
    daySeries.push({ id: year, value: anomaly, label: String(year), selected: true, partial: true, secondary: resolved.label });
  }
  const dayStripesBox = el('div', { class: 'stripes-box' });
  wrap.appendChild(el('h3', { text: `Ce ${formatDayMonthFR(date)} depuis ${clim.firstYear}` }));
  wrap.appendChild(el('p', { class: 'muted small', text: 'Une bande par année : écart de la moyenne journalière de ce jour calendaire à la normale. Cliquer une bande ouvre ce jour-là.' }));
  wrap.appendChild(dayStripesBox);
  renderStripes(dayStripesBox, daySeries, {
    domain: DAILY_DOMAIN, height: 56, shift, tickEvery: 10,
    ariaLabel: `Écarts à la normale du ${formatDayMonthFR(date)} pour chaque année depuis ${clim.firstYear}`,
    onSelect: (item) => ctx.actions.goTo(sameDayInYear(date, item.id)),
  });
  const dayLegend = el('div');
  renderLegend(dayLegend, DAILY_DOMAIN, { zeroLabel: baseline === 'preindustrial' ? '1850-1900' : 'normale' });
  wrap.appendChild(dayLegend);
  const dayTable = el('details', { class: 'data-table' }, [el('summary', { text: 'Valeurs (tableau)' })]);
  const dayTableBox = el('div');
  renderStripesTable(dayTableBox, daySeries, `Écart à la normale, ${formatDayMonthFR(date)}, par année`);
  dayTable.appendChild(dayTableBox);
  wrap.appendChild(dayTable);

  // Stripes: annual
  const annual = clim.annualSeries().map((a) => ({
    id: a.year, value: a.anomaly, label: String(a.year), selected: a.year === year, partial: a.partial,
    secondary: a.mean === null ? null : `moyenne ${fmtTemp(a.mean)}${a.partial ? `, ${a.days} jours` : ''}`,
  }));
  const annualBox = el('div', { class: 'stripes-box' });
  wrap.appendChild(el('h3', { text: `Années ${clim.firstYear} → ${clim.lastYear}` }));
  wrap.appendChild(el('p', { class: 'muted small', text: 'Écart de la moyenne annuelle à la normale. L’année en cours est partielle (hachurée à la légende). Cliquer une bande ouvre la même date de cette année.' }));
  wrap.appendChild(annualBox);
  renderStripes(annualBox, annual, {
    domain: ANNUAL_DOMAIN, height: 48, shift, tickEvery: 10,
    ariaLabel: `Écarts annuels à la normale de ${clim.firstYear} à ${clim.lastYear}`,
    onSelect: (item) => ctx.actions.goTo(sameDayInYear(date, item.id)),
  });
  const annualLegend = el('div');
  renderLegend(annualLegend, ANNUAL_DOMAIN, { zeroLabel: baseline === 'preindustrial' ? '1850-1900' : 'normale' });
  wrap.appendChild(annualLegend);
  const annualTable = el('details', { class: 'data-table' }, [el('summary', { text: 'Valeurs (tableau)' })]);
  const annualTableBox = el('div');
  renderStripesTable(annualTableBox, annual, 'Écart annuel à la normale');
  annualTable.appendChild(annualTableBox);
  wrap.appendChild(annualTable);

  // Next 7 days mini stripes (when forecast covers them)
  const next = [];
  for (let i = 0; i <= 7; i++) {
    const iso = addDays(date, i);
    const f = ctx.forecastIndex.get(iso);
    const v = f && f.mean !== null && f.mean !== undefined ? f.mean : (clim.valueOn(iso));
    const a = v === null || v === undefined ? null : clim.anomaly(keyIndex(mmdd(iso)), v);
    next.push({ id: iso, value: a, label: formatShortFR(iso).slice(0, 5), selected: i === 0, secondary: v === null || v === undefined ? null : fmtTemp(v) });
  }
  if (next.some((d) => d.value !== null)) {
    const nextBox = el('div', { class: 'stripes-box stripes-mini' });
    wrap.appendChild(el('h3', { text: 'Les 7 prochains jours' }));
    wrap.appendChild(nextBox);
    renderStripes(nextBox, next, {
      domain: DAILY_DOMAIN, height: 28, shift, tickEvery: 1,
      ariaLabel: 'Écart prévu à la normale pour les sept prochains jours',
      onSelect: (item) => ctx.actions.goTo(item.id),
    });
  }

  wrap.appendChild(el('p', { class: 'muted small' }, [
    el('button', { type: 'button', class: 'link', onclick: () => ctx.actions.openMethod(), text: 'ⓘ Méthode et sources' }),
    ` · données ERA5 jusqu’au ${formatShortFR(clim.lastDate)} · grille ${fmtNumber(clim.source.grid_lat, 2)}, ${fmtNumber(clim.source.grid_lon, 2)}`,
  ]));
  return wrap;
}

// ---------------------------------------------------------------- view

export function renderDay(ctx) {
  const root = el('div', { class: 'view view-day' });
  root.appendChild(renderDayHeader(ctx));
  root.appendChild(safeBlock('A · La journée', 'block-a', () => renderEphemeris(ctx)));
  root.appendChild(safeBlock(`B · Un ${formatDayMonthFR(ctx.state.date)}, il a dit`, 'block-b', () => renderQuote(ctx)));
  root.appendChild(safeBlock('C · Météo et climat', 'block-c', () => renderClimate(ctx)));
  return root;
}

export { SOURCE_LABELS };
