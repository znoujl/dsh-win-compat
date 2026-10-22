/**
 * dsh-win-compat / DSH host plugin entry.
 *
 * Zero runtime dependencies and zero build: only Node built-ins plus the
 * cordis-style host context (`ctx.effect`, `ctx.logger`). Everything is
 * best-effort and wrapped so a repair failure can never fail plugin loading.
 *
 * Lifecycle on a Windows Desktop / CLI host:
 *   1. `apply()` runs when the profile composes;
 *   2. after `startupDelayMs` (default 3000) the shim scan detects + repairs;
 *   3. the watcher keeps repairing regenerated shims until the plugin is
 *      disposed (and the poll pass catches new runtime folders).
 */
import { inspectShim, repairAll, repairShim, verifyShim, summarizeReport } from './repair.js';
import { STATUS_LABELS, VERDICT_LABELS, runDiagnostics } from './diagnostics.js';
import { renderHtmlReport, renderTextReport } from './report.js';
import { startShimWatch } from './watch.js';

export const name = 'dsh-win-compat';
/** No required host services: startup repair must work in any profile. */
export const inject = [];

const DEFAULTS = {
  enabled: true,
  startupDelayMs: 3000,
  watch: true,
  pollIntervalMs: 5000,
  debounceMs: 250,
  includePathShims: false,
  extraShimPaths: [],
  dryRun: false,
};

function adaptLogger(logger) {
  const write = (level, message) => {
    try {
      const fn = logger?.[level];
      if (typeof fn === 'function') {
        fn.call(logger, message);
        return;
      }
      const fallback = level === 'warn' || level === 'error' ? console.warn : console.log;
      fallback(message);
    } catch {
      // logging must never break the host
    }
  };
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    debug: (message) => write('debug', message),
  };
}

function describeResult(result) {
  if (result?.status === 'missing') return null;
  const actions = Array.isArray(result?.actions) && result.actions.length > 0 ? ` (${result.actions.join(', ')})` : '';
  if (result?.changed) return `repaired ${result.path}${actions}${result.backupPath ? `; backup ${result.backupPath}` : ''}`;
  if (result?.status === 'ok') return null;
  const problems = Array.isArray(result?.remaining) && result.remaining.length > 0 ? result.remaining.join(', ') : 'unknown';
  return `still needs attention: ${result?.path} (${problems})`;
}

/**
 * @param {object} ctx cordis-style host context
 * @param {Partial<typeof DEFAULTS>} [config]
 * @returns {(() => void)|undefined} dispose function (also registered on ctx.effect)
 */
export function apply(ctx, config = {}) {
  if (process.platform !== 'win32') return undefined;

  const options = { ...DEFAULTS, ...(config !== null && typeof config === 'object' ? config : {}) };
  if (options.enabled === false) return undefined;

  const logger = adaptLogger(ctx?.logger);
  const env = process.env;
  const scanOptions = {
    env,
    extraShimPaths: Array.isArray(options.extraShimPaths) ? options.extraShimPaths : [],
    includePath: options.includePathShims === true,
    backup: true,
    dryRun: options.dryRun === true,
  };

  const report = (result) => {
    const lines = [summarizeReport(result)];
    for (const item of result.results ?? []) {
      const line = describeResult(item);
      if (line !== null) lines.push(`  - ${line}`);
    }
    if ((result.failed ?? 0) > 0) logger.warn(lines.join('\n'));
    else logger.info(lines.join('\n'));
  };

  const runStartupScan = () => {
    try {
      const result = repairAll(scanOptions);
      if (result.existing > 0 || result.repaired > 0) {
        report(result);
      } else {
        logger.debug('[dsh-win-compat] no pnpm shim found; watching for one');
      }
      return result;
    } catch (error) {
      logger.warn(`[dsh-win-compat] startup shim repair failed: ${error?.message ?? error}`);
      return null;
    }
  };

  const startupTimer = setTimeout(runStartupScan, Math.max(0, Number(options.startupDelayMs) || 0));
  startupTimer.unref?.();

  const watcher = options.watch === false
    ? null
    : startShimWatch({
        env,
        extraShimPaths: scanOptions.extraShimPaths,
        includePath: scanOptions.includePath,
        pollIntervalMs: Math.max(250, Number(options.pollIntervalMs) || DEFAULTS.pollIntervalMs),
        debounceMs: Math.max(0, Number(options.debounceMs) || DEFAULTS.debounceMs),
        logger,
        onRepair: (result) => {
          if (result?.changed) {
            logger.info(`[dsh-win-compat] shim regenerated and repaired: ${result.path} (${(result.actions ?? []).join(', ')})`);
          } else {
            report(result);
          }
        },
      });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(startupTimer);
    watcher?.close();
  };

  try {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => dispose, 'dsh-win-compat: pnpm shim repair');
    } else {
      process.once('exit', dispose);
    }
  } catch {
    // non-cordis host (unit tests): caller owns dispose via the return value
  }

  return dispose;
}

export {
  inspectShim,
  repairAll,
  repairShim,
  verifyShim,
  summarizeReport,
  runDiagnostics,
  STATUS_LABELS,
  VERDICT_LABELS,
  renderTextReport,
  renderHtmlReport,
};
export { runDiagnostics as doctor };
export { startShimWatch } from './watch.js';
