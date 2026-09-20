import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseJSONL, fnv1a32, indexQuotes, selectQuote, coverage, yearsAgo } from '../../assets/js/quotes.js';

const here = dirname(fileURLToPath(import.meta.url));

function entry(id, author, date, verified = true) {
  return {
    id, author, date, verified, lang: 'en', medium: 'other', added: '2026-01-01',
    text: `Sample text for ${id} long enough`, source_url: 'https://example.org/',
  };
}

test('parseJSONL ignores comments and blank lines and reports bad lines', () => {
  const text = '# header\n\n{"a":1}\nnot json\n{"b":2}\n';
  const { entries, errors } = parseJSONL(text);
  assert.equal(entries.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 4);
});

test('the shipped quotes.jsonl parses and contains only the example line', () => {
  const text = readFileSync(join(here, '..', '..', 'data', 'quotes.jsonl'), 'utf8');
  const { entries, errors } = parseJSONL(text);
  assert.equal(errors.length, 0);
  assert.ok(entries.length >= 1);
  assert.equal(indexQuotes(entries).size, 0); // example is verified: false
});

test('fnv1a32 is stable', () => {
  assert.equal(fnv1a32(''), 0x811c9dc5);
  assert.equal(fnv1a32('a'), 0xe40c292c);
  assert.equal(fnv1a32('2026-09-17|musk,trump'), fnv1a32('2026-09-17|musk,trump'));
});

test('selection is deterministic, filtered by author, cycles with offset', () => {
  const entries = [
    entry('trump-2018-09-17-001', 'trump', '2018-09-17'),
    entry('trump-2019-09-17-001', 'trump', '2019-09-17'),
    entry('musk-2020-09-17-001', 'musk', '2020-09-17'),
    entry('musk-2020-09-18-001', 'musk', '2020-09-18'),
    entry('trump-2017-01-01-001', 'trump', '2017-01-01', false),
  ];
  const index = indexQuotes(entries);
  assert.equal(index.get('09-17').length, 3);
  assert.equal(index.has('01-01'), false);

  const a = selectQuote(index, '2026-09-17');
  const b = selectQuote(index, '2026-09-17');
  assert.equal(a.quote.id, b.quote.id);
  assert.deepEqual(a.fallback, { days: 0, allAuthors: false, key: '09-17' });
  assert.equal(a.candidates.length, 3);

  const onlyMusk = selectQuote(index, '2026-09-17', { authors: ['musk'] });
  assert.equal(onlyMusk.quote.author, 'musk');
  assert.equal(onlyMusk.candidates.length, 1);

  const seen = new Set();
  for (let k = 0; k < 3; k++) seen.add(selectQuote(index, '2026-09-17', { offset: k }).quote.id);
  assert.equal(seen.size, 3);
});

test('fallbacks: all authors, then neighbouring days, then nothing', () => {
  const entries = [entry('musk-2020-09-18-001', 'musk', '2020-09-18')];
  const index = indexQuotes(entries);
  const r1 = selectQuote(index, '2026-09-18', { authors: ['trump'] });
  assert.equal(r1.quote.author, 'musk');
  assert.deepEqual(r1.fallback, { days: 0, allAuthors: true, key: '09-18' });
  const r2 = selectQuote(index, '2026-09-17');
  assert.equal(r2.quote.id, 'musk-2020-09-18-001');
  assert.equal(r2.fallback.days, 1);
  const r3 = selectQuote(index, '2026-09-21');
  assert.equal(r3.fallback.days, -3);
  const r4 = selectQuote(index, '2026-09-22');
  assert.equal(r4.quote, null);
  // 29 February falls back to 28 February.
  const feb = indexQuotes([entry('trump-2019-02-28-001', 'trump', '2019-02-28')]);
  const r5 = selectQuote(feb, '2024-02-29');
  assert.equal(r5.fallback.key, '02-28');
});

test('coverage counts days and entries per author', () => {
  const entries = [
    entry('trump-2018-09-17-001', 'trump', '2018-09-17'),
    entry('trump-2019-09-17-001', 'trump', '2019-09-17'),
    entry('musk-2020-09-18-001', 'musk', '2020-09-18'),
  ];
  const c = coverage(entries);
  assert.equal(c.covered, 2);
  assert.equal(c.total, 366);
  assert.equal(c.missing.length, 364);
  assert.equal(c.byAuthor.trump.entries, 2);
  assert.equal(c.byAuthor.trump.days, 1);
  assert.equal(c.byAuthor.musk.days, 1);
  assert.equal(c.verified, 3);
});

test('yearsAgo counts whole years', () => {
  assert.equal(yearsAgo('2026-09-17', '2018-09-17'), 8);
  assert.equal(yearsAgo('2026-09-17', '2018-09-18'), 7);
  assert.equal(yearsAgo('2026-09-17', '2026-09-17'), 0);
});
