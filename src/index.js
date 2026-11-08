// Library entry point: discover memory files, index repos, classify every entry.
import fs from "node:fs";
import path from "node:path";
import { auditEntries } from "./classify.js";
import { discover, SOURCES } from "./discover.js";
import { parseMarkdown } from "./parse.js";
import { indexRepo, listFiles } from "./repo.js";

export { SOURCES };
export const NOT_AGENT_MEMORY = new Set(["repo-fact", "history", "duplicate"]);

export function summarize(entries) {
  const counts = {};
  let total = 0;
  let privateTotal = 0;
  let notAgentMemory = 0;
  let problems = 0;
  for (const e of entries) {
    if (e.verdict === "heading") continue;
    total++;
    counts[e.verdict] = (counts[e.verdict] ?? 0) + 1;
    if (["redact", "contradiction", "stale", "superseded", "conflict"].includes(e.verdict)) problems++;
    // Committed instruction files are already shared; "belongs elsewhere" only applies to private memory.
    if (e.scope !== "committed") {
      privateTotal++;
      if (NOT_AGENT_MEMORY.has(e.verdict)) notAgentMemory++;
    }
  }
  return { total, counts, problems, private_total: privateTotal, not_agent_memory: notAgentMemory };
}

export function runAudit({ root = ".", related = [], noRepo = false, agents = SOURCES, files = [], exclude = [], ignore = [], vscodeUserDirs, claudeHome } = {}) {
  const rootAbs = fs.realpathSync(path.resolve(root));
  const repos = noRepo ? [] : [indexRepo(rootAbs, ignore), ...related.map((r) => indexRepo(r, ignore))];
  const tracked = repos[0] ? [...repos[0].files] : listFiles(rootAbs);
  const memFiles = discover(rootAbs, { agents, files, exclude, tracked, vscodeUserDirs, claudeHome });

  const entries = [];
  for (const mf of memFiles) {
    const text = fs.readFileSync(mf.path, "utf8");
    for (const e of parseMarkdown(text, mf.path)) entries.push({ ...e, label: mf.label, source: mf.source, scope: mf.scope });
  }
  auditEntries(entries, repos);

  return {
    root: rootAbs,
    repos: repos.map((r) => r.name),
    files: memFiles.map((f) => ({ ...f, entries: entries.filter((e) => e.file === f.path && e.verdict !== "heading").length })),
    entries,
    summary: summarize(entries),
  };
}
