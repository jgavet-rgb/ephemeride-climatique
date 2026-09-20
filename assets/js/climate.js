// Climatology: normals, anomalies, records, ranks (DATA_FORMATS.md, section 1).
// The build functions reproduce scripts/climatology_core.py to the last bit: same
// iteration order, same float accumulation, same rounding. Pure functions only.

import { KEYS, keyIndex } from './dates.js';

export const SCHEMA_VERSION = 1;
export const DEFAULT_NORMAL_PERIOD = [1991, 2020];
export const DEFAULT_WINDOW_DAYS = 7;
export const PARTIAL_THRESHOLD_DAYS = 360;
const RING = 366;

const LOCATION_KEYS = ['slug', 'label', 'lat', 'lon', 'timezone', 'country_code', 'elevation', 'berkeley_region'];
const SOURCE_KEYS = ['provider', 'endpoint', 'model', 'dataset', 'grid_lat', 'grid_lon', 'grid_elevation', 'fetched_at', 'start', 'end', 'variable'];
const SOURCE_DEFAULTS = {
  provider: 'Open-Meteo',
  endpoint: 'https://archive-api.open-meteo.com/v1/archive',
  model: 'era5',
  dataset: 'ERA5 (ECMWF, Copernicus Climate Change Service)',
  variable: 'temperature_2m_mean',
};

/** Shared rounding rule: floor(x * 100 + 0.5) / 100. */
export function round2(x) {
  return Math.floor(x * 100 + 0.5) / 100;
}

/** Celsius -> integer tenths, half away from zero; null when missing. */
export function toTenths(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
  const x = Number(v);
  const tenths = x >= 0 ? Math.floor(x * 10 + 0.5) : -Math.floor(-x * 10 + 0.5);
  return tenths === 0 ? 0 : tenths; // normalise -0
}

export function emptyYear() {
  return new Array(RING).fill(null);
}

/** Insert a daily series (ISO dates, Celsius or null) into daily (Map year -> array). */
export function mergeSeries(daily, times, values) {
  if (times.length !== values.length) {
    throw new RangeError(`séries de longueurs différentes : ${times.length} dates, ${values.length} valeurs`);
  }
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (typeof t !== 'string' || t.length < 10) throw new RangeError(`date invalide dans la série : ${t}`);
    const year = Number(t.slice(0, 4));
    const index = keyIndex(t.slice(5, 10));
    let row = daily.get(year);
    if (!row) {
      row = emptyYear();
      daily.set(year, row);
    }
    row[index] = toTenths(values[i]);
  }
  return daily;
}

export function seriesToDaily(times, values) {
  return mergeSeries(new Map(), times, values);
}

/** Rebuild the daily Map from the JSON section (string years -> arrays). */
export function dailyFromJSON(obj) {
  const daily = new Map();
  for (const [yearText, row] of Object.entries(obj)) {
    if (!Array.isArray(row) || row.length !== RING) {
      throw new RangeError(`année ${yearText} : tableau de ${RING} entrées attendu`);
    }
    daily.set(Number(yearText), row.map((v) => (v === null ? null : Number(v))));
  }
  return daily;
}

function sortedYears(daily) {
  return [...daily.keys()].sort((a, b) => a - b);
}

export function computeNormals(daily, period = DEFAULT_NORMAL_PERIOD, windowDays = DEFAULT_WINDOW_DAYS) {
  const years = sortedYears(daily).filter((y) => y >= period[0] && y <= period[1]);
  const mean = [];
  const std = [];
  for (let index = 0; index < RING; index++) {
    const sample = [];
    for (const year of years) {
      const row = daily.get(year);
      for (let k = -windowDays; k <= windowDays; k++) {
        const value = row[(((index + k) % RING) + RING) % RING];
        if (value !== null) sample.push(value / 10);
      }
    }
    if (sample.length === 0) {
      mean.push(null);
      std.push(null);
      continue;
    }
    const count = sample.length;
    let total = 0.0;
    for (const v of sample) total += v;
    const m = total / count;
    let squares = 0.0;
    for (const v of sample) {
      const delta = v - m;
      squares += delta * delta;
    }
    mean.push(round2(m));
    std.push(round2(Math.sqrt(squares / count)));
  }
  return { mean, std };
}

export function computeAnnual(daily, normalMean) {
  const entries = [];
  for (const year of sortedYears(daily)) {
    const row = daily.get(year);
    let total = 0.0;
    let count = 0;
    let anomalyTotal = 0.0;
    let anomalyCount = 0;
    for (let index = 0; index < RING; index++) {
      const value = row[index];
      if (value === null) continue;
      const celsius = value / 10;
      total += celsius;
      count += 1;
      const normal = normalMean[index];
      if (normal !== null && normal !== undefined) {
        anomalyTotal += celsius - normal;
        anomalyCount += 1;
      }
    }
    entries.push({
      year,
      mean: count ? round2(total / count) : null,
      anomaly: anomalyCount ? round2(anomalyTotal / anomalyCount) : null,
      days: count,
      partial: count < PARTIAL_THRESHOLD_DAYS,
    });
  }
  return entries;
}

export function computeRecords(daily) {
  const years = sortedYears(daily);
  const max = [];
  const min = [];
  for (let index = 0; index < RING; index++) {
    let bestMax = null;
    let yearMax = null;
    let bestMin = null;
    let yearMin = null;
    for (const year of years) {
      const value = daily.get(year)[index];
      if (value === null) continue;
      if (bestMax === null || value > bestMax) {
        bestMax = value;
        yearMax = year;
      }
      if (bestMin === null || value < bestMin) {
        bestMin = value;
        yearMin = year;
      }
    }
    max.push([bestMax === null ? null : bestMax / 10, yearMax]);
    min.push([bestMin === null ? null : bestMin / 10, yearMin]);
  }
  return { max, min };
}

