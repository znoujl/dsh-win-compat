/**
 * dsh-win-compat / report renderers.
 *
 * One report model, three outputs: terminal text, machine JSON (handled by the
 * CLI via JSON.stringify) and a self-contained HTML "health check" document
 * with no external assets. The four states are visually distinct and a
 * `skipped` check can never appear in the green pass section.
 */
import { STATUS_LABELS, VERDICT_LABELS } from './diagnostics.js';

const STATUS_ORDER = ['error', 'warn', 'skipped', 'pass'];

const STATUS_HELP = {
  error: '阻断性问题，需要处理后再继续。',
  warn: '有风险或降级行为，建议处理。',
  skipped: '未执行或当前环境无法执行；不代表通过。',
  pass: '已执行并通过。',
};

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function formatTime(iso) {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso ?? '');
    return date.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(iso ?? '');
  }
}

function supportLabel(report) {
  const state = report.environment?.support?.state;
  if (state === 'native') return '新版原生支持';
  if (state === 'legacy') return '旧版兼容修复';
  return '版本未知';
}

/** Terminal rendering used by `doctor` without --json/--html. */
export function renderTextReport(report) {
  const lines = [];
  lines.push('DSH Windows 兼容体检（只读诊断）');
  lines.push(`生成时间 ${formatTime(report.generatedAt)} · 宿主 ${report.host.mode} · 插件 ${report.plugin.name}@${report.plugin.version}`);
  lines.push(`DSH_HOME ${report.environment.dshHome}`);
  lines.push(`安装目录 ${report.environment.installRoot ?? '(未定位)'} · DSH 运行时 ${report.environment.dshRuntimeVersion ?? '(未知)'} · ${supportLabel(report)}`);
  lines.push(`工作区 ${report.environment.workspace}`);
  lines.push('');
  const { summary } = report;
  lines.push(
    `结论：${VERDICT_LABELS[summary.verdict] ?? summary.verdict}` +
      `（高危 ${summary.error} / 警告 ${summary.warn} / 通过 ${summary.pass} / 未运行 ${summary.skipped}，共 ${summary.total} 项）`,
  );

  for (const status of STATUS_ORDER) {
    const group = report.checks.filter((check) => check.status === status);
    if (group.length === 0) continue;
    lines.push('');
    lines.push(`【${STATUS_LABELS[status]}】${group.length} 项 — ${STATUS_HELP[status]}`);
    for (const check of group) {
      lines.push(`  - ${check.title} (${check.id} · ${check.category})`);
      if (check.detail) lines.push(`    详情：${check.detail}`);
      if (check.rootCause) lines.push(`    根因：${check.rootCause}`);
      if (check.suggestion) lines.push(`    建议：${check.suggestion}`);
    }
  }
  lines.push('');
  lines.push('说明：本报告为只读诊断，不修改任何文件。未运行项不会计为通过。');
  return lines.join('\n');
}

