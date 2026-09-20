import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KEYS, isLeap, parseISO, isValidISO, addDays, diffDays, isoWeekday, dayOfYear, isoWeek,
  mmdd, keyIndex, shiftKey, easter, frenchHolidays, holidaysOn, dstTransitions, mothersDayFR,
  fathersDayFR, calendarEvents, formatLongFR, monthGrid, romanNumeral, todayISO, addMonths,
} from '../../assets/js/dates.js';

test('366 keys with 02-29 at index 59', () => {
  assert.equal(KEYS.length, 366);
  assert.equal(KEYS[59], '02-29');
  assert.equal(KEYS[0], '01-01');
  assert.equal(KEYS[365], '12-31');
  assert.equal(keyIndex('12-31'), 365);
  assert.equal(shiftKey('01-01', -1), '12-31');
  assert.equal(shiftKey('02-28', 1), '02-29');
});

test('leap years and ISO parsing', () => {
  assert.equal(isLeap(2000), true);
  assert.equal(isLeap(1900), false);
  assert.equal(isLeap(2024), true);
  assert.equal(isLeap(2026), false);
  assert.deepEqual(parseISO('2026-09-17'), { y: 2026, m: 9, d: 17 });
  assert.equal(isValidISO('2026-02-29'), false);
  assert.equal(isValidISO('2024-02-29'), true);
  assert.throws(() => parseISO('2026-13-01'), RangeError);
});

test('day arithmetic', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(diffDays('2026-01-01', '2026-09-17'), 259);
  assert.equal(dayOfYear('2026-09-17'), 260);
  assert.equal(dayOfYear('2024-12-31'), 366);
  assert.equal(mmdd('2026-09-17'), '09-17');
});

test('weekdays and ISO weeks', () => {
  assert.equal(isoWeekday('2026-09-17'), 4); // Thursday
  assert.equal(isoWeekday('1970-01-01'), 4);
  assert.equal(isoWeekday('2026-09-20'), 7);
  assert.deepEqual(isoWeek('2026-09-17'), { week: 38, year: 2026 });
  assert.deepEqual(isoWeek('2021-01-01'), { week: 53, year: 2020 });
  assert.deepEqual(isoWeek('2024-12-30'), { week: 1, year: 2025 });
  assert.deepEqual(isoWeek('2026-01-01'), { week: 1, year: 2026 });
});

test('Easter and French holidays', () => {
  assert.equal(easter(2024), '2024-03-31');
  assert.equal(easter(2025), '2025-04-20');
  assert.equal(easter(2026), '2026-04-05');
  assert.equal(easter(2000), '2000-04-23');
  const h2026 = frenchHolidays(2026);
  assert.equal(h2026.length, 11);
  assert.equal(h2026.find((h) => h.name === 'Ascension').date, '2026-05-14');
  assert.equal(h2026.find((h) => h.name === 'Lundi de Pentecôte').date, '2026-05-25');
  assert.deepEqual(holidaysOn('2026-07-14'), ['Fête nationale']);
  assert.deepEqual(holidaysOn('2026-09-17'), []);
  assert.equal(frenchHolidays(2026, { alsaceMoselle: true }).length, 13);
});

test('DST transitions, mothers and fathers day', () => {
  assert.deepEqual(dstTransitions(2026), { start: '2026-03-29', end: '2026-10-25' });
  assert.deepEqual(dstTransitions(2025), { start: '2025-03-30', end: '2025-10-26' });
  assert.equal(mothersDayFR(2026), '2026-05-31');
  // 2024: last Sunday of May (26th) was not Pentecost (19 May) -> 26 May.
  assert.equal(mothersDayFR(2024), '2024-05-26');
  // 2023: Pentecost fell on 28 May = last Sunday of May -> first Sunday of June.
  assert.equal(mothersDayFR(2023), '2023-06-04');
  assert.equal(mothersDayFR(2015), '2015-05-31');
  assert.equal(fathersDayFR(2026), '2026-06-21');
  assert.ok(calendarEvents('2026-03-29').some((e) => e.includes('heure d')));
  assert.ok(calendarEvents('2026-02-14').includes('Saint-Valentin'));
});

test('French formatting and month grid', () => {
  assert.equal(formatLongFR('2026-09-17'), 'jeudi 17 septembre 2026');
  assert.equal(formatLongFR('2026-05-01'), 'vendredi 1er mai 2026');
  const grid = monthGrid(2026, 9);
  assert.equal(grid[0][1], '2026-09-01'); // September 2026 starts on a Tuesday
  assert.equal(grid[0][0], null);
  assert.equal(grid.every((w) => w.length === 7), true);
  assert.equal(romanNumeral(234), 'CCXXXIV');
  assert.equal(romanNumeral(2026), 'MMXXVI');
  assert.deepEqual(addMonths(2026, 12, 1), { y: 2027, m: 1 });
  assert.deepEqual(addMonths(2026, 1, -1), { y: 2025, m: 12 });
});

test('todayISO respects the time zone', () => {
  const instant = new Date('2026-09-17T23:30:00Z');
  assert.equal(todayISO('Europe/Paris', instant), '2026-09-18');
  assert.equal(todayISO('America/Los_Angeles', instant), '2026-09-17');
  assert.equal(todayISO('UTC', instant), '2026-09-17');
});
