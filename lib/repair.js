/**
 * dsh-win-compat / repair core.
 *
 * Zero-dependency, side-effect-free-until-called Windows shim repair:
 * inspect a generated `.cmd` shim, normalize it to what cmd.exe can parse on a
 * Chinese (OEM 936) console — UTF-8 without BOM, CRLF, and an explicit
 * `chcp 65001 >nul` before any non-ASCII path is expanded.
 *
 * The module also diagnoses the other Windows path traps:
 * non-ASCII / space / cross-drive / long DSH_HOME roots.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SHIM_FILENAME = 'pnpm.cmd';
export const BACKUP_SUFFIX = '.dsh-win-compat.bak';
export const CHCP_LINE = 'chcp 65001 >nul';

const CHCP_RE = /^\s*@?chcp(?:\.com)?\s+(\d+)\b/i;
const ECHO_OFF_RE = /^\s*@?echo\s+off\s*$/i;
const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function readDirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function sleepSync(ms) {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

/** First `pnpm.cmd` on PATH (only used when the caller opts in). */
function scanPathForPnpm(env) {
  const raw = env.PATH || env.Path || '';
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, SHIM_FILENAME);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep scanning
    }
  }
  return null;
}

/** `$DSH_HOME`, or `~/.dsh` when the harness did not set it. */
export function resolveDshHome(env = process.env) {
  const value = env.DSH_HOME || env.DSH_HOME_DIR || '';
  if (value.trim()) return path.resolve(value.trim());
  return path.join(os.homedir(), '.dsh');
}

/**
 * Every place a DSH / pnpm installer may have written a pnpm shim.
 * Paths need not exist yet: the watcher attaches when their directory appears.
 *
 * @param {{dshHome?: string, env?: NodeJS.ProcessEnv, extraShimPaths?: string[],
 *          includePath?: boolean}} [options]
 * @returns {{dshHome: string, candidates: {path: string, source: string}[]}}
 */
export function expandCandidatePaths(options = {}) {
  const env = options.env ?? process.env;
  const dshHome = path.resolve(options.dshHome ?? resolveDshHome(env));
  const seen = new Set();
  const candidates = [];
  const add = (file, source) => {
    if (!file) return;
    const resolved = path.resolve(file);
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path: resolved, source });
  };

  // Layouts observed across DSH Desktop releases: a shared runtime-commands
  // folder, or one `bin` per installed runtime under `dsh-runtimes`.
  add(path.join(dshHome, 'dsh-runtimes', 'runtime-commands', 'bin', SHIM_FILENAME), 'dsh-runtimes/runtime-commands');
  add(path.join(dshHome, 'runtime-commands', 'bin', SHIM_FILENAME), 'dsh-home/runtime-commands');
  add(path.join(dshHome, 'bin', SHIM_FILENAME), 'dsh-home/bin');
  for (const entry of readDirEntries(path.join(dshHome, 'dsh-runtimes'))) {
    if (!entry.isDirectory()) continue;
    add(
      path.join(dshHome, 'dsh-runtimes', entry.name, 'runtime-commands', 'bin', SHIM_FILENAME),
      `dsh-runtimes/${entry.name}/runtime-commands`,
    );
    add(path.join(dshHome, 'dsh-runtimes', entry.name, 'bin', SHIM_FILENAME), `dsh-runtimes/${entry.name}/bin`);
  }

  // Profile-level `.bin` shims (pnpm bin links) and the user command folder.
  for (const entry of readDirEntries(path.join(dshHome, 'profiles'))) {
    if (!entry.isDirectory()) continue;
    add(
      path.join(dshHome, 'profiles', entry.name, 'node_modules', '.bin', SHIM_FILENAME),
      `profile/${entry.name}`,
    );
  }
  add(path.join(os.homedir(), '.local', 'bin', SHIM_FILENAME), 'user/.local/bin');

  for (const extra of options.extraShimPaths ?? []) add(extra, 'extra');
  if (options.includePath) add(scanPathForPnpm(env), 'PATH');

  return { dshHome, candidates };
}

