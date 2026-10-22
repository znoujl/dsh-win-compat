# dsh-win-compat

**DeepSeek Harness 的 Windows 兼容守护**：零依赖、零构建。启动/运行期自动修复 pnpm shim 的代码页问题，并提供只读诊断矩阵与可归档的 HTML / JSON 体检报告。

```
启动 → 检测 → 修复 → 重启后仍生效 → Desktop 再次重建 → 监听器再次修复
                 └── doctor：11 项只读体检（高危 / 警告 / 通过 / 未运行）
```

## 它解决什么

| Windows 常见事故 | 本插件 |
|---|---|
| 生成的 `pnpm.cmd` 以 UTF-8 写入，cmd.exe 按 GBK 读取，中文路径报“系统找不到指定的路径” | 启动 3 秒后与运行期检测，注入 `chcp 65001 >nul`、去 BOM、统一 CRLF；Desktop 重启重建后再次修复 |
| 含空格 / 非 ASCII / 跨盘路径导致转发截断、坏链接 | `doctor` 逐项诊断并给出 junction / 迁移建议 |
| 旧版 DSH 的目录选择器 `readUtf16` 把「一 / 开」误判为字符串结束 | 识别安装版本与解码实现：旧版提示“适用于旧版修复”，新版提示“已由新版原生支持，本插件提供守护兜底” |
| 交付前无法证明“这台机器没问题” | `doctor --html` 生成专业体检报告，`--json` 接入 CI/CD |

## 诊断矩阵（只读）

11 项检查：Node 版本、DSH 运行时版本边界、目录选择器解码实现、Koffi 原生模块加载、PowerShell 可用性、工作区权限、DSH_HOME 字符集/空格/跨盘/长度、pnpm shim 编码与目标。逐项说明见 [docs/diagnostic-matrix.md](docs/diagnostic-matrix.md)。

四种状态严格区分：

| 状态 | 含义 |
|---|---|
| **高危** | 阻断性问题，需要处理 |
| **警告** | 风险或降级行为，建议处理 |
| **通过** | 已执行并通过 |
| **未运行** | 未执行或当前环境无法执行，**不代表通过** |

HTML 报告中“未运行”单独成节，只使用灰色标记；汇总与退出码都不会把它算作通过。汇总结论：有高危 → 需处理；否则有警告 → 有警告；否则有未运行 → 部分检查未运行；全部通过 → 通过。

### 多版本兼容判定

- `< 0.1.2-alpha.1`：**“适用于旧版修复”** —— 目录选择器/旧 pnpm 转发链仍可能需要兼容处理；
- `>= 0.1.2-alpha.1`：**“已由新版原生支持，本插件提供守护兜底”**。

判定阈值与语义在 `lib/version.js`，按 semver 预发布规则比较（`alpha.1 < alpha.2 < rc.1 < 正式版`）。

## 安装

用 Desktop 自带 CLI 装入 **desktop** profile（`web` 只是界面 profile，装到 `web` 不会进入 Desktop 应用）：

从 GitHub 安装（需要本机有 Git）：

```powershell
$cli = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $cli plugin --profile desktop add "https://github.com/znoujl/dsh-win-compat.git"
```

从本地源码安装（把 `<仓库绝对路径>` 换成实际目录）：

```powershell
& $cli plugin --profile desktop add "file:<仓库绝对路径>"
```

安装会写入 profile 的 `dependencies` 与 `dsh.profile.bundles`。Desktop 支持配置热重组，通常安装后即生效；若你的环境关闭了 HMR，**完全退出并重启 DeepSeek Harness** 后加载。

卸载：

```powershell
& $cli plugin --profile desktop remove dsh-win-compat
```

> 本地 `file:` 依赖安装的是**快照**：改完插件代码后，同版本号再次 `add` 不会刷新内容，需要先 `remove` 再 `add`（或先提升 `version`）。

> 发布到 npm 后可改用 `& $cli plugin --profile desktop add dsh-win-compat`。

## doctor 使用

