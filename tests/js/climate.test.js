import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildClimatology, Climatology, round2, toTenths, seriesToDaily, computeNormals, extendClimatology,
} from '../../assets/js/climate.js';
import { KEYS, toISO, addDays } from '../../assets/js/dates.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');
const loadJSON = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));

test('round2 and toTenths follow the shared conventions', () => {
  assert.equal(round2(1.006), 1.01);
  assert.equal(round2(-1.236), -1.24);
  assert.equal(round2(-1.234), -1.23);
  assert.equal(round2(2.676), 2.68);
  assert.equal(round2(2.674), 2.67);
  assert.equal(round2(0.125), 0.13);
  // Binary representation traps are shared with the Python implementation (same floor rule).
  assert.equal(round2(1.005), 1);
  assert.equal(toTenths(21.85), 219);
  assert.equal(toTenths(-0.05), -1);
  assert.equal(toTenths(-0.04), 0);
  assert.equal(toTenths(null), null);
  assert.equal(toTenths(undefined), null);
});

test('synthetic series reproduces the Python expected output exactly', () => {
  const series = loadJSON('synthetic_series.json');
  const expected = loadJSON('synthetic_climatology_expected.json');
  const result = buildClimatology(series.time, series.temperature_2m_mean, expected.location, expected.source);
  assert.deepEqual(result.keys, expected.keys);
  assert.deepEqual(result.normal_mean, expected.normal_mean);
  assert.deepEqual(result.normal_std, expected.normal_std);
  assert.deepEqual(result.records, expected.records);
  assert.deepEqual(result.annual, expected.annual);
  assert.deepEqual(result.daily, expected.daily);
  assert.deepEqual(result, expected);
});

function constantSeries(start, end, value) {
  const times = [];
  const values = [];
  let iso = start;
  while (iso <= end) {
    times.push(iso);
    values.push(value);
    iso = addDays(iso, 1);
  }
  return { times, values };
}

test('constant series: normals equal the constant, anomalies vanish, records first year', () => {
  const { times, values } = constantSeries('1990-01-01', '2021-12-31', 12.0);
  const clim = buildClimatology(times, values, { slug: 'test' }, {});
  assert.equal(clim.normal_mean.every((v) => v === 12), true);
  assert.equal(clim.normal_std.every((v) => v === 0), true);
  assert.deepEqual(clim.records.max[0], [12, 1990]);
  assert.deepEqual(clim.records.max[59], [12, 1992]); // first leap year with a 29 February
  for (const entry of clim.annual) {
    assert.equal(entry.anomaly, 0);
    assert.equal(entry.mean, 12);
    assert.equal(entry.partial, false);
    assert.equal(entry.days, entry.year % 4 === 0 ? 366 : 365);
  }
});

test('29 February slot is null on common years and filled on leap years', () => {
  const { times, values } = constantSeries('1999-01-01', '2000-12-31', 5.5);
  const daily = seriesToDaily(times, values);
  assert.equal(daily.get(1999)[59], null);
  assert.equal(daily.get(2000)[59], 55);
  assert.equal(daily.get(2000).length, 366);
});

test('a series ending mid-year marks the last year as partial', () => {
  const { times, values } = constantSeries('2019-01-01', '2021-06-30', 10);
  const clim = buildClimatology(times, values, {}, {});
  const last = clim.annual[clim.annual.length - 1];
  assert.equal(last.year, 2021);
  assert.equal(last.partial, true);
  assert.equal(last.days, 181);
});

test('normals use a +/-7 day ring window across the year boundary', () => {
  // A single year in the reference period with a spike on 31 December.
  const { times, values } = constantSeries('2000-01-01', '2000-12-31', 0);
  values[values.length - 1] = 15; // 31 December
  const daily = seriesToDaily(times, values);
  const { mean } = computeNormals(daily, [2000, 2000], 7);
  // Index 0 (01-01) sees 31-12 through the ring: 15 / 15 samples = 1.0
  assert.equal(mean[0], 1);
  // Index 200 does not see the spike.
  assert.equal(mean[200], 0);
});

test('Climatology accessor: anomaly, rank, records, series', () => {
  const series = loadJSON('synthetic_series.json');
  const expected = loadJSON('synthetic_climatology_expected.json');
  const clim = new Climatology(buildClimatology(series.time, series.temperature_2m_mean, expected.location, expected.source));
  const idx = KEYS.indexOf('07-14');
  const normal = clim.normal(idx);
  assert.equal(typeof normal, 'number');
  assert.equal(clim.anomaly(idx, normal + 1.5), 1.5);
  const ds = clim.daySeries(idx);
  assert.equal(ds.length, clim.years.length);
  const { rank, n } = clim.rank(idx, 100);
  assert.equal(rank, 1);
  assert.equal(n, ds.filter((d) => d.value !== null).length);
  const rec = clim.records(idx);
  assert.equal(typeof rec.max.year, 'number');
  assert.equal(clim.valueOn(toISO(1995, 7, 14)), clim.dayValue(1995, idx));
});

test('extendClimatology merges new days and updates the end date', () => {
  const { times, values } = constantSeries('2000-01-01', '2000-06-30', 3);
  const clim = buildClimatology(times, values, {}, { end: '2000-06-30' });
  const more = constantSeries('2000-07-01', '2000-07-10', 4);
  const extended = extendClimatology(clim, more.times, more.values, '2000-07-10');
  assert.equal(extended.source.end, '2000-07-10');
  assert.equal(extended.daily['2000'][KEYS.indexOf('07-05')], 40);
  assert.equal(extended.annual[0].days, 192);
});
