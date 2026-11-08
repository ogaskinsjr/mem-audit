#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAudit, SOURCES } from "../src/index.js";
import { VERDICTS } from "../src/classify.js";
import { findOption, renderHelp, renderOptionHelp } from "../src/help.js";
import { renderJson, renderText } from "../src/report.js";

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

const HELP = renderHelp(pkg.version);

function usage(msg) {
  fs.writeSync(2, `mem-audit: ${msg}\n\n${HELP}`);
  process.exit(2);
}

// `--help` lists everything; `--help --related` (or `--related --help`, `--help related`) describes those options.
function handleHelp(argv) {
  const at = argv.findIndex((a) => a === "-h" || a === "--help");
  if (at === -1) return;
  const asked = [];
  argv.forEach((a, i) => {
    if (i === at || a === "-h" || a === "--help") return;
    const named = a.startsWith("-") || i === at + 1;
    if (!named) return;
    const o = findOption(a);
    if (!o) usage(`unknown option ${a}`);
    if (!asked.includes(o)) asked.push(o);
  });
  fs.writeSync(1, asked.length ? renderOptionHelp(asked) : HELP);
  process.exit(0);
}

function parseArgs(argv) {
  handleHelp(argv);
  const o = { root: ".", related: [], files: [], exclude: [], agents: SOURCES, json: false, verbose: false, failOn: [], list: false, hint: true, noRepo: false, out: "mem-audit.json", vscodeUserDirs: undefined, claudeHome: undefined };
  let rootSet = false;
  const value = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) usage(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-v": case "--version": fs.writeSync(1, `${pkg.version}\n`); process.exit(0);
      case "--json": o.json = true; break;
      case "--verbose": o.verbose = true; break;
      case "--list": o.list = true; break;
      case "--no-hint": o.hint = false; break;
      case "--no-repo": o.noRepo = true; break;
      case "--out": o.out = value(i, a); i++; break;
      case "--no-out": o.out = null; break;
      case "--file": o.files.push(value(i, a)); i++; break;
      case "--exclude": o.exclude.push(value(i, a)); i++; break;
      case "--claude-home": o.claudeHome = path.resolve(value(i, a)); i++; break;
      case "--vscode-user-dir": (o.vscodeUserDirs ??= []).push(path.resolve(value(i, a))); i++; break;
      case "--agent": {
        const list = value(i, a).split(",").map((s) => s.trim()).filter(Boolean);
        const bad = list.filter((s) => !SOURCES.includes(s));
        if (bad.length) usage(`unknown --agent ${bad.join(", ")}`);
        o.agents = list;
        i++;
        break;
      }
      case "--fail-on": {
        const list = value(i, a).split(",").map((s) => s.trim()).filter(Boolean);
        const bad = list.filter((s) => !VERDICTS.includes(s));
        if (bad.length) usage(`unknown --fail-on verdict ${bad.join(", ")}`);
        o.failOn = list;
        i++;
        break;
      }
      case "--related": {
        let n = 0;
        while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { o.related.push(argv[++i]); n++; }
        if (!n) usage("--related needs at least one directory");
        break;
      }
      default:
        if (a.startsWith("-")) usage(`unknown option ${a}`);
        if (rootSet) usage(`unexpected argument ${a}`);
        o.root = a;
        rootSet = true;
    }
  }
  for (const d of [o.root, ...o.related]) {
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) usage(`not a directory: ${d}`);
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const outPath = opts.out ? path.resolve(opts.out) : null;
const result = runAudit({ ...opts, ignore: outPath ? [outPath] : [] });

if (opts.list) {
  if (opts.json) process.stdout.write(`${JSON.stringify(result.files.map(({ label, path: p, source, scope }) => ({ label, path: p, source, scope })), null, 2)}\n`);
  else for (const f of result.files) process.stdout.write(`${f.label}\t${f.path}\n`);
} else {
  const json = renderJson(result, { version: pkg.version });
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${json}\n`);
  }
  const shownOut = outPath && path.relative(process.cwd(), outPath);
  process.stdout.write(`${opts.json ? json : renderText(result, { verbose: opts.verbose, hint: opts.hint, version: pkg.version, outPath: shownOut })}\n`);
  // exitCode (not exit()) so piped stdout is fully flushed.
  process.exitCode = opts.failOn.some((v) => result.summary.counts[v]) ? 1 : 0;
}
