// Memory checked against itself: values that disagree between entries, things one
// entry says were removed while another still describes them, and duplicates.
// Detection keys on anchors and values, never on one model's wording; the removal
// lexicon only scopes which sentence a removal applies to.
import { extractAnchors } from "./anchors.js";
import { extractFacts, normValue } from "./facts.js";
import { hasWord } from "./repo.js";

const REMOVAL_RE = /\b(?:removed|removing|deleted|deleting|dropped|dropping|gone|deprecated|obsolete|outdated|retired|sunset|ripped out|killed|no longer|replaces|replacing|replaced (?:by|with)|superseded|supersedes|instead of|in favou?r of|renamed|moved to|switched (?:from|to))\b|~~[^~]+~~/i;
const DATE_RE = /\b(20\d\d-\d\d-\d\d)\b/g;
const REMOVABLE = new Set(["path", "symbol", "identifier", "env", "script", "flag", "token", "route"]);
export const PROBLEM_TYPES = new Set(["secret", "contradiction", "stale", "superseded", "conflict"]);

const where = (e) => `${e.label}:${e.line}`;

// Anchors an entry itself reports as removed/replaced (sentence-scoped).
export function removalAnchors(text) {
  const out = [];
  // Wrapped lines belong to the same sentence.
  for (const sentence of text.replace(/\n\s*/g, " ").split(/(?<=[.;!?])\s+/)) {
    if (!REMOVAL_RE.test(sentence)) continue;
    for (const a of extractAnchors(sentence)) {
      if (!REMOVABLE.has(a.kind)) continue;
      if (a.kind === "route" && a.value.split("/").filter(Boolean).length < 2) continue;
      out.push(a);
    }
  }
  return out;
}

export function addFinding(e, f) {
  if (!e.findings.some((x) => x.type === f.type && x.message === f.message)) e.findings.push(f);
}

// Newest date stated in the entry, else in its nearest dated heading.
export function entryDate(e) {
  const latest = (s) => [...s.matchAll(DATE_RE)].map((m) => m[1]).sort().pop() ?? null;
  const own = latest(e.text);
  if (own) return own;
  for (let i = e.section.length - 1; i >= 0; i--) {
    const d = latest(e.section[i]);
    if (d) return d;
  }
  return null;
}

function factLabel(f) {
  switch (f.type) {
    case "env": return `\`${f.subject}\` default`;
    case "port": return `${f.subject} port`;
    case "version": return `${f.subject} version`;
    case "count": return `${f.subject} check count`;
    default: return `${f.subject} default`;
  }
}

function checkFacts(entries, repos) {
  const envRepo = new Map();
  for (const r of repos) {
    for (const [name, vals] of r.envDefaults) {
      if (!envRepo.has(name)) envRepo.set(name, new Map());
      for (const [v, repo] of vals) {
        const n = normValue("env", v, name);
        if (!envRepo.get(name).has(n)) envRepo.get(name).set(n, { value: v, repo });
      }
    }
  }
  const versionRepo = new Map();
  for (const r of repos) for (const [n, v] of r.versions) if (!versionRepo.has(n)) versionRepo.set(n, { value: v, repo: r.name });

  const groups = new Map();
  for (const e of entries) {
    for (const f of extractFacts(e)) {
      let decided = false;
      if (f.type === "env" && envRepo.has(f.subject)) {
        decided = true;
        const known = envRepo.get(f.subject);
        // A bare `VAR=value` may describe a valid setting rather than the default.
        const validSetting = !f.explicit && repos.some((r) => hasWord(r.code, f.value));
        if (!known.has(f.norm) && !validSetting) {
          const first = [...known.values()][0];
          addFinding(e, { type: "contradiction", message: `\`${f.subject}\` default is \`${f.value}\` here, but the code says \`${first.value}\` (${first.repo})` });
        }
      }
      if (f.type === "version" && versionRepo.has(f.subject)) {
        decided = true;
        const k = versionRepo.get(f.subject);
        if (normValue("version", k.value) !== f.norm) {
          addFinding(e, { type: "contradiction", message: `${f.subject} is ${f.value} here, but its package.json says ${k.value} (${k.repo})` });
        }
      }
      const key = `${f.type}\u0000${f.subject}`;
      if (!groups.has(key)) groups.set(key, { decided: false, items: [] });
      const g = groups.get(key);
      g.decided ||= decided;
      g.items.push({ f, e });
    }
  }

  for (const g of groups.values()) {
    // The repo already ruled on these values; memory-vs-memory adds nothing.
    if (g.decided) continue;
    if (new Set(g.items.map((i) => i.f.norm)).size < 2) continue;
    if (new Set(g.items.map((i) => i.e)).size < 2) continue;

    const dated = g.items.map((i) => ({ ...i, d: entryDate(i.e) }));
    if (dated.every((i) => i.d)) {
      const max = dated.reduce((a, b) => (a.d >= b.d ? a : b)).d;
      const newest = dated.filter((i) => i.d === max);
      if (new Set(newest.map((i) => i.f.norm)).size === 1) {
        const w = newest[0];
        for (const i of dated) {
          if (i.f.norm === w.f.norm) continue;
          addFinding(i.e, { type: "superseded", message: `${factLabel(i.f)} is \`${i.f.value}\` here; newer ${where(w.e)} (${w.d}) says \`${w.f.value}\``, ref: where(w.e) });
        }
        continue;
      }
    }
    for (const i of g.items) {
      const other = g.items.find((o) => o.f.norm !== i.f.norm);
      addFinding(i.e, { type: "conflict", message: `${factLabel(i.f)} is \`${i.f.value}\` here but \`${other.f.value}\` at ${where(other.e)}`, ref: where(other.e) });
    }
  }
}

