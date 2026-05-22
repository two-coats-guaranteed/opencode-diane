/**
 * opencode-diane — type definitions.
 *
 * The store is hierarchical: top-level `category` partitions the
 * memory set, each entry has a `subject` (mid-level slug for
 * coarse filtering) and a free-form `content` body that's the
 * leaf-level text searched by BM25.
 */

export type Category =
  | "git-history"
  | "project-facts"
  | "code-health"
  | "code-map"
  | "session-trace"
  | "session-snapshot"
  | "agent-note"
  | "skill-mined"
  | "custom"

/** A single memory entry — a leaf in the hierarchy. */
export interface Memory {
  /** Stable id, e.g. `mem_000123`. */
  id: string
  category: Category
  /** Human-readable slug grouping related entries (file path, task name, etc.). */
  subject: string
  /** The actual text searched by BM25 and shown to the agent. */
  content: string
  /** Optional tags for filtering (e.g. "bugfix", "framework:django"). */
  tags: string[]
  /** Where this memory came from (e.g. `git:abc123`, `session:sess_xyz`, `agent`). */
  source: string
  /** Epoch ms. */
  createdAt: number
  /** Last time the entry was returned by a recall query. */
  usedAt: number
  /** Number of recalls that returned this entry. */
  useCount: number
  /** Approx byte size of content + subject + tags JSON — used for budget. */
  sizeBytes: number
  /** If true, never evicted regardless of budget. */
  pinned?: boolean
}

/** On-disk JSON representation. */
export interface MemoryStoreFile {
  version: 1
  memories: Memory[]
  meta: {
    ingestedAt: Record<string, number> // category → epoch ms of last ingest
    lastEvictionAt: number | null
    schema: 1
  }
}

/** Result of a recall query. */
export interface RecallHit {
  memory: Memory
  score: number
}

