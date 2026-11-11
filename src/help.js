// CLI help: one-line summaries for `--help`, full descriptions for `--help <option>`.
import { SOURCES } from "./discover.js";
import { VERDICTS } from "./classify.js";

export const OPTIONS = [
  {
    names: ["root"],
    arg: "",
    summary: "repository to audit (default: current directory)",
    details: [
      "Positional argument: the repository whose agent memory is audited.",
      "Memory files are discovered for this path (VS Code workspace storage is matched on it),",
      "and its files, npm scripts, package versions and env defaults are what memory is checked against.",
      "Default: the current directory.",
    ],
    example: "mem-audit ~/code/my-app",
  },
  {
    names: ["--agent"],
    arg: "<list>",
    summary: `memory sources to read: ${SOURCES.join(",")} (default: all)`,
    details: [
      "Comma-separated list of memory sources:",
      "  copilot    VS Code Copilot repo memory for this workspace + user memory",
      "  claude     CLAUDE.md files, CLAUDE.local.md, ~/.claude/CLAUDE.md, Claude project auto-memory",
      "  committed  AGENTS.md, GEMINI.md, .github/copilot-instructions.md, .github/instructions/*,",
      "             .cursor/rules/*, .cursorrules",
      "Files passed with --file are always included.",
    ],
    example: "mem-audit --agent copilot,claude",
  },
  {
    names: ["--file"],
    arg: "<path>",
    summary: "also audit this markdown file (repeatable)",
    details: [
      "Adds a markdown file to the audit, for memory stored somewhere discovery doesn't look",
      "(another tool, an exported notes file). Repeat the flag for several files.",
    ],
    example: "mem-audit --file notes/agent-memory.md --file ~/memory/team.md",
  },
  {
    names: ["--related"],
    arg: "<dir...>",
    summary: "also index sibling repos that memory refers to",
    details: [
      "Indexes extra repositories so memory that talks about them can be checked too.",
      "Takes every following argument until the next option. A path like `api/src/x.ts` is",
      "resolved inside the related repo named `api`; other anchors are searched in all repos.",
      "Without it, repos next to root are still searched for anything memory names that root",
      "doesn't have; those notes are reported as misplaced (see --no-siblings).",
    ],
    example: "mem-audit . --related ../api ../shared-lib",
  },
  {
    names: ["--no-siblings"],
    arg: "",
    summary: "don't search repos next to root for what memory names",
    details: [
      "By default, when memory names a file, script or symbol that isn't in the audited repo, the",
      "folders next to it that contain .git are searched. A match is reported as misplaced, naming",
      "the repo it was found in. With --no-siblings it's reported as stale instead.",
    ],
    example: "mem-audit --no-siblings",
  },
  {
    names: ["--exclude"],
    arg: "<text>",
    summary: "skip memory files whose path or label contains <text> (repeatable)",
    details: [
      "Drops discovered memory files whose absolute path or label (e.g. `committed:templates/AGENTS.md`)",
      "contains the given text. Useful for templates or vendored instruction files.",
    ],
    example: "mem-audit --exclude templates/ --exclude CLAUDE.local.md",
  },
  {
    names: ["--no-repo"],
    arg: "",
    summary: "skip repo checks; only check memory against itself",
    details: [
      "Doesn't index any repository. Only memory-vs-memory checks run: values that disagree",
      "between entries, things one entry says were removed while another still describes them,",
      "and duplicates. Ties are broken by explicit dates only. Faster, and works outside a repo.",
    ],
    example: "mem-audit --no-repo --file memory.md",
  },
  {
    names: ["--json"],
    arg: "",
    summary: "print the JSON audit to stdout instead of the text report",
    details: [
      "Prints the same document every run writes to <out>/mem-audit.json: files, summary counts,",
      "and every entry with its verdict, findings and resolved anchors. Ordering is stable and there",
      "are no timestamps, so identical inputs give byte-identical output. Secrets are masked.",
    ],
    example: "mem-audit --json | jq .summary",
  },
  {
    names: ["--out"],
    arg: "<dir>",
    summary: "folder every run writes the audit files to (default: <root>/mem-audit)",
    details: [
      "Every run replaces the audit files in this folder, whatever is printed to the terminal:",
      "  mem-audit.json   the full audit (same document as --json)",
      "  summary.json     counts, plus which file holds each verdict",
      "  agent-todos/     one <verdict>.json per verdict that has something to do (stale.json,",
      "                   misplaced.json, ...): meaning, what to do, and each entry's memory file,",
      "                   line, text and findings",
      "  audit-ready/     guidance.json and keep-local.json: notes that need no change",
      "  .gitignore       `*`, so git ignores the folder",
      "Verdict files from an earlier run that no longer apply are removed; nothing else is touched.",
      "Relative paths resolve against the current directory.",
    ],
    example: "mem-audit --out reports/mem-audit",
  },
  {
    names: ["--no-out"],
    arg: "",
    summary: "don't write the audit files",
    details: ["Skips writing the --out folder; only the terminal report (or --json stdout) is produced."],
    example: "mem-audit --no-out",
  },
  {
    names: ["--verbose"],
    arg: "",
    summary: "list every entry, not just problems",
    details: [
      "Problem verdicts are always listed in full. Without --verbose, the other buckets",
      "(repo-fact, history, keep-local, review) show 3 examples each plus a count.",
    ],
    example: "mem-audit --verbose",
  },
  {
    names: ["--fail-on"],
    arg: "<list>",
    summary: "exit 1 when any entry has one of these verdicts",
    details: [
      "Comma-separated verdicts that make the command exit with status 1, for CI or agent hooks.",
      `Verdicts: ${VERDICTS.join(", ")}.`,
      "Exit codes: 0 = ok, 1 = a --fail-on verdict was found, 2 = usage error.",
    ],
    example: "mem-audit --fail-on redact,stale,contradiction",
  },
  {
    names: ["--list"],
    arg: "",
    summary: "only list the memory files that would be audited",
    details: [
      "Prints each discovered memory file (label and absolute path) and exits without classifying",
      "or writing the JSON audit. Combine with --json for a JSON array.",
    ],
    example: "mem-audit --list",
  },
  {
    names: ["--no-hint"],
    arg: "",
    summary: "omit the DocuSOR tips",
    details: ["Leaves out the DocuSOR tip printed under each report section that has entries."],
    example: "mem-audit --no-hint",
  },
  {
    names: ["--vscode-user-dir"],
    arg: "<dir>",
    summary: "VS Code user data dir to search (repeatable)",
    details: [
      "Replaces the default VS Code user data locations (Code, Code - Insiders, VSCodium under the",
      "OS config dir). Copilot repo memory is read from <dir>/workspaceStorage/<id>/…/memories/repo/",
      "for the workspace whose workspace.json points at the audited repo; user memory from",
      "<dir>/globalStorage/github.copilot-chat/memory-tool/memories/.",
    ],
    example: "mem-audit --vscode-user-dir \"$HOME/Library/Application Support/Code/User\"",
  },
  {
    names: ["--claude-home"],
    arg: "<dir>",
    summary: "Claude Code home (default: ~/.claude)",
    details: [
      "Where Claude Code keeps user memory (CLAUDE.md) and per-project auto-memory",
      "(projects/<encoded repo path>/memory/).",
    ],
    example: "mem-audit --claude-home /tmp/claude-home",
  },
  {
    names: ["-h", "--help"],
    arg: "[option]",
    summary: "show this help; with an option, describe that option",
    details: ["With no option, lists every option. Followed by (or following) an option, describes it in full."],
    example: "mem-audit --help --related",
  },
  {
    names: ["-v", "--version"],
    arg: "",
    summary: "show the version",
    details: ["Prints the version and exits."],
    example: "mem-audit --version",
  },
];

const label = (o) => `${o.names.join(", ")}${o.arg ? ` ${o.arg}` : ""}`;

export function findOption(token) {
  const t = token.startsWith("-") ? token : token === "root" ? token : `--${token}`;
  return OPTIONS.find((o) => o.names.includes(t));
}

export function renderHelp(version) {
  const w = Math.max(...OPTIONS.map((o) => label(o).length));
  return [
    `mem-audit ${version}`,
    "Audit coding-agent memory against the real repo and against itself — offline and deterministic.",
    "Never modifies memory; each run writes the audit files to <root>/mem-audit/ (see --out).",
    "",
    "Usage: mem-audit [root] [options]",
    "       mem-audit --help <option>   describe one option",
    "",
    ...OPTIONS.map((o) => `  ${label(o).padEnd(w)}  ${o.summary}`),
    "",
  ].join("\n");
}

export function renderOptionHelp(options) {
  return options
    .map((o) => [label(o), ...o.details.map((d) => `  ${d}`), "", `  Example: ${o.example}`].join("\n"))
    .join("\n\n") + "\n";
}
