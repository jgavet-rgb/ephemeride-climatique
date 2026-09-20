import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { isSextile, vendemiaireStart, toRepublican, formatRepublican, articleFor } from '../../assets/js/republican.js';

const here = dirname(fileURLToPath(import.meta.url));
const names = JSON.parse(readFileSync(join(here, '..', '..', 'data', 'republican.json'), 'utf8'));

test('sextile years: historical rule then Romme rule', () => {
  assert.deepEqual([1, 2, 3, 4, 7, 11, 15, 16, 19, 20, 24, 100, 200, 236, 400].map(isSextile),
    [false, false, true, false, true, true, true, false, false, true, true, false, false, true, true]);
});

test('1 Vendémiaire dates match the historical and the Romme concordance', () => {
  assert.equal(vendemiaireStart(1), '1792-09-22');
  assert.equal(vendemiaireStart(4), '1795-09-23');
  assert.equal(vendemiaireStart(8), '1799-09-23');
  assert.equal(vendemiaireStart(12), '1803-09-24');
  assert.equal(vendemiaireStart(14), '1805-09-23');
  assert.equal(vendemiaireStart(234), '2025-09-22');
  assert.equal(vendemiaireStart(235), '2026-09-22');
  assert.equal(vendemiaireStart(236), '2027-09-22');
  assert.equal(vendemiaireStart(237), '2028-09-22');
});

test('known conversions', () => {
  const t1 = toRepublican('1792-09-22');
  assert.equal(t1.year, 1); assert.equal(t1.month, 1); assert.equal(t1.day, 1);
  const t2 = toRepublican('1794-07-27');
  assert.equal(t2.year, 2); assert.equal(t2.month, 11); assert.equal(t2.day, 9); // 9 Thermidor II
  const t3 = toRepublican('1799-11-09');
  assert.equal(t3.year, 8); assert.equal(t3.month, 2); assert.equal(t3.day, 18); // 18 Brumaire VIII
  const t4 = toRepublican('1806-01-01');
  assert.equal(t4.year, 14); assert.equal(t4.month, 4); assert.equal(t4.day, 11); // 11 Nivôse XIV
  const t5 = toRepublican('2026-09-17');
  assert.equal(t5.year, 234); assert.equal(t5.month, 13); assert.equal(t5.day, 1); // 1er jour complémentaire
  const t6 = toRepublican('2026-09-16');
  assert.equal(t6.month, 12); assert.equal(t6.day, 30);
  assert.equal(toRepublican('1792-09-21'), null);
});

test('formatting with day names', () => {
  const f = formatRepublican(toRepublican('2026-09-16'), names);
  assert.equal(f.dayName, 'Panier');
  assert.equal(f.text, '30 fructidor an CCXXXIV');
  assert.equal(f.decadeName, 'Décadi');
  assert.equal(f.dayLabel, 'jour du Panier');
  const g = formatRepublican(toRepublican('2026-09-17'), names);
  assert.equal(g.dayName, 'Vertu');
  assert.equal(g.text, '1er jour complémentaire an CCXXXIV');
  const h = formatRepublican(toRepublican('2026-09-22'), names);
  assert.equal(h.text, '1er vendémiaire an CCXXXV');
  assert.equal(h.dayName, 'Raisin');
  assert.equal(articleFor('Âne'), 'de l’');
  assert.equal(articleFor('Hotte'), 'de la ');
  assert.equal(articleFor('Hêtre'), 'de l’');
  assert.equal(articleFor('Récompenses'), 'des ');
  assert.equal(articleFor('Bœuf'), 'du ');
});
