import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractAnchors } from "../src/anchors.js";
import { runAudit } from "../src/index.js";
import { parseMarkdown } from "../src/parse.js";
import { findSecrets, maskSecrets } from "../src/secrets.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "mem-audit.js");
const FAKE_STRIPE = `sk_live_${"A1b2C3d4E5f6G7h8I9j0K1l2"}`;

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mem-audit-")));
  const repo = path.join(base, "demo-app");
  write(repo, "package.json", JSON.stringify({ name: "demo-app", version: "2.1.0", scripts: { dev: "node src/server.ts", test: "node --test" } }));
  write(repo, "src/server.ts", [
    "const port = process.env.PORT_NUMBER || '3000';",
    "export function startServer() { app.get('/api/users/list', handler); }",
  ].join("\n"));
  write(repo, "src/db.ts", "export const pool = makePool();\n");
  write(repo, ".env.example", "API_TIMEOUT_MS=5000\n");
  write(repo, "AGENTS.md", "# Agents\n\n- Run `npm run dev` to start `src/server.ts`.\n");

  const scratch = path.join(base, "scratch");
  fs.mkdirSync(scratch);
  fs.writeFileSync(path.join(scratch, "notes.txt"), "");
  const memory = [
    "# Notes",
    "",
    "## Server (2026-01-01)",
    "- `startServer()` boots the API in `src/server.ts`",
    "- `src/legacy.ts` holds the old router",
    "- `oldHelper()` formats rows",
    "- `API_TIMEOUT_MS` defaults to 30s",
    "- demo-app 1.0.0 ships the users API",
    "- run `npm run deploy` to ship",
    "- `legacyFlag` toggles the old code path",
    `- scratch notes live in ${scratch}/notes.txt`,
    "- The user prefers terse answers",
    "- `other/thing.go` belongs to some other project",
    `- deploy key ${FAKE_STRIPE}`,
    "",
    "## Cache (2026-02-01)",
    "- cache service port 6379",
    "",
    "## Cache update (2026-03-01)",
    "- cache service port 6380",
    "- `legacyFlag` was removed in favor of config",
    "",
    "## Widgets",
    "- widget service port 7000",
    "",
    "## More widgets",
    "- widget service port 7001",
    "- the nightly job rebuilds every search index from scratch and then warms the cache for all tenants",
    "- the nightly job rebuilds every search index from scratch and then warms the cache for all tenants",
    "",
  ].join("\n");

  const userDir = path.join(base, "vscode", "User");
  const ws = path.join(userDir, "workspaceStorage", "abc123");
  write(ws, "workspace.json", JSON.stringify({ folder: pathToFileURL(repo).href }));
  write(ws, "GitHub.copilot-chat/memory-tool/memories/repo/notes.md", memory);
  write(ws, "GitHub.copilot-chat/memory-tool/memories/MDAwMDAw/session.md", "- transient session note\n");
  write(userDir, "globalStorage/github.copilot-chat/memory-tool/memories/prefs.md", "- Always use zsh and Homebrew on macOS\n");
  // A different workspace must not be picked up.
  write(path.join(userDir, "workspaceStorage", "zzz"), "workspace.json", JSON.stringify({ folder: pathToFileURL(base).href }));
  write(path.join(userDir, "workspaceStorage", "zzz"), "GitHub.copilot-chat/memory-tool/memories/repo/other.md", "- other repo\n");

  const claudeHome = path.join(base, "claude");
  write(claudeHome, `projects/${repo.replace(/[^A-Za-z0-9]/g, "-")}/memory/auto.md`, "- `src/db.ts` exports the pool\n");

  return { base, repo, userDir, claudeHome };
}

function audit(fx, extra = {}) {
  return runAudit({ root: fx.repo, vscodeUserDirs: [fx.userDir], claudeHome: fx.claudeHome, ...extra });
}

