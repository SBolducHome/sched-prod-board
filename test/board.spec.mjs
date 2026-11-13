// The lab: builds the board with scripts/build.mjs, serves it from the mock API, and checks the plan's
// behavior in Chromium. Run with `npm test` (the build needs a clean git tree).
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { FIXED, startMock } from './mock-api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROW = '[data-testid="incident-row"]';
const row = (id) => `${ROW}[data-id="${id}"]`;

let mock;
let browser;
let dist;
const contexts = [];

before(async () => {
  dist = mkdtempSync(join(tmpdir(), 'board-lab-'));
  mock = await startMock({ dist });
  execFileSync(process.execPath, ['scripts/build.mjs', '--out', dist], {
    cwd: root,
    env: { ...process.env, BOARD_API: mock.apiUrl, BOARD_SESSION: mock.session },
    stdio: 'inherit',
  });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await mock?.close();
  if (dist) rmSync(dist, { recursive: true, force: true });
});

beforeEach(async () => {
  while (contexts.length) await contexts.pop().close();
  mock.reset();
});

async function open(options = {}, beforeGoto = async () => {}) {
  const context = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/London', viewport: { width: 1280, height: 800 }, ...options });
  contexts.push(context);
  // Counts incident rows taken out of the DOM (rows inside removed nodes too).
  await context.addInitScript(() => {
    window.__rowsRemoved = 0;
    const sel = '[data-testid="incident-row"]';
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.removedNodes) {
          if (n.nodeType === 1) window.__rowsRemoved += (n.matches(sel) ? 1 : 0) + n.querySelectorAll(sel).length;
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const page = await context.newPage();
  await beforeGoto(page);
  const problems = { errors: [], dialogs: [] };
  page.on('pageerror', (err) => problems.errors.push(String(err)));
  page.on('dialog', (dialog) => {
    problems.dialogs.push(dialog.message());
    dialog.dismiss();
  });
  await page.goto(mock.url);
  return { page, problems };
}

const rowIds = (page) => page.$$eval(ROW, (rows) => rows.map((r) => r.dataset.id));
const mockIds = () => mock.state.incidents.map((i) => i.id);
const waitFetches = async (page, n) => {
  const target = mock.state.fetches + n;
  while (mock.state.fetches < target) await page.waitForTimeout(100);
};
const newBar = (page) => page.locator('[data-testid="new-bar"]:visible');
const topId = (page) => page.locator(ROW).first().getAttribute('data-id');
const rowYs = (page) => page.$$eval(ROW, (rows) => rows.map((r) => `${r.dataset.id}@${Math.round(r.getBoundingClientRect().y)}`));
const rowsRemoved = (page) => page.evaluate(() => window.__rowsRemoved);
/** Waits for the "N new" bar and clicks it; the new top row must show within 600 ms. */
async function bringNewIn(page) {
  await newBar(page).waitFor({ timeout: 3500 });
  await newBar(page).click();
  await page.waitForFunction((id) => document.querySelector('[data-testid="incident-row"]')?.dataset.id === id, mockIds()[0], { timeout: 600 });
}

test('1. loader on open, gone after the first load; empty state, then new incidents show directly', async () => {
  mock.state.delayIncidents.push(1200);
  const { page, problems } = await open();
  assert.equal(await page.getByTestId('loader').isVisible(), true, 'loader visible on open');
  await page.locator(ROW).first().waitFor();
  assert.equal(await page.getByTestId('loader').count(), 0, 'loader removed after the first load');
  assert.equal(await page.getByTestId('empty').count(), 0);

  mock.setIncidents([]);
  const second = await open();
  await second.page.getByTestId('empty').waitFor();
  assert.equal(await second.page.getByTestId('loader').count(), 0);
  assert.equal(await second.page.locator(ROW).count(), 0);

  assert.equal(await newBar(second.page).count(), 0, 'no bar on an empty board');

  // Nothing on screen: new incidents show directly, no bar.
  const added = mock.addIncident();
  await second.page.locator(row(added.id)).waitFor({ timeout: 3500 });
  assert.equal(await second.page.getByTestId('empty').count(), 0, 'empty gone once an incident arrives');
  assert.equal(await newBar(second.page).count(), 0);
  assert.deepEqual([...problems.errors, ...second.problems.errors], []);
});

test('2. rows newest first; a new incident waits behind the bar and comes in at the top on click', async () => {
  const { page, problems } = await open();
  await page.locator(ROW).first().waitFor();
  assert.deepEqual(await rowIds(page), mockIds());
  const first = await topId(page);

  mock.addIncident();
  await newBar(page).waitFor({ timeout: 3500 });
  assert.match(await newBar(page).innerText(), /^1 new incident\b/);
  assert.equal(await topId(page), first, 'list held still');
  await bringNewIn(page);
  assert.deepEqual(await rowIds(page), mockIds());
  assert.equal(await newBar(page).count(), 0, 'bar hidden after the click');
  assert.deepEqual(problems.errors, []);
});

test('3. Ack acks the clicked row with the latest cursor; acked and untouched rows survive refreshes', async (t) => {
  const { page, problems } = await open();
  await page.locator(ROW).first().waitFor();
  const ids = await rowIds(page);
  const [x, y, z, b] = [ids[2], ids[3], ids[1], ids[4]];
  const bButton = await page.$(`${row(b)} [data-testid="ack"]`);

  await page.locator(row(x)).getByTestId('ack').click();
  await page.locator(row(x)).getByTestId('acked').waitFor();
  assert.equal(mock.state.acks.length, 1);
  const sent = mock.state.acks[0];
  assert.equal(sent.id, x, 'acked the clicked row');
  const latest = sent.cursorsIssued.at(-1);
  const previous = sent.cursorsIssued.at(-2);
  assert.ok([latest, previous].includes(sent.cursor), `cursor ${sent.cursor} is from the latest fetch (${latest})`);
  if (sent.cursor !== latest) t.diagnostic('ack went out while the next fetch was settling');
  assert.equal(await page.locator(row(x)).getByTestId('ack').count(), 0);
  assert.match(await page.locator(row(x)).getByTestId('acked').innerText(), /acked \S/);

  await bButton.focus();
  mock.addIncident();
  await waitFetches(page, 3);
  mock.addIncident();
  await waitFetches(page, 2);
  await page.waitForTimeout(200);
  assert.equal(await page.locator(row(x)).getByTestId('acked').count(), 1, 'still acked after refreshes');
  assert.equal(await page.locator(row(x)).getByTestId('ack').count(), 0);
  const sameNode = await bButton.evaluate((el, sel) => el.isConnected && el === document.querySelector(sel), `${row(b)} [data-testid="ack"]`);
  assert.equal(sameNode, true, 'untouched row keeps the same Ack button node');
  assert.equal(await bButton.evaluate((el) => document.activeElement === el), true, 'focus survives refreshes');
  assert.equal(mock.state.acks.length, 1, 'no extra acks');

  mock.state.delayAckMs = 800;
  const zButton = page.locator(row(z)).getByTestId('ack');
  await zButton.click();
  assert.equal(await zButton.isDisabled(), true, 'disabled while the ack is in flight');
  await page.locator(row(z)).getByTestId('acked').waitFor();
  mock.state.delayAckMs = 0;

  mock.state.failAcks = 1;
  await page.locator(row(y)).getByTestId('ack').click();
  await page.locator(`${row(y)} .error`).waitFor();
  assert.equal(await page.locator(row(y)).getByTestId('ack').isEnabled(), true, 're-enabled after a failed ack');
  assert.equal(await page.locator(row(y)).getByTestId('acked').count(), 0);
  await page.locator(row(y)).getByTestId('ack').click();
  await page.locator(row(y)).getByTestId('acked').waitFor();
  assert.equal(await page.locator(`${row(y)} .error`).count(), 0);
  assert.deepEqual(mock.state.acks.map((a) => a.id), [x, z, y, y]);
  assert.deepEqual(problems.errors, []);
});

test('4. times in the viewer\'s own locale and zone; full UTC in <time datetime>', async () => {
  const cases = [
    { locale: 'de-DE', timezoneId: 'Europe/Berlin', time: [/12\.11\.2026/, /\b04:03\b/], nov5: [/05\.11\.2026/, /\b19:00\b/] },
    { locale: 'en-NZ', timezoneId: 'Pacific/Auckland', time: [/12\/11\/2026/, /\b(16:03|0?4:03\s*pm)/i], nov5: [/06\/11\/2026/, /\b0?7:00\s*am/i] },
    { locale: 'en-US', timezoneId: 'America/Chicago', time: [/11\/11\/2026/, /\b0?9:03\s*PM/i], nov5: [/11\/05\/2026/, /\b12:00\s*PM/i] },
    // EU locales whose native order is year-first: day/month/year with '/', plus the locale's own time
    { locale: 'sv-SE', timezoneId: 'Europe/Stockholm', time: [/^12\/11\/2026\b/, /\b04:03\b/], nov5: [/^05\/11\/2026\b/, /\b19:00\b/] },
    { locale: 'hu-HU', timezoneId: 'Europe/Budapest', time: [/^12\/11\/2026\b/, /\b0?4:03\b/], nov5: [/^05\/11\/2026\b/, /\b19:00\b/] },
    { locale: 'lt-LT', timezoneId: 'Europe/Vilnius', time: [/^12\/11\/2026\b/, /\b05:03\b/], nov5: [/^05\/11\/2026\b/, /\b20:00\b/] },
  ];
  for (const { locale, timezoneId, time, nov5 } of cases) {
    const { page, problems } = await open({ locale, timezoneId });
    await page.locator(ROW).first().waitFor();
    for (const [incident, patterns] of [[FIXED.time, time], [FIXED.nov5, nov5]]) {
      const el = page.locator(`${row(incident.id)} > time`);
      const text = await el.innerText();
      for (const p of patterns) assert.match(text, p, `${locale} ${timezoneId}: "${text}" for ${incident.openedAt}`);
      assert.equal(await el.getAttribute('datetime'), incident.openedAt);
    }
    assert.deepEqual(problems.errors, []);
  }
});

test('5. meta build and footer build-sha are git rev-parse HEAD', async () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const { page } = await open();
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(await page.locator('meta[name="build"]').getAttribute('content'), head);
  assert.equal((await page.getByTestId('build-sha').innerText()).trim(), head);
});

test('6. a summary with HTML shows as text', async () => {
  const { page, problems } = await open();
  await page.locator(row(FIXED.html.id)).waitFor();
  assert.match(await page.locator(`${row(FIXED.html.id)} .what`).innerText(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('[data-testid="incident-list"] img').count(), 0);
  await page.waitForTimeout(300);
  assert.deepEqual(problems.dialogs, []);
  assert.deepEqual(problems.errors, []);
});

test('7. failed fetches keep the list and the loop; never two fetches at once', async () => {
  mock.state.failIncidents = 1;
  const { page, problems } = await open();
  await page.locator('.stale').waitFor();
  assert.equal(await page.getByTestId('loader').isVisible(), true, 'loader stays until a first answer');
  await page.locator(ROW).first().waitFor({ timeout: 3500 });
  assert.equal(await page.getByTestId('loader').count(), 0);
  assert.equal(await page.locator('.stale').isVisible(), false);

  const before = await rowIds(page);
  mock.state.failIncidents = 2;
  await page.locator('.stale').waitFor({ timeout: 3500 });
  assert.match(await page.locator('.stale').innerText(), /stale/i);
  assert.deepEqual(await rowIds(page), before, 'list kept while fetches fail');
  await page.locator('.stale').waitFor({ state: 'hidden', timeout: 6000 });
  mock.addIncident();
  await bringNewIn(page);

  mock.state.maxInFlight = 0;
  mock.state.delayIncidents.push(2600, 2600);
  await waitFetches(page, 3);
  assert.equal(mock.state.maxInFlight, 1, 'one fetch at a time');
  assert.deepEqual(problems.errors, []);
});

test('8. R4: a request starts every 2 s, also while requests are slow', async () => {
  const { page, problems } = await open();
  await page.locator(ROW).first().waitFor();
  await waitFetches(page, 1);
  mock.state.maxInFlight = 0;
  mock.state.delayIncidents.push(1500, 1500, 1500);
  const from = mock.state.starts.length;
  await waitFetches(page, 4);
  const starts = mock.state.starts.slice(from);
  const gaps = starts.slice(1).map((s, n) => s - starts[n]);
  assert.ok(gaps.length >= 3, `gaps ${gaps}`);
  for (const gap of gaps) assert.ok(gap >= 1800 && gap <= 2300, `start-to-start ${gap} ms (all: ${gaps.join(', ')})`);
  assert.equal(mock.state.maxInFlight, 1, 'one fetch at a time');
  assert.deepEqual(problems.errors, []);
});

test('9. a bar click keeps a row whose Ack is in flight; the next bar click drops it once the Ack settled', async () => {
  const { page, problems } = await open();
  await page.locator(ROW).first().waitFor();
  mock.state.cap = mock.state.incidents.length;
  const oldest = (await rowIds(page)).at(-1);
  mock.state.delayAckMs = 4000;
  await page.locator(row(oldest)).getByTestId('ack').click();
  mock.addIncident();
  assert.equal(mockIds().includes(oldest), false, 'the capped list dropped the oldest row');
  await bringNewIn(page);
  assert.equal(mock.state.acks.at(-1).status, undefined, 'ack still in flight');
  assert.deepEqual(await rowIds(page), [...mockIds(), oldest], 'pending row kept at its place');
  assert.equal(await page.locator(row(oldest)).getByTestId('ack').isDisabled(), true);

  await page.locator(row(oldest)).getByTestId('acked').waitFor({ timeout: 5000 });
  assert.equal(mock.state.acks.at(-1).id, oldest);
  assert.equal(mock.state.acks.at(-1).status, 200);
  await waitFetches(page, 1);
  assert.equal(await page.locator(row(oldest)).count(), 1, 'the list holds still: no removal on a refresh');
  mock.addIncident();
  await bringNewIn(page);
  await page.locator(row(oldest)).waitFor({ state: 'detached', timeout: 600 });
  assert.deepEqual(await rowIds(page), mockIds());
  assert.deepEqual(problems.errors, []);
});

test('10. an acked row that left the list is forgotten (acked memory stays bounded)', async () => {
  const { page, problems } = await open();
  await page.locator(ROW).first().waitFor();
  mock.state.cap = mock.state.incidents.length;
  const oldest = mock.state.incidents.at(-1);
  await page.locator(row(oldest.id)).getByTestId('ack').click();
  await page.locator(row(oldest.id)).getByTestId('acked').waitFor();

  mock.addIncident();
  await bringNewIn(page);
  await page.locator(row(oldest.id)).waitFor({ state: 'detached', timeout: 600 });

  // The page keeps no ack memory for rows it no longer shows: if the same id comes back, it is a fresh row.
  mock.state.cap += 1;
  mock.setIncidents([...mock.state.incidents, oldest]);
  await newBar(page).waitFor({ timeout: 3500 });
  assert.match(await newBar(page).innerText(), /^1 new incident\b/);
  await newBar(page).click();
  await page.locator(row(oldest.id)).waitFor({ timeout: 600 });
  assert.equal(await page.locator(row(oldest.id)).getByTestId('acked').count(), 0, 'ack entry was dropped with its row');
  assert.equal(await page.locator(row(oldest.id)).getByTestId('ack').count(), 1);
  assert.deepEqual(problems.errors, []);
});

test('11. the list holds still while new incidents arrive; the bar counts them and brings them in', async () => {
  const { page, problems } = await open();
  await page.locator(ROW).first().waitFor();
  await waitFetches(page, 1);
  const before = await rowYs(page);
  const first = await topId(page);
  const focused = page.locator(ROW).nth(3).getByTestId('ack');
  await focused.focus();
  await page.evaluate(() => (window.__rowsRemoved = 0));

  mock.addIncident();
  await waitFetches(page, 2);
  mock.addIncident();
  await waitFetches(page, 2);
  await page.waitForTimeout(200);
  assert.equal(await topId(page), first, 'top row unchanged');
  assert.deepEqual(await rowYs(page), before, 'no row moved, also with the bar showing');
  assert.equal(await rowsRemoved(page), 0, 'no row removed');
  assert.match(await newBar(page).innerText(), /^2 new incidents\b/);
  const barBox = await newBar(page).boundingBox();
  const firstBox = await page.locator(ROW).first().boundingBox();
  assert.ok(barBox.y + barBox.height <= firstBox.y, 'bar sits above the list');
  assert.match(await page.locator('[aria-live="polite"]').first().textContent(), /2 new incidents/);
  assert.equal(await focused.evaluate((el) => document.activeElement === el), true, 'announcing moved no focus');

  await bringNewIn(page);
  assert.deepEqual(await rowIds(page), mockIds(), 'new incidents at the top, newest first');
  assert.equal(await page.locator(ROW).first().getByTestId('ack').count(), 1, 'top row has an Ack button');
  assert.equal(await newBar(page).count(), 0);

  // Keyboard: the bar is a button in the tab order.
  mock.addIncident();
  await newBar(page).waitFor({ timeout: 3500 });
  await newBar(page).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction((id) => document.querySelector('[data-testid="incident-row"]')?.dataset.id === id, mockIds()[0], { timeout: 600 });
  assert.deepEqual(problems.errors, []);
});

test('12. an Ack aimed while a new incident arrives mid-aim acks the intended incident (replay h)', async () => {
  let lastTop = null;
  let hold = null;
  const { page, problems } = await open({}, (p) =>
    p.route('**/api/incidents**', async (route) => {
      const res = await route.fetch();
      const body = await res.text();
      let top = null;
      try {
        top = JSON.parse(body).incidents?.[0]?.id ?? null;
      } catch {}
      const fresh = lastTop !== null && top !== null && top !== lastTop;
      if (top) lastTop = top;
      if (fresh && hold?.armed) await new Promise((release) => hold.wait(release));
      await route.fulfill({ response: res, body });
    }),
  );
  await page.locator(ROW).first().waitFor();
  await waitFetches(page, 1);
  for (let attempt = 0; attempt < 3; attempt++) {
    const target = page.locator(ROW).filter({ hasNot: page.getByTestId('acked') }).nth(2);
    const intended = await target.getAttribute('data-id');
    const box = await target.getByTestId('ack').boundingBox();
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    let release;
    const landed = new Promise((ok) => (hold = { armed: true, wait: (r) => ((release = r), ok()) }));
    mock.addIncident();
    await page.mouse.move(x, y, { steps: 8 });
    await Promise.race([landed, page.waitForTimeout(5000)]);
    assert.ok(release, 'a new incident arrived mid-aim');
    release();
    hold = null;
    await page.waitForTimeout(300);
    const sent = mock.state.acks.length;
    await page.mouse.click(x, y);
    for (let waited = 0; mock.state.acks.length === sent && waited < 3000; waited += 100) await page.waitForTimeout(100);
    assert.equal(mock.state.acks.at(-1)?.id, intended, `attempt ${attempt + 1}: acked ${mock.state.acks.at(-1)?.id}, aimed at ${intended}`);
    await page.locator(row(intended)).getByTestId('acked').waitFor();
  }
  assert.deepEqual(problems.errors, []);
});

test('13. the "could not refresh" note moves no row', async () => {
  const { page, problems } = await open();
  await page.locator(ROW).first().waitFor();
  const before = await rowYs(page);
  mock.state.failIncidents = 2;
  await page.locator('.stale').waitFor({ timeout: 3500 });
  assert.deepEqual(await rowYs(page), before, 'note showing moved no row');
  await page.locator('.stale').waitFor({ state: 'hidden', timeout: 6000 });
  assert.deepEqual(await rowYs(page), before, 'note hiding moved no row');
  assert.deepEqual(problems.errors, []);
});

test('14. empty API: loader gone and empty visible within 8 s (replay i)', async () => {
  mock.setIncidents([]);
  const { page, problems } = await open();
  await page.locator('[data-testid="empty"]:visible').waitFor({ timeout: 8000 });
  assert.equal(await page.locator('[data-testid="loader"]:visible').count(), 0);
  assert.equal(await newBar(page).count(), 0);
  assert.deepEqual(problems.errors, []);
});