`doctor` 是插件自带的 CLI，**不是** `dsh` 的子命令（`dsh doctor` 会把 doctor 当成 profile 名并报错）。用 DSH 自带 node 运行：

```powershell
$node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$doc  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-win-compat\lib\cli.js"

# DSH_HOME 不是默认目录时改用：
# $doc = "$env:DSH_HOME\profiles\desktop\node_modules\dsh-win-compat\lib\cli.js"

& $node $doc doctor                     # 终端体检
& $node $doc doctor --json              # 机器可读（CI/CD）
& $node $doc doctor --html report.html  # 专业 HTML 报告（默认 dsh-win-compat-report.html）
```

> 安装后 profile 里也会生成 `profiles/desktop/node_modules/.bin/dsh-win-compat.CMD`，可直接运行 `& ...\.bin\dsh-win-compat.CMD doctor --html report.html`。

常用参数：`--dsh-home <path>`、`--workspace <path>`、`--install-root <path|none>`、`--include-path`、`--extra-shim <path>`。

CI 用法示例：

```powershell
& $node $doc doctor --json --install-root none > doctor.json
if ($LASTEXITCODE -ne 0) { throw "Windows 兼容体检发现高危项" }
```

`doctor` 退出码：存在 **高危** 项为 `1`，否则 `0`（警告与未运行不阻断）。JSON 的 `summary` 含 `error/warn/pass/skipped/verdict`，可直接做门禁。

### 本机实测（DSH 0.2.1-rc.2）

```
结论：有警告（高危 0 / 警告 1 / 通过 9 / 未运行 1，共 11 项）

【警告】PowerShell 可用性
  详情：可用 PowerShell：powershell 5.1.26100.9168
  根因：只有 Windows PowerShell 5.1，没有 PowerShell 7（pwsh）。
【未运行】pnpm shim 编码与目标
  详情：未发现 pnpm.cmd（候选 6 处；dsh-runtimes 不存在）。
【通过】Node 24.21.0 / DSH 0.2.1-rc.2（新版原生支持 + 守护兜底）
  / 目录选择器 koffi str16 / Koffi 3.1.1 加载成功 / 工作区可读写 / 路径检查
```

## 安装即生效的守护

修复动作只发生在 `DSH_HOME` 下的 pnpm shim：

1. 识别 UTF-8 BOM、行尾、`chcp` 行；
2. 第 2 行注入 `chcp 65001 >nul`（`@echo off` 之后），错误代码页原地替换；
3. 去 BOM、统一 CRLF、保留原命令行与中文路径；
4. 首次修复前保存 `<shim>.dsh-win-compat.bak`；
5. 同目录临时文件 + 重命名原子替换（Windows 占用有界重试）；
6. **已正确时零写入**（字节与 mtime 不变）；
7. 非 UTF-8 文件不碰，只报告 `invalid-utf8`。

监听的布局（存在即修复，`dsh-runtimes` 后创建也会补挂监听）：

```
$DSH_HOME/dsh-runtimes/<runtime>/runtime-commands/bin/pnpm.cmd
$DSH_HOME/dsh-runtimes/<runtime>/bin/pnpm.cmd
$DSH_HOME/dsh-runtimes/runtime-commands/bin/pnpm.cmd
$DSH_HOME/runtime-commands/bin/pnpm.cmd
$DSH_HOME/bin/pnpm.cmd
$DSH_HOME/profiles/<profile>/node_modules/.bin/pnpm.cmd
~/.local/bin/pnpm.cmd
（可选）PATH 上的 pnpm.cmd，仅在 includePathShims=true 时
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭插件 |
| `startupDelayMs` | `3000` | 启动后延迟扫描 |
| `watch` | `true` | 运行时监听 + 轮询 |
| `pollIntervalMs` | `5000` | 轮询兜底间隔 |
| `debounceMs` | `250` | fs.watch 去抖 |
| `includePathShims` | `false` | 是否修复 PATH 上的 pnpm.cmd |
| `extraShimPaths` | `[]` | 额外 shim 路径 |
| `dryRun` | `false` | 只报告不落盘 |

## 验证

```powershell
# 闭环测试（14 项）：检测/修复/幂等/BOM/行尾 + 启动/重启/运行中重建 + 诊断矩阵 + HTML 转义
$env:ELECTRON_RUN_AS_NODE='1'
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" test/run.mjs

