import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractAnchors } from "../src/anchors.js";
import { resolveRows } from "../src/consistency.js";
import { runAudit } from "../src/index.js";
import { parseMarkdown } from "../src/parse.js";
import { renderOutputFiles, renderText } from "../src/report.js";
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
  // Both cache ports and both widget ports exist, so memory-vs-memory rules settle those notes.
  write(repo, "src/ports.ts", [
    "export const CACHE_SERVICE_PORT = 6380;",
    "export const CACHE_SERVICE_PORT_OLD = 6379;",
    "export const WIDGET_SERVICE_PORT = 7000;",
    "export const WIDGET_SERVICE_PORT_ALT = 7001;",
  ].join("\n"));
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
  // No git history here, so nothing backs "git already has this".
  const removedNote = entry(r, "was removed in favor of config");
  assert.equal(removedNote.verdict, "review");
  assert.match(removedNote.reason, /records `legacyFlag` as removed, but this repo's git history has no record of it/);

  const dups = r.entries.filter((e) => e.text.includes("nightly job"));
  assert.equal(dups[0].findings.length, 0);
  assert.ok(dups[1].findings.some((f) => f.type === "duplicate"));
});

test("reads removal direction, example settings and stated absence correctly", () => {
  const fx = fixture();
  const notes = write(fx.base, "extra.md", [
    "# Extra",
    "- put_thing can overwrite a prior segment",
    "- Progress: your put_thing replaces YOUR segment, the baseline still runs.",
    "- Local gotcha: CHROME_BIN=\"/Applications/Google Chrome.app/x\" npm run dev",
    "- Docker installs chromium and sets PUPPETEER_SKIP=true + CHROME_BIN=/usr/bin/chromium.",
    "- Prerender with puppeteer, NOT SSR, so renderToNothing would crash.",
    "- phantom files (`ghost.yml` — not in repo tree) were skipped",
    "- Dropped stale: ghost.yml.",
    "- `deadHandler()` parses incoming rows, then the cache is not warmed.",
    "",
  ].join("\n"));
  const r = audit(fx, { files: [notes] });
  const noProblems = (needle) => assert.deepEqual(entry(r, needle).findings.filter((f) => f.type !== "restates").map((f) => f.type), [], needle);

  noProblems("can overwrite a prior segment");
  noProblems("replaces YOUR segment");
  noProblems("Local gotcha");
  noProblems("Docker installs chromium");
  noProblems("renderToNothing");
  noProblems("phantom files");
  // Both notes record ghost.yml as gone and the repo agrees, so they're linked, not flagged.
  assert.deepEqual(entry(r, "phantom files").findings.map((f) => f.type), ["restates"]);
  assert.match(entry(r, "phantom files").findings[0].message, /^looks like the same fact as .*extra\.md:8: both say `ghost\.yml` isn't in the repo$/);
  assert.deepEqual(entry(r, "Local gotcha").findings, []);
  assert.equal(entry(r, "renderToNothing").anchors.find((a) => a.value === "renderToNothing").status, "absent");
  assert.equal(entry(r, "deadHandler").verdict, "stale");
});

test("decisions: a later decision supersedes an edited note, old decisions stand, unsettled ones conflict", () => {
  const fx = fixture();
  const decisions = write(fx.base, "decisions.md", [
    "# Decisions",
    "",
    "## Queue (2026-01-10)",
    "- Workers listen on port 7070",
    "- The batch size limit is 50",
    "",
    "## Timeout decision (2026-03-02)",
    "- The job timeout is 60s (was 30s).",
    "",
    "## Uploads",
    "- The upload size cap is 20MB",
    "",
  ].join("\n"));
  const notes = write(fx.base, "notes.md", "# Notes\n- The job timeout is 30s\n- The upload size cap is 10MB\n");
  // The note was edited after the decision; edit time must not make it win.
  fs.utimesSync(decisions, new Date("2026-03-02"), new Date("2026-03-02"));
  fs.utimesSync(notes, new Date(), new Date());

  // Memory-only: these pin how notes settle among themselves when the code can't decide.
  const r = audit(fx, { files: [decisions, notes], noRepo: true });
  for (const still of ["Workers listen on port 7070", "batch size limit is 50", "job timeout is 60s"]) {
    assert.deepEqual(entry(r, still).findings, [], still);
  }
  const old = entry(r, "job timeout is 30s");
  assert.equal(old.verdict, "superseded");
  assert.equal(old.findings[0].ref, `file:${decisions}:8`);
  assert.match(old.findings[0].message, /^job timeout is `30s` here; replaced by .*decisions\.md:8 \(2026-03-02\), which says `60s` \(was `30s`\)$/);

  for (const cap of ["upload size cap is 20MB", "upload size cap is 10MB"]) assert.equal(entry(r, cap).verdict, "conflict", cap);
});

test("decisions: a scoped replacement only covers its scope; the same records answer per job type", () => {
  const fx = fixture();
  const scoped = write(fx.base, "retry.md", [
    "# Retry",
    "## Retry (2026-01-10)",
    "- The retry limit is 3.",
    "- `MAX_RETRIES` defaults to 3",
    "## Retry policy (2026-04-01)",
    "- For new jobs only, the retry limit is 5.",
    "- New-job retry handling replaces `MAX_RETRIES` for new jobs only.",
    "",
  ].join("\n"));
  const r = audit(fx, { files: [scoped], noRepo: true });

  const old = entry(r, "retry limit is 3");
  assert.equal(old.verdict, "narrowed");
  assert.match(old.findings[0].message, /superseded for new job by .*retry\.md:6 \(2026-04-01\), which says `5`; still applies otherwise$/);
  assert.deepEqual(entry(r, "For new jobs only").findings, []);
  // A scoped replacement isn't a removal of MAX_RETRIES everywhere.
  assert.deepEqual(entry(r, "`MAX_RETRIES` defaults to 3").findings, []);

  const newJobs = resolveRows(r.entries, "retry limit", "new jobs");
  assert.deepEqual([newJobs.status, newJobs.value, newJobs.superseded], ["resolved", "5", [`file:${scoped}:3`]]);
  const legacyJobs = resolveRows(r.entries, "retry limit", "legacy jobs");
  assert.deepEqual([legacyJobs.status, legacyJobs.value, legacyJobs.superseded], ["resolved", "3", []]);

  // Same values, no scope and no dates: nothing says which applies.
  const unscoped = write(fx.base, "retry-unscoped.md", "# Retry\n- The retry limit is 3.\n- The retry limit is 5.\n");
  const u = audit(fx, { files: [unscoped], noRepo: true });
  assert.equal(entry(u, "retry limit is 3").verdict, "conflict");
  assert.equal(entry(u, "retry limit is 5").verdict, "conflict");
  assert.equal(resolveRows(u.entries, "retry limit", "new jobs").status, "unresolved");
  assert.equal(resolveRows(u.entries, "retry limit", "legacy jobs").status, "unresolved");
});

test("the code decides which value is right; a lone number is only flagged when it is a stated default", () => {
  const fx = fixture();
  write(fx.repo, "src/queue.ts", [
    "export const RETRY_LIMIT = 5;",
    "export const JOB_TIMEOUT_MS = 60_000;",
    "// workers",
    "server.listen(7070);",
  ].join("\n"));
  write(fx.repo, "config/queue.yml", "batch_size: 50\n");
  write(fx.repo, "src/license.ts", 'export const LICENSE_MODE = "grace";\n');
  const notes = write(fx.base, "code.md", [
    "# Code",
    "- The retry limit is 5",
    "- The retry limit is 3",
    "- The job timeout is 60s",
    "- The batch size is 40",
    "- Workers listen on port 7070",
    "- The upload size cap is 10MB",
    "- The upload size cap is 20MB",
    "- The queue depth limit is 9",
    "- QUEUE_WORKER_COUNT (default 4) sets the pool size",
    "- The license mode is `grace`",
    "- The license mode is `strict`",
    "",
  ].join("\n"));
  const r = audit(fx, { files: [notes] });
  const found = (needle) => entry(r, needle).findings.map((f) => `${f.type}: ${f.message}`);

  assert.deepEqual(found("retry limit is 5"), []);
  assert.deepEqual(found("retry limit is 3"), ["contradiction: retry limit is `3` here, but the code sets `5` at src/queue.ts:1"]);
  assert.deepEqual(found("job timeout is 60s"), []);
  assert.deepEqual(found("batch size is 40"), ["contradiction: batch size is `40` here, but the code sets `50` at config/queue.yml:1"]);
  assert.deepEqual(found("listen on port 7070"), []);
  assert.match(found("upload size cap is 10MB")[0], /^contradiction: upload size cap is `10MB` here and `20MB` at .*code\.md:8; neither value is set in demo-app$/);
  assert.match(found("upload size cap is 20MB")[0], /^contradiction: upload size cap is `20MB` here and `10MB` at .*code\.md:7; neither value is set in demo-app$/);
  // One note, no code: "9" may be a measurement, so nothing says it is wrong.
  assert.deepEqual(found("queue depth limit is 9"), []);
  assert.deepEqual(found("QUEUE_WORKER_COUNT"), ["stale: no `4` for `QUEUE_WORKER_COUNT` default is set in demo-app"]);
  assert.deepEqual(found("license mode is `grace`"), []);
  assert.deepEqual(found("license mode is `strict`"), ["contradiction: license mode is `strict` here, but the code sets `grace` at src/license.ts:1"]);
});

test("when the code has both values, scope and dates decide", () => {
  const fx = fixture();
  write(fx.repo, "src/retry.ts", [
    "export function retryLimitFor(job) {",
    "  if (job.isNew) return 5;",
    "  return 3;",
    "}",
  ].join("\n"));
  const notes = write(fx.base, "retry.md", [
    "# Retry",
    "## Retry (2026-01-10)",
    "- The retry limit is 3.",
    "## Retry policy (2026-04-01)",
    "- For new jobs only, the retry limit is 5.",
    "",
  ].join("\n"));
  const r = audit(fx, { files: [notes] });
  assert.equal(entry(r, "retry limit is 3").verdict, "narrowed");
  assert.deepEqual(entry(r, "For new jobs only").findings, []);
});

test("decisions: vague or one-word subjects are never compared", () => {
  const fx = fixture();
  const notes = write(fx.base, "vague.md", [
    "# Vague",
    "- Progress: the coverage is 0.92 after the run",
    "- Earlier the coverage is 0.85 on the old branch",
    "- In the build job the limit is 3",
    "- In the deploy job the limit is 5",
    ...["a", "b", "c", "d", "e"].map((x) => `- Note ${x} about the job runner limit tuning`),
    "- The job runner limit is 4",
    "- The job runner limit is 6",
    "",
  ].join("\n"));
  // Only this file, so word frequency comes from these notes alone.
  const r = audit(fx, { files: [notes], agents: [] });
  for (const needle of ["coverage is 0.92", "coverage is 0.85", "build job the limit", "deploy job the limit", "job runner limit is 4", "job runner limit is 6"]) {
    assert.deepEqual(entry(r, needle).findings, [], needle);
  }
});

test("a removal is history only when git kept a record of it; every verdict says why", () => {
  const fx = fixture();
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: fx.repo, encoding: "utf8" });
  git("init", "-q");
  write(fx.repo, "src/flags.ts", "export const legacyFlag = true;\n");
  write(fx.repo, "src/old-router.ts", "export default {};\n");
  git("add", "-A");
  git("commit", "-qm", "add");
  fs.rmSync(path.join(fx.repo, "src/flags.ts"));
  fs.rmSync(path.join(fx.repo, "src/old-router.ts"));
  git("add", "-A");
  git("commit", "-qm", "remove");
  const notes = write(fx.base, "removals.md", [
    "# Removals",
    "- Dropped `src/old-router.ts`; routes live in `src/server.ts` now.",
    "- Recovery that worked: dropped stale: phantom-file.yml.",
    "",
  ].join("\n"));

  const r = audit(fx, { files: [notes] });
  const routed = entry(r, "Dropped `src/old-router.ts`");
  assert.equal(routed.verdict, "history");
  assert.match(routed.reason, /^records `src\/old-router\.ts` \(last in commit [0-9a-f]{7,}\) as removed; git history keeps that record$/);
  assert.equal(entry(r, "was removed in favor of config").verdict, "history");
  const phantom = entry(r, "phantom-file.yml");
  assert.equal(phantom.verdict, "review");
  assert.match(phantom.reason, /git history has no record/);

  for (const e of r.entries) if (e.verdict !== "heading") assert.ok(e.reason, `${e.label}:${e.line} has no reason`);
  assert.match(entry(r, "boots the API").reason, /^names `startServer`, `src\/server\.ts`, which the repo has$/);
  assert.match(entry(r, "prefers terse").reason, /^states a preference/);
});

