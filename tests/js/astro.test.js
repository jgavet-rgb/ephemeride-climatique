import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  localDateOf,
  zonedToUTC,
  sunTimes,
  moonInfo,
  solarEvents,
  seasonInfo,
} from '../../assets/js/astro.js';

const MINUTE = 60000;

/** Assert that two instants differ by at most `toleranceMinutes`. */
function assertWithinMinutes(actual, expectedIso, toleranceMinutes, label) {
  assert.ok(actual instanceof Date, `${label}: expected a Date, got ${actual}`);
  const expected = new Date(expectedIso);
  const errorMinutes = (actual.getTime() - expected.getTime()) / MINUTE;
  assert.ok(
    Math.abs(errorMinutes) <= toleranceMinutes,
    `${label}: ${actual.toISOString()} differs from ${expectedIso} by ${errorMinutes.toFixed(2)} min (tolerance ${toleranceMinutes})`,
  );
}

// ---------------------------------------------------------------------------
// Time zone helpers
// ---------------------------------------------------------------------------

describe('localDateOf', () => {
  test('gives the civil date of the zone, not the UTC date', () => {
    assert.equal(localDateOf(new Date('2026-09-23T00:05:00Z'), 'Europe/Paris'), '2026-09-23');
    assert.equal(localDateOf(new Date('2026-09-22T21:30:00Z'), 'Europe/Paris'), '2026-09-22');
    assert.equal(localDateOf(new Date('2026-03-19T19:58:00Z'), 'Australia/Sydney'), '2026-03-20');
    assert.equal(localDateOf(new Date('2026-01-01T02:00:00Z'), 'America/Los_Angeles'), '2025-12-31');
    assert.equal(localDateOf(new Date('2026-01-01T02:00:00Z'), 'UTC'), '2026-01-01');
  });

  test('zero-pads month and day', () => {
    assert.equal(localDateOf(new Date('2026-02-03T12:00:00Z'), 'UTC'), '2026-02-03');
  });

  test('rejects invalid input', () => {
    assert.throws(() => localDateOf('2026-01-01', 'UTC'), TypeError);
    assert.throws(() => localDateOf(new Date(NaN), 'UTC'), TypeError);
    assert.throws(() => localDateOf(new Date(), 'Mars/Olympus_Mons'), RangeError);
  });
});

describe('zonedToUTC', () => {
  test('applies the summer and winter offsets of Europe/Paris', () => {
    assert.equal(zonedToUTC('2026-09-17', '12:00', 'Europe/Paris').toISOString(), '2026-09-17T10:00:00.000Z');
    assert.equal(zonedToUTC('2026-01-15', '12:00', 'Europe/Paris').toISOString(), '2026-01-15T11:00:00.000Z');
  });

  test('handles zones far from Greenwich and the UTC zone itself', () => {
    // Sydney is on daylight-saving time (UTC+11) in March.
    assert.equal(zonedToUTC('2026-03-20', '12:00', 'Australia/Sydney').toISOString(), '2026-03-20T01:00:00.000Z');
    assert.equal(zonedToUTC('2026-07-04', '23:45', 'America/Los_Angeles').toISOString(), '2026-07-05T06:45:00.000Z');
    assert.equal(zonedToUTC('2026-07-04', '00:00', 'UTC').toISOString(), '2026-07-04T00:00:00.000Z');
  });

  test('accepts an optional seconds field', () => {
    assert.equal(zonedToUTC('2026-01-15', '08:30:15', 'UTC').toISOString(), '2026-01-15T08:30:15.000Z');
  });

  test('round-trips with localDateOf', () => {
    for (const [isoDate, tz] of [['2026-09-17', 'Europe/Paris'], ['2026-03-20', 'Australia/Sydney'], ['2025-12-31', 'America/Los_Angeles']]) {
      for (const hhmm of ['00:00', '12:00', '23:59']) {
        assert.equal(localDateOf(zonedToUTC(isoDate, hhmm, tz), tz), isoDate, `${isoDate} ${hhmm} ${tz}`);
      }
    }
  });

  test('stays within one hour of the wall time during daylight-saving transitions', () => {
    // 2026-03-29 02:30 does not exist in Paris (clocks jump from 02:00 to 03:00).
    const skipped = zonedToUTC('2026-03-29', '02:30', 'Europe/Paris');
    assert.equal(skipped.toISOString(), '2026-03-29T01:30:00.000Z');
    // 2026-10-25 02:30 happens twice in Paris; either instant is acceptable.
    const repeated = zonedToUTC('2026-10-25', '02:30', 'Europe/Paris').toISOString();
    assert.ok(repeated === '2026-10-25T00:30:00.000Z' || repeated === '2026-10-25T01:30:00.000Z', repeated);
  });

  test('rejects malformed dates and times', () => {
    assert.throws(() => zonedToUTC('2026-02-30', '12:00', 'UTC'), RangeError);
    assert.throws(() => zonedToUTC('2026-13-01', '12:00', 'UTC'), RangeError);
    assert.throws(() => zonedToUTC('17/09/2026', '12:00', 'UTC'), RangeError);
    assert.throws(() => zonedToUTC('2026-09-17', '25:00', 'UTC'), RangeError);
    assert.throws(() => zonedToUTC('2026-09-17', '12h00', 'UTC'), RangeError);
  });
});

