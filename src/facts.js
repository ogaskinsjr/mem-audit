// Subject/value claims memory states in recognizable shapes, so two entries
// (or an entry and the repo) can be compared without understanding prose.
// Each claim is a decision row: subject, value, condition ("for new jobs only")
// and the values it says it replaced ("(was 30s)").

const STOP_SUBJECTS = new Set([
  "the", "a", "an", "default", "host", "its", "this", "that", "on", "and", "or", "same", "real", "local", "public",
  "published", "container", "compose", "http", "https", "tls", "new", "old", "which", "each", "any", "one", "to", "from",
  "with", "via", "at", "by", "of", "random", "free", "open", "exposed", "internal", "external", "fixed", "dev", "test",
]);
const EMPTY_VALUE_RE = /^\(?(required|optional|none|null|unset|empty|n\/a|-|—|\.\.\.)\)?$/i;
const GENERIC_NOUNS = new Set(["service", "server", "app", "api", "container", "instance", "db", "database", "proxy", "worker"]);

// Closed-class English words (finite, domain-independent). Content words are never listed.
const CLOSED = new Set([
  "a", "an", "the", "this", "that", "these", "those", "our", "my", "your", "its", "their", "his", "her",
  "it", "we", "they", "you", "i", "he", "she", "is", "are", "was", "were", "be", "been", "am",
  "of", "to", "in", "on", "at", "by", "for", "from", "with", "as", "into", "per", "via",
  "and", "or", "but", "so", "then", "than", "nor", "when", "if", "unless", "only", "except", "while", "because",
  "not", "no", "now", "also", "just", "still",
]);
// Words that qualify a subject without naming it ("the default retry limit").
const LEAD = new Set(["default", "current"]);
// "<subject> is/of/= <value>": link and value shapes are closed; the subject is whatever precedes the link.
// "2+ words" isn't a value, on/off only is one at the end of a clause ("is ON the network" isn't), and a
// string only is one in quotes or backticks (no dots/slashes, so file names don't become values) and
// not itself being defined ("scripts: `build` = vite build" defines `build`, it isn't the value) or
// the first of a list ("read at start: `A_KEY`, `B_KEY`").
const PROSE_RE = /(?:\s+(?:is|are)(?:\s+now)?|\s+(?:of|now|becomes|defaults? to|(?:set|changed|raised|lowered|bumped) to)|\s*[:=])\s*(?:`?(\d+(?:\.\d+)?\s?(?:milliseconds?|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|kb|mb|gb|tb|s|m|h|d|%|x)?(?![\w%+]|\.\d)|(?:on|off|true|false|enabled|disabled)(?=`?\s*(?:[.,;:)!?]|$)))`?|([`"'])([A-Za-z][\w-]{1,23})\2(?!\s*[:=]|\s*,\s*[`"']))/gi;
const REPLACED_RE = /\((?:was|previously|formerly)\s+`?([^`)]+?)`?\)|\b(?:previously|formerly)\s+`?([\w.%]+)|\bfrom\s+`?([\w.%]+(?:\s(?:milliseconds?|seconds?|minutes?|hours?|days?|kb|mb|gb|tb)\b)?)`?\s+to\b|\binstead of\s+`?([\w.%]+)/gi;
// "grace period (72h default)", "retries (default 3)": the value sits in brackets after the subject.
const PAREN_DEFAULT_RE = /\(\s*(?:(?:defaults?(?:\s+to|\s+is|:)?|by default:?)\s*`?(\d+(?:\.\d+)?\s?(?:milliseconds?|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|kb|mb|gb|tb|s|m|h|d|%|x)?)`?|`?(\d+(?:\.\d+)?\s?(?:milliseconds?|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|kb|mb|gb|tb|s|m|h|d|%|x)?)`?\s+(?:by\s+)?default)\s*\)/gi;
const PROSE_TIME_RE = /^(\d+(?:\.\d+)?)(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/;

const tokens = (s) => s.match(/[A-Za-z0-9][\w-]*|[^\s\w]/g) ?? [];
const stem = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

export function contentWords(s) {
  return tokens(s.toLowerCase()).flatMap((t) => t.split("-")).filter((w) => /^[a-z][a-z0-9_]*$/.test(w) && !CLOSED.has(w)).map(stem);
}

// "new-jobs only" and "New jobs" name the same thing.
export const normPhrase = (s) => contentWords(s).join(" ");

// `NEW_JOB_RETRY_LIMIT`, `newJobRetryLimit`, `new-job-retry-limit` -> new job retry limit.
export const idWords = (id) => contentWords(id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_$.]+/g, " "));

// Conditions a sentence puts on its claims. onlyForms: just "for X only" / "only for X".
export function conditionsIn(sentence, onlyForms = false) {
  const low = tokens(sentence).map((t) => t.toLowerCase());
  const phrase = (i) => {
    const w = [];
    while (i < low.length && w.length < 4 && /^[a-z0-9][\w-]*$/.test(low[i]) && !CLOSED.has(low[i])) w.push(low[i++]);
    return w;
  };
  const out = [];
  for (let i = 0; i < low.length; i++) {
    if (low[i] === "only" && ["for", "in", "on", "when"].includes(low[i + 1])) {
      const w = phrase(i + 2);
      if (w.length) out.push(w.join(" "));
    } else if (low[i] === "for") {
      const w = phrase(i + 1);
      if (w.length && low[i + 1 + w.length] === "only") out.push(w.join(" "));
    } else if (!onlyForms && (low[i] === "when" || low[i] === "if")) {
      const w = phrase(i + 1);
      if (w.length) out.push(w.join(" "));
    }
  }
  return [...new Set(out.map(normPhrase).filter(Boolean))].sort().join(" & ");
}

function sentenceAt(text, at) {
  let start = 0;
  for (const m of text.matchAll(/[.;!?]\s+/g)) {
    if (m.index >= at) return text.slice(start, m.index + 1);
    start = m.index + m[0].length;
  }
  return text.slice(start);
}

function okValue(v) {
  return v && v.length <= 200 && !/^[$<{(=>]/.test(v) && !EMPTY_VALUE_RE.test(v);
}

// The subject of a prose claim: the words right before the link or bracket.
function subjectBefore(text) {
  const left = tokens(text);
  const subj = [];
  for (let i = left.length - 1; i >= 0 && subj.length < 4; i--) {
    if (!/^[A-Za-z][\w-]*$/.test(left[i]) || CLOSED.has(left[i].toLowerCase())) break;
    subj.unshift(left[i]);
  }
  while (subj.length && LEAD.has(subj[0].toLowerCase())) subj.shift();
  // "tests use noRepo: true": a code name right before the link is the whole subject.
  if (subj.length > 1 && /[a-z][A-Z]|_/.test(subj[subj.length - 1])) subj.splice(0, subj.length - 1);
  // Env vars already have their own, stricter shapes.
  if (!subj.length || subj.some((w) => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(w))) return null;
  const code = subj.length === 1 && /[a-z][A-Z]|_/.test(subj[0]);
  const subject = code ? subj[0] : normPhrase(subj.join(" "));
  return subject ? { subject, code } : null;
}

const UNIT_MS = { ms: 1, s: 1000, sec: 1000, m: 60000, min: 60000, h: 3600000, hr: 3600000, d: 86400000 };
const SUFFIX_MS = [[/_MS$/, 1], [/_(?:SECONDS?|SECS?)$/, 1000], [/_(?:MINUTES?|MINS?)$/, 60000], [/_(?:HOURS?|HRS?)$/, 3600000], [/_DAYS?$/, 86400000]];

// "300s" and AUTO_X_TIMEOUT_MS=300000 are the same value.
export function normValue(type, v, subject = "") {
  let s = String(v).trim().replace(/^["'`]|["'`]$/g, "");
  if (type === "env") {
    s = s.replace(/\/+$/, "").toLowerCase();
    const u = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr|d)$/);
    if (u) return String(Number(u[1]) * UNIT_MS[u[2]]);
    const suf = /^\d+(?:\.\d+)?$/.test(s) && SUFFIX_MS.find(([re]) => re.test(subject));
    if (suf) return String(Number(s) * suf[1]);
  }
  if (type === "toggle") s = /^(on|enabled|true)$/i.test(s) ? "on" : "off";
  if (type === "version") s = s.replace(/^v/i, "");
  if (type === "prose") {
    s = s.toLowerCase().replace(/\s+/g, "");
    if (/^(on|enabled|true)$/.test(s)) return "on";
    if (/^(off|disabled|false)$/.test(s)) return "off";
    const u = s.match(PROSE_TIME_RE);
    if (u) {
      const unit = u[2];
      const ms = /^(ms|milli)/.test(unit) ? 1 : unit[0] === "s" ? 1000 : unit[0] === "m" ? 60000 : unit[0] === "h" ? 3600000 : 86400000;
      return String(Number(u[1]) * ms);
    }
  }
  return s;
}

