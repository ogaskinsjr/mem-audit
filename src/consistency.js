import { extractAnchors } from "./anchors.js";
import { conditionsIn, contentWords, extractFacts, idWords, normPhrase, normValue } from "./facts.js";
import { hasWord } from "./repo.js";

const REMOVAL_RE = /\b(?:removed|removing|deleted|deleting|dropped|dropping|gone|deprecated|obsolete|outdated|retired|sunset|ripped out|killed|no longer|superseded(?! by)|renamed)\b|~~[^~]+~~/i;
// Directional verbs retire one side only: "A replaces B" retires B, "A replaced by B" retires A.
const OLD_AFTER_RE = /\b(?:replaces|replacing|supersedes|instead of|switched from)\b/gi;
const OLD_BEFORE_RE = /\b(?:replaced (?:by|with)|superseded by|in favou?r of|switched to|moved to)\b/gi;
const CLAUSE_BREAK = /[,;—–]/;
// "NOT SSR — renderToString would crash", "x.yml — not in repo tree": the entry itself says it's absent.
const ABSENT_RE = /\b(?:not|never|don'?t|doesn'?t|isn'?t|aren'?t|won'?t|can'?t|cannot|avoid(?:s|ed)?|phantom|non-?existent|would (?:crash|break|fail))\b/i;
const ABSENT_WINDOW = 3;
// Words that say a thing is gone for good; deprecated or renamed things are often still in the code.
const GONE_RE = /\b(?:removed|deleted|dropped|gone|ripped out|killed|no longer (?:exists?|used|needed|present))\b/gi;
// Between "removed" and a name these don't count as words...
const FILLER_WORDS = new Set(["the", "a", "an", "was", "were", "is", "are", "been", "has", "have", "had", "got", "now", "all", "both"]);
// ...and these mean the name is where something was removed from, not what was removed.
const PLACE_WORDS = new Set([
  "from", "in", "of", "to", "by", "with", "for", "on", "at", "into", "onto", "via", "per", "than", "as", "since", "after", "before",
  "when", "while", "under", "over", "inside", "within", "without", "through", "during", "between", "across", "against", "using",
  "favor", "favour", "out", "off",
]);
const LIST_GAP_RE = /^[\s`'"*_]*(?:[/+&]|and|or)[\s`'"*_]*$/i;
const DATE_RE = /\b(20\d\d-\d\d-\d\d)\b/g;
const REMOVABLE = new Set(["path", "symbol", "identifier", "env", "script", "flag", "token", "route"]);
export const PROBLEM_TYPES = new Set(["secret", "contradiction", "stale", "superseded", "conflict"]);

// A later heading that says a problem was settled, or a later sentence that takes an idea back.
const SETTLED_HEAD_RE = /(?<![\w-])(?:confirmed|fixed|resolved|solved|the fix|fix that works?|real reason|root cause|actual cause)(?![\w-])/i;
const RETRACTED_RE = /\b(?:was|were|proved|turned out(?: to be)?)\s+(?:wrong|incorrect|mistaken)\b/i;
// Wording of a note about something still open or unsure.
const OPEN_RE = /\b(?:blocked|blockers?|remaining gap|unproven|unresolved|unsolved|not (?:yet )?(?:fixed|solved|resolved|working)|possibly|maybe|may be (?:required|needed|relevant)|might be|theory|hypothesis|suspect(?:ed)?|prevents?)\b/i;
const MARKER_WORDS = new Set(["confirmed", "fixed", "resolved", "solved", "work", "real", "reason", "root", "cause", "actual"]);
// "used only for X": a claim about every use of a name, which the code can count.
const ONLY_USE_RE = /\b(?:used|read|referenced|called|needed|consumed|imported|set)\s+only\b|\bonly\s+(?:used|read|referenced|called|needed|consumed|imported|set)\b/i;
const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|php|cs|swift|sh|vue|svelte)$/i;
const NOT_A_USE_RE = /\.d\.[cm]?ts$|(?:^|\/)(?:tests?|__tests__|spec|fixtures?)\/|\.(?:test|spec)\./i;
const CLAUSE_SPLIT_RE = /(?<=[.!?])\s+|;\s*|,\s+|\s+[—–]\s+/;
const NUMBER_RE = /(?<![\w.])\d+(?:\.\d+)?/g;
const NAMED_KINDS = new Set(["path", "symbol", "env", "route"]);
// A command is one name; its words ("npm", "run") say nothing about what a note claims.
const COMMAND_RE = /\b(?:npm|pnpm|yarn|npx)\s+(?:run(?:-script)?\s+)?[\w:.@/-]+/gi;
// So is a path or URL, however many words it holds; "grace/licensed" is two words, not a path.
const PATHLIKE_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s)'"`,;]+|(?<![\w/.])[\w.@~<>{}-]*(?:\/[\w.@~<>{}*:-]+)+/gi;
const isPathLike = (t) => t.length > 1 && (t[0] === "/" || t.includes(".") || t.split("/").length > 2);