/** Plugin-level configuration (everything optional with defaults). */
export interface UserConfig {
  /** Max disk usage for memory store, in megabytes. Default 50. */
  maxMemoryDiskMB?: number
  /** Run ingest on plugin startup. Default true. */
  autoIngestOnStartup?: boolean
  /** Cap on commits walked by the git ingester. Default 500. */
  gitHistoryDepth?: number
  /** If true, run even when the directory isn't a detected workable repo. Default false. */
  forceActive?: boolean
  /** Where to write SKILL.md files (relative to project root). Default ".opencode/skills". */
  skillsOutputDir?: string
  /** Min cluster size to mine a skill. Default 3. */
  skillMiningMinCluster?: number
  /** Whether to ingest other OpenCode sessions for this project. Default true. */
  ingestSessions?: boolean
  /**
   * Build a tree-sitter "code map" of file signatures (Aider-style).
   * Default `true` since v0.0.4. Web-tree-sitter plus vendored grammar
   * wasm (~10.3 MB across thirteen languages) ships with the package
   * regardless; this flag controls whether the ingester RUNS at
   * startup. Set `false` to disable if you don't want structural
   * signatures in the store.
   */
  enableCodeMap?: boolean
  /**
   * On first startup, write `<skillsOutputDir>/<prefix>using-memory/SKILL.md`
   * so OpenCode surfaces a "call memory_recall first" instruction to
   * the agent at session start. The plugin's nudge hook and tool
   * descriptions already point the same way; this is the one-time
   * upfront push.
   *
   * Defaults to `true` since v0.0.4. Set `false` to never install it.
   * The file is written only when it does not already exist, so a
   * user can edit it and the edits survive every subsequent startup
   * — and a user can delete it (with this option still true) to opt
   * out for the lifetime of that checkout.
   */
  installUsageSkill?: boolean
  /**
   * Walk `<root>/docs/` (and conventional root-level docs like
   * CHANGELOG.md, CONTRIBUTING.md, ARCHITECTURE.md, …) and index
   * each H1/H2/H3 heading as a recallable section pointer
   * (`<path>:<line>  # <heading>` + first paragraph). Default `true`.
   */
  ingestDocs?: boolean
  /**
   * Index root-level agent-instruction files (AGENTS.md, CLAUDE.md,
   * GEMINI.md, COPILOT.md, CONVENTIONS.md, .cursorrules,
   * .windsurfrules, .clinerules) as project facts so the agent sees
   * the repo's house rules within the first recall. Default `true`.
   */
  ingestProjectNotes?: boolean
  /**
   * Walk for `.csv`, `.tsv`, `.xlsx`, `.xls`, `.xlsm` files and index
   * their column headers (first row only — never row data). XLSX/XLS
   * files are handled via SheetJS, lazy-loaded only when a spreadsheet
   * is actually encountered (projects with no spreadsheets pay no
   * module-load cost). Default `true`.
   */
  ingestTableHeaders?: boolean
  /**
   * Run the grammar-agnostic cross-reference ingester: detects file-to-
   * file connections in any language (Pascal, Ruby, Perl, Lua, …) and
   * config DSLs (JSON / YAML / TOML) where one file references another
   * by path. Multi-signal corroborated; filesystem-grounded signals
   * (path resolves to existing file) emit edges alone, lexical signals
   * (identifier mention) require an orthogonal corroboration before
   * emitting. Default `true`.
   */
  ingestCrossRefs?: boolean
  /**
   * Rarity threshold for the grammar-agnostic cross-reference ingester.
   * An identifier that is defined in *more than this many* files is
   * treated as too generic to use as a corroboration signal. Reduce to
   * tighten confidence (fewer, higher-quality edges); raise for large
   * monorepos where the same class name spans many packages. Default 3.
   */
  crossRefsRarityThreshold?: number
  /**
   * Maximum number of files the cross-reference ingester walks in one
   * prefill pass. Raise for monorepos with hundreds of thousands of
   * files; lower for speed. Default `2000`.
   */
  crossRefsMaxFiles?: number
  /**
   * Hard cap on total cross-reference edges emitted per prefill pass.
   * Lower values keep the memory store leaner; higher values give more
   * complete coverage on dense codebases. Default `10000`.
   */
  crossRefsMaxEdges?: number
  /**
   * Maximum number of files the docs ingester walks in one pass
   * (`docs/` tree + conventional root docs). Raise for documentation-
   * heavy repos. Default `200`.
   */
  docsMaxFiles?: number
  /**
   * Number of characters of body text captured after each heading as
   * context in the recall snippet. A longer value gives richer
   * snippets at the cost of larger memory entries. Default `240`.
   */
  docsBodyChars?: number
  /**
   * Deepest heading level to index. `3` indexes H1–H3; `2` indexes
   * only H1–H2; `4` or `5` captures deeper structure. Default `3`.
   */
  docsMaxHeadingLevel?: number
  /**
   * Maximum number of table files (CSV, TSV, XLSX) walked per prefill
   * pass. Default `200`.
   */
  tablesMaxFiles?: number
  /**
   * Skip XLSX/XLS files larger than this, in megabytes. Very large
   * spreadsheets are usually data dumps whose headers are rarely worth
   * indexing. Set `0` to skip ALL spreadsheets. Default `50`.
   */
  tablesMaxXlsxMB?: number
  /**
   * Maximum number of column headers to list per table / sheet in the
   * memory content. Wide tables beyond this threshold get a
   * "(N more)" note. Default `40`.
   */
  tablesMaxColumns?: number
  /**
   * Maximum bytes of content read from each agent-instruction file
   * (AGENTS.md, CLAUDE.md, .cursorrules, …). Teams with detailed
   * instructions should raise this. Default `6144` (6 KB).
   */
  notesMaxBytes?: number
  /**
   * Minimum number of times two files must appear in the same commit
   * before a co-change edge is recorded. Lower values add more
   * connections on new or small repos; higher values keep the graph
   * tight. Default `3`.
   */
  coChangeMinOccurrences?: number
  /**
   * Maximum number of source files the code-map ingester parses per
   * pass. By default this is set adaptively (1500 small / 4000 medium
   * / 10000 large), based on a one-shot measurement of the repo at
   * startup. Setting this explicitly *overrides the adaptive
   * decision* — useful when you know your repo's right size and want
   * deterministic behaviour. Set to a small value to speed up
   * startup at the cost of code-map completeness; raise for very
   * large monorepos. Default `4000` (medium tier).
   */
  codeMapMaxFiles?: number
  /**
   * Maximum number of git commits the co-change graph builder
   * scans per pass. By default adaptive (1000 small / 5000 medium /
   * 20000 large). Setting this explicitly overrides the adaptive
   * choice. Lower for faster startup at the cost of co-change graph
   * density; raise for repos where you want deeper history coverage.
   * Default `5000` (medium tier).
   */
  coChangeMaxCommits?: number
  /**
   * The recall-first nudge: a tool.execute.before/after hook pair that
   * appends ONE reminder to a discovery tool's output if the agent
   * does raw discovery without checking memory. Default TRUE.
   *
   * Set FALSE if another plugin (e.g. oh-my-opencode, which registers
   * many lifecycle hooks) also post-processes tool output and you'd
   * rather avoid two plugins touching `output.output`. The directive
   * tool descriptions still encourage recall-first; only the
   * output-mutating hook is disabled.
   */
  enableNudgeHook?: boolean
  /**
   * Adapt size-derived settings to the repository. Default TRUE.
   *
   * When on, prefill measures one cheap signal — commit count (or
   * file count when there's no git) — classifies the repo as small /
   * medium / large, and scales `gitHistoryDepth`, the code-map file
   * cap, and the co-change cutoff accordingly. (The disk budget is
   * deliberately not tier-scaled — the 50 MB default is generous
   * enough for every realistic repo.) The chosen tier is logged
   * every run.
   *
   * Adaptation only fills knobs the user did NOT set explicitly — any
   * value you pass in config always wins. Set FALSE to pin every
   * setting to its fixed default regardless of repo size.
   */
  adaptive?: boolean
  /**
   * Opt-in cross-lingual semantic search. Default FALSE.
   *
   * When on, the plugin also embeds each memory with a small
   * multilingual e5 model (via the optional `@huggingface/transformers`
   * dependency, downloaded on demand) and fuses vector similarity with
   * the BM25 lexical ranking. This lets a query in one language
   * (e.g. Chinese, Russian) retrieve code and comments written in
   * another (e.g. English) — something pure lexical search cannot do.
   *
   * It is fully additive: when off, no model is downloaded, no runtime
   * is loaded, and retrieval is byte-for-byte the lexical path. When
   * on but the optional dependency is absent, the plugin logs that and
   * falls back to lexical search rather than failing.
   */
  enableSemanticSearch?: boolean
  /**
   * The embedding model id (a transformers.js-compatible model).
   * Default "Xenova/multilingual-e5-small". Only consulted when
   * `enableSemanticSearch` is true.
   */
  embeddingModel?: string
  /**
   * Use Personalized PageRank for the co-change boost in recall,
   * instead of the default single-hop propagation. Default FALSE.
   *
   * The co-change graph (files historically changed together) feeds a
   * boost that surfaces structurally-related context a query alone
   * would miss. By default that boost is one hop — the direct
   * neighbours of the textual hits. With this on, it is instead a
   * restart-biased random walk over the whole graph: relevance
   * reaches multi-hop files, graded by graph distance.
   *
   * The tradeoff: PPR is a per-recall iterative computation (a few ms
   * on a large graph) and is less trivially inspectable than the one
   * hop. It is opt-in for that reason; the default stays cheap and
   * fully traceable. See WIKI: "How it compares".
   */
  personalizedPageRank?: boolean
}

