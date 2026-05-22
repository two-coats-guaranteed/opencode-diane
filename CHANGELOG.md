# Changelog

All notable changes to this project are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
on the understanding that the public surface for SemVer purposes is the
tool list (`memory_*`) and the documented `UserConfig` options.

## [0.0.5] — 2026-05-22

### Added
- **Live-session activity recording (`recordSessionActivity`, default
  `true`).** The current session's file edits and bash commands are
  now rolled up into a single memory under `session-trace` →
  `live:${sessionId}`, upserted in place after each event. Lets the
  current session recall what it has already touched without scanning
  the OpenCode SDK, and pre-seeds the trace for the moment this
  session becomes "past" to a successor. The memory is not pinned —
  transient state should be evictable. JSONL logs are unchanged; this
  is a recall surface, not an audit log. New module
  `src/ingest/live-session.ts` (~160 lines), bounded by
  `MAX_CONTENT_BYTES` and per-buffer caps so a long session can't
  swell the store.
- **Bash file-change tracking (`bashFileTrackingMaxFiles`,
  default `20`).** After every `bash` tool call the plugin runs
  `git status --porcelain` and refreshes the code-map for each
  touched file (modified or untracked, deletions skipped). Closes the
  long-standing "bash-driven changes are a known gap" caveat —
  `git checkout other-branch`, `npm run format`, `cargo fmt --all`,
  and similar now keep the code map fresh. Capped to bound post-hook
  latency on mass-checkout situations; raise or set to `0` to
  disable.
- **Auto git re-ingest on HEAD movement (`autoReingestGitOnHeadChange`,
  default `true`).** After every `bash` call the plugin polls
  `git rev-parse HEAD`; if HEAD moved (pull / merge / rebase /
  checkout / reset), it queues a background re-ingest of git
  history. Idempotent — already-known commits are skipped via
  `insertIfMissing`. Concurrent triggers coalesce (one re-ingest at a
  time; further detections re-arm the flag for the next poll). Closes
  the post-merge invisibility gap surfaced by the v0.0.4 verdict.
- **`memory_ingest_git` tool (the 10th).** Explicit on-demand
  re-ingest of git history for cases the auto-detect can't cover
  (a `git fetch` without merge that nonetheless brings new commits
  via another mechanism). Returns a human-readable summary of new
  commit / co-change / churn / recency memories added.
- New helpers in `src/utils/shell.ts`: `currentHead(cwd)` (returns
  the HEAD SHA or null) and `changedFilesInWorktree(cwd)` (parses
  `git status --porcelain` into a file list, handling renames,
  deletions, and C-quoted paths). Both are non-throwing — they
  return safe empty values on non-git directories or git failures.

### Changed
- The tool count is now **ten** (was nine in v0.0.4). The new tool is
  additive — existing tool semantics are unchanged.
- Live-session memories share the `session-trace` category with past
  sessions, distinguished by subject prefix: `task:` / `trace:` for
  past, `live:` for current.

### Notes
- All three new behaviours default ON. Set the corresponding config
  to `false` (or `0` for `bashFileTrackingMaxFiles`) to opt out. The
  JSONL audit log captures the same events regardless.
- Test count: **674 assertions across 24 test suites** (up from
  641/23 in v0.0.4). New suite `tests/live-session.test.ts` adds
  33 assertions; two pre-existing plugin-test assertions and one
  smoke-script assertion were updated from "nine tools" to "ten".

## [0.0.4] — 2026-05-22