test("names the nearby repo a note belongs to; --no-siblings reports it as stale", () => {
  const fx = fixture();
  const sib = path.join(fx.base, "demo-api");
  fs.mkdirSync(path.join(sib, ".git"), { recursive: true });
  write(sib, "src/edgeproof.ts", "export function proveEdges() {}\n");
  write(path.join(fx.base, "demo-web", ".git"), "HEAD", "");
  write(fx.base, "demo-web/src/edgeproof.ts", "// stub\n");
  // makePool is in both repos, so it says nothing about which repo a note is about.
  write(sib, "src/pool.ts", "export const pool = makePool();\n");
  const notes = write(fx.base, "extra.md", [
    "# Api",
    "- edgeproof.ts holds `proveEdges()`",
    "- `startServer()` reports through `proveEdges()`",
    "- `makePool()` feeds `proveEdges()`",
    "",
  ].join("\n"));

  const e = entry(audit(fx, { files: [notes] }), "edgeproof.ts holds");
  assert.equal(e.verdict, "misplaced");
  assert.equal(e.findings.length, 2);
  for (const f of e.findings) {
    assert.equal(f.type, "misplaced");
    // demo-web has the file but not the function, so only demo-api is named.
    assert.match(f.message, /isn't in demo-app; found in demo-api\. Move this note to that repo's memory\./);
  }

  const r = audit(fx, { files: [notes] });
  // startServer is only here and as specific as proveEdges: the note is about this repo.
  const uses = entry(r, "reports through");
  assert.equal(uses.verdict, "repo-fact");
  assert.equal(uses.reason, "names `startServer`, which the repo has; it also uses `proveEdges` from demo-api");
  // makePool is in both repos; proveEdges only in demo-api decides.
  assert.equal(entry(r, "feeds `proveEdges()`").verdict, "misplaced");

  const off = entry(audit(fx, { files: [notes], siblings: false }), "edgeproof.ts holds");
  assert.equal(off.verdict, "stale");
  assert.ok(off.findings.some((f) => f.message === "`edgeproof.ts` isn't in demo-app"));
});

