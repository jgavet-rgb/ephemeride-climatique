/**
 * Astronomical computations for the perpetual calendar, evaluated locally in
 * the browser: sun rise/set and civil twilight, moon phase, equinoxes and
 * solstices, astronomical seasons.
 *
 * Sources of the algorithms:
 * - Sun position and equation of time: NOAA Solar Calculator equations
 *   (themselves derived from Jean Meeus, "Astronomical Algorithms", ch. 25).
 * - Lunar phases: Meeus, "Astronomical Algorithms", 2nd ed., chapter 49.
 * - Equinoxes and solstices: Meeus, chapter 27.
 * - Delta T (TT - UT): polynomial expressions of Espenak and Meeus.
 *
 * All exported functions are pure: they never read the current time and only
 * depend on their arguments. Instants are plain Date objects (UTC). Civil dates
 * are 'YYYY-MM-DD' strings interpreted in an IANA time zone through Intl.
 */

const MS_PER_MINUTE = 60000;
const MS_PER_DAY = 86400000;
const JD_UNIX_EPOCH = 2440587.5; // Julian Day of 1970-01-01T00:00:00Z
const JD_J2000 = 2451545.0; // Julian Day of 2000-01-01T12:00:00 TT
const DAYS_PER_CENTURY = 36525;

const DEG_TO_RAD = Math.PI / 180;

/** Zenith distance of the sun's centre at sunrise/sunset (refraction + semi-diameter). */
const ZENITH_SUNRISE = 90.833;
/** Zenith distance of the sun's centre at the civil twilight limit. */
const ZENITH_CIVIL = 96;

const ISO_DATE_RE = /^(-?\d{4,6})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function rad(degrees) {
  return degrees * DEG_TO_RAD;
}

function deg(radians) {
  return radians / DEG_TO_RAD;
}