// ---------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------

describe('sunTimes', () => {
  const GRENOBLE = { lat: 45.1885, lon: 5.7245, tz: 'Europe/Paris' };
  const GRENOBLE_REFERENCES = [
    { date: '2026-09-17', sunrise: '2026-09-17T05:17:00Z', sunset: '2026-09-17T17:44:00Z' },
    { date: '2025-12-21', sunrise: '2025-12-21T07:12:00Z', sunset: '2025-12-21T15:57:00Z' },
    { date: '2026-06-21', sunrise: '2026-06-21T03:49:00Z', sunset: '2026-06-21T19:28:00Z' },
  ];

  for (const ref of GRENOBLE_REFERENCES) {
    test(`Grenoble ${ref.date}: sunrise and sunset within 3 minutes of the reference`, () => {
      const s = sunTimes(ref.date, GRENOBLE.lat, GRENOBLE.lon, GRENOBLE.tz);
      assertWithinMinutes(s.sunrise, ref.sunrise, 3, 'sunrise');
      assertWithinMinutes(s.sunset, ref.sunset, 3, 'sunset');
      assert.equal(s.polar, null);
    });
  }

  test('Grenoble: events are ordered and daylight matches sunset - sunrise', () => {
    for (const ref of GRENOBLE_REFERENCES) {
      const s = sunTimes(ref.date, GRENOBLE.lat, GRENOBLE.lon, GRENOBLE.tz);
      assert.ok(s.civilDawn < s.sunrise, 'civilDawn < sunrise');
      assert.ok(s.sunrise < s.solarNoon, 'sunrise < solarNoon');
      assert.ok(s.solarNoon < s.sunset, 'solarNoon < sunset');
      assert.ok(s.sunset < s.civilDusk, 'sunset < civilDusk');
      const expectedMinutes = (s.sunset.getTime() - s.sunrise.getTime()) / MINUTE;
      assert.ok(Math.abs(s.daylightMinutes - expectedMinutes) <= 1, `daylightMinutes ${s.daylightMinutes} vs ${expectedMinutes}`);
      // Every event belongs to the requested local civil day.
      for (const key of ['civilDawn', 'sunrise', 'solarNoon', 'sunset', 'civilDusk']) {
        assert.equal(localDateOf(s[key], GRENOBLE.tz), ref.date, key);
      }
    }
  });

  test('Grenoble: solar noon sits between the clock times 12:00 and 14:00 as expected for lon 5.7 E', () => {
    const s = sunTimes('2026-09-17', GRENOBLE.lat, GRENOBLE.lon, GRENOBLE.tz);
    assert.ok(s.solarNoon > zonedToUTC('2026-09-17', '12:00', GRENOBLE.tz));
    assert.ok(s.solarNoon < zonedToUTC('2026-09-17', '14:00', GRENOBLE.tz));
  });

  test('Sydney 2026-03-20: events are attached to the local civil day although the UTC date differs', () => {
    const s = sunTimes('2026-03-20', -33.8688, 151.2093, 'Australia/Sydney');
    assertWithinMinutes(s.sunrise, '2026-03-19T19:58:00Z', 3, 'sunrise');
    assertWithinMinutes(s.sunset, '2026-03-20T08:06:00Z', 3, 'sunset');
    assert.equal(localDateOf(s.sunrise, 'Australia/Sydney'), '2026-03-20');
    assert.equal(localDateOf(s.sunset, 'Australia/Sydney'), '2026-03-20');
    assert.equal(s.polar, null);
  });

  test('extreme zone offsets still yield events on the requested local day', () => {
    const cases = [
      ['2026-09-17', 1.87, -157.43, 'Pacific/Kiritimati'], // UTC+14 at 157 W
      ['2026-09-17', 39.47, 75.99, 'Asia/Shanghai'], // Kashgar: solar noon around 14:00 clock time
      ['2026-09-17', 51.88, -176.65, 'America/Adak'],
      ['2026-01-15', -36.85, 174.76, 'Pacific/Auckland'],
    ];
    for (const [date, lat, lon, tz] of cases) {
      const s = sunTimes(date, lat, lon, tz);
      assert.equal(s.polar, null, tz);
      assert.equal(localDateOf(s.sunrise, tz), date, `${tz} sunrise`);
      assert.equal(localDateOf(s.sunset, tz), date, `${tz} sunset`);
      assert.equal(localDateOf(s.solarNoon, tz), date, `${tz} solarNoon`);
      assert.ok(s.sunrise < s.solarNoon && s.solarNoon < s.sunset, tz);
    }
  });

  test('Longyearbyen 2026-06-21: polar day', () => {
    const s = sunTimes('2026-06-21', 78.22, 15.63, 'Arctic/Longyearbyen');
    assert.equal(s.polar, 'day');
    assert.equal(s.sunrise, null);
    assert.equal(s.sunset, null);
    assert.equal(s.daylightMinutes, 1440);
    assert.equal(s.civilDawn, null);
    assert.equal(s.civilDusk, null);
    assert.ok(s.solarNoon instanceof Date);
    assert.equal(localDateOf(s.solarNoon, 'Arctic/Longyearbyen'), '2026-06-21');
  });

  test('Longyearbyen 2026-12-21: polar night', () => {
    const s = sunTimes('2026-12-21', 78.22, 15.63, 'Arctic/Longyearbyen');
    assert.equal(s.polar, 'night');
    assert.equal(s.sunrise, null);
    assert.equal(s.sunset, null);
    assert.equal(s.daylightMinutes, 0);
    // At 78 N in late December the sun stays below -6 degrees all day: no civil twilight.
    assert.equal(s.civilDawn, null);
    assert.equal(s.civilDusk, null);
    assert.ok(s.solarNoon instanceof Date);
  });

  test('Longyearbyen 2026-02-20: short day shortly after the end of the polar night', () => {
    const s = sunTimes('2026-02-20', 78.22, 15.63, 'Arctic/Longyearbyen');
    assert.equal(s.polar, null);
    assert.ok(s.daylightMinutes > 120 && s.daylightMinutes < 420, `daylightMinutes ${s.daylightMinutes}`);
    assert.ok(s.civilDawn < s.sunrise && s.sunset < s.civilDusk);
  });

  test('the poles are handled without exception', () => {
    assert.equal(sunTimes('2026-09-17', 90, 0, 'UTC').polar, 'day');
    assert.equal(sunTimes('2026-12-21', 90, 0, 'UTC').polar, 'night');
    assert.equal(sunTimes('2026-12-21', -90, 0, 'UTC').polar, 'day');
  });

  test('rejects out-of-range coordinates', () => {
    assert.throws(() => sunTimes('2026-09-17', 95, 0, 'UTC'), RangeError);
    assert.throws(() => sunTimes('2026-09-17', 0, 200, 'UTC'), RangeError);
    assert.throws(() => sunTimes('2026-09-17', '45', 0, 'UTC'), TypeError);
  });
});