test("each report section carries its own DocuSOR tip; --no-hint hides them", () => {
  const fx = fixture();
  const r = audit(fx);
  const text = renderText(r);
  assert.match(text, /== Memory vs the repo ==[\s\S]*?Tip: DocuSOR re-checks context[\s\S]*?== Memory vs itself ==[\s\S]*?Tip: DocuSOR keeps one verified version/);
  assert.match(text, /== Doesn't need to be agent memory ==[\s\S]*?Tip: repo facts don't need/);
  assert.doesNotMatch(text, /== Belongs in agent memory ==[\s\S]*?Tip:[\s\S]*?== Unclassified/);
  assert.ok(!renderText(r, { hint: false }).includes("docusor.ai"));
});

test("rules, verification records and weak mentions aren't repo-facts", () => {
  const fx = fixture();
  write(fx.repo, "src/server.ts", [
    "const port = process.env.PORT_NUMBER || '3000';",
    "const auth = 'x-api-key';",
    "export function startServer() { app.get('/api/users/list', handler); }",
  ].join("\n"));
  const notes = write(fx.base, "rules.md", [
    "# Rules",
    "- Always restart via `startServer()` after schema changes.",
    "- `src/db.ts` exports the pool so that every query shares one connection.",
    "- Verified: `npm run dev` boots clean.",
    "- The `x-api-key` header is injected by the proxy.",
    "- Chrome lives at /Applications/Google Chrome.app for the prerender workaround.",
    "\"\"",
  ].join("\n"));
  const r = audit(fx, { files: [notes] });

  const rule = entry(r, "Always restart");
  assert.equal(rule.verdict, "guidance");
  assert.equal(rule.reason, 'mentions `startServer` but records a rule or reason the code can\'t show ("Always")');
  assert.equal(entry(r, "shares one connection").verdict, "guidance");
  const verified = entry(r, "boots clean");
  assert.equal(verified.verdict, "history");
  assert.match(verified.reason, /verification record/);
  // A token resolving somewhere in the code doesn't make the note a copy of the repo.
  const weak = entry(r, "x-api-key");
  assert.equal(weak.verdict, "review");
  assert.equal(entry(r, "Chrome lives at").verdict, "keep-local");
  // Plain structural statements with strong anchors stay repo-facts.
  assert.equal(entry(r, "boots the API").verdict, "repo-fact");
});