const where = (e) => `${e.label}:${e.line}`;

// Wrapped lines belong to the same sentence.
const sentences = (text) => text.replace(/\n\s*/g, " ").split(/(?<=[.;!?])\s+/);
const words = (s) => s.split(/\s+/).filter(Boolean);

function removalScopes(sentence) {
  if (REMOVAL_RE.test(sentence)) return [sentence];
  const scopes = [];
  for (const m of sentence.matchAll(OLD_AFTER_RE)) {
    const rest = sentence.slice(m.index + m[0].length);
    const end = rest.search(CLAUSE_BREAK);
    scopes.push(end === -1 ? rest : rest.slice(0, end));
  }
  for (const m of sentence.matchAll(OLD_BEFORE_RE)) {
    const head = sentence.slice(0, m.index);
    let start = head.length - 1;
    while (start >= 0 && !CLAUSE_BREAK.test(head[start])) start--;
    scopes.push(head.slice(start + 1));
  }
  return scopes;
}

// Anchors an entry itself reports as removed/replaced (sentence-scoped).
export function removalAnchors(text) {
  const out = [];
  for (const sentence of sentences(text)) {
    // "replaces X for new jobs only" retires X for some cases, not everywhere.
    if (conditionsIn(sentence, true)) continue;
    for (const scope of removalScopes(sentence)) {
      for (const a of extractAnchors(scope)) {
        if (!REMOVABLE.has(a.kind)) continue;
        if (a.kind === "route" && a.value.split("/").filter(Boolean).length < 2) continue;
        out.push(a);
      }
    }
  }
  return out;
}

// Anchors with a negation right next to them.
export function absentAnchors(text) {
  const out = [];
  for (const sentence of sentences(text)) {
    if (!ABSENT_RE.test(sentence)) continue;
    for (const a of extractAnchors(sentence)) {
      const i = sentence.indexOf(a.value);
      if (i === -1) continue;
      const near = [...words(sentence.slice(0, i)).slice(-ABSENT_WINDOW), ...words(sentence.slice(i + a.value.length)).slice(0, ABSENT_WINDOW)];
      if (ABSENT_RE.test(near.join(" "))) out.push(a);
    }
  }
  return out;
}

export function addFinding(e, f) {
  if (!e.findings.some((x) => x.type === f.type && x.message === f.message)) e.findings.push(f);
}

function gapOk(text, maxWords) {
  if (CLAUSE_BREAK.test(text)) return false;
  const ws = text.toLowerCase().match(/[a-z][\w'-]*/g) ?? [];
  return !ws.some((w) => PLACE_WORDS.has(w)) && ws.filter((w) => !FILLER_WORDS.has(w)).length <= maxWords;
}

// Names a sentence says outright are gone: right after "removed", or just before "was removed",
// plus the rest of a list they belong to ("`A` / `B` / `C`"). Far stricter than removalAnchors.
function saidGone(sentence) {
  const spots = [];
  for (const a of extractAnchors(sentence)) {
    if (!REMOVABLE.has(a.kind)) continue;
    const start = sentence.indexOf(a.value);
    if (start !== -1) spots.push({ a, start, end: start + a.value.length });
  }
  spots.sort((x, y) => x.start - y.start);
  const picked = new Set();
  for (const m of sentence.matchAll(GONE_RE)) {
    const end = m.index + m[0].length;
    const after = spots.findIndex((s) => s.start >= end);
    if (after !== -1 && gapOk(sentence.slice(end, spots[after].start), 2)) picked.add(after);
    const before = spots.findLastIndex((s) => s.end <= m.index);
    if (before !== -1 && gapOk(sentence.slice(spots[before].end, m.index), 0)) picked.add(before);
  }
  for (let grew = picked.size > 0; grew;) {
    grew = false;
    for (const i of [...picked]) {
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= spots.length || picked.has(j)) continue;
        const [l, r] = j < i ? [spots[j], spots[i]] : [spots[i], spots[j]];
        if (LIST_GAP_RE.test(sentence.slice(l.end, r.start))) { picked.add(j); grew = true; }
      }
    }
  }
  return [...picked].sort((x, y) => x - y).map((i) => spots[i].a);
}