function pick(source, keys, defaults = {}) {
  const out = {};
  for (const key of keys) {
    out[key] = source[key] !== undefined ? source[key] : (defaults[key] !== undefined ? defaults[key] : null);
  }
  return out;
}

/** Full climatology structure from the daily Map (mirrors compute_climatology). */
export function computeClimatology(daily, location, source, period = DEFAULT_NORMAL_PERIOD, windowDays = DEFAULT_WINDOW_DAYS) {
  const { mean, std } = computeNormals(daily, period, windowDays);
  const dailyJSON = {};
  for (const year of sortedYears(daily)) dailyJSON[String(year)] = [...daily.get(year)];
  return {
    schema_version: SCHEMA_VERSION,
    location: pick(location, LOCATION_KEYS),
    source: pick(source, SOURCE_KEYS, SOURCE_DEFAULTS),
    normal_period: [Number(period[0]), Number(period[1])],
    window_days: Number(windowDays),
    keys: [...KEYS],
    normal_mean: mean,
    normal_std: std,
    records: computeRecords(daily),
    annual: computeAnnual(daily, mean),
    daily: dailyJSON,
  };
}

/** Pure entry point: daily series -> climatology object. */
export function buildClimatology(times, values, location, source, period, windowDays) {
  return computeClimatology(seriesToDaily(times, values), location, source, period, windowDays);
}

/** Read-only accessor around a climatology object (file or freshly built). */
export class Climatology {
  constructor(obj) {
    if (!obj || obj.schema_version !== SCHEMA_VERSION) {
      throw new RangeError('fichier de climatologie incompatible');
    }
    this.raw = obj;
    this.daily = dailyFromJSON(obj.daily);
    this.years = sortedYears(this.daily);
  }

  get location() { return this.raw.location; }
  get source() { return this.raw.source; }
  get normalPeriod() { return this.raw.normal_period; }
  get firstYear() { return this.years[0]; }
  get lastYear() { return this.years[this.years.length - 1]; }
  get lastDate() { return this.raw.source.end; }

  normal(index) { return this.raw.normal_mean[index]; }
  std(index) { return this.raw.normal_std[index]; }

  /** Anomaly of a Celsius value on the given ring index (null when no normal). */
  anomaly(index, value) {
    const normal = this.normal(index);
    if (normal === null || value === null || value === undefined) return null;
    return value - normal;
  }

  /** Observed daily mean (Celsius) for a year and ring index, or null. */
  dayValue(year, index) {
    const row = this.daily.get(year);
    if (!row) return null;
    const v = row[index];
    return v === null ? null : v / 10;
  }

  /** Observed value for an ISO date, or null when missing. */
  valueOn(iso) {
    return this.dayValue(Number(iso.slice(0, 4)), keyIndex(iso.slice(5, 10)));
  }

  /** Same calendar day across all years: [{ year, value, anomaly }]. */
  daySeries(index) {
    const out = [];
    for (const year of this.years) {
      const value = this.dayValue(year, index);
      out.push({ year, value, anomaly: value === null ? null : this.anomaly(index, value) });
    }
    return out;
  }

  /** Warm rank of a value among the observed years for this ring index. */
  rank(index, value) {
    let warmer = 0;
    let n = 0;
    for (const year of this.years) {
      const v = this.dayValue(year, index);
      if (v === null) continue;
      n += 1;
      if (v > value) warmer += 1;
    }
    return { rank: warmer + 1, n };
  }

  records(index) {
    const [maxValue, maxYear] = this.raw.records.max[index];
    const [minValue, minYear] = this.raw.records.min[index];
    return { max: { value: maxValue, year: maxYear }, min: { value: minValue, year: minYear } };
  }

  /** Annual entries [{ year, mean, anomaly, days, partial }]. */
  annualSeries() {
    return this.raw.annual;
  }

  /** Standard score of a value relative to the normal window spread (null without std). */
  zScore(index, value) {
    const std = this.std(index);
    const anomaly = this.anomaly(index, value);
    if (std === null || std === 0 || anomaly === null) return null;
    return anomaly / std;
  }

  /** Daily anomalies of a year for the ring (null where missing). */
  yearAnomalies(year) {
    const row = this.daily.get(year);
    if (!row) return null;
    return row.map((v, index) => (v === null ? null : this.anomaly(index, v / 10)));
  }
}

/** Convert a raw Open-Meteo archive response into a climatology object. */
export function climatologyFromArchive(response, location, extra = {}) {
  const times = response.daily && response.daily.time;
  const values = response.daily && response.daily.temperature_2m_mean;
  if (!Array.isArray(times) || !Array.isArray(values)) {
    throw new RangeError('réponse d’archive inattendue');
  }
  const source = {
    grid_lat: response.latitude,
    grid_lon: response.longitude,
    grid_elevation: response.elevation,
    fetched_at: extra.fetched_at || null,
    start: times[0] || null,
    end: times[times.length - 1] || null,
  };
  return buildClimatology(times, values, location, source);
}

/** Merge new daily values into an existing climatology object and recompute derived sections. */
export function extendClimatology(obj, times, values, end) {
  const daily = dailyFromJSON(obj.daily);
  mergeSeries(daily, times, values);
  const source = { ...obj.source, end: end || obj.source.end };
  return computeClimatology(daily, obj.location, source, obj.normal_period, obj.window_days);
}
