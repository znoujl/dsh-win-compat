/**
 * Closed-loop verification for dsh-win-compat.
 *
 *   detect → repair → verify → "restart" → still effective
 *   → Desktop regenerates a bad shim → watcher repairs it again
 *
 * Runs with plain `node test/run.mjs` (or, on this machine, with the bundled
 * Electron-as-node executable). No test framework, no dependencies.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  expandCandidatePaths,
  inspectShim,
  repairAll,
  repairShim,
  verifyShim,
} from '../lib/repair.js';
import { doctor } from '../lib/diagnostics.js';
import { renderHtmlReport } from '../lib/report.js';
import { classifyDshSupport, compareVersions } from '../lib/version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(here);
const simPath = path.join(here, 'host-sim.mjs');
const cliPath = path.join(pluginRoot, 'lib', 'cli.js');
const tmpRoot = path.join(here, '.tmp');

const BROKEN_SHIM = [
  '@echo off',
  '"C:\\Users\\anon\\软件一开发\\tools\\node.exe" "C:\\Users\\anon\\软件一开发\\tools\\pnpm.cjs" %*',
  '',
].join('\n');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function freshDir(label) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${label}-`));
  return dir;
}

function makeHome(label) {
  const home = freshDir(label);
  const shim = path.join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'runtime-commands', 'bin', 'pnpm.cmd');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  return { home, shim };
}

function writeShim(shim, text, { bom = false } = {}) {
  const buffer = Buffer.from(text, 'utf8');
  fs.writeFileSync(shim, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buffer]) : buffer);
}

function runChild(script, args, env, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child timed out: ${script}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseSim(result) {
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith('__HOST_SIM__ '));
  assert.ok(line, `host-sim produced no result line\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return JSON.parse(line.slice('__HOST_SIM__ '.length));
}

async function runSim(home, env = {}, waitMs = 700) {
  const result = await runChild(simPath, [], { DSH_HOME: home, SIM_WAIT_MS: String(waitMs), ...env });
  assert.equal(result.code, 0, `host-sim exited ${result.code}\nstderr:\n${result.stderr}`);
  return { ...parseSim(result), stdout: result.stdout, stderr: result.stderr };
}

// --- core detection / repair -------------------------------------------------

test('detect flags a UTF-8 shim with Chinese path and no chcp', () => {
  const { home, shim } = makeHome('detect');
  writeShim(shim, BROKEN_SHIM);

  const state = inspectShim(shim);
  assert.equal(state.exists, true);
  assert.equal(state.status, 'needs-repair');
  assert.deepEqual(state.problems.sort(), ['missing-chcp-utf8', 'non-crlf-endings'].sort());
  assert.equal(state.bom, false);
  assert.equal(state.eol, 'lf');
  assert.equal(state.nonAscii, true);
  assert.equal(state.hasEchoOff, true);

  const { candidates } = expandCandidatePaths({ dshHome: home });
  assert.ok(candidates.some((candidate) => candidate.path === shim), 'legacy runtime-commands layout is discovered');
  fs.rmSync(home, { recursive: true, force: true });
});

test('repair injects chcp on line 2, writes CRLF without BOM, preserves commands', () => {
  const { home, shim } = makeHome('repair');
  writeShim(shim, BROKEN_SHIM);

  const result = repairShim(shim);
  assert.equal(result.changed, true);
  assert.ok(result.actions.includes('injected-chcp'));
  assert.ok(result.actions.includes('normalized-eol:lf'));
  assert.ok(fs.existsSync(result.backupPath), 'backup of the original shim exists');

  const bytes = fs.readFileSync(shim);
  assert.notDeepEqual(bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]), 'no UTF-8 BOM');
  const text = bytes.toString('utf8');
  assert.ok(text.startsWith('@echo off\r\nchcp 65001 >nul\r\n'), `unexpected head: ${JSON.stringify(text.slice(0, 60))}`);
  assert.ok(text.includes('软件一开发'), 'Chinese path is preserved byte-for-byte');
  assert.ok(!/(?<!\r)\n/.test(text), 'no lone LF line endings remain');
  assert.equal(text.match(/chcp/gi).length, 1, 'exactly one chcp line');

  const verified = verifyShim(shim);
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.problems, []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('repair is idempotent (second run changes nothing)', () => {
  const { home, shim } = makeHome('idempotent');
  writeShim(shim, BROKEN_SHIM);

  assert.equal(repairShim(shim).changed, true);
  const hash = sha256(shim);
  const second = repairShim(shim);
  assert.equal(second.changed, false);
  assert.equal(second.skipped, 'already-ok');
  assert.equal(sha256(shim), hash);
  fs.rmSync(home, { recursive: true, force: true });
});

test('wrong codepage is rewritten to 65001, BOM and LF are normalized', () => {
  const { home, shim } = makeHome('normalize');
  writeShim(shim, ['@echo off', 'chcp 437 >nul', '"C:\\Tools\\pnpm.cjs" %*', ''].join('\n'), { bom: true });

  const result = repairShim(shim);
  assert.equal(result.changed, true);
  assert.ok(result.actions.includes('rewrote-chcp:437'));
  const text = fs.readFileSync(shim, 'utf8');
  assert.ok(text.startsWith('@echo off\r\nchcp 65001 >nul\r\n'));
  assert.equal(text.match(/chcp/gi).length, 1);
  assert.equal(fs.readFileSync(shim).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('dry-run reports the problem but leaves bytes untouched', () => {
  const { home, shim } = makeHome('dryrun');
  writeShim(shim, BROKEN_SHIM);
  const hash = sha256(shim);
  const report = repairAll({ dshHome: home, dryRun: true });
  assert.equal(report.repaired, 0);
  assert.equal(sha256(shim), hash);
  const item = report.results.find((entry) => entry.path === shim);
  assert.ok(item, 'report contains the shim');
  assert.ok(item.problems.includes('missing-chcp-utf8'));
  fs.rmSync(home, { recursive: true, force: true });
});

// --- startup / restart / regeneration loop -----------------------------------

test('startup loop: plugin apply() repairs a broken shim', async () => {
  const { home, shim } = makeHome('startup');
  writeShim(shim, BROKEN_SHIM);

  const sim = await runSim(home, { SIM_STARTUP_DELAY_MS: '0' });
  assert.equal(sim.ok, true);
  const repairedLog = sim.logs.find((entry) => entry.includes('repaired=1'));
  assert.ok(repairedLog, `expected a repair summary, got:\n${sim.logs.join('\n')}`);
  assert.equal(inspectShim(shim).status, 'ok');
  fs.rmSync(home, { recursive: true, force: true });
});

test('restart loop: a second startup finds it already repaired and changes nothing', async () => {
  const { home, shim } = makeHome('restart');
  writeShim(shim, BROKEN_SHIM);

  const first = await runSim(home, { SIM_STARTUP_DELAY_MS: '0' });
  assert.ok(first.logs.some((entry) => entry.includes('repaired=1')));
  const hash = sha256(shim);

  const second = await runSim(home, { SIM_STARTUP_DELAY_MS: '0' });
  assert.ok(second.logs.some((entry) => entry.includes('repaired=0') && entry.includes('ok=1')), `unexpected second startup logs:\n${second.logs.join('\n')}`);
  assert.equal(sha256(shim), hash, 'bytes are stable across restarts');
  assert.equal(inspectShim(shim).status, 'ok');
  fs.rmSync(home, { recursive: true, force: true });
});

test('regeneration loop: Desktop rewrites a broken shim while the plugin runs and the watcher repairs it', async () => {
  const { home, shim } = makeHome('regen');
  writeShim(shim, BROKEN_SHIM);

  const sim = await runSim(
    home,
    {
      SIM_STARTUP_DELAY_MS: '0',
      SIM_WAIT_MS: '1600',
      // Effectively disable the polling fallback: only fs.watch can see the
      // regeneration inside the test window.
      SIM_POLL_MS: '60000',
      SIM_REGENERATE_PATH: shim,
      SIM_REGENERATE_CONTENT: BROKEN_SHIM,
      SIM_REGENERATE_DELAY_MS: '300',
    },
    20000,
  );
  assert.ok(sim.logs.some((entry) => entry.includes('regenerated')), 'simulation rewrote the shim');
  const watchLog = sim.logs.find((entry) => entry.includes('shim regenerated and repaired'));
  assert.ok(watchLog, `expected the watcher to repair the regenerated shim, got:\n${sim.logs.join('\n')}`);
  assert.equal(inspectShim(shim).status, 'ok');
  fs.rmSync(home, { recursive: true, force: true });
});

// --- diagnosis / CLI -----------------------------------------------------------

test('DSH version classification matches the native-fix threshold', () => {
  assert.equal(classifyDshSupport('0.1.1').state, 'legacy');
  assert.equal(classifyDshSupport('0.1.2-alpha.0').state, 'legacy');
  assert.equal(classifyDshSupport('0.1.2-alpha.1').state, 'native');
  assert.equal(classifyDshSupport('0.1.2').state, 'native');
  assert.equal(classifyDshSupport('0.2.1-rc.2').state, 'native');
  assert.equal(classifyDshSupport('garbage').state, 'unknown');
  assert.equal(classifyDshSupport(undefined).state, 'unknown');
  assert.equal(compareVersions('0.1.2-alpha.1', '0.1.2-alpha.2'), -1);
  assert.equal(compareVersions('0.1.2-rc.1', '0.1.2'), -1);
  assert.equal(compareVersions('0.2.1-rc.2', '0.1.2-alpha.1'), 1);
});

test('doctor matrix covers runtime, version, koffi, shell, workspace, paths and shims', async () => {
  const base = freshDir('matrix');
  const home = path.join(base, '软件 开发', '.dsh');
  const shim = path.join(home, 'dsh-runtimes', 'rt', 'runtime-commands', 'bin', 'pnpm.cmd');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  writeShim(shim, BROKEN_SHIM);
  const before = sha256(shim);

  const report = await doctor({ dshHome: home, installRoot: '', env: {}, workspace: base });
  const ids = report.checks.map((check) => check.id);
  for (const id of [
    'node-version',
    'dsh-runtime-version',
    'directory-picker-decoder',
    'koffi-native',
    'powershell',
    'workspace-permissions',
    'home-non-ascii',
    'home-space',
    'cross-drive',
    'long-path',
    'pnpm-shims',
  ]) {
    assert.ok(ids.includes(id), `matrix is missing check ${id}: ${ids.join(', ')}`);
  }
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(byId['dsh-runtime-version'].status, 'skipped');
  assert.equal(byId['koffi-native'].status, 'skipped');
  assert.equal(byId['cross-drive'].status, 'skipped');
  assert.equal(byId['pnpm-shims'].status, 'error');
  assert.equal(byId['home-non-ascii'].status, 'warn');
  assert.equal(byId['home-space'].status, 'warn');
  assert.equal(byId['workspace-permissions'].status, 'pass');
  assert.equal(report.summary.error + report.summary.warn + report.summary.pass + report.summary.skipped, report.summary.total);
  assert.ok(report.summary.skipped >= 3, 'unrun checks are counted separately');
  assert.ok(report.checks.filter((check) => check.status === 'skipped').every((check) => check.risk === 'skipped'));
  assert.equal(sha256(shim), before, 'doctor is read-only');
  fs.rmSync(base, { recursive: true, force: true });
});

test('HTML report keeps 未运行 separate from 通过 and escapes injected content', async () => {
  const base = freshDir('html');
  const home = path.join(base, '.dsh');
  fs.mkdirSync(home, { recursive: true });
  const report = await doctor({ dshHome: home, installRoot: '', env: {}, workspace: base });
  const html = renderHtmlReport(report);
  assert.match(html, /<!DOCTYPE html>/);
  assert.ok(html.includes('id="section-skipped"'));
  assert.ok(html.includes('不代表通过'));
  assert.ok(html.includes('id="section-pass"'));

  const skippedChunk = html.split('id="section-skipped"')[1] ?? '';
  assert.ok(skippedChunk.includes('data-check-id="dsh-runtime-version"'), 'skipped check lives in the skipped section');
  const passStart = html.indexOf('id="section-pass"');
  if (passStart >= 0) {
    assert.ok(!html.slice(passStart).includes('data-check-id="dsh-runtime-version"'), 'skipped check never appears in pass');
  }

  const malicious = {
    ...report,
    checks: [{
      id: 'xss',
      category: '<img src=x onerror=alert(1)>',
      title: '<script>alert(1)</script>',
      status: 'warn',
      risk: 'warning',
      detail: '<b>bold</b>',
      rootCause: '<i>cause</i>',
      suggestion: '<u>fix</u>',
      evidence: { '<key>': '<value>' },
    }],
    summary: { total: 1, error: 0, warn: 1, pass: 0, skipped: 0, verdict: 'warn' },
  };
  const escaped = renderHtmlReport(malicious);
  assert.ok(!escaped.includes('<script>alert(1)</script>'));
  assert.ok(escaped.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('CLI doctor --json emits the matrix and a consistent exit code', async () => {
  const { home, shim } = makeHome('doctor-json');
  writeShim(shim, BROKEN_SHIM);
  const result = await runChild(cliPath, ['doctor', '--json', '--dsh-home', home, '--install-root', 'none', '--workspace', home], {}, 30000);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.ok(Array.isArray(report.checks) && report.checks.length >= 10);
  assert.equal(report.summary.error > 0, result.code === 1, `exit ${result.code} should mirror summary.error`);
  assert.ok(report.checks.some((check) => check.id === 'pnpm-shims' && check.status === 'error'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('CLI doctor --html writes a self-contained report file', async () => {
  const { home, shim } = makeHome('doctor-html');
  writeShim(shim, BROKEN_SHIM);
  const outFile = path.join(home, 'report.html');
  const result = await runChild(cliPath, ['doctor', '--html', outFile, '--dsh-home', home, '--install-root', 'none', '--workspace', home], {}, 30000);
  assert.ok([0, 1].includes(result.code), `unexpected exit ${result.code}\n${result.stderr}`);
  assert.ok(fs.existsSync(outFile), `report file missing\n${result.stdout}\n${result.stderr}`);
  const html = fs.readFileSync(outFile, 'utf8');
  assert.ok(html.includes('Windows 兼容体检报告'));
  assert.ok(html.includes('未运行'));
  assert.ok(html.includes('id="section-skipped"'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('CLI status exits 1 on a broken shim, repair exits 0 and fixes it', async () => {
  const { home, shim } = makeHome('cli');
  writeShim(shim, BROKEN_SHIM);

  const status = await runChild(cliPath, ['status', '--dsh-home', home, '--json'], {});
  assert.equal(status.code, 1, `status should fail on a broken shim\n${status.stdout}\n${status.stderr}`);

  const repair = await runChild(cliPath, ['repair', '--dsh-home', home], {});
  assert.equal(repair.code, 0, `repair should succeed\n${repair.stdout}\n${repair.stderr}`);
  assert.equal(inspectShim(shim).status, 'ok');

  const verify = await runChild(cliPath, ['verify', '--dsh-home', home], {});
  assert.equal(verify.code, 0, `verify should pass\n${verify.stdout}\n${verify.stderr}`);
  fs.rmSync(home, { recursive: true, force: true });
});

// --- runner --------------------------------------------------------------------

let failed = 0;
fs.mkdirSync(tmpRoot, { recursive: true });
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(String(error?.stack ?? error).split('\n').map((line) => `     ${line}`).join('\n'));
  }
}
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  // temp cleanup is best effort
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
process.exit(failed === 0 ? 0 : 1);
