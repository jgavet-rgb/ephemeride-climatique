// Open-Meteo access (forecast, archive, geocoding), request caching and the merge rule
// choosing the temperature source for a given date (DATA_FORMATS / prompt section 6.2).
// The only network endpoints of the application live in this file.

import { storeGet, storeSet } from './storage.js';

export const ENDPOINTS = Object.freeze({
  forecast: 'https://api.open-meteo.com/v1/forecast',
  archive: 'https://archive-api.open-meteo.com/v1/archive',
  geocoding: 'https://geocoding-api.open-meteo.com/v1/search',
});

export const FORECAST_DAILY = [
  'temperature_2m_mean', 'temperature_2m_max', 'temperature_2m_min', 'weather_code',
  'precipitation_sum', 'sunrise', 'sunset', 'daylight_duration',
];
export const FORECAST_CURRENT = ['temperature_2m', 'relative_humidity_2m', 'weather_code', 'wind_speed_10m', 'is_day'];
export const ARCHIVE_DAY_DAILY = ['temperature_2m_mean', 'temperature_2m_max', 'temperature_2m_min', 'weather_code', 'precipitation_sum'];

const FORECAST_TTL_MS = 60 * 60 * 1000; // one hour
const ARCHIVE_DAY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // a past day does not change

function coord(x) {
  return Number(x).toFixed(4);
}

export function buildForecastURL(loc, { pastDays = 92, forecastDays = 16 } = {}) {
  const params = new URLSearchParams({
    latitude: coord(loc.lat),
    longitude: coord(loc.lon),
    timezone: 'auto',
    past_days: String(pastDays),
    forecast_days: String(forecastDays),
    current: FORECAST_CURRENT.join(','),
    daily: FORECAST_DAILY.join(','),
  });
  return `${ENDPOINTS.forecast}?${params}`;
}

export function buildArchiveURL(loc, start, end, { daily = ['temperature_2m_mean'], models = 'era5' } = {}) {
  const params = new URLSearchParams({
    latitude: coord(loc.lat),
    longitude: coord(loc.lon),
    start_date: start,
    end_date: end,
    daily: daily.join(','),
    timezone: 'auto',
    models,
  });
  return `${ENDPOINTS.archive}?${params}`;
}

export function buildGeocodingURL(query, { count = 8, language = 'fr' } = {}) {
  const params = new URLSearchParams({ name: query, count: String(count), language, format: 'json' });
  return `${ENDPOINTS.geocoding}?${params}`;
}

