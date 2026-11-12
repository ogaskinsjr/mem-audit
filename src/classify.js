import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXT_RE, extractAnchors } from "./anchors.js";
import { absentAnchors, addFinding, checkConsistency, PROBLEM_TYPES, removalAnchors } from "./consistency.js";
import { gitHistory, hasWord } from "./repo.js";
import { findSecrets } from "./secrets.js";

export const VERDICTS = [
  "redact", "contradiction", "stale", "superseded", "conflict", "misplaced", "narrowed", "keep-local", "guidance", "repo-fact", "duplicate", "history", "review",
];
export const PROBLEM_VERDICTS = new Set(["redact", "contradiction", "stale", "superseded", "conflict"]);

const PREF_RE = /\b(?:user (?:prefers|wants|asked|likes|said|requested)|i prefer|my preference|always ask|never ask|ask (?:the user|me) (?:before|first))\b/i;
const OS_RE = /\b(?:zsh|bash|fish|powershell|homebrew|brew|macos|linux|windows|terminal|dotfiles|keychain)\b|\$PATH\b/gi;
const HIST_RE = /\b20\d\d-\d\d-\d\d\b|\b(?:TODO|WIP|FIXME|BUILT|FIXED|DONE|ADDED|SHIPPED|PENDING|NEXT)\b|\b(?:[Ii]n progress|[Nn]ext steps?|not (?:yet )?(?:done|built)|[Ff]ollow-?up)\b/;
const GUIDE_RE = /\b(?:do not|don'?t|never|must(?:n'?t)?|always|avoid|on purpose|instead of|because|so (?:that|they|it|its|the)|does not|doesn'?t|keep (?:th(?:at|is|em|e)|it)|exception|gotcha)\b/i;
const VERIFIED_RE = /^\W*verified\b/i;
const APP_PATH_RE = /(?:^|[\s"'`(=])\/Applications\//;
const STRONG_KINDS = new Set(["path", "symbol", "env", "script", "route"]);
const MAX_HOMES = 2;
const LOOKUP_KINDS = new Set(["env", "identifier"]);

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
  
  for (const r of repos) if (fs.existsSync(path.join(r.root, s))) return resolved(r);
  if (segs.length === 1) {
    for (const r of repos) if (r.basenames.has(s)) return resolved(r);
    for (const r of repos) if (r.code.includes(s)) return resolved(r);
    return EXT_RE.test(s) ? missing() : UNKNOWN;
  }
  const tail = `/${s}`;
  for (const r of repos) {
    for (const f of r.files) if (f.endsWith(tail)) return resolved(r);
    for (const d of r.dirs) if (d.endsWith(tail)) return resolved(r);
  }
  
  const owners = repos.filter((r) => r.topDirs.has(segs[0]));
  if (owners.length) return missing(owners.length === 1 ? owners[0] : null);
  return EXTERNAL;
}

function hasDir(r, name) {
  if (r.dirs.has(name)) return true;
  for (const d of r.dirs) if (d.endsWith(`/${name}`)) return true;
  
  const p = path.join(r.root, name);
  try { return fs.statSync(p).isDirectory() && !fs.existsSync(path.join(p, "mem-audit.json")); } catch { return false; }
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
      case "dir":
        for (const r of repos) if (hasDir(r, a.value)) return resolved(r);
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

function staleMessage(a, here) {
  const where = a.repo ?? here;
  switch (a.kind) {
    case "local-path": return `local path \`${a.value}\` no longer exists`;
    case "script": return `npm script \`${a.value}\` isn't in ${where}`;
    default: return `\`${a.value}\` isn't in ${where}`;
  }
}

const list = (as) => as.slice(0, 4).map((a) => `\`${a.value}\``).join(", ") + (as.length > 4 ? ` and ${as.length - 4} more` : "");
const fromRepos = (repos) => (repos.length > MAX_HOMES ? `${repos.length} nearby repos` : repos.join(", "));

function decide(e, hasRepo) {
  const types = new Set(e.findings.map((f) => f.type));
  const first = (t) => e.findings.find((f) => f.type === t)?.message;
  if (types.has("secret")) return ["redact", first("secret")];
  for (const t of ["contradiction", "stale", "superseded", "conflict", "misplaced", "narrowed"]) if (types.has(t)) return [t, first(t)];

  const personal = e.anchors.filter((a) => a.kind === "local-path" && a.local);
  if (personal.length) return ["keep-local", `names a path on this machine: ${list(personal)}`];
  if (APP_PATH_RE.test(e.text)) return ["keep-local", "names an application path on this machine"];
  const pref = e.text.match(PREF_RE);
  if (pref) return ["keep-local", `states a preference ("${pref[0]}")`];

  if (e.scope === "user") return ["keep-local", "user memory, shared across every repo"];
  const backed = e.anchors.filter((a) => a.status === "resolved" && !a.local);
  if (e.sectionLocal && !backed.length) return ["keep-local", "filed under a heading about a path on this machine"];

  const recorded = e.anchors.filter((a) => a.status === "removed" && a.commit);
  if (recorded.length) return ["history", `records ${recorded.map((a) => `\`${a.value}\` (last in commit ${a.commit})`).join(", ")} as removed; git history keeps that record`];
  if (VERIFIED_RE.test(e.text)) return ["history", "a one-time verification record; re-run the check instead of trusting memory"];

  const guide = backed.length ? e.text.match(GUIDE_RE) : null;
  if (guide) return ["guidance", `mentions ${list(backed)} but records a rule or reason the code can't show ("${guide[0]}")`];
  const strong = backed.filter((a) => STRONG_KINDS.has(a.kind));
  if (strong.length) {
    const uses = (e.uses ?? []).map((u) => `\`${u.value}\` from ${fromRepos(u.repos)}`);
    return ["repo-fact", `names ${list(strong)}, which the repo has${uses.length ? `; it also uses ${uses.join("; ")}` : ""}`];
  }
  if (e.headingRepo) return ["repo-fact", "describes its heading's subject, which the repo has"];
  const osHits = new Set((e.text.match(OS_RE) ?? []).map((s) => s.toLowerCase()));
  if (osHits.size >= 2) return ["keep-local", `machine setup (${[...osHits].join(", ")})`];
  if (types.has("duplicate")) return ["duplicate", first("duplicate")];
  const hist = e.text.match(HIST_RE);
  if (hist) return ["history", `reads like a status or changelog line ("${hist[0]}")`];
  const unrecorded = e.anchors.filter((a) => a.status === "removed");
  if (unrecorded.length) return ["review", `records ${list(unrecorded)} as removed, but this repo's git history has no record of it`];
  const unplaced = e.anchors.filter((a) => a.status === "unknown");
  if (hasRepo && unplaced.length) return ["review", `names ${list(unplaced)}, but none of that could be checked against the repo`];
  return ["review", "nothing to check it against: no file, symbol, value or personal detail"];
}

/**
 * @param {Array} entries parsed entries; each must carry label + scope of its file
 * @param {Array} repos   indexRepo() results (target first); [] = memory-only checks
 * @param {{siblings?: () => Array}} opts siblings: lazy indexRepo() results for repos next to the target
 */
export function auditEntries(entries, repos, { siblings } = {}) {
  const resolve = makeResolver(repos);
  const here = repos.map((r) => r.name).join(", ");
  const gitSeen = new Map();
  const inGit = (a) => {
    const k = `${a.kind}\u0000${a.value}`;
    if (!gitSeen.has(k)) gitSeen.set(k, repos.reduce((hit, r) => hit ?? gitHistory(r.root, a), null));
    return gitSeen.get(k);
  };
  let nearby = null;
  const foundIn = (a) => {
    if (!siblings) return [];
    nearby ??= siblings().map((r) => ({ name: r.name, resolve: makeResolver([r]) }));
    return nearby.filter((s) => s.resolve(a).status === "resolved").map((s) => s.name);
  };
  const sectionLocal = new Map();
  const headingRepo = new Map();
  for (const e of entries) {
    
    e.anchors = extractAnchors(e.text).map((a) => ({ ...a, ...resolve(a) })).filter((a) => a.kind !== "dir" || a.status === "resolved");

    const key = `${e.file}\u0000${e.section.join("\u0000")}`;
    if (!sectionLocal.has(key)) sectionLocal.set(key, e.section.some((h) => extractAnchors(h).some((a) => a.kind === "local-path")));
    e.sectionLocal = sectionLocal.get(key);
    if (e.kind === "heading") {
      headingRepo.set(`${e.file}\u0000${[...e.section, e.text].join("\u0000")}`, e.anchors.some((a) => a.status === "resolved" && !a.local));
    }
    
    e.headingRepo = e.kind !== "heading" && headingRepo.get(key) === true;

    if (e.sectionLocal || e.anchors.some((a) => a.kind === "local-path" && a.local)) {
      for (const a of e.anchors) {
        if (a.status === "missing" && !a.local && (a.kind === "symbol" || (a.kind === "path" && !a.value.includes("/")))) a.status = "external";
      }
    }
    if (e.scope === "user") for (const a of e.anchors) if (a.status === "missing" && !a.local) a.status = "external";
    const removed = new Set(removalAnchors(e.text).map((a) => a.value));
    for (const a of e.anchors) if (a.status === "missing" && removed.has(a.value)) a.status = "removed";
    for (const a of e.anchors) if (a.status === "removed") a.commit = inGit(a);
    const absent = new Set(absentAnchors(e.text).map((a) => a.value));
    for (const a of e.anchors) if (a.status === "missing" && absent.has(a.value)) a.status = "absent";

    e.findings = [];
    e.secrets = findSecrets(e.text);
    for (const s of e.secrets) addFinding(e, { type: "secret", message: `possible ${s.kind}: ${s.masked}` });

    const missing = e.anchors.filter((a) => a.status === "missing");
    const placeable = e.scope !== "user" && !e.sectionLocal && !e.anchors.some((a) => a.kind === "local-path" && a.local);

    const lookups = placeable
      ? e.anchors.filter((a) => !removed.has(a.value) && !absent.has(a.value)
        && ((a.status === "unknown" && LOOKUP_KINDS.has(a.kind)) || (a.status === "external" && a.kind === "path")))
      : [];
    const candidates = [...missing, ...lookups];
    const hits = candidates.map((a) => (a.kind === "local-path" ? [] : foundIn(a)));
    const found = hits.filter((h) => h.length);
    const common = found.length ? found.reduce((acc, h) => acc.filter((n) => h.includes(n))) : [];
    let usesOthers = false;

    if (found.length) {
      const localCounts = e.anchors.filter((a) => a.status === "resolved" && !a.local).map((a) => 1 + foundIn(a).length);
      usesOthers = localCounts.length > 0 && Math.min(...localCounts) <= Math.min(...found.map((h) => h.length));
    }

    e.uses = [];
    candidates.forEach((a, i) => {
      if (!hits[i].length) {
        if (a.status === "missing") addFinding(e, { type: "stale", message: staleMessage(a, here) });
        return;
      }
      const where = common.length ? common : hits[i];
      a.status = "elsewhere";
      a.repo = where[0];
      if (usesOthers) {
        e.uses.push({ value: a.value, repos: hits[i] });
        return;
      }
      const move = where.length === 1 ? "Move this note to that repo's memory."
        : where.length <= MAX_HOMES ? "Move this note to the memory of the one it is about."
          : `Those repos share it, so move this note to the one that defines \`${a.value}\`.`;
      addFinding(e, { type: "misplaced", message: `\`${a.value}\` isn't in ${here}; found in ${where.join(", ")}. ${move}` });
    });
  }

  checkConsistency(entries, repos, resolve);

  for (const e of entries) {
    const [v, reason] = decide(e, repos.length > 0);
    e.verdict = e.kind === "heading" && !PROBLEM_VERDICTS.has(v) && v !== "misplaced" && v !== "narrowed" ? "heading" : v;
    e.reason = e.checked?.length && !PROBLEM_VERDICTS.has(v) ? `${reason}; checked: ${e.checked.join("; ")}` : reason;
    e.history = HIST_RE.test(e.text);
    e.findings.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.message < b.message ? -1 : 1));
  }
  return entries;
}

export { PROBLEM_TYPES };
