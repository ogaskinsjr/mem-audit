// Read-only index of a repository: which paths exist, what the code says, and
// the facts memory most often restates (npm scripts, package versions, env defaults).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage", ".turbo", ".cache", "vendor", "target",
  "__pycache__", ".venv", "venv",
]);
const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum",
]);
const MAX_BYTES = 1_000_000;
const MAX_WALK = 50_000;
const SEP = "\n\u0000\n";

function gitFiles(root) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean).sort();
  } catch {
    return null;
  }
}

function walk(root) {
  const out = [];
  const visit = (rel) => {
    if (out.length >= MAX_WALK) return;
    let ents;
    try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of ents) {
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) visit(p); }
      else if (d.isFile()) out.push(p);
    }
  };
  visit("");
  return out;
}

export function listFiles(root) {
  const files = gitFiles(root) ?? walk(root);
  return files.filter((f) => !f.split("/").some((seg) => SKIP_DIRS.has(seg)));
}

function addDefault(map, name, value, repo) {
  const v = value.trim().replace(/^["']|["']$/g, "");
  if (!v || /^[$<{]/.test(v)) return;
  if (!map.has(name)) map.set(name, new Map());
  if (!map.get(name).has(v)) map.get(name).set(v, repo);
}

function collectEnvDefaults(text, file, map, repo) {
  for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\s*(?:\|\||\?\?)\s*(['"`])([^'"`\n]*)\2/g)) addDefault(map, m[1], m[3], repo);
  for (const m of text.matchAll(/os\.(?:getenv|environ\.get)\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*,\s*['"]([^'"\n]*)['"]/g)) addDefault(map, m[1], m[2], repo);
  for (const m of text.matchAll(/\$\{([A-Z][A-Z0-9_]*):?-([^}\n]*)\}/g)) addDefault(map, m[1], m[2], repo);
  if (/(^|\/)\.env\.(example|sample|template)$/.test(file)) {
    for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/gm)) addDefault(map, m[1], m[2], repo);
  }
}

export function indexRepo(rootArg, ignore = []) {
  const root = fs.realpathSync(path.resolve(rootArg));
  const name = path.basename(root);
  // A previous audit's JSON quotes memory verbatim; indexing it would make every anchor "resolve".
  const skip = new Set(ignore.map((p) => path.relative(root, path.resolve(p)).split(path.sep).join("/")));
  const fileList = listFiles(root).filter((f) => !skip.has(f) && path.posix.basename(f) !== "mem-audit.json");
  const files = new Set(fileList);
  const dirs = new Set();
  const topDirs = new Set();
  const basenames = new Set();
  const scripts = new Set();
  const versions = new Map();
  const envDefaults = new Map();
  const code = [];
  const all = [];
  let hasPackageJson = false;

  for (const f of fileList) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    if (parts.length > 1) topDirs.add(parts[0]);
    const base = parts[parts.length - 1];
    basenames.add(base);
    if (LOCKFILES.has(base)) continue;

    let buf;
    try {
      const st = fs.statSync(path.join(root, f));
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      buf = fs.readFileSync(path.join(root, f));
    } catch { continue; }
    if (buf.subarray(0, 8000).includes(0)) continue;
    const text = buf.toString("utf8");

    all.push(text);
    // Docs and migration history still mention removed things; "is it in the code" must ignore them.
    const isDoc = /\.(md|mdx|txt|rst|adoc)$/i.test(f) || /(^|\/)CHANGELOG/i.test(f);
    const isHistory = /(^|\/)migrations?\//i.test(f);
    if (!isDoc && !isHistory) code.push(text);

    if (base === "package.json") {
      hasPackageJson = true;
      try {
        const pkg = JSON.parse(text);
        for (const s of Object.keys(pkg.scripts ?? {})) scripts.add(s);
        if (pkg.name && pkg.version) versions.set(String(pkg.name).toLowerCase(), String(pkg.version));
      } catch { /* malformed package.json */ }
    }
    if (!isDoc) collectEnvDefaults(text, f, envDefaults, name);
  }

  return { name, root, files, dirs, topDirs, basenames, scripts, versions, envDefaults, hasPackageJson, code: code.join(SEP), all: all.join(SEP) };
}

const WORD_CHAR = /[A-Za-z0-9_$]/;

// Whole-word occurrence (no regex per token: indexOf over the joined corpus is fast).
export function hasWord(blob, token) {
  let i = blob.indexOf(token);
  while (i !== -1) {
    const a = blob[i - 1];
    const b = blob[i + token.length];
    if (!(a && WORD_CHAR.test(a)) && !(b && WORD_CHAR.test(b))) return true;
    i = blob.indexOf(token, i + 1);
  }
  return false;
}