// ---------------------------------------------------------------------------
// Equinoxes and solstices
// ---------------------------------------------------------------------------

describe('solarEvents', () => {
  test('2026 events within 15 minutes of the reference instants', () => {
    const e = solarEvents(2026);
    assertWithinMinutes(e.marchEquinox, '2026-03-20T14:46:00Z', 15, 'March equinox');
    assertWithinMinutes(e.juneSolstice, '2026-06-21T08:24:00Z', 15, 'June solstice');
    assertWithinMinutes(e.septemberEquinox, '2026-09-23T00:05:00Z', 15, 'September equinox');
    assertWithinMinutes(e.decemberSolstice, '2026-12-21T20:50:00Z', 15, 'December solstice');
  });

  test('2000 March equinox within 15 minutes of 07:35 UTC', () => {
    assertWithinMinutes(solarEvents(2000).marchEquinox, '2000-03-20T07:35:00Z', 15, 'March equinox 2000');
  });

  test('Meeus worked example 27.a: June solstice 1962 at 21:25:08 TT (about 34 s of Delta T earlier in UT)', () => {
    assertWithinMinutes(solarEvents(1962).juneSolstice, '1962-06-21T21:24:34Z', 1, 'June solstice 1962');
  });

  test('events are chronological and one tropical year apart', () => {
    for (const year of [1900, 1999, 2026, 2100]) {
      const e = solarEvents(year);
      assert.ok(e.marchEquinox < e.juneSolstice && e.juneSolstice < e.septemberEquinox && e.septemberEquinox < e.decemberSolstice);
      const next = solarEvents(year + 1);
      const days = (next.marchEquinox.getTime() - e.marchEquinox.getTime()) / 86400000;
      assert.ok(Math.abs(days - 365.2422) < 0.05, `tropical year ${days}`);
    }
  });

  test('rejects non-integer years', () => {
    assert.throws(() => solarEvents(2026.5), TypeError);
    assert.throws(() => solarEvents('2026'), TypeError);
  });
});

