/**
 * dsh-win-compat / diagnostic orchestrator.
 *
 * `doctor` is a READ-ONLY matrix: it inspects files, versions, ACL-relevant
 * access bits and spawns version queries, but never writes, repairs or deletes.
 * Every result is one of four states, and a check that could not run is
 * reported as `skipped` ("未运行") — never as `pass`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { readAsarEntry, readAsarJson } from './asar.js';
import { classifyDshSupport, NATIVE_SUPPORT_THRESHOLD, parseVersion } from './version.js';
import {
  detectInstallRoot,
  expandCandidatePaths,
  inspectShim,
  resolveDshHome,
  staleShimTarget,
} from './repair.js';

export const STATUS_LABELS = Object.freeze({
  error: '高危',
  warn: '警告',
  pass: '通过',
  skipped: '未运行',
});

export const VERDICT_LABELS = Object.freeze({
  fail: '需处理',
  warn: '有警告',
  partial: '部分检查未运行',
  pass: '通过',
});

const RISK_BY_STATUS = Object.freeze({
  error: 'high',
  warn: 'warning',
  pass: 'pass',
  skipped: 'skipped',
});

function readOwnPackage() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}

function isNonAscii(value) {
  return /[^\x00-\x7f]/.test(value);
}

function existsDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function accessCheck(target, mode) {
  try {
    fs.accessSync(target, mode);
    return true;
  } catch {
    return false;
  }
}

async function queryPowerShell(executable) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, error: error?.message ?? String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({ ok: false, error: 'timeout after 4000ms' });
    }, 4000);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ ok: false, error: error?.message ?? String(error) }));
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, version: stdout.trim() });
      else finish({ ok: false, error: (stderr || `exit ${code}`).trim() });
    });
  });
}

function findPowerShellCandidates(env) {
  const seen = new Set();
  const found = [];
  const add = (label, file) => {
    if (!file) return;
    const resolved = path.resolve(file);
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (!existsDirectory(path.dirname(resolved))) return;
    try {
      if (!fs.statSync(resolved).isFile()) return;
    } catch {
      return;
    }
    found.push({ label, path: resolved });
  };

  const pathValue = env.PATH || env.Path || '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    add('pwsh', path.join(dir, 'pwsh.exe'));
    add('powershell', path.join(dir, 'powershell.exe'));
  }
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  add('pwsh', path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'));
  const systemRoot = env.SystemRoot || 'C:\\Windows';
  add('powershell', path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  return found;
}

async function checkPowerShell(env) {
  const candidates = findPowerShellCandidates(env);
  if (candidates.length === 0) {
    return {
      status: 'error',
      detail: '未找到 pwsh.exe 或 powershell.exe：DSH 的 PowerShell 工具与部分修复脚本将不可用。',
      rootCause: 'PowerShell 可执行文件不在 PATH，也不在标准安装目录。',
      suggestion: '安装 PowerShell 7（winget install Microsoft.PowerShell），或修复 Windows 自带 PowerShell。',
      evidence: { searched: 'PATH + Program Files\\PowerShell\\7 + System32\\WindowsPowerShell\\v1.0' },
    };
  }
  const results = [];
  for (const candidate of candidates) {
    results.push({ ...candidate, ...(await queryPowerShell(candidate.path)) });
  }
  const usable = results.filter((result) => result.ok);
  const pwsh = usable.find((result) => result.label === 'pwsh');
  if (usable.length > 0) {
    const status = pwsh ? 'pass' : 'warn';
    return {
      status,
      detail: `可用 PowerShell：${usable.map((item) => `${item.label} ${item.version}`).join('；')}`,
      ...(pwsh
        ? {}
        : {
            rootCause: '只有 Windows PowerShell 5.1，没有 PowerShell 7（pwsh）。',
            suggestion: '安装 PowerShell 7 以获得 DSH 推荐 shell；5.1 也可用，但兼容性较差。',
          }),
      evidence: { candidates: results.map(({ label, path: file, ok, version, error }) => ({ label, path: file, ok, version, error })) },
    };
  }
  return {
    status: 'warn',
    detail: '找到了 PowerShell 可执行文件，但版本查询全部失败。',
    rootCause: '执行被策略拦截、超时或二进制损坏。',
    suggestion: '在终端手动运行 `pwsh -NoProfile -Command $PSVersionTable` 确认；检查执行策略/安全软件。',
    evidence: { candidates: results.map(({ label, path: file, ok, version, error }) => ({ label, path: file, ok, version, error })) },
  };
}

function readRuntimeMetadata(installRoot) {
  if (!installRoot) {
    return { asarPath: null, runtimeVersion: null, desktopVersion: null, runtimePackage: null, decoderText: null };
  }
  const asarPath = path.join(installRoot, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    return { asarPath, missing: true, runtimeVersion: null, desktopVersion: null, runtimePackage: null, decoderText: null };
  }
  const runtimePackage = readAsarJson(asarPath, 'dsh/package.json');
  const desktopPackage = readAsarJson(asarPath, 'package.json');
  const decoder = readAsarEntry(
    asarPath,
    'dsh/node_modules/@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs',
  );
  return {
    asarPath,
    runtimeVersion: typeof runtimePackage?.version === 'string' ? runtimePackage.version : null,
    desktopVersion: typeof desktopPackage?.version === 'string' ? desktopPackage.version : null,
    runtimePackage,
    decoderText: decoder === null ? null : decoder.toString('utf8'),
  };
}

function checkDshVersion(installRoot, metadata) {
  const support = classifyDshSupport(metadata.runtimeVersion);
  const evidence = {
    installRoot,
    asarPath: metadata.asarPath,
    runtimeVersion: metadata.runtimeVersion,
    desktopVersion: metadata.desktopVersion,
    threshold: NATIVE_SUPPORT_THRESHOLD,
  };
  if (support.state === 'unknown') {
    return {
      status: 'skipped',
      title: 'DSH 运行时版本侦测',
      detail: metadata.missing
        ? `安装目录中缺少 app.asar（${metadata.asarPath}），版本兼容性检查未运行。`
        : '无法从 app.asar 读取 DSH 运行时版本，版本兼容性检查未运行。',
      suggestion: '在 DSH 宿主内运行 doctor，或用 --install-root 指定安装目录。',
      evidence,
      support,
    };
  }
  if (support.state === 'legacy') {
    return {
      status: 'warn',
      title: '旧版 DSH：需要本插件修复',
      detail: support.message,
      rootCause: '旧版目录选择器 readUtf16 只检查低字节，遇到「一/开」等字符会截断；旧 pnpm 转发链也缺少 UTF-8 代码页处理。',
      suggestion: '升级到 0.1.2-alpha.1 或更高；升级前由本插件守护 pnpm shim 编码，目录选择器问题需升级核心。',
      evidence,
      support,
    };
  }
  return {
    status: 'pass',
    title: '新版 DSH：原生支持 + 守护兜底',
    detail: support.message,
    evidence,
    support,
  };
}

function checkDirectoryPickerDecoder(metadata) {
  const evidence = { worker: 'dsh/node_modules/@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs' };
  if (metadata.decoderText === null) {
    return {
      status: 'skipped',
      title: '目录选择器解码实现',
      detail: '无法从 app.asar 读取 worker.cjs，解码实现检查未运行（不代表通过）。',
      evidence,
    };
  }
  if (metadata.decoderText.includes('str16')) {
    return {
      status: 'pass',
      title: '目录选择器解码实现',
      detail: '使用 koffi "str16" 解码，UTF-16 终止符问题已原生修复。',
      evidence: { ...evidence, pattern: 'koffi str16' },
    };
  }
  if (/bytes\s*\[\s*end\s*\]/.test(metadata.decoderText)) {
    return {
      status: 'warn',
      title: '目录选择器解码实现',
      detail: '检测到旧版手写 UTF-16 终止符扫描（bytes[end] !== 0），含「一/开」等字符的路径可能被截断。',
      rootCause: 'readUtf16 只检查每个码元的低字节是否为 0，U+4E00/U+5F00 的低字节恰为 0x00。',
      suggestion: '升级 DSH 到 ≥ 0.1.2-alpha.1；或核心层改为连续两字节均为 0 的终止符判断。',
      evidence: { ...evidence, pattern: 'manual bytes[end] scan' },
    };
  }
  return {
    status: 'skipped',
    title: '目录选择器解码实现',
    detail: '未识别的解码实现，需人工复核（不代表通过）。',
    evidence: { ...evidence, pattern: 'unknown' },
  };
}

function checkKoffi(installRoot) {
  const evidence = { installRoot };
  if (!installRoot) {
    return {
      status: 'skipped',
      title: 'Koffi 原生模块加载状态',
      detail: '未定位安装目录，原生模块检查未运行（不代表通过）。',
      suggestion: '用 --install-root 指定 DeepSeek Harness 安装目录。',
      evidence,
    };
  }
  const koffiDir = path.join(installRoot, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi');
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(koffiDir, 'package.json'), 'utf8'));
  } catch {
    manifest = null;
  }
  evidence.koffiDir = koffiDir;
  evidence.version = manifest?.version ?? null;
  if (manifest === null) {
    return {
      status: 'error',
      title: 'Koffi 原生模块加载状态',
      detail: 'app.asar.unpacked 中找不到可读的 koffi 包，目录选择器原生能力不可用。',
      rootCause: '安装不完整、杀毒软件隔离或更新中途失败。',
      suggestion: '重新安装 DeepSeek Harness，并检查安全软件是否隔离了 .node 文件。',
      evidence,
    };
  }
  if (!process.versions.electron) {
    return {
      status: 'skipped',
      title: 'Koffi 原生模块加载状态',
      detail: `koffi ${manifest.version} 已安装，但当前是纯 Node CLI，无法验证 Electron ABI 下的加载（不代表通过）。`,
      suggestion: '在 DSH 宿主内运行 doctor（或让插件启动时记录）以验证真实加载。',
      evidence,
    };
  }
  try {
    const requireFromKoffi = createRequire(path.join(koffiDir, 'package.json'));
    const module = requireFromKoffi(koffiDir);
    const loaded = typeof module?.load === 'function' || typeof module?.decode === 'function';
    if (!loaded) {
      return {
        status: 'error',
        title: 'Koffi 原生模块加载状态',
        detail: 'koffi 模块可以 require，但缺少预期的 load/decode 导出。',
        rootCause: '安装包版本不匹配或被替换。',
        suggestion: '重新安装 DeepSeek Harness。',
        evidence,
      };
    }
    return {
      status: 'pass',
      title: 'Koffi 原生模块加载状态',
      detail: `koffi ${manifest.version} 在 Electron ABI 下加载成功。`,
      evidence: { ...evidence, exports: ['load', 'decode'] },
    };
  } catch (error) {
    return {
      status: 'error',
      title: 'Koffi 原生模块加载状态',
      detail: `koffi 加载失败：${error?.message ?? String(error)}`,
      rootCause: '原生模块 ABI 不匹配、缺少 VC++ 运行库、或 .node 文件被杀毒软件隔离。',
      suggestion: '重装 Desktop；检查安全软件隔离区；确认安装目录与 Electron 版本匹配。',
      evidence: { ...evidence, error: String(error?.stack ?? error) },
    };
  }
}

function checkWorkspace(workspace) {
  const evidence = { path: workspace };
  let stat;
  try {
    stat = fs.statSync(workspace);
  } catch {
    return {
      status: 'error',
      title: '工作区权限',
      detail: `工作区不存在或不可访问：${workspace}`,
      rootCause: '路径被删除、所在盘符未挂载，或权限不足。',
      suggestion: '确认工作区路径存在且当前用户可访问；在 DSH 中重新选择目录。',
      evidence,
    };
  }
  if (!stat.isDirectory()) {
    return {
      status: 'error',
      title: '工作区权限',
      detail: `工作区路径不是目录：${workspace}`,
      rootCause: '路径指向文件或符号链接目标类型异常。',
      suggestion: '重新选择工作区目录。',
      evidence,
    };
  }
  const readable = accessCheck(workspace, fs.constants.R_OK);
  const writable = accessCheck(workspace, fs.constants.W_OK);
  evidence.readable = readable;
  evidence.writable = writable;
  evidence.note = 'Windows 上 W_OK 是近似判断，最终以实际写入为准。';
  if (readable && writable) {
    return { status: 'pass', title: '工作区权限', detail: `工作区可读可写：${workspace}`, evidence };
  }
  return {
    status: 'warn',
    title: '工作区权限',
    detail: readable ? `工作区可读但不可写：${workspace}` : `工作区不可读：${workspace}`,
    rootCause: '目录 ACL、只读属性或所在卷权限限制。',
    suggestion: '给当前用户授予修改权限，或把工作区移到用户目录下。',
    evidence,
  };
}

function checkPaths({ dshHome, installRoot, workspace }) {
  const checks = [];

  const homeNonAscii = isNonAscii(dshHome);
  checks.push({
    id: 'home-non-ascii',
    category: '路径',
    title: 'DSH_HOME 字符集',
    status: homeNonAscii ? 'warn' : 'pass',
    detail: homeNonAscii ? `DSH_HOME 含非 ASCII 字符：${dshHome}` : `DSH_HOME 为 ASCII 路径：${dshHome}`,
    ...(homeNonAscii
      ? {
          rootCause: '旧版 dsh → pnpm 转发链按 OEM(936) 解释 UTF-8 路径，可能截断或乱码。',
          suggestion: '保持 pnpm shim 含 chcp 65001，或把 DSH_HOME 迁到纯 ASCII 路径（可用 junction 桥接旧数据）。',
        }
      : {}),
    evidence: { path: dshHome },
  });

  const homeSpace = /\s/.test(dshHome);
  checks.push({
    id: 'home-space',
    category: '路径',
    title: 'DSH_HOME 空格',
    status: homeSpace ? 'warn' : 'pass',
    detail: homeSpace ? `DSH_HOME 含空格：${dshHome}` : 'DSH_HOME 不含空格。',
    ...(homeSpace
      ? {
          rootCause: '旧版转发层未给路径加引号时会在空格处截断。',
          suggestion: '修复版 shim 会带引号；也可用 mklink /J 建一个无空格 junction 指向实际目录。',
        }
      : {}),
    evidence: { path: dshHome },
  });

  if (!installRoot) {
    checks.push({
      id: 'cross-drive',
      category: '路径',
      title: '跨盘安装',
      status: 'skipped',
      detail: '未定位安装目录，无法比较 DSH_HOME 与安装目录的盘符（不代表通过）。',
      suggestion: '用 --install-root 指定安装目录后重跑。',
      evidence: { dshHome },
    });
  } else {
    const homeDrive = path.parse(dshHome).root.toLowerCase();
    const installDrive = path.parse(installRoot).root.toLowerCase();
    const mismatch = homeDrive !== installDrive;
    checks.push({
      id: 'cross-drive',
      category: '路径',
      title: '跨盘安装',
      status: mismatch ? 'warn' : 'pass',
      detail: mismatch
        ? `DSH_HOME 与安装目录不在同一盘符（${homeDrive} vs ${installDrive}）`
        : `DSH_HOME 与安装目录同盘（${homeDrive}）。`,
      ...(mismatch
        ? {
            rootCause: '跨盘插件安装可能生成坏链接，旧安装器也可能复制失败。',
            suggestion: '把插件与 DSH_HOME 统一到同一盘符，或用 junction 桥接。',
          }
        : {}),
      evidence: { dshHome, installRoot },
    });
  }

  const longPath = dshHome.length > 200;
  checks.push({
    id: 'long-path',
    category: '路径',
    title: '路径长度',
    status: longPath ? 'warn' : 'pass',
    detail: longPath ? `DSH_HOME 路径较长（${dshHome.length} 字符）` : `DSH_HOME 长度 ${dshHome.length} 字符，低于阈值。`,
    ...(longPath
      ? {
          rootCause: '接近 MAX_PATH（260）时部分旧工具会失败。',
          suggestion: '缩短目录层级，或启用 Windows 长路径支持。',
        }
      : {}),
    evidence: { length: dshHome.length, workspace },
  });

  return checks;
}

function checkShims(options, dshHome, env) {
  const { candidates } = expandCandidatePaths({ ...options, env, dshHome });
  const present = [];
  const stale = [];
  for (const candidate of candidates) {
    const state = inspectShim(candidate.path);
    if (!state.exists) continue;
    const staleTarget = staleShimTarget(candidate.path);
    present.push({
      path: candidate.path,
      source: candidate.source,
      status: state.status,
      problems: state.problems,
      ...(staleTarget === null ? {} : { staleTarget }),
    });
    if (staleTarget !== null) stale.push({ path: candidate.path, staleTarget });
  }
  const runtimesDir = path.join(dshHome, 'dsh-runtimes');

  if (present.length === 0) {
    return {
      check: {
        status: 'skipped',
        detail: `未发现 pnpm.cmd（候选 ${candidates.length} 处；dsh-runtimes ${fs.existsSync(runtimesDir) ? '存在' : '不存在'}）。当前版本可能直接调用 pnpm.cjs；插件保持监听，shim 出现后立即修复。`,
        evidence: { candidates: candidates.length, dshRuntimes: fs.existsSync(runtimesDir) },
      },
      shims: present,
    };
  }

  const broken = present.filter((item) => item.status === 'needs-repair' || item.status === 'unsupported' || item.status === 'unreadable');
  if (broken.length > 0) {
    return {
      check: {
        status: 'error',
        detail: `${broken.length} 个 pnpm shim 需要修复：${broken.map((item) => item.path).join('；')}`,
        rootCause: 'shim 以 UTF-8 写入但 cmd.exe 按 OEM(936) 解析，或缺少 chcp 65001 / 含 BOM / 行尾异常。',
        suggestion: '运行 `dsh-win-compat repair`，或重启 DSH 让插件启动扫描自动修复。',
        evidence: { shims: present },
      },
      shims: present,
    };
  }
  if (stale.length > 0) {
    return {
      check: {
        status: 'warn',
        detail: `${stale.length} 个 shim 指向不存在的可执行文件：${stale.map((item) => item.path).join('；')}`,
        rootCause: '旧安装残留或运行时目录被移动/删除。',
        suggestion: '确认 pnpm 是否仍由该 shim 提供；不再需要时删除残留 shim（插件不会删除文件）。',
        evidence: { shims: present },
      },
      shims: present,
    };
  }
  return {
    check: {
      status: 'pass',
      detail: `${present.length} 个 pnpm shim 编码正常（chcp 65001、CRLF、无 BOM）。`,
      evidence: { shims: present },
    },
    shims: present,
  };
}

function readShimStaleEntries(present) {
  return present.filter((item) => item.staleTarget !== undefined).map((item) => item.path);
}

/**
 * Run the full read-only matrix.
 *
 * @param {{dshHome?: string, installRoot?: string|null, workspace?: string,
 *          env?: NodeJS.ProcessEnv, extraShimPaths?: string[],
 *          includePath?: boolean}} [options]
 * @returns {Promise<object>} report consumed by the text/JSON/HTML renderers
 */