// Where the code still has a name; docs don't count, they lag behind the code.
function stillAt(a, repos) {
  for (const r of repos) {
    if (a.kind === "path") {
      const p = a.value.replace(/^\.\//, "").replace(/\/$/, "");
      const hit = r.files.has(p) || r.dirs.has(p) ? p : [...r.files].find((f) => f.endsWith(`/${p}`));
      if (hit) return hit;
    } else if (a.kind === "script") {
      if (r.scripts.has(a.value)) return "the package.json scripts";
    } else {
      for (const { file, lines } of r.codeFiles) {
        const i = lines.findIndex((l) => hasWord(l, a.value));
        if (i !== -1) return `${file}:${i + 1}`;
      }
    }
  }
  return null;
}

// A note says a thing is gone and the code still has it: the removal wasn't finished, or the note is wrong.
function checkStillPresent(entries, repos) {
  if (!repos.length) return;
  for (const e of entries) {
    if (e.kind === "heading" || e.scope === "user" || e.sectionLocal) continue;
    for (const sentence of sentences(e.text)) {
      for (const a of saidGone(sentence)) {
        const at = stillAt(a, repos);
        if (at) addFinding(e, { type: "still-present", message: `says \`${a.value}\` is gone, but it is still at ${at}` });
      }
    }
  }
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
    case "prose": return f.subject;
    default: return `${f.subject} default`;
  }
}

// In how many entries each word appears (headings aside).
function docFrequency(entries) {
  const df = new Map();
  let n = 0;
  for (const e of entries) {
    if (e.kind === "heading") continue;
    n++;
    for (const w of new Set(contentWords(e.text))) df.set(w, (df.get(w) ?? 0) + 1);
  }
  return { df, n };
}

// Words used across a large share of this memory are too generic to identify a subject on their own.
function commonWords(entries) {
  const { df, n } = docFrequency(entries);
  return new Set([...df].filter(([, c]) => c >= 5 && c / n > 0.2).map(([w]) => w));
}

const specific = (f, common) => f.type !== "prose" || f.code || (f.subject.includes(" ") && f.subject.split(" ").some((w) => !common.has(w)));
const dated = (i) => (i.d ? ` (${i.d})` : "");

// The newest row when every row is dated and the newest agree; otherwise null.
function newestOf(list) {
  if (!list.every((i) => i.d)) return null;
  const max = list.reduce((a, b) => (a.d >= b.d ? a : b)).d;
  const top = list.filter((i) => i.d === max);
  return new Set(top.map((i) => i.f.norm)).size === 1 ? top[0] : null;
}

