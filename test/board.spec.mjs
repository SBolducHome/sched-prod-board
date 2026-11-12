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

async function open(options = { locale: 'en-GB', timezoneId: 'Europe/London' }) {
  const context = await browser.newContext(options);
  contexts.push(context);
  const page = await context.newPage();
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

test('1. loader on open, gone after the first load; empty state comes and goes', async () => {
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

  const added = mock.addIncident();
  await second.page.locator(row(added.id)).waitFor({ timeout: 3500 });
  assert.equal(await second.page.getByTestId('empty').count(), 0, 'empty gone once an incident arrives');
  mock.setIncidents([]);
  await second.page.getByTestId('empty').waitFor({ timeout: 3500 });
  assert.equal(await second.page.locator(ROW).count(), 0);
  assert.deepEqual([...problems.errors, ...second.problems.errors], []);
});

test('2. rows newest first; a new incident appears at the top without a reload', async () => {
  const { page, problems } = await open();
  await page.locator(ROW).first().waitFor();
  assert.deepEqual(await rowIds(page), mockIds());

  const added = mock.addIncident();
  const started = Date.now();
  await page.waitForFunction((id) => document.querySelector('[data-testid="incident-row"]')?.dataset.id === id, added.id, { timeout: 3500 });
  const took = Date.now() - started;
  assert.ok(took < 3500, `appeared after ${took} ms`);
  assert.deepEqual(await rowIds(page), mockIds());
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
  const added = mock.addIncident();
  await page.waitForFunction((id) => document.querySelector('[data-testid="incident-row"]')?.dataset.id === id, added.id, { timeout: 3500 });

  mock.state.maxInFlight = 0;
  mock.state.delayIncidents.push(2600, 2600);
  await waitFetches(page, 3);
  assert.equal(mock.state.maxInFlight, 1, 'one fetch at a time');
  assert.deepEqual(problems.errors, []);
});
