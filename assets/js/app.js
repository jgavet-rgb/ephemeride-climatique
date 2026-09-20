// Application bootstrap: state, hash routing, data loading, rendering. Static site, no
// backend; the only network calls go to Open-Meteo (weather.js) and to the repository files.

import {
  todayISO, addDays, isValidISO, parseISO, toISO, addMonths, clampDay, daysInMonth, formatShortFR, formatLongFR,
} from './dates.js';
import { parseJSONL, indexQuotes, coverage } from './quotes.js';
import { Climatology, climatologyFromArchive, extendClimatology } from './climate.js';
import { fetchForecast, fetchArchiveDay, fetchArchiveSeries, geocode, indexForecast } from './weather.js';
import { storeGet, storeSet, idbGet, idbSet } from './storage.js';
import { renderDay } from './views/day.js';
import { renderMonth } from './views/month.js';
import { renderYear } from './views/year.js';
import { el, clear, toast, announce, openModal, closeModal, fmtSigned, fmtNumber, kv } from './ui.js';

const DATA_BASE = 'data/';
const ERA5_START = '1940-01-01';
const ERA5_LAG_DAYS = 6;
const STALE_DAYS = 20;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const NEARBY_KM = 25;
const KEYS = {
  location: 'ec:location', authors: 'ec:authors', baseline: 'ec:baseline', theme: 'ec:theme', favorites: 'ec:favorites', view: 'ec:view',
};

const state = {
  view: 'day',
  date: null,
  location: null,
  locations: [],
  authors: ['trump', 'musk'],
  baseline: 'normal',
  quoteOffset: 0,
  showTranslation: false,
  theme: 'auto',
};

const runtime = {
  data: { saints: null, republican: null, quotesAll: [], quotesIndex: new Map(), baselines: null, coverage: null },
  clim: null,
  climStatus: 'idle',
  climProgress: '',
  climError: '',
  forecast: null,
  forecastIndex: new Map(),
  forecastStatus: 'idle',
  forecastError: '',
  archiveDays: new Map(),
  today: null,
  loadToken: 0,
};

// ---------------------------------------------------------------- routing

