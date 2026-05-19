# opencode-diane

A memory layer for [OpenCode](https://opencode.ai). It gives the
coding agent a persistent, searchable store of structural facts about
a repository, so it stops re-discovering the same things — with raw
`git log`, `grep`, and file reads — every single session.

Named for Agent Cooper's unseen assistant in *Twin Peaks*: the agent
dictates what it learns about the codebase; Diane keeps it.

## TL;DR for a decision-maker

- **What it is.** A hierarchical, BM25-ranked memory store for any git
  repository, in any language. It pre-fills itself from git history
  and project files; the agent reaches it through nine `memory_*`
  tools.
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
- **What it costs.** Core plugin: ~77 KB plus one small dependency; a
  few hundred MB of RAM for a large store. The optional code map adds
  ~16 MB of vendored grammar files.
- **What it is not.** Not an LLM, not an unbounded archive (a
  configurable disk budget, 50 MB by default, ages out least-used
  facts), not a replacement for `AGENTS.md`. Not a vector store by
  default — lexical BM25 — though cross-lingual semantic search is
  available as an explicit opt-in.
- **Maturity.** 444 assertions across 15 test suites, ~90 % line
  coverage; verified against the documented plugin contract and
  dry-run on real repos in 10 languages. Not yet run end-to-end inside
  a live OpenCode *server* — see the WIKI.

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
loads, runs prefill in the background, registers all nine tools, and
the agent can use them immediately. If the directory is neither a git
repo nor has a recognised manifest, the plugin logs one idle line and
does nothing.

The optional Aider-style code map is **off by default** because its
tree-sitter grammars add ~16 MB to the install. To enable it, use the
`[name, options]` tuple form and restart OpenCode:

```json
{
  "plugin": [["opencode-diane", { "enableCodeMap": true }]]
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
  enableCodeMap?: boolean        // default false  (see WIKI: Code map)
  enableNudgeHook?: boolean      // default true   (see WIKI: Compatibility)
  adaptive?: boolean             // default true   (see WIKI: Adaptive sizing)
  enableSemanticSearch?: boolean // default false  (see WIKI: Semantic search)
  embeddingModel?: string        // default "Xenova/multilingual-e5-small"
  personalizedPageRank?: boolean // default false  (co-change ranking; see WIKI)
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
