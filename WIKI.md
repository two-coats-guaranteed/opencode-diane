# opencode-diane — Wiki

## What it is

A plugin for [OpenCode](https://opencode.ai) that gives the agent a
hierarchical, BM25-ranked memory store for **any git repository, in any
language**. It pre-fills itself from git history and project files,
lets the agent ingest past OpenCode sessions, and mines its own
contents into reusable `SKILL.md` files. No embeddings, no LLM
round-trips, no convention assumptions — by default. (Cross-lingual
semantic search is available as an explicit opt-in; see *Semantic
search*.)

The name is a *Twin Peaks* reference. Throughout the show, Dale
Cooper recorded his case notes for Diane, the recipient of his
investigation log. The plugin plays that role for a coding agent — a
persistent memory layer that holds everything it has observed about
the codebase. "Diane, I'm standing at the edge of a large
repository, and I have some thoughts on the commit history."

## Why it exists

The agent re-discovers the same things every session: which files
change together, what's in the build manifest, which files are
hotspots. Each rediscovery costs many tool calls. A small store of
compact, structural facts, queryable with BM25, replaces those
discoveries.

It's also a substrate for skill mining: after enough history the store
contains real patterns, and the miner turns clusters into OpenCode
`SKILL.md` files. Those are usable in the *same* session via the
`memory_skill` tool — no restart — and OpenCode also picks them up as
native skills on the next startup.

## No conventions — only structure

The hard rule: the plugin never interprets *culture*. It does not
parse commit messages for intent, does not assume a commit-message
style, does not reach into a language's semantics. Real repositories
often have no commit-message culture at all (`wip`, `.`, `更新`,
empty) — message-derived classification is noise dressed up as signal.

Everything the plugin derives is a **fact about what physically
happened or physically exists**:

- From git: per-commit diff *shape* (files touched, lines ±, files
  created/deleted), file *co-change*, file *churn*, *recency*. The
  commit subject is stored verbatim as searchable text — data, never
  signal.
- From the tree: a file-extension census (the language signal emerges
  from the data), the top-level layout, and recognised project/build/CI
  files summarised **by format only** (JSON → keys, TOML → sections,
  `Makefile` → targets, …). Recognising that a file is *named*
  `Cargo.toml` is a fact, like knowing a file extension; interpreting
  Rust's dependency model would be a convention, and the plugin does
  not do that.
- From the language server (live): current diagnostics per file —
  the compiler's / type-checker's own output, normalised by LSP
  across 40+ languages. No heuristics.
- From tree-sitter (opt-in): per-file definition *signatures* — the
  structural shape of the code, bodies stripped.

## Straight answers for a decision-maker

Short answers to the questions that decide whether this is worth
adding. Each links to the section with the full story.

**How is the memory structured?**
Every memory is one flat record — a `category`, a `subject`, verbatim
searchable `content`, structural `tags`, and bookkeeping fields
(`use_count`, `size_bytes`, `pinned`). There is no graph, no nesting,
no per-category schema. See [How the memory is
structured](#how-the-memory-is-structured).

**What does "hierarchical" mean here?**
Two address levels: a fixed top-level `category` (nine kinds — git
history, project facts, code map, …) and a free-form `subject` (a file
path, a task slug). Retrieval filters by either or both *before*
scoring, so narrowing to "the git history of `context.go`" costs
nothing. The hierarchy is those two filter levels — not a tree of
objects.

**What if the repo has no git history?**
The plugin still activates on any recognised manifest and still gives
you project facts, the code map, LSP code-health, and everything
session-driven — but the single largest source (per-commit memories,
co-change, churn, recency) is gone, so day one is thin. It grows
useful over sessions as snapshots and notes accumulate. `git init`
unlocks more than half the value. See [Without git
history](#without-git-history).

**What if commit messages are meaningless ("wip", "fix", ".")?**
By design this changes nothing about correctness. The plugin never
classifies a commit by its message — every tag comes from what the
commit physically did (files touched, lines ±, files created/deleted).
A terse message only means that one memory's searchable text is
low-signal; the diff-shape tags, co-change and churn are unaffected.
See [No conventions](#no-conventions--only-structure).

**How is it different from other memory plugins / approaches?**
By default it is deterministic: BM25 over a hand-built index — no
embeddings, no model, no API spend, fully reproducible and
inspectable. (An opt-in semantic-search mode adds an embedding model
for cross-lingual recall — off unless you enable it.) See [How it
compares](#how-it-compares).

**What token reduction can I actually expect?**
When a recall covers the task, 80–89 % measured on real repos with
history. That is a *ceiling*, not a promise — it assumes the recall is
relevant. It is lower on terse-history repos, mature/stable repos,
dynamic-dispatch code, and tiny repos. The `dry-run.mjs` script gives
your repo a GOOD / MODERATE / LOW verdict before you rely on it. See
[What token reduction to expect](#what-token-reduction-to-expect).

**What does it cost to run?**
The core plugin is ~77 KB with one small dependency, and a large store
costs a few hundred MB of RAM. The optional code map adds ~16 MB of
vendored grammar files. No GPU, no API key, no network. See
[Performance](#performance) and [Code map](#code-map).

**Is it production-ready?**
444 assertions across fifteen suites, ~90 % line coverage, verified
against the documented plugin contract and dry-run against real repos
in ten languages. The one honest gap: it has not yet been run
end-to-end inside a live OpenCode *server* — see [Verifying it inside
a live OpenCode session](#verifying-it-inside-a-live-opencode-session).

## How the memory is structured

Every memory is **one flat record** — there is no per-category schema,
no nesting, no object graph. The shape, end to end:

```
  one memory  —  the only record shape; every category uses it
  ─────────────────────────────────────────────────────────────────
   id          mem_mp45o0rc_c
   category    git-history        one of 9 fixed kinds      ┐ the two
   subject     src/context.go     what the fact is about    ┘ hierarchy
   content     "fix nil deref on flush"  + diff shape         levels
               verbatim text — scored by BM25, never parsed
   tags        [single-file, tiny-diff, net-addition]
               structural only — never derived from prose
   source      git:116c8060…      provenance
   pinned      false              true => never evicted
   use_count   3    used_at …      least-used pair ages out first
   size_bytes  412                counts against the disk budget
   created_at  2026-05-01T…
```

That uniformity is deliberate: one storage table, one inverted index,
one eviction rule, regardless of where a memory came from.

### The hierarchy is two filter levels

"Hierarchical" here means exactly two levels of address — nothing more
elaborate:

- **`category`** — a fixed, closed set of nine kinds. It says *what
  type of fact* this is.
- **`subject`** — free-form. Usually a file path; sometimes a task
  slug or a synthetic key like `<tree>` or `go.mod↔go.sum`. It says
  *what the fact is about*.

```
  the store
  │
  ├─ git-history ······ commit / co-change / churn / recency memories
  │   ├─ subject "src/context.go"       a commit that touched it
  │   ├─ subject "src/writer.go"
  │   ├─ subject "go.mod↔go.sum"        a co-change pair
  │   └─ subject "context.go (churn)"   a stability signal
  │
  ├─ project-facts ···· manifests, tree census, README headline
  │   ├─ subject "package.json"
  │   └─ subject "<tree>"
  │
  ├─ code-map ········· one signature digest per source file  (opt-in)
  ├─ code-health ······ one LSP error/warning summary per file (live)
  ├─ session-snapshot · one per session — mental model, decisions
  ├─ session-trace ···· task + tool-trace summaries of past sessions
  ├─ agent-note ······· facts the agent chose to remember
  ├─ skill-mined ······ subject clusters promoted to SKILL.md
  └─ custom ··········· anything stored with memory_remember
```

Retrieval can filter by `category`, by `subject`, or by both *before*
BM25 scoring runs — so "the git history of `context.go`" or "every
code-map entry" is a free narrowing, not a post-filter over a full
scan. That pre-score filter is the entire payoff of the hierarchy: it
makes a scoped recall as cheap as an unscoped one.

There is no third level and no cross-links between memories *as data*.
The one relationship the plugin uses — which files change together —
is itself stored as ordinary `git-history` memories (subject
`fileA↔fileB`) and consulted at query time as the co-change boost; it
is not a separate graph structure in the store.

## How it compares

The plugin is one specific point in the design space. What it trades,
against the common alternatives:

**vs. an embedding / vector memory.** The deliberate difference is
that the *default* uses *no model*. Retrieval is BM25 over a
hand-built inverted index — deterministic, reproducible, debuggable,
no GPU, no API spend. (Semantic search bridges to the embedding world
as an opt-in when you need cross-lingual recall — see *Semantic
search* — but it is off by default.) The cost of that choice
is real: BM25 matches *tokens*, so a query has to share words (or CJK
bigrams) with the memory — it will not catch a pure paraphrase the way
a vector search can. Three things blunt that: identifier-aware
tokenisation (so `getUserName` also matches `user` and `name`), the
co-change boost (structurally-related memories surface with no textual
match), and the fact that code search is mostly keyword search anyway.
If you specifically need semantic similarity over prose, an embedding
store is the better tool; for a fast, free, inspectable memory of a
codebase, this is.

**vs. aider's repo-map.** aider uses tree-sitter too, but the design
is different at every level.

*How it works (from the source).* The expensive step — tree-sitter
parsing and tag extraction — is cached persistently on disk
(`.aider.tags.cache.v{N}`, using `diskcache`) across sessions. What
is recomputed on each message turn is the *ranking*: a full PageRank
run (via NetworkX) on a symbol-reference dependency graph, where each
source file is a node and edges are weighted by how often one file
references symbols defined in another. The ranking is *personalised*
to the current turn — files in the active chat get a ×50 multiplier
on their outgoing edges; symbols mentioned in the current message get
×10; long compound identifiers (camelCase / snake_case, ≥ 8 chars)
×10; private `_`-prefixed symbols ×0.1. An in-session in-memory cache
short-circuits the PageRank when the inputs are unchanged. The ranked
tags are then fitted into the token budget by binary search.

*The budget is dynamic.* The default token cap is 1 024 (`--map-tokens`),
but when no files are in the chat the budget multiplies by
`map_mul_no_files=8` — up to ~8 192 tokens — so an empty chat gets a
much wider view of the whole repo.

*Where diane lands.* diane's default co-change boost is deliberately
one hop — direct neighbours only — which is cheaper and trivially
inspectable, but narrower than aider's whole-graph PageRank. The
`personalizedPageRank` option closes that gap: turned on, diane runs
its own Personalized PageRank (a restart-biased random walk seeded on
the query's textual hits) over the co-change graph, so relevance
reaches multi-hop files graded by graph distance. It is off by
default — the random walk is a per-recall iterative computation (a few
ms on a large graph) and less trivially traceable than one hop, so the
cheap, fully-inspectable path stays the default and PPR is there for
those who want the wider reach. The graph differs from aider's in
kind: aider's edges are *symbol references* (who calls whom), diane's
are *co-change* (what changes together in Git history) — structural
coupling rather than static call structure.

*Output format: source lines, not stripped signatures.* aider's output
(via `TreeContext` with "lines of interest") shows the actual source
lines of the referenced symbols — class attributes, multi-line
signatures, brief context — not just a single signature string per
definition. Richer context per symbol, but more tokens per symbol;
diane's code map is more compact, covering more files at a lower
per-file token cost.

*How diane's code map differs.* It does not track symbol references or
run a graph algorithm. Every file gets one flat signature digest; BM25
recall selects the most query-relevant digests at call time. The map
is available immediately (persisted from prefill) and the token cost
is predictable at every call. It is also only one of nine memory
categories — git history, past sessions, mined skills and snapshots
sit alongside it. The benchmark repo (`opencode-diane-benchmarks`)
compares the two maps directly on real repositories.

**vs. AGENTS.md / static context files.** Those are loaded into the
prompt *every turn* — a fixed, recurring token cost the model pays
whether or not it needs them. This plugin is *pull*, not push: a
memory costs tokens only on the turn it is recalled. The two are
complementary — AGENTS.md for guidance the model should always see,
diane for facts it needs only sometimes.

**vs. no memory at all.** Without a memory the agent re-runs the same
`git log`, `ls -R`, `grep` and file reads every session. That raw
discovery is the baseline the token-savings numbers below are measured
against.

## The pillars

**1. Hierarchical store.** Top-level `category` (`git-history`,
`project-facts`, `code-health`, `code-map`, `session-trace`,
`session-snapshot`, `agent-note`, `skill-mined`, `custom`) + free-form
`subject` (file path, task slug). Retrieval filters by both before
scoring, so narrowing is free.

**2. BM25 retrieval, co-change-boosted.** Pure-JS tokenizer with
camelCase / snake_case splitting for Latin text and **overlapping
bigrams for CJK** (Chinese, Japanese, Korean) — CJK has no word
delimiters, so an ASCII splitter would drop it entirely; bigrams give
BM25 units to match on, the same dependency-free approach Lucene's CJK
analyzer and SQLite FTS5 use (see *Multilingual retrieval*). Inverted
index, `k1=1.2 b=0.75`, plus a small log-of-useCount tiebreak. On top
of textual scoring, a one-hop **co-change boost**: a hit about file X
pulls in memories about files X is historically modified with —
structurally-related context a pure text match would miss. (With
`personalizedPageRank` on, that one hop becomes a full
restart-biased random walk over the co-change graph, reaching
multi-hop files — opt-in; see *How it compares*.) Recall
output is **token-budgeted**: ranked hits are packed to a ceiling
(default 1200) so a
call's context cost is predictable; an oversized sole hit is
content-truncated rather than allowed to blow the budget.

The retrieval path, end to end:

```
  memory_recall("nil deref on flush", category?, subject?, prefer?)
        │
        ▼  tokenize     camelCase / snake_case split · CJK -> bigrams ·
        │               stopwords dropped · sub-2-char tokens dropped
   [nil, deref, flush]
        │
        ▼  filter       category / subject narrow the candidate set
        │               BEFORE scoring — a scoped recall is free
        │
        ▼  BM25         k1=1.2  b=0.75   +  log1p(use_count)*0.05 tiebreak
        │
        ▼  co-change    a hit on context.go pulls in writer.go if history
        │   boost       shows them changing together (a direct text
        │               match still outranks a co-change-surfaced one)
        │
        ▼  prefer lean  optional: gently up/down-rank code vs tests vs
        │               history to match the query's intent
        │
        ▼  token-budget ranked hits packed to <= tokenBudget (default
        │   pack        1200); the remainder returned as an omitted
        │               count; an oversized sole hit is truncated
        ▼
   bounded, predictable result
```

**3. Structural pre-fill.** Walks the last 500 commits via
`git log --numstat --summary`; every non-merge commit becomes a memory
tagged purely by diff shape. Adds co-change, churn and recency
memories. Separately, censuses the file tree and summarises recognised
project files by format. Works identically on a Go, Rust, Python,
Elixir, or polyglot repo.

What prefill does, on every startup:

```
  OpenCode starts
        │
        ▼  activate?  — git repo OR a recognised manifest present?
        │              if neither: log one idle line, register no tools
        │
        ▼  prefill  (background — the agent can query partial results at once)
        │
        ├── git log --numstat --summary -> per-commit · co-change · churn · recency
        ├── walk the file tree ----------> extension census · layout · manifest digests
        ├── tree-sitter parse  (opt-in) -> per-file signature digests   (code-map)
        ├── past OpenCode sessions ------> task + tool-trace summaries
        └── most recent session-snapshot > resume point logged
        │
        ▼  store ready — every later session starts warm
```

**4. Live code-health.** Subscribes to OpenCode's
`lsp.client.diagnostics` event and keeps one `code-health` memory per
file reflecting its *current* error/warning count — re-reports
replace, not accumulate. Convention-free, language-agnostic, no new
dependency.

**5. Code map (opt-in).** With `enableCodeMap`, tree-sitter parses
each source file and stores the *signatures* of its definitions
(bodies stripped) — an Aider-style repo map, reachable via
`memory_code_map`. This is the one heavyweight, language-aware
feature; see *Code map* below.

**6. Session snapshots.** `memory_snapshot` records a session's
*understanding* — mental model, decisions, learned conventions — as a
pinned `session-snapshot` memory. Each tags the previous session's as
`parent`, so the set is a branchable history with no DAG structure
beyond the tags; a later or parallel session resumes from the latest.
See *Session snapshots* below.

**7. LFU disk budget.** Configurable byte cap (default 50 MB — see
*Configuration* and the *heap* note under *Performance*). After every
mutation, evict ascending by `(useCount, usedAt)` until under. Pinned
entries (including snapshots) are never evicted.

**8. Skill mining.** Clusters memories by `subject`. Clusters with
≥ 3 entries become `<root>/.opencode/skills/<slug>/SKILL.md`. Runs
in the background; the tool returns immediately. The mined skills are
usable in the same session through the `memory_skill` tool — no
restart — and OpenCode also loads them as native skills next start.

## The nine tools

| Tool | Purpose |
|---|---|
| `memory_recall(query, category?, subject?, prefer?, limit?, tokenBudget?)` | Search the store — co-change-boosted, token-budgeted. `prefer` ('code'/'tests'/'history') leans ranking to match query intent. The recall-first entry point. |
| `memory_code_map(query?, tokenBudget?)` | Aider-style file-signature map, ranked + budgeted. Needs `enableCodeMap`. |
| `memory_remember(subject, content, tags?)` | Save a fact for future turns. |
| `memory_snapshot(summary, decisions?, conventions?)` | Record this session's understanding for a later/parallel session to resume from. |
| `memory_outline()` | Counts per category — cheap orientation. |
| `memory_status()` | Size, byte usage vs budget, last-ingest timestamps. |
| `memory_ingest_sessions()` | Pull task + tool-trace summaries from past OpenCode sessions. |
| `memory_mine_skills(reason?)` | Cluster memories into SKILL.md files. Background. |
| `memory_skill(name?)` | List the mined skill files, or load one into the conversation — so a skill mined this session is usable now, no restart. |

Tool descriptions are deliberately **directive** — they tell the
agent to recall *before* raw discovery and frame the token-cost
argument, since the description is the only prompt a plugin controls.
On top of that, a `tool.execute.before/after` pair provides a gentle
**recall-first nudge**: if the agent makes a couple of raw discovery
calls without ever touching a memory tool, one reminder is appended to
a discovery result. It fires at most once per session, never on
`read` output (file contents stay pristine), and goes silent the
moment any memory tool is used.

## Activation

Activates on any directory that is a git repository **or** contains at
least one recognised project/build file (a flat list of filenames
across ecosystems — no language logic). Otherwise it logs one idle
line and registers no tools. `forceActive: true` overrides.

## Without git history

Git is the largest single source: per-commit memories plus co-change,
churn and recency — and co-change is the entire backing for the
retrieval boost and the closest thing the plugin has to a graph.
Without git, none of that exists.

What remains git-independent:

- **Project facts** — manifests, build/CI files, tree census, README
  headline. Real, but a modest slice: orientation, not history-derived
  intelligence.
- **Code map** (`enableCodeMap`) — tree-sitter parses the file tree
  directly and never touches git. On a non-git repo this is the main
  source of actual codebase intelligence.
- **Code health** — LSP diagnostics, event-driven.
- **Session snapshots, agent notes, session ingestion, skill mining** —
  all agent- and session-driven; they accumulate across sessions
  regardless of git.
- The retrieval machinery itself — BM25, the inverted index, token
  budgeting, the recall-first nudge — is entirely git-independent. It
  simply has less to retrieve at first.

So the honest picture: **weak on a fresh non-git repo on day one**
(project facts alone is thin — and `measure-savings.mjs` will report
"inconclusive" there for exactly that reason), but **not useless over
time**, because snapshots, notes and traces build a store that recall
still operates on. `detectWorkableRepo` accepts a recognised manifest
*or* git, so a non-git Node/Rust/Python project still activates and
ingests project facts — only a directory with neither git nor a
manifest sits idle (and needs `forceActive`).

Recommendation: if you work without git, enable `enableCodeMap` and
use `memory_snapshot` / `memory_remember` deliberately — on a non-git
repo the store is only as good as what you and past sessions put in.
If the repo could be under git, `git init` unlocks more than half the
plugin's value and is the cheapest fix.

## Configuration

Defaults work without any config. To override, list the plugin as a
`[name, options]` tuple in `opencode.json`; OpenCode passes the
options straight through, and they're coerced defensively (bad keys
ignored, defaults applied).

```ts
interface UserConfig {
  maxMemoryDiskMB?: number       // default 50
  autoIngestOnStartup?: boolean  // default true
  gitHistoryDepth?: number       // default 500
  forceActive?: boolean          // default false
  skillsOutputDir?: string       // default ".opencode/skills"
  skillMiningMinCluster?: number // default 3
  ingestSessions?: boolean       // default true
  enableCodeMap?: boolean        // default false — see Code map
  enableNudgeHook?: boolean      // default true  — see Compatibility
  adaptive?: boolean             // default true  — see Adaptive sizing
  enableSemanticSearch?: boolean // default false — see Semantic search
  embeddingModel?: string        // default "Xenova/multilingual-e5-small"
  personalizedPageRank?: boolean // default false — see "How it compares"
}
```

## Coexisting plugins

Diane is designed to run alongside other OpenCode plugins without
either side losing functionality. The two compatibility decisions
that can't be avoided are made automatically at startup, by reading
the `plugin` array in `opencode.json` (project-local first, then
`~/.config/opencode/opencode.json`) and matching against known peer
names.

### What gets adjusted, and why

**The `tool.execute.after` nudge hook (default ON).** When a memory
tool has gone unused after several discovery calls, Diane appends one
short reminder to the discovery tool's output. `oh-my-opencode` also
post-processes tool output (its `look_at` flow replaces grep/glob),
and two plugins both mutating `output.output` interleave
unpredictably — so when oh-my-opencode is listed in `opencode.json`
the nudge is turned off. `caveman` doesn't touch tool output (it
hooks `session.created` and `tui.prompt.append`), so the nudge stays
on alongside caveman.

**Mined-skill subdirectory prefix (default empty).**
`memory_mine_skills` writes to `.opencode/skills/<slug>/SKILL.md` —
the same directory OpenCode discovers skills from. `caveman` writes
fixed slugs into the same place (`caveman`, `caveman-commit`,
`caveman-review`, `caveman-help`, `caveman-compress`), and
`oh-my-opencode`'s skill system also lives there. When either is
detected, Diane prefixes its subdirs with `diane-` so collisions are
impossible AND `memory_skill` surfaces only Diane's slugs (the
peer's slugs are theirs to list, not ours). Standalone, no prefix is
applied — paths are byte-for-byte the documented default.

### The matrix

| Detected peer | nudge hook | mined-skill subdirs |
|---|---|---|
| none | on (default) | `<slug>/` |
| `oh-my-opencode` / `oh-my-openagent` / `oh-my-opencode-slim` | **off** | **`diane-<slug>/`** |
| `caveman` / `caveman-opencode` / `caveman-opencode-plugin` / `opencode-caveman` | on | **`diane-<slug>/`** |
| both | **off** | **`diane-<slug>/`** |

### Override

An explicit `enableNudgeHook` or `skillsOutputDir` in your `"diane"`
config beats the auto-detect — useful when you have a specific reason
to want the nudge on alongside oh-my-opencode, or to point mining at
a non-standard directory and accept your own collision policy. The
adjustments are also visible at runtime:

- The OpenCode log line at startup names the peers found and the
  adjustments made (or "no compatibility adjustments needed" when
  none were).
- The `plugin.active` event in the JSONL log carries
  `peers: { ohMyOpencode, caveman, found: [...] }` plus the
  resolved `enableNudgeHook` and `minedSkillPrefix`, so a support
  thread can confirm what actually ran.

### What's not detected

Detection is **list-based, not behavioural**. A plugin that does the
same things oh-my-opencode does but isn't named anything we recognise
will get no special treatment from us. If you hit a clash with such a
plugin, set `enableNudgeHook: false` (and/or `skillsOutputDir`) in
your config and file an issue with the peer's name so we can add it
to the detection list.

## Adaptive sizing

The fixed defaults (gitHistoryDepth 500, a 4000-file code-map cap) are
a sensible middle — wasteful on a 50-commit toy, thin on a 100k-commit
monorepo. With `adaptive` on (the default), prefill closes that gap
from **one measured signal**: `git rev-list --count HEAD`, or a
bounded file count when there's no git. That signal sorts the repo
into one of three named tiers, and a lookup table picks the knobs:

| knob | small | medium | large |
|---|---|---|---|
| `gitHistoryDepth` | 250 | 500 | 1500 |
| code-map file cap | 1500 | 4000 | 10000 |
| co-change pass | on | on | skipped above 5000 commits |

**The disk budget is deliberately not in that table.** It used to be
(small/medium 5 MB, large 20 MB) — back when the default was a tight
5 MB that genuinely needed widening for big repos. The default is now
a generous 50 MB (see *Configuration*), which clears even a
depth-capped large repo's store (~6–8 MB) several times over, so there
is nothing left for adaptation to do: every tier carries the same
50 MB budget. To use more or less, set `maxMemoryDiskMB` explicitly.

**Co-change is the one pass that gets cut** on huge histories: its
pair-counting is O(commits × files²), the only super-linear step in
the plugin, so above the threshold it's skipped (commit/churn/recency
still run).

One input, three tiers, a table — not a pile of heuristics — so the
behaviour stays inspectable: the chosen tier and every knob it moved
are logged each run (`prefill: repo tier=large (9000 commits) — …`).
Adaptation only fills knobs the user did **not** set explicitly; an
explicit config value always wins, including `maxMemoryDiskMB` set
below the 50 MB default. `adaptive: false` pins everything to the
fixed defaults.

When there's no git, the file count is the signal instead — same
mechanism, different sensor — so adaptive sizing still works on a
non-git repo.

## Code map

`enableCodeMap` turns on tree-sitter parsing of every source file
into its per-file structural shape. It is **off by default** and is
the one deliberate exception to the plugin's lightweight design:

- Covers **thirteen languages**. Ten are extracted as definition
  signatures (JavaScript, TypeScript, Python, Go, Rust, Java, C, C++,
  C#, PHP); the other three get their own extractors since they have no
  "definitions" — CSS → selectors and at-rules, JSON → top-level keys,
  HTML → `id`-bearing and landmark elements.
- It adds `web-tree-sitter` (~300 KB) plus vendored grammar `.wasm`
  (~16 MB total). Three grammars are most of that weight: C# (5.2 MB),
  C++ (4.5 MB) and TypeScript (2.3 MB). With it on, the package is
  ~16.5 MB rather than ~77 KB. Grammars load lazily — only for
  languages actually present in the repo — but all `.wasm` ships in the
  package; dropping a grammar you don't need is a small edit in
  `code-map.ts` plus deleting one file.
- It is the only language-*aware* component: one small table maps
  each grammar's node types to the kinds worth extracting. Files in a
  language with no grammar are skipped; if `web-tree-sitter` fails to
  load, code map degrades gracefully and the rest of the plugin is
  unaffected.
- Measured: on a real 81-file Go repo the map cost ~45 tokens/file,
  and a `memory_recall` + `memory_code_map` pair answered a "work on
  feature X" scenario in ~700 tokens versus ~5,400 tokens of raw
  discovery — an ~87 % reduction. Worth it or not is a per-setup
  judgement; hence opt-in.

## Session snapshots

The other categories hold *facts*; `session-snapshot` holds
*understanding* — a session's mental model, the decisions it made and
why, the conventions it learned that the code doesn't show. The agent
writes one with `memory_snapshot`; it is **pinned** (eviction-proof),
**one per session** (re-snapshotting replaces in place), and tags the
most recent other session's snapshot as `parent:<id>`.

Those `parent` tags are the entire mechanism — the snapshot set is a
branchable history with no DAG data structure, just edges in the tag
list. A later session resumes from the latest snapshot (prefill logs
the resume point); a parallel session reads the same shared store and
forks from the same point; a snapshot tagging an older parent is a
branch. It's the harness-side, no-model take on versioned agent
memory — continuity without embeddings or LLM summarisation.

## Performance

All hot paths are O(1) or O(n), never O(n²). The in-memory working set
is a `Map<id, Memory>`, so insert, lookup and delete are O(1) —
`removeMemory` and `applyEviction` (which run on the per-event
`upsertBySubject` path and after every write) were O(n) array
operations before the Map. `insertIfMissing` uses a composite-key
`Map` for O(1) idempotency; `totalBytes` is a running counter;
`countsByCategory` reads the index directly; eviction sorts once per
*batch*, not per insert.

Persistence is a SQLite database (`bun:sqlite`) written behind a
debounced, failure-tolerant write-behind buffer: mutations record a
changed/deleted id, and the flush drains the buffer into one
transaction — a delta of only the changed rows, not a re-serialise of
the whole store the way the old JSON file did. The database is read
exactly once, at load; recall runs entirely against the in-memory
index and never touches it. At small scale this is not a speed win
over the JSON file — a ~1 MB store is cheap to rewrite wholesale, and
SQLite's per-transaction overhead is comparable. The win is at scale
and in the steady-state access pattern: on a 15,000-entry store,
touching a handful of memories and flushing costs ~4 ms (a delta of
the changed rows) versus ~40 ms for a JSON-style whole-file rewrite,
and that gap widens as the store grows — the incremental flush is
constant in the number of *changed* rows, the rewrite is linear in
the *whole* store. WAL mode also makes writes crash-safe and lets
parallel sessions share a repo. The migration is justified by that
scaling behaviour and crash-safety, not by small-store microbenchmarks.

### Scaling — measured

`scripts/stress-scale.mjs` builds stores of increasing size with
realistic content (a wide vocabulary, co-change tags) and measures
every cost that grows with size. Eviction is disabled so the table is
the raw curve. Representative numbers on a dev machine:

| memories | store on disk | insert | full flush | reload | recall ×100 | incr. flush | heap |
|--:|--:|--:|--:|--:|--:|--:|--:|
| 5 000 | 1.2 MB | 0.3 s | 18 ms | 0.2 s | 23 ms | 13 ms | ~100 MB |
| 15 000 | 3.6 MB | 0.8 s | 77 ms | 0.7 s | 51 ms | 18 ms | ~275 MB |
| 25 000 | 6.0 MB | 1.3 s | 126 ms | 1.2 s | 77 ms | 50 ms | ~440 MB |

Every cost scales **linearly** — there is no quadratic term. Recall
stays ~1–3 ms per query throughout (BM25 over the in-memory index;
latency tracks how many memories match the query terms, not the store
size). Incremental flush stays a small near-flat delta — that's the
SQLite write-behind win. `tests/scaling.test.ts` is a gated guard at
4 000 memories that would fail loudly if any of these went
super-linear.

The honest caveat is **heap**. The plugin holds the entire working
set in memory — the `byId` map, the inverted index (a term-frequency
map per memory, needed for BM25), and the co-change graph. That's
roughly 17 KB of heap per memory, ~70× the on-disk size. At a
realistic large store (~25k memories → ~440 MB) that's a chunky but
manageable footprint on a modern dev machine.

**The disk budget bounds RAM, not just disk.** Because heap tracks
memory count, and memory count tracks bytes stored, the byte budget is
effectively a RAM ceiling — about **70 MB of heap per 1 MB of
budget**, if the budget were ever filled. The default budget is 50 MB,
so the *theoretical* worst case is ~210k memories and ~3.5 GB of heap.

In practice a store never comes close. The git-history and code-map
ingesters are themselves depth-capped (≤ 1500 commits, ≤ 10 000
files), so a real store — even on a large repo — lands in the
**15–25k band: ~4–6 MB on disk, ~300–440 MB of heap**, far below the
50 MB budget. That is the point of the generous default: at 50 MB the
budget is a *safety valve* for a runaway monorepo, not a routine
clipper. The previous 5 MB default was small enough that a normal
large repo (~25k memories ≈ 6 MB) hit the ceiling and lost useful
memories to eviction every run; 50 MB ends that.

If you run on an unusually large monorepo and the heap footprint
matters, `maxMemoryDiskMB` is the single knob — set it **down** (e.g.
`10`, ~700 MB heap ceiling) to cap RAM hard, or **up** if you have the
memory and want a deeper store. The budget is the RAM dial.

The fuller answer for a store that genuinely outgrows RAM is to move
the search index itself onto disk. SQLite is already the durable store
here, and SQLite's FTS5 is a disk-resident full-text index with BM25
built in — so a future version could keep the inverted index in FTS5
rather than in the heap, holding only a small working set in memory and
letting the rest live on disk. That is a real architectural change (the
CJK bigram tokenisation would move to an FTS5 custom/trigram tokenizer,
and ranking would shift from the in-process scorer to FTS5's), so it is
deliberately scoped as separate future work rather than bolted on; for
now the byte budget plus depth-capped ingesters are what keep the
in-memory footprint bounded.

Confirmed on real large repositories: ingesting `redis` (1.8k files),
`rocksdb` (2.2k files) and `spring-framework` (11.4k files) produced
1.9k / 2.4k / 4.7k memories with a one-time background prefill of
~9 / ~17 / ~11 seconds. On `spring-framework` the code-map count
stopped at exactly 4 000 — the file cap doing its job, which is why an
11k-file repo prefilled no slower than a 2k-file one. The first session
gets partial recall until that prefill finishes; every session after is
warm.

## Rich logs

In addition to the human-readable lines that go to OpenCode's session
log (via `client.app.log`), the plugin writes a structured JSON-Lines
log to `os.tmpdir()/opencode-diane/` — typically
`/tmp/opencode-diane/` on Linux,
`/var/folders/.../T/opencode-diane/` on macOS. One file per process,
named `diane-<iso-timestamp>-pid<pid>.jsonl`, so parallel OpenCode
sessions never interleave.

**Inside Docker:** the default `os.tmpdir()` path is ephemeral
container storage — fine for ad-hoc runs but lost when the container
exits. Set `OPENCODE_DIANE_LOG_DIR` to a mounted path and the logs
flow to the host:

```bash
docker run \
  -e OPENCODE_DIANE_LOG_DIR=/logs \
  -v $PWD/logs:/logs \
  …
# then from outside the container:
python3 analyze-logs.py --dir ./logs --plain
```

The env var is the write-side override; `analyze-logs.py --dir` is
the read-side counterpart, so the two halves of the diagnostic loop
work together regardless of where the logs are.

Two record shapes share the file: prose `log()` lines and structured
`event()` records. Every record carries `ts` (ISO ms-precision),
`service`, and `root`. Prose lines add `level` (`debug`/`info`/`warn`/
`error`) and `message` (mirroring exactly what OpenCode's session log
shows). Events add `event` (a dotted name like `ingest.git`) and a
typed payload — counts, ms, ids. The header record is
`event: "session.start"` with the pid, Node version, platform, and
cwd, so opening the file in isolation always gives context.

The events fired today:

- `session.start` — header (pid, node, platform, cwd)
- `plugin.idle` — directory has no git history and no project files
- `plugin.active` — version, storeSize, bytesTotal, budgetBytes, feature flags
- `store.migration.failed` — the legacy `diane.json` → SQLite migration
  hit an error (the cause is in the `reason` field). The plugin does
  **not** crash on this: it starts with an empty database, leaves the
  JSON file in place, and the next startup retries. Observed in the
  field when running alongside heavyweight plugins (e.g. oh-my-opencode)
  whose own startup contends for resources during ours.
- `prefill.start` / `prefill.complete` / `prefill.failed` (with ms)
- `adaptive.tuned` — the size signal and the chosen knobs
- `ingest.project`, `ingest.git`, `ingest.sessions`, `ingest.code-map`
  / `ingest.code-map.skipped` — each ingester's raw counts
- `snapshot.resume` — id and total count when resuming
- `eviction` — removed count, bytes after, trigger
- `tool.call` — one record per tool invocation, with `tool`, `ms`,
  `ok`, `args` (truncated to ~500 chars per string field) and either
  `result` (a per-tool summary like `{hits, omitted}` or `{id,
  sizeBytes, bytesTotal}`) or `error` on failure
- `mining.complete` / `mining.failed` — the background outcome of
  `memory_mine_skills` (the tool returns immediately; these fire when
  the background job finishes)

Because every line is independently valid JSON, the file is greppable
*and* `jq`-able. Common queries:

```bash
# Tail the latest session
tail -f "$(ls -t /tmp/diane/*.jsonl | head -1)"

# Just the structured events from a specific run, in time order
jq -c 'select(.event)' /tmp/diane/diane-2026-05-15T*.jsonl

# Every tool call across all sessions, with timing
jq -c 'select(.event == "tool.call") | {tool, ms, ok}' /tmp/diane/*.jsonl

# Slow tool calls (> 100ms)
jq -c 'select(.event == "tool.call" and .ms > 100)' /tmp/diane/*.jsonl

# Find slow prefills (> 1 s)
jq -c 'select(.event == "prefill.complete" and .ms > 1000)' /tmp/diane/*.jsonl
```

### `analyze-logs.py`

A standalone Python script at the repo root that turns one or more
JSONL files into a report. Standalone means: stdlib only, no plugin
imports — you can copy the script to a machine that doesn't have the
plugin installed and analyse logs that came from one that does.

**Every report leads with a plain-language "What happened" summary.**
The raw log is a stream of dotted event names and typed payloads —
`prefill.complete`, `ingest.git scanned=1500`, `eviction removed=12` —
which is precise but assumes you know what each one means. The
analyzer's first job is to translate that into a numbered, jargon-free
account of what the plugin did and *why* it mattered, written for
someone who has never read the plugin's source. For example, instead
of `ingest.git scanned=1500 commitMemories=80` it writes: "it read
1,500 commits of Git history and turned them into 80 compact notes
about which files change together … this is what lets the AI answer
'what changed recently?' from memory instead of searching your files."
The technical sections (per-tool latency tables, the event timeline,
raw ingest counts) follow underneath for anyone who wants them.

`--plain` prints only that plain-language summary — the view for a
non-specialist or a quick "what did it just do?" check. `--json`
includes the same explanation as a string array per session, so an LLM
or downstream tool gets it too. Useful for bug reports
(`./analyze-logs.py --json > report.json` and attach it), quick local
debugging (`--timeline` shows the full chronological flow), or feeding
to an LLM as context. Examples:

```bash
./analyze-logs.py                        # plain summary + technical detail
./analyze-logs.py --plain                # plain-language summary only
./analyze-logs.py --tail 3 --timeline    # 3 newest, with chronological flow
./analyze-logs.py --json                 # JSON (carries the explanation too)
./analyze-logs.py --root /path/to/repo   # filter to one repo
./analyze-logs.py --quiet                # one-line-per-session summary
```

The plain-language explainer is covered by `tests/test_analyze_logs.py`
(Python `unittest`, stdlib only, wired into CI): the tests assert that
each major step is explained with its real numbers and its reason, and
that the plain output contains none of the raw event/field identifiers
— a machine-checkable proxy for "a non-specialist can read this".

The script is intentionally NOT bundled into the published npm
package — it's a development/debugging aid, not part of the runtime
plugin. It lives in the repo so it's there when you clone, and that's
the only coupling.

Reliability: writes are synchronous (`openSync` + `writeSync`), so a
line that "wrote" is on disk before the call returns — including
right before a crash, which is when these logs are most useful. A
write failure (disk full, permission lost mid-session) drops the fd
silently; the plugin keeps running and OpenCode's own log channel is
unaffected. A logger error never propagates.

Retention is the user's responsibility: the plugin never deletes its
own log files. On Linux they're cleared at reboot or by
`systemd-tmpfiles`; on macOS the periodic tmp cleaner removes them
after a few days of inactivity. For a manual sweep:
`rm /tmp/diane/*.jsonl`.

## Tests & CI

444 assertions across fifteen suites (store, search, ingest, mining,
sessions, code-health, code-map, session-snapshot, adaptive, file-log,
token-savings, skill-activation, scaling, semantic, plugin). The ingest suite exercises a real git fixture
and a Rust project fixture; code-map parses a multi-language fixture
with the real grammars; the session-snapshot suite covers parent
linkage and pinned-survives-eviction; the plugin suite covers the
recall-first nudge hooks; the token-savings suite builds a fixture
repo with real history and asserts that recall is measurably cheaper
than raw discovery (see *Token savings*, below); the skill-activation
suite proves a skill mined mid-session is discoverable and loadable in
that same session, no restart; the scaling suite builds a 4 000-memory
store and guards correctness plus anti-quadratic timing ceilings (the
deep curve is `scripts/stress-scale.mjs` — see *Scaling*). Alongside
the Bun suites, `tests/test_analyze_logs.py` is a 12-test Python
(`unittest`, stdlib only) suite for the log analyzer's plain-language
explainer — it asserts the report stays legible to a non-specialist
(see *Rich logs*). CI runs typecheck →
lint (ESLint 9, type-aware) → build → tests → a smoke test of the
compiled `dist/` → a package-size guard → the Python analyzer tests,
all on the Bun runtime (with the preinstalled `python3` for the last
step), then a coverage job (`bun test --coverage`) enforces a
line/function coverage floor and uploads the lcov report. Coverage
sits around 90 % lines as Bun measures it. There is no Node version
matrix — OpenCode loads plugins under Bun, so Bun is what's tested.
The suites use a small self-contained assertion harness, so each runs
as a Bun script and self-gates on exit code.

A separate, informational workflow — `compare-aider` — is *not* part
of the merge gate. It's manually runnable (and runs monthly), installs
aider, and compares aider's tree-sitter repo-map to diane's
code map on a real repository, publishing the result to the run's job
summary. See *Token savings* below.

Verified unchanged against three real repositories — `rs/zerolog`
(Go), `BurntSushi/byteorder` (Rust), `petrovich/pytrovich` (Python) —
producing the same structural signals for each.

## Development & packaging

The plugin runs under Bun (the runtime OpenCode loads plugins in), so
the whole toolchain is Bun-based. `tsc` is still the build step — it
emits the `.d.ts` files the npm package ships — but it runs under Bun
like everything else.

```bash
bun install
bun run build          # tsc -p tsconfig.json — emits dist/ + .d.ts
bun run lint           # eslint src tests (type-aware; floating promises = error)
bun run test           # 444 assertions across fifteen suites
bun run smoke          # exercises the compiled dist/ as OpenCode would
bun run check:size     # fails if the package exceeds its size ceiling
bun run typecheck      # no emit
bun run coverage:check # bun test --coverage, fails under the coverage floor
bun run test:analyzer  # python tests for the log analyzer's plain-language report
bun run verify:semantic # optional: runs the real e5 model on a 9-language fixture set
```

CI (`.github/workflows/ci.yml`) runs typecheck → lint → build → test →
smoke → size-guard on Bun, then a separate coverage job. There is no
Node version matrix — OpenCode loads plugins under Bun, so Bun is what
is tested.

To publish a new version:

```bash
bun run test && bun run smoke && bun run check:size   # pre-flight: all must pass
bun run clean && bun run build                        # also the prepublishOnly script
npm version <patch|minor|major>                       # bump version + git tag
npm publish --access public                           # npm is the registry
```

**The version lives in exactly one place:** `package.json#version`.
`npm version <patch|minor|major>` edits that field (and creates a
matching git tag). At plugin startup `src/index.ts` reads it from
that same `package.json` and the value flows from there to the
`plugin.active` log event (so the running version is in every
session's JSONL log) and to the `memory_status` tool's output (so an
agent can ask which version is loaded). There is no second place to
update — change `package.json#version`, rebuild, and every consumer
picks up the new number.

`bun pm pack --dry-run` lists exactly what would be packed; the `files`
allowlist in `package.json` limits the tarball to `dist/`, `grammars/`,
`README.md`, `WIKI.md`, and `LICENSE`. `check:size` runs that
`--dry-run` under the hood and fails CI if the unpacked size crosses
its ceiling or a vendored grammar goes missing — so a size regression
cannot ship silently.

## Token savings

The plugin's premise is that a token-budgeted recall is cheaper than
the raw discovery an agent would otherwise do. That claim is measured
two ways, both with zero API spend.

### What token reduction to expect

The honest range, from measured runs:

- **When a recall covers the task: 80–89 %.** Real-repo measurements
  (`measure-savings.mjs`): ~87 % on `zerolog`, ~89 % on `click`,
  ~85 % on `express` — ~8–11k tokens of raw discovery collapsing to
  ~1.1–1.2k of recall.
- That figure is a **ceiling, not a promise.** It is "tokens saved
  *if the recall is relevant*" — it is not a relevance score. A recall
  can be cheap and still mediocre (see the `express` case under
  *Real-world usefulness*).
- **Lower** on: terse-history repos (low-signal commit text), mature/
  stable repos (recent history is dependency bumps), dynamic-dispatch
  codebases (the code map extracts *declared* signatures), and very
  small repos (raw discovery was already cheap — reported as
  "inconclusive", not a loss).
- The gated test floor is deliberately conservative: a fixture
  end-to-end orientation must be **> 25 %** cheaper, and recall output
  must stay within ~2× its own token budget — so the plugin's
  footprint can never turn a saving into a cost.

Before trusting it on your repo, run `scripts/dry-run.mjs <repo>`: it
prints a **GOOD / MODERATE / LOW** verdict on the git-history signal
and shows real query results with their token cost. That verdict is
the answer for *your* repo, which no general percentage can give.

### How it is measured

`scripts/measure-savings.mjs <repo>` runs a realistic *without-plugin*
discovery recipe (recent git history, a tree listing, reading the
files whose names match the task, a grep), sums the token cost, then
runs the *with-plugin* memory calls and sums those. Both sides print
what they ran. It's honest about coverage: thin recall results assume
the agent still does part of the fallback discovery rather than
claiming an unrealistic 100 %, and a non-git repo with an empty store
is reported "inconclusive", not a win. Sample runs land around 80 % on
real repos with history; on a tiny repo the saving is modest, because
the baseline was already cheap — that's correct, not a failure.

`tests/token-savings.test.ts` turns the same method into gated
assertions on a fixture repo with real history: a single file's
history via recall vs `git log -p` (~5× cheaper), project facts via
recall vs reading the config files, and a whole end-to-end
orientation (>25 % fewer tokens). One case guards the floor — it
verifies recall output stays within ~2× its token budget, so the
plugin's own footprint can't run away and turn a "saving" into a cost.

For the code map specifically, the repo can compare against aider.
`scripts/dump-code-map.mjs <repo>` prints diane's full code map
as text; `aider --show-repo-map` prints aider's repo-map;
`scripts/compare-aider.mjs <aider-map> <diane-map>` reports token cost
and approximate coverage for both, with one tokenizer applied to each.
The `compare-aider` workflow runs the whole thing in CI. The report is
careful about what it shows: the two artifacts are different shapes —
aider's repo-map embeds critical source lines and is trimmed to
`--map-tokens` (default 1k) per turn; diane's code map is one
signature digest per file, recalled as a query-ranked subset — so the
figures are a coverage/footprint comparison of the full maps, not a
head-to-head of per-request context cost.

### `bun test` vs `bun run test`

These look the same and are not. `bun run test` is the canonical gate:
it runs each suite as a script (`bun tests/<name>.test.ts`), uses the
custom assertion harness, and self-gates on exit code per suite. Its
output is the 343-pass/0-fail summary.

`bun test` (Bun's native test runner) discovers `*.test.ts` files in
parallel and looks for `bun:test` registrations. Our suites use a
custom harness, so Bun reports "0 tests" — that's correct, not a bug.
The only places that invoke `bun test` are `coverage:check` (it needs
Bun's `--coverage` instrumentation) and CI gating.

The most common confusion: `bun test` shows `1 fail / 1 error /
Cannot find module '@opencode-ai/plugin'`. That means your
`node_modules` is incomplete — usually a missing `bun install` on a
fresh checkout. The `coverage:check` preflight catches this case
explicitly and tells you to run `bun install`; if you see the error
from raw `bun test`, the answer is the same.

## Multilingual retrieval

Retrieval works for non-Latin scripts, with CJK as the driving case.
The tokenizer handles two scripts in one pass: Latin/digit runs are
split identifier-aware (camelCase, snake_case), and **CJK runs — Han,
Hiragana, Katakana, Hangul — are emitted as overlapping bigrams**
(`数据库连接` → `数据`,`据库`,`库连`,`连接`). A mixed string like
`fix 数据库连接 bug` tokenizes to both `fix`/`bug` and the Chinese
bigrams. Indexing and querying share the tokenizer, so the two sides
always agree.

This matters because CJK has no spaces between words: an ASCII
splitter treats every ideograph as a separator and **discards Chinese
text entirely** — Chinese commit messages would index to nothing and
Chinese queries would match nothing. Bigrams give BM25 overlapping
units to match on. A dry run on a real Chinese repository confirmed
`数据库索引` and `面试题` retrieve relevant Chinese commits where before
they returned nothing.

The honest tradeoff: bigrams are the *lightweight* approach — the same
one Lucene's CJK analyzer and SQLite FTS5 use — chosen because they're
deterministic and need no dictionary or model. They take CJK recall
from broken to working, but they're not as precise as true word
segmentation: a bigram can be shared by unrelated words (`编程` is in
both `并发编程` "concurrent programming" and `AI 编程` "AI programming"),
so partial-match false positives happen — the same class of imprecision
BM25 has for English. A statistical segmenter (jieba-style) would be
more precise, but its dictionary alone is several MB and would break
the package-size budget, so bigrams are the right point on that curve
for the *lexical* index — which is the always-on default. (Genuine
cross-lingual recall is a different problem with its own opt-in
answer, *Semantic search*, below.)

One known refinement: the token-budget estimate is a flat ~4
chars/token heuristic, which slightly *under*-counts CJK (CJK is
denser per model token), so recall packs marginally more CJK content
than the budget intends. It's a small imprecision in packing, not a
correctness problem.

Note the scope of all the above: bigrams make retrieval work *within*
a language — a Chinese query finding Chinese text. They cannot do
*cross-lingual* recall — a Chinese or Russian query finding code
commented in English — because lexical search matches tokens, and
different scripts share none. That is a genuinely different problem,
and it has its own opt-in answer below.

## Semantic search

`enableSemanticSearch` (default **off**) adds opt-in **cross-lingual**
retrieval: a query in one language finding code and comments written
in another — e.g. a Russian or Chinese query surfacing an
English-commented function. Lexical BM25 structurally cannot do this
(a Russian query and English content share zero tokens); it needs an
embedding model that places the languages in one shared vector space.

**How it works.** With the flag on, the plugin loads a small
multilingual embedding model — `intfloat/e5` via the optional
`@huggingface/transformers` dependency, default
`Xenova/multilingual-e5-small` (~120 MB, ~384-dim, 100+ languages,
downloaded and cached on first use). A background pass after prefill
embeds every memory and stores the vectors in a **separate**
`.opencode/diane-vectors.db`; the pass is incremental and crash-safe,
so each memory is embedded once and reused across sessions. On a
recall, the query is embedded and the two rankings — BM25 lexical and
vector similarity — are merged with reciprocal-rank fusion (RRF), the
standard position-only blend that needs no score calibration. The
recall path itself stays synchronous: only the query embedding is
async, done in the tool handler before the sync ranking.

**Off by default, and off means off.** When `enableSemanticSearch` is
false: no model is downloaded, `@huggingface/transformers` is never
imported (it is an *optional* peer dependency — a normal install never
pulls it in), no vector database is created, and `recallDetailed`
takes the byte-for-byte unchanged lexical path. The plugin's full
existing test suite runs with the feature off and is the regression
proof that the default path is untouched.

**Enabling it.**

```sh
bun add @huggingface/transformers      # the optional dependency
```

```jsonc
// opencode.json
["opencode-diane", { "enableSemanticSearch": true }]
```

If the flag is on but the dependency is missing or the model can't be
fetched, the plugin logs a warning and falls back to lexical search —
enabling the flag never breaks recall.

**Cost, honestly.** The model is a real dependency: a one-time ~120 MB
download, a few hundred MB of process RAM while loaded, and a
background embedding pass that takes a few minutes on a large store
the first time (incremental and cached thereafter). Each recall adds
one query embedding (~tens of ms on CPU) plus a brute-force cosine
scan (sub-millisecond at realistic store sizes). And it trades away
the plugin's signature property: BM25 is inspectable — you can see
*why* a hit matched — whereas an embedding match is a black box. That
is the deliberate tradeoff for crossing languages, which is why it is
opt-in rather than default.

**What is tested, and how.** diane's *pipeline* — the vector store,
RRF fusion, the recall gating, graceful degradation, and end-to-end
RU/EN/ZH cross-lingual retrieval — is covered in CI (`semantic.test.ts`)
by a deterministic stub embedder with a built-in trilingual concept
lexicon. The stub is used on purpose: the cross-lingual *quality* is a
property of Microsoft's e5 model, benchmarked by its authors, and CI
should not re-prove it by downloading 120 MB on every run. The real
model is verified separately by `scripts/verify-semantic.mjs` (run it
once where the Hugging Face Hub is reachable: `bun run verify:semantic`).
That script covers **nine languages on a two-tier scheme**: a *core*
tier of well-represented languages (English, Chinese, Russian,
Japanese, Spanish, Turkish) whose cross-lingual matches gate the exit
code, plus an *experimental* tier of low-resource Cyrillic languages
(Mongolian, Tajik, Kyrgyz) whose results are reported but do not fail
the script — an honest empirical view of how the model handles
languages it was trained on with very uneven amounts of data, rather
than a pretence that it handles all of them equally.

## Real-world usefulness — when it helps, when it doesn't

The plugin was dry-run against real repositories — `rs/zerolog` (Go),
`pallets/click` (Python), `expressjs/express` (JavaScript),
`BurntSushi/byteorder` (Rust), `Snailclimb/JavaGuide` (Chinese),
`redis/redis` (C), `facebook/rocksdb` (C++) and
`spring-projects/spring-framework` (Java, 11k files) — using
`scripts/dry-run.mjs` (ingests a checkout and shows the actual memories
and the results of realistic developer queries) and
`scripts/measure-savings.mjs` (models the token cost of raw discovery
versus a recall). The honest findings:

**Measured token savings.** When recall covers a task, the saving is
large: ~87 % on `zerolog`, ~89 % on `click`, ~85 % on `express` — raw
discovery of ~8–11k tokens collapsing to ~1.1–1.2k. But that number is
"tokens saved *if recall is relevant*". It is not a relevance score —
see the express case below, where the token count looks great while the
hits are mediocre. Treat the percentage as a ceiling, not a promise.

**It helps most on** repos with descriptive commit messages and
*statically-declared* code structure (Go, Rust, typed Java/Python),
under active development so recent history is substantive. On `zerolog`,
"error handling" and "logging configuration" surfaced genuinely relevant
commits and the code map gave compact, accurate API digests.

**It helps least on**:
- *Terse-commit repos.* Commit messages are stored verbatim — the
  plugin derives nothing from message style — so a history of "fix",
  "wip", "update" yields low-signal memories. `dry-run.mjs` prints a
  GOOD / MODERATE / LOW verdict so you know before relying on it.
- *Repos mid-mechanical-refactor.* A burst of renames or a doc
  migration produces many keyword-matching but signal-free commits. The
  git ingester detects **balanced churn** — additions ≈ deletions, the
  convention-free fingerprint of moved/reformatted content — and gives
  it no per-commit memory, as merge commits get none. On `click`,
  mid-`.rst`→`.md` migration, this filtered ~5 % of commits; on
  `zerolog` only ~2.5 %.
- *Mature, stable repos.* On `express` (2000+ commits) recent history
  is dominated by dependency bumps, CI tweaks and test maintenance; the
  substantive architectural commits are old, possibly past the depth
  cap. Git-history memory is most valuable on actively-evolving code.
- *Dynamic-dispatch codebases.* The tree-sitter code map extracts
  *declared* signatures, so its quality tracks how statically a
  language declares its API. It is **strong on C, C++, Java, Go and
  Rust** — dry runs on `redis`, `rocksdb` and `spring-framework`
  produced accurate signatures (`static int checkStringLength(client
  *c…)`, C++ namespaces/templates/inheritance, Java classes/methods).
  It is **weak on idiomatic dynamic JavaScript**: `express` builds its
  real API (`app.get`, `req.body`…) through prototype mutation and
  higher-order functions, so the extractor finds little (`lib/request.js`
  → "1 definition").
- *Very small repos.* Little history → raw discovery was already cheap;
  `measure-savings.mjs` reports such cases as inconclusive, not a win.

**Keyword-on-filename bias.** Default retrieval is keyword BM25 (the
deliberate embedding-free default) and it scores file *paths* as well
as content, so a file *named* after a concept can outrank the real
implementation. This was the most consistent weakness across the dry
runs: on `express`,
"routing and middleware" surfaced `test/middleware.basic.js` and a
benchmark over `lib/router/`; on `rocksdb`, "write ahead log" surfaced
test and bench files; on `spring-framework`, "bean lifecycle" surfaced
JUnit fixture classes named `LifecycleBean.java`. The effect is
*amplified* in verbose-naming languages — Java's long descriptive class
names mean test and fixture classes match concept keywords strongly.

The mitigation is the `memory_recall` **`prefer`** option — a
query-dependent intent lean the calling agent sets from what the user
asked: `prefer:"code"` gently down-ranks test-pathed memories,
`prefer:"tests"` lifts them, `prefer:"history"` favours change history.
It is a mild score multiplier, deliberately **never a filter** — a
strongly-matching test still surfaces under `"code"`, just lower —
because sometimes the test really is what you want. On `spring`,
`prefer:"code"` lifted the real `InitDestroyAnnotationBeanPostProcessor`
above the JUnit fixtures for "bean lifecycle"; on `rocksdb` it separated
`db_write_test.cc` from the implementation. The test signal itself is
deliberately minimal and language-neutral — whether the word "test"
appears as a *token* of the path, which catches `test/` directories,
`_test.go` / `.test.ts` / `test_x.py` filenames alike without
enumerating any one ecosystem's convention. It is the agent — already
an LLM that understood the request in whatever natural language — that
decides the intent; the plugin hardcodes no query keywords. Run
`dry-run.mjs` on your own repo to see the lean in action.

### Verifying it inside a live OpenCode session

The suites and smoke test exercise the plugin against the documented
plugin contract with a mock host; they do **not** run it end-to-end
inside a live OpenCode server — that gap is real and is best closed by
running it. A quick manual check, in a real repo under OpenCode:

1. Start OpenCode; confirm the plugin loads (no error; `memory_status`
   responds and, after prefill, reports a non-zero memory count).
2. Ask the agent something the history knows ("what changed recently
   around <area>"); confirm `memory_recall` is called and the results
   are relevant.
3. Run `memory_code_map` for a structural question; confirm the
   signatures are accurate.
4. Run `memory_mine_skills`, then `memory_skill` — confirm a skill
   mined this session lists and loads without a restart.
5. Skim a session log with `analyze-logs.py` to see the tool calls and
   their latencies.

## What it is not

- **Not a vector store by default.** Lexical BM25, no neural ranker —
  though cross-lingual semantic search is an explicit opt-in.
- **Not an LLM.** No model is bundled or called; everything is
  deterministic structure + BM25.
- **Not an unbounded archive.** A configurable disk budget (50 MB default); least-used facts age out via LFU eviction.
- **Not a substitute for AGENTS.md.** AGENTS.md is for fuzzy guidance every turn; this is for facts surfaced on demand.
- **Not lossy by intent.** The store keeps verbatim content; eviction only kicks in over budget.

## Live code-map refresh

When `enableCodeMap` is on and the agent modifies a source file using
OpenCode's `write` or `edit` tool, the plugin **re-indexes that file's
code-map memory immediately** — before the agent's next tool call —
so `memory_code_map` never serves stale signatures within the same
session.

How it works: the `tool.execute.before` hook records which file a
`write`/`edit` is about to change; the `tool.execute.after` hook
(which fires once the file is on disk in its new form) calls
`ingestCodeMapForFile`, a per-file variant of the prefill walk. It
reuses the already-warm tree-sitter engine (the wasm init and grammar
loads only happen once per session, at prefill), so a single-file
re-parse costs ~milliseconds. `upsertBySubject` replaces the old
code-map memory in place — no duplicates, no accumulation.

**Honest coverage.** Only structured file-writing tools (`write`,
`edit`, and `patch` if present) are intercepted; their args carry a
`filePath` field the hook reads. `bash` is excluded by design: an
arbitrary shell command's file effects can't be reliably detected.
Deletions (`rm`, `unlink`) are not tracked. So:

- Agent uses `write`/`edit` on `src/handler.go` → code map refreshed.
- Agent runs `bash` to `sed -i …` a file → NOT refreshed (stale until next
  explicit recall or prefill). Work around: after a bash edit, have the
  agent call `memory_code_map` — the refresh will run at the next session's
  prefill automatically, and the current memory still covers the
  pre-edit signatures.
- Agent deletes a file → its code-map memory remains until the next
  prefill.

These limits are knowable and bounded. Prefill runs fresh on every new
session, so stale memories are always one session-close away from
correct.

## Compatibility

Built against `@opencode-ai/plugin@1.14.x`. Runs on the Bun runtime
(what OpenCode loads plugins under) — Bun ≥ 1.1. Uses documented
hooks only — `tool` for custom tools, `event` for `lsp.client.diagnostics`,
`tool.execute.before/after` for code-map refresh and the recall-first
nudge, `client.app.log` for session logs. Storage is a SQLite database
(`bun:sqlite`, built into the Bun runtime) you can inspect with any
SQLite client.

Coexists with other plugins. With a **hook-heavy plugin** alongside it
(e.g. `oh-my-opencode`), note that the recall-first nudge mutates
`output.output` in a `tool.execute.after` hook — if you'd rather not
have two plugins post-processing tool output, set
`enableNudgeHook: false`. The nudge effect is then suppressed;
**the hooks themselves remain registered** (they still run the
code-map refresh). If the other plugin already does AST/LSP code
intelligence, leaving `enableCodeMap` off avoids redundant work (and
the grammar-wasm weight) while diane still covers the persistent
memory store, git-structure signals, session ingestion, and skill
mining.


## License

MIT.
