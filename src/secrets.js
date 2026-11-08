// Credential-shaped strings. Memory should never hold these; output always masks them.

const PATTERNS = [
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g, 0],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g, 0],
  ["Stripe key", /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, 0],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, 0],
  ["API key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, 0],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 0],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 0],
  ["credential in URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/`'"]+:([^\s@/`'"]{4,})@/gi, 1],
  ["assigned secret", /\b(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\b["'`]?\s*[:=]\s*["'`]?([A-Za-z0-9_\-/+=.]{12,})/gi, 1],
  ["prefixed key", /\b[a-z]{2,6}_(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{24,}\b/g, 0],
];

const PLACEHOLDER_RE = /[<>{}$]|x{4,}|\.\.\.|example|your|changeme|placeholder|redacted|dummy|sample/i;

function mask(s) {
  return s.length <= 4 ? "****" : `${s.slice(0, 4)}…[redacted]`;
}

export function findSecrets(text) {
  const out = [];
  for (const [kind, re, group] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = m[group] ?? m[0];
      if (PLACEHOLDER_RE.test(value)) continue;
      if (out.some((s) => s.value === value)) continue;
      out.push({ kind, value, masked: mask(value) });
    }
  }
  return out;
}

export function maskSecrets(text, secrets) {
  let t = text;
  for (const s of secrets) t = t.split(s.value).join(s.masked);
  return t;
}