/** fetch + JSON with timeout and a single retry; throws an Error with a French message. */
export async function fetchJSON(url, { timeoutMs = 20000, retries = 1, fetchImpl = globalThis.fetch } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(url, { signal: controller ? controller.signal : undefined });
      if (!response.ok) {
        let reason = '';
        try {
          const body = await response.json();
          reason = body && body.reason ? ` : ${body.reason}` : '';
        } catch {
          // no JSON body
        }
        throw new Error(`Open-Meteo a répondu ${response.status}${reason}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err && err.name === 'AbortError' ? new Error('Open-Meteo ne répond pas (délai dépassé)') : err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || new Error('Open-Meteo injoignable');
}

function cacheKey(prefix, loc, extra = '') {
  return `${prefix}:${coord(loc.lat)},${coord(loc.lon)}${extra ? `:${extra}` : ''}`;
}

function readCached(key, ttlMs, session) {
  const hit = storeGet(key, { session });
  if (hit && typeof hit.at === 'number' && Date.now() - hit.at < ttlMs && hit.data) return hit.data;
  return null;
}

/** Forecast, current conditions and the last 92 days for a location (1 h cache). */
export async function fetchForecast(loc, opts = {}) {
  const key = cacheKey('forecast', loc);
  const cached = opts.force ? null : readCached(key, FORECAST_TTL_MS, true);
  if (cached) return cached;
  const data = await fetchJSON(buildForecastURL(loc), opts);
  storeSet(key, { at: Date.now(), data }, { session: true });
  return data;
}

/** One past day (ERA5) with min/max, weather code and precipitation (30-day cache). */
export async function fetchArchiveDay(loc, iso, opts = {}) {
  const key = cacheKey('archive-day', loc, iso);
  const cached = readCached(key, ARCHIVE_DAY_TTL_MS, false);
  if (cached) return cached;
  const data = await fetchJSON(buildArchiveURL(loc, iso, iso, { daily: ARCHIVE_DAY_DAILY }), opts);
  storeSet(key, { at: Date.now(), data });
  return data;
}

/** Full daily mean series for a location (no cache here: the caller stores the climatology). */
export async function fetchArchiveSeries(loc, start, end, opts = {}) {
  return fetchJSON(buildArchiveURL(loc, start, end), { timeoutMs: 60000, ...opts });
}

/** Geocoding search; returns normalised location candidates. */
export async function geocode(query, opts = {}) {
  const text = String(query || '').trim();
  if (text.length < 2) return [];
  const data = await fetchJSON(buildGeocodingURL(text), opts);
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map((r) => ({
    slug: `geo-${r.id}`,
    geocoding_id: r.id,
    label: r.name,
    admin1: r.admin1 || '',
    country: r.country || '',
    country_code: r.country_code || '',
    lat: r.latitude,
    lon: r.longitude,
    elevation: r.elevation,
    timezone: r.timezone,
    population: r.population || 0,
  }));
}

/** Local ISO time string from Open-Meteo ("2026-09-17T07:17") + fixed offset -> UTC Date. */
export function localToUTC(localISO, utcOffsetSeconds) {
  if (!localISO) return null;
  const [datePart, timePart = '00:00'] = localISO.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - utcOffsetSeconds * 1000);
}

/** Index a forecast response by ISO date -> { mean, max, min, code, precipitation, sunrise, sunset, daylight }. */
export function indexForecast(forecast) {
  const out = new Map();
  const daily = forecast && forecast.daily;
  if (!daily || !Array.isArray(daily.time)) return out;
  const offset = forecast.utc_offset_seconds || 0;
  daily.time.forEach((iso, i) => {
    const pickValue = (name) => (Array.isArray(daily[name]) ? daily[name][i] : null);
    let mean = pickValue('temperature_2m_mean');
    const max = pickValue('temperature_2m_max');
    const min = pickValue('temperature_2m_min');
    let meanApprox = false;
    if ((mean === null || mean === undefined) && max !== null && min !== null && max !== undefined && min !== undefined) {
      mean = (max + min) / 2;
      meanApprox = true;
    }
    out.set(iso, {
      iso,
      mean: mean === undefined ? null : mean,
      meanApprox,
      max: max === undefined ? null : max,
      min: min === undefined ? null : min,
      code: pickValue('weather_code'),
      precipitation: pickValue('precipitation_sum'),
      sunrise: localToUTC(pickValue('sunrise'), offset),
      sunset: localToUTC(pickValue('sunset'), offset),
      daylight: pickValue('daylight_duration'),
    });
  });
  return out;
}

export const SOURCE_LABELS = Object.freeze({
  era5: 'observé (réanalyse ERA5)',
  forecast_past: 'observé (provisoire)',
  today: 'aujourd’hui (prévu)',
  forecast: 'prévu',
  none: 'hors données',
});

/**
 * Merge rule for the daily mean temperature of a date.
 * climatologyValue: ERA5 value (Celsius) or null; forecastDay: entry from indexForecast or undefined.
 */
export function resolveDay(iso, todayISO, climatologyValue, forecastDay) {
  if (climatologyValue !== null && climatologyValue !== undefined) {
    return { value: climatologyValue, source: 'era5', label: SOURCE_LABELS.era5 };
  }
  if (forecastDay && forecastDay.mean !== null && forecastDay.mean !== undefined) {
    let source = 'forecast';
    if (iso < todayISO) source = 'forecast_past';
    else if (iso === todayISO) source = 'today';
    return { value: forecastDay.mean, source, label: SOURCE_LABELS[source], approx: forecastDay.meanApprox };
  }
  return { value: null, source: 'none', label: SOURCE_LABELS.none };
}

/** WMO weather interpretation codes -> French label and a simple icon. */
export function weatherCodeInfo(code, isDay = true) {
  const table = {
    0: ['ciel dégagé', isDay ? '☀️' : '🌙'],
    1: ['plutôt dégagé', isDay ? '🌤️' : '🌙'],
    2: ['partiellement nuageux', '⛅'],
    3: ['couvert', '☁️'],
    45: ['brouillard', '🌫️'],
    48: ['brouillard givrant', '🌫️'],
    51: ['bruine légère', '🌦️'],
    53: ['bruine', '🌦️'],
    55: ['bruine dense', '🌧️'],
    56: ['bruine verglaçante', '🌧️'],
    57: ['bruine verglaçante dense', '🌧️'],
    61: ['pluie faible', '🌧️'],
    63: ['pluie', '🌧️'],
    65: ['pluie forte', '🌧️'],
    66: ['pluie verglaçante', '🌧️'],
    67: ['pluie verglaçante forte', '🌧️'],
    71: ['neige faible', '🌨️'],
    73: ['neige', '🌨️'],
    75: ['neige forte', '❄️'],
    77: ['grains de neige', '🌨️'],
    80: ['averses faibles', '🌦️'],
    81: ['averses', '🌧️'],
    82: ['averses violentes', '⛈️'],
    85: ['averses de neige', '🌨️'],
    86: ['fortes averses de neige', '❄️'],
    95: ['orage', '⛈️'],
    96: ['orage avec grêle', '⛈️'],
    99: ['orage avec forte grêle', '⛈️'],
  };
  const entry = table[code];
  if (!entry) return { label: 'conditions inconnues', icon: '🌡️' };
  return { label: entry[0], icon: entry[1] };
}