/** Reduce an angle in degrees to the range [0, 360). */
function norm360(degrees) {
  const r = degrees % 360;
  return r < 0 ? r + 360 : r;
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** Milliseconds since the Unix epoch of a proleptic Gregorian UTC wall time (any year). */
function utcMillis(year, month, day, hour = 0, minute = 0, second = 0) {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

function julianDayFromMillis(ms) {
  return ms / MS_PER_DAY + JD_UNIX_EPOCH;
}

function millisFromJulianDay(jd) {
  return Math.round((jd - JD_UNIX_EPOCH) * MS_PER_DAY);
}

/** Julian centuries since J2000.0 for an instant given in milliseconds since the epoch. */
function julianCenturyFromMillis(ms) {
  return (julianDayFromMillis(ms) - JD_J2000) / DAYS_PER_CENTURY;
}

/** Decimal year (e.g. 2026.71) of an instant, adequate for choosing lunation numbers and Delta T. */
function decimalYear(date) {
  const year = date.getUTCFullYear();
  const start = utcMillis(year, 1, 1);
  const end = utcMillis(year + 1, 1, 1);
  return year + (date.getTime() - start) / (end - start);
}

function parseIsoDate(isoDate) {
  const m = typeof isoDate === 'string' ? ISO_DATE_RE.exec(isoDate) : null;
  if (!m) {
    throw new RangeError(`Invalid civil date "${isoDate}", expected YYYY-MM-DD`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Reject impossible dates (2026-02-30, month 13...) by round-tripping through Date.
  const probe = new Date(utcMillis(year, month, day));
  if (
    month < 1 || month > 12 || day < 1 ||
    probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid civil date "${isoDate}"`);
  }
  return { year, month, day };
}

function parseHHMM(hhmm) {
  const m = typeof hhmm === 'string' ? HHMM_RE.exec(hhmm) : null;
  if (!m) {
    throw new RangeError(`Invalid time "${hhmm}", expected HH:MM`);
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] === undefined ? 0 : Number(m[3]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new RangeError(`Invalid time "${hhmm}"`);
  }
  return { hour, minute, second };
}

function assertFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function assertDate(value, name) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
}

// ---------------------------------------------------------------------------
// Time zones (Intl based)
// ---------------------------------------------------------------------------

const formatterCache = new Map();

function zoneFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    // Throws a RangeError for unknown IANA names, which is the desired behaviour.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock fields { year, month, day, hour, minute, second } of an instant in a time zone. */
function wallClockFields(date, timeZone) {
  const fields = {};
  for (const part of zoneFormatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') {
      fields[part.type] = Number(part.value);
    }
  }
  if (fields.hour === 24) {
    fields.hour = 0; // defensive: some engines print midnight as 24 with hour12:false
  }
  return fields;
}

/** UTC offset of a time zone at an instant, in minutes (positive east of Greenwich). */
function zoneOffsetMinutes(date, timeZone) {
  const f = wallClockFields(date, timeZone);
  const asIfUtc = utcMillis(f.year, f.month, f.day, f.hour, f.minute, f.second);
  const wholeSeconds = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asIfUtc - wholeSeconds) / MS_PER_MINUTE);
}

/**
 * Civil date of a UTC instant in an IANA time zone, as 'YYYY-MM-DD'.
 * @param {Date} dateUTC instant
 * @param {string} timeZone IANA time zone name, e.g. 'Europe/Paris'
 * @returns {string}
 */
export function localDateOf(dateUTC, timeZone) {
  assertDate(dateUTC, 'dateUTC');
  const f = wallClockFields(dateUTC, timeZone);
  return `${f.year}-${pad2(f.month)}-${pad2(f.day)}`;
}

/**
 * Convert a civil 'YYYY-MM-DD' + 'HH:MM' wall time in timeZone to a UTC Date.
 * The zone offset is resolved iteratively (twice), which handles daylight-saving
 * transitions well enough for calendar purposes: a wall time inside a skipped hour
 * is shifted forward by the transition amount, and a wall time inside a repeated
 * hour maps deterministically to one of its two valid instants.
 * @param {string} isoDate 'YYYY-MM-DD'
 * @param {string} hhmm 'HH:MM' (an optional ':SS' is accepted)
 * @param {string} timeZone IANA time zone name
 * @returns {Date}
 */
export function zonedToUTC(isoDate, hhmm, timeZone) {
  const d = parseIsoDate(isoDate);
  const t = parseHHMM(hhmm);
  const wall = utcMillis(d.year, d.month, d.day, t.hour, t.minute, t.second);
  let offset = zoneOffsetMinutes(new Date(wall), timeZone);
  let utc = wall - offset * MS_PER_MINUTE;
  offset = zoneOffsetMinutes(new Date(utc), timeZone);
  utc = wall - offset * MS_PER_MINUTE;
  return new Date(utc);
}

/** Signed number of civil days from isoA to isoB (both 'YYYY-MM-DD'). */
function civilDayDifference(isoA, isoB) {
  const a = parseIsoDate(isoA);
  const b = parseIsoDate(isoB);
  return Math.round((utcMillis(b.year, b.month, b.day) - utcMillis(a.year, a.month, a.day)) / MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// Delta T = TT - UT (seconds), Espenak & Meeus polynomial expressions
// ---------------------------------------------------------------------------

/** Approximate TT - UT in seconds for a decimal year. Adequate to well under a minute for 1900-2150. */
function deltaTSeconds(year) {
  let t;
  if (year >= 2050 && year < 2150) {
    const u = (year - 1820) / 100;
    return -20 + 32 * u * u - 0.5628 * (2150 - year);
  }
  if (year >= 2005 && year < 2050) {
    t = year - 2000;
    return 62.92 + 0.32217 * t + 0.005589 * t * t;
  }
  if (year >= 1986 && year < 2005) {
    t = year - 2000;
    return 63.86 + 0.3345 * t - 0.060374 * t ** 2 + 0.0017275 * t ** 3 + 0.000651814 * t ** 4 + 0.00002373599 * t ** 5;
  }
  if (year >= 1961 && year < 1986) {
    t = year - 1975;
    return 45.45 + 1.067 * t - t ** 2 / 260 - t ** 3 / 718;
  }
  if (year >= 1941 && year < 1961) {
    t = year - 1950;
    return 29.07 + 0.407 * t - t ** 2 / 233 + t ** 3 / 2547;
  }
  if (year >= 1920 && year < 1941) {
    t = year - 1920;
    return 21.2 + 0.84493 * t - 0.0761 * t ** 2 + 0.0020936 * t ** 3;
  }
  if (year >= 1900 && year < 1920) {
    t = year - 1900;
    return -2.79 + 1.494119 * t - 0.0598939 * t ** 2 + 0.0061966 * t ** 3 - 0.000197 * t ** 4;
  }
  // Far past or far future: parabolic long-term fit.
  const u = (year - 1820) / 100;
  return -20 + 32 * u * u;
}

/** Convert a Julian Ephemeris Day (Terrestrial Time) to a UTC Date. */
function dateFromJulianEphemerisDay(jde) {
  const approxMs = millisFromJulianDay(jde);
  const dt = deltaTSeconds(decimalYear(new Date(approxMs)));
  return new Date(approxMs - Math.round(dt * 1000));
}

// ---------------------------------------------------------------------------
// Sun (NOAA solar calculator equations)
// ---------------------------------------------------------------------------

/** Geometric mean longitude of the sun, degrees in [0, 360). */
function sunGeometricMeanLongitude(T) {
  return norm360(280.46646 + T * (36000.76983 + T * 0.0003032));
}

/** Geometric mean anomaly of the sun, degrees. */
function sunGeometricMeanAnomaly(T) {
  return 357.52911 + T * (35999.05029 - 0.0001537 * T);
}

/** Eccentricity of Earth's orbit. */
function earthOrbitEccentricity(T) {
  return 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
}

/** Equation of the centre of the sun, degrees. */
function sunEquationOfCentre(T) {
  const M = rad(sunGeometricMeanAnomaly(T));
  return (
    Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M) * 0.000289
  );
}

/** Longitude of the ascending node of the moon's mean orbit, degrees (used for nutation/aberration). */
function moonNodeLongitude(T) {
  return 125.04 - 1934.136 * T;
}

/** Apparent longitude of the sun, degrees. */
function sunApparentLongitude(T) {
  const trueLongitude = sunGeometricMeanLongitude(T) + sunEquationOfCentre(T);
  return trueLongitude - 0.00569 - 0.00478 * Math.sin(rad(moonNodeLongitude(T)));
}

/** Mean obliquity of the ecliptic, degrees. */
function meanObliquityOfEcliptic(T) {
  const seconds = 21.448 - T * (46.815 + T * (0.00059 - T * 0.001813));
  return 23 + (26 + seconds / 60) / 60;
}

/** Obliquity corrected for nutation, degrees. */
function obliquityCorrection(T) {
  return meanObliquityOfEcliptic(T) + 0.00256 * Math.cos(rad(moonNodeLongitude(T)));
}

/** Apparent declination of the sun, degrees. */
function sunDeclination(T) {
  const epsilon = rad(obliquityCorrection(T));
  const lambda = rad(sunApparentLongitude(T));
  return deg(Math.asin(Math.sin(epsilon) * Math.sin(lambda)));
}

/** Equation of time, minutes (apparent solar time minus mean solar time). */
function equationOfTime(T) {
  const epsilon = rad(obliquityCorrection(T));
  const L0 = rad(sunGeometricMeanLongitude(T));
  const e = earthOrbitEccentricity(T);
  const M = rad(sunGeometricMeanAnomaly(T));
  let y = Math.tan(epsilon / 2);
  y *= y;
  const eTime =
    y * Math.sin(2 * L0) -
    2 * e * Math.sin(M) +
    4 * e * y * Math.sin(M) * Math.cos(2 * L0) -
    0.5 * y * y * Math.sin(4 * L0) -
    1.25 * e * e * Math.sin(2 * M);
  return deg(eTime) * 4;
}

/**
 * Cosine of the local hour angle at which the sun's centre reaches the given zenith
 * distance. Values outside [-1, 1] mean the sun never reaches that altitude that day.
 */
function cosHourAngle(latitude, declination, zenith) {
  const phi = rad(latitude);
  const delta = rad(declination);
  return (Math.cos(rad(zenith)) - Math.sin(phi) * Math.sin(delta)) / (Math.cos(phi) * Math.cos(delta));
}

/**
 * UTC instant (ms) of the solar noon nearest to the reference instant, at the given
 * longitude. Two passes refine the equation of time at the noon itself.
 */
function solarNoonNear(referenceMs, lon) {
  let t = referenceMs;
  for (let pass = 0; pass < 2; pass++) {
    const eot = equationOfTime(julianCenturyFromMillis(t));
    const minutesOfUtcDay = (((t % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / MS_PER_MINUTE;
    // Apparent solar time (minutes) = UT + 4 * longitude + equation of time.
    const apparentSolarMinutes = minutesOfUtcDay + 4 * lon + eot;
    let delta = 720 - apparentSolarMinutes;
    delta = ((((delta + 720) % 1440) + 1440) % 1440) - 720; // wrap to [-720, 720)
    t += delta * MS_PER_MINUTE;
  }
  return t;
}

/**
 * Instants at which the sun's centre crosses the given zenith distance around a
 * solar noon. Returns { state: 'above' } when the sun stays above that altitude all
 * day, { state: 'below' } when it stays below, otherwise { state: 'crosses', rise, set }
 * with instants in milliseconds since the epoch.
 */
function sunCrossings(noonMs, lat, zenith) {
  const noonT = julianCenturyFromMillis(noonMs);
  const eotAtNoon = equationOfTime(noonT);
  const cosH0 = cosHourAngle(lat, sunDeclination(noonT), zenith);
  if (cosH0 > 1) {
    return { state: 'below' };
  }
  if (cosH0 < -1) {
    return { state: 'above' };
  }
  const h0 = deg(Math.acos(cosH0));

  // Second pass with the declination and the equation of time at the event itself
  // (as in the NOAA calculator), which matters most when declination changes fast.
  const refine = (estimateMs, sign) => {
    const T = julianCenturyFromMillis(estimateMs);
    const cosH = cosHourAngle(lat, sunDeclination(T), zenith);
    if (cosH > 1 || cosH < -1) {
      return estimateMs; // razor-edge polar case: keep the first estimate
    }
    const h = deg(Math.acos(cosH));
    const noonShiftMinutes = eotAtNoon - equationOfTime(T);
    return noonMs + (noonShiftMinutes + sign * 4 * h) * MS_PER_MINUTE;
  };

  const rise = refine(noonMs - 4 * h0 * MS_PER_MINUTE, -1);
  const set = refine(noonMs + 4 * h0 * MS_PER_MINUTE, +1);
  return { state: 'crosses', rise, set };
}

/**
 * Sun events for the civil date isoDate ('YYYY-MM-DD') at lat/lon (degrees), in the
 * IANA time zone timeZone. Events are those of the local civil day: they are
 * searched around the solar noon closest to that day's 12:00 wall-clock time.
 *
 * @param {string} isoDate 'YYYY-MM-DD'
 * @param {number} lat latitude in degrees, north positive
 * @param {number} lon longitude in degrees, east positive
 * @param {string} timeZone IANA time zone name
 * @returns {{
 *   sunrise: Date|null, sunset: Date|null, solarNoon: Date,
 *   civilDawn: Date|null, civilDusk: Date|null,
 *   daylightMinutes: number|null, polar: null|'day'|'night'
 * }}
 * polar is 'day' when the sun never sets (sunrise/sunset null, daylightMinutes 1440)
 * and 'night' when it never rises (daylightMinutes 0). civilDawn/civilDusk are null
 * when the sun never crosses -6 degrees that day (whichever side it stays on).
 */
export function sunTimes(isoDate, lat, lon, timeZone) {
  assertFiniteNumber(lat, 'lat');
  assertFiniteNumber(lon, 'lon');
  if (lat < -90 || lat > 90) {
    throw new RangeError('lat must be within [-90, 90]');
  }
  if (lon < -180 || lon > 180) {
    throw new RangeError('lon must be within [-180, 180]');
  }

  const clockNoonMs = zonedToUTC(isoDate, '12:00', timeZone).getTime();
  const noonMs = solarNoonNear(clockNoonMs, lon);

  const sun = sunCrossings(noonMs, lat, ZENITH_SUNRISE);
  const civil = sunCrossings(noonMs, lat, ZENITH_CIVIL);

  let sunrise = null;
  let sunset = null;
  let daylightMinutes = null;
  let polar = null;
  if (sun.state === 'crosses') {
    sunrise = new Date(Math.round(sun.rise));
    sunset = new Date(Math.round(sun.set));
    daylightMinutes = Math.round((sun.set - sun.rise) / MS_PER_MINUTE);
  } else if (sun.state === 'above') {
    polar = 'day';
    daylightMinutes = 1440;
  } else {
    polar = 'night';
    daylightMinutes = 0;
  }

  return {
    sunrise,
    sunset,
    solarNoon: new Date(Math.round(noonMs)),
    civilDawn: civil.state === 'crosses' ? new Date(Math.round(civil.rise)) : null,
    civilDusk: civil.state === 'crosses' ? new Date(Math.round(civil.set)) : null,
    daylightMinutes,
    polar,
  };
}

// ---------------------------------------------------------------------------
// Moon phases (Meeus, chapter 49)
// ---------------------------------------------------------------------------

/**
 * Periodic-term arguments shared by the new moon and full moon series, as multiples
 * of [M (sun's mean anomaly), M' (moon's mean anomaly), F (argument of latitude),
 * Omega (longitude of ascending node)], with the power of E applied to each term.
 */
const NEW_FULL_ARGUMENTS = [
  // [ePower, M, M', F, Omega]
  [0, 0, 1, 0, 0],
  [1, 1, 0, 0, 0],
  [0, 0, 2, 0, 0],
  [0, 0, 0, 2, 0],
  [1, -1, 1, 0, 0],
  [1, 1, 1, 0, 0],
  [2, 2, 0, 0, 0],
  [0, 0, 1, -2, 0],
  [0, 0, 1, 2, 0],
  [1, 1, 2, 0, 0],
  [0, 0, 3, 0, 0],
  [1, 1, 0, 2, 0],
  [1, 1, 0, -2, 0],
  [1, -1, 2, 0, 0],
  [0, 0, 0, 0, 1],
  [0, 2, 1, 0, 0],
  [0, 0, 2, -2, 0],
  [0, 3, 0, 0, 0],
  [0, 1, 1, -2, 0],
  [0, 0, 2, 2, 0],
  [0, 1, 1, 2, 0],
  [0, -1, 1, 2, 0],
  [0, -1, 1, -2, 0],
  [0, 1, 3, 0, 0],
  [0, 0, 4, 0, 0],
];

const NEW_MOON_COEFFICIENTS = [
  -0.4072, 0.17241, 0.01608, 0.01039, 0.00739, -0.00514, 0.00208, -0.00111, -0.00057,
  0.00056, -0.00042, 0.00042, 0.00038, -0.00024, -0.00017, -0.00007, 0.00004, 0.00004,
  0.00003, 0.00003, -0.00003, 0.00003, -0.00002, -0.00002, 0.00002,
];

const FULL_MOON_COEFFICIENTS = [
  -0.40614, 0.17302, 0.01614, 0.01043, 0.00734, -0.00515, 0.00209, -0.00111, -0.00057,
  0.00056, -0.00042, 0.00042, 0.00038, -0.00024, -0.00017, -0.00007, 0.00004, 0.00004,
  0.00003, 0.00003, -0.00003, 0.00003, -0.00002, -0.00002, 0.00002,
];

/** Periodic terms for the quarters: [coefficient, ePower, M, M', F, Omega]. */
const QUARTER_TERMS = [
  [-0.62801, 0, 0, 1, 0, 0],
  [0.17172, 1, 1, 0, 0, 0],
  [-0.01183, 1, 1, 1, 0, 0],
  [0.00862, 0, 0, 2, 0, 0],
  [0.00804, 0, 0, 0, 2, 0],
  [0.00454, 1, -1, 1, 0, 0],
  [0.00204, 2, 2, 0, 0, 0],
  [-0.0018, 0, 0, 1, -2, 0],
  [-0.0007, 0, 0, 1, 2, 0],
  [-0.0004, 0, 0, 3, 0, 0],
  [-0.00034, 1, -1, 2, 0, 0],
  [0.00032, 1, 1, 0, 2, 0],
  [0.00032, 1, 1, 0, -2, 0],
  [-0.00028, 2, 2, 1, 0, 0],
  [0.00027, 1, 1, 2, 0, 0],
  [-0.00017, 0, 0, 0, 0, 1],
  [-0.00005, 0, -1, 1, -2, 0],
  [0.00004, 0, 0, 2, 2, 0],
  [-0.00004, 0, 1, 1, 2, 0],
  [0.00004, 0, -2, 1, 0, 0],
  [0.00003, 0, 1, 1, -2, 0],
  [0.00003, 0, 3, 0, 0, 0],
  [0.00002, 0, 0, 2, -2, 0],
  [0.00002, 0, -1, 1, 2, 0],
  [-0.00002, 0, 1, 3, 0, 0],
];

/** Additional planetary corrections: [coefficient (days), A0 (deg), A1 (deg per k)]. */
const PLANETARY_TERMS = [
  [0.000325, 299.77, 0.107408], // this one also carries a -0.009173 T^2 term
  [0.000165, 251.88, 0.016321],
  [0.000164, 251.83, 26.651886],
  [0.000126, 349.42, 36.412478],
  [0.00011, 84.66, 18.206239],
  [0.000062, 141.74, 53.303771],
  [0.00006, 207.14, 2.453732],
  [0.000056, 154.84, 7.30686],
  [0.000047, 34.52, 27.261239],
  [0.000042, 207.19, 0.121824],
  [0.00004, 291.34, 1.844379],
  [0.000037, 161.72, 24.198154],
  [0.000035, 239.56, 25.513099],
  [0.000023, 331.55, 3.592518],
];

/**
 * Julian Ephemeris Day (TT) of a lunar phase. k is an integer for new moons,
 * integer + 0.25 for first quarters, + 0.5 for full moons, + 0.75 for last quarters
 * (k = 0 is the new moon of 2000 January 6).
 */
function lunarPhaseJDE(k) {
  const T = k / 1236.85;
  const T2 = T * T;
  const T3 = T2 * T;
  const T4 = T3 * T;

  let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.00000015 * T3 + 0.00000000073 * T4;

  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const M = rad(2.5534 + 29.1053567 * k - 0.0000014 * T2 - 0.00000011 * T3);
  const Mp = rad(201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4);
  const F = rad(160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4);
  const Omega = rad(124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3);
  const ePowers = [1, E, E * E];

  // Fractional part of k selects the series: 0 new, 1 first quarter, 2 full, 3 last quarter.
  const fractionOfK = k - Math.floor(k);
  const phaseKind = Math.round(fractionOfK * 4) % 4;
  let correction = 0;

  if (phaseKind === 0 || phaseKind === 2) {
    const coefficients = phaseKind === 0 ? NEW_MOON_COEFFICIENTS : FULL_MOON_COEFFICIENTS;
    for (let i = 0; i < NEW_FULL_ARGUMENTS.length; i++) {
      const [ePower, m, mp, f, o] = NEW_FULL_ARGUMENTS[i];
      correction += coefficients[i] * ePowers[ePower] * Math.sin(m * M + mp * Mp + f * F + o * Omega);
    }
  } else {
    for (const [coefficient, ePower, m, mp, f, o] of QUARTER_TERMS) {
      correction += coefficient * ePowers[ePower] * Math.sin(m * M + mp * Mp + f * F + o * Omega);
    }
    const W =
      0.00306 -
      0.00038 * E * Math.cos(M) +
      0.00026 * Math.cos(Mp) -
      0.00002 * Math.cos(Mp - M) +
      0.00002 * Math.cos(Mp + M) +
      0.00002 * Math.cos(2 * F);
    correction += phaseKind === 1 ? W : -W;
  }

  for (let i = 0; i < PLANETARY_TERMS.length; i++) {
    const [coefficient, a0, a1] = PLANETARY_TERMS[i];
    let angle = a0 + a1 * k;
    if (i === 0) {
      angle -= 0.009173 * T2;
    }
    correction += coefficient * Math.sin(rad(angle));
  }

  return jde + correction;
}

/** UTC instant (ms since the epoch) of the lunar phase of index k. */
function lunarPhaseMillis(k) {
  return dateFromJulianEphemerisDay(lunarPhaseJDE(k)).getTime();
}

/**
 * Integer lunation number k of the new moon that starts the lunation containing the
 * instant: newMoon(k) <= t < newMoon(k + 1).
 */
function lunationContaining(date) {
  let k = Math.floor((decimalYear(date) - 2000) * 12.3685);
  const t = date.getTime();
  while (lunarPhaseMillis(k) > t) {
    k -= 1;
  }
  while (lunarPhaseMillis(k + 1) <= t) {
    k += 1;
  }
  return k;
}

const MOON_PHASE_NAMES = [
  'nouvelle lune',
  'premier croissant',
  'premier quartier',
  'gibbeuse croissante',
  'pleine lune',
  'gibbeuse décroissante',
  'dernier quartier',
  'dernier croissant',
];

const MOON_PHASE_EMOJIS = ['\u{1F311}', '\u{1F312}', '\u{1F313}', '\u{1F314}', '\u{1F315}', '\u{1F316}', '\u{1F317}', '\u{1F318}'];

/** Half-width (in phase units) of the window around a principal phase that keeps its name. */
const PRINCIPAL_PHASE_HALF_WIDTH = 0.0125;

/** Index in MOON_PHASE_NAMES / MOON_PHASE_EMOJIS for a phase in [0, 1). */
function moonPhaseIndex(phase) {
  const w = PRINCIPAL_PHASE_HALF_WIDTH;
  if (phase < w || phase > 1 - w) return 0;
  if (Math.abs(phase - 0.25) < w) return 2;
  if (Math.abs(phase - 0.5) < w) return 4;
  if (Math.abs(phase - 0.75) < w) return 6;
  if (phase < 0.25) return 1;
  if (phase < 0.5) return 3;
  if (phase < 0.75) return 5;
  return 7;
}

/**
 * Moon state at a UTC instant.
 *
 * The phase is measured against the true instants of the principal phases of the
 * current lunation (Meeus ch. 49): 0 at the new moon, exactly 0.25 / 0.5 / 0.75 at the
 * first quarter, full moon and last quarter, interpolated linearly in between. This
 * keeps the phase, its name, the illumination and nextNewMoon/nextFullMoon mutually
 * consistent to the minute.
 *
 * @param {Date} dateUTC instant
 * @returns {{
 *   phase: number, ageDays: number, illumination: number,
 *   name: string, emoji: string, nextNewMoon: Date, nextFullMoon: Date
 * }}
 * phase in [0, 1) (0 = new moon, 0.5 = full moon); ageDays = days since the last new
 * moon; illumination = illuminated fraction of the disc in [0, 1]; nextNewMoon and
 * nextFullMoon are the first such instants strictly after dateUTC.
 */
export function moonInfo(dateUTC) {
  assertDate(dateUTC, 'dateUTC');
  const t = dateUTC.getTime();
  const k = lunationContaining(dateUTC);

  // Principal phases of the lunation: new, first quarter, full, last quarter, next new.
  const anchors = [0, 0.25, 0.5, 0.75, 1].map((q) => lunarPhaseMillis(k + q));

  let segment = 0;
  while (segment < 3 && t >= anchors[segment + 1]) {
    segment += 1;
  }
  const segmentStart = anchors[segment];
  const segmentEnd = anchors[segment + 1];
  let phase = 0.25 * segment + 0.25 * ((t - segmentStart) / (segmentEnd - segmentStart));
  if (phase < 0) phase = 0;
  if (phase >= 1) phase = 1 - Number.EPSILON;

  const nextNewMoon = new Date(anchors[4]);
  const nextFullMoon = new Date(t < anchors[2] ? anchors[2] : lunarPhaseMillis(k + 1.5));

  const index = moonPhaseIndex(phase);
  return {
    phase,
    ageDays: (t - anchors[0]) / MS_PER_DAY,
    illumination: (1 - Math.cos(2 * Math.PI * phase)) / 2,
    name: MOON_PHASE_NAMES[index],
    emoji: MOON_PHASE_EMOJIS[index],
    nextNewMoon,
    nextFullMoon,
  };
}

// ---------------------------------------------------------------------------
// Equinoxes and solstices (Meeus, chapter 27)
// ---------------------------------------------------------------------------

/** Mean-instant polynomials for years 1000 to 3000 (Y = (year - 2000) / 1000). */
const MEAN_EVENT_POLYNOMIALS_MODERN = {
  marchEquinox: [2451623.80984, 365242.37404, 0.05169, -0.00411, -0.00057],
  juneSolstice: [2451716.56767, 365241.62603, 0.00325, 0.00888, -0.0003],
  septemberEquinox: [2451810.21715, 365242.01767, -0.11575, 0.00337, 0.00078],
  decemberSolstice: [2451900.05952, 365242.74049, -0.06223, -0.00823, 0.00032],
};

/** Mean-instant polynomials for years -1000 to 1000 (Y = year / 1000). */
const MEAN_EVENT_POLYNOMIALS_ANCIENT = {
  marchEquinox: [1721139.29189, 365242.1374, 0.06134, 0.00111, -0.00071],
  juneSolstice: [1721233.25401, 365241.72562, -0.05323, 0.00907, 0.00025],
  septemberEquinox: [1721325.70455, 365242.49558, -0.11677, -0.00297, 0.00074],
  decemberSolstice: [1721414.39987, 365242.88257, -0.00769, -0.00933, -0.00006],
};

/** Periodic terms of table 27.C: [A, B (deg), C (deg per Julian century)]. */
const EVENT_PERIODIC_TERMS = [
  [485, 324.96, 1934.136],
  [203, 337.23, 32964.467],
  [199, 342.08, 20.186],
  [182, 27.85, 445267.112],
  [156, 73.14, 45036.886],
  [136, 171.52, 22518.443],
  [77, 222.54, 65928.934],
  [74, 296.72, 3034.906],
  [70, 243.58, 9037.513],
  [58, 119.81, 33718.147],
  [52, 297.17, 150.678],
  [50, 21.02, 2281.226],
  [45, 247.54, 29929.562],
  [44, 325.15, 31555.956],
  [29, 60.93, 4443.417],
  [18, 155.12, 67555.328],
  [17, 288.79, 4562.452],
  [16, 198.04, 62894.029],
  [14, 199.76, 31436.921],
  [12, 95.39, 14577.848],
  [12, 287.11, 31931.756],
  [12, 320.81, 34777.259],
  [9, 227.73, 1222.114],
  [8, 15.45, 16859.074],
];

/** Julian Ephemeris Day (TT) of an equinox or solstice of a given year. */
function solarEventJDE(year, eventKey) {
  let coefficients;
  let Y;
  if (year >= 1000) {
    coefficients = MEAN_EVENT_POLYNOMIALS_MODERN[eventKey];
    Y = (year - 2000) / 1000;
  } else {
    coefficients = MEAN_EVENT_POLYNOMIALS_ANCIENT[eventKey];
    Y = year / 1000;
  }
  const [c0, c1, c2, c3, c4] = coefficients;
  const jde0 = c0 + Y * (c1 + Y * (c2 + Y * (c3 + Y * c4)));

  const T = (jde0 - JD_J2000) / DAYS_PER_CENTURY;
  const W = rad(35999.373 * T - 2.47);
  const deltaLambda = 1 + 0.0334 * Math.cos(W) + 0.0007 * Math.cos(2 * W);
  let S = 0;
  for (const [A, B, C] of EVENT_PERIODIC_TERMS) {
    S += A * Math.cos(rad(B + C * T));
  }
  return jde0 + (0.00001 * S) / deltaLambda;
}

/**
 * Meeus ch. 27: instants (UTC) of the equinoxes and solstices of a Gregorian year.
 * @param {number} year Gregorian year (best accuracy between -1000 and 3000)
 * @returns {{ marchEquinox: Date, juneSolstice: Date, septemberEquinox: Date, decemberSolstice: Date }}
 */
export function solarEvents(year) {
  if (!Number.isInteger(year)) {
    throw new TypeError('year must be an integer');
  }
  return {
    marchEquinox: dateFromJulianEphemerisDay(solarEventJDE(year, 'marchEquinox')),
    juneSolstice: dateFromJulianEphemerisDay(solarEventJDE(year, 'juneSolstice')),
    septemberEquinox: dateFromJulianEphemerisDay(solarEventJDE(year, 'septemberEquinox')),
    decemberSolstice: dateFromJulianEphemerisDay(solarEventJDE(year, 'decemberSolstice')),
  };
}

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

const EVENT_ORDER = ['marchEquinox', 'juneSolstice', 'septemberEquinox', 'decemberSolstice'];

/** Season that begins at each event, per hemisphere. */
const SEASON_STARTED_BY = {
  north: { marchEquinox: 'printemps', juneSolstice: 'été', septemberEquinox: 'automne', decemberSolstice: 'hiver' },
  south: { marchEquinox: 'automne', juneSolstice: 'hiver', septemberEquinox: 'printemps', decemberSolstice: 'été' },
};

/** Astronomical name of each event, per hemisphere. */
const EVENT_NAMES = {
  north: {
    marchEquinox: 'équinoxe de printemps',
    juneSolstice: "solstice d'été",
    septemberEquinox: "équinoxe d'automne",
    decemberSolstice: "solstice d'hiver",
  },
  south: {
    marchEquinox: "équinoxe d'automne",
    juneSolstice: "solstice d'hiver",
    septemberEquinox: 'équinoxe de printemps',
    decemberSolstice: "solstice d'été",
  },
};

/**
 * Astronomical season for the civil date isoDate in timeZone.
 *
 * The season boundaries are the local civil dates of the equinoxes and solstices.
 * On the very day of an event, the outgoing season is still reported and `next` is
 * that day's event, with daysUntilNext = 0; the new season is reported from the
 * following day onwards.
 *
 * @param {string} isoDate 'YYYY-MM-DD'
 * @param {string} timeZone IANA time zone name
 * @param {'north'|'south'} [hemisphere='north']
 * @returns {{ season: string, start: Date, next: { name: string, date: Date }, daysUntilNext: number }}
 * season is one of 'printemps', 'été', 'automne', 'hiver'; start is the instant the
 * current season began; next.name is one of "équinoxe de printemps", "solstice d'été",
 * "équinoxe d'automne", "solstice d'hiver" for the given hemisphere.
 */
export function seasonInfo(isoDate, timeZone, hemisphere = 'north') {
  const { year } = parseIsoDate(isoDate);
  if (hemisphere !== 'north' && hemisphere !== 'south') {
    throw new RangeError(`hemisphere must be 'north' or 'south', got "${hemisphere}"`);
  }

  // Chronological list of the events of the surrounding years, with their local dates.
  const events = [];
  for (const y of [year - 1, year, year + 1]) {
    const yearEvents = solarEvents(y);
    for (const key of EVENT_ORDER) {
      const date = yearEvents[key];
      events.push({ key, date, localDate: localDateOf(date, timeZone) });
    }
  }

  let previous = null;
  let next = null;
  for (const event of events) {
    if (event.localDate < isoDate) {
      previous = event; // ISO strings compare chronologically
    } else {
      next = event;
      break;
    }
  }

  return {
    season: SEASON_STARTED_BY[hemisphere][previous.key],
    start: previous.date,
    next: { name: EVENT_NAMES[hemisphere][next.key], date: next.date },
    daysUntilNext: civilDayDifference(isoDate, next.localDate),
  };
}
