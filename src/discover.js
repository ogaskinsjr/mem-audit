// Finds the memory / instruction files coding agents keep for a repository.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCES = ["copilot", "claude", "committed"];

export function defaultVscodeUserDirs({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const base = platform === "darwin"
    ? path.join(home, "Library", "Application Support")
    : platform === "win32"
      ? env.APPDATA || path.join(home, "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return ["Code", "Code - Insiders", "VSCodium"].map((p) => path.join(base, p, "User"));
}

function readdirSorted(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); }
  catch { return []; }
}

function listMd(dir, recursive) {
  const out = [];
  for (const d of readdirSorted(dir)) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && recursive) out.push(...listMd(p, true));
    else if (d.isFile() && /\.mdc?$/i.test(d.name)) out.push(p);
  }
  return out;
}

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function copilotFiles(rootReal, userDirs, add) {
  for (const ud of userDirs) {
    const ws = path.join(ud, "workspaceStorage");
    for (const d of readdirSorted(ws)) {
      if (!d.isDirectory()) continue;
      let folder;
      try { folder = JSON.parse(fs.readFileSync(path.join(ws, d.name, "workspace.json"), "utf8")).folder; } catch { continue; }
      if (typeof folder !== "string" || !folder.startsWith("file:")) continue;
      let fp;
      try { fp = realpath(fileURLToPath(folder)); } catch { continue; }
      if (fp !== rootReal) continue;
      // Only the repo scope; per-conversation session folders are transient.
      for (const ext of ["GitHub.copilot-chat", "github.copilot-chat"]) {
        const dir = path.join(ws, d.name, ext, "memory-tool", "memories", "repo");
        for (const f of listMd(dir, true)) add(f, "copilot", "repo", `copilot:repo/${path.relative(dir, f)}`);
      }
    }
    for (const ext of ["github.copilot-chat", "GitHub.copilot-chat"]) {
      const dir = path.join(ud, "globalStorage", ext, "memory-tool", "memories");
      for (const f of listMd(dir, false)) add(f, "copilot", "user", `copilot:user/${path.basename(f)}`);
    }
  }
}

function claudeFiles(root, rootReal, tracked, claudeHome, add) {
  for (const f of tracked) if (path.posix.basename(f) === "CLAUDE.md") add(path.join(root, f), "claude", "project", `claude:${f}`);
  add(path.join(root, "CLAUDE.local.md"), "claude", "local", "claude:CLAUDE.local.md");
  add(path.join(claudeHome, "CLAUDE.md"), "claude", "user", "claude:~/.claude/CLAUDE.md");
  const encodings = new Set([rootReal.replace(/[^A-Za-z0-9]/g, "-"), rootReal.replace(/[\\/]/g, "-")]);
  for (const enc of encodings) {
    const dir = path.join(claudeHome, "projects", enc, "memory");
    for (const f of listMd(dir, true)) add(f, "claude", "auto-memory", `claude:memory/${path.relative(dir, f)}`);
  }
}

function committedFiles(root, tracked, add) {
  for (const f of tracked) {
    const b = path.posix.basename(f);
    const hit = b === "AGENTS.md" || b === "GEMINI.md" || f === ".github/copilot-instructions.md" || f === ".cursorrules"
      || /^\.github\/instructions\/.+\.instructions\.md$/.test(f) || /^\.cursor\/rules\/.+\.mdc?$/.test(f);
    if (hit) add(path.join(root, f), "committed", "committed", `committed:${f}`);
  }
}

/**
 * @returns {Array<{path:string, source:string, scope:string, label:string}>} sorted by label
 */
export function discover(root, { agents = SOURCES, files = [], exclude = [], tracked = [], vscodeUserDirs, claudeHome } = {}) {
  const rootReal = realpath(root);
  const found = new Map();
  const add = (p, source, scope, label) => {
    if (!isFile(p)) return;
    // Case-insensitive filesystems reach one file via "GitHub.copilot-chat" and "github.copilot-chat".
    const st = fs.statSync(p);
    const key = `${st.dev}:${st.ino}`;
    if (!found.has(key)) found.set(key, { path: realpath(p), source, scope, label });
  };

  if (agents.includes("copilot")) copilotFiles(rootReal, vscodeUserDirs ?? defaultVscodeUserDirs(), add);
  if (agents.includes("claude")) claudeFiles(rootReal, rootReal, tracked, claudeHome ?? path.join(os.homedir(), ".claude"), add);
  if (agents.includes("committed")) committedFiles(rootReal, tracked, add);
  for (const f of files) add(path.resolve(f), "file", "explicit", `file:${f}`);

  return [...found.values()]
    .filter((f) => !exclude.some((x) => f.path.includes(x) || f.label.includes(x)))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}
