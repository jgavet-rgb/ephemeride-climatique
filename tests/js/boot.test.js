// End-to-end boot of the application in jsdom, with fetch mocked: local data files are read
// from disk, Open-Meteo answers from fixtures. Checks the wiring of app.js (routing, loading,
// rendering, navigation, error paths) which the view tests do not cover.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const calls = [];
let failForecast = false;

function mockFetch(url) {
  const href = String(url);
  calls.push(href);
  if (href.startsWith('data/')) {
    try {
      return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(read(href)), text: async () => read(href) });
    } catch {
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
    }
  }
  if (href.startsWith('https://api.open-meteo.com/')) {
    if (failForecast) return Promise.reject(new Error('réseau coupé'));
    return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(read('tests/fixtures/forecast_sample.json')) });
  }
  if (href.startsWith('https://archive-api.open-meteo.com/')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ latitude: 45.25, longitude: 5.75, elevation: 216, daily: { time: [], temperature_2m_mean: [] } }) });
  }
  return Promise.reject(new Error(`URL inattendue : ${href}`));
}

let app;
const settle = async (ms = 40) => { await new Promise((r) => setTimeout(r, ms)); };

before(async () => {
  const dom = new JSDOM(read('index.html'), { url: 'https://example.org/depot/', runScripts: 'outside-only' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.history = dom.window.history;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
  globalThis.fetch = mockFetch;
  dom.window.fetch = mockFetch;
  globalThis.__EC_NO_AUTOSTART__ = true;
  app = await import('../../assets/js/app.js');
  await app.init();
  await settle(120);
});

test('index.html declares a CSP limited to the repository and Open-Meteo', () => {
  const csp = read('index.html').match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.open-meteo\.com https:\/\/archive-api\.open-meteo\.com https:\/\/geocoding-api\.open-meteo\.com/);
  assert.match(csp, /script-src 'self'/);
});

test('boot renders the day view for today at the default location', () => {
  const text = document.getElementById('app').textContent;
  assert.match(text, /Éphéméride climatique/);
  assert.equal(app.state.location.slug, 'grenoble');
  assert.equal(app.state.view, 'day');
  assert.match(text, /Grenoble/);
  assert.equal(document.querySelectorAll('section.card').length, 3);
  assert.match(window.location.hash, /^#\/j\/\d{4}-\d{2}-\d{2}\?lieu=grenoble$/);
});

test('only the repository and Open-Meteo were contacted', () => {
  const hosts = new Set(calls.map((c) => (c.startsWith('http') ? new URL(c).host : 'depot')));
  assert.deepEqual([...hosts].sort(), ['api.open-meteo.com', 'depot']);
  // The precomputed climatology is read from the repository, no archive download is needed.
  assert.ok(calls.includes('data/climatology/grenoble.json'));
  assert.equal(calls.filter((c) => c.startsWith('https://archive-api')).length, 0);
});

test('the precomputed climatology is loaded and feeds the anomalies', () => {
  assert.equal(app.runtime.climStatus, 'ready');
  assert.equal(app.runtime.clim.firstYear, 1940);
  assert.ok(document.querySelector('.anomaly-chip'));
  assert.match(document.getElementById('block-c').textContent, /vs normale 1991-2020/);
});

test('navigation: arrows, today, month and year views, hash follows', async () => {
  const start = app.state.date;
  app.actions.step(1);
  await settle();
  assert.notEqual(app.state.date, start);
  assert.match(window.location.hash, new RegExp(`#/j/${app.state.date}`));

  app.actions.setView('month');
  await settle();
  assert.match(window.location.hash, /#\/m\/\d{4}-\d{2}/);
  assert.ok(document.querySelector('table.month-grid'));

  app.actions.setView('year');
  await settle();
  assert.match(window.location.hash, /#\/a\/\d{4}/);
  assert.ok(document.querySelector('table.year-grid'));

  app.actions.setView('day');
  app.actions.today();
  await settle();
  assert.equal(app.state.date, app.runtime.today);
});

test('goTo navigates to an old date and keeps the three blocks', async () => {
  app.actions.goTo('1976-07-04');
  await settle();
  assert.equal(app.state.date, '1976-07-04');
  assert.equal(document.querySelectorAll('section.card').length, 3);
  assert.match(document.getElementById('block-c').textContent, /observé \(réanalyse ERA5\)/);
});

test('dates are clamped to the navigable range', () => {
  assert.equal(app.clampDate('1500-01-01'), '1900-01-01');
  assert.equal(app.clampDate('2500-01-01'), '2100-12-31');
  assert.equal(app.clampDate('2026-02-29'), '2026-02-28');
});

test('out-of-data dates fall back to normals and records only', async () => {
  app.actions.goTo('2100-12-31');
  await settle();
  const text = document.getElementById('block-c').textContent;
  assert.match(text, /hors données/);
  assert.match(text, /record chaud/);
  assert.equal(document.querySelectorAll('section.card').length, 3);

  app.actions.goTo('1900-01-01');
  await settle();
  assert.match(document.getElementById('block-c').textContent, /hors données/);
  assert.match(document.getElementById('block-a').textContent, /Lever/);
});

test('a weather failure leaves blocks A and B intact and offers a retry', async () => {
  failForecast = true;
  app.actions.goTo('2026-09-17');
  await settle();
  app.actions.retryWeather();
  // fetchJSON retries once after 800 ms before giving up.
  await settle(2200);
  assert.equal(app.runtime.forecastStatus, 'error');
  const text = document.getElementById('app').textContent;
  assert.match(text, /Météo indisponible/);
  assert.match(text, /Réessayer/);
  assert.match(document.getElementById('block-a').textContent, /Lever/);
  assert.equal(document.querySelectorAll('section.card').length, 3);
  failForecast = false;
});

test('preferences are persisted', async () => {
  app.actions.setBaseline('preindustrial');
  await settle();
  assert.equal(JSON.parse(localStorage.getItem('ec:baseline')), 'preindustrial');
  app.actions.toggleAuthor('musk', false);
  await settle();
  assert.deepEqual(JSON.parse(localStorage.getItem('ec:authors')), ['trump']);
  // At least one author always stays selected.
  app.actions.toggleAuthor('trump', false);
  await settle();
  assert.equal(app.state.authors.length, 1);
  app.actions.setBaseline('normal');
  app.actions.toggleAuthor('musk', true);
  await settle();
});
