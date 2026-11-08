// Subject/value claims memory states in recognizable shapes, so two entries
// (or an entry and the repo) can be compared without understanding prose.

const STOP_SUBJECTS = new Set([
  "the", "a", "an", "default", "host", "its", "this", "that", "on", "and", "or", "same", "real", "local", "public",
  "published", "container", "compose", "http", "https", "tls", "new", "old", "which", "each", "any", "one", "to", "from",
  "with", "via", "at", "by", "of", "random", "free", "open", "exposed", "internal", "external", "fixed", "dev", "test",
]);
const EMPTY_VALUE_RE = /^\(?(required|optional|none|null|unset|empty|n\/a|-|—|\.\.\.)\)?$/i;
const GENERIC_NOUNS = new Set(["service", "server", "app", "api", "container", "instance", "db", "database", "proxy", "worker"]);

function okValue(v) {
  return v && v.length <= 200 && !/^[$<{(=>]/.test(v) && !EMPTY_VALUE_RE.test(v);
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
  return s;
}

export function extractFacts(entry) {
  const out = [];
  const push = (type, subject, value, extra = {}) => {
    if (!subject || !okValue(value)) return;
    const f = { type, subject, value: String(value).trim(), norm: normValue(type, value, subject), ...extra };
    if (!out.some((o) => o.type === f.type && o.subject === f.subject && o.norm === f.norm)) out.push(f);
  };
  const text = entry.text;

  if (entry.table) {
    const di = entry.table.headers.findIndex((h) => /default/i.test(h));
    const name = entry.table.cells[0]?.match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/);
    if (di > 0 && name) push("env", name[1], (entry.table.cells[di] ?? "").replace(/`/g, "").trim(), { explicit: true });
  } else {
    const defRe = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b`?\s*(?:\(\s*defaults?(?:\s+to)?\s*:?\s*|\s+defaults?\s+(?:to\s+|is\s+|=\s*|:\s*)?)`?([^\s`),;|]+)`?/g;
    for (const m of text.matchAll(defRe)) push("env", m[1], m[2], { explicit: true });
    // `VAR=value` is often a condition ("off when MODE=self_host"), so it's only a weak claim.
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b`?\s*=(?!=)\s*`?([^\s`),;|]+)`?/g)) {
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      if (/\b(?:when|if|unless|with|set|setting|e\.g\.|for|or|and)\s*`?$/i.test(before)) continue;
      push("env", m[1], m[2], { explicit: false });
    }
  }

  for (const m of text.matchAll(/(?:^|[\s(`])(@?[a-z][\w.-]*[a-z0-9](?:\/[\w.-]+)?)`?\s+(?:is\s+|now\s+|at\s+)?v?(\d+\.\d+\.\d+)\b/gi)) {
    const subject = m[1].toLowerCase();
    if (/[-/@]/.test(subject)) push("version", subject, m[2]);
  }

  for (const m of text.matchAll(/\b(?:([A-Za-z][\w-]+)\s+)?([A-Za-z][\w-]{2,})\s+(?:listens on(?:\s+port)?|runs on(?:\s+port)?|on port|port)\s*:?\s*`?(\d{2,5})\b/gi)) {
    const head = m[2].toLowerCase();
    // "cache service port" and "widget service port" are different subjects.
    const subject = GENERIC_NOUNS.has(head) && m[1] && !STOP_SUBJECTS.has(m[1].toLowerCase()) ? `${m[1].toLowerCase()} ${head}` : head;
    if (!STOP_SUBJECTS.has(head) || subject !== head) push("port", subject, m[3]);
  }
  const boldPort = text.match(/\*\*port\*\*\s*:?\s*`?(\d{2,5})\b/i);
  if (boldPort && entry.section.length) push("port", entry.section[entry.section.length - 1].toLowerCase(), boldPort[1]);

  for (const m of text.matchAll(/([\w.-]+\.(?:mts|cts|ts|mjs|cjs|js|py|sh))\b[^\n.;]{0,40}?\b(\d+)\s+(?:checks?|tests?)\b/gi)) {
    push("count", m[1], m[2]);
  }

  for (const m of text.matchAll(/([A-Za-z][\w -]{2,40}?)\s*\([^)]*?\bdefault\s+(on|off|enabled|disabled|true|false)\b/gi)) {
    push("toggle", m[1].trim().toLowerCase(), m[2]);
  }
  return out;
}
