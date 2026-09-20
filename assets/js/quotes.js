// Dated quotes: JSONL parsing, deterministic selection with documented fallbacks,
// coverage statistics (DATA_FORMATS.md, section 4).

import { KEYS, mmdd, shiftKey, parseISO } from './dates.js';

export const AUTHORS = Object.freeze({
  trump: { name: 'Donald Trump', handle: 'realDonaldTrump' },
  musk: { name: 'Elon Musk', handle: 'elonmusk' },
});

export const MEDIUM_FR = Object.freeze({
  twitter: 'Twitter',
  x: 'X',
  truth_social: 'Truth Social',
  speech: 'discours',
  interview: 'entretien',
  press_conference: 'conférence de presse',
  earnings_call: 'présentation de résultats',
  hearing: 'audition',
  book: 'livre',
  other: 'autre',
});

/** Parse JSONL text; blank lines and lines starting with '#' are ignored. */
export function parseJSONL(text) {
  const entries = [];
  const errors = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        entries.push(obj);
      } else {
        errors.push({ line: i + 1, message: 'objet JSON attendu' });
      }
    } catch (err) {
      errors.push({ line: i + 1, message: err.message });
    }
  });
  return { entries, errors };
}

/** FNV-1a 32-bit hash of a string (stable across platforms). */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function isDisplayable(entry) {
  return entry
    && entry.verified === true
    && typeof entry.text === 'string'
    && typeof entry.date === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
    && typeof entry.source_url === 'string'
    && /^https?:\/\//.test(entry.source_url)
    && (entry.author === 'trump' || entry.author === 'musk');
}

/** Map MM-DD -> verified entries sorted by id. */
export function indexQuotes(entries) {
  const index = new Map();
  for (const entry of entries) {
    if (!isDisplayable(entry)) continue;
    const key = mmdd(entry.date);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(entry);
  }
  for (const list of index.values()) list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return index;
}

function filterKey(authors) {
  return [...authors].sort().join(',');
}

/**
 * Select the quote for a date. authors: iterable of 'trump' | 'musk'.
 * Fallback order: same MM-DD (filtered), same MM-DD (all authors), then ±1, ±2, ±3 days,
 * each first filtered then all authors. offset cycles through the candidates ("autre").
 */
export function selectQuote(index, iso, { authors = ['trump', 'musk'], offset = 0 } = {}) {
  const wanted = new Set(authors);
  const allAuthors = Object.keys(AUTHORS);
  const filtered = wanted.size > 0 && wanted.size < allAuthors.length;
  const key = mmdd(iso);
  const steps = [0, -1, 1, -2, 2, -3, 3];
  for (const days of steps) {
    const shifted = shiftKey(key, days);
    const list = index.get(shifted) || [];
    const attempts = filtered
      ? [{ candidates: list.filter((q) => wanted.has(q.author)), allAuthors: false },
         { candidates: list, allAuthors: true }]
      : [{ candidates: list, allAuthors: false }];
    for (const attempt of attempts) {
      const candidates = attempt.candidates;
      if (candidates.length === 0) continue;
      const seed = fnv1a32(`${iso}|${filterKey(attempt.allAuthors ? allAuthors : wanted)}`);
      const position = (((seed + offset) % candidates.length) + candidates.length) % candidates.length;
      return {
        quote: candidates[position],
        candidates,
        position,
        fallback: { days, allAuthors: attempt.allAuthors, key: shifted },
      };
    }
  }
  return { quote: null, candidates: [], position: 0, fallback: null };
}

/** Coverage of the 366 MM-DD keys by verified entries, overall and per author. */
export function coverage(entries) {
  const index = indexQuotes(entries);
  const byAuthor = {};
  for (const author of Object.keys(AUTHORS)) byAuthor[author] = { entries: 0, days: 0 };
  let covered = 0;
  const missing = [];
  for (const key of KEYS) {
    const list = index.get(key) || [];
    if (list.length > 0) covered += 1; else missing.push(key);
    const seen = new Set();
    for (const q of list) {
      byAuthor[q.author].entries += 1;
      seen.add(q.author);
    }
    for (const author of seen) byAuthor[author].days += 1;
  }
  return { covered, total: KEYS.length, missing, byAuthor, verified: covered ? [...index.values()].reduce((n, l) => n + l.length, 0) : 0 };
}

/** Whole years between the quote date and the displayed date (0 when same year). */
export function yearsAgo(displayISO, quoteISO) {
  const a = parseISO(quoteISO);
  const b = parseISO(displayISO);
  let years = b.y - a.y;
  if (b.m < a.m || (b.m === a.m && b.d < a.d)) years -= 1;
  return years;
}

export function authorName(author) {
  return AUTHORS[author] ? AUTHORS[author].name : author;
}

export function mediumLabel(medium) {
  return MEDIUM_FR[medium] || medium;
}