/** Self-contained HTML health-check report. */
export function renderHtmlReport(report) {
  const { summary, environment, host, plugin } = report;
  const verdict = VERDICT_LABELS[summary.verdict] ?? summary.verdict;
  const verdictClass = `verdict-${summary.verdict}`;

  const summaryCards = STATUS_ORDER.map(
    (status) => `<div class="metric metric-${status}">
      <div class="metric-value">${summary[status]}</div>
      <div class="metric-label">${STATUS_LABELS[status]}</div>
      <div class="metric-help">${STATUS_HELP[status]}</div>
    </div>`,
  ).join('');

  const sections = STATUS_ORDER.map((status) => {
    const group = report.checks.filter((check) => check.status === status);
    if (group.length === 0) return '';
    const note = status === 'skipped'
      ? '<p class="section-note">以下检查项未执行或无法在当前环境执行，<strong>不代表通过</strong>。</p>'
      : `<p class="section-note">${STATUS_HELP[status]}</p>`;
    const cards = group.map((check) => renderCheck(check)).join('\n');
    return `<section class="check-section" id="section-${status}">
      <div class="section-head">
        <h2><span class="badge badge-${status}">${STATUS_LABELS[status]}</span> ${escapeHtml(sectionTitle(status))}</h2>
        <span class="section-count">${group.length} 项</span>
      </div>
      ${note}
      <div class="check-list">${cards}</div>
    </section>`;
  }).join('\n');

  const support = environment.support ?? {};
  const supportClass = support.state === 'native' ? 'support-native' : support.state === 'legacy' ? 'support-legacy' : 'support-unknown';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Windows 兼容体检报告 · ${escapeHtml(plugin.name)}</title>
<style>
  :root {
    --bg: #f4f6f8; --panel: #ffffff; --ink: #101828; --muted: #475467; --line: #e4e7ec;
    --error: #b42318; --error-bg: #fef3f2; --warn: #b54708; --warn-bg: #fffaeb;
    --pass: #067647; --pass-bg: #ecfdf3; --skip: #475467; --skip-bg: #f2f4f7;
    --brand: #0b1f3a; --accent: #175cd3;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.6 "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; }
  .page { max-width: 1120px; margin: 0 auto; padding: 28px 20px 56px; }
  header.hero { background: linear-gradient(135deg, #0b1f3a 0%, #12335c 100%); color: #fff;
    border-radius: 16px; padding: 28px 32px; box-shadow: 0 12px 32px rgba(11,31,58,.18); }
  .kicker { letter-spacing: .18em; text-transform: uppercase; font-size: 11px; opacity: .72; }
  h1 { margin: 6px 0 8px; font-size: 28px; line-height: 1.25; font-weight: 650; }
  .hero-meta { display: flex; flex-wrap: wrap; gap: 8px 22px; color: rgba(255,255,255,.78); font-size: 13px; }
  .verdict { display: inline-flex; align-items: center; gap: 8px; margin-top: 18px;
    padding: 8px 14px; border-radius: 999px; font-weight: 600; font-size: 14px; }
  .verdict-fail { background: rgba(240,68,56,.18); border: 1px solid rgba(240,68,56,.55); }
  .verdict-warn { background: rgba(247,144,9,.16); border: 1px solid rgba(247,144,9,.55); }
  .verdict-partial { background: rgba(152,162,179,.16); border: 1px solid rgba(152,162,179,.5); }
  .verdict-pass { background: rgba(18,183,106,.16); border: 1px solid rgba(18,183,106,.5); }
  .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin: 22px 0; }
  .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .metric-value { font-size: 30px; font-weight: 700; line-height: 1.1; }
  .metric-label { font-weight: 600; margin-top: 2px; }
  .metric-help { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .metric-error .metric-value { color: var(--error); }
  .metric-warn .metric-value { color: var(--warn); }
  .metric-pass .metric-value { color: var(--pass); }
  .metric-skipped .metric-value { color: var(--skip); }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 20px 22px; margin-bottom: 20px; }
  .panel h2 { font-size: 15px; margin: 0 0 14px; letter-spacing: .02em; color: var(--muted); text-transform: uppercase; }
  .env-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 24px; }
  .env-item { min-width: 0; }
  .env-key { color: var(--muted); font-size: 12px; }
  .env-value { font-family: "Cascadia Code", Consolas, monospace; font-size: 12.5px; word-break: break-all; }
  .support { border-radius: 12px; padding: 14px 18px; margin: 18px 0 4px; font-size: 13.5px; }
  .support-native { background: var(--pass-bg); color: #05603a; border: 1px solid #abefc6; }
  .support-legacy { background: var(--warn-bg); color: #93370d; border: 1px solid #fedf89; }
  .support-unknown { background: var(--skip-bg); color: #344054; border: 1px solid #d0d5dd; }
  .check-section { margin-top: 26px; }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .section-head h2 { font-size: 18px; margin: 0; }
  .section-count { color: var(--muted); font-size: 13px; }
  .section-note { color: var(--muted); font-size: 12.5px; margin: 6px 0 12px; }
  .check-list { display: grid; gap: 12px; }
  .check { background: var(--panel); border: 1px solid var(--line); border-left-width: 4px; border-radius: 12px; padding: 16px 18px; }
  .check-error { border-left-color: var(--error); }
  .check-warn { border-left-color: var(--warn); }
  .check-pass { border-left-color: var(--pass); }
  .check-skipped { border-left-color: #98a2b3; background: #fcfcfd; }
  .check-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .check-title { font-weight: 650; font-size: 15px; }
  .check-meta { color: var(--muted); font-size: 12px; margin-left: auto; font-family: Consolas, monospace; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge-error { background: var(--error-bg); color: var(--error); }
  .badge-warn { background: var(--warn-bg); color: var(--warn); }
  .badge-pass { background: var(--pass-bg); color: var(--pass); }
  .badge-skipped { background: var(--skip-bg); color: var(--skip); }
  .check-detail { margin-top: 10px; color: #1d2939; }
  .field { display: grid; grid-template-columns: 76px 1fr; gap: 10px; margin-top: 8px; font-size: 13px; }
  .field-key { color: var(--muted); }
  .field-value { min-width: 0; }
  details { margin-top: 10px; }
  summary { cursor: pointer; color: var(--accent); font-size: 12.5px; }
  pre { margin: 8px 0 0; padding: 12px; background: #101828; color: #d0d5dd; border-radius: 8px;
    overflow: auto; font: 12px/1.5 Consolas, monospace; max-height: 320px; }
  footer { margin-top: 30px; color: var(--muted); font-size: 12px; text-align: center; }
  @media (max-width: 760px) {
    .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .env-grid { grid-template-columns: 1fr; }
    .check-meta { margin-left: 0; }
  }
  @media print {
    body { background: #fff; }
    .page { max-width: none; padding: 0; }
    header.hero { box-shadow: none; }
    .check { break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="hero">
    <div class="kicker">DeepSeek Harness · Windows Compatibility Guardian</div>
    <h1>Windows 兼容体检报告</h1>
    <div class="hero-meta">
      <span>生成时间 ${escapeHtml(formatTime(report.generatedAt))}</span>
      <span>插件 ${escapeHtml(plugin.name)}@${escapeHtml(plugin.version)}</span>
      <span>宿主 ${escapeHtml(host.mode)} · Node ${escapeHtml(host.node)}${host.electron ? ` · Electron ${escapeHtml(host.electron)}` : ''}</span>
    </div>
    <div class="verdict ${verdictClass}">结论：${escapeHtml(verdict)}（高危 ${summary.error} / 警告 ${summary.warn} / 通过 ${summary.pass} / 未运行 ${summary.skipped}）</div>
  </header>

  <div class="metrics">${summaryCards}</div>

  <div class="panel">
    <h2>环境与版本</h2>
    <div class="env-grid">
      <div class="env-item"><div class="env-key">DSH_HOME</div><div class="env-value">${escapeHtml(environment.dshHome)}</div></div>
      <div class="env-item"><div class="env-key">安装目录</div><div class="env-value">${escapeHtml(environment.installRoot ?? '(未定位)')}</div></div>
      <div class="env-item"><div class="env-key">工作区</div><div class="env-value">${escapeHtml(environment.workspace)}</div></div>
      <div class="env-item"><div class="env-key">DSH 运行时</div><div class="env-value">${escapeHtml(environment.dshRuntimeVersion ?? '(未知)')}</div></div>
      <div class="env-item"><div class="env-key">桌面版本</div><div class="env-value">${escapeHtml(environment.desktopVersion ?? '(未知)')}</div></div>
      <div class="env-item"><div class="env-key">兼容性判定</div><div class="env-value">${escapeHtml(supportLabel(report))}（阈值 ${escapeHtml(support.threshold ?? '0.1.2-alpha.1')}）</div></div>
    </div>
    <div class="support ${supportClass}">${escapeHtml(support.message ?? '版本兼容性检查未运行。')}</div>
  </div>

  ${sections}

  <footer>
    本报告为只读诊断，未修改任何文件。未运行项不会计为通过。<br>
    ${escapeHtml(plugin.name)}@${escapeHtml(plugin.version)} · schema v${escapeHtml(report.schemaVersion)} · ${escapeHtml(report.platform)}
  </footer>
</div>
</body>
</html>`;
}

function sectionTitle(status) {
  if (status === 'error') return '高危问题';
  if (status === 'warn') return '风险项';
  if (status === 'skipped') return '未执行项';
  return '通过项';
}

function renderCheck(check) {
  const evidence = check.evidence === undefined
    ? ''
    : `<details><summary>证据 / Evidence</summary><pre>${escapeHtml(JSON.stringify(check.evidence, null, 2))}</pre></details>`;
  return `<article class="check check-${check.status}" data-check-id="${escapeHtml(check.id)}" data-status="${escapeHtml(check.status)}">
    <div class="check-head">
      <span class="badge badge-${check.status}">${STATUS_LABELS[check.status]}</span>
      <span class="check-title">${escapeHtml(check.title)}</span>
      <span class="check-meta">${escapeHtml(check.id)} · ${escapeHtml(check.category)}</span>
    </div>
    <div class="check-detail">${escapeHtml(check.detail)}</div>
    ${check.rootCause ? `<div class="field"><div class="field-key">根因</div><div class="field-value">${escapeHtml(check.rootCause)}</div></div>` : ''}
    ${check.suggestion ? `<div class="field"><div class="field-key">修复建议</div><div class="field-value">${escapeHtml(check.suggestion)}</div></div>` : ''}
    ${evidence}
  </article>`;
}
