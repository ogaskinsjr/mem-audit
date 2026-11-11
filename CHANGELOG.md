# Changelog

All notable changes to mem-audit are listed here. Versions follow [Semantic Versioning](https://semver.org).

## [1.1.0] - Unreleased

### Changed

- **Breaking:** `--out` now names a folder, not a file. Every run writes `<root>/mem-audit/` by default; 1.0.0 wrote `./mem-audit.json` in the current directory.
- **Breaking:** a note that names something found in a git repo next to the audited one is now `misplaced` instead of `stale`, so `--fail-on stale` no longer fails on it. `--no-siblings` restores the old result.
- When two notes give different values for the same thing, the value the code sets wins. If the code sets neither, both notes are flagged. 1.0.0 let the newer date win.
- `repo-fact` now needs a path, symbol, env var, script or route the repo has. A flag or a loose word is no longer enough.
- A note that records a removal is `history` only when git has a record of the removed thing; otherwise it is left for `review`. Lines that start with "Verified:" are also `history`.
- User-level memory is `keep-local` and is no longer judged against the audited repo. Notes that name a macOS application path are `keep-local` too.
- Finding messages are reworded, for example "`src/legacy.ts` isn't in app".
- The DocuSOR tip appears under each report section that has entries instead of once at the end. `--no-hint` hides all of them.

### Added

- Verdicts:
  - `misplaced`: the note is about a git repo next to this one, and the finding names that repo. Env vars, snake_case names and paths that point outside the repo are looked up there too.
  - `narrowed`: the note was replaced only for a stated scope ("for new jobs only") and still applies otherwise.
  - `guidance`: a rule or reason the code can't show. Keep it.
- Findings that keep the entry's verdict and are never counted as problems:
  - `restates`: looks like the same fact as another entry, in different words.
  - `still-present`: says something is gone that the code still has, and names where.
- Checks against the code:
  - Ports, on/off defaults, "X is N" sentences and bracketed defaults such as "(72h default)" are compared with what the code assigns. Units are understood (`60s` matches `JOB_TIMEOUT_MS = 60_000`), and so are products (`72 * 3_600_000`).
  - A stated default the code has nothing for is `stale`. A lone "X is N" sentence is left alone, because the number may be a measurement.
  - `NAME=value` settings are checked against the line that sets them.
  - "Used only" claims about an env var are checked against the files that use it.
- Checks against other notes:
  - "(was X)", "from X to Y" and "for X only" are read when notes disagree.
  - A note about an open problem or a guess is `superseded` once a later heading in the same file settles it, or a later sentence says it was wrong.
- Output folder:
  - `summary.json`: counts, what each verdict means, what to do about it, and which file holds it.
  - `mem-audit.json`: the full audit, the same document as `--json`.
  - `agent-todos/`: one file per verdict or finding that has something to do.
  - `audit-ready/`: `guidance.json` and `keep-local.json`, the notes that need no change.
  - `.gitignore`: keeps the folder out of git.
  - Verdict files left by an earlier run that no longer apply are removed.
- A `reason` on every entry. Values confirmed in the code are listed after `checked:` with the file and line.
- A `state` block with the repo commit, a dirty flag and a hash per memory file, so a reader can tell when the audit is out of date.
- `restates` and `still_present` counts in the summary.
- `--no-siblings`: don't search the repos next to the audited one.
- Anchors: `.txt` and `.xml` files, `NAME=value`, and directories written as `name/`.
- For contributors: `npm run score` compares a build with hand labels for real agent memory.

### Fixed

- "A replaces B" retired both A and B. Only B is retired now, and "A replaced by B" retires only A.
- A replacement that applies to some cases only ("for new jobs only") no longer counts as a removal.
- A note that says a name is absent ("NOT X", "X — not in repo tree") is no longer `stale` for naming it.
- A path at the end of a sentence ("only in src/auth.ts.") no longer loses its directory.

## [1.0.0]

Initial release.