# 真实宿主闭环（隔离 DSH_HOME，不碰现有 profile）：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-in-real-dsh.ps1
```

最近一次真实宿主验证：安装为 bundle 后，预置坏 shim 在宿主启动时被修复；第二次启动哈希与 mtime 均未变；运行中重写坏 shim 被 watcher 再次修复；`doctor` 在宿主内报告 Koffi 加载成功、DSH 版本判定为“新版原生支持 + 守护兜底”。

## 支持版本范围

- DSH 运行时：`>= 0.1.2-alpha.1 < 0.3.0-0`（更低版本仍可做 shim 守护，但目录选择器截断需升级核心）
- Node.js：`>= 20`
- 平台：Windows（`win32`）；非 Windows 上插件不启动，`doctor` 只做只读探测

## 上架与开源

- 仓库：<https://github.com/znoujl/dsh-win-compat>（`main` 已同步）
- 市场文案：[docs/marketplace.md](docs/marketplace.md)（安装/体检命令、短描述、长描述、关键词、企业卖点）
- 清单文件（均随 `package.json#files` 发布）：
  - [`plugin.json`](plugin.json)：标准市场清单，含 `id` / `name` / `version` / `entry: index.js`；
  - [`manifest.json`](manifest.json)：Bundle 清单，含 `id` / `name` / `version` / `entry: index.js`，并用 `bundle: ./cordis.patch.yml` 保留补丁入口；
  - `package.json` 的 `dsh.bundle.patch` 指向 [`cordis.patch.yml`](cordis.patch.yml)，这是 DSH 实际加载的入口；
  - [`index.js`](index.js) 是标准 entry，re-export `lib/index.js`，两种入口指向同一插件实现。
- 打 tag / Release：

```powershell
git tag v0.2.0
git push origin v0.2.0
```

## 目录结构

```
dsh-win-compat/
├─ package.json                 # dsh.bundle.patch + dshhub 市场元数据
├─ cordis.patch.yml             # insert: win-compat 行 + 默认配置
├─ index.js                     # 标准 entry：re-export lib/index.js
├─ plugin.json                  # 市场清单：id/name/version/entry
├─ manifest.json                # Bundle 清单：id/name/version/entry + bundle patch
├─ lib/
│  ├─ index.js                  # 插件入口 name/inject/apply（ctx.effect 清理）
│  ├─ repair.js                 # shim 检测/修复/复验（只写 shim）
│  ├─ watch.js                  # fs.watch + 轮询
│  ├─ diagnostics.js            # 只读诊断矩阵（11 项，四状态）
│  ├─ report.js                 # 终端文本 + 自包含 HTML 报告
│  ├─ asar.js                   # 无依赖读取 app.asar 元数据
│  ├─ version.js                # semver 预发布比较 + 版本边界判定
│  └─ cli.js                    # status|repair|verify|doctor|watch
├─ test/run.mjs                 # 14 项闭环测试
├─ scripts/verify-in-real-dsh.ps1
└─ docs/
   ├─ diagnostic-matrix.md
   └─ marketplace.md
```

## 限制

- 不修改 `app.asar` / 核心包；`doctor` 只读，不修复、不删除。
- 不创建缺失的 pnpm shim：无法可靠推断 pnpm 位置，只修复已存在的 shim。
- 目录选择器的 UTF-16 截断属于核心层问题：请升级到 `>= 0.1.2-alpha.1`；旧版需改核心后重建，插件不会 patch 打包产物。
- `doctor` 的 PowerShell 检查会启动一次只读版本查询（`$PSVersionTable`），超时 4 秒。
- 纯 Node CLI 下无法验证 Electron ABI，`koffi-native` 会显示为“未运行”。

## License

MIT，见 [LICENSE](LICENSE)。