export function extractFacts(entry) {
  const out = [];
  // Wrapped lines belong to the same sentence.
  const text = entry.text.replace(/\n\s*/g, " ");
  const push = (type, subject, value, extra = {}, at = null) => {
    if (!subject || !okValue(value)) return;
    const sentence = at == null ? "" : sentenceAt(text, at);
    const replaces = [...sentence.matchAll(REPLACED_RE)].map((m) => normValue(type, (m[1] ?? m[2] ?? m[3] ?? m[4]).trim(), subject));
    const f = { type, subject, value: String(value).trim(), norm: normValue(type, value, subject), cond: conditionsIn(sentence), replaces, ...extra };
    if (!out.some((o) => o.type === f.type && o.subject === f.subject && o.norm === f.norm && o.cond === f.cond)) out.push(f);
  };

  if (entry.table) {
    const di = entry.table.headers.findIndex((h) => /default/i.test(h));
    const name = entry.table.cells[0]?.match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/);
    if (di > 0 && name) push("env", name[1], (entry.table.cells[di] ?? "").replace(/`/g, "").trim(), { explicit: true });
  } else {
    const defRe = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b`?\s*(?:\(\s*defaults?(?:\s+to)?\s*:?\s*|\s+defaults?\s+(?:to\s+|is\s+|=\s*|:\s*)?)`?([^\s`),;|]+)`?/g;
    for (const m of text.matchAll(defRe)) push("env", m[1], m[2].replace(/[.:]+$/, ""), { explicit: true }, m.index);
    // `VAR=value` is often a condition ("off when MODE=self_host"), so it's only a weak claim.
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b`?\s*=(?!=)\s*`?(?:"([^"\n]*)"|'([^'\n]*)'|([^\s`),;|]+))`?/g)) {
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      if (/\b(?:when|if|unless|with|set|setting|e\.g\.|for|or|and)\s*`?$/i.test(before)) continue;
      push("env", m[1], m[2] ?? m[3] ?? m[4].replace(/[.:]+$/, ""), { explicit: false }, m.index);
    }
  }

  for (const m of text.matchAll(/(?:^|[\s(`])(@?[a-z][\w.-]*[a-z0-9](?:\/[\w.-]+)?)`?\s+(?:is\s+|now\s+|at\s+)?v?(\d+\.\d+\.\d+)\b/gi)) {
    const subject = m[1].toLowerCase();
    if (/[-/@]/.test(subject)) push("version", subject, m[2], {}, m.index);
  }

  for (const m of text.matchAll(/\b(?:([A-Za-z][\w-]+)\s+)?([A-Za-z][\w-]{2,})\s+(?:listens on(?:\s+port)?|runs on(?:\s+port)?|on port|port)\s*:?\s*`?(\d{2,5})\b/gi)) {
    const head = m[2].toLowerCase();
    // "cache service port" and "widget service port" are different subjects.
    const subject = GENERIC_NOUNS.has(head) && m[1] && !STOP_SUBJECTS.has(m[1].toLowerCase()) ? `${m[1].toLowerCase()} ${head}` : head;
    if (!STOP_SUBJECTS.has(head) || subject !== head) push("port", subject, m[3], {}, m.index);
  }
  const boldPort = text.match(/\*\*port\*\*\s*:?\s*`?(\d{2,5})\b/i);
  if (boldPort && entry.section.length) push("port", entry.section[entry.section.length - 1].toLowerCase(), boldPort[1]);

  for (const m of text.matchAll(/([\w.-]+\.(?:mts|cts|ts|mjs|cjs|js|py|sh))\b[^\n.;]{0,40}?\b(\d+)\s+(?:checks?|tests?)\b/gi)) {
    push("count", m[1], m[2], {}, m.index);
  }

  for (const m of text.matchAll(/([A-Za-z][\w -]{2,40}?)\s*\([^)]*?\bdefault\s+(on|off|enabled|disabled|true|false)\b/gi)) {
    push("toggle", m[1].trim().toLowerCase(), m[2], {}, m.index);
  }

  if (!entry.table) {
    for (const m of text.matchAll(PROSE_RE)) {
      const s = subjectBefore(text.slice(0, m.index));
      if (s) push("prose", s.subject, (m[1] ?? m[3]).trim(), { explicit: true, code: s.code }, m.index + m[0].length - 1);
    }
    for (const m of text.matchAll(PAREN_DEFAULT_RE)) {
      const s = subjectBefore(text.slice(0, m.index));
      if (s) push("prose", s.subject, (m[1] ?? m[2]).trim(), { explicit: true, code: s.code }, m.index);
    }
  }
  return out;
}