test("an open problem is outdated once a later heading or sentence in the same file settles it", () => {
  const fx = fixture();
  const notes = write(fx.base, "journal.md", [
    "# Journal",
    "## Edge proof",
    "- The proof stub never opens its port, so this is a platform-level blocker.",
    "- Contracts must match the consumer's real calls.",
    "- Possibly the evidence list rotates between graph calls.",
    "- Maybe the cache warmer needs a longer timeout.",
    "## FIX THAT WORKS: live mode skips the stub",
    "- Add live mode to the consumes block.",
    "- Remaining gap: the dashboard still shows the old count.",
    "- The evidence rotation theory was wrong.",
    "",
  ].join("\n"));
  const r = audit(fx, { files: [notes], agents: [] });
  const found = (needle) => entry(r, needle).findings.map((f) => `${f.type}: ${f.message}`);

  assert.equal(entry(r, "platform-level blocker").verdict, "superseded");
  assert.match(found("platform-level blocker")[0], /^superseded: describes an open problem that .*journal\.md:7 later settles \("FIX THAT WORKS: live mode skips the stub"\)$/);
  assert.match(found("evidence list rotates")[0], /^superseded: .*journal\.md:10 later says this was wrong \("The evidence rotation theory was wrong\."\)$/);
  // Not an open problem, nothing later about it, written after the fix, and the correction itself.
  for (const needle of ["Contracts must match", "cache warmer", "Remaining gap", "theory was wrong"]) assert.deepEqual(found(needle), [], needle);
});

