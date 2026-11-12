import { fetchIncidents, ack } from './api.js';

const REFRESH_MS = 2000;

const board = document.querySelector('[data-testid="board"]');
const list = document.querySelector('[data-testid="incident-list"]');
const stale = document.querySelector('.stale');
let empty = null;

// Row elements by incident id. Rows are kept across updates so a row's Ack button, focus and acked mark
// survive; only new rows are inserted and gone rows removed.
const rows = new Map();
// Acks done on this page: incident id -> ackedAt.
const acked = new Map();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // API strings are untrusted: text only, never HTML
  return node;
}

function setText(node, text) {
  const value = String(text ?? '');
  if (node.textContent !== value) node.textContent = value;
}

// The viewer's own locale (day/month order) and, with no timeZone given, the viewer's own time zone.
const dateTime = new Intl.DateTimeFormat(navigator.languages, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const timeOnly = new Intl.DateTimeFormat(navigator.languages, { hour: '2-digit', minute: '2-digit' });

// R5: day before month for EU locales. Some EU locales are natively year- or month-first (sv-SE, hu-HU,
// lt-LT); for those only, the date becomes dd/mm/yyyy and the locale keeps its own time part.
const EU = new Set('AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK'.split(' '));
const TIME_PARTS = new Set(['hour', 'minute', 'second', 'dayPeriod']);

function needsDayFirst(format) {
  let region;
  try {
    region = new Intl.Locale(format.resolvedOptions().locale).maximize().region;
  } catch {
    return false;
  }
  if (!EU.has(region)) return false;
  const types = format.formatToParts(0).map((p) => p.type);
  return types.indexOf('day') > types.indexOf('month');
}

const dayFirst = needsDayFirst(dateTime);

function formatDateTime(date) {
  if (!dayFirst) return dateTime.format(date);
  const parts = dateTime.formatToParts(date);
  const value = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const timeAt = parts.flatMap((p, n) => (TIME_PARTS.has(p.type) ? [n] : []));
  const time = timeAt.length ? parts.slice(timeAt[0], timeAt.at(-1) + 1).map((p) => p.value).join('') : '';
  return `${value('day')}/${value('month')}/${value('year')} ${time}`.trim();
}

/** Local time as text; the full UTC value in `datetime`. */
function setTime(node, iso, format = formatDateTime) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    setText(node, iso);
    node.setAttribute('datetime', String(iso ?? ''));
    return;
  }
  setText(node, format(date));
  node.setAttribute('datetime', date.toISOString());
}

function showAcked(cell, ackedAt) {
  const mark = el('span', 'acked', 'acked ');
  mark.dataset.testid = 'acked';
  const time = el('time');
  setTime(time, ackedAt, (date) => timeOnly.format(date));
  mark.append(time);
  cell.replaceChildren(mark);
}

function ackButton(id, cell) {
  const button = el('button', 'ack', 'Ack');
  button.type = 'button';
  button.dataset.testid = 'ack';
  button.addEventListener('click', async () => {
    button.disabled = true;
    cell.querySelector('.error')?.remove();
    try {
      const reply = await ack(id);
      acked.set(id, reply.ackedAt);
      showAcked(cell, reply.ackedAt);
    } catch (err) {
      console.warn('ack failed', id, err);
      button.disabled = false;
      cell.append(el('span', 'error', 'Ack failed, retry'));
    }
  });
  return button;
}

function updateRow(row, incident) {
  const [, sev, what, time] = row.children;
  row.className = 'row';
  if (/^[\w-]+$/.test(String(incident.severity))) row.classList.add(incident.severity);
  setText(sev, incident.severity);
  setText(what, `${incident.service} · ${incident.region} · ${incident.summary}`);
  setTime(time, incident.openedAt);
}

function createRow(incident) {
  const id = String(incident.id);
  const row = el('li');
  row.dataset.testid = 'incident-row';
  row.dataset.id = id;
  const cell = el('span', 'act');
  row.append(el('span', 'id', id), el('span', 'sev'), el('span', 'what'), el('time'), cell);
  if (acked.has(id)) showAcked(cell, acked.get(id));
  else cell.append(ackButton(id, cell));
  updateRow(row, incident);
  return row;
}

/** Brings the list in line with `incidents` (newest first) without re-creating rows that stay. */
function render(incidents) {
  const ids = new Set(incidents.map((i) => String(i.id)));
  for (const [id, row] of rows) {
    if (!ids.has(id)) {
      row.remove();
      rows.delete(id);
    }
  }
  const placed = new Set();
  let next = list.firstElementChild;
  for (const incident of incidents) {
    const id = String(incident.id);
    if (placed.has(id)) continue;
    placed.add(id);
    let row = rows.get(id);
    if (row) updateRow(row, incident);
    else rows.set(id, (row = createRow(incident)));
    if (row === next) next = next.nextElementSibling;
    else list.insertBefore(row, next);
  }
  showEmpty(rows.size === 0);
}

function showEmpty(on) {
  if (on && !empty) {
    empty = el('p', 'empty', 'No incidents tonight.');
    empty.dataset.testid = 'empty';
    board.append(empty);
  } else if (!on && empty) {
    empty.remove();
    empty = null;
  }
}

let loaded = false;

// A fetch starts every REFRESH_MS, one at a time: the next start is booked when this one settles, at
// REFRESH_MS after this start (at once if this fetch took longer). A failed fetch keeps the last list on
// screen and the loop going.
async function refresh() {
  const started = performance.now();
  try {
    const page = await fetchIncidents();
    render(Array.isArray(page.incidents) ? page.incidents : []);
    if (!loaded) {
      loaded = true;
      document.querySelector('[data-testid="loader"]')?.remove();
    }
    stale.hidden = true;
  } catch (err) {
    console.warn('refresh failed', err);
    stale.textContent = loaded
      ? 'Could not refresh: this list may be stale. Retrying…'
      : 'Could not load incidents. Retrying…';
    stale.hidden = false;
  } finally {
    setTimeout(refresh, Math.max(0, REFRESH_MS - (performance.now() - started)));
  }
}

refresh();