export interface ResolvedConfig {
  maxMemoryBytes: number
  autoIngestOnStartup: boolean
  gitHistoryDepth: number
  forceActive: boolean
  skillsOutputDir: string
  /**
   * Prefix applied to mined skill subdirectory names AND to the
   * subjects of the memories that point at them. Default `""` — the
   * standalone behaviour, paths unchanged. Set to `"diane-"` at
   * startup when a coexisting plugin (caveman, oh-my-opencode) writes
   * into the same `.opencode/skills/` directory; this namespaces our
   * subdirs so they don't collide with the peer's slugs (`caveman`,
   * `caveman-commit`, …) and ensures `memory_skill` surfaces only
   * ours, not the peer's.
   */
  minedSkillPrefix: string
  skillMiningMinCluster: number
  ingestSessions: boolean
  enableCodeMap: boolean
  installUsageSkill: boolean
  ingestDocs: boolean
  ingestProjectNotes: boolean
  ingestTableHeaders: boolean
  ingestCrossRefs: boolean
  /** See `UserConfig.crossRefsRarityThreshold`. */
  crossRefsRarityThreshold: number
  crossRefsMaxFiles: number
  crossRefsMaxEdges: number
  docsMaxFiles: number
  docsBodyChars: number
  docsMaxHeadingLevel: number
  tablesMaxFiles: number
  tablesMaxXlsxMB: number
  tablesMaxColumns: number
  notesMaxBytes: number
  coChangeMinOccurrences: number
  enableNudgeHook: boolean
  adaptive: boolean
  enableSemanticSearch: boolean
  embeddingModel: string
  personalizedPageRank: boolean
  /**
   * Names of the keys the user set explicitly in opencode.json.
   * Adaptive tuning consults this so it never overrides a value the
   * user chose deliberately — it only fills in size-derived defaults.
   */
  explicitKeys: ReadonlySet<keyof UserConfig>
  /**
   * Size adaptation knobs not exposed as user config — set by
   * `applyAdaptiveTuning` from the measured repo signal, read by the
   * ingesters. When `adaptive` is false these stay at fixed defaults.
   */
  codeMapMaxFiles: number
  /** Skip the O(commits × files²) co-change pass above this commit count. */
  coChangeMaxCommits: number
}

/** Returned by tools that perform background operations. */
export interface BackgroundJobHandle {
  job: string
  startedAt: number
  /** Caller is told the job is running async; this is for the agent's reference. */
  note: string
}
