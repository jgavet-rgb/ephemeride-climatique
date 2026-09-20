// DOM smoke tests of the three views with the real data files (jsdom, no network).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let renderDay; let renderMonth; let renderYear; let Climatology; let indexQuotes; let indexForecast; let parseHash; let buildHash;
let ctxBase;

before(async () => {
  const dom = new JSDOM('<!DOCTYPE html><html lang="fr"><body><div id="app"></div><div id="live"></div></body></html>', { url: 'https://example.org/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.history = dom.window.history;
  // globalThis.navigator is getter-only on recent Node versions.
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
  globalThis.__EC_NO_AUTOSTART__ = true;

  ({ renderDay } = await import('../../assets/js/views/day.js'));
  ({ renderMonth } = await import('../../assets/js/views/month.js'));
  ({ renderYear } = await import('../../assets/js/views/year.js'));
  ({ Climatology } = await import('../../assets/js/climate.js'));
  ({ indexQuotes } = await import('../../assets/js/quotes.js'));
  ({ indexForecast } = await import('../../assets/js/weather.js'));
  ({ parseHash, buildHash } = await import('../../assets/js/app.js'));

  const saints = JSON.parse(read('data/saints.json'));
  const republican = JSON.parse(read('data/republican.json'));
  const locations = JSON.parse(read('data/locations.json')).locations;
  const baselines = JSON.parse(read('data/baselines.json'));
  const clim = new Climatology(JSON.parse(read('data/climatology/grenoble.json')));
  const forecast = JSON.parse(read('tests/fixtures/forecast_sample.json'));
  const quotes = indexQuotes([{
    id: 'trump-2018-09-17-001', author: 'trump', date: '2018-09-17', verified: true, lang: 'en', medium: 'twitter',
    text: 'Sample verified text used only by the rendering test', source_url: 'https://example.org/status/1', added: '2026-01-01',
    text_fr: 'Texte exemple utilisé uniquement par le test de rendu', translation: 'machine', context: 'Contexte de test',
  }]);
  const noop = () => {};
  ctxBase = {
    state: {
      view: 'day', date: '2026-09-17', location: locations[0], authors: ['trump', 'musk'], baseline: 'normal',
      quoteOffset: 0, showTranslation: false, theme: 'auto',
    },
    data: { saints, republican, quotesIndex: quotes, baselines },
    clim, climStatus: 'ready', climProgress: '', climError: '',
    forecast, forecastIndex: indexForecast(forecast), forecastStatus: 'ready', forecastError: '',
    archiveDay: null,
    regionDelta: { slug: 'france', ...baselines.regions.france },
    today: '2026-09-17',
    actions: {
      goTo: noop, setView: noop, toggleAuthor: noop, nextQuote: noop, toggleTranslation: noop, setBaseline: noop,
      retryWeather: noop, retryClimatology: noop, openMethod: noop,
    },
  };
});

test('day view renders the three blocks with real data', () => {
  const node = renderDay(ctxBase);
  const text = node.textContent;
  assert.match(text, /jeudi 17 septembre 2026/);
  assert.match(text, /jour 260\/365/);
  assert.match(text, /1er jour complémentaire an CCXXXIV/);
  assert.match(text, /Vertu/);
  assert.match(text, /Renaud/);              // saint of 17 September
  assert.match(text, /07:17/);               // sunrise in Europe/Paris
  assert.match(text, /19:44/);               // sunset
  assert.match(text, /Sample verified text/);
  assert.match(text, /Donald Trump/);
  assert.match(text, /il y a 8 ans/);
  assert.match(text, /22,6 °C/);        // current temperature from the fixture
  assert.match(text, /vs normale 1991-2020/);
  assert.match(text, /vs pré-industriel 1850-1900/);
  assert.match(text, /record chaud/);
  assert.match(text, /Ce 17 septembre depuis 1940/);
  assert.equal(node.querySelectorAll('section.card').length, 3);
  const stripes = node.querySelectorAll('svg.stripes');
  assert.ok(stripes.length >= 2);
  // Day stripes: one rect per year in the climatology (87 years) plus the hatch pattern rects.
  const dayRects = stripes[0].querySelectorAll('rect.stripe');
  assert.equal(dayRects.length, ctxBase.clim.years.length);
  assert.ok(node.querySelector('.anomaly-chip .chip-value').textContent.length > 0);
});

test('day view without climatology and with weather error still renders blocks A and B', () => {
  const ctx = { ...ctxBase, clim: null, climStatus: 'error', climError: 'test', forecast: null, forecastIndex: new Map(), forecastStatus: 'error', forecastError: 'hors ligne' };
  const node = renderDay(ctx);
  const text = node.textContent;
  assert.match(text, /Renaud/);
  assert.match(text, /Sample verified text/);
  assert.match(text, /Météo indisponible/);
  assert.match(text, /Climatologie indisponible/);
  assert.equal(node.querySelectorAll('section.card').length, 3);
});

test('day view for a date without quote shows the empty state', () => {
  const ctx = { ...ctxBase, state: { ...ctxBase.state, date: '1976-07-04' } };
  const node = renderDay(ctx);
  assert.match(node.textContent, /Aucune citation vérifiée/);
  assert.match(node.textContent, /observé \(réanalyse ERA5\)/);
  assert.match(node.textContent, /le plus chaud sur/);
});

test('translation toggle shows the French text', () => {
  const ctx = { ...ctxBase, state: { ...ctxBase.state, showTranslation: true } };
  const node = renderDay(ctx);
  assert.match(node.textContent, /Texte exemple utilisé/);
  assert.match(node.textContent, /Texte original/);
});

test('month view renders 30 day cells for September 2026 with colours', () => {
  const node = renderMonth(ctxBase);
  const cells = node.querySelectorAll('td.cell:not(.cell-empty)');
  assert.equal(cells.length, 30);
  assert.ok(node.querySelector('td.cell.is-today'));
  // ERA5 covers 1 to 11 September (source.end = 2026-09-11), the forecast fixture 16 to 18:
  // 14 coloured cells, the other 16 days are out of data and stay hatched.
  const coloured = [...node.querySelectorAll('.cell-btn')].filter((b) => b.style.background);
  assert.equal(coloured.length, 14);
  assert.equal(node.querySelectorAll('td.cell.no-data').length, 16);
  assert.equal(node.querySelectorAll('td.cell.is-forecast').length, 2); // today and tomorrow
  assert.ok(node.textContent.includes('Septembre 2026'));
});

test('year view renders 365 cells for 2026', () => {
  const node = renderYear(ctxBase);
  const cells = node.querySelectorAll('td.ycell:not(.ycell-empty)');
  assert.equal(cells.length, 365);
  assert.match(node.textContent, /Année 2026/);
});

test('hash routing round-trips', () => {
  assert.deepEqual(parseHash('#/j/2026-09-17?lieu=grenoble'), { view: 'day', date: '2026-09-17', lieu: 'grenoble' });
  assert.deepEqual(parseHash('#/m/2026-09'), { view: 'month', date: '2026-09-01', lieu: null });
  assert.deepEqual(parseHash('#/a/1976'), { view: 'year', date: '1976-01-01', lieu: null });
  assert.deepEqual(parseHash(''), { view: 'day', date: null, lieu: null });
  assert.deepEqual(parseHash('#/j/2026-02-30'), { view: 'day', date: null, lieu: null });
  assert.equal(buildHash('day', '2026-09-17', 'grenoble'), '#/j/2026-09-17?lieu=grenoble');
  assert.equal(buildHash('month', '2026-09-17', null), '#/m/2026-09');
  assert.equal(buildHash('year', '2026-09-17', '45.1787,5.7148'), '#/a/2026?lieu=45.1787%2C5.7148');
});
