import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROBLEM_VERDICTS } from "../src/classify.js";
import { runAudit } from "../src/index.js";

const LABELS_DIR = process.env.MEM_AUDIT_LABELS ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "labels");
const CLASSES = ["problem", "elsewhere"];
const textSha = (t) => crypto.createHash("sha256").update(t).digest("hex").slice(0, 12);
const classOf = (v) => (PROBLEM_VERDICTS.has(v) ? "problem" : v === "misplaced" ? "elsewhere" : "fine");
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "n/a");
const where = (e) => `${e.label}:${e.line}`;

function load(root) {
  const abs = path.resolve(root);
  const file = path.join(LABELS_DIR, `${path.basename(abs)}.json`);
  const labels = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).labels : [];
  const { entries } = runAudit({ root, ignore: [path.join(abs, "mem-audit")] });
  const byKey = new Map(entries.map((e) => [`${e.label}\u0000${textSha(e.text)}`, e]));
  return { labels, entries, find: (l) => byKey.get(`${l.label}\u0000${l.text_sha}`) };
}

const allows = (expect, cls) => expect.some((x) => x === cls || (x !== "fine" && !CLASSES.includes(x) && classOf(x) === cls));

function score(root) {
  const { labels, entries, find } = load(root);
  const t = { name: path.basename(path.resolve(root)), scored: 0, agree: 0, unsure: 0, stale: 0, wrong: [] };
  for (const c of CLASSES) t[c] = { want: 0, hit: 0, extra: 0 };
  const seen = new Set();
  for (const l of labels) {
    const e = find(l);
    if (!e) { t.stale++; continue; }
    seen.add(e);
    if (!l.expect?.length) { t.unsure++; continue; }
    const got = classOf(e.verdict);
    const ok = l.expect.includes(e.verdict) || l.expect.includes(got);
    t.scored++;
    if (ok) t.agree++;
    else t.wrong.push(`${where(e)}  expected ${l.expect.join(" or ")}, got ${e.verdict}${l.why ? `  (${l.why})` : ""}`);
    for (const c of CLASSES) {
      const only = allows(l.expect, c) && !allows(l.expect, "fine") && CLASSES.every((o) => o === c || !allows(l.expect, o));
      if (only) { t[c].want++; if (got === c) t[c].hit++; }
      if (got === c && !allows(l.expect, c)) t[c].extra++;
    }
  }
  t.unlabelled = entries.filter((e) => e.verdict !== "heading" && !seen.has(e)).length;
  return t;
}

function print(t) {
  const L = [`${t.name}: ${t.agree}/${t.scored} agree (${pct(t.agree, t.scored)})`];
  for (const c of CLASSES) L.push(`  ${c.padEnd(9)} ${t[c].hit} of ${t[c].want} found, ${t[c].extra} flagged that shouldn't be`);
  const skipped = [t.unsure && `${t.unsure} labelled unsure`, t.unlabelled && `${t.unlabelled} not labelled`, t.stale && `${t.stale} labels no longer match an entry`].filter(Boolean);
  if (skipped.length) L.push(`  not scored: ${skipped.join(", ")}`);
  for (const w of t.wrong) L.push(`  - ${w}`);
  return L.join("\n");
}

const args = process.argv.slice(2);
const roots = args.filter((a) => !a.startsWith("--"));
if (!roots.length) {
  process.stderr.write("usage: node scripts/score.mjs [--new] <repo>...\n  --new  print label stubs for entries that have no label yet\n");
  process.exit(2);
}
if (args.includes("--new")) {
  for (const root of roots) {
    const { labels, entries, find } = load(root);
    const seen = new Set(labels.map(find));
    const stubs = entries.filter((e) => e.verdict !== "heading" && !seen.has(e))
      .map((e) => ({ label: e.label, line: e.line, text_sha: textSha(e.text), expect: [], why: "", text: e.text.replace(/\s+/g, " ").slice(0, 100) }));
    process.stdout.write(`${JSON.stringify(stubs, null, 2)}\n`);
  }
} else {
  const all = roots.map(score);
  const total = { name: "total", scored: 0, agree: 0, unsure: 0, stale: 0, unlabelled: 0, wrong: [] };
  for (const c of CLASSES) total[c] = { want: 0, hit: 0, extra: 0 };
  for (const t of all) {
    for (const k of ["scored", "agree", "unsure", "stale", "unlabelled"]) total[k] += t[k];
    for (const c of CLASSES) for (const k of ["want", "hit", "extra"]) total[c][k] += t[c][k];
  }
  process.stdout.write(`${[...all, ...(all.length > 1 ? [total] : [])].map(print).join("\n\n")}\n`);
}