function entry(result, needle) {
  const e = result.entries.find((x) => x.text.includes(needle));
  assert.ok(e, `no entry containing ${needle}`);
  return e;
}

test("parseMarkdown splits headings, list items with continuations, tables and fences", () => {
  const md = "# A\n\n- one\n  continued\n- two\n\n| Var | Default |\n|---|---|\n| `X_Y` | `1` |\n\n```sh\nnpm run dev\n```\n";
  const es = parseMarkdown(md, "f.md");
  assert.deepEqual(es.map((e) => [e.kind, e.line]), [["heading", 1], ["list-item", 3], ["list-item", 5], ["table-row", 9], ["code", 11]]);
  assert.equal(es[1].text, "- one\n  continued");
  assert.deepEqual(es[1].section, ["A"]);
  assert.deepEqual(es[3].table.cells, ["`X_Y`", "`1`"]);
});

test("extractAnchors finds paths, symbols, env vars, routes, scripts and personal paths", () => {
  const a = extractAnchors("See `src/app.ts` and buildBaselineDraft(); set `API_KEY_NAME`, hit `GET /api/users/:id`, run `npm run dev`, notes in ~/scratch/x.md, Node.js is fine, read/write too.");
  const got = a.map((x) => `${x.kind}:${x.value}`);
  for (const want of ["path:src/app.ts", "symbol:buildBaselineDraft", "env:API_KEY_NAME", "route:/api/users/:id", "script:dev", "local-path:~/scratch/x.md"]) {
    assert.ok(got.includes(want), `missing ${want} in ${got.join(", ")}`);
  }
  assert.ok(!got.some((g) => g.includes("Node.js") || g.includes("read/write")));
});

test("secrets are detected and masked", () => {
  const s = findSecrets(`key ${FAKE_STRIPE} and postgres://app:hunter22@db/x`);
  assert.equal(s.length, 2);
  const masked = maskSecrets(`key ${FAKE_STRIPE}`, s);
  assert.ok(!masked.includes(FAKE_STRIPE));
  assert.equal(findSecrets("token: <YOUR_TOKEN_HERE>").length, 0);
});

test("discovers only this repo's copilot memory, user memory, claude auto-memory and committed files", () => {
  const fx = fixture();
  const r = audit(fx);
  assert.deepEqual(r.files.map((f) => f.label), [
    "claude:memory/auto.md",
    "committed:AGENTS.md",
    "copilot:repo/notes.md",
    "copilot:user/prefs.md",
  ]);
});

test("classifies memory against the repo", () => {
  const fx = fixture();
  const r = audit(fx);
  assert.equal(entry(r, "boots the API").verdict, "repo-fact");
  assert.equal(entry(r, "src/legacy.ts").verdict, "stale");
  assert.equal(entry(r, "oldHelper").verdict, "stale");
  assert.equal(entry(r, "npm run deploy").verdict, "stale");
  assert.equal(entry(r, "API_TIMEOUT_MS").verdict, "contradiction");
  assert.equal(entry(r, "demo-app 1.0.0").verdict, "contradiction");
  assert.equal(entry(r, "scratch notes").verdict, "keep-local");
  assert.equal(entry(r, "prefers terse").verdict, "keep-local");
  assert.equal(entry(r, "zsh and Homebrew").verdict, "keep-local");
  assert.equal(entry(r, "other/thing.go").verdict, "review");
  assert.equal(entry(r, "deploy key").verdict, "redact");
  assert.equal(entry(r, "exports the pool").verdict, "repo-fact");
});

test("checks memory against itself", () => {
  const fx = fixture();
  const r = audit(fx);
  const older = entry(r, "port 6379");
  assert.equal(older.verdict, "superseded");
  assert.match(older.findings.find((f) => f.type === "superseded").message, /2026-03-01/);
  assert.equal(entry(r, "port 6380").findings.length, 0);

  assert.equal(entry(r, "port 7000").verdict, "conflict");
  assert.equal(entry(r, "port 7001").verdict, "conflict");

  const flag = entry(r, "toggles the old code path");
  assert.ok(flag.findings.some((f) => f.type === "superseded" && /legacyFlag/.test(f.message)));
  assert.equal(entry(r, "was removed in favor of config").verdict, "history");

  const dups = r.entries.filter((e) => e.text.includes("nightly job"));
  assert.equal(dups[0].findings.length, 0);
  assert.ok(dups[1].findings.some((f) => f.type === "duplicate"));
});

