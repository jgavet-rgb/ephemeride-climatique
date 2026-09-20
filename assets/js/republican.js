// French Republican calendar, Romme continuation rule (DATA_FORMATS.md, section 6).
//
// Sextile (366-day) years: III, VII, XI and XV by the historical equinox rule, then from
// year XX the Gregorian rule applied to the year number (N % 4 === 0, except N % 100 === 0
// unless N % 400 === 0). 1 Vendémiaire of year N is 1792-09-22 + 365 (N - 1) + S(N - 1)
// days, where S(k) counts sextile years among 1..k. Checked against the concordance table
// of the source page for 2026-2050 (year CCXXXV starts on 2026-09-22).

import { addDays, diffDays, parseISO, romanNumeral } from './dates.js';

export const EPOCH = '1792-09-22';

export function isSextile(n) {
  if (n < 20) return n === 3 || n === 7 || n === 11 || n === 15;
  return (n % 4 === 0 && n % 100 !== 0) || n % 400 === 0;
}

/** Number of sextile years among republican years 1..k. */
export function sextileCount(k) {
  let count = 0;
  for (let n = 1; n <= k; n++) if (isSextile(n)) count += 1;
  return count;
}

/** Gregorian ISO date of 1 Vendémiaire of republican year n (n >= 1). */
export function vendemiaireStart(n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('an républicain invalide');
  return addDays(EPOCH, 365 * (n - 1) + sextileCount(n - 1));
}

/**
 * Convert a Gregorian ISO date to the republican calendar.
 * Returns null for dates before 1792-09-22.
 * month: 1..12, or 13 for the complementary days (sansculottides); day: 1..30 (1..6 in month 13).
 */
export function toRepublican(iso) {
  const { y } = parseISO(iso);
  if (iso < EPOCH) return null;
  // Estimate the republican year, then correct so that start(n) <= iso < start(n + 1).
  let n = Math.max(1, y - 1792);
  while (vendemiaireStart(n + 1) <= iso) n += 1;
  while (n > 1 && vendemiaireStart(n) > iso) n -= 1;
  const rank = diffDays(vendemiaireStart(n), iso) + 1; // 1..366
  const month = Math.floor((rank - 1) / 30) + 1;
  const day = ((rank - 1) % 30) + 1;
  return {
    year: n,
    roman: romanNumeral(n),
    month,
    day,
    rank,
    sextile: isSextile(n),
    decade: month <= 12 ? Math.floor((day - 1) / 10) + 1 : null,
    decadeDay: month <= 12 ? ((day - 1) % 10) + 1 : null,
  };
}

/**
 * Human-readable pieces for a republican date, using data/republican.json content.
 * names = { months, days, complementary, decade_days }.
 */
export function formatRepublican(rep, names) {
  if (!rep) return null;
  const monthName = rep.month <= 12 ? names.months[rep.month - 1] : 'jour complémentaire';
  const dayName = rep.month <= 12
    ? names.days[(rep.month - 1) * 30 + rep.day - 1]
    : names.complementary[rep.day - 1];
  const decadeName = rep.decadeDay ? names.decade_days[rep.decadeDay - 1] : null;
  const dayLabel = rep.day === 1 ? '1er' : String(rep.day);
  const text = rep.month <= 12
    ? `${dayLabel} ${monthName.toLowerCase()} an ${rep.roman}`
    : `${ordinalFR(rep.day)} jour complémentaire an ${rep.roman}`;
  const article = dayName ? articleFor(dayName) : '';
  return {
    text,
    monthName,
    dayName,
    decadeName,
    dayLabel: dayName ? `jour ${article}${dayName}` : null,
  };
}

function ordinalFR(n) {
  return n === 1 ? '1er' : `${n}e`;
}

/** "du", "de la", "de l'", "des" chosen from the day name. */
export function articleFor(name) {
  if (PLURAL.has(name)) return 'des ';
  const first = name.charAt(0).toLowerCase();
  if (/^[aeiouyàâäéèêëîïôöûüœ]/.test(first) || H_MUET.has(name)) return 'de l’';
  return FEMININE.has(name) ? 'de la ' : 'du ';
}

const PLURAL = new Set(['Récompenses']);
// Names starting with a mute h (elision applies); the other h-names are aspirated.
const H_MUET = new Set(['Hémérocalle', 'Hêtre', 'Héliotrope', 'Hyacinthe']);

// Feminine day names of the republican calendar (Fabre d'Églantine's nomenclature).
const FEMININE = new Set([
  'Châtaigne', 'Colchique', 'Balsamine', 'Carotte', 'Amarante', 'Cuve', 'Pomme de terre',
  'Immortelle', 'Citrouille', 'Pêche', 'Amaryllis', 'Aubergine', 'Tomate', 'Pomme', 'Poire',
  'Betterave', 'Oie', 'Figue', 'Scorsonère', 'Charrue', 'Mâcre', 'Endive', 'Dentelaire',
  'Grenade', 'Herse', 'Bacchante', 'Azerole', 'Garance', 'Pistache', 'Raiponce', 'Chicorée',
  'Nèfle', 'Mâche', 'Pioche', 'Cire', 'Sabine', 'Bruyère', 'Oseille', 'Truffe', 'Olive',
  'Pelle', 'Tourbe', 'Houille', 'Lave', 'Terre végétale', 'Argile', 'Ardoise', 'Marne',
  'Pierre à chaux', 'Pierre à plâtre', 'Mousse', 'Perce neige', 'Cognée', 'Vache', 'Pulmonaire',
  'Serpette', 'Thymèle', 'Trainasse', 'Guède', 'Chélidoine', 'Violette', 'Bêche', 'Fumeterre',
  'Chèvre', 'Mandragore', 'Cochléaria', 'Pâquerette', 'Sylvie', 'Capillaire', 'Primevère',
  'Asperge', 'Tulipe', 'Poule', 'Bette', 'Jonquille', 'Pervenche', 'Morille', 'Abeille',
  'Laitue', 'Ciguë', 'Ruche', 'Romaine', 'Roquette', 'Anémone', 'Pensée', 'Myrtille', 'Rose',
  'Fougère', 'Aubépine', 'Ancolie', 'Hyacinthe', 'Rhubarbe', 'Pimprenelle', 'Corbeille d’or',
  'Arroche', 'Statice', 'Fritillaire', 'Bourrache', 'Valériane', 'Carpe', 'Civette', 'Buglosse',
  'Houlette', 'Luzerne', 'Hémérocalle', 'Angélique', 'Mélisse', 'Faux', 'Fraise', 'Bétoine',
  'Caille', 'Camomille', 'Tanche', 'Verveine', 'Pivoine', 'Véronique', 'Absinthe', 'Faucille',
  'Coriandre', 'Giroflée', 'Lavande', 'Groseille', 'Gesse', 'Cerise', 'Menthe', 'Pintade',
  'Sauge', 'Vesce', 'Chalemie', 'Ivraie', 'Prêle', 'Armoise', 'Mûre', 'Salicorne', 'Brebis',
  'Guimauve', 'Amande', 'Gentiane', 'Écluse', 'Carline', 'Lentille', 'Aunée', 'Loutre',
  'Prune', 'Tubéreuse', 'Réglisse', 'Échelle', 'Pastèque', 'Épine-vinette', 'Noix', 'Truite',
  'Cardère', 'Tagette', 'Hotte', 'Noisette', 'Écrevisse', 'Bigarade', 'Verge d’or',
  'Vertu', 'Opinion', 'Révolution',
]);