// ---------------------------------------------------------------------------
// Moon
// ---------------------------------------------------------------------------

describe('moonInfo', () => {
  const NAMES = [
    'nouvelle lune',
    'premier croissant',
    'premier quartier',
    'gibbeuse croissante',
    'pleine lune',
    'gibbeuse décroissante',
    'dernier quartier',
    'dernier croissant',
  ];
  const EMOJIS = ['\u{1F311}', '\u{1F312}', '\u{1F313}', '\u{1F314}', '\u{1F315}', '\u{1F316}', '\u{1F317}', '\u{1F318}'];

  function checkInvariants(m, date) {
    assert.ok(m.phase >= 0 && m.phase < 1, `phase ${m.phase}`);
    assert.ok(m.ageDays >= 0 && m.ageDays <= 29.6, `ageDays ${m.ageDays}`);
    assert.ok(m.illumination >= 0 && m.illumination <= 1, `illumination ${m.illumination}`);
    assert.ok(NAMES.includes(m.name), m.name);
    assert.equal(m.emoji, EMOJIS[NAMES.indexOf(m.name)]);
    assert.ok(m.nextNewMoon > date, 'nextNewMoon is strictly after the date');
    assert.ok(m.nextFullMoon > date, 'nextFullMoon is strictly after the date');
  }

  test('new moon of 2000-01-06 18:14 UTC', () => {
    const date = new Date('2000-01-06T18:14:00Z');
    const m = moonInfo(date);
    checkInvariants(m, date);
    assert.ok(Math.min(m.phase, 1 - m.phase) < 0.01, `phase ${m.phase}`);
    assert.equal(m.name, 'nouvelle lune');
    assert.equal(m.emoji, '\u{1F311}');
    assert.ok(m.illumination < 0.01);
  });

  test('from 2000-01-07 the next full moon is 2000-01-21 04:40 UTC and the next new moon 2000-02-05 13:03 UTC', () => {
    const date = new Date('2000-01-07T00:00:00Z');
    const m = moonInfo(date);
    checkInvariants(m, date);
    assertWithinMinutes(m.nextFullMoon, '2000-01-21T04:40:00Z', 120, 'next full moon');
    assertWithinMinutes(m.nextNewMoon, '2000-02-05T13:03:00Z', 120, 'next new moon');
  });

  test('total lunar eclipses of 2025 happen at full moon', () => {
    for (const iso of ['2025-03-14T06:59:00Z', '2025-09-07T18:12:00Z']) {
      const date = new Date(iso);
      const m = moonInfo(date);
      checkInvariants(m, date);
      assert.equal(m.name, 'pleine lune', iso);
      assert.equal(m.emoji, '\u{1F315}');
      assert.ok(m.illumination > 0.99, `illumination ${m.illumination} at ${iso}`);
      assert.ok(Math.abs(m.phase - 0.5) < 0.0125, `phase ${m.phase} at ${iso}`);
      // The next full moon is the one of the following lunation, about 29.5 days later.
      const daysToNextFull = (m.nextFullMoon.getTime() - date.getTime()) / 86400000;
      assert.ok(daysToNextFull > 29 && daysToNextFull < 30.2, `days to next full moon ${daysToNextFull}`);
    }
  });

  test('Meeus worked example 49.a: new moon of 1977-02-18 03:37:42 TT (about 48 s earlier in UT)', () => {
    const m = moonInfo(new Date('1977-02-17T00:00:00Z'));
    assertWithinMinutes(m.nextNewMoon, '1977-02-18T03:36:54Z', 1, 'new moon 1977');
  });

  test('Meeus worked example 49.b: last quarter of 2044-01-21 23:48:17 TT reads as phase 0.75', () => {
    const m = moonInfo(new Date('2044-01-21T23:46:49Z'));
    assert.ok(Math.abs(m.phase - 0.75) < 0.0005, `phase ${m.phase}`);
    assert.equal(m.name, 'dernier quartier');
  });

  test('phase names follow the expected order across a lunation', () => {
    const seen = [];
    const start = Date.UTC(2026, 8, 11, 4); // shortly after the new moon of 2026-09-11
    for (let hours = 0; hours < 30 * 24; hours += 3) {
      const m = moonInfo(new Date(start + hours * 3600000));
      if (seen[seen.length - 1] !== m.name) {
        seen.push(m.name);
      }
    }
    assert.deepEqual(seen, [...NAMES, 'nouvelle lune']);
  });

  test('invariants hold over several years of sampled instants', () => {
    const start = Date.UTC(2024, 0, 1);
    let previousNextNew = null;
    for (let i = 0; i < 2000; i++) {
      const date = new Date(start + i * 12 * 3600000);
      const m = moonInfo(date);
      assert.ok(m.phase >= 0 && m.phase < 1);
      // Synodic months range between about 29.27 and 29.83 days.
      assert.ok(m.ageDays >= 0 && m.ageDays < 29.9, `ageDays ${m.ageDays}`);
      assert.ok(m.illumination >= 0 && m.illumination <= 1);
      assert.ok(m.nextNewMoon > date && m.nextFullMoon > date);
      if (previousNextNew !== null) {
        assert.ok(m.nextNewMoon >= previousNextNew, 'nextNewMoon never goes backwards');
      }
      previousNextNew = m.nextNewMoon;
    }
  });

  test('phase and illumination are consistent at the quarters', () => {
    const m = moonInfo(new Date('2000-01-07T00:00:00Z'));
    // First quarter of January 2000 was on the 14th at 13:34 UTC.
    const fq = moonInfo(new Date('2000-01-14T13:34:00Z'));
    assert.ok(Math.abs(fq.phase - 0.25) < 0.0125, `phase ${fq.phase}`);
    assert.equal(fq.name, 'premier quartier');
    assert.ok(Math.abs(fq.illumination - 0.5) < 0.05, `illumination ${fq.illumination}`);
    assert.ok(fq.ageDays > 7 && fq.ageDays < 8.5, `ageDays ${fq.ageDays}`);
    assert.equal(fq.nextFullMoon.getTime(), m.nextFullMoon.getTime());
  });

  test('rejects invalid input', () => {
    assert.throws(() => moonInfo('2026-09-17'), TypeError);
    assert.throws(() => moonInfo(new Date(NaN)), TypeError);
  });
});

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

