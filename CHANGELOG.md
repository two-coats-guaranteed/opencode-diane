# Changelog

All notable changes to this project are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
on the understanding that the public surface for SemVer purposes is the
tool list (`memory_*`) and the documented `UserConfig` options.

## [0.0.9] — 2026-05-28

Two additions on top of 0.0.8: **fused recall** (default ON — a measured
win) and **goal-shift context compaction** (default OFF — experimental).

### Fused recall (default ON)

`memory_recall` now returns its routing hint *plus the body of the single
most query-relevant function* from the top-ranked file, in one response —
capped at `fuseRecallMaxLines` (150), falling back to pointer-only for
larger functions. Token-overlap scoring (snake_case / camelCase aware)
picks the function.

Rationale and result: session cost is dominated by turn count (each turn
re-bills the cached conversation). Fusing the relevant code into the
recall response collapses the locate→understand phase from several turns
to one. Measured on a 30-session, 3-way SWE-bench Lite run (Sonnet, fused
vs pointer-only vs baseline):

| metric (median) | fused | pointer-only | baseline |
|---|---:|---:|---:|
| solve rate | 10/10 | 9/10 | 7/10 |
| tool calls / session | 10.5 | 13.0 | 3.0 |
| $/session | $0.133 | $0.164 | $0.069 |
| cache_read | 127k | 178k | 10k |

Fused beats pointer-only on every axis (−19% cost, −28% cache_read, −2.5
tool calls, +1 solve) and — importantly — *stabilizes* behaviour: the
pointer-only worst case ran to 57 tool calls / 1.6M cache_read; fused
capped at 17. Config: `fuseRecallBody` (default true), `fuseRecallMaxLines`
(default 150).

### Goal-shift context compaction (default OFF, experimental)

When the conversation's goal shifts, mask the stale span's tool
observations (file reads, command output) — keeping reasoning intact —
and re-insert an archived segment's observations if the goal later drifts
back. Implements the "trigger + indexed re-insertion" loop described in
the recent agent-memory literature (Memex-style indexed experience;
observation-masking per Lindenbauer et al. 2025), with the explicit goal
of being non-lossy: originals are stashed (and independently re-fetchable
via the session API), so a premature compaction is recoverable — the
defence against "summarization drift".

- **Detection** is online and cheap. Default backend is lexical-cohesion
  (TextTiling-style cosine over a running term centroid, snake/camel
  aware), which is strong in the coding domain where a goal change drags a
  large vocabulary change with it. An embedding backend (reusing the e5
  model) is implemented and unit-tested but not wired into the live hot
  path, because the model loads asynchronously.
- **Compaction** rewrites the per-request message list via
  `experimental.chat.messages.transform`. This changes the request prefix
  and so causes a deliberate, accepted prompt-cache miss at each shift, in
  exchange for a smaller per-turn context for the rest of the new segment.
- **Hysteresis** (`minSegmentTurns`, default 2) prevents a single
  tangential turn from thrashing the segmentation.
- Entirely best-effort: any failure leaves the messages untouched and the
  conversation proceeds normally. When the flag is off, the transform hook
  is not registered at all.

Config: `enableContextCompaction` (default false), `contextDriftThreshold`,
`contextMinObservationChars` (default 400). EXPERIMENTAL — validate the
detector on your own transcripts (TIAGE / Pk / WindowDiff are the standard
tools) before relying on it.

## [0.0.8] — 2026-05-27

Added an experimental **AST-scoped read view** (`enableAstReadView`,
**default OFF**) and a `read_range` tool, then measured it and turned
it off. The hypothesis: intercept the `read` tool, replace large file
content with a compact structural view (definitions + line ranges),
and let the agent expand sections on demand via `read_range`. The goal
was to shrink the file content carried in the conversation so it
re-bills less on every cached turn.

**Measured net-negative.** A 20-session SWE-bench Lite run (2 instances
× 5 runs, Sonnet 4.6) against the v0.0.7b baseline:

