// Text and JSON renderings of an audit result. Output order is stable, secrets are always masked.
import { maskSecrets } from "./secrets.js";

const SITE = "https://docusor.ai";
// One source for the text report, the per-verdict files and the README.
export const VERDICT_INFO = {
  contradiction: { meaning: "memory disagrees with the code", action: "Fix the note to match the code (the finding says what the code has), or delete it." },
  stale: { meaning: "points at files, scripts, symbols or values that aren't in this repo", action: "Delete the note, or update it to what the repo has now." },
  misplaced: { meaning: "about a repo next to this one, not this one", action: "Move the note to the memory of the repo named in the finding." },
  superseded: { meaning: "replaced, removed, settled or taken back by a later entry", action: "Delete the note, or update it to match the entry `ref` points at." },
  conflict: { meaning: "entries disagree and nothing settles which is right", action: "Decide which entry is right and delete the other; `ref` points at it." },
  narrowed: { meaning: "replaced only for some cases by a later, scoped entry; still applies otherwise", action: "Keep the note, but note that it no longer covers the scope named in the finding." },
  duplicate: { meaning: "repeated elsewhere in memory", action: "Keep one copy; delete this one." },
  restates: { meaning: "looks like the same fact as another entry, in different words", action: "Compare the two entries; if they say the same thing, keep it in one place." },
  "still-present": { meaning: "says something is gone that the code still has", action: "Look at the place named in the finding: if the thing is still in use, correct the note; if it is a leftover, the note stands." },
  redact: { meaning: "credential-shaped values; remove them from memory", action: "Remove the credential from the note now." },
  "repo-fact": { meaning: "names things the repo has, so the repo is the better source; the statement itself isn't verified", action: "Optional: delete it and read the repo instead. If you keep it, don't treat it as verified." },
  history: { meaning: "records a past event: a removal git history has, a one-time check, or a status line", action: "Optional: delete it. Don't rely on it for how the repo is now; the reason says where the record is or what to re-check." },
  "keep-local": { meaning: "personal or machine-specific", action: "Nothing to do; this is what agent memory is for." },
  guidance: { meaning: "a rule or reason about the repo that the code can't show", action: "Nothing to do; this is what agent memory is for." },
  review: { meaning: "no repo anchors or local signals; review by hand", action: "Read it and decide by hand." },
};
// [title, verdicts, tip shown under the section when it has entries]
const GROUPS = [
  ["Memory vs the repo", ["contradiction", "stale", "still-present"], `DocuSOR re-checks context against the repo on every change, so it doesn't go stale: ${SITE}`],
  ["Belongs to another repo", ["misplaced"], `DocuSOR shares verified context across repos, so each repo can read the others': ${SITE}`],
  ["Memory vs itself", ["superseded", "conflict", "narrowed", "duplicate", "restates"], `DocuSOR keeps one verified version of each fact instead of copies that drift apart: ${SITE}`],
  ["Secrets", ["redact"]],
  ["Doesn't need to be agent memory", ["repo-fact", "history"], `repo facts don't need to live in each agent's private memory. DocuSOR hosts them as shared context that's re-verified against the repo: ${SITE}`],
  ["Belongs in agent memory", ["keep-local", "guidance"]],
  ["Unclassified", ["review"]],
];
const ALWAYS_LIST = new Set(["contradiction", "stale", "still-present", "misplaced", "superseded", "conflict", "narrowed", "duplicate", "redact"]);
// Findings that keep the entry's own verdict; each gets a file of its own.
export const FINDING_FILES = ["restates", "still-present"];
// The output folder's two subfolders; every verdict file goes in one of them.
export const OUT_FOLDERS = {
  "agent-todos": "notes with something to do; each file's `action` says what",
  "audit-ready": "notes that need no change",
};
const READY = new Set(["guidance", "keep-local"]);
const fileOf = (v) => `${READY.has(v) ? "audit-ready" : "agent-todos"}/${v}.json`;
// Findings listed on their own whatever the entry's verdict is.
const CROSS_FINDINGS = new Set(["duplicate", ...FINDING_FILES]);

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

  for (const [title, verdicts, tip] of GROUPS) {
    const blocks = [];
    for (const v of verdicts) {
      const desc = VERDICT_INFO[v].meaning;
      const hits = live.filter((e) => e.verdict === v || (CROSS_FINDINGS.has(v) && e.findings.some((f) => f.type === v)));
      if (!hits.length) continue;
      blocks.push("");
      blocks.push(`${v.toUpperCase()} (${hits.length}) — ${desc}`);
      const shown = verbose || ALWAYS_LIST.has(v) ? hits : hits.slice(0, 3);
      for (const e of shown) {
        blocks.push(`  ${e.label}:${e.line}`);
        const fs = e.findings.filter((f) => (CROSS_FINDINGS.has(v) ? f.type === v : !CROSS_FINDINGS.has(f.type)));
        for (const f of fs) blocks.push(`    - ${maskSecrets(f.message, e.secrets)}`);
        if (!fs.length && e.reason) blocks.push(`    - ${maskSecrets(e.reason, e.secrets)}`);
        blocks.push(`    > ${snippet(e)}`);
      }
      if (shown.length < hits.length) blocks.push(`  … ${hits.length - shown.length} more (--verbose to list all)`);
    }
    if (!blocks.length) continue;
    if (hint && tip) blocks.push("", `  Tip: ${tip}`);
    L.push("");
    L.push(`== ${title} ==`);
    L.push(...blocks);
  }

  L.push("");
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  L.push(`Summary: ${summary.total} entries, ${summary.problems} wrong or outdated (${pct(summary.problems, summary.total)}%).`);
  if (summary.counts.misplaced) L.push(`${summary.counts.misplaced} entries are about other repos.`);
  if (summary.restates) L.push(`${summary.restates} entries look like the same fact as another entry.`);
  if (summary.still_present) L.push(`${summary.still_present} ${summary.still_present === 1 ? "entry says" : "entries say"} something is gone that the code still has.`);
  if (summary.private_total) {
    L.push(`${summary.not_agent_memory} of ${summary.private_total} private memory entries (${pct(summary.not_agent_memory, summary.private_total)}%) don't need to be agent memory.`);
  }
  if (outPath) L.push(`Audit files: ${outPath} (summary.json, full mem-audit.json, one file per verdict in ${Object.keys(OUT_FOLDERS).map((d) => `${d}/`).join(" and ")})`);
  return L.join("\n");
}