test("--no-repo still runs the memory-vs-memory checks", () => {
  const fx = fixture();
  const r = audit(fx, { noRepo: true });
  assert.equal(entry(r, "port 6379").verdict, "superseded");
  assert.equal(entry(r, "src/legacy.ts").verdict === "stale", false);
});

test("CLI: JSON is deterministic, secrets masked, --fail-on sets the exit code", () => {
  const fx = fixture();
  const args = [BIN, fx.repo, "--vscode-user-dir", fx.userDir, "--claude-home", fx.claudeHome, "--json"];
  const opts = { encoding: "utf8", cwd: fx.base };
  const a = spawnSync(process.execPath, args, opts);
  const b = spawnSync(process.execPath, args, opts);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, b.stdout);
  assert.ok(!a.stdout.includes(FAKE_STRIPE));
  assert.ok(JSON.parse(a.stdout).summary.counts.stale >= 3);

  const fail = spawnSync(process.execPath, [...args, "--fail-on", "stale"], opts);
  assert.equal(fail.status, 1);
  const bad = spawnSync(process.execPath, [BIN, fx.repo, "--fail-on", "nope"], opts);
  assert.equal(bad.status, 2);
});

test("CLI: every run writes the JSON audit; --out moves it, --no-out skips it", () => {
  const fx = fixture();
  const base = [BIN, fx.repo, "--vscode-user-dir", fx.userDir, "--claude-home", fx.claudeHome];
  const opts = { encoding: "utf8", cwd: fx.base };

  const text = spawnSync(process.execPath, base, opts);
  const file = path.join(fx.base, "mem-audit.json");
  assert.equal(text.status, 0);
  assert.match(text.stdout, /JSON audit: mem-audit\.json/);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.tool, "mem-audit");
  assert.ok(written.entries.length > 0);
  assert.ok(!fs.readFileSync(file, "utf8").includes(FAKE_STRIPE));

  // The previous audit sitting in the repo must not satisfy anchors on the next run.
  fs.copyFileSync(file, path.join(fx.repo, "mem-audit.json"));
  const again = JSON.parse(spawnSync(process.execPath, [...base, "--json"], opts).stdout);
  assert.deepEqual(again.summary, written.summary);

  spawnSync(process.execPath, [...base, "--out", "reports/audit.json"], opts);
  assert.ok(fs.existsSync(path.join(fx.base, "reports", "audit.json")));

  fs.rmSync(file);
  spawnSync(process.execPath, [...base, "--no-out"], opts);
  assert.ok(!fs.existsSync(file));
});

test("CLI: --help lists every option; --help <option> describes it", () => {
  const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: "utf8" });
  const all = run("--help");
  assert.equal(all.status, 0);
  for (const flag of ["--agent", "--file", "--related", "--exclude", "--no-repo", "--json", "--out", "--no-out", "--verbose", "--fail-on", "--list", "--no-hint", "--vscode-user-dir", "--claude-home", "--version"]) {
    assert.ok(all.stdout.includes(flag), `--help is missing ${flag}`);
  }

  const one = run("--help", "--related");
  assert.equal(one.status, 0);
  assert.match(one.stdout, /^--related <dir\.\.\.>/);
  assert.match(one.stdout, /Example:/);
  assert.ok(!one.stdout.includes("--claude-home"));

  assert.equal(run("--fail-on", "--help").stdout, run("--help", "fail-on").stdout);
  assert.equal(run("--help", "--bogus").status, 2);
});