function checkRemovals(entries, resolve) {
  const byValue = new Map();
  for (const e of entries) {
    for (const a of e.anchors) {
      if (!REMOVABLE.has(a.kind)) continue;
      if (!byValue.has(a.value)) byValue.set(a.value, new Set());
      byValue.get(a.value).add(e);
    }
  }

  const removedIn = new Map();
  const records = [];
  for (const e of entries) {
    for (const a of removalAnchors(e.text)) {
      // Still in the repo: the removal was partial or about something else — the repo wins.
      const r = resolve(a);
      if (r.status === "resolved") continue;
      if (!removedIn.has(e)) removedIn.set(e, new Set());
      removedIn.get(e).add(a.value);
      records.push({ R: e, a, confirmed: r.status === "missing" });
    }
  }

  for (const { R, a, confirmed } of records) {
    for (const E of byValue.get(a.value) ?? []) {
      if (E === R || removedIn.get(E)?.has(a.value)) continue;
      const dR = entryDate(R);
      const dE = entryDate(E);
      if (confirmed || (dR && (!dE || dR >= dE))) {
        addFinding(E, { type: "superseded", message: `\`${a.value}\` was removed per ${where(R)}${dR ? ` (${dR})` : ""}`, ref: where(R) });
      } else if (dR && dE && dE > dR) {
        continue;
      } else {
        addFinding(E, { type: "conflict", message: `${where(R)} says \`${a.value}\` was removed`, ref: where(R) });
        addFinding(R, { type: "conflict", message: `${where(E)} still describes \`${a.value}\``, ref: where(E) });
      }
    }
  }
}

// Everything under a superseded heading inherits it (until the next heading at the same level).
function propagateSections(entries) {
  for (let i = 0; i < entries.length; i++) {
    const h = entries[i];
    if (h.kind !== "heading" || !h.findings.some((f) => f.type === "superseded")) continue;
    for (let j = i + 1; j < entries.length && entries[j].file === h.file; j++) {
      const c = entries[j];
      if (c.kind === "heading" && c.level <= h.level) break;
      if (c.findings.some((f) => PROBLEM_TYPES.has(f.type))) continue;
      // Unrelated facts filed under the heading still check out against the repo.
      if (c.anchors.some((a) => a.status === "resolved" && (a.kind === "path" || a.kind === "script"))) continue;
      addFinding(c, { type: "superseded", message: `under superseded heading ${where(h)}`, ref: where(h) });
    }
  }
}

function checkDuplicates(entries) {
  const norm = (t) => t.toLowerCase().replace(/[`*_#>|[\]()~-]+/g, " ").replace(/\s+/g, " ").trim();
  const items = entries
    .filter((e) => e.kind !== "heading" && e.kind !== "code")
    .map((e) => {
      const n = norm(e.text);
      return { e, n, toks: new Set(n.split(" ").filter((w) => w.length > 2)) };
    })
    .filter((i) => i.toks.size >= 8);

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i];
      const B = items[j];
      let dup = A.n === B.n;
      if (!dup) {
        const [small, big] = A.toks.size <= B.toks.size ? [A.toks, B.toks] : [B.toks, A.toks];
        if (small.size / big.size < 0.9) continue;
        let inter = 0;
        for (const t of small) if (big.has(t)) inter++;
        dup = inter / (A.toks.size + B.toks.size - inter) >= 0.9;
      }
      if (dup) addFinding(B.e, { type: "duplicate", message: `duplicates ${where(A.e)}`, ref: where(A.e) });
    }
  }
}

export function checkConsistency(entries, repos, resolve) {
  checkFacts(entries, repos);
  checkRemovals(entries, resolve);
  propagateSections(entries);
  checkDuplicates(entries);
}