export function parseHash(hash) {
  const raw = (hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const segments = path.split('/').filter(Boolean);
  const out = { view: 'day', date: null, lieu: params.get('lieu') };
  if (segments.length >= 2) {
    const [kind, value] = segments;
    if (kind === 'j' && isValidISO(value)) { out.view = 'day'; out.date = value; }
    else if (kind === 'm' && /^\d{4}-\d{2}$/.test(value)) { out.view = 'month'; out.date = `${value}-01`; }
    else if (kind === 'a' && /^\d{4}$/.test(value)) { out.view = 'year'; out.date = `${value}-01-01`; }
  } else if (segments.length === 1 && isValidISO(segments[0])) {
    out.date = segments[0];
  }
  return out;
}

export function buildHash(view, date, lieu) {
  let path;
  if (view === 'month') path = `#/m/${date.slice(0, 7)}`;
  else if (view === 'year') path = `#/a/${date.slice(0, 4)}`;
  else path = `#/j/${date}`;
  return lieu ? `${path}?lieu=${encodeURIComponent(lieu)}` : path;
}

function lieuParam(loc) {
  if (!loc) return null;
  if (state.locations.some((l) => l.slug === loc.slug)) return loc.slug;
  return `${Number(loc.lat).toFixed(4)},${Number(loc.lon).toFixed(4)}`;
}

function writeHash(replace = false) {
  const hash = buildHash(state.view, state.date, lieuParam(state.location));
  if (window.location.hash === hash) return;
  if (replace) history.replaceState(null, '', hash); else window.location.hash = hash;
}

// ---------------------------------------------------------------- helpers

/**
 * Bring a date inside the navigable range, tolerating a day that does not exist in its month
 * (a URL may carry 2026-02-29): the day is clamped to the length of the month.
 */
function clampDate(iso) {
  const match = /^(-?\d{4,})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!match) throw new RangeError(`date ISO invalide : ${iso}`);
  const y = Number(match[1]);
  const m = Math.min(12, Math.max(1, Number(match[2])));
  const d = Math.max(1, Number(match[3]));
  if (y < MIN_YEAR) return toISO(MIN_YEAR, 1, 1);
  if (y > MAX_YEAR) return toISO(MAX_YEAR, 12, 31);
  return toISO(y, m, Math.min(d, daysInMonth(y, m)));
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearestPrecomputed(loc) {
  let best = null;
  for (const candidate of state.locations) {
    const km = haversineKm(loc, candidate);
    if (km <= NEARBY_KM && (!best || km < best.km)) best = { location: candidate, km };
  }
  return best;
}

function regionFor(loc) {
  if (!runtime.data.baselines || !runtime.data.baselines.regions) return null;
  const regions = runtime.data.baselines.regions;
  let slug = loc.berkeley_region || null;
  if (!slug && loc.country_code) {
    const match = state.locations.find((l) => l.country_code === loc.country_code && l.berkeley_region);
    if (match) slug = match.berkeley_region;
  }
  if (slug && regions[slug]) return { slug, ...regions[slug] };
  return { slug, delta_c: null, note: slug ? `région ${slug} absente de baselines.json` : 'pays sans série Berkeley Earth configurée', label: slug || '' };
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function locationFromParam(param) {
  if (!param) return null;
  const known = state.locations.find((l) => l.slug === param);
  if (known) return known;
  const favorites = storeGet(KEYS.favorites) || [];
  const fav = favorites.find((l) => l.slug === param);
  if (fav) return fav;
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(param);
  if (m) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { slug: `pt-${lat.toFixed(4)},${lon.toFixed(4)}`, label: `Position ${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon, timezone: browserTimeZone(), country_code: null };
    }
  }
  return null;
}

// ---------------------------------------------------------------- data loading

async function fetchLocalJSON(path) {
  const response = await fetch(`${DATA_BASE}${path}`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${path} : HTTP ${response.status}`);
  return response.json();
}

async function fetchLocalText(path) {
  const response = await fetch(`${DATA_BASE}${path}`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${path} : HTTP ${response.status}`);
  return response.text();
}

async function loadStaticData() {
  const [saints, republican, locations, quotesText, baselines] = await Promise.all([
    fetchLocalJSON('saints.json'),
    fetchLocalJSON('republican.json'),
    fetchLocalJSON('locations.json'),
    fetchLocalText('quotes.jsonl'),
    fetchLocalJSON('baselines.json').catch(() => null),
  ]);
  runtime.data.saints = saints;
  runtime.data.republican = republican;
  state.locations = locations.locations || [];
  const parsed = parseJSONL(quotesText);
  if (parsed.errors.length) console.warn('quotes.jsonl : lignes invalides', parsed.errors);
  runtime.data.quotesAll = parsed.entries;
  runtime.data.quotesIndex = indexQuotes(parsed.entries);
  runtime.data.coverage = coverage(parsed.entries);
  runtime.data.baselines = baselines;
}

async function loadClimatology(loc, token) {
  runtime.clim = null;
  runtime.climStatus = 'loading';
  runtime.climProgress = '';
  runtime.climError = '';
  render();
  try {
    let obj = null;
    const precomputed = state.locations.find((l) => l.slug === loc.slug);
    if (precomputed) {
      runtime.climProgress = 'lecture du fichier précalculé';
      obj = await fetchLocalJSON(`climatology/${loc.slug}.json`).catch(() => null);
    }
    const key = `clim:${Number(loc.lat).toFixed(4)},${Number(loc.lon).toFixed(4)}`;
    if (!obj) obj = await idbGet(key);
    const today = runtime.today;
    const targetEnd = addDays(today, -ERA5_LAG_DAYS);
    if (obj && obj.source && obj.source.end && obj.source.end < addDays(targetEnd, -STALE_DAYS)) {
      // Stale: fetch the missing tail only.
      runtime.climProgress = `mise à jour depuis le ${formatShortFR(obj.source.end)}`;
      render();
      try {
        const tail = await fetchArchiveSeries(loc, addDays(obj.source.end, 1), targetEnd);
        if (tail.daily && tail.daily.time && tail.daily.time.length) {
          obj = extendClimatology(obj, tail.daily.time, tail.daily.temperature_2m_mean, tail.daily.time[tail.daily.time.length - 1]);
          if (!precomputed) await idbSet(key, obj);
        }
      } catch (err) {
        console.warn('mise à jour incrémentale impossible', err);
      }
    }
    if (!obj) {
      runtime.climProgress = `téléchargement ERA5 ${ERA5_START.slice(0, 4)} → ${targetEnd.slice(0, 4)}`;
      render();
      const response = await fetchArchiveSeries(loc, ERA5_START, targetEnd);
      runtime.climProgress = 'calcul des normales';
      render();
      obj = climatologyFromArchive(response, {
        slug: loc.slug, label: loc.label, lat: loc.lat, lon: loc.lon, timezone: loc.timezone,
        country_code: loc.country_code || null, elevation: loc.elevation || null, berkeley_region: loc.berkeley_region || null,
      }, { fetched_at: new Date().toISOString() });
      await idbSet(key, obj);
    }
    if (token !== runtime.loadToken) return;
    runtime.clim = new Climatology(obj);
    runtime.climStatus = 'ready';
  } catch (err) {
    if (token !== runtime.loadToken) return;
    console.error(err);
    runtime.climStatus = 'error';
    runtime.climError = err.message;
  }
  render();
}

async function loadForecast(loc, token, force = false) {
  runtime.forecastStatus = 'loading';
  runtime.forecastError = '';
  render();
  try {
    const data = await fetchForecast(loc, { force });
    if (token !== runtime.loadToken) return;
    runtime.forecast = data;
    runtime.forecastIndex = indexForecast(data);
    runtime.forecastStatus = 'ready';
  } catch (err) {
    if (token !== runtime.loadToken) return;
    runtime.forecast = null;
    runtime.forecastIndex = new Map();
    runtime.forecastStatus = 'error';
    runtime.forecastError = err.message;
  }
  render();
  loadArchiveDayIfNeeded();
}

async function loadArchiveDayIfNeeded() {
  const iso = state.date;
  const loc = state.location;
  if (!loc || !runtime.today) return;
  if (iso >= runtime.today || runtime.forecastIndex.has(iso) || iso < ERA5_START) return;
  const key = `${loc.slug}|${iso}`;
  if (runtime.archiveDays.has(key)) return;
  runtime.archiveDays.set(key, null);
  try {
    const data = await fetchArchiveDay(loc, iso);
    const index = indexForecast(data);
    runtime.archiveDays.set(key, index.get(iso) || null);
  } catch (err) {
    console.warn('archive du jour indisponible', err);
    runtime.archiveDays.delete(key);
    return;
  }
  if (state.date === iso && state.location === loc) render();
}

function reloadLocationData() {
  runtime.loadToken += 1;
  const token = runtime.loadToken;
  runtime.today = todayISO(state.location.timezone || browserTimeZone());
  runtime.archiveDays.clear();
  loadForecast(state.location, token);
  loadClimatology(state.location, token);
}

// ---------------------------------------------------------------- actions

function setDate(iso, { view } = {}) {
  state.date = clampDate(iso);
  state.quoteOffset = 0;
  state.showTranslation = false;
  if (view) state.view = view;
  writeHash();
  render();
  announce(formatLongFR(state.date));
  loadArchiveDayIfNeeded();
}

function setLocation(loc, { remember = true } = {}) {
  state.location = loc;
  if (remember) storeSet(KEYS.location, loc);
  writeHash(true);
  reloadLocationData();
  render();
}

function addFavorite(loc) {
  if (state.locations.some((l) => l.slug === loc.slug)) return;
  const favorites = (storeGet(KEYS.favorites) || []).filter((l) => l.slug !== loc.slug);
  favorites.unshift(loc);
  storeSet(KEYS.favorites, favorites.slice(0, 5));
}

function removeFavorite(slug) {
  const favorites = (storeGet(KEYS.favorites) || []).filter((l) => l.slug !== slug);
  storeSet(KEYS.favorites, favorites);
}

const actions = {
  goTo(iso) { setDate(iso, { view: 'day' }); },
  setView(view) {
    state.view = view;
    storeSet(KEYS.view, view);
    writeHash();
    render();
  },
  step(direction) {
    const { y, m, d } = parseISO(state.date);
    if (state.view === 'month') {
      const next = addMonths(y, m, direction);
      setDate(toISO(next.y, next.m, clampDay(next.y, next.m, d)));
    } else if (state.view === 'year') {
      setDate(toISO(y + direction, m, clampDay(y + direction, m, d)));
    } else {
      setDate(addDays(state.date, direction));
    }
  },
  today() { setDate(runtime.today || todayISO(browserTimeZone())); },
  toggleAuthor(author, checked) {
    const set = new Set(state.authors);
    if (checked) set.add(author); else set.delete(author);
    if (set.size === 0) set.add(author); // keep at least one author selected
    state.authors = [...set];
    state.quoteOffset = 0;
    storeSet(KEYS.authors, state.authors);
    render();
  },
  nextQuote() {
    state.quoteOffset += 1;
    state.showTranslation = false;
    render();
  },
  toggleTranslation() {
    state.showTranslation = !state.showTranslation;
    render();
  },
  setBaseline(baseline) {
    state.baseline = baseline;
    storeSet(KEYS.baseline, baseline);
    render();
  },
  retryWeather() { loadForecast(state.location, runtime.loadToken, true); },
  retryClimatology() { loadClimatology(state.location, runtime.loadToken); },
  openMethod() { openModal('Méthode et sources', renderMethod()); },
  openLocation() { openModal('Choisir un lieu', renderLocationPicker()); },
  openAbout() { openModal('À propos', renderAbout()); },
  toggleTheme() {
    const order = ['auto', 'light', 'dark'];
    state.theme = order[(order.indexOf(state.theme) + 1) % order.length];
    storeSet(KEYS.theme, state.theme);
    applyTheme();
    render();
  },
};

// ---------------------------------------------------------------- modals

function renderMethod() {
  const clim = runtime.clim;
  const delta = state.location ? regionFor(state.location) : null;
  const box = el('div', { class: 'prose' });
  box.appendChild(el('h3', { text: 'Météo et réanalyse' }));
  box.appendChild(el('p', { text: 'Prévisions, conditions actuelles et 92 derniers jours : API Open-Meteo (modèles météo nationaux combinés, sans clé). Série longue : réanalyse ERA5 (ECMWF, Copernicus Climate Change Service) via l’API d’archive Open-Meteo, modèle fixé à ERA5 pour une série homogène depuis 1940, publiée avec environ cinq jours de délai. Le point de grille utilisé peut être à quelques kilomètres du lieu.' }));
  if (clim) {
    box.appendChild(el('dl', {}, [
      kv('Lieu', `${clim.location.label} (${fmtNumber(clim.location.lat, 3)}, ${fmtNumber(clim.location.lon, 3)})`),
      kv('Point de grille', `${fmtNumber(clim.source.grid_lat, 3)}, ${fmtNumber(clim.source.grid_lon, 3)}, altitude ${fmtNumber(clim.source.grid_elevation, 0)} m`),
      kv('Période', `${formatShortFR(clim.source.start)} → ${formatShortFR(clim.source.end)}`),
      kv('Récupéré le', clim.source.fetched_at ? clim.source.fetched_at.slice(0, 10) : '–'),
    ]));
  }
  box.appendChild(el('h3', { text: 'Normale de saison et anomalies' }));
  box.appendChild(el('p', { text: `Pour chaque jour calendaire, la normale est la moyenne des températures moyennes journalières ERA5 des années ${clim ? clim.normalPeriod.join('-') : '1991-2020'} dans une fenêtre centrée de ± 7 jours (450 valeurs), ce qui lisse le bruit journalier. L’anomalie d’un jour est sa moyenne journalière moins cette normale. L’anomalie annuelle est la moyenne des anomalies journalières de l’année ; l’année en cours est partielle.` }));
  box.appendChild(el('h3', { text: 'Référence pré-industrielle (estimation)' }));
  if (delta && typeof delta.delta_c === 'number') {
    box.appendChild(el('p', { text: `L’écart au pré-industriel affiché vaut : anomalie du jour + Δ, avec Δ = ${fmtSigned(delta.delta_c)} pour la région « ${delta.label} ». Δ est la différence entre la moyenne des anomalies annuelles ${delta.ref_window.join('-')} et celle des anomalies annuelles ${delta.pre_window.join('-')} dans la série nationale Berkeley Earth (${delta.n_ref} et ${delta.n_pre} années valides ; analyse Berkeley Earth du ${delta.analysis_date}). Approximation assumée : un Δ annuel appliqué à une valeur journalière ignore la saisonnalité du réchauffement et les différences locales.` }));
    box.appendChild(el('p', {}, ['Source : ', el('a', { href: delta.source_url, target: '_blank', rel: 'noopener noreferrer', text: delta.source_url }), ` (licence ${delta.licence}).`]));
  } else {
    box.appendChild(el('p', { text: `Indisponible pour ce lieu${delta && delta.note ? ` : ${delta.note}` : ''}. Aucune constante climatique n’est codée dans l’application : la valeur vient uniquement de data/baselines.json, généré à partir des séries Berkeley Earth.` }));
  }
  box.appendChild(el('h3', { text: 'Couleurs' }));
  box.appendChild(el('p', { text: 'Palette divergente (type ColorBrewer RdBu, 11 classes), symétrique autour du zéro choisi : la normale de saison, ou le pré-industriel (les couleurs sont alors décalées de Δ). Bornes fixes : ± 2,5 °C pour les écarts annuels, ± 8 °C pour les écarts journaliers. Hachures : absence de donnée.' }));
  box.appendChild(el('h3', { text: 'Citations' }));
  box.appendChild(el('p', { text: 'Chaque citation affichée porte une source et a été vérifiée par un mainteneur ; le texte est celui de la source, jamais reformulé. Elles sont reproduites à fins d’information et de documentation, sans commentaire éditorial et sans affiliation avec les personnes citées.' }));
  return box;
}

function renderAbout() {
  const cov = runtime.data.coverage;
  const box = el('div', { class: 'prose' });
  box.appendChild(el('p', { text: 'Éphéméride climatique : un calendrier perpétuel qui met côte à côte la journée classique (soleil, lune, saint, fêtes, calendrier républicain), une citation datée et la météo du jour replacée dans le climat depuis 1940.' }));
  if (cov) {
    box.appendChild(el('h3', { text: 'Base de citations' }));
    box.appendChild(el('dl', {}, [
      kv('Citations vérifiées', String(cov.verified)),
      kv('Jours couverts', `${cov.covered} / ${cov.total}`),
      ...Object.entries(cov.byAuthor).map(([author, c]) => kv(author === 'trump' ? 'Donald Trump' : 'Elon Musk', `${c.entries} citation${c.entries > 1 ? 's' : ''}, ${c.days} jour${c.days > 1 ? 's' : ''}`)),
    ]));
  }
  box.appendChild(el('h3', { text: 'Données et licences' }));
  box.appendChild(el('ul', {}, [
    el('li', {}, ['Météo et réanalyse : ', el('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Open-Meteo' }), ' (données ERA5 du Copernicus Climate Change Service, ECMWF).']),
    el('li', {}, ['Référence pré-industrielle : ', el('a', { href: 'https://berkeleyearth.org/data/', target: '_blank', rel: 'noopener noreferrer', text: 'Berkeley Earth' }), ', licence CC BY-NC 4.0 (usage non commercial).']),
    el('li', {}, ['Géocodage : Open-Meteo, données ', el('a', { href: 'https://www.geonames.org/', target: '_blank', rel: 'noopener noreferrer', text: 'GeoNames' }), '.']),
    el('li', { text: 'Calendrier des saints et noms des jours républicains : relevés sur Wikipédia (CC BY-SA 4.0), sources indiquées dans les fichiers de données.' }),
  ]));
  box.appendChild(el('p', {}, [
    el('a', { href: 'README.md', text: 'Documentation' }), ' · ', el('a', { href: 'CONTRIBUTING.md', text: 'Ajouter une citation' }),
  ]));
  return box;
}

function renderLocationPicker() {
  const box = el('div', { class: 'location-picker' });
  const input = el('input', { type: 'search', placeholder: 'Ville (3 lettres minimum)', 'aria-label': 'Rechercher une ville', autocomplete: 'off' });
  const results = el('ul', { class: 'results', 'aria-live': 'polite' });
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) {
      clear(results);
      return;
    }
    timer = setTimeout(async () => {
      clear(results);
      results.appendChild(el('li', { class: 'muted', text: 'Recherche…' }));
      try {
        const found = await geocode(q);
        clear(results);
        if (!found.length) results.appendChild(el('li', { class: 'muted', text: 'Aucun résultat.' }));
        for (const loc of found) {
          results.appendChild(el('li', {}, [el('button', {
            type: 'button', class: 'btn btn-block', onclick: () => {
              addFavorite(loc);
              closeModal();
              setLocation(loc);
              toast(`Lieu : ${loc.label}`);
            },
            text: `${loc.label}${loc.admin1 ? `, ${loc.admin1}` : ''}${loc.country ? ` (${loc.country})` : ''}`,
          })]));
        }
      } catch (err) {
        clear(results);
        results.appendChild(el('li', { class: 'error', text: `Recherche impossible : ${err.message}` }));
      }
    }, 300);
  });
  box.appendChild(el('div', { class: 'field' }, [input]));
  box.appendChild(results);

  const geoButton = el('button', {
    type: 'button', class: 'btn', text: '📍 Utiliser ma position',
    onclick: () => {
      if (!navigator.geolocation) {
        toast('Géolocalisation indisponible dans ce navigateur', { type: 'error' });
        return;
      }
      geoButton.disabled = true;
      navigator.geolocation.getCurrentPosition((pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const near = nearestPrecomputed({ lat, lon });
        const loc = near
          ? { ...near.location, label: `${near.location.label} (à ${fmtNumber(near.km, 0)} km de ma position)` }
          : { slug: `pt-${lat.toFixed(4)},${lon.toFixed(4)}`, label: `Ma position (${lat.toFixed(3)}, ${lon.toFixed(3)})`, lat, lon, timezone: browserTimeZone(), country_code: null };
        closeModal();
        setLocation(loc);
        toast(near ? `Lieu précalculé le plus proche : ${near.location.label}` : 'Calcul de la climatologie pour votre position…');
      }, (err) => {
        geoButton.disabled = false;
        toast(`Position refusée ou indisponible (${err.message})`, { type: 'error' });
      }, { timeout: 15000, maximumAge: 600000 });
    },
  });
  box.appendChild(el('div', { class: 'picker-section' }, [geoButton]));

  box.appendChild(el('h3', { text: 'Lieux précalculés' }));
  box.appendChild(el('ul', { class: 'results' }, state.locations.map((loc) => el('li', {}, [el('button', {
    type: 'button', class: 'btn btn-block', onclick: () => { closeModal(); setLocation(loc); },
    text: `${loc.label}${loc.admin1 ? `, ${loc.admin1}` : ''}${loc.country ? ` (${loc.country})` : ''}`,
  })]))));

  const favorites = storeGet(KEYS.favorites) || [];
  if (favorites.length) {
    box.appendChild(el('h3', { text: 'Mes lieux' }));
    box.appendChild(el('ul', { class: 'results' }, favorites.map((loc) => el('li', { class: 'fav' }, [
      el('button', { type: 'button', class: 'btn btn-block', onclick: () => { closeModal(); setLocation(loc); }, text: `${loc.label}${loc.country ? ` (${loc.country})` : ''}` }),
      el('button', { type: 'button', class: 'btn btn-icon', 'aria-label': `Retirer ${loc.label}`, text: '✕', onclick: (e) => { removeFavorite(loc.slug); e.target.closest('li').remove(); } }),
    ]))));
  }
  setTimeout(() => input.focus(), 50);
  return box;
}

// ---------------------------------------------------------------- render

function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', state.theme);
}

function renderHeader() {
  const views = [['day', 'Jour'], ['month', 'Mois'], ['year', 'Année']];
  const { y, m, d } = parseISO(state.date);
  const themeLabel = { auto: 'Thème : auto', light: 'Thème : clair', dark: 'Thème : sombre' }[state.theme];
  return el('header', { class: 'topbar' }, [
    el('div', { class: 'brand' }, [
      el('button', { type: 'button', class: 'link brand-link', onclick: () => actions.openAbout(), text: 'Éphéméride climatique' }),
    ]),
    el('nav', { class: 'nav', 'aria-label': 'Navigation' }, [
      el('div', { class: 'seg', role: 'tablist' }, views.map(([id, label]) => el('button', {
        type: 'button', role: 'tab', class: `seg-btn${state.view === id ? ' is-active' : ''}`,
        'aria-selected': state.view === id ? 'true' : 'false', onclick: () => actions.setView(id), text: label,
      }))),
      el('div', { class: 'date-nav' }, [
        el('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Précédent', onclick: () => actions.step(-1), text: '◄' }),
        el('input', {
          type: 'date', class: 'date-input', 'aria-label': 'Choisir une date', value: state.date,
          min: `${MIN_YEAR}-01-01`, max: `${MAX_YEAR}-12-31`,
          onchange: (e) => { if (isValidISO(e.target.value)) setDate(e.target.value); },
        }),
        el('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Suivant', onclick: () => actions.step(1), text: '►' }),
        el('button', { type: 'button', class: 'btn', onclick: () => actions.today(), text: 'Aujourd’hui' }),
      ]),
      el('div', { class: 'tools' }, [
        el('button', { type: 'button', class: 'btn', onclick: () => actions.openLocation(), text: `📍 ${state.location ? state.location.label : 'Lieu'}` }),
        el('button', { type: 'button', class: 'btn btn-icon', 'aria-label': themeLabel, title: themeLabel, onclick: () => actions.toggleTheme(), text: state.theme === 'dark' ? '☾' : state.theme === 'light' ? '☀' : '◐' }),
      ]),
    ]),
    el('p', { class: 'sr-only', text: `${d}/${m}/${y}` }),
  ]);
}

function renderFooter() {
  return el('footer', { class: 'footer' }, [
    el('p', {}, [
      'Météo et réanalyse ERA5 : ', el('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Open-Meteo' }),
      ' (Copernicus Climate Change Service, ECMWF) · Référence pré-industrielle : ',
      el('a', { href: 'https://berkeleyearth.org/', target: '_blank', rel: 'noopener noreferrer', text: 'Berkeley Earth' }), ' (CC BY-NC 4.0) · Lieux : GeoNames.',
    ]),
    el('p', { class: 'muted small', text: 'Les citations sont reproduites à fins d’information avec leur source, sans affiliation ni commentaire. Application non commerciale, sans suivi ni cookie.' }),
    el('p', { class: 'muted small' }, [
      el('button', { type: 'button', class: 'link', onclick: () => actions.openMethod(), text: 'Méthode et sources' }), ' · ',
      el('button', { type: 'button', class: 'link', onclick: () => actions.openAbout(), text: 'À propos' }), ' · ',
      el('a', { href: 'CONTRIBUTING.md', text: 'Contribuer' }),
    ]),
  ]);
}

function buildContext() {
  const archiveKey = state.location ? `${state.location.slug}|${state.date}` : '';
  return {
    state,
    data: runtime.data,
    clim: runtime.clim,
    climStatus: runtime.climStatus,
    climProgress: runtime.climProgress,
    climError: runtime.climError,
    forecast: runtime.forecast,
    forecastIndex: runtime.forecastIndex,
    forecastStatus: runtime.forecastStatus,
    forecastError: runtime.forecastError,
    archiveDay: runtime.archiveDays.get(archiveKey) || null,
    regionDelta: state.location ? regionFor(state.location) : null,
    today: runtime.today,
    actions,
  };
}

let renderScheduled = false;
function render() {
  if (renderScheduled) return;
  renderScheduled = true;
  Promise.resolve().then(() => {
    renderScheduled = false;
    renderNow();
  });
}

function renderNow() {
  const app = document.getElementById('app');
  if (!app || !state.date || !state.location) return;
  const ctx = buildContext();
  let view;
  try {
    view = state.view === 'month' ? renderMonth(ctx) : state.view === 'year' ? renderYear(ctx) : renderDay(ctx);
  } catch (err) {
    console.error(err);
    view = el('p', { class: 'error', text: `Affichage impossible : ${err.message}` });
  }
  clear(app);
  app.appendChild(renderHeader());
  app.appendChild(el('main', { id: 'main' }, [view]));
  app.appendChild(renderFooter());
}

// ---------------------------------------------------------------- init

function restorePreferences() {
  const authors = storeGet(KEYS.authors);
  if (Array.isArray(authors) && authors.length) state.authors = authors.filter((a) => a === 'trump' || a === 'musk');
  if (!state.authors.length) state.authors = ['trump', 'musk'];
  const baseline = storeGet(KEYS.baseline);
  if (baseline === 'preindustrial' || baseline === 'normal') state.baseline = baseline;
  const theme = storeGet(KEYS.theme);
  if (theme === 'light' || theme === 'dark' || theme === 'auto') state.theme = theme;
  applyTheme();
}

function onHashChange() {
  const parsed = parseHash(window.location.hash);
  const requested = locationFromParam(parsed.lieu);
  if (requested && (!state.location || requested.slug !== state.location.slug)) {
    setLocation(requested, { remember: false });
  }
  const changedView = parsed.view !== state.view;
  const changedDate = parsed.date && parsed.date !== state.date;
  if (changedView) state.view = parsed.view;
  if (changedDate) {
    state.date = clampDate(parsed.date);
    state.quoteOffset = 0;
    state.showTranslation = false;
  }
  if (changedView || changedDate) {
    render();
    loadArchiveDayIfNeeded();
  }
}

function onKeyDown(event) {
  const target = event.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  if (document.body.classList.contains('has-modal')) return;
  if (event.key === 'ArrowLeft') { actions.step(-1); event.preventDefault(); }
  else if (event.key === 'ArrowRight') { actions.step(1); event.preventDefault(); }
  else if (event.key === 't' || event.key === 'T') { actions.today(); }
}

export async function init() {
  const app = document.getElementById('app');
  restorePreferences();
  try {
    await loadStaticData();
  } catch (err) {
    console.error(err);
    if (app) {
      clear(app);
      app.appendChild(el('p', { class: 'error', text: `Impossible de charger les données de l’application : ${err.message}` }));
    }
    return;
  }
  const parsed = parseHash(window.location.hash);
  const fromParam = locationFromParam(parsed.lieu);
  const remembered = storeGet(KEYS.location);
  state.location = fromParam || remembered || state.locations[0] || {
    slug: 'defaut', label: 'Lieu par défaut', lat: 45.17869, lon: 5.71479, timezone: 'Europe/Paris',
  };
  runtime.today = todayISO(state.location.timezone || browserTimeZone());
  const hasHash = window.location.hash.replace(/^#\/?/, '').trim().length > 0;
  const savedView = storeGet(KEYS.view);
  state.view = hasHash ? parsed.view : (savedView === 'month' || savedView === 'year' ? savedView : 'day');
  state.date = parsed.date ? clampDate(parsed.date) : runtime.today;
  writeHash(true);
  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('keydown', onKeyDown);
  render();
  reloadLocationData();
}

if (typeof document !== 'undefined' && document.getElementById('app') && !globalThis.__EC_NO_AUTOSTART__) {
  init();
}

export { state, runtime, actions, regionFor, nearestPrecomputed, clampDate };
