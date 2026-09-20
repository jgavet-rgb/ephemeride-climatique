// Calendar arithmetic: ISO dates, 366-key ring (MM-DD), ISO weeks, Easter and French
// holidays, DST transitions, French formatting. Pure functions, no DOM, no Date.now()
// except in todayISO() which is the single entry point for "now".

const MS_PER_DAY = 86400000;

export const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];
export const WEEKDAYS_FR = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
export const WEEKDAYS_SHORT_FR = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 366 MM-DD keys in leap-year order; '02-29' is at index 59. */
export const KEYS = (() => {
  const keys = [];
  const lengths = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= lengths[m - 1]; d++) keys.push(`${pad2(m)}-${pad2(d)}`);
  }
  return Object.freeze(keys);
})();

const KEY_INDEX = new Map(KEYS.map((k, i) => [k, i]));
export const LEAP_DAY_INDEX = 59;

export function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

export function daysInYear(y) {
  return isLeap(y) ? 366 : 365;
}

const ISO_RE = /^(-?\d{4,})-(\d{2})-(\d{2})$/;

/** Parse 'YYYY-MM-DD' into { y, m, d }; throws RangeError on an invalid date. */
export function parseISO(iso) {
  const match = ISO_RE.exec(String(iso));
  if (!match) throw new RangeError(`date ISO invalide : ${iso}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw new RangeError(`date ISO invalide : ${iso}`);
  }
  return { y, m, d };
}

export function isValidISO(iso) {
  try {
    parseISO(iso);
    return true;
  } catch {
    return false;
  }
}

export function toISO(y, m, d) {
  const year = y < 0 ? `-${String(-y).padStart(4, '0')}` : String(y).padStart(4, '0');
  return `${year}-${pad2(m)}-${pad2(d)}`;
}

function toEpochDays(iso) {
  const { y, m, d } = parseISO(iso);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

function fromEpochDays(days) {
  const date = new Date(days * MS_PER_DAY);
  return toISO(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function addDays(iso, n) {
  return fromEpochDays(toEpochDays(iso) + n);
}

/** Number of days from isoA to isoB (positive when isoB is later). */
export function diffDays(isoA, isoB) {
  return toEpochDays(isoB) - toEpochDays(isoA);
}

export function compareISO(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 1 = Monday ... 7 = Sunday (ISO 8601). */
export function isoWeekday(iso) {
  const days = toEpochDays(iso);
  // 1970-01-01 was a Thursday (ISO 4).
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

export function dayOfYear(iso) {
  const { y } = parseISO(iso);
  return diffDays(toISO(y, 1, 1), iso) + 1;
}

/** ISO 8601 week number and week-based year. */
export function isoWeek(iso) {
  const weekday = isoWeekday(iso);
  // The Thursday of the current week decides the week-based year.
  const thursday = addDays(iso, 4 - weekday);
  const week = Math.floor((dayOfYear(thursday) - 1) / 7) + 1;
  return { week, year: parseISO(thursday).y };
}

export function mmdd(iso) {
  return iso.slice(5, 10);
}

export function keyIndex(key) {
  const index = KEY_INDEX.get(key);
  if (index === undefined) throw new RangeError(`clé calendaire invalide : ${key}`);
  return index;
}

/** Shift a MM-DD key by `offset` days on the 366-day ring. */
export function shiftKey(key, offset) {
  const index = keyIndex(key);
  return KEYS[(((index + offset) % 366) + 366) % 366];
}

export function romanNumeral(n) {
  if (!Number.isInteger(n) || n <= 0 || n >= 4000) return String(n);
  const table = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  let rest = n;
  for (const [value, symbol] of table) {
    while (rest >= value) {
      out += symbol;
      rest -= value;
    }
  }
  return out;
}

/** Gregorian Easter Sunday (Meeus/Jones/Butcher algorithm). */
export function easter(y) {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toISO(y, month, day);
}

/** Last given ISO weekday (1..7) of a month. */
function lastWeekdayOfMonth(y, m, weekday) {
  const last = toISO(y, m, daysInMonth(y, m));
  const shift = (isoWeekday(last) - weekday + 7) % 7;
  return addDays(last, -shift);
}

/** n-th given ISO weekday (1..7) of a month (n from 1). */
function nthWeekdayOfMonth(y, m, weekday, n) {
  const first = toISO(y, m, 1);
  const shift = (weekday - isoWeekday(first) + 7) % 7;
  return addDays(first, shift + 7 * (n - 1));
}

/** French public holidays (metropolitan France; Alsace-Moselle adds two days). */
export function frenchHolidays(y, { alsaceMoselle = false } = {}) {
  const pascha = easter(y);
  const list = [
    { date: toISO(y, 1, 1), name: 'Jour de l’an' },
    { date: addDays(pascha, 1), name: 'Lundi de Pâques' },
    { date: toISO(y, 5, 1), name: 'Fête du Travail' },
    { date: toISO(y, 5, 8), name: 'Victoire de 1945' },
    { date: addDays(pascha, 39), name: 'Ascension' },
    { date: addDays(pascha, 50), name: 'Lundi de Pentecôte' },
    { date: toISO(y, 7, 14), name: 'Fête nationale' },
    { date: toISO(y, 8, 15), name: 'Assomption' },
    { date: toISO(y, 11, 1), name: 'Toussaint' },
    { date: toISO(y, 11, 11), name: 'Armistice de 1918' },
    { date: toISO(y, 12, 25), name: 'Noël' },
  ];
  if (alsaceMoselle) {
    list.push({ date: addDays(pascha, -2), name: 'Vendredi saint' });
    list.push({ date: toISO(y, 12, 26), name: 'Saint-Étienne' });
  }
  list.sort((a, b) => compareISO(a.date, b.date));
  return list;
}

export function holidaysOn(iso, opts) {
  const { y } = parseISO(iso);
  return frenchHolidays(y, opts).filter((h) => h.date === iso).map((h) => h.name);
}

/** Religious feasts tied to Easter, useful as day events. */
export function movableFeasts(y) {
  const pascha = easter(y);
  return [
    { date: addDays(pascha, -47), name: 'Mardi gras' },
    { date: addDays(pascha, -46), name: 'Mercredi des Cendres' },
    { date: addDays(pascha, -7), name: 'Dimanche des Rameaux' },
    { date: addDays(pascha, -2), name: 'Vendredi saint' },
    { date: pascha, name: 'Pâques' },
    { date: addDays(pascha, 49), name: 'Pentecôte' },
  ];
}

/** EU daylight-saving transitions: last Sunday of March and of October. */
export function dstTransitions(y) {
  return {
    start: lastWeekdayOfMonth(y, 3, 7),
    end: lastWeekdayOfMonth(y, 10, 7),
  };
}

/** French Mother's Day: last Sunday of May, or first Sunday of June when it is Pentecost. */
export function mothersDayFR(y) {
  const candidate = lastWeekdayOfMonth(y, 5, 7);
  const pentecost = addDays(easter(y), 49);
  return candidate === pentecost ? nthWeekdayOfMonth(y, 6, 7, 1) : candidate;
}

/** French Father's Day: third Sunday of June. */
export function fathersDayFR(y) {
  return nthWeekdayOfMonth(y, 6, 7, 3);
}

/** Civil and traditional events for a date (French usage). */
export function calendarEvents(iso) {
  const { y, m, d } = parseISO(iso);
  const events = [];
  const dst = dstTransitions(y);
  if (iso === dst.start) events.push('Passage à l’heure d’été (+1 h à 2 h)');
  if (iso === dst.end) events.push('Passage à l’heure d’hiver (−1 h à 3 h)');
  if (iso === mothersDayFR(y)) events.push('Fête des mères');
  if (iso === fathersDayFR(y)) events.push('Fête des pères');
  for (const feast of movableFeasts(y)) {
    if (feast.date === iso && !holidaysOn(iso).includes(feast.name)) events.push(feast.name);
  }
  if (m === 1 && d === 6) events.push('Épiphanie');
  if (m === 2 && d === 2) events.push('Chandeleur');
  if (m === 2 && d === 14) events.push('Saint-Valentin');
  if (m === 6 && d === 21) events.push('Fête de la musique');
  if (m === 10 && d === 31) events.push('Halloween');
  if (m === 12 && d === 31) events.push('Saint-Sylvestre');
  return events;
}

/** Civil date "today" in an IANA time zone (the only place using the system clock). */
export function todayISO(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function formatLongFR(iso) {
  const { y, m, d } = parseISO(iso);
  const weekday = WEEKDAYS_FR[isoWeekday(iso) - 1];
  const day = d === 1 ? '1er' : String(d);
  return `${weekday} ${day} ${MONTHS_FR[m - 1]} ${y}`;
}

export function formatDayMonthFR(iso) {
  const { m, d } = parseISO(iso);
  const day = d === 1 ? '1er' : String(d);
  return `${day} ${MONTHS_FR[m - 1]}`;
}

export function formatShortFR(iso) {
  const { y, m, d } = parseISO(iso);
  return `${pad2(d)}/${pad2(m)}/${y}`;
}

export function monthTitleFR(y, m) {
  const name = MONTHS_FR[m - 1];
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${y}`;
}

/** Weeks of a month as rows of 7 ISO dates or null, Monday first. */
export function monthGrid(y, m) {
  const first = toISO(y, m, 1);
  const lead = isoWeekday(first) - 1;
  const total = daysInMonth(y, m);
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(toISO(y, m, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function addMonths(y, m, n) {
  const total = y * 12 + (m - 1) + n;
  return { y: Math.floor(total / 12), m: (total % 12 + 12) % 12 + 1 };
}

/** Clamp a day to a month length (used when navigating month to month). */
export function clampDay(y, m, d) {
  return Math.min(d, daysInMonth(y, m));
}

export function quarter(m) {
  return Math.floor((m - 1) / 3) + 1;
}
