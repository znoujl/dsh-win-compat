# dsh-win-compat · 上架文案

## 短描述（市场卡片，≤ 120 字）

Windows 兼容守护：只读体检 + 自动修复。检测 pnpm shim 代码页、DSH 版本边界、Koffi/PowerShell/工作区/路径风险，一键导出 HTML/JSON 报告。零依赖，未运行项绝不冒充通过。

## 一句话卖点

**装一次，Windows 上的编码与路径坑不再静默失败；体检报告可直接交给 IT 和企业客户。**

## 安装（DSH Desktop）

```powershell
$cli = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $cli plugin --profile desktop add "https://github.com/znoujl/dsh-win-compat.git"
```

- profile 必须是 **`desktop`**（Desktop 应用实际运行的 profile），不是 `web`；Web 只是界面，装到 `web` 不会进入当前应用。
- 从 GitHub 安装需要本机有 Git；没有 Git 时，把仓库下载到本地后用 `& $cli plugin --profile desktop add "file:<仓库绝对路径>"`。
- 安装后通常热生效；若环境关闭了 HMR，需**完整退出并重启 DeepSeek Harness**。

## 使用（插件自带 CLI）

`doctor` **不是** `dsh` 的子命令（`dsh doctor` 会把 doctor 当成 profile 名并报错），要用安装后的插件 CLI：

```powershell
$node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$doc  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-win-compat\lib\cli.js"

& $node $doc doctor                     # 终端体检
& $node $doc doctor --json              # 结构化数据（CI/CD）
& $node $doc doctor --html report.html  # 专业 HTML 报告
```

> 如果 `DSH_HOME` 不在默认的 `%USERPROFILE%\.dsh`，把 `$doc` 换成 `$env:DSH_HOME\profiles\desktop\node_modules\dsh-win-compat\lib\cli.js`。

## 长描述（市场详情页）

DeepSeek Harness 在 Windows 上最常见的两类事故，往往都发生在“看不见”的地方：

- 选中文目录时路径被静默截断（「软件开发」变成「软件」）——这是目录选择器核心解码问题，**DSH ≥ 0.1.2-alpha.1 已原生修复**；本插件负责版本判定并在旧版上提示风险。
- 生成的 pnpm 启动脚本以 UTF-8 写入，cmd.exe 却按 GBK 读取，报“系统找不到指定的路径”——由本插件在启动和运行期自动修复。

`dsh-win-compat` 不替换核心文件，而是做两件事：

**1. 自动修复（守护）**
DSH 启动 3 秒后扫描已知的全部 pnpm shim 布局，缺 `chcp 65001` 就补、有 BOM 就去、行尾统一 CRLF、错误代码页替换；Desktop 每次重启重新生成坏 shim，监听器与轮询会再次修复。已正确时零写入，首次修复自动备份。

**2. 只读体检（诊断编排器）**
`doctor` 输出 11 项诊断矩阵：Node 版本、DSH 运行时版本边界、目录选择器解码实现、Koffi 原生模块加载、PowerShell 可用性、工作区权限、DSH_HOME 字符集/空格/跨盘/长度、pnpm shim 编码与目标。

- `doctor --json`：结构化数据，接入 CI/CD；
- `doctor --html`：内置模板的专业体检报告，区分**高危 / 警告 / 通过 / 未运行**四种状态；
- 未运行或无法执行的检查**单独归类**，永远不会被计为通过。

**版本边界自动判定**
低于 `0.1.2-alpha.1`：提示“适用于旧版修复”；达到或超过该版本：提示“已由新版原生支持，本插件提供守护兜底”。

**企业价值**
一份可归档的 HTML 报告：每项都带风险等级、根因说明与修复建议，适合在交付前做环境验收，也方便 IT 统一排查终端问题。

## 搜索关键词

Windows、兼容修复、编码、chcp、pnpm、路径、诊断、体检报告、Koffi、PowerShell、企业交付

## 适用人群

- 在中文用户目录（如 `D:\软件\...`）下使用 DSH 的 Windows 用户；
- 需要把 DSH 交付给客户、先做环境体检的团队；
- 维护旧版 DSH 兼容层的开发者。

## 兼容与许可

- DSH 运行时：`>=0.1.2-alpha.1 <0.3.0-0`（更低版本仍可做 shim 守护，但目录选择器问题需升级核心）
- Node.js：`>=20`
- 许可：MIT
- 只读诊断：`doctor` 不修改任何文件；修复仅作用于 `DSH_HOME` 下的 pnpm shim，并保留一次性备份。
