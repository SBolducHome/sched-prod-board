// Builds the board into dist/ (or --out DIR): copies app/, stamps the git sha into index.html, writes
// config.js from BOARD_API and BOARD_SESSION. Refuses to build uncommitted code, so the sha names what ships.
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = '__BUILD_SHA__';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(root, 'app');
const outFlag = process.argv.indexOf('--out');
const out = resolve(root, outFlag > -1 ? process.argv[outFlag + 1] : 'dist');

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const changed = git('status', '--porcelain', '--untracked-files=no');
if (changed) fail(`uncommitted changes to tracked files; commit them first:\n${changed}`);
const untracked = git('status', '--porcelain', '--untracked-files=all', '--', 'app');
if (untracked) fail(`untracked files in app/ would ship without being in the sha:\n${untracked}`);

const sha = git('rev-parse', 'HEAD');
if (!/^[0-9a-f]{40}$/.test(sha)) fail(`unexpected sha "${sha}"`);

const api = process.env.BOARD_API?.trim().replace(/\/+$/, '');
const session = process.env.BOARD_SESSION?.trim();
if (!api) fail('BOARD_API is not set');
if (!session) fail('BOARD_SESSION is not set');

if (out === root || out === app || app.startsWith(out + '/')) fail(`refusing to write to ${out}`);
rmSync(out, { recursive: true, force: true });
cpSync(app, out, { recursive: true });

const indexPath = resolve(out, 'index.html');
const html = readFileSync(indexPath, 'utf8');
if (!html.includes(PLACEHOLDER)) fail(`${PLACEHOLDER} not found in app/index.html`);
writeFileSync(indexPath, html.replaceAll(PLACEHOLDER, sha));

writeFileSync(
  resolve(out, 'config.js'),
  `// Written by scripts/build.mjs at ${sha}. Not in git.\n` +
    `export const API = ${JSON.stringify(api)};\n` +
    `export const SESSION = ${JSON.stringify(session)};\n`,
);

console.log(`build: ${sha} -> ${relative(root, out) || out}`);
