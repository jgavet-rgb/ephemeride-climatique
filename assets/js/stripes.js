// Climate stripes rendering: diverging palette, inline SVG bands with keyboard access,
// legend and an accessible table fallback. No library.

const SVG_NS = 'http://www.w3.org/2000/svg';

// ColorBrewer RdBu 11 classes, ordered from cold (blue) to warm (red).
export const PALETTE = Object.freeze([
  '#053061', '#2166ac', '#4393c3', '#92c5de', '#d1e5f0', '#f7f7f7',
  '#fddbc7', '#f4a582', '#d6604d', '#b2182b', '#67001f',
]);

export const NO_DATA_COLOR = 'url(#stripes-hatch)';
export const NO_DATA_FALLBACK = '#c8c8c8';

/** Map an anomaly (Celsius) to a palette colour, symmetric around zero, clamped to ±domain. */
export function colorFor(anomaly, domain) {
  if (anomaly === null || anomaly === undefined || Number.isNaN(anomaly)) return null;
  const n = PALETTE.length;
  const clamped = Math.max(-domain, Math.min(domain, anomaly));
  // -domain -> 0, +domain -> n - 1
  let index = Math.floor(((clamped + domain) / (2 * domain)) * n);
  if (index >= n) index = n - 1;
  if (index < 0) index = 0;
  return PALETTE[index];
}

/** Text colour (dark or light) readable on a given hex background. */
export function contrastText(hex) {
  if (!hex || hex[0] !== '#' || hex.length !== 7) return '#111111';
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.45 ? '#111111' : '#ffffff';
}

function svgEl(doc, tag, attrs = {}) {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  return node;
}

function formatSigned(value) {
  if (value === null || value === undefined) return 'sans donnée';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(1).replace('.', ',')} °C`;
}

/**
 * Render stripes into `container` (emptied first).
 * items: [{ id, value (anomaly or null), label, selected, partial, secondary }]
 * opts: { domain, height, ariaLabel, onSelect(item), shift (added to value before colouring),
 *         tickEvery (label every n items), doc }
 */
export function renderStripes(container, items, opts = {}) {
  const doc = opts.doc || container.ownerDocument;
  const domain = opts.domain || 2.5;
  const height = opts.height || 48;
  const shift = opts.shift || 0;
  const n = Math.max(items.length, 1);
  const width = 1000;
  const stripeWidth = width / n;
  const tickEvery = opts.tickEvery || 0;
  const labelHeight = tickEvery ? 16 : 0;

  container.textContent = '';
  const svg = svgEl(doc, 'svg', {
    viewBox: `0 0 ${width} ${height + labelHeight}`,
    width: '100%',
    height: height + labelHeight,
    role: 'img',
    'aria-label': opts.ariaLabel || 'climate stripes',
    class: 'stripes',
    preserveAspectRatio: 'none',
  });

  const defs = svgEl(doc, 'defs');
  const pattern = svgEl(doc, 'pattern', {
    id: 'stripes-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
  });
  pattern.appendChild(svgEl(doc, 'rect', { width: 6, height: 6, fill: '#e6e6e6' }));
  pattern.appendChild(svgEl(doc, 'rect', { width: 3, height: 6, fill: '#c2c2c2' }));
  defs.appendChild(pattern);
  svg.appendChild(defs);

  items.forEach((item, i) => {
    const shifted = item.value === null || item.value === undefined ? null : item.value + shift;
    const color = colorFor(shifted, domain);
    const rect = svgEl(doc, 'rect', {
      x: (i * stripeWidth).toFixed(3),
      y: 0,
      width: (stripeWidth + 0.5).toFixed(3),
      height,
      fill: color || NO_DATA_COLOR,
      class: `stripe${item.selected ? ' is-selected' : ''}${item.partial ? ' is-partial' : ''}`,
      'data-id': item.id,
      tabindex: opts.onSelect ? 0 : null,
      role: opts.onSelect ? 'button' : null,
      'aria-label': `${item.label} : ${formatSigned(item.value)}${item.partial ? ' (année partielle)' : ''}`,
    });
    const title = svgEl(doc, 'title');
    title.textContent = `${item.label} : ${formatSigned(item.value)}${item.partial ? ' (partiel)' : ''}${item.secondary ? ` · ${item.secondary}` : ''}`;
    rect.appendChild(title);
    if (opts.onSelect) {
      rect.addEventListener('click', () => opts.onSelect(item));
      rect.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          opts.onSelect(item);
        }
      });
    }
    svg.appendChild(rect);
    if (item.selected) {
      svg.appendChild(svgEl(doc, 'rect', {
        x: (i * stripeWidth).toFixed(3), y: 0, width: stripeWidth.toFixed(3), height,
        fill: 'none', stroke: '#111', 'stroke-width': 3, class: 'stripe-outline', 'pointer-events': 'none',
      }));
    }
    if (tickEvery && (i % tickEvery === 0 || i === items.length - 1)) {
      const text = svgEl(doc, 'text', {
        x: (i * stripeWidth + stripeWidth / 2).toFixed(3),
        y: height + 12,
        'text-anchor': i === items.length - 1 ? 'end' : i === 0 ? 'start' : 'middle',
        class: 'stripe-tick',
        'font-size': 11,
      });
      text.textContent = item.label;
      svg.appendChild(text);
    }
  });
  container.appendChild(svg);
  return svg;
}

/** Legend for a symmetric domain: coloured cells with three labels. */
export function renderLegend(container, domain, opts = {}) {
  const doc = opts.doc || container.ownerDocument;
  container.textContent = '';
  const wrap = doc.createElement('div');
  wrap.className = 'legend';
  const bar = doc.createElement('div');
  bar.className = 'legend-bar';
  PALETTE.forEach((color) => {
    const cell = doc.createElement('span');
    cell.style.background = color;
    bar.appendChild(cell);
  });
  const labels = doc.createElement('div');
  labels.className = 'legend-labels';
  for (const text of [`−${domain} °C`, opts.zeroLabel || '0', `+${domain} °C`]) {
    const span = doc.createElement('span');
    span.textContent = text;
    labels.appendChild(span);
  }
  wrap.appendChild(bar);
  wrap.appendChild(labels);
  container.appendChild(wrap);
  return wrap;
}

/** Accessible table equivalent of a stripe series (label, value). */
export function renderStripesTable(container, items, caption, opts = {}) {
  const doc = opts.doc || container.ownerDocument;
  container.textContent = '';
  const table = doc.createElement('table');
  table.className = 'stripes-table';
  const cap = doc.createElement('caption');
  cap.textContent = caption;
  table.appendChild(cap);
  const head = doc.createElement('tr');
  for (const h of ['Année', 'Écart (°C)']) {
    const th = doc.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const item of items) {
    const tr = doc.createElement('tr');
    const td1 = doc.createElement('td');
    td1.textContent = String(item.label);
    const td2 = doc.createElement('td');
    td2.textContent = formatSigned(item.value);
    tr.appendChild(td1);
    tr.appendChild(td2);
    table.appendChild(tr);
  }
  container.appendChild(table);
  return table;
}
