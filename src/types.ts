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
  /** Max disk usage for memory store, in megabytes. Default 5. */
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
   * Default FALSE — this is the one heavyweight feature: it pulls in
   * web-tree-sitter plus vendored grammar wasm (~10.3 MB across
   * eleven languages). Opt in only if you want the agent to have the
   * codebase's structural shape.
   */
  enableCodeMap?: boolean
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
   * cap, the disk budget (large repos only — it never shrinks below
   * the 5 MB default), and the co-change cutoff accordingly. The
   * chosen tier is logged every run.
   *
   * Adaptation only fills knobs the user did NOT set explicitly — any
   * value you pass in config always wins. Set FALSE to pin every
   * setting to its fixed default regardless of repo size.
   */
  adaptive?: boolean
}

export interface ResolvedConfig {
  maxMemoryBytes: number
  autoIngestOnStartup: boolean
  gitHistoryDepth: number
  forceActive: boolean
  skillsOutputDir: string
  skillMiningMinCluster: number
  ingestSessions: boolean
  enableCodeMap: boolean
  enableNudgeHook: boolean
  adaptive: boolean
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
