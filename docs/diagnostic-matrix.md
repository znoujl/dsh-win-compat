# 诊断矩阵（只读）

`dsh-win-compat` v0.2.0 · 共 11 项。`doctor` 只读取文件、版本与 ACL 访问位，不写盘、不修复、不删除。
无法执行的检查一律记为 `skipped`（未运行），**永远不会**计入 `pass`。

| # | ID | 检查项 | 可能的结论 | 典型根因 / 修复建议 |
|---|---|---|---|---|
| 1 | `node-version` | Node.js 版本合规性 | 通过 / 高危 | 低于 20：升级 Node 或使用 DSH 自带运行时 |
| 2 | `dsh-runtime-version` | DSH 运行时版本边界 | 通过 / 警告 / 未运行 | < `0.1.2-alpha.1`：提示“适用于旧版修复”；≥ 该版本：“已由新版原生支持，本插件提供守护兜底”；读不到 asar：未运行 |
| 3 | `directory-picker-decoder` | 目录选择器解码实现 | 通过 / 警告 / 未运行 | 含 `koffi str16` 为已修复；检测到手写 `bytes[end]` 扫描则警告（旧版截断 bug）；无法读取 worker.cjs 则未运行 |
| 4 | `koffi-native` | Koffi 原生模块加载状态 | 通过 / 高危 / 未运行 | 在 DSH 宿主内实际 `require(koffi)` 验证；纯 Node CLI 无法验证 Electron ABI，记为未运行；缺包/加载失败为高危（重装、查杀软隔离） |
| 5 | `powershell` | PowerShell 可用性 | 通过 / 警告 / 高危 | 有 pwsh 7 通过；仅 5.1 警告；都没有为高危 |
| 6 | `workspace-permissions` | 工作区权限 | 通过 / 警告 / 高危 | 不存在/非目录为高危；只读为警告（Windows 的 W_OK 为近似判断） |
| 7 | `home-non-ascii` | DSH_HOME 字符集 | 通过 / 警告 | 非 ASCII 路径在 OEM(936) 下可能乱码/截断；保持 chcp 补丁或迁移路径 |
| 8 | `home-space` | DSH_HOME 空格 | 通过 / 警告 | 旧转发层未加引号会截断；用 junction 或无空格路径 |
| 9 | `cross-drive` | 跨盘安装 | 通过 / 警告 / 未运行 | DSH_HOME 与安装目录不同盘符；未定位安装目录则未运行 |
| 10 | `long-path` | 路径长度 | 通过 / 警告 | DSH_HOME > 200 字符时提示 MAX_PATH 风险 |
| 11 | `pnpm-shims` | pnpm shim 编码与目标 | 通过 / 警告 / 高危 / 未运行 | 缺 `chcp 65001`/BOM/LF 为高危；指向已删除可执行为警告；未发现 shim 为未运行（当前版本默认不生成） |

## 状态语义

| 状态 | 标签 | 含义 | HTML 颜色 |
|---|---|---|---|
| `error` | 高危 | 阻断性问题，需要处理 | 红 |
| `warn` | 警告 | 风险或降级行为 | 橙 |
| `pass` | 通过 | 已执行并通过 | 绿 |
| `skipped` | 未运行 | 未执行或当前环境无法执行，**不代表通过** | 灰 |

汇总结论：存在 `error` → 需处理；否则存在 `warn` → 有警告；否则存在 `skipped` → 部分检查未运行；全部通过 → 通过。

## 输出

- 终端文本：默认 `doctor`
- JSON：`doctor --json`（`schemaVersion: 1`，含 `summary`、`checks`、`environment`、`shims`）
- HTML：`doctor --html [file]`，内置模板、无外部资源，可打印/归档

## 运行环境差异

- 在 **DSH 宿主** 内运行：`koffi-native` 会真实加载原生模块；`host.mode = dsh-host`。
- 在 **纯 Node CLI** 运行：`koffi-native` 无法验证 Electron ABI，记为未运行；其余检查照常执行。
- 读不到 `app.asar` 时：DSH 版本与目录选择器解码检查记为未运行，可用 `--install-root` 指定安装目录后重跑。