test("an env var said to have one use is checked against the files that use it", () => {
  const fx = fixture();
  write(fx.repo, "src/auth.ts", "export const loginUrl = process.env.PUBLIC_API_BASE + '/login';\n");
  write(fx.repo, "src/sources.ts", "export const sourcesUrl = process.env.PUBLIC_API_BASE + '/sources';\n");
  write(fx.repo, "src/upload.ts", "export const cap = process.env.UPLOAD_CAP_BYTES;\n");
  const notes = write(fx.base, "only.md", [
    "# Only",
    "- `PUBLIC_API_BASE` is used only for the login redirect.",
    "- `PUBLIC_API_BASE` is read only in src/auth.ts.",
    "- `UPLOAD_CAP_BYTES` is used only for the upload size check.",
    "",
  ].join("\n"));
  const r = audit(fx, { files: [notes], agents: [] });
  const found = (needle) => entry(r, needle).findings.map((f) => `${f.type}: ${f.message}`);

  assert.deepEqual(found("login redirect"), ["contradiction: `PUBLIC_API_BASE` is said to have only one use, but 2 code files use it: src/auth.ts, src/sources.ts"]);
  assert.deepEqual(found("read only in"), ["contradiction: `PUBLIC_API_BASE` is said to be used only in src/auth.ts, but it is also used in src/sources.ts"]);
  assert.deepEqual(found("upload size check"), []);
});

test("links notes that look like the same fact; different facts stay apart", () => {
  const fx = fixture();
  write(fx.repo, "src/orders.ts", "app.get('/api/orders/list', handler);\n");
  const notes = write(fx.base, "restated.md", [
    "# Restated",
    "- Verified locally: `/api/users/list` always returns 204.",
    "- Exempt surfaces: `/api/users/list` -> 204 with an empty body.",
    "- Before submitting, prune stale fixture paths against the pinned snapshot manifest.",
    "- Recovery that worked: prune the stale fixture paths using the pinned snapshot manifest first.",
    "- `/api/orders/list` always returns 204.",
    "- `/api/users/list` returns 204, see `src/legacy.ts`.",
    "- The importer registers each app with the billing service by name.",
    "- Address the app by its service name inside the cluster.",
    "- The exporter writes dist/<route>/index.html.",
    "- The preview server serves dist/<route>/index.html for clean URLs.",
    "- The upload queue drains in 45 seconds.",
    "- The upload queue drains in 90 seconds.",
    "",
  ].join("\n"));
  const r = audit(fx, { files: [notes], agents: [] });
  const links = (needle) => entry(r, needle).findings.filter((f) => f.type === "restates").map((f) => f.ref.replace(/^.*:/, ""));

  // Same route and status; most of the same specific words.
  assert.deepEqual([links("Verified locally"), links("Exempt surfaces")], [["3"], ["2"]]);
  assert.deepEqual([links("Before submitting"), links("Recovery that worked")], [["5"], ["4"]]);
  assert.match(entry(r, "Exempt surfaces").findings[0].message, /^looks like the same fact as .*restated\.md:2: "Verified locally: `\/api\/users\/list` always returns 204\."$/);
  // A link isn't a problem: the verdict and its reason stay as they were.
  assert.equal(r.summary.restates, 4);
  assert.equal(r.summary.problems, 1);
  // Another route, a note that's stale anyway, a shared topic, a shared path, different numbers.
  for (const needle of ["/api/orders/list", "importer registers", "Address the app", "exporter writes", "preview server", "45 seconds", "90 seconds"]) {
    assert.deepEqual(entry(r, needle).findings, [], needle);
  }
  assert.deepEqual(entry(r, "src/legacy.ts").findings.map((f) => f.type), ["stale"]);

  const text = renderText(r);
  assert.match(text, /RESTATES \(4\) — looks like the same fact as another entry, in different words/);
  assert.match(text, /4 entries look like the same fact as another entry\./);
  const files = renderOutputFiles(r);
  const restates = JSON.parse(files["agent-todos/restates.json"]);
  assert.deepEqual([restates.finding, restates.count, restates.entries.length], ["restates", 4, 4]);
  assert.ok(restates.entries.every((e) => e.verdict && e.findings.every((f) => f.type === "restates" && f.ref)));
  assert.deepEqual(JSON.parse(files["summary.json"]).findings.restates.file, "agent-todos/restates.json");
});

test("a bracketed default is checked against a constant the code computes", () => {
  const fx = fixture();
  write(fx.repo, "src/grace.ts", "export const GRACE_MS = 72 * 3_600_000;\n");
  const run = (line) => entry(audit(fx, { files: [write(fx.base, "grace.md", `# Grace\n- ${line}\n`)], agents: [] }), line);

  const ok = run("Unconfigured means the grace period (72h default) allows access.");
  assert.deepEqual(ok.findings, []);
  assert.match(ok.reason, /; checked: `72h` for grace period matches src\/grace\.ts:1$/);
  assert.deepEqual(run("Offline installs get a grace period (default 48h).").findings.map((f) => `${f.type}: ${f.message}`), [
    "contradiction: grace period is `48h` here, but the code sets `72 * 3_600_000` at src/grace.ts:1",
  ]);
});