### Added
- **Grammar-agnostic cross-reference ingester (`ingestCrossRefs`,
  default `true`).** Discovers file→file edges for languages
  tree-sitter doesn't cover (Pascal, Ruby, Perl, Elixir, Lua, R,
  Haskell, Scala, Kotlin, Swift, Crystal, Nim, Tcl, OCaml, F#, Dart,
  Erlang, Clojure, Elm, Zig, Ada, **plus Verilog, SystemVerilog,
  VHDL, COBOL, Fortran (modern, .f90+), Solidity, D, Vim script,
  Smalltalk, Racket/Scheme, Common Lisp, Modula-2**) and for
  low-code DSLs (GitHub Actions, Docker Compose, k8s kustomize,
  Terraform, Ansible, n8n-shaped JSON workflows, OpenAPI, Protocol
  Buffers, Thrift, GraphQL). Uses **multi-signal corroboration** to
  keep FP low: path-resolvable strings (filesystem-grounded; single
  signal sufficient) and rare identifier references corroborated by
  import-line context OR filename↔identifier coupling (lexical
  matches alone are deliberately rejected). Three new import-line
  patterns: Verilog backtick-include (`` `include "file.v" ``),
  COBOL `COPY copybook.cpy.`, Vim `runtime path/file.vim`.
  Per-extension comment-line skipping prevents Lisp `; alu` in
  comments from spuriously coupling to `alu.v`. Each edge becomes a
  memory under `xref:<from>→<to>`. 52 assertions in
  `tests/cross-refs.test.ts` exercise the language + DSL matrix
  including FP-control negatives.
- **Generic markdown ingestion (`ingestDocs`, default `true`).** Walks
  `<root>/docs/` recursively and a fixed set of conventional root
  docs (CHANGELOG, CONTRIBUTING, ARCHITECTURE, ROADMAP, TODO, NOTES,
  SECURITY, HISTORY, GOVERNANCE, MAINTAINERS, AUTHORS,
  CODE_OF_CONDUCT). Each H1/H2/H3 heading becomes a recallable
  section pointer: `memory_recall { query: "installation" }` now
  returns `docs/install.md:15  ## Installation` + first paragraph —
  the agent gets a precise pointer it can hand to `read` without
  grepping the docs tree. Headings inside fenced code blocks are
  correctly ignored. Bounded walk (200 files, 50 headings/file,
  256 KB/file). Tests in `tests/docs-ingest.test.ts`.
- **Project-notes ingestion (`ingestProjectNotes`, default `true`).**
  Indexes root-level agent-instruction files as project facts:
  `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `COPILOT.md`,
  `CONVENTIONS.md`, `.cursorrules`, `.windsurfrules`, `.clinerules`.
  One memory per file (truncated to 6 KB) plus a directory-summary
  memory listing what was found, so the agent learns the repo's
  house rules in the first recall. Tests in
  `tests/extra-ingesters.test.ts`.
- **Table-header ingestion (`ingestTableHeaders`, default `true`).**
  Walks for `.csv`, `.tsv`, `.xlsx`, `.xls`, `.xlsm` files and
  indexes *only the column headers* — `users.csv (CSV, 4 columns):
  id, email, signup_date, plan_tier`; for spreadsheets, each sheet
  becomes its own memory (`table:budget.xlsx#users`,
  `table:budget.xlsx#events`). Row data is never loaded; even a 10 GB
  CSV or a workbook with 1 M rows costs the same as a 10-row file.
  RFC-4180-ish CSV parsing handles quoted fields with embedded
  commas; single-column files / sheets and binary files are
  rejected. XLSX support uses SheetJS, **lazy-imported only when a
  spreadsheet is actually encountered** — projects with no
  spreadsheets pay no module-load cost. SheetJS is invoked with
  macros, formulas, and styles disabled (minimum surface). Tests
  in `tests/extra-ingesters.test.ts`.

### Changed
- **`enableCodeMap` now defaults to `true`.** The tree-sitter
  signature map is built on first startup so the agent has the
  structural shape of the codebase from the first session. Set to
  `false` to disable (the ~10 MB grammars ship in the package
  regardless).
- **Soft-force adoption.** A new `installUsageSkill` option (default
  `true`) writes `<skillsOutputDir>/<prefix>using-memory/SKILL.md` on
  first startup so OpenCode surfaces a "call `memory_recall` first"
  instruction to the agent at session start. Written only when the
  file does not already exist — user edits and user deletions both
  survive every subsequent startup. Set `installUsageSkill: false` to
  never write it.

## [0.0.3] — Unreleased

First public preview release.

### Added
- Nine `memory_*` tools (`recall`, `remember`, `snapshot`, `status`,
  `code_map`, `outline`, `ingest_sessions`, `mine_skills`, `skill`).
- BM25 lexical recall with one-hop co-change boosting; opt-in
  Personalized PageRank for multi-hop recall (`personalizedPageRank`).
- Tree-sitter code-map across 10 languages plus JSON/CSS/HTML
  (`enableCodeMap`).
- Cross-lingual semantic search via a small multilingual e5 model
  (`enableSemanticSearch`, optional `@huggingface/transformers`).
- Skill mining: cluster-derived `SKILL.md` files from past sessions.
- Structured JSONL logs under `$OPENCODE_DIANE_LOG_DIR` (or
  `os.tmpdir()/opencode-diane/`) with `analyze-logs.py` reader.
- Plugin version flows from `package.json#version` to the
  `plugin.active` event and `memory_status` output — single source of
  truth, no second place to update.
- Defensive legacy-JSON → SQLite migration that never crashes plugin
  startup even when another plugin is contending for the database.

### Reliability
- `MemoryRepository.load` accepts an `onMigrationError` callback so a
  failed legacy migration logs cleanly and the plugin continues with
  an empty database rather than failing to start. Regression test in
  `tests/store.test.ts`.
- Auto-detects coexisting plugins (`oh-my-opencode`/`oh-my-openagent`/
  `oh-my-opencode-slim`, and any `caveman` packaging) by reading the
  `plugin` array in `opencode.json`. When a peer is present and the
  user hasn't overridden the relevant option, disables the
  tool-output nudge hook (oh-my-opencode also rewrites tool output)
  and prefixes mined-skill subdirectories with `diane-` (so skills
  in the shared `.opencode/skills/` directory don't collide with the
  peer's slugs). Standalone behaviour is unchanged. Tests in
  `tests/peer-compat.test.ts`.

### Coverage
- 460+ assertions across 16 suites; 91%+ line coverage; size ceiling
  enforced in CI.