| | v0.0.7b | v0.0.8 (on) | change |
|---|---:|---:|---:|
| solve rate | 10/10 | 10/10 | flat |
| $/session (mean) | $0.178 | $0.252 | **+42 %** |
| cache_read (mean) | 187 k | 374 k | **+100 %** |

**Why it failed.** Session cost scales roughly as
(conversation size) × (number of turns). The compressed view shrinks
the first factor but inflates the second: the agent calls `read_range`
to expand functions, each call is another turn, and every extra turn
re-bills the entire cached conversation — including diane's own
per-turn overhead (recall payload + tool descriptions), which is the
genuinely large part. Trading conversation size for turn count loses.
The view's `read_range(...)` hints also actively *invited* exploration:
one run made 11 expansions across six files (including files unrelated
to the bug), costing 1.57 M cache_read tokens in a single session.

The feature is retained behind `enableAstReadView` (off) for the one
regime where the math may flip positive — repos of very large files
(>400 lines) where the agent makes ≤3 expansions per file — and as a
documented record so the idea is not blindly re-attempted. The `read`
tool's default behaviour is unchanged from v0.0.7b. See EVAL.md for
the full diagnosis.

The actionable lesson carried into the next iteration: the lever that
moves cost is **turn count**, not file-content size. Reducing turns
(e.g., delivering the relevant code in the same response as the recall
that points to it) is the direction to pursue.

## [0.0.7] — 2026-05-23

This release is the response to the project's first external evaluation:
a 40-session controlled run against SWE-bench Lite (2 instances × 5
runs × 2 conditions × 2 models). The eval contradicted the README's
prior "80–89 % token reduction" claim — diane used ~1.8× as many
tokens as the no-memory baseline at both Haiku 4.5 and Sonnet 4.6,
with no solve-rate benefit. Its one measurable upside was a ~40 %
wall-clock reduction on Sonnet. Tool-call traces also showed that of
the ten `memory_*` tools, the agent only ever called three across
all 21 diane sessions.

This release rebases positioning and defaults on those measurements.

### Changed — positioning

- **README and WIKI rewritten** around the actual measurement. Dropped
  the "80–89 %" headline; replaced with the per-model hit-rate /
  $/session / wall-clock table from the SWE-bench run. The pitch is
  now "tokens for latency, ~40 % wall-clock reduction on Sonnet at
  ~1.8× cost premium," not "saves tokens."
- `scripts/measure-savings.mjs` re-framed: it estimates an *upper bound*
  of how much of a hypothetical discovery recipe the recall could
  replace, **not** end-to-end agent cost. The script is kept for repo
  introspection; the corroborating measurement is the SWE-bench
  eval, not the synthetic one.

### Changed — defaults

- **`exposeOpsTools` (new, default `false`)** hides the seven
  `memory_*` tools the eval showed the agent never calls
  (`memory_snapshot`, `memory_status`, `memory_code_map`,
  `memory_skill`, `memory_ingest_sessions`, `memory_ingest_git`,
  `memory_mine_skills`). The default registration is now three:
  `memory_recall`, `memory_outline`, `memory_remember`. Set to
  `true` to restore the full ten-tool surface for explicit ops
  workflows.
- **Opportunistic ingesters now opt-in.** Defaults for `ingestDocs`,
  `ingestProjectNotes`, `ingestTableHeaders`, `ingestCrossRefs` are
  now `false`. They added startup latency without a measurable
  retrieval-quality benefit in the eval. Code-map and git-history
  remain on by default — those are the two that actually drive
  recall.

### Changed — retrieval

- **Confidence-based payload sizing in `memory_recall`.** The recall
  now inspects the BM25 score distribution and shapes its return:
  - **Peaked** (top-1 / top-3 ≥ 2.0): top 1–3 hits with full content,
    rest suppressed. The store believes it knows the answer.
  - **Flat** (ratio ≤ 1.5): paths only, no content. The store has no
    confident answer — half a page of paths beats third-of-a-page
    blocks of half-relevant content. Includes an explicit "scores are
    flat — read the file directly or refine the query" line.
  - **Moderate** in between: the previous token-budgeted behaviour.
  The `pylint-6506` failure in the eval was diane confidently
  misrouting on a high-but-wrong BM25 score; this is the targeted
  response.
