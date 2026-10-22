#!/usr/bin/env node
/**
 * dsh-win-compat / CLI.
 *
 * Repair commands (host not running or immediate fix):
 *   status   detect only, exit 1 when a shim needs repair
 *   repair   detect + repair + verify
 *   verify   post-repair verification only
 *   watch    keep repairing regenerated shims (Ctrl+C)
 *
 * Read-only health check:
 *   doctor                terminal report
 *   doctor --json         machine-readable report (CI/CD)
 *   doctor --html [file]  self-contained HTML report (default file below)
 *
 * Options: --dsh-home <path>, --workspace <path>, --install-root <path|none>,
 *          --include-path, --extra-shim <path> (repeatable), --json, --dry-run,
 *          --interval <ms>
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { repairAll, resolveDshHome, summarizeReport, verifyShim } from './repair.js';
import { runDiagnostics } from './diagnostics.js';
import { renderHtmlReport, renderTextReport } from './report.js';
import { startShimWatch } from './watch.js';

const DEFAULT_HTML_REPORT = 'dsh-win-compat-report.html';

const argv = process.argv.slice(2);
const command = (argv[0] ?? 'status').toLowerCase();

function takeFlag(...names) {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index >= 0) {
      argv.splice(index, 1);
      return true;
    }
  }
  return false;
}

function takeOption(...names) {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index >= 0 && index + 1 < argv.length) {
      const value = argv[index + 1];
      argv.splice(index, 2);
      return value;
    }
  }
  return undefined;
}

const wantsJson = takeFlag('--json', '-j');
const dryRun = takeFlag('--dry-run');
const includePath = takeFlag('--include-path');
const dshHomeArg = takeOption('--dsh-home', '--home');
const workspaceArg = takeOption('--workspace');
const installRootArg = takeOption('--install-root');
const intervalArg = takeOption('--interval', '--poll-interval');
const extraShims = [];
for (;;) {
  const extra = takeOption('--extra-shim', '--shim');
  if (extra === undefined) break;
  extraShims.push(extra);
}

// --html takes an optional filename; without one the default report path is used.
let htmlPath = null;
{
  const index = argv.indexOf('--html');
  if (index >= 0) {
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      htmlPath = next;
      argv.splice(index, 2);
    } else {
      htmlPath = DEFAULT_HTML_REPORT;
      argv.splice(index, 1);
    }
  }
}

const env = process.env;
const dshHome = resolveDshHome(env);
const baseOptions = {
  dshHome: dshHomeArg ?? dshHome,
  env,
  extraShimPaths: extraShims,
  includePath,
  backup: true,
};

function parseInstallRoot(value) {
  if (value === undefined) return undefined;
  if (value === '' || value === '-' || value.toLowerCase() === 'none') return null;
  return path.resolve(value);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printReport(result) {
  const lines = [summarizeReport(result)];
  for (const item of result.results) {
    if (item.status === 'missing') continue;
    const actions = item.actions?.length ? ` [${item.actions.join(', ')}]` : '';
    const problems = item.problems?.length ? ` problems=${item.problems.join('+')}` : '';
    const remaining = item.remaining?.length ? ` remaining=${item.remaining.join('+')}` : '';
    const backup = item.backupPath ? ` backup=${item.backupPath}` : '';
    lines.push(`  ${item.changed ? 'REPAIRED' : item.status.toUpperCase()} ${item.path}${actions}${problems}${remaining}${backup}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

switch (command) {
  case 'status':
  case 'detect': {
    const result = repairAll({ ...baseOptions, dryRun: true });
    if (wantsJson) printJson(result);
    else printReport(result);
    const problems = result.results.filter((item) => item.status !== 'ok' && item.status !== 'missing');
    process.exitCode = problems.length === 0 ? 0 : 1;
    break;
  }

  case 'repair': {
    const result = repairAll({ ...baseOptions, dryRun });
    if (wantsJson) printJson(result);
    else printReport(result);
    if (dryRun) {
      process.exitCode = result.results.some((item) => item.status === 'needs-repair') ? 1 : 0;
      break;
    }
    const failed = result.results.filter((item) => item.status !== 'ok' && item.status !== 'missing');
    if (failed.length > 0) {
      process.stderr.write(`[dsh-win-compat] ${failed.length} shim(s) could not be repaired\n`);
      process.exitCode = 1;
    }
    break;
  }

  case 'verify': {
    const result = repairAll({ ...baseOptions, dryRun: true });
    const checks = result.results
      .filter((item) => item.status !== 'missing')
      .map((item) => verifyShim(item.path));
    const failed = checks.filter((check) => !check.ok);
    if (wantsJson) printJson({ checks, failed: failed.length });
    else {
      for (const check of checks) {
        process.stdout.write(`${check.ok ? 'OK  ' : 'FAIL'} ${check.path}${check.ok ? '' : ` (${check.problems.join(', ')})`}\n`);
      }
      if (checks.length === 0) process.stdout.write('[dsh-win-compat] no pnpm shim present; nothing to verify\n');
    }
    process.exitCode = failed.length === 0 ? 0 : 1;
    break;
  }

  case 'doctor': {
    const report = await runDiagnostics({
      ...baseOptions,
      workspace: workspaceArg,
      installRoot: parseInstallRoot(installRootArg),
    });

    if (htmlPath !== null) {
      const target = path.resolve(htmlPath);
      fs.writeFileSync(target, renderHtmlReport(report), 'utf8');
      if (!wantsJson) process.stdout.write(`HTML 报告已写入：${target}\n`);
    }
    if (wantsJson) printJson(report);
    else if (htmlPath === null) process.stdout.write(`${renderTextReport(report)}\n`);

    process.exitCode = report.summary.error > 0 ? 1 : 0;
    break;
  }

  case 'watch': {
    const interval = Number(intervalArg ?? 5000);
    process.stdout.write(`[dsh-win-compat] watching for pnpm shims under ${baseOptions.dshHome} (Ctrl+C to stop)\n`);
    const watcher = startShimWatch({
      ...baseOptions,
      pollIntervalMs: Number.isFinite(interval) ? interval : 5000,
      logger: console,
      onRepair: (result) => {
        if (result?.changed) process.stdout.write(`[dsh-win-compat] repaired ${result.path} (${(result.actions ?? []).join(', ')})\n`);
        else if (typeof result?.repaired === 'number') process.stdout.write(`${summarizeReport(result)}\n`);
      },
    });
    const keepAlive = setInterval(() => {}, 1 << 30);
    const stop = () => {
      clearInterval(keepAlive);
      watcher.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    break;
  }

  default:
    process.stderr.write(
      'usage: dsh-win-compat <status|repair|verify|doctor|watch> [--dsh-home <path>] [--workspace <path>] ' +
        '[--install-root <path|none>] [--json] [--html [file]] [--dry-run] [--include-path]\n',
    );
    process.exitCode = 2;
}