/** Only candidate paths that currently exist, deduplicated. */
export function listExistingShims(options = {}) {
  return expandCandidatePaths(options).candidates.filter((candidate) => {
    try {
      return fs.statSync(candidate.path).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Inspect one shim without modifying it.
 *
 * @returns {{
 *   path: string, exists: boolean, size: number,
 *   status: 'ok'|'missing'|'needs-repair'|'unreadable'|'unsupported',
 *   problems: string[], bom: boolean, eol: 'crlf'|'lf'|'mixed'|null,
 *   hasEchoOff: boolean, nonAscii: boolean,
 *   chcp: {value: string, lineIndex: number, line: string}|null,
 *   firstLines: string[], error?: string
 * }}
 */
export function inspectShim(file) {
  const result = {
    path: file,
    exists: false,
    size: 0,
    status: 'missing',
    problems: [],
    bom: false,
    eol: null,
    hasEchoOff: false,
    nonAscii: false,
    chcp: null,
    firstLines: [],
  };

  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      result.status = 'unreadable';
      result.problems.push(`unreadable:${error?.code ?? 'error'}`);
      result.error = String(error?.message ?? error);
    }
    return result;
  }

  result.exists = true;
  result.size = bytes.length;
  result.bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = result.bom ? bytes.subarray(3) : bytes;

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    result.status = 'unsupported';
    result.problems.push('invalid-utf8');
    return result;
  }

  const crlfCount = (text.match(/\r\n/g) ?? []).length;
  const loneLfCount = (text.match(/(?<!\r)\n/g) ?? []).length;
  result.eol = crlfCount > 0 && loneLfCount > 0 ? 'mixed' : loneLfCount > 0 ? 'lf' : 'crlf';

  const lines = text.split(/\r\n|\n|\r/);
  result.hasEchoOff = lines.length > 0 && ECHO_OFF_RE.test(lines[0]);
  result.firstLines = lines.slice(0, 4);
  result.nonAscii = /[^\x00-\x7f]/.test(text);

  for (let index = 0; index < lines.length; index += 1) {
    const match = CHCP_RE.exec(lines[index]);
    if (match) {
      result.chcp = { value: match[1], lineIndex: index, line: lines[index].trim() };
      break;
    }
  }

  if (result.chcp === null || result.chcp.value !== '65001') result.problems.push('missing-chcp-utf8');
  if (result.bom) result.problems.push('utf8-bom');
  if (result.eol !== 'crlf') result.problems.push('non-crlf-endings');

  result.status = result.problems.length === 0 ? 'ok' : 'needs-repair';
  return result;
}

/** Rewrite a shim atomically. Returns what changed; never throws for missing files. */
export function repairShim(file, options = {}) {
  const { backup = true, dryRun = false } = options;
  const before = inspectShim(file);

  if (!before.exists) return { path: file, changed: false, skipped: 'missing', before, after: before };
  if (before.status === 'ok') return { path: file, changed: false, skipped: 'already-ok', before, after: before };
  if (before.status === 'unsupported') {
    return { path: file, changed: false, skipped: 'invalid-utf8', before, after: before };
  }
  if (before.status === 'unreadable') {
    return { path: file, changed: false, skipped: 'unreadable', before, after: before, error: before.error };
  }

  const original = fs.readFileSync(file);
  const body = before.bom ? original.subarray(3) : original;
  let text = new TextDecoder('utf-8', { fatal: true }).decode(body);

  let lines = text.split(/\r\n|\n|\r/);
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (hadTrailingNewline) lines.pop();

  const actions = [];
  if (before.bom) actions.push('stripped-bom');
  if (before.eol !== 'crlf') actions.push(`normalized-eol:${before.eol}`);

  const chcpIndex = lines.findIndex((line) => CHCP_RE.test(line));
  if (chcpIndex >= 0) {
    if (!/^\s*@?chcp(?:\.com)?\s+65001\b/i.test(lines[chcpIndex])) {
      const previous = CHCP_RE.exec(lines[chcpIndex])?.[1] ?? 'unknown';
      lines[chcpIndex] = CHCP_LINE;
      actions.push(`rewrote-chcp:${previous}`);
    }
  } else {
    const insertIndex = lines.length > 0 && ECHO_OFF_RE.test(lines[0]) ? 1 : 0;
    lines.splice(insertIndex, 0, CHCP_LINE);
    actions.push('injected-chcp');
  }

  text = lines.join('\r\n');
  if (hadTrailingNewline) text += '\r\n';
  const next = Buffer.from(text, 'utf8');

  if (next.equals(original)) {
    return { path: file, changed: false, skipped: 'no-difference', before, after: inspectShim(file), actions };
  }

  if (dryRun) {
    return { path: file, changed: false, dryRun: true, wouldChange: true, before, after: before, actions };
  }

  const backupPath = `${file}${BACKUP_SUFFIX}`;
  if (backup) {
    try {
      if (!fs.existsSync(backupPath)) fs.copyFileSync(file, backupPath);
    } catch {
      // A backup is best effort; the repair itself must still be attempted.
    }
  }

  const mode = fs.statSync(file).mode & 0o777;
  atomicWrite(file, next, mode);

  return { path: file, changed: true, before, after: inspectShim(file), actions, backupPath };
}

/** Post-repair check: no BOM, CRLF, `chcp 65001` present. */
export function verifyShim(file) {
  const state = inspectShim(file);
  return { path: file, ok: state.exists && state.status === 'ok', status: state.status, problems: state.problems, state };
}

function atomicWrite(file, bytes, mode) {
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  fs.writeFileSync(temp, bytes, { mode });
  try {
    renameWithRetry(temp, file);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // best effort
    }
    throw error;
  }
}

