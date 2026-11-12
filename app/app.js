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

function setTime(node, iso) {
  setText(node, iso);
  node.setAttribute('datetime', String(iso ?? ''));
}

function showAcked(cell, ackedAt) {
  const mark = el('span', 'acked', 'acked ');
  mark.dataset.testid = 'acked';
  const time = el('time');
  setTime(time, ackedAt);
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

// One fetch at a time: the next one is booked only after this one settles. A failed fetch keeps the last
// list on screen and the loop going.
async function refresh() {
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
    setTimeout(refresh, REFRESH_MS);
  }
}

refresh();
