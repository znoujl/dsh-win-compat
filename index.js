/**
 * Standard marketplace entry (`plugin.json` → `entry: "index.js"`).
 * Re-exports the real plugin module so both `package.json#main` and the
 * marketplace entry resolve to the same `name` / `inject` / `apply`.
 */
export * from './lib/index.js';
