// Extracts what a memory entry points at: repo paths, env vars, routes, npm
// scripts, code symbols, CLI flags, personal (home/tmp) paths and ports.

// Paths that belong to one person's machine, not to the repo.
export const LOCAL_ABS_RE = /^(?:~(?:\/|$)|\/(?:Users|home)\/[^/\s]+(?:\/|$)|\/(?:private\/)?tmp\/|\/(?:private\/)?var\/folders\/|[A-Za-z]:[\\/]Users[\\/])/;
// System / in-container absolute paths (/app, /workspace, /usr/local/bin…) are neither repo nor personal.
const SYSTEM_ABS_RE = /^\/(?:var|etc|usr|opt|bin|sbin|dev|proc|sys|run|lib|app|workspace|data|srv|root|mnt|Volumes|Library|System|Applications)(?:\/|$)/;

const CODE_EXT = "ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|rb|java|kt|sql|prisma|sh|bash|zsh|yml|yaml|json|toml|md|mdx|css|scss|html|vue|svelte|php|cs|swift|proto|graphql|gql|tf|ini|cfg|conf|env|pem";
export const EXT_RE = new RegExp(`\\.(?:${CODE_EXT})$`, "i");
const NAMED_FILES = new Set([
  "Dockerfile", "Makefile", "Caddyfile", "Procfile", "Jenkinsfile", "Gemfile", "Rakefile", "Justfile", "justfile",
  ".gitignore", ".dockerignore", ".env", ".env.local", ".env.example", ".env.sample", ".env.template", ".npmrc", ".nvmrc", ".editorconfig",
]);
// Product/brand names that look like camelCase identifiers.
const STOP_SYMBOLS = new Set([
  "jQuery", "iPhone", "iPad", "iCloud", "eBay", "macOS", "iOS", "iPadOS", "gRPC", "JavaScript", "TypeScript", "GitHub",
  "GitLab", "PostgreSQL", "MySQL", "MongoDB", "OAuth", "OpenAI", "OpenAPI", "GraphQL", "WebSocket", "NodeJS", "VSCode",
  "PowerShell", "LaunchDarkly", "CloudFlare", "PayPal", "LinkedIn", "WordPress", "FastAPI", "NextJS", "YouTube", "DevOps",
  "HashiCorp", "SendGrid", "BigQuery", "DynamoDB", "ElasticSearch", "RabbitMQ", "SQLite", "WebAssembly", "DocuSOR",
  "BitBucket", "PagerDuty", "DataDog", "OpenTelemetry", "ChatGPT", "VMware", "GitOps",
]);
const SCRIPT_SKIP = new Set([
  "install", "i", "ci", "exec", "x", "init", "link", "publish", "add", "remove", "rm", "dlx", "create", "uninstall",
  "update", "outdated", "audit", "pack", "version", "login", "whoami", "config", "cache", "prune", "dedupe", "ls", "list",
  "why", "view", "info", "run",
]);
const HTTP = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";
// Bare directory paths are only trusted under conventional source roots ("src/scm/", not "read/write").
const SOURCE_DIR_RE = /^(?:src|lib|app|apps|packages|test|tests|scripts|prisma|internal|cmd|web|server|client)\/(?:[\w.-]+\/)+$/;

export function normPath(p) {
  return p
    .replace(/^\.\//, "")
    .replace(/#L?\d+.*$/, "")
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/[),.;:!?]+$/, "");
}

function isCamel(t) {
  return (/^[a-z]+(?:[A-Z][a-z0-9]+)+$/.test(t) || /^(?:[A-Z][a-z0-9]+){2,}$/.test(t)) && !STOP_SYMBOLS.has(t);
}