test("user memory isn't judged against this repo", () => {
  const fx = fixture();
  // `port` and `startServer` are both in the repo's code, which says nothing about a note on zsh.
  write(fx.userDir, "globalStorage/github.copilot-chat/memory-tool/memories/shell.md", [
    "# zsh: never use `port` as a variable name",
    "In zsh a variable called `port` breaks later commands, and `startServer` is a bad alias name.",
    "- Never alias `startServer`; it must stay a function.",
    "",
  ].join("\n"));
  const r = audit(fx);
  for (const needle of ["breaks later commands", "Never alias"]) {
    const e = entry(r, needle);
    assert.deepEqual([e.verdict, e.reason], ["keep-local", "user memory, shared across every repo"], needle);
  }
});

test("names this repo lacks are looked up in the repos next to it", () => {
  const fx = fixture();
  const sibling = (name, files) => {
    fs.mkdirSync(path.join(fx.base, name, ".git"), { recursive: true });
    for (const [f, content] of Object.entries(files)) write(fx.base, `${name}/${f}`, content);
  };
  sibling("demo-api", {
    "src/session.ts": "export const domain = process.env.SESSION_COOKIE_DOMAIN;\nexport const old = process.env.OLD_SESSION_SECRET;\nexport const shared_contract_rows = [];\nexport function sharedVerb() {}\n",
    "bin/tool.js": "// cli\n",
  });
  sibling("demo-cli", { "src/verbs.ts": "export function sharedVerb() {}\n" });
  sibling("demo-web", { "src/verbs.ts": "export function sharedVerb() {}\n" });
  const notes = write(fx.base, "nearby.md", [
    "# Nearby",
    "- Cross-subdomain deploys need SESSION_COOKIE_DOMAIN set.",
    "- Attestation rows land in shared_contract_rows on draft runs.",
    "- Run the tool with ../demo-api/bin/tool.js first.",
    "- `sharedVerb()` needs a JSON body.",
    "- Deploys also need UNKNOWN_EVERYWHERE_FLAG set.",
    "- `OLD_SESSION_SECRET` was removed.",
    "",
  ].join("\n"));
  const r = audit(fx, { files: [notes], agents: [] });
  const found = (needle) => entry(r, needle).findings.map((f) => `${f.type}: ${f.message}`);

  assert.deepEqual(found("Cross-subdomain"), ["misplaced: `SESSION_COOKIE_DOMAIN` isn't in demo-app; found in demo-api. Move this note to that repo's memory."]);
  assert.deepEqual(found("Attestation rows"), ["misplaced: `shared_contract_rows` isn't in demo-app; found in demo-api. Move this note to that repo's memory."]);
  assert.deepEqual(found("Run the tool"), ["misplaced: `../demo-api/bin/tool.js` isn't in demo-app; found in demo-api. Move this note to that repo's memory."]);
  // In three repos, so none of them is named as the home.
  assert.deepEqual(found("needs a JSON body"), ["misplaced: `sharedVerb` isn't in demo-app; found in demo-api, demo-cli, demo-web. Those repos share it, so move this note to the one that defines `sharedVerb`."]);
  // In no repo: an env var can be set outside the code, so it isn't called stale.
  const nowhere = entry(r, "UNKNOWN_EVERYWHERE_FLAG");
  assert.deepEqual([nowhere.verdict, nowhere.reason], ["review", "names `UNKNOWN_EVERYWHERE_FLAG`, but none of that could be checked against the repo"]);
  // The note itself says it is gone, so finding it next door proves nothing.
  assert.deepEqual(found("was removed"), []);

  const alone = audit(fx, { files: [notes], agents: [], siblings: false });
  assert.equal(entry(alone, "Cross-subdomain").verdict, "review");
});

test("a note that names a directory of this repo is about this repo, whatever else it uses", () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.base, "demo-api", ".git"), { recursive: true });
  write(fx.base, "demo-api/src/runs.ts", "export const validated_sha_column = 1;\n");
  write(fx.repo, "sample-api/server.js", "// nested service\n");
  write(fx.repo, "mem-audit/mem-audit.json", "{}\n");
  const notes = write(fx.base, "dirs.md", [
    "# Dirs",
    "- Read validated_sha_column, then in sample-api/: `git rev-parse HEAD` has to equal it.",
    "- Read validated_sha_column, then compare it with HEAD.",
    "- Read validated_sha_column w/ the newest run in other-api/ too.",
    "- Read validated_sha_column next to the files in mem-audit/ here.",
    "",
  ].join("\n"));
  const r = audit(fx, { files: [notes], agents: [] });
  const moved = ["misplaced: `validated_sha_column` isn't in demo-app; found in demo-api. Move this note to that repo's memory."];
  const found = (needle) => entry(r, needle).findings.map((f) => `${f.type}: ${f.message}`);

  const local = entry(r, "in sample-api/");
  assert.deepEqual(local.findings, []);
  assert.deepEqual(local.uses, [{ value: "validated_sha_column", repos: ["demo-api"] }]);
  assert.deepEqual(found("compare it with HEAD"), moved);
  // `w/` and `other-api/` aren't directories here, so they change nothing.
  const words = entry(r, "newest run");
  assert.deepEqual(found("newest run"), moved);
  assert.ok(!words.anchors.some((a) => a.kind === "dir"));
  // An earlier audit's output folder is on disk, but it isn't part of the repo.
  assert.deepEqual(found("files in mem-audit/"), moved);
});

