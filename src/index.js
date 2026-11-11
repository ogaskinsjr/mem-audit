// Library entry point: discover memory files, index repos, classify every entry.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { auditEntries } from "./classify.js";
import { discover, SOURCES } from "./discover.js";
import { parseMarkdown } from "./parse.js";
import { indexRepo, listFiles } from "./repo.js";

export { SOURCES };
export const NOT_AGENT_MEMORY = new Set(["repo-fact", "history", "duplicate"]);

// Git repos next to the audited one, indexed only the first time an anchor is missing.
function nearbyRepos(rootAbs, skip, ignore) {
  let cached;
  return () => {
    if (cached) return cached;
    const parent = path.dirname(rootAbs);
    let dirs = [];
    try {
      dirs = fs.readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(parent, d.name)).sort();
    } catch { /* unreadable parent */ }
    cached = dirs.filter((d) => !skip.has(d) && fs.existsSync(path.join(d, ".git"))).map((d) => indexRepo(d, ignore));
    return cached;
  };
}

export function summarize(entries) {
  const counts = {};
  let total = 0;
  let privateTotal = 0;
  let notAgentMemory = 0;
  let problems = 0;
  let restates = 0;
  let stillPresent = 0;
  for (const e of entries) {
    if (e.verdict === "heading") continue;
    total++;
    counts[e.verdict] = (counts[e.verdict] ?? 0) + 1;
    if (e.findings.some((f) => f.type === "restates")) restates++;
    if (e.findings.some((f) => f.type === "still-present")) stillPresent++;
    if (["redact", "contradiction", "stale", "superseded", "conflict"].includes(e.verdict)) problems++;
    // Committed instruction files are already shared; "belongs elsewhere" only applies to private memory.
    if (e.scope !== "committed") {
      privateTotal++;
      if (NOT_AGENT_MEMORY.has(e.verdict)) notAgentMemory++;
    }
  }
  return { total, counts, problems, private_total: privateTotal, not_agent_memory: notAgentMemory, restates, still_present: stillPresent };
}

// What the audit saw, so a reader can tell whether it's still current. Content-derived: no timestamps.
function repoState(root) {
  const git = (...a) => {
    try {
      return execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const commit = git("rev-parse", "HEAD");
  if (!commit) return { commit: null, dirty: null };
  return { commit, dirty: git("status", "--porcelain") !== "" };
}

export function runAudit({ root = ".", related = [], noRepo = false, siblings = true, agents = SOURCES, files = [], exclude = [], ignore = [], vscodeUserDirs, claudeHome } = {}) {
  const rootAbs = fs.realpathSync(path.resolve(root));
  const repos = noRepo ? [] : [indexRepo(rootAbs, ignore), ...related.map((r) => indexRepo(r, ignore))];
  const tracked = repos[0] ? [...repos[0].files] : listFiles(rootAbs);
  const memFiles = discover(rootAbs, { agents, files, exclude, tracked, vscodeUserDirs, claudeHome });

  const entries = [];
  const memHashes = {};
  for (const mf of memFiles) {
    const text = fs.readFileSync(mf.path, "utf8");
    memHashes[mf.label] = `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
    for (const e of parseMarkdown(text, mf.path)) entries.push({ ...e, label: mf.label, source: mf.source, scope: mf.scope });
  }
  const skip = new Set(repos.map((r) => r.root));
  auditEntries(entries, repos, { siblings: !noRepo && siblings ? nearbyRepos(rootAbs, skip, ignore) : undefined });

  return {
    root: rootAbs,
    repos: repos.map((r) => r.name),
    state: { ...(noRepo ? { commit: null, dirty: null } : repoState(rootAbs)), memory: memHashes },
    files: memFiles.map((f) => ({ ...f, entries: entries.filter((e) => e.file === f.path && e.verdict !== "heading").length })),
    entries,
    summary: summarize(entries),
  };
}
