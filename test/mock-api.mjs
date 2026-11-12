// A local stand-in for the course's incident API (both calls) that also serves a built board. Lab only:
// it never talks to the course.
//
//   import { startMock } from './mock-api.mjs'      (the lab drives it)
//   node test/mock-api.mjs --dist dist --port 8788 --every 9000      (by hand; build with
//     BOARD_API=http://127.0.0.1:8788/api BOARD_SESSION=lab-session npm run build)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const SERVICES = ['payments', 'calendar', 'auth', 'search', 'notify'];
const REGIONS = ['eu-west', 'us-east', 'ap-southeast'];

/** Fixed rows the lab checks against; the rest is generated with times near "now". */
export const FIXED = {
  time: { id: 'INC-0303', service: 'calendar', region: 'eu-west', summary: 'fixed time row', severity: 'sev2', openedAt: '2026-11-12T03:03:00.000Z' },
  nov5: { id: 'INC-0505', service: 'auth', region: 'us-east', summary: 'older fixed row', severity: 'sev3', openedAt: '2026-11-05T18:00:00.000Z' },
  html: { id: 'INC-0666', service: 'notify', region: 'eu-west', summary: '<img src=x onerror=alert(1)>', severity: 'sev2', openedAt: '2026-11-12T01:00:00.000Z' },
};

export async function startMock({ dist, session = 'lab-session', port = 0, host = '127.0.0.1' } = {}) {
  let serial = 1000;
  const fixedIds = new Set(Object.values(FIXED).map((i) => i.id));
  const state = {};
  let timer = null;

  function makeIncident(extra = {}) {
    serial += 1;
    return {
      id: `INC-${serial}`,
      service: SERVICES[serial % SERVICES.length],
      region: REGIONS[serial % REGIONS.length],
      summary: `lab incident ${serial}`,
      severity: serial % 3 === 0 ? 'sev1' : 'sev2',
      openedAt: new Date(Date.now() + 3000).toISOString(),
      ...extra,
    };
  }

  function reset() {
    const now = Date.now();
    const generated = Array.from({ length: 5 }, (_, n) => makeIncident({ openedAt: new Date(now - (n + 1) * 60_000).toISOString() }));
    Object.assign(state, {
      incidents: [...generated, FIXED.html, FIXED.time, FIXED.nov5].map((i) => ({ ...i })),
      cursors: [],
      fetches: 0,
      inFlight: 0,
      maxInFlight: 0,
      acks: [],
      failIncidents: 0,
      failAcks: 0,
      delayIncidents: [],
      delayAckMs: 0,
      drift: true,
    });
  }
  reset();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  };
  const unauthorized = (res) => json(res, 401, { message: 'unknown session', error: 'Unauthorized', statusCode: 401 });

  async function incidents(url, res) {
    if (url.searchParams.get('t') !== session) return unauthorized(res);
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      const delay = state.delayIncidents.shift();
      if (delay) await sleep(delay);
      if (state.failIncidents > 0) {
        state.failIncidents -= 1;
        return json(res, 503, { message: 'mock: failing on purpose', error: 'Service Unavailable', statusCode: 503 });
      }
      if (state.drift) {
        for (const i of state.incidents) {
          if (!fixedIds.has(i.id)) i.openedAt = new Date(Date.parse(i.openedAt) + Math.round(Math.random() * 4000 - 2000)).toISOString();
        }
      }
      state.fetches += 1;
      const cursor = `lab-cursor-${state.fetches}`;
      state.cursors.push(cursor);
      json(res, 200, { updatedAt: new Date().toISOString(), incidents: state.incidents.map((i) => ({ ...i })), cursor });
    } finally {
      state.inFlight -= 1;
    }
  }

  async function ack(url, res) {
    if (url.searchParams.get('t') !== session) return unauthorized(res);
    const id = url.searchParams.get('id');
    const record = { id, cursor: url.searchParams.get('cursor'), cursorsIssued: [...state.cursors], at: new Date().toISOString() };
    state.acks.push(record);
    if (state.delayAckMs) await sleep(state.delayAckMs);
    if (state.failAcks > 0) {
      state.failAcks -= 1;
      record.failed = true;
      return json(res, 503, { message: 'mock: failing on purpose', error: 'Service Unavailable', statusCode: 503 });
    }
    if (!state.incidents.some((i) => i.id === id)) return json(res, 404, { message: 'no such incident', error: 'Not Found', statusCode: 404 });
    json(res, 200, { id, ackedAt: record.at, receipt: `lab-receipt-${state.acks.length}` });
  }

  async function file(url, res) {
    if (!dist) return json(res, 404, { message: 'no dist' });
    const root = resolve(dist);
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (path !== root && !path.startsWith(root + sep)) return json(res, 403, { message: 'outside dist' });
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      json(res, 404, { message: 'not found' });
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = url.pathname === '/api/incidents' ? incidents : url.pathname === '/api/ack' ? ack : file;
    route(url, res).catch((err) => json(res, 500, { message: String(err) }));
  });
  await new Promise((ok) => server.listen(port, host, ok));
  const origin = `http://${host}:${server.address().port}`;

  return {
    url: `${origin}/`,
    apiUrl: `${origin}/api`,
    session,
    state,
    reset,
    /** Puts a new incident at the top (newest first) and returns it. */
    addIncident(extra) {
      const incident = makeIncident(extra);
      state.incidents.unshift(incident);
      return incident;
    },
    setIncidents(list) {
      state.incidents = list.map((i) => ({ ...i }));
    },
    autoAdd(ms) {
      clearInterval(timer);
      timer = ms ? setInterval(() => this.addIncident(), ms) : null;
    },
    close() {
      clearInterval(timer);
      server.closeAllConnections();
      return new Promise((ok) => server.close(ok));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at > -1 ? process.argv[at + 1] : fallback;
  };
  const mock = await startMock({ dist: arg('dist', 'dist'), port: Number(arg('port', 8788)), session: arg('session', 'lab-session') });
  mock.autoAdd(Number(arg('every', 9000)));
  console.log(`mock board ${mock.url}  api ${mock.apiUrl}  session ${mock.session}`);
}
