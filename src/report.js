// Text and JSON renderings of an audit result. Output order is stable, secrets are always masked.
import { maskSecrets } from "./secrets.js";

const GROUPS = [
  ["Memory vs the repo", [
    ["contradiction", "memory disagrees with the code"],
    ["stale", "points at files, scripts or symbols that no longer exist"],
  ]],
  ["Memory vs itself", [
    ["superseded", "replaced by a newer entry or a later removal"],
    ["conflict", "entries disagree and nothing settles which is right"],
    ["duplicate", "repeated elsewhere in memory"],
  ]],
  ["Secrets", [
    ["redact", "credential-shaped values; remove them from memory"],
  ]],
  ["Doesn't need to be agent memory", [
    ["repo-fact", "the repo already says this; read it there, or keep it in shared, verified context"],
    ["history", "changelog notes; git history already has them"],
  ]],
  ["Belongs in agent memory", [
    ["keep-local", "personal or machine-specific"],
  ]],
  ["Unclassified", [
    ["review", "no repo anchors or local signals; review by hand"],
  ]],
];
const ALWAYS_LIST = new Set(["contradiction", "stale", "superseded", "conflict", "duplicate", "redact"]);

function snippet(e) {
  const t = maskSecrets(e.text, e.secrets).replace(/\s+/g, " ").trim();
  return t.length > 140 ? `${t.slice(0, 137)}...` : t;
}

export function renderText(result, { verbose = false, hint = true, version = "", outPath = null } = {}) {
  const L = [];
  const { summary } = result;
  const live = result.entries.filter((e) => e.verdict !== "heading" || e.findings.length);
  const related = result.repos.slice(1);

  L.push(`mem-audit ${version}`.trim());
  L.push(result.repos.length
    ? `Repo: ${result.repos[0]}${related.length ? ` (+ related: ${related.join(", ")})` : ""}`
    : "Repo checks: off (--no-repo)");
  L.push("");
  if (!result.files.length) {
    L.push("No memory files found. Pass --file <path> or check --agent / --vscode-user-dir / --claude-home.");
    return L.join("\n");
  }
  L.push(`Memory files (${result.files.length}):`);
  const w = Math.max(...result.files.map((f) => f.label.length));
  for (const f of result.files) L.push(`  ${f.label.padEnd(w)}  ${String(f.entries).padStart(4)} entries`);

  for (const [title, verdicts] of GROUPS) {
    const blocks = [];
    for (const [v, desc] of verdicts) {
      const hits = live.filter((e) => e.verdict === v || (v === "duplicate" && e.verdict !== v && e.findings.some((f) => f.type === "duplicate")));
      if (!hits.length) continue;
      blocks.push("");
      blocks.push(`${v.toUpperCase()} (${hits.length}) — ${desc}`);
      const shown = verbose || ALWAYS_LIST.has(v) ? hits : hits.slice(0, 3);
      for (const e of shown) {
        blocks.push(`  ${e.label}:${e.line}`);
        const fs = v === "duplicate" ? e.findings.filter((f) => f.type === "duplicate") : e.findings;
        for (const f of fs) blocks.push(`    - ${maskSecrets(f.message, e.secrets)}`);
        blocks.push(`    > ${snippet(e)}`);
      }
      if (shown.length < hits.length) blocks.push(`  … ${hits.length - shown.length} more (--verbose to list all)`);
    }
    if (!blocks.length) continue;
    L.push("");
    L.push(`== ${title} ==`);
    L.push(...blocks);
  }

  L.push("");
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  L.push(`Summary: ${summary.total} entries, ${summary.problems} wrong or outdated (${pct(summary.problems, summary.total)}%).`);
  if (summary.private_total) {
    L.push(`${summary.not_agent_memory} of ${summary.private_total} private memory entries (${pct(summary.not_agent_memory, summary.private_total)}%) don't need to be agent memory.`);
  }
  if (outPath) L.push(`JSON audit: ${outPath}`);
  if (hint && summary.not_agent_memory) {
    L.push("");
    L.push("Tip: repo facts don't need to live in each agent's private memory. DocuSOR hosts them as shared context that's re-verified against the repo: https://docusor.ai");
  }
  return L.join("\n");
}

export function renderJson(result, { version = "" } = {}) {
  return JSON.stringify({
    tool: "mem-audit",
    version,
    root: result.root,
    repos: result.repos,
    files: result.files.map(({ label, path, source, scope, entries }) => ({ label, path, source, scope, entries })),
    summary: result.summary,
    entries: result.entries
      .filter((e) => e.verdict !== "heading" || e.findings.length)
      .map((e) => ({
        label: e.label,
        line: e.line,
        kind: e.kind,
        scope: e.scope,
        section: e.section,
        verdict: e.verdict,
        findings: e.findings.map((f) => ({ ...f, message: maskSecrets(f.message, e.secrets) })),
        anchors: e.anchors.map(({ kind, value, status, repo }) => ({ kind, value: maskSecrets(value, e.secrets), status, ...(repo ? { repo } : {}) })),
        text: maskSecrets(e.text, e.secrets),
      })),
  }, null, 2);
}