test("NAME=value settings and plain files are recognised and checked", () => {
  const fx = fixture();
  write(fx.repo, "Dockerfile", "FROM node:22\nENV SKIP_DOWNLOAD=true\nENV CHROME_PATH=/usr/bin/chromium\n");
  write(fx.repo, "public/robots.txt", "User-agent: *\n");
  write(fx.repo, "public/sitemap.xml", "<urlset/>\n");
  const notes = write(fx.base, "settings.md", [
    "# Settings",
    "- Docker builder sets SKIP_DOWNLOAD=true + CHROME_PATH=/usr/bin/chromium.",
    "- Static discovery files in public/: robots.txt, sitemap.xml.",
    "- The edge proxy answers under /edge only.",
    "",
  ].join("\n"));
  const r = audit(fx, { files: [notes], agents: [] });

  const docker = entry(r, "Docker builder");
  assert.equal(docker.verdict, "repo-fact");
  assert.equal(docker.reason, "names `SKIP_DOWNLOAD`, `CHROME_PATH`, which the repo has; checked: `SKIP_DOWNLOAD=true` matches Dockerfile:2; `CHROME_PATH=/usr/bin/chromium` matches Dockerfile:3");
  assert.equal(entry(r, "Static discovery").reason, "names `robots.txt`, `sitemap.xml`, which the repo has");
  // A name was found, so the reason no longer claims there was nothing to check.
  assert.equal(entry(r, "edge proxy").reason, "names `/edge`, but none of that could be checked against the repo");
});

test("a name a note calls gone is reported when the code still has it", () => {
  const fx = fixture();
  const notes = write(fx.base, "gone.md", [
    "# Gone",
    "- Old (removed) helpers: `oldHelper` / `startServer` / `goneThing`.",
    "- Removed the retry loop from `src/server.ts`.",
    "- `oldHelper` was removed in favor of `startServer`.",
    "- `src/db.ts` is deprecated.",
    "",
  ].join("\n"));
  const r = audit(fx, { files: [notes], agents: [] });
  const found = (needle) => entry(r, needle).findings.filter((f) => f.type === "still-present").map((f) => f.message);

  assert.deepEqual(found("Old (removed) helpers"), ["says `startServer` is gone, but it is still at src/server.ts:2"]);
  // Where a thing was removed from, what replaced it, and a deprecation don't say a name is gone.
  for (const needle of ["retry loop", "in favor of", "is deprecated"]) assert.deepEqual(found(needle), [], needle);
  // The entry keeps its own verdict and isn't counted as wrong.
  assert.deepEqual([r.summary.still_present, r.summary.problems], [1, 0]);

  assert.match(renderText(r), /STILL-PRESENT \(1\) \u2014 says something is gone that the code still has/);
  const files = renderOutputFiles(r);
  const file = JSON.parse(files["agent-todos/still-present.json"]);
  assert.deepEqual([file.finding, file.count, file.entries[0].findings.length], ["still-present", 1, 1]);
  assert.equal(JSON.parse(files["summary.json"]).findings["still-present"].file, "agent-todos/still-present.json");
});