// Rows of one subject: explicit "(was X)" first, then dates within each condition, then scoped vs general.
function compareRows(rows) {
  const done = new Set();
  const superseded = (E, msg, R) => {
    addFinding(E.e, { type: "superseded", message: `${factLabel(E.f)} is \`${E.f.value}\` here; ${msg}`, ref: where(R.e) });
    done.add(E);
  };
  const narrowed = (U, S) => addFinding(U.e, {
    type: "narrowed",
    message: `${factLabel(U.f)} is \`${U.f.value}\` here; superseded for ${S.f.cond} by ${where(S.e)}${dated(S)}, which says \`${S.f.value}\`; still applies otherwise`,
    ref: where(S.e),
  });
  const conflict = (A, B, msg) => {
    addFinding(A.e, { type: "conflict", message: msg(A, B), ref: where(B.e) });
    addFinding(B.e, { type: "conflict", message: msg(B, A), ref: where(A.e) });
  };

  for (const R of rows) {
    for (const E of rows) {
      if (E.e === R.e || E.f.norm === R.f.norm || !R.f.replaces.includes(E.f.norm)) continue;
      if (E.f.cond && E.f.cond !== R.f.cond) continue;
      if (R.d && E.d && E.d > R.d) {
        conflict(E, R, (a, b) => `${factLabel(a.f)} is \`${a.f.value}\` here${dated(a)}; ${where(b.e)}${dated(b)} says \`${b.f.value}\`, and the record claiming the replacement is the older one`);
        done.add(E);
      } else if (E.f.cond === R.f.cond) {
        superseded(E, `replaced by ${where(R.e)}${dated(R)}, which says \`${R.f.value}\` (was \`${E.f.value}\`)`, R);
      } else {
        narrowed(E, R);
        done.add(E);
      }
    }
  }

  const byCond = new Map();
  for (const i of rows) {
    if (done.has(i)) continue;
    if (!byCond.has(i.f.cond)) byCond.set(i.f.cond, []);
    byCond.get(i.f.cond).push(i);
  }
  const winners = new Map();
  for (const [cond, list] of byCond) {
    if (new Set(list.map((i) => i.f.norm)).size < 2) {
      winners.set(cond, list.reduce((a, b) => ((b.d ?? "") > (a.d ?? "") ? b : a)));
      continue;
    }
    const w = newestOf(list);
    winners.set(cond, w);
    if (w) {
      for (const i of list) if (i.f.norm !== w.f.norm) superseded(i, `newer ${where(w.e)}${dated(w)} says \`${w.f.value}\``, w);
      continue;
    }
    if (new Set(list.map((i) => i.e)).size < 2) continue;
    for (const i of list) {
      const other = list.find((o) => o.f.norm !== i.f.norm);
      addFinding(i.e, { type: "conflict", message: `${factLabel(i.f)} is \`${i.f.value}\` here but \`${other.f.value}\` at ${where(other.e)}`, ref: where(other.e) });
    }
  }

  // A scoped row narrows the general rule, unless the general rule was restated after it.
  for (const [cond, S] of winners) {
    if (!cond || !S) continue;
    for (const U of byCond.get("") ?? []) {
      if (done.has(U) || U.e === S.e || U.f.norm === S.f.norm) continue;
      if (U.d && S.d && U.d > S.d) {
        conflict(U, S, (a, b) => `${factLabel(a.f)} is \`${a.f.value}\` here${dated(a)} but \`${b.f.value}\`${b.f.cond ? ` for ${b.f.cond}` : ""} at ${where(b.e)}${dated(b)}`);
      } else {
        narrowed(U, S);
      }
    }
  }
}

/**
 * What memory says `subject` is under `cond` ("" = no condition), and which rows that overrides.
 * @returns {{status: "resolved", value: string, from: string, superseded: string[]} | {status: "unresolved", candidates: string[]} | {status: "none"}}
 */
export function resolveRows(entries, subject, cond = "") {
  const c = normPhrase(cond);
  const subjects = new Set([subject, normPhrase(subject)]);
  const rows = entries.flatMap((e) => extractFacts(e).filter((f) => subjects.has(f.subject)).map((f) => ({ f, e, d: entryDate(e) })));
  if (!rows.length) return { status: "none" };
  const pick = (list) => {
    const live = list.filter((i) => !list.some((R) => R.f.norm !== i.f.norm && R.f.replaces.includes(i.f.norm) && !(R.d && i.d && i.d > R.d)));
    if (new Set(live.map((i) => i.f.norm)).size === 1) return live.reduce((a, b) => ((b.d ?? "") > (a.d ?? "") ? b : a));
    return newestOf(live);
  };
  const general = rows.filter((r) => !r.f.cond);
  const scoped = c ? rows.filter((r) => r.f.cond === c) : [];
  const pool = scoped.length ? [...scoped, ...general] : general;
  let w = scoped.length ? pick(scoped) : pick(general);
  // A general rule restated after the scoped one leaves the scope unclear.
  if (w && scoped.length && general.some((g) => g.f.norm !== w.f.norm && g.d && w.d && g.d > w.d)) w = null;
  if (!w) return { status: "unresolved", candidates: pool.map((i) => where(i.e)) };
  return { status: "resolved", value: w.f.value, from: where(w.e), superseded: pool.filter((i) => i.f.norm !== w.f.norm).map((i) => where(i.e)) };
}

// Unit words in code names (`JOB_TIMEOUT_MS`) scale the value and don't count as subject words.
const UNIT_FACTOR = { ms: 1, millisecond: 1, sec: 1000, second: 1000, min: 60000, minute: 60000, hr: 3600000, hrs: 3600000, hour: 3600000, day: 86400000 };
const UNIT_WORDS = new Set([...Object.keys(UNIT_FACTOR), "kb", "mb", "gb"]);
const leadingNumber = (v) => String(v).match(/^-?\d+(?:\.\d+)?/)?.[0] ?? null;

function subjectWords(f) {
  if (f.type === "env") return idWords(f.subject);
  if (f.type === "port") return [...contentWords(f.subject), "port"];
  return contentWords(f.subject);
}

