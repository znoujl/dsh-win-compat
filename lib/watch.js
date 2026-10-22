/**
 * dsh-win-compat / runtime watcher.
 *
 * Desktop regenerates its runtime shims on restart (and may recreate them
 * lazily). A one-shot startup repair would be undone by the next launch, so
 * the plugin keeps two cheap guards alive:
 *   - fs.watch on every directory that may hold a pnpm.cmd (attached lazily,
 *     because dsh-runtimes may not exist yet);
 *   - a low-frequency polling pass that catches events fs.watch misses on
 *     Windows (new directory creation, rename races, watcher error).
 */
import fs from 'node:fs';
import path from 'node:path';
import { expandCandidatePaths, inspectShim, repairAll, repairShim, SHIM_FILENAME } from './repair.js';

/**
 * @param {{
 *   dshHome?: string,
 *   env?: NodeJS.ProcessEnv,
 *   extraShimPaths?: string[],
 *   includePath?: boolean,
 *   pollIntervalMs?: number,
 *   debounceMs?: number,
 *   logger?: {info?: Function, warn?: Function, debug?: Function},
 *   onRepair?: (result: object) => void,
 * }} [options]
 * @returns {{close: () => void, stats: () => object}}
 */
export function startShimWatch(options = {}) {
  const {
    dshHome,
    env = process.env,
    extraShimPaths = [],
    includePath = false,
    pollIntervalMs = 5000,
    debounceMs = 250,
    logger,
    onRepair,
  } = options;

  const watchers = new Map();
  const pending = new Map();
  const repairedTotal = { count: 0 };
  let closed = false;

  const descriptor = { dshHome, env, extraShimPaths, includePath };

  const warn = (message) => {
    try {
      (logger?.warn ?? console.warn)?.(message);
    } catch {
      // logging must never break the watcher
    }
  };

  const repairFile = (file) => {
    try {
      const before = inspectShim(file);
      if (before.status !== 'needs-repair') return;
      const result = repairShim(file, { backup: true });
      if (result.changed) {
        repairedTotal.count += 1;
        try {
          onRepair?.(result);
        } catch {
          // ignore consumer errors
        }
      }
    } catch (error) {
      warn(`[dsh-win-compat] watcher could not repair ${file}: ${error?.message ?? error}`);
    }
  };

  const schedule = (file) => {
    if (closed) return;
    const existing = pending.get(file);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(file);
      if (!closed) repairFile(file);
    }, debounceMs);
    timer.unref?.();
    pending.set(file, timer);
  };

  const syncWatchers = () => {
    if (closed) return;
    const { candidates } = expandCandidatePaths(descriptor);
    for (const candidate of candidates) {
      const dir = path.dirname(candidate.path);
      if (watchers.has(dir)) continue;
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
          const name = filename === null ? SHIM_FILENAME : String(filename);
          if (name.toLowerCase() !== SHIM_FILENAME) return;
          schedule(path.join(dir, name));
        });
        watcher.on('error', () => {
          try {
            watcher.close();
          } catch {
            // ignore
          }
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
      } catch (error) {
        warn(`[dsh-win-compat] cannot watch ${dir}: ${error?.message ?? error}`);
      }
    }
  };

  const poll = () => {
    if (closed) return;
    try {
      const report = repairAll({ ...descriptor, backup: true });
      if (report.repaired > 0) {
        repairedTotal.count += report.repaired;
        try {
          onRepair?.(report);
        } catch {
          // ignore consumer errors
        }
      }
    } catch (error) {
      warn(`[dsh-win-compat] polling repair failed: ${error?.message ?? error}`);
    }
    // A new dsh-runtimes/<runtime> folder means new watch targets.
    syncWatchers();
  };

  syncWatchers();
  const interval = setInterval(poll, Math.max(250, pollIntervalMs));
  interval.unref?.();

  return {
    close() {
      if (closed) return;
      clearInterval(interval);
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      for (const watcher of watchers.values()) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
      }
      watchers.clear();
    },
    stats() {
      return { watchedDirs: watchers.size, pendingFiles: pending.size, repaired: repairedTotal.count };
    },
  };
}
