/**
 * Minimal DSH-host simulator for the closed-loop test.
 *
 * It exercises the real plugin entry (`apply`) with the same surface a cordis
 * host provides (ctx.logger + ctx.effect), waits for the startup scan and the
 * watcher, then disposes and prints one machine-readable line.
 *
 * Env:
 *   DSH_HOME                     fixture home
 *   SIM_WAIT_MS                  how long to stay alive (default 600)
 *   SIM_STARTUP_DELAY_MS         override startupDelayMs (default 0)
 *   SIM_REGENERATE_PATH          file to overwrite mid-run
 *   SIM_REGENERATE_CONTENT       UTF-8 content written mid-run
 *   SIM_REGENERATE_DELAY_MS      delay before the overwrite (default 250)
 */
import fs from 'node:fs';
import { apply } from '../lib/index.js';

const home = process.env.DSH_HOME;
const waitMs = Number(process.env.SIM_WAIT_MS ?? 600);
const startupDelayMs = Number(process.env.SIM_STARTUP_DELAY_MS ?? 0);
const pollIntervalMs = Number(process.env.SIM_POLL_MS ?? 100);
const regeneratePath = process.env.SIM_REGENERATE_PATH ?? '';
const regenerateContent = process.env.SIM_REGENERATE_CONTENT ?? '';
const regenerateDelay = Number(process.env.SIM_REGENERATE_DELAY_MS ?? 250);

const logs = [];
const pushLog = (level, message) => logs.push(`${level}: ${String(message).replace(/\r?\n/g, ' | ')}`);
const ctx = {
  logger: {
    info: (message) => pushLog('info', message),
    warn: (message) => pushLog('warn', message),
    debug: (message) => pushLog('debug', message),
  },
  effect(fn) {
    // cordis: effect(callback) runs it now and keeps its returned disposer.
    const disposer = fn();
    this.disposers.push(disposer);
  },
  disposers: [],
};

let dispose;
try {
  dispose = apply(ctx, {
    startupDelayMs,
    watch: true,
    pollIntervalMs,
    debounceMs: 50,
    includePathShims: false,
  });
} catch (error) {
  console.log(`__HOST_SIM__ ${JSON.stringify({ ok: false, error: String(error?.stack ?? error), logs })}`);
  process.exit(1);
}

if (regeneratePath !== '') {
  setTimeout(() => {
    try {
      fs.writeFileSync(regeneratePath, regenerateContent, 'utf8');
      pushLog('sim', `regenerated ${regeneratePath}`);
    } catch (error) {
      pushLog('warn', `regeneration failed: ${error?.message ?? error}`);
    }
  }, regenerateDelay);
}

setTimeout(() => {
  try {
    dispose?.();
    for (const disposer of ctx.disposers) {
      if (typeof disposer === 'function') disposer();
    }
  } catch (error) {
    pushLog('warn', `dispose failed: ${error?.message ?? error}`);
  }
  console.log(`__HOST_SIM__ ${JSON.stringify({ ok: true, home, logs })}`);
  process.exit(0);
}, waitMs);
