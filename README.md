# opencode-diane

[![npm](https://img.shields.io/npm/v/opencode-diane.svg)](https://www.npmjs.com/package/opencode-diane)
[![CI](https://github.com/two-coats-guaranteed/opencode-diane/actions/workflows/ci.yml/badge.svg)](https://github.com/two-coats-guaranteed/opencode-diane/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A memory layer for [OpenCode](https://opencode.ai). It gives the
coding agent a persistent, searchable store of structural facts about
a repository, so it stops re-discovering the same things — with raw
`git log`, `grep`, and file reads — every single session.

Named for Diane in *Twin Peaks* — the recipient of Dale Cooper's
recorded case notes. The plugin works the same way: it keeps the
record of what your coding agent learns about a codebase.

## TL;DR for a decision-maker

- **What it is.** A hierarchical, BM25-ranked memory layer for any git
  repository. It pre-fills itself from git history, project files,
  docs, agent-instruction files (AGENTS.md, CLAUDE.md, .cursorrules),
  table column headers, and grammar-agnostic cross-file edges; the
  agent reaches it through ten `memory_*` tools.
- **The problem it solves.** An agent re-greps and re-reads the same
  files every session. One bounded `memory_recall` replaces many raw
  discovery calls.
- **Token reduction.** 80–89 % measured *when a recall covers the
  task* — a ceiling, not a promise; lower on terse-history, mature, or
  tiny repos. The bundled `dry-run.mjs` gives *your* repo a GOOD /
  MODERATE / LOW verdict before you rely on it.
- **Deterministic.** BM25 over a hand-built index — no embeddings, no
  model, no API key, no GPU, no network. Reproducible and debuggable.
  (One opt-in exception: semantic search — off by default — adds an
  embedding model for cross-lingual recall. See below.)
- **Convention-free.** It never parses commit messages for meaning;
  every signal is a physical fact (files touched, lines ±, co-change).
  It behaves identically on a `wip` / `.` / `更新` history and a
  pristine one.
- **Languages.** Code map covers 13 tree-sitter grammars. The
  grammar-agnostic cross-reference ingester extends this to 30+
  languages (Pascal, Ruby, Perl, Elixir, Verilog, VHDL, COBOL,
  Fortran, Solidity, Smalltalk, Racket, Common Lisp, Vim script, and
  more) plus low-code DSLs (GitHub Actions, k8s, Terraform, n8n).
- **What it costs.** ~1.6 MB packed, ~17 MB unpacked (includes
  tree-sitter grammar `.wasm` files and SheetJS for spreadsheet
  headers). A few hundred MB RAM for a large store. Dependencies:
  `@opencode-ai/plugin`, `web-tree-sitter`, `xlsx`.
- **What it is not.** Not an LLM, not an unbounded archive (a
  configurable disk budget, 50 MB by default, ages out least-used
  facts), not a replacement for `AGENTS.md` (though we *read*
  AGENTS.md and index its contents). Not a vector store by default —
  lexical BM25 — though cross-lingual semantic search is available as
  an explicit opt-in.
- **Maturity.** 674 assertions across 24 test suites, ~90 % line
  coverage; verified against the documented plugin contract in 30+
  languages and against live builds with oh-my-opencode and caveman
  as coexisting plugins. Not yet run end-to-end inside a live OpenCode
  *server* — see the WIKI.

**The full design — how the memory is structured, how retrieval works,
what happens without git, scaling numbers, how it compares to other
approaches, and every honest limitation — is in
[WIKI.md](./WIKI.md).** Start there with *Straight answers for a
decision-maker*.

## The tools

| Tool | What it does |
|---|---|
| `memory_recall` | BM25 search over the store — co-change-boosted, token-budgeted, with optional `category` / `subject` filters. The recall-first entry point. |
| `memory_code_map` | Aider-style structural map: per-file signatures of functions/classes/types, ranked and budgeted. Needs `enableCodeMap`. |
| `memory_remember` | Store an explicit note for future turns. |
| `memory_snapshot` | Record this session's *understanding* — mental model, decisions, conventions — for a later or parallel session to resume from. |
| `memory_outline` | Counts per category — token-cheap orientation. |
| `memory_status` | Size, byte usage vs budget, last-ingest timestamps. |
| `memory_ingest_sessions` | Pull task + tool-trace summaries from past OpenCode sessions. |
| `memory_ingest_git` | Re-scan git history for new commits after a pull / merge / rebase. Idempotent — already-known commits are skipped. The plugin also auto-runs this in the background when it detects HEAD moved as a side effect of a `bash` call. |
| `memory_mine_skills` | Cluster memories by subject into `SKILL.md` files. Runs in the background. |
| `memory_skill` | List the mined skill files, or load one into the conversation — so a skill mined this session is usable now, no restart. |

## Install

```bash
npm install opencode-diane
```

Then in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-diane"]
}
```

Open OpenCode in any git repository, in any language. The plugin
loads, runs prefill in the background, registers all ten tools, and
the agent can use them immediately. If the directory is neither a git
repo nor has a recognised manifest, the plugin logs one idle line and
does nothing.


The Aider-style code map is **on by default** since v0.0.4 — it gives
`memory_code_map` and recall enough structural signal (per-file
function/class/type signatures, 13 tree-sitter grammars) that turning
it off is rarely worth it. The grammar `.wasm` files (~16 MB,
vendored under `grammars/`) ship with the package regardless, since
they're loaded lazily on first use; the option only controls whether
the plugin parses files at prefill. If you want to skip that parsing
— for a tighter prefill on a huge monorepo, or on a non-source repo
where the code map adds no signal — disable it via the
`[name, options]` tuple form:

```json
{
  "plugin": [["opencode-diane", { "enableCodeMap": false }]]
}
```

### Install from a local clone

```bash
git clone <repo-url> opencode-diane
cd opencode-diane
bun install      # fetches @opencode-ai/plugin into ./node_modules
bun run build    # compiles src/ -> dist/
```

Then point `opencode.json` at the built file:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-diane/dist/index.js"]
}
```

`bun install` is required for the local form — OpenCode resolves
plugin imports through the module resolver, so
`node_modules/@opencode-ai/plugin` must sit next to `dist/`.

## Configuration

Every setting is optional with a sensible default. To override, list
the plugin as a `[name, options]` tuple — OpenCode passes the options
object straight through, and bad or unknown keys are ignored so a
malformed config never breaks the plugin.

```ts
interface UserConfig {
  maxMemoryDiskMB?: number       // default 50
  autoIngestOnStartup?: boolean  // default true
  gitHistoryDepth?: number       // default 500
  forceActive?: boolean          // default false
  skillsOutputDir?: string       // default ".opencode/skills"
  skillMiningMinCluster?: number // default 3
  ingestSessions?: boolean       // default true
  enableCodeMap?: boolean        // default true  (see WIKI: Code map)
  installUsageSkill?: boolean    // default true  — write a using-memory skill on first startup
  ingestDocs?: boolean           // default true  — index docs/ headings as section pointers
  ingestProjectNotes?: boolean   // default true  — index AGENTS.md, CLAUDE.md, .cursorrules, …
  ingestTableHeaders?: boolean   // default true  — index CSV/TSV/XLSX column headers
  ingestCrossRefs?: boolean      // default true  — grammar-agnostic cross-file edge discovery
  crossRefsRarityThreshold?: number // default 3 — max files a symbol can appear in to count
  enableNudgeHook?: boolean      // default true  (see WIKI: Compatibility)
  adaptive?: boolean             // default true  (see WIKI: Adaptive sizing)
  enableSemanticSearch?: boolean // default false (see WIKI: Semantic search)
  embeddingModel?: string        // default "Xenova/multilingual-e5-small"
  personalizedPageRank?: boolean // default false (co-change ranking; see WIKI)
  recordSessionActivity?: boolean      // default true  — record this session's edits + bash as a rolling memory
  bashFileTrackingMaxFiles?: number    // default 20    — refresh code-map for files a bash call touched (0 = off)
  autoReingestGitOnHeadChange?: boolean // default true — re-ingest git when bash moves HEAD (pull/merge/rebase)
}
```

With `adaptive` on (the default), prefill measures one cheap signal —
commit count, or file count when there is no git — and scales the
history depth and code-map file cap to the repo's size. An explicit
value in your config always wins.

`maxMemoryDiskMB` is the disk budget for the memory store: once it is
exceeded, least-used memories are evicted (pinned ones never). The
default is 50 MB — generous enough that a realistic store (even on a
large repo, ~4–6 MB) never hits it, so eviction acts as a safety valve
rather than a routine clip. Note it also bounds RAM: the search index
is held in memory at roughly 70 MB of heap per 1 MB of budget *if
filled*, so on an unusually large monorepo, lower it to cap memory or
raise it for a deeper store. See *Performance* in the WIKI.

`enableSemanticSearch` (default **off**) adds opt-in cross-lingual
recall: with it on, the plugin also embeds memories with a small
multilingual e5 model and fuses vector similarity with the BM25
ranking, so a query in one language (Russian, Chinese, …) can retrieve
code and comments written in another. It needs the optional
`@huggingface/transformers` dependency (`bun add @huggingface/transformers`);
the model downloads on first use. When off — the default — no model is
downloaded, the dependency is never loaded, and retrieval is the
unchanged lexical path. See *Semantic search* in the WIKI.

### Fine-grained tuning

Most users never set these — the defaults cover typical repos. They
exist for monorepos, documentation-heavy projects, and locked-down
environments where every walk needs an explicit ceiling. All numeric
limits are clamped to a safe minimum and rounded; garbage input in
`opencode.json` never breaks the plugin.

| Option | Default | What it does |
|---|---|---|
| `docsMaxFiles` | `200` | Cap on `.md` / `.markdown` files walked under `docs/` plus conventional root docs (CHANGELOG, CONTRIBUTING, ARCHITECTURE, ROADMAP, …). |
| `docsBodyChars` | `240` | Characters of body text captured after each heading as the recall snippet. |
| `docsMaxHeadingLevel` | `3` | Deepest heading level indexed (`3` = H1–H3). Clamped to `[1, 6]`. |
| `notesMaxBytes` | `6144` | Maximum bytes read from each agent-instruction file (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, …). |
| `tablesMaxFiles` | `200` | Cap on table files (CSV / TSV / XLSX / XLS) walked per prefill pass. |
| `tablesMaxXlsxMB` | `50` | Skip XLSX/XLS files larger than this (in MB). Set `0` to skip all spreadsheets. |
| `tablesMaxColumns` | `40` | Maximum column headers listed per table/sheet. Wider tables get a `(N more)` note. |
| `crossRefsMaxFiles` | `2000` | Cap on files the cross-reference ingester walks per prefill. Raise for monorepos. |
| `crossRefsMaxEdges` | `10000` | Hard cap on cross-reference edges emitted per pass. |
| `coChangeMinOccurrences` | `3` | Minimum commits in which two files must co-change before a co-change edge is recorded. |
| `codeMapMaxFiles` | adaptive (`1500` / `4000` / `10000`) | Cap on source files the code-map ingester parses per pass. With `adaptive: true` (the default), this is sized at startup by the small / medium / large tier. Setting it explicitly *overrides the adaptive choice*. |
| `coChangeMaxCommits` | `5000` | Cap on git commits the co-change graph builder scans. Adaptive sizing keeps this uniform across tiers in the current implementation; only `codeMapMaxFiles` and `gitHistoryDepth` vary by tier. |

## Learn more

[WIKI.md](./WIKI.md) covers everything else, including:

- *Straight answers for a decision-maker* — the questions above, in depth
- *How the memory is structured* — the record shape and the hierarchy, with diagrams
- *The pillars* — retrieval, prefill, code-health, and the rest, with diagrams
- *How it compares* — versus embeddings, aider's repo-map, and `AGENTS.md`
- *Without git history* — what works, what doesn't, and why
- *Semantic search* — the opt-in cross-lingual embedding feature
- *Token savings* — what reduction to expect, and how it is measured
- *Performance* & *Scaling* — measured numbers, and the honest heap caveat
- *Code map*, *Session snapshots*, *Skill mining*, *Rich logs*, *Tests & CI*

## License

MIT.