describe('seasonInfo', () => {
  test('2026-09-17 in Paris: summer, autumn equinox in 6 days', () => {
    const s = seasonInfo('2026-09-17', 'Europe/Paris');
    assert.equal(s.season, 'été');
    assert.equal(s.next.name, "équinoxe d'automne");
    assert.equal(s.daysUntilNext, 6);
    assertWithinMinutes(s.start, '2026-06-21T08:24:00Z', 15, 'season start');
    assertWithinMinutes(s.next.date, '2026-09-23T00:05:00Z', 15, 'next event');
    assert.equal(localDateOf(s.next.date, 'Europe/Paris'), '2026-09-23');
  });

  test('2026-09-17 in Sydney, southern hemisphere: winter, spring equinox next', () => {
    const s = seasonInfo('2026-09-17', 'Australia/Sydney', 'south');
    assert.equal(s.season, 'hiver');
    assert.equal(s.next.name, 'équinoxe de printemps');
    assert.equal(s.daysUntilNext, 6);
  });

  test('2026-12-25 in Paris: winter', () => {
    const s = seasonInfo('2026-12-25', 'Europe/Paris');
    assert.equal(s.season, 'hiver');
    assert.equal(s.next.name, 'équinoxe de printemps');
    assertWithinMinutes(s.start, '2026-12-21T20:50:00Z', 15, 'season start');
    assert.equal(localDateOf(s.next.date, 'Europe/Paris'), '2027-03-20');
  });

  test('defaults to the northern hemisphere', () => {
    assert.deepEqual(seasonInfo('2026-07-14', 'Europe/Paris'), seasonInfo('2026-07-14', 'Europe/Paris', 'north'));
    assert.equal(seasonInfo('2026-07-14', 'Europe/Paris').season, 'été');
    assert.equal(seasonInfo('2026-07-14', 'Europe/Paris', 'south').season, 'hiver');
  });

  test('on the local day of the event, the outgoing season is reported with daysUntilNext 0', () => {
    // Equinox at 2026-09-23 00:05 UTC = 02:05 Paris time, but still 2026-09-22 in Los Angeles.
    const paris = seasonInfo('2026-09-23', 'Europe/Paris');
    assert.equal(paris.season, 'été');
    assert.equal(paris.next.name, "équinoxe d'automne");
    assert.equal(paris.daysUntilNext, 0);

    const parisAfter = seasonInfo('2026-09-24', 'Europe/Paris');
    assert.equal(parisAfter.season, 'automne');
    assert.equal(parisAfter.next.name, "solstice d'hiver");
    assert.equal(parisAfter.start.getTime(), paris.next.date.getTime());

    const losAngeles = seasonInfo('2026-09-23', 'America/Los_Angeles');
    assert.equal(losAngeles.season, 'automne');
    assert.equal(seasonInfo('2026-09-22', 'America/Los_Angeles').daysUntilNext, 0);
  });

  test('early January belongs to the winter that started the previous December', () => {
    const s = seasonInfo('2026-01-05', 'Europe/Paris');
    assert.equal(s.season, 'hiver');
    assert.equal(s.start.getUTCFullYear(), 2025);
    assert.equal(s.next.name, 'équinoxe de printemps');
    assert.equal(s.daysUntilNext, 74); // 2026-03-20 is 74 days after 2026-01-05
  });

  test('southern hemisphere naming across the year', () => {
    const expectations = [
      ['2026-01-15', 'été', "équinoxe d'automne"],
      ['2026-04-15', 'automne', "solstice d'hiver"],
      ['2026-07-15', 'hiver', 'équinoxe de printemps'],
      ['2026-10-15', 'printemps', "solstice d'été"],
    ];
    for (const [date, season, nextName] of expectations) {
      const s = seasonInfo(date, 'Australia/Sydney', 'south');
      assert.equal(s.season, season, date);
      assert.equal(s.next.name, nextName, date);
    }
  });

  test('daysUntilNext decreases by one per day and is never negative', () => {
    let previous = null;
    for (let day = 1; day <= 30; day++) {
      const s = seasonInfo(`2026-11-${String(day).padStart(2, '0')}`, 'Europe/Paris');
      assert.ok(s.daysUntilNext >= 0);
      if (previous !== null) {
        assert.equal(s.daysUntilNext, previous - 1);
      }
      previous = s.daysUntilNext;
    }
  });

  test('rejects invalid input', () => {
    assert.throws(() => seasonInfo('2026-02-30', 'UTC'), RangeError);
    assert.throws(() => seasonInfo('2026-02-10', 'UTC', 'east'), RangeError);
    assert.throws(() => seasonInfo('2026-02-10', 'Mars/Olympus_Mons'), RangeError);
  });
});