function codeMatches(f, a) {
  const raw = a.value.replace(/_/g, "");
  if (f.type === "toggle") return /^(true|false|on|off|enabled|disabled)$/i.test(raw) && normValue("toggle", raw) === f.norm;
  const unit = a.words.find((w) => w in UNIT_FACTOR);
  if (unit && /^-?\d/.test(raw) && String(Number(raw) * UNIT_FACTOR[unit]) === f.norm) return true;
  if (normValue(f.type, raw, a.id) === f.norm) return true;
  // "60s" in memory vs `timeout: 60` in code: same number, unit implied by the code.
  return leadingNumber(f.value) !== null && leadingNumber(f.value) === raw;
}

// `1.0` must not match inside `2.1.0`, nor `30` inside `3000` or `60_000`.
function hasLiteral(line, v) {
  let i = line.indexOf(v);
  while (i !== -1) {
    const before = line[i - 1] ?? "";
    const after = line.slice(i + v.length, i + v.length + 2);
    if (!/[\w.$]/.test(before) && !/^(?:[\w$]|\.\d)/.test(after)) return true;
    i = line.indexOf(v, i + 1);
  }
  return false;
}

// A line with the value within 3 lines of every subject word (`listen(7070)` next to `// workers`).
function valueNearWords(f, words, repos) {
  const literals = [...new Set([f.value, leadingNumber(f.value)].filter(Boolean))];
  for (const r of repos) {
    for (const { file, lines } of r.codeFiles) {
      for (let i = 0; i < lines.length; i++) {
        if (!literals.some((v) => hasLiteral(lines[i], v))) continue;
        const near = new Set(idWords(lines.slice(Math.max(0, i - 3), i + 4).join(" ")));
        if (words.every((w) => near.has(w))) return `${file}:${i + 1}`;
      }
    }
  }
  return null;
}

/**
 * Where the code sets this row's value.
 * @returns {{status: "set", at: string} | {status: "differs", value: string, at: string, env?: boolean, version?: boolean} | {status: "absent"} | null}
 *   null = nothing to say (a bare `VAR=value` setting the code doesn't contradict).
 */