function renameWithRetry(from, to) {
  let delay = 20;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const transient = process.platform === 'win32' && TRANSIENT_RENAME_CODES.has(error?.code);
      if (!transient || attempt >= 8) throw error;
      sleepSync(delay);
      delay = Math.min(delay * 2, 200);
    }
  }
}

/**
 * Detect + repair every existing shim candidate in one pass.
 *
 * @param {{dshHome?: string, env?: NodeJS.ProcessEnv, extraShimPaths?: string[],
 *          includePath?: boolean, backup?: boolean, dryRun?: boolean}} [options]
 */
export function repairAll(options = {}) {
  const { dshHome, candidates } = expandCandidatePaths(options);
  const results = [];

  for (const candidate of candidates) {
    const before = inspectShim(candidate.path);
    if (!before.exists) {
      results.push({ path: candidate.path, source: candidate.source, status: 'missing', changed: false, problems: [] });
      continue;
    }
    if (before.status === 'ok') {
      results.push({ path: candidate.path, source: candidate.source, status: 'ok', changed: false, problems: [] });
      continue;
    }
    const repair = repairShim(candidate.path, options);
    const after = repair.after ?? inspectShim(candidate.path);
    results.push({
      path: candidate.path,
      source: candidate.source,
      status: after.status,
      changed: repair.changed === true,
      skipped: repair.skipped,
      actions: repair.actions ?? [],
      backupPath: repair.backupPath,
      problems: before.problems,
      remaining: after.problems,
    });
  }

  const existing = results.filter((result) => result.status !== 'missing');
  return {
    dshHome,
    candidates: results.length,
    existing: existing.length,
    repaired: results.filter((result) => result.changed).length,
    ok: results.filter((result) => result.status === 'ok').length,
    failed: results.filter((result) => result.status !== 'ok' && result.status !== 'missing').length,
    results,
  };
}

/** Install root, derived from the Desktop host environment when available. */
export function detectInstallRoot(env = process.env) {
  const nodeExecutable = env.DSH_DESKTOP_NODE_EXECUTABLE;
  if (nodeExecutable) {
    const marker = `${path.sep}resources${path.sep}`;
    const index = nodeExecutable.toLowerCase().indexOf(marker.toLowerCase());
    if (index > 0) return nodeExecutable.slice(0, index);
  }
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    return path.dirname(process.resourcesPath);
  }
  return null;
}

/**
 * First quoted absolute executable referenced by a shim whose target is gone.
 * Catches stale launchers left behind by an older installation (this machine
 * has a `~/.local/bin/node.cmd` pointing at a removed dsh-runtimes folder).
 * Environment-variable forms are skipped: they cannot be checked without
 * expanding the caller's shell.
 */
export function staleShimTarget(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:@?echo|chcp|rem\b|::)/i.test(line)) continue;
    const match = /"([A-Za-z]:\\[^"]+)"/.exec(line);
    if (!match) continue;
    const target = match[1];
    if (/%/.test(target)) continue;
    try {
      if (fs.statSync(target).isFile()) continue;
    } catch {
      // fall through: reported as stale
    }
    return target;
  }
  return null;
}

/**
 * One-line human summary of a repairAll report.
 */
export function summarizeReport(report) {
  return `[dsh-win-compat] shim scan: candidates=${report.candidates}, existing=${report.existing}, repaired=${report.repaired}, ok=${report.ok}, failed=${report.failed}`;
}