export function renderJson(result, { version = "" } = {}) {
  return JSON.stringify({
    tool: "mem-audit",
    version,
    root: result.root,
    repos: result.repos,
    state: result.state,
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
        reason: maskSecrets(e.reason ?? "", e.secrets),
        findings: e.findings.map((f) => ({ ...f, message: maskSecrets(f.message, e.secrets) })),
        anchors: e.anchors.map(({ kind, value, status, repo }) => ({ kind, value: maskSecrets(value, e.secrets), status, ...(repo ? { repo } : {}) })),
        text: maskSecrets(e.text, e.secrets),
      })),
  }, null, 2);
}

/**
 * Everything the output folder holds, by path inside it: the full audit, a summary that indexes the
 * rest, and one small file per verdict (no anchors) for an agent to work through.
 */
export function renderOutputFiles(result, { version = "" } = {}) {
  const out = { "mem-audit.json": renderJson(result, { version }) };
  const byVerdict = {};
  for (const [v, count] of Object.entries(result.summary.counts)) {
    if (!count) continue;
    const file = fileOf(v);
    byVerdict[v] = file;
    out[file] = JSON.stringify({
      verdict: v,
      ...VERDICT_INFO[v],
      count,
      entries: result.entries
        .filter((e) => e.verdict === v)
        .map((e) => ({
          label: e.label,
          path: e.file,
          line: e.line,
          section: e.section,
          text: maskSecrets(e.text, e.secrets),
          reason: maskSecrets(e.reason ?? "", e.secrets),
          findings: e.findings.map((f) => ({ ...f, message: maskSecrets(f.message, e.secrets) })),
        })),
    }, null, 2);
  }
  const findings = {};
  for (const type of FINDING_FILES) {
    const hit = result.entries.filter((e) => e.findings.some((f) => f.type === type));
    if (!hit.length) continue;
    findings[type] = { file: fileOf(type), count: hit.length, ...VERDICT_INFO[type] };
    out[fileOf(type)] = JSON.stringify({
      finding: type,
      ...VERDICT_INFO[type],
      count: hit.length,
      entries: hit.map((e) => ({
        label: e.label,
        path: e.file,
        line: e.line,
        section: e.section,
        text: maskSecrets(e.text, e.secrets),
        verdict: e.verdict,
        findings: e.findings.filter((f) => f.type === type).map((f) => ({ ...f, message: maskSecrets(f.message, e.secrets) })),
      })),
    }, null, 2);
  }
  out["summary.json"] = JSON.stringify({
    tool: "mem-audit",
    version,
    root: result.root,
    repos: result.repos,
    // Compare to the current repo commit and memory files; a mismatch means re-run before acting.
    state: result.state,
    summary: result.summary,
    full: "mem-audit.json",
    folders: OUT_FOLDERS,
    verdicts: Object.fromEntries(Object.entries(byVerdict).map(([v, file]) => [v, { file, count: result.summary.counts[v], ...VERDICT_INFO[v] }])),
    ...(Object.keys(findings).length ? { findings } : {}),
  }, null, 2);
  return out;
}
