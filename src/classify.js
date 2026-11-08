// Resolves each entry's anchors against the indexed repos and assigns one verdict.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXT_RE, extractAnchors } from "./anchors.js";
import { addFinding, checkConsistency, PROBLEM_TYPES, removalAnchors } from "./consistency.js";
import { hasWord } from "./repo.js";
import { findSecrets } from "./secrets.js";

export const VERDICTS = [
  "redact", "contradiction", "stale", "superseded", "conflict", "keep-local", "repo-fact", "duplicate", "history", "review",
];
export const PROBLEM_VERDICTS = new Set(["redact", "contradiction", "stale", "superseded", "conflict"]);

const PREF_RE = /\b(?:user (?:prefers|wants|asked|likes|said|requested)|i prefer|my preference|always ask|never ask|ask (?:the user|me) (?:before|first))\b/i;
const OS_RE = /\b(?:zsh|bash|fish|powershell|homebrew|brew|macos|linux|windows|terminal|dotfiles|keychain)\b|\$PATH\b/gi;
const HIST_RE = /\b20\d\d-\d\d-\d\d\b|\b(?:TODO|WIP|FIXME|BUILT|FIXED|DONE|ADDED|SHIPPED|PENDING|NEXT)\b|\b(?:[Ii]n progress|[Nn]ext steps?|not (?:yet )?(?:done|built)|[Ff]ollow-?up)\b/;

const UNKNOWN = { status: "unknown" };
const EXTERNAL = { status: "external" };
const resolved = (r) => ({ status: "resolved", repo: r?.name });
const missing = (r) => ({ status: "missing", repo: r?.name });