test("scripts/score.mjs scores an audit against hand labels", () => {
  const fx = fixture();
  const script = path.join(path.dirname(BIN), "..", "scripts", "score.mjs");
  const text = "- Run `npm run dev` to start `src/server.ts`.";
  const labels = path.join(fx.base, "labels");
  const label = (expect) => write(labels, "demo-app.json", JSON.stringify({
    labels: [{ label: "committed:AGENTS.md", line: 3, text_sha: crypto.createHash("sha256").update(text).digest("hex").slice(0, 12), expect, why: "it is right" }],
  }));
  const run = () => spawnSync(process.execPath, [script, fx.repo], { encoding: "utf8", env: { ...process.env, MEM_AUDIT_LABELS: labels } }).stdout;

  label(["fine"]);
  assert.match(run(), /^demo-app: 1\/1 agree \(100%\)\n {2}problem {3}0 of 0 found, 0 flagged that shouldn't be\n/);
  label(["problem"]);
  assert.match(run(), /^demo-app: 0\/1 agree \(0%\)\n {2}problem {3}0 of 1 found[\s\S]*- committed:AGENTS\.md:3 {2}expected problem, got repo-fact {2}\(it is right\)/);
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

test("CLI: every run writes the audit folder; --out moves it, --no-out skips it", () => {
  const fx = fixture();
  const base = [BIN, fx.repo, "--vscode-user-dir", fx.userDir, "--claude-home", fx.claudeHome];
  const opts = { encoding: "utf8", cwd: fx.base };
  const dir = path.join(fx.repo, "mem-audit");
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

  // Leftovers from an earlier run: a verdict that no longer applies and the old flat layout go, anything else stays.
  write(dir, "agent-todos/narrowed.json", "{}");
  write(dir, "stale.json", "{}");
  write(dir, "notes.txt", "mine");

  const text = spawnSync(process.execPath, base, opts);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /Audit files: demo-app\/mem-audit\//);
  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), "*\n");
  assert.ok(!fs.existsSync(path.join(dir, "agent-todos", "narrowed.json")));
  // summary.json and mem-audit.json are the only audit files outside the two folders.
  assert.deepEqual(fs.readdirSync(dir).sort(), [".gitignore", "agent-todos", "audit-ready", "mem-audit.json", "notes.txt", "summary.json"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "audit-ready")), ["keep-local.json"]);
  const folderOf = (v) => (v === "guidance" || v === "keep-local" ? "audit-ready" : "agent-todos");

  const full = read("mem-audit.json");
  assert.equal(full.tool, "mem-audit");
  const summary = read("summary.json");
  assert.deepEqual(summary.summary, full.summary);
  assert.equal(summary.full, "mem-audit.json");
  // Not a git repo, so only the memory hashes identify the run.
  assert.deepEqual([summary.state.commit, summary.state.dirty], [null, null]);
  assert.match(summary.state.memory["copilot:repo/notes.md"], /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(full.state, summary.state);
  assert.deepEqual(summary.folders, { "agent-todos": "notes with something to do; each file's `action` says what", "audit-ready": "notes that need no change" });
  for (const [v, count] of Object.entries(full.summary.counts)) {
    const rel = `${folderOf(v)}/${v}.json`;
    assert.deepEqual([summary.verdicts[v].file, summary.verdicts[v].count], [rel, count], v);
    const file = read(rel);
    assert.deepEqual([file.verdict, file.count, file.entries.length], [v, count, count], v);
    assert.ok(file.meaning && file.action, v);
    for (const e of file.entries) {
      assert.deepEqual(Object.keys(e), ["label", "path", "line", "section", "text", "reason", "findings"]);
      assert.ok(e.reason, `${v} entry without a reason`);
      assert.ok(path.isAbsolute(e.path));
    }
  }
  const stale = read("agent-todos/stale.json");
  assert.ok(stale.entries.some((e) => e.text.includes("src/legacy.ts")));
  for (const d of ["", "agent-todos", "audit-ready"]) {
    for (const name of fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith(".json"))) {
      assert.ok(!fs.readFileSync(path.join(dir, d, name), "utf8").includes(FAKE_STRIPE), name);
    }
  }

  // The previous audit sitting in the repo must not satisfy anchors on the next run.
  const again = JSON.parse(spawnSync(process.execPath, [...base, "--json"], opts).stdout);
  assert.deepEqual(again.summary, full.summary);
  assert.deepEqual(again.state, full.state);

  // An edited memory file changes its hash, so a reader can tell the audit is out of date.
  const memPath = full.files.find((f) => f.label === "copilot:repo/notes.md").path;
  fs.appendFileSync(memPath, "- another note\n");
  const after = JSON.parse(spawnSync(process.execPath, [...base, "--json"], opts).stdout);
  assert.notEqual(after.state.memory["copilot:repo/notes.md"], full.state.memory["copilot:repo/notes.md"]);

  spawnSync(process.execPath, [...base, "--out", "reports/audit"], opts);
  assert.ok(fs.existsSync(path.join(fx.base, "reports", "audit", "summary.json")));

  fs.rmSync(dir, { recursive: true });
  spawnSync(process.execPath, [...base, "--no-out"], opts);
  assert.ok(!fs.existsSync(dir));
});

test("CLI: --help lists every option; --help <option> describes it", () => {
  const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: "utf8" });
  const all = run("--help");
  assert.equal(all.status, 0);
  for (const flag of ["--agent", "--file", "--related", "--no-siblings", "--exclude", "--no-repo", "--json", "--out", "--no-out", "--verbose", "--fail-on", "--list", "--no-hint", "--vscode-user-dir", "--claude-home", "--version"]) {
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