- **Directional co-change boost.** The one-hop co-change boost now
  scales by `1 / (1 + log2(churn))` of the neighbor file: a
  rare-changer (e.g. `config_initialization.py`) gets full boost, a
  churn-heavy file (`run.py`, `conftest.py`) gets meaningfully less.
  Behavioural bugs land more often in rare-changers, while
  churn-heavy files are usually generic touchpoints — the damping
  pushes the recall toward the locus of the bug instead of the most
  active file in the repo. Falls back to flat (un-damped) behaviour
  when no churn data is available, matching pre-v0.0.7.
- **Tool descriptions trimmed.** `memory_recall`, `memory_outline`,
  and `memory_remember` descriptions cut by ~60 % each; the
  "ALWAYS call this FIRST" steering removed. Each description now
  states the typical token cost and an explicit "skip when" clause.
  Less system-prompt overhead per turn; less reflexive use.

### Verification

- 691 test assertions still pass (`bun test`); typecheck and build
  clean.
- Pending: re-run the 40-session SWE-bench harness against this
  release to measure whether the cost premium drops toward 1.0×.

## [0.0.6] — 2026-05-22

### Added
- **Bounded-parallel file reads in the heavy ingesters.** New
  `src/utils/concurrent.ts` exposes `mapConcurrent(items, n, fn)`:
  a worker-pool topology with in-input-order results, used by
  `ingestCodeMap` (16-wide) and the cross-reference ingester's
  `collectFiles` (32-wide). Both passes split into a phase-1 walk
  that collects candidate paths and a phase-2 parallel read; the
  walk preserves DFS order so the `maxFiles` cap selects the same
  candidate set as the pre-refactor implementation. Measured on
  this repo's 80-file source tree, the parallel read finishes in
  3.6 ms vs 376 ms sequential on cold cache (~104× speedup) and
  in 1.2 ms vs 2.6 ms warm (~2×). The cold-cache gain dominates
  in real use because OpenCode session start hits the disk fresh;
  the warm case is repeat ingests within the same session. The
  other ingesters (docs, tables, project-notes) remain sequential
  — they walk small file sets where the wins don't justify the
  change. New test suite `tests/concurrent.test.ts` (10
  assertions) covers in-order results, the concurrency cap, error
  propagation, and degenerate inputs; the parallel paths are
  additionally stress-tested out-of-tree against a shared-parser
  multi-language workload and a 1,000-file collectFiles
  correctness check.
- **New WIKI section *Prompt-cache friendliness*.** Spells out what
  is byte-stable across same-state recalls and what is
  deliberately not. Linked from the README's *Learn more* list.

### Fixed
- **Live-session memory no longer drifts every minute.** The header
  previously read `Live session <id> (started <N>m ago): …`, where
  `N` was recomputed from `Date.now()` on every render. A
  prompt-cache audit found that this ticked the agent-visible
  content every full minute even when no new edits or bash
  commands had happened, busting cached recall prefixes that
  happened to surface the live trace. The header is now `(started
  <ISO-startedAt>): …` — fixed for the recorder's lifetime and
  bit-identical across renders until the session itself restarts.

### Notes
- Codebase prompt-cache audit findings recorded in WIKI:
  tool descriptions are static literals; no `Math.random` anywhere
  in `src/`; BM25 / PPR / tokeniser are pure; output ordering is
  deterministic. Two intentional non-determinisms left in place
  and documented: the `0.05 × ln(1 + useCount)` popularity bias
  (frequently-used memories edge up over time) and
  `memory_remember`'s id-bearing acknowledgement (every write is
  distinct anyway).
- Test count: **691 assertions across 26 test suites** (up from
  674/24 in v0.0.5). New suite `tests/concurrent.test.ts` adds
  10 assertions covering the helper itself; new suite
  `tests/concurrency-stress.test.ts` adds 7 covering the
  shared-parser safety claim and in-order results under load.

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