function resolvePath(p, repos) {
  if (!repos.length || /[<>*{}$]|\.\.\./.test(p)) return UNKNOWN;
  const s = p.replace(/^(?:\.\.\/)+/, "").replace(/^\.\//, "").replace(/\/$/, "");
  if (!s) return UNKNOWN;
  const segs = s.split("/");

  if (segs.length > 1) {
    const owner = repos.find((r) => r.name === segs[0]);
    if (owner) {
      const rel = segs.slice(1).join("/");
      if (owner.files.has(rel) || owner.dirs.has(rel)) return resolved(owner);
      return segs.length === 2 || owner.topDirs.has(segs[1]) ? missing(owner) : EXTERNAL;
    }
  }
  for (const r of repos) if (r.files.has(s) || r.dirs.has(s)) return resolved(r);
  // Gitignored files (.env, local config) exist on disk but not in the file list.
  for (const r of repos) if (fs.existsSync(path.join(r.root, s))) return resolved(r);
  if (segs.length === 1) {
    for (const r of repos) if (r.basenames.has(s)) return resolved(r);
    // Files the code creates at runtime (overrides, reports) are named in the code, not committed.
    for (const r of repos) if (r.code.includes(s)) return resolved(r);
    return EXT_RE.test(s) ? missing() : UNKNOWN;
  }
  // Memory often drops leading dirs ("orchestrator/queue.ts" for "src/orchestrator/queue.ts").
  const tail = `/${s}`;
  for (const r of repos) {
    for (const f of r.files) if (f.endsWith(tail)) return resolved(r);
    for (const d of r.dirs) if (d.endsWith(tail)) return resolved(r);
  }
  // Only call it stale when the path's top-level dir exists, so another project's paths stay "external".
  const owners = repos.filter((r) => r.topDirs.has(segs[0]));
  if (owners.length) return missing(owners.length === 1 ? owners[0] : null);
  return EXTERNAL;
}

function routePrefix(route) {
  const segs = route.split("/").filter(Boolean);
  const stat = [];
  for (const s of segs) {
    if (/^[:{<*]/.test(s)) break;
    stat.push(s);
  }
  return stat.length >= 2 ? `/${stat.join("/")}` : null;
}

export function makeResolver(repos) {
  const cache = new Map();
  const home = os.homedir();
  const run = (a) => {
    switch (a.kind) {
      case "path": return resolvePath(a.value, repos);
      case "local-path": {
        if (/[<>*{}$]|\.\.\./.test(a.value)) return { ...UNKNOWN, local: true };
        const p = a.value === "~" || a.value.startsWith("~/") ? path.join(home, a.value.slice(2)) : a.value;
        const owner = repos.find((r) => p === r.root || p.startsWith(r.root + path.sep));
        if (owner) return p === owner.root ? resolved(owner) : resolvePath(path.relative(owner.root, p).split(path.sep).join("/"), [owner]);
        return { status: fs.existsSync(p) ? "resolved" : "missing", local: true };
      }
      case "script":
        if (!repos.length) return UNKNOWN;
        for (const r of repos) if (r.scripts.has(a.value)) return resolved(r);
        return repos.some((r) => r.hasPackageJson) ? missing() : UNKNOWN;
      case "symbol":
        if (!repos.length) return UNKNOWN;
        for (const r of repos) if (hasWord(r.code, a.value)) return resolved(r);
        return missing();
      case "identifier":
        for (const r of repos) if (hasWord(r.code, a.value)) return resolved(r);
        return UNKNOWN;
      case "env":
      case "flag":
      case "token":
        for (const r of repos) if (hasWord(r.all, a.value)) return resolved(r);
        return UNKNOWN;
      case "route": {
        const prefix = routePrefix(a.value);
        if (!prefix) return UNKNOWN;
        for (const r of repos) if (r.all.includes(prefix)) return resolved(r);
        return UNKNOWN;
      }
      default:
        return UNKNOWN;
    }
  };
  return (a) => {
    const k = `${a.kind}\u0000${a.value}`;
    if (!cache.has(k)) cache.set(k, run(a));
    return cache.get(k);
  };
}

function staleMessage(a) {
  const where = a.repo ? ` in ${a.repo}` : "";
  switch (a.kind) {
    case "local-path": return `local path \`${a.value}\` no longer exists`;
    case "script": return `npm script \`${a.value}\` isn't in any package.json`;
    case "symbol": return `\`${a.value}\` isn't in the code anymore`;
    default: return `\`${a.value}\` no longer exists${where}`;
  }
}

function decide(e) {
  const types = new Set(e.findings.map((f) => f.type));
  if (types.has("secret")) return "redact";
  for (const t of ["contradiction", "stale", "superseded", "conflict"]) if (types.has(t)) return t;

  const personalPath = e.anchors.some((a) => a.kind === "local-path" && a.local);
  if (personalPath || PREF_RE.test(e.text)) return "keep-local";
  const repoEvidence = e.anchors.some((a) => a.status === "resolved" && !a.local);
  if (e.sectionLocal && !repoEvidence) return "keep-local";
  // An entry recording what was removed is a changelog line, even if it names live code.
  if (e.anchors.some((a) => a.status === "removed")) return "history";
  if (repoEvidence || e.headingRepo) return "repo-fact";
  const osHits = new Set((e.text.match(OS_RE) ?? []).map((s) => s.toLowerCase()));
  if (e.scope === "user" || osHits.size >= 2) return "keep-local";
  if (types.has("duplicate")) return "duplicate";
  if (HIST_RE.test(e.text)) return "history";
  return "review";
}

/**
 * @param {Array} entries parsed entries; each must carry label + scope of its file
 * @param {Array} repos   indexRepo() results (target first); [] = memory-only checks
 */
export function auditEntries(entries, repos) {
  const resolve = makeResolver(repos);
  const sectionLocal = new Map();
  const headingRepo = new Map();
  for (const e of entries) {
    e.anchors = extractAnchors(e.text).map((a) => ({ ...a, ...resolve(a) }));

    const key = `${e.file}\u0000${e.section.join("\u0000")}`;
    if (!sectionLocal.has(key)) sectionLocal.set(key, e.section.some((h) => extractAnchors(h).some((a) => a.kind === "local-path")));
    e.sectionLocal = sectionLocal.get(key);
    if (e.kind === "heading") {
      headingRepo.set(`${e.file}\u0000${[...e.section, e.text].join("\u0000")}`, e.anchors.some((a) => a.status === "resolved" && !a.local));
    }
    // Field lines like "- **Auth**: per-engineer key" document whatever their heading names.
    e.headingRepo = e.kind !== "heading" && headingRepo.get(key) === true;
    // Anything unresolved next to (or under a heading with) a personal path belongs to that local project.
    if (e.sectionLocal || e.anchors.some((a) => a.kind === "local-path" && a.local)) {
      for (const a of e.anchors) {
        if (a.status === "missing" && !a.local && (a.kind === "symbol" || (a.kind === "path" && !a.value.includes("/")))) a.status = "external";
      }
    }
    // User-level memory spans every repo, so "not in this repo" says nothing about it.
    if (e.scope === "user") for (const a of e.anchors) if (a.status === "missing" && !a.local) a.status = "external";
    // Saying "we deleted X" is accurate history, not a stale reference to X.
    const removed = new Set(removalAnchors(e.text).map((a) => a.value));
    for (const a of e.anchors) if (a.status === "missing" && removed.has(a.value)) a.status = "removed";

    e.findings = [];
    e.secrets = findSecrets(e.text);
    for (const s of e.secrets) addFinding(e, { type: "secret", message: `possible ${s.kind}: ${s.masked}` });
    for (const a of e.anchors) if (a.status === "missing") addFinding(e, { type: "stale", message: staleMessage(a) });
  }

  checkConsistency(entries, repos, resolve);

  for (const e of entries) {
    const v = decide(e);
    // Headings only matter when something is wrong with them.
    e.verdict = e.kind === "heading" && !PROBLEM_VERDICTS.has(v) ? "heading" : v;
    e.history = HIST_RE.test(e.text);
    e.findings.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.message < b.message ? -1 : 1));
  }
  return entries;
}

export { PROBLEM_TYPES };
