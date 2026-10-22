/**
 * Minimal semver comparison for the one decision that matters here:
 * does this DSH runtime already include the native fixes (< 0.1.2-alpha.1
 * needs the compatibility shim; >= 0.1.2-alpha.1 is native + guarded by this
 * plugin).
 *
 * Prerelease ordering follows semver 2.0: `alpha < alpha.1 < alpha.2 <
 * beta < rc.1 < 1.0.0`, and a release outranks its prereleases.
 */
export const NATIVE_SUPPORT_THRESHOLD = '0.1.2-alpha.1';

export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function isNumericIdentifier(value) {
  return /^\d+$/.test(value);
}

function compareIdentifier(left, right) {
  const leftNumeric = isNumericIdentifier(left);
  const rightNumeric = isNumericIdentifier(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Compare two version strings.
 * @returns {-1|0|1|null} null when either side is not a plain semver string.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= a.prerelease.length) return -1;
    if (index >= b.prerelease.length) return 1;
    const cmp = compareIdentifier(a.prerelease[index], b.prerelease[index]);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * Classify a detected DSH runtime version against the native-fix threshold.
 * @returns {{state: 'native'|'legacy'|'unknown', threshold: string,
 *            comparison: number|null, message: string}}
 */
export function classifyDshSupport(version) {
  const threshold = NATIVE_SUPPORT_THRESHOLD;
  if (parseVersion(version) === null) {
    return {
      state: 'unknown',
      threshold,
      comparison: null,
      message: '无法解析 DSH 版本，版本兼容性检查未运行（不代表通过）。',
    };
  }
  const comparison = compareVersions(version, threshold);
  if (comparison < 0) {
    return {
      state: 'legacy',
      threshold,
      comparison,
      message: `适用于旧版修复：${version} 低于 ${threshold}，目录选择器/旧 pnpm 转发链仍可能需要兼容处理。`,
    };
  }
  return {
    state: 'native',
    threshold,
    comparison,
    message: `已由新版原生支持，本插件提供守护兜底（${version} ≥ ${threshold}）。`,
  };
}
