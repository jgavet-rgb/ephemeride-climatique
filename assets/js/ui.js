// Small DOM and formatting helpers (French locale). No framework.

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // only used with trusted, static markup
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  node.textContent = '';
  return node;
}

const numberFormats = new Map();
function numberFormat(decimals) {
  if (!numberFormats.has(decimals)) {
    numberFormats.set(decimals, new Intl.NumberFormat('fr-FR', {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    }));
  }
  return numberFormats.get(decimals);
}

export function fmtNumber(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return numberFormat(decimals).format(value);
}

/** '18,4 °C' ; sign=true gives '+2,3 °C' / '−1,0 °C'. */
export function fmtTemp(value, { decimals = 1, sign = false } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  const abs = numberFormat(decimals).format(Math.abs(value));
  let prefix = '';
  if (sign) prefix = value > 0 ? '+' : value < 0 ? '−' : '';
  else if (value < 0) prefix = '−';
  const zero = Number(abs.replace(',', '.')) === 0;
  return `${zero ? '' : prefix}${abs} °C`;
}

export function fmtSigned(value, decimals = 1) {
  return fmtTemp(value, { decimals, sign: true });
}

/** Minutes -> '12 h 28'. */
export function fmtDuration(minutes) {
  if (minutes === null || minutes === undefined) return '–';
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')}`;
}

/** Signed minutes difference -> '+2 min' / '−3 min'. */
export function fmtMinutesDelta(minutes) {
  if (minutes === null || minutes === undefined) return '';
  const rounded = Math.round(minutes);
  if (rounded === 0) return '±0 min';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)} min`;
}

/** Instant -> 'HH:MM' in a time zone. */
export function fmtTime(date, timeZone) {
  if (!date) return '–';
  return new Intl.DateTimeFormat('fr-FR', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

export function fmtDateTime(date, timeZone) {
  if (!date) return '–';
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

export function fmtDateShort(date, timeZone) {
  if (!date) return '–';
  return new Intl.DateTimeFormat('fr-FR', { timeZone, day: 'numeric', month: 'long' }).format(date);
}

export function ordinalFR(n) {
  return n === 1 ? '1er' : `${n}e`;
}

export function percent(value) {
  if (value === null || value === undefined) return '–';
  return `${Math.round(value * 100)} %`;
}

// --- modal ---

let modalRoot = null;

export function openModal(title, content) {
  closeModal();
  const close = () => closeModal();
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' }, [
    el('div', { class: 'modal-head' }, [
      el('h2', { id: 'modal-title', text: title }),
      el('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Fermer', onclick: close, text: '✕' }),
    ]),
    el('div', { class: 'modal-body' }, [content]),
  ]);
  modalRoot = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === modalRoot) close(); } }, [box]);
  document.body.appendChild(modalRoot);
  document.body.classList.add('has-modal');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  modalRoot.dataset.listener = '1';
  modalRoot._onKey = onKey;
  document.addEventListener('keydown', onKey);
  const focusable = box.querySelector('button');
  if (focusable) focusable.focus();
  return modalRoot;
}

export function closeModal() {
  if (!modalRoot) return;
  if (modalRoot._onKey) document.removeEventListener('keydown', modalRoot._onKey);
  modalRoot.remove();
  modalRoot = null;
  document.body.classList.remove('has-modal');
}

// --- toasts and live region ---

export function toast(message, { type = 'info', timeout = 5000 } = {}) {
  let region = document.getElementById('toasts');
  if (!region) {
    region = el('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
    document.body.appendChild(region);
  }
  const item = el('div', { class: `toast toast-${type}`, role: 'status', text: message });
  region.appendChild(item);
  if (timeout) setTimeout(() => item.remove(), timeout);
  return item;
}

export function announce(text) {
  const live = document.getElementById('live');
  if (live) {
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 30);
  }
}

/** Definition-list row helper: <div class="kv"><dt>label</dt><dd>value</dd></div>. */
export function kv(label, value, opts = {}) {
  return el('div', { class: `kv${opts.class ? ` ${opts.class}` : ''}` }, [
    el('dt', { text: label }),
    el('dd', {}, typeof value === 'string' ? [value] : [].concat(value)),
  ]);
}