export async function runDiagnostics(options = {}) {
  const env = options.env ?? process.env;
  const dshHome = path.resolve(options.dshHome ?? resolveDshHome(env));
  const installRoot = options.installRoot === undefined
    ? detectInstallRoot(env)
    : (options.installRoot === '' || options.installRoot === null ? null : path.resolve(options.installRoot));
  const workspace = path.resolve(options.workspace ?? env.DSH_WORKSPACE ?? process.cwd());
  const metadata = readRuntimeMetadata(installRoot);
  const versionCheck = checkDshVersion(installRoot, metadata);
  const decoderCheck = checkDirectoryPickerDecoder(metadata);
  const koffiCheck = checkKoffi(installRoot);
  const powershellCheck = await checkPowerShell(env);
  const workspaceCheck = checkWorkspace(workspace);
  const pathChecks = checkPaths({ dshHome, installRoot, workspace });
  const shimResult = checkShims(options, dshHome, env);

  const checks = [];
  const add = (check) => {
    if (!check || typeof check !== 'object') return;
    const status = check.status;
    checks.push({
      id: check.id,
      category: check.category ?? '环境',
      title: check.title ?? check.id,
      status,
      risk: RISK_BY_STATUS[status] ?? 'skipped',
      detail: check.detail ?? '',
      ...(check.rootCause ? { rootCause: check.rootCause } : {}),
      ...(check.suggestion ? { suggestion: check.suggestion } : {}),
      ...(check.evidence ? { evidence: check.evidence } : {}),
    });
  };

  // 1. Runtime baseline
  add({
    id: 'node-version',
    category: '运行时',
    title: 'Node.js 版本合规性',
    status: parseVersion(process.versions.node ?? '') !== null && Number(process.versions.node.split('.')[0]) >= 20 ? 'pass' : 'error',
    detail: `当前 Node ${process.versions.node ?? '未知'}（插件要求 ≥ 20）。`,
    ...(Number(process.versions.node.split('.')[0]) >= 20
      ? {}
      : {
          rootCause: 'Node 版本低于插件 engines 要求与 DSH 运行时基线。',
          suggestion: '升级 Node.js 到 20+，或使用 DSH 自带运行时。',
        }),
    evidence: { node: process.versions.node ?? null, electron: process.versions.electron ?? null, required: '>=20' },
  });

  add({
    id: 'dsh-runtime-version',
    category: '版本',
    title: versionCheck.title,
    status: versionCheck.status,
    detail: versionCheck.detail,
    ...(versionCheck.rootCause ? { rootCause: versionCheck.rootCause } : {}),
    ...(versionCheck.suggestion ? { suggestion: versionCheck.suggestion } : {}),
    evidence: versionCheck.evidence,
  });

  add({
    id: 'directory-picker-decoder',
    category: '版本',
    title: decoderCheck.title,
    status: decoderCheck.status,
    detail: decoderCheck.detail,
    ...(decoderCheck.rootCause ? { rootCause: decoderCheck.rootCause } : {}),
    ...(decoderCheck.suggestion ? { suggestion: decoderCheck.suggestion } : {}),
    evidence: decoderCheck.evidence,
  });

  add({
    id: 'koffi-native',
    category: '原生模块',
    title: koffiCheck.title,
    status: koffiCheck.status,
    detail: koffiCheck.detail,
    ...(koffiCheck.rootCause ? { rootCause: koffiCheck.rootCause } : {}),
    ...(koffiCheck.suggestion ? { suggestion: koffiCheck.suggestion } : {}),
    evidence: koffiCheck.evidence,
  });

  add({
    id: 'powershell',
    category: 'Shell',
    title: 'PowerShell 可用性',
    status: powershellCheck.status,
    detail: powershellCheck.detail,
    ...(powershellCheck.rootCause ? { rootCause: powershellCheck.rootCause } : {}),
    ...(powershellCheck.suggestion ? { suggestion: powershellCheck.suggestion } : {}),
    evidence: powershellCheck.evidence,
  });

  add({
    id: 'workspace-permissions',
    category: '工作区',
    title: workspaceCheck.title,
    status: workspaceCheck.status,
    detail: workspaceCheck.detail,
    ...(workspaceCheck.rootCause ? { rootCause: workspaceCheck.rootCause } : {}),
    ...(workspaceCheck.suggestion ? { suggestion: workspaceCheck.suggestion } : {}),
    evidence: workspaceCheck.evidence,
  });

  for (const check of pathChecks) {
    add(check);
  }

  add({
    id: 'pnpm-shims',
    category: '编码',
    title: 'pnpm shim 编码与目标',
    status: shimResult.check.status,
    detail: shimResult.check.detail,
    ...(shimResult.check.rootCause ? { rootCause: shimResult.check.rootCause } : {}),
    ...(shimResult.check.suggestion ? { suggestion: shimResult.check.suggestion } : {}),
    evidence: shimResult.check.evidence,
  });

  const summary = {
    total: checks.length,
    error: checks.filter((check) => check.status === 'error').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    pass: checks.filter((check) => check.status === 'pass').length,
    skipped: checks.filter((check) => check.status === 'skipped').length,
  };
  summary.verdict = summary.error > 0 ? 'fail' : summary.warn > 0 ? 'warn' : summary.skipped > 0 ? 'partial' : 'pass';

  const ownPackage = readOwnPackage();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    plugin: { name: ownPackage?.name ?? 'dsh-win-compat', version: ownPackage?.version ?? null },
    platform: process.platform,
    host: {
      mode: process.versions.electron ? 'dsh-host' : 'cli',
      node: process.versions.node ?? null,
      electron: process.versions.electron ?? null,
      cwd: process.cwd(),
    },
    environment: {
      dshHome,
      installRoot,
      workspace,
      dshRuntimeVersion: metadata.runtimeVersion,
      desktopVersion: metadata.desktopVersion,
      support: versionCheck.support ?? classifyDshSupport(null),
    },
    summary,
    checks,
    shims: shimResult.shims,
    staleShims: readShimStaleEntries(shimResult.shims),
  };
}

/** Alias used by the CLI and tests. */
export const doctor = runDiagnostics;