function isPathLike(t, ticked) {
  if (/\s/.test(t) || /^[a-z][\w+.-]*:/i.test(t)) return false;
  const last = t.replace(/\/$/, "").split("/").pop();
  if (t.includes("/")) {
    if (EXT_RE.test(last) || NAMED_FILES.has(last)) return /^[\w.@<>{}*-]+(?:\/[\w.@<>{}*-]+)+\/?$/.test(t.replace(/^\.{1,2}\//, ""));
    if (SOURCE_DIR_RE.test(t)) return true;
    return ticked && /^[\w.@-]+(?:\/[\w.@<>{}*-]+)+\/?$/.test(t);
  }
  if (NAMED_FILES.has(t)) return true;
  // ".json" / ".contract.json" name a file type, not a file.
  if (/^\.[a-z0-9]+(?:\.[a-z0-9]+)*$/i.test(t)) return false;
  // "Node.js"/"Next.js" are product names, not files.
  return EXT_RE.test(t) && /^[\w.@-]+$/.test(t) && !/^[A-Z][a-z]+\.js$/.test(t);
}

function addRoute(add, r) {
  const p = r.split("?")[0].replace(/\/$/, "");
  if (p.length > 1) add("route", p);
}

function classifyToken(raw, add, ticked) {
  const t = raw.trim().replace(/^[("'[{]+/, "").replace(/[)"'\]},.;:!?]+$/, "");
  if (t.length < 2) return;

  const cmd = t.match(/^(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/);
  if (cmd) {
    const s = cmd[1] === "t" ? "test" : cmd[1];
    if (!SCRIPT_SKIP.has(s)) add("script", s);
  }
  const route = t.match(new RegExp(`^(?:${HTTP})\\s+(\\S+)`, "i"));
  if (route) {
    if (route[1].startsWith("/")) addRoute(add, route[1]);
    else classifyToken(route[1], add, ticked);
    return;
  }
  if (/\s/.test(t)) {
    for (const w of t.split(/\s+/)) classifyToken(w, add, false);
    return;
  }
  if (/^[a-z][\w+.-]*:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      if (u.port) add("port", u.port);
      if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(u.hostname) && u.pathname.length > 1) addRoute(add, u.pathname);
    } catch { /* not a URL */ }
    return;
  }
  const hostPort = t.match(/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})(\/\S*)?$/);
  if (hostPort) {
    add("port", hostPort[1]);
    if (hostPort[2]) addRoute(add, hostPort[2]);
    return;
  }
  if (LOCAL_ABS_RE.test(t)) { add("local-path", t); return; }
  if (SYSTEM_ABS_RE.test(t)) return;
  if (/^--[a-z][\w-]+/.test(t)) { add("flag", t.split("=")[0]); return; }
  if (/^\/[\w\-/:{}.<>*]+$/.test(t)) { addRoute(add, t); return; }
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(t)) { add("env", t); return; }
  if (isPathLike(t, ticked)) { add("path", normPath(t)); return; }
  const call = t.match(/^(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)\(/);
  if (call) {
    if (call[1].length >= 3 && !STOP_SYMBOLS.has(call[1])) add("symbol", call[1]);
    return;
  }
  if (!ticked) {
    if (isCamel(t) && /^[a-z]/.test(t) && t.length >= 8) add("symbol", t);
    // Unticked snake_case is as often a DB name or a library's error code as our own symbol.
    else if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(t) && t.length >= 8) add("identifier", t);
    return;
  }
  if (isCamel(t) && t.length >= 5) { add("symbol", t); return; }
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(t)) { add("symbol", t); return; }
  if (/^[\w.:@-]{4,}$/.test(t) && /[a-z]/i.test(t) && !/^\d/.test(t)) add("token", t);
}

export function extractAnchors(text) {
  const out = [];
  const seen = new Set();
  const add = (kind, value) => {
    const k = `${kind}\u0000${value}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ kind, value });
  };

  // Fenced code is scanned like prose: its delimiters are dropped, its content kept.
  const body = text.replace(/^\s*(```+|~~~+)[^\n]*$/gm, " ");
  for (const m of body.matchAll(/`([^`\n]+)`/g)) classifyToken(m[1], add, true);

  let bare = body.replace(/`[^`\n]+`/g, " ");
  for (const m of bare.matchAll(/\]\(([^)\s]+)\)/g)) classifyToken(m[1], add, true);
  bare = bare.replace(/\]\([^)\s]+\)/g, "]");

  for (const m of bare.matchAll(/\b(?:npm|pnpm|yarn)\s+run\s+[\w:.-]+|\b(?:npm|pnpm|yarn)\s+(?:test|start)\b/g)) classifyToken(m[0], add, false);
  for (const m of bare.matchAll(new RegExp(`\\b(?:${HTTP})\\s+(\\/[\\w\\-/:{}.]*)`, "g"))) addRoute(add, m[1]);
  for (const m of bare.matchAll(/\b([A-Za-z_$][\w$]*)\(\)/g)) classifyToken(`${m[1]}()`, add, false);

  for (const tok of bare.split(/[\s,;()"'“”<>|*]+/)) {
    if (!tok) continue;
    // "emitServe/BILLABLE_TOOLS" lists alternatives, it isn't a path.
    if (tok.includes("/") && !/^[~./]|:\/\//.test(tok) && !isPathLike(tok, false)) {
      for (const part of tok.split("/")) if (part) bareToken(part, add);
      continue;
    }
    bareToken(tok, add);
  }
  return out;
}

function bareToken(tok, add) {
  const t = tok.replace(/[.:!?]+$/, "");
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(t) && t.length >= 5) {
    add("env", t);
    return;
  }
  classifyToken(tok, add, false);
}