function codeEvidence(f, repos, envRepo, versionRepo) {
  const known = f.type === "env" ? envRepo.get(f.subject) : null;
  const version = f.type === "version" ? versionRepo.get(f.subject) : null;
  if (known?.has(f.norm)) return { status: "set", at: known.get(f.norm).repo };
  // package.json is the one place a package's version is set.
  if (version) return normValue("version", version.value) === f.norm ? { status: "set", at: version.repo } : { status: "differs", value: version.value, at: version.repo, version: true };
  // A bare `VAR=value` may describe a valid setting rather than the default: the line that sets it,
  // else anywhere the value appears.
  if (f.explicit === false) {
    for (const r of repos) {
      for (const { file, lines } of r.codeFiles) {
        const i = lines.findIndex((l) => hasWord(l, f.subject) && hasLiteral(l, f.value));
        if (i !== -1) return { status: "set", at: `${file}:${i + 1}` };
      }
    }
    if (repos.some((r) => hasWord(r.code, f.value))) return { status: "set", at: "code" };
  }

  const words = subjectWords(f);
  const core = (a) => a.words.filter((w) => !UNIT_WORDS.has(w));
  const all = repos.flatMap((r) => r.assignments);
  const exact = all.filter((a) => { const c = core(a); return c.length === words.length && words.every((w) => c.includes(w)); });
  let candidates = exact.length ? exact : all.filter((a) => words.every((w) => a.words.includes(w)));
  // `GRACE_MS` for "grace period": the code name adds no word and covers at least half the subject.
  let loose = false;
  if (!candidates.length && words.length > 1) {
    candidates = all.filter((a) => { const c = core(a); return c.length && c.length * 2 >= words.length && c.every((w) => words.includes(w)); });
    loose = true;
  }
  const hit = candidates.find((a) => codeMatches(f, a));
  if (hit) return { status: "set", at: hit.at };
  const near = valueNearWords(f, f.type === "port" ? contentWords(f.subject) : words, repos);
  if (near) return { status: "set", at: near };

  if (known) {
    const first = [...known.values()][0];
    return { status: "differs", value: first.value, at: first.repo, env: true };
  }
  if (f.explicit === false) return null;
  // A loose match only rules when one code name fits; several would be a guess.
  if (candidates.length && (!loose || new Set(candidates.map((a) => a.id)).size === 1)) {
    return { status: "differs", value: candidates[0].expr ?? candidates[0].value, at: candidates[0].at };
  }
  return { status: "absent" };
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
  const common = commonWords(entries);
  const here = repos.map((r) => r.name).join(", ");
  // User memory spans every repo, local notes describe one machine, and notes about another repo
  // (misplaced) hold that repo's values, so this repo can't rule on any of them.
  const checkable = (i) => repos.length && i.e.scope !== "user" && !i.e.sectionLocal && i.f.type !== "count"
    && !i.e.anchors.some((a) => a.status === "elsewhere");

  const groups = new Map();
  for (const e of entries) {
    for (const f of extractFacts(e)) {
      if (!specific(f, common)) continue;
      const key = `${f.type}\u0000${f.subject}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ f, e });
    }
  }

  const differs = (i) => {
    const ev = i.ev;
    const message = ev.env
      ? `\`${i.f.subject}\` default is \`${i.f.value}\` here, but the code says \`${ev.value}\` (${ev.at})`
      : ev.version
        ? `${i.f.subject} is ${i.f.value} here, but its package.json says ${ev.value} (${ev.at})`
        : `${factLabel(i.f)} is \`${i.f.value}\` here, but the code sets \`${ev.value}\` at ${ev.at}`;
    addFinding(i.e, { type: "contradiction", message });
  };
  const absent = (i) => addFinding(i.e, { type: "stale", message: `no \`${i.f.value}\` for ${factLabel(i.f)} is set in ${here}` });

  for (const group of groups.values()) {
    const rows = group.map((i) => ({ ...i, d: entryDate(i.e), ev: checkable(i) ? codeEvidence(i.f, repos, envRepo, versionRepo) : null }));
    for (const i of rows) {
      if (i.ev?.status !== "set" || !/:\d+$/.test(i.ev.at)) continue;
      const what = i.f.explicit === false ? `\`${i.f.subject}=${i.f.value}\`` : `\`${i.f.value}\` for ${factLabel(i.f)}`;
      const note = `${what} matches ${i.ev.at}`;
      if (!(i.e.checked ??= []).includes(note)) i.e.checked.push(note);
    }
    for (const i of rows) if (i.f.explicit === false && i.ev?.status === "differs") differs(i);
    // A bare `VAR=value` is one setting someone used (local vs Docker), not a claim about the default.
    const items = rows.filter((i) => i.f.explicit !== false);
    const ruled = new Set();
    const rule = (i, fn) => { fn(i); ruled.add(i); };

    const byCond = new Map();
    for (const i of items) {
      if (!byCond.has(i.f.cond)) byCond.set(i.f.cond, []);
      byCond.get(i.f.cond).push(i);
    }
    for (const list of byCond.values()) {
      const setNorms = new Set(list.filter((i) => i.ev?.status === "set").map((i) => i.f.norm));
      const disagree = new Set(list.map((i) => i.f.norm)).size > 1 && new Set(list.map((i) => i.e)).size > 1;
      if (disagree && list.every((i) => i.ev) && setNorms.size < 2) {
        // The code decides: the value it sets is right; if it sets none of them, none are.
        const winner = list.find((i) => i.ev.status === "set");
        for (const i of list) {
          if (winner && i.f.norm === winner.f.norm) continue;
          const message = winner
            ? `${factLabel(i.f)} is \`${i.f.value}\` here, but the code sets \`${winner.f.value}\` at ${winner.ev.at}`
            : `${factLabel(i.f)} is \`${i.f.value}\` here and \`${list.find((o) => o.f.norm !== i.f.norm).f.value}\` at ${where(list.find((o) => o.f.norm !== i.f.norm).e)}; neither value is set in ${here}`;
          rule(i, () => addFinding(i.e, { type: "contradiction", message }));
        }
        continue;
      }
      // One value, or several the code all sets: rows the code doesn't back are wrong on their own.
      for (const i of list) {
        if (i.ev?.status === "differs" && !setNorms.has(i.f.norm)) rule(i, differs);
        // A lone number in a sentence is as often a measurement ("58 tool calls") as a setting.
        else if (i.ev?.status === "absent" && i.f.type !== "prose") rule(i, absent);
      }
    }

    const left = items.filter((i) => !ruled.has(i));
    if (new Set(left.map((i) => i.e)).size >= 2) compareRows(left);
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
      if (E.anchors.some((x) => x.value === a.value && x.status === "absent")) continue;
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

// An earlier note about an open problem or a guess, once a later heading or sentence in the same
// file says it was settled or wrong.
function checkCorrections(entries) {
  const common = commonWords(entries);
  const keyWords = (text) => new Set(contentWords(text).filter((w) => w.length >= 4 && !common.has(w) && !MARKER_WORDS.has(w)));
  const byFile = new Map();
  for (const e of entries) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  for (const list of byFile.values()) {
    const corrections = [];
    list.forEach((e, i) => {
      if (e.kind === "heading") {
        if (SETTLED_HEAD_RE.test(e.text)) corrections.push({ i, e, words: keyWords(e.text), quote: e.text, retraction: false });
        return;
      }
      for (const s of sentences(e.text)) {
        const m = s.match(RETRACTED_RE);
        if (m) corrections.push({ i, e, words: keyWords(s.slice(0, m.index)), quote: s.replace(/^[\s(-]+|[\s)]+$/g, ""), retraction: true });
      }
    });
    if (!corrections.length) continue;
    list.forEach((e, i) => {
      if (e.kind === "heading" || e.kind === "code") return;
      // A note that takes something back is the correction, not the thing corrected.
      const own = sentences(e.text).filter((s) => !RETRACTED_RE.test(s)).join(" ");
      if (!OPEN_RE.test(own)) return;
      const mine = new Set(contentWords(own));
      const c = corrections.find((x) => x.i > i && [...x.words].some((w) => mine.has(w)));
      if (!c) return;
      const quote = c.quote.length > 90 ? `${c.quote.slice(0, 87)}...` : c.quote;
      addFinding(e, {
        type: "superseded",
        message: c.retraction
          ? `${where(c.e)} later says this was wrong ("${quote}")`
          : `describes an open problem that ${where(c.e)} later settles ("${quote}")`,
        ref: where(c.e),
      });
    });
  }
}

// "`X` is used only for Y" while several code files use X.
function checkOnlyClaims(entries, repos) {
  if (!repos.length) return;
  const seen = new Map();
  const filesUsing = (name) => {
    if (!seen.has(name)) {
      const files = [];
      for (const r of repos) {
        for (const { file, lines } of r.codeFiles) {
          if (SOURCE_FILE_RE.test(file) && !NOT_A_USE_RE.test(file) && lines.some((l) => hasWord(l, name))) files.push(file);
        }
      }
      seen.set(name, files);
    }
    return seen.get(name);
  };
  for (const e of entries) {
    if (e.kind === "heading" || e.scope === "user" || e.sectionLocal) continue;
    for (const s of sentences(e.text)) {
      if (!ONLY_USE_RE.test(s)) continue;
      const anchors = extractAnchors(s);
      // Env vars have no defining file, so every file that names one is a use.
      const envs = anchors.filter((a) => a.kind === "env" && e.anchors.some((x) => x.kind === "env" && x.value === a.value && x.status === "resolved"));
      if (envs.length !== 1) continue;
      const named = anchors.filter((a) => a.kind === "path").map((a) => a.value);
      const files = filesUsing(envs[0].value).filter((f) => !named.some((p) => f === p || f.endsWith(`/${p}`)));
      if (files.length < (named.length ? 1 : 2)) continue;
      const shown = `${files.slice(0, 4).join(", ")}${files.length > 4 ? ` and ${files.length - 4} more` : ""}`;
      addFinding(e, {
        type: "contradiction",
        message: named.length
          ? `\`${envs[0].value}\` is said to be used only in ${named.join(", ")}, but it is also used in ${shown}`
          : `\`${envs[0].value}\` is said to have only one use, but ${files.length} code files use it: ${shown}`,
      });
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

// The same fact stated in two entries in different words: both record the same name as gone, or a
// clause in each shares the same number and a specific name or word, or most of its specific words.
function checkRestated(entries) {
  const { df, n } = docFrequency(entries);
  const common = new Set([...df].filter(([, c]) => c >= 5 && c / n > 0.2).map(([w]) => w));
  const rare = (t) => t.length >= 4 && (df.get(t) ?? 0) <= Math.max(4, Math.ceil(n * 0.05));
  // Notes that are wrong or replaced get removed anyway.
  const live = entries.filter((e) => e.kind !== "heading" && e.kind !== "code" && !e.findings.some((f) => PROBLEM_TYPES.has(f.type)));
  const duplicateOf = (a, b) => a.findings.some((f) => f.type === "duplicate" && f.ref === where(b));
  const linked = new Map();
  const link = (a, b, aSays, bSays) => {
    if (a === b || linked.get(a)?.has(b) || linked.get(b)?.has(a) || duplicateOf(a, b) || duplicateOf(b, a)) return;
    if (!linked.has(a)) linked.set(a, new Set());
    linked.get(a).add(b);
    addFinding(a, { type: "restates", message: `looks like the same fact as ${where(b)}: ${bSays}`, ref: where(b) });
    addFinding(b, { type: "restates", message: `looks like the same fact as ${where(a)}: ${aSays}`, ref: where(a) });
  };

  // The repo confirms the name is gone, so both notes record the same thing.
  const gone = new Map();
  for (const e of live) {
    for (const a of e.anchors) {
      if (a.status !== "removed" && a.status !== "absent") continue;
      if (!gone.has(a.value)) gone.set(a.value, []);
      if (!gone.get(a.value).includes(e)) gone.get(a.value).push(e);
    }
  }
  for (const [value, list] of gone) {
    const says = `both say \`${value}\` isn't in the repo`;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) link(list[i], list[j], says, says);
  }

  const clauses = [];
  for (const e of live) {
    for (const part of e.text.replace(/\n\s*/g, " ").split(CLAUSE_SPLIT_RE)) {
      const names = new Set();
      const take = (t) => { names.add(t.toLowerCase().replace(/\s+/g, " ")); return " "; };
      let rest = part.replace(COMMAND_RE, take).replace(PATHLIKE_RE, (t) => { const p = t.replace(/[.:]+$/, ""); return isPathLike(p) ? take(p) : t; });
      for (const a of extractAnchors(part)) {
        const v = a.value.toLowerCase();
        if (!NAMED_KINDS.has(a.kind) || v.length < 4 || [...names].some((x) => x.includes(v))) continue;
        names.add(v);
        rest = rest.split(a.value).join(" ");
      }
      const nums = new Set(rest.match(NUMBER_RE) ?? []);
      const all = new Set([...names, ...[...nums].filter((x) => x.length >= 2).map((x) => `#${x}`), ...contentWords(rest).filter((w) => w.length >= 3 && !common.has(w))]);
      if (all.size >= 2) clauses.push({ e, text: part.replace(/^[\s-]+/, "").trim(), all, nums, names });
    }
  }

  const posting = new Map();
  clauses.forEach((c, i) => {
    for (const t of c.all) {
      if (!posting.has(t)) posting.set(t, []);
      posting.get(t).push(i);
    }
  });
  const sameFact = (A, B, shared) => {
    // Two notes about different named things aren't one fact, whatever else they share.
    if (A.names.size && B.names.size && ![...A.names].some((x) => B.all.has(x)) && ![...B.names].some((x) => A.all.has(x))) return false;
    const specific = (t) => A.names.has(t) || B.names.has(t) || rare(t);
    if (shared.some((t) => t[0] === "#") && shared.some((t) => t[0] !== "#" && specific(t))) return true;
    // Different numbers for one subject is a disagreement, not a restatement.
    if (A.nums.size && B.nums.size && ![...A.nums].some((x) => B.nums.has(x))) return false;
    // Three shared words is often just a shared topic ("app", "service", "name").
    return shared.length >= 4 && shared.length / Math.min(A.all.size, B.all.size) >= 0.6;
  };
  const clip = (t) => `"${t.length > 80 ? `${t.slice(0, 77)}...` : t}"`;
  clauses.forEach((A, i) => {
    const sharedWith = new Map();
    for (const t of A.all) {
      const list = posting.get(t);
      if (list.length > 500) continue;
      for (const j of list) {
        if (j <= i || clauses[j].e === A.e) continue;
        if (!sharedWith.has(j)) sharedWith.set(j, []);
        sharedWith.get(j).push(t);
      }
    }
    for (const [j, shared] of sharedWith) {
      const B = clauses[j];
      if (sameFact(A, B, shared)) link(A.e, B.e, clip(A.text), clip(B.text));
    }
  });
}

export function checkConsistency(entries, repos, resolve) {
  checkFacts(entries, repos);
  checkRemovals(entries, resolve);
  propagateSections(entries);
  checkCorrections(entries);
  checkOnlyClaims(entries, repos);
  checkStillPresent(entries, repos);
  checkDuplicates(entries);
  checkRestated(entries);
}
