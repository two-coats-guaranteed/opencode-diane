/**
 * opencode-diane — OpenCode plugin entry point.
 *
 * A hierarchical, BM25-ranked memory store for any git repository,
 * in any language. Pre-fills from git history (read as structure —
 * diff shape, co-change, churn, recency, never the commit message
 * as a signal) and from project files (recognised by name,
 * summarised by format — JSON/TOML/YAML/etc., never by language
 * semantics). Ingests past OpenCode sessions on demand; mines
 * reusable SKILL.md files from recurring memory clusters.
 * No LLM at the core, no convention assumptions; optional opt-in
 * cross-lingual semantic search via a small multilingual e5 model.
 *
 * Tools exposed to the agent:
 *   memory_recall          — hierarchical search over the store
 *   memory_remember        — add an explicit note
 *   memory_snapshot        — record this session's understanding for resume by a later session
 *   memory_outline         — table of contents (counts per category)
 *   memory_status          — store size, hit stats, plugin version
 *   memory_code_map        — Aider-style tree-sitter signature map
 *   memory_skill           — read one mined skill by name
 *   memory_ingest_sessions — pull facts from past OpenCode sessions
 *   memory_ingest_git      — re-scan git history (pull/merge/rebase)
 *   memory_mine_skills     — turn clusters into .opencode/skills/<x>/SKILL.md (background)
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

import { MemoryRepository } from "./store/repository.js"
import { ingestGitHistory } from "./ingest/git.js"
import { ingestProjectFacts } from "./ingest/project.js"
import { ingestDocs } from "./ingest/docs.js"
import { ingestProjectNotes } from "./ingest/project-notes.js"
import { ingestTableHeaders } from "./ingest/tables.js"
import { ingestCrossRefs } from "./ingest/cross-refs.js"
import { ingestSessions } from "./ingest/sessions.js"
import { ingestCodeHealth } from "./ingest/code-health.js"
import { ingestCodeMap, ingestCodeMapForFile } from "./ingest/code-map.js"
import { writeSnapshot, latestSnapshot, snapshotSummary } from "./ingest/session-snapshot.js"
import { measureRepo, applyAdaptiveTuning } from "./ingest/adaptive.js"
import { createE5Embedder } from "./search/e5-embedder.js"
import { DEFAULT_EMBEDDING_MODEL, type Embedder } from "./search/embedder.js"
import { VectorStore } from "./store/vector-store.js"
import { embedMissingMemories } from "./search/embed-pass.js"
import { isGitRepo, currentHead, changedFilesInWorktree } from "./utils/shell.js"
import { createFileLogger, truncateForLog } from "./utils/file-log.js"
import { detectPeerPlugins } from "./utils/peer-detection.js"
import { installUsageSkill } from "./utils/usage-skill.js"
import { mineSkills, readMinedSkills } from "./mining/skill-miner.js"
import { LiveSessionRecorder } from "./ingest/live-session.js"
import type { Category, ResolvedConfig, UserConfig } from "./types.js"

const SERVICE = "opencode-diane"

/**
 * Plugin version, read at startup from this package's own package.json.
 *
 * `package.json#version` is the **single source of truth** for the
 * release version — change it there and it propagates everywhere this
 * constant is used (the `plugin.active` startup event, the
 * `memory_status` tool's output, and any downstream tooling that
 * reads the logs). There is no second place to update, by design.
 *
 * The read is relative to this module's location, which resolves to
 * the package root in BOTH dev (`src/index.ts` → `src/../package.json`)
 * and after install (`dist/index.js` → `dist/../package.json`), so it
 * works identically in both. If the file is unreachable for any
 * reason the constant degrades to `"unknown"` rather than crashing —
 * a missing version label is a worse outcome than a missing plugin.
 */
const PLUGIN_VERSION: string = ((): string => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const text = readFileSync(join(here, "..", "package.json"), "utf-8")
    return (JSON.parse(text) as { version?: string }).version ?? "unknown"
  } catch {
    return "unknown"
  }
})()

export type {
  BackgroundJobHandle,
  Category,
  Memory,
  MemoryStoreFile,
  RecallHit,
  ResolvedConfig,
  UserConfig,
} from "./types.js"

export const OpencodeDiane: Plugin = async (ctx, options) => {
  const root = pickRoot(ctx.directory, ctx.worktree)
  const client = ctx.client
  // OpenCode passes per-plugin options when the plugin is listed as a
  // tuple in opencode.json: ["opencode-diane", { ...options }].
  // Coerce defensively — it's untrusted JSON, junk keys are ignored.
  const config = resolveConfig(coerceUserConfig(options))

  // ── Peer-plugin compatibility (auto-detected, opt-out) ─────────────
  // Read the user's opencode.json(s) and see which known coexisting
  // plugins are listed alongside us. Two compatibility decisions get
  // made here when peers are present AND the user didn't override:
  //
  //   - oh-my-opencode also rewrites tool output; two plugins both
  //     mutating `output.output` interleave unpredictably. Disable
  //     our nudge hook in its presence.
  //   - caveman writes skills into the shared `.opencode/skills/`
  //     directory under fixed slugs (`caveman`, `caveman-commit`, …).
  //     Namespace our mined-skill subdirs with `diane-` so they don't
  //     collide, and so `memory_skill` surfaces only our skills, not
  //     the peer's.
  //
  // Standalone — no peer listed — `peers` is all-false and behaviour
  // is byte-for-byte the documented default.
  const peers = detectPeerPlugins(root)
  if (peers.ohMyOpencode && !config.explicitKeys.has("enableNudgeHook")) {
    config.enableNudgeHook = false
  }
  if ((peers.ohMyOpencode || peers.caveman) && !config.explicitKeys.has("skillsOutputDir")) {
    config.minedSkillPrefix = "diane-"
  }

  // Rich on-disk log. Two sinks: OpenCode's session log channel (the
  // existing `client.app.log` call below — for the user/agent in the
  // UI) and a per-session JSONL file under `os.tmpdir()/diane/`
  // (for debugging the plugin itself across runs). The file logger is
  // failure-tolerant: a write error drops it silently — never the host.
  const fileLog = createFileLogger({ service: SERVICE, base: { root } })

  const log = (level: "debug" | "info" | "warn" | "error", msg: string): void => {
    void client.app
      .log({ body: { service: SERVICE, level, message: msg } })
      .catch(() => {})
    fileLog.log(level, msg)
  }
  /**
   * Structured-event sink. Use when the *shape* of the data matters
   * more than the prose — counts from an ingester, ms from a flush, an
   * eviction's removed/freed totals. Goes to the JSONL file only; the
   * OpenCode log channel keeps its existing human-readable lines.
   */
  const event = (name: string, data?: Record<string, unknown>): void => {
    fileLog.event(name, data)
  }

  /**
   * Per-tool-call structured-event helper. Every tool's `execute`
   * body wraps in a try/catch/finally and calls this from `finally`,
   * passing the args, a start timestamp, and either a result summary
   * (success) or an error message. One `tool.call` event lands per
   * invocation, success or failure — the file becomes a complete
   * audit trail of what the agent did and how long it took.
   *
   * Args are run through `truncateForLog` so a 10 KB `content` arg on
   * `memory_remember` (or a long recall query) doesn't bloat the line.
   * The per-tool `summary` is the *meaningful* return shape (counts,
   * ids), not the prose return string — those are very different
   * audiences: the agent sees prose, the analyst sees structure.
   */
  const recordToolCall = (
    toolName: string,
    args: unknown,
    t0: number,
    summary: Record<string, unknown>,
    error: string | undefined
  ): void => {
    event("tool.call", {
      tool: toolName,
      ms: Math.round(performance.now() - t0),
      args: truncateForLog(args),
      ...(error === undefined ? { ok: true, result: summary } : { ok: false, error }),
    })
  }

  /**
   * Inject a note into the live session as a `noReply: true` message.
   * This is OpenCode's documented message-insertion pattern — the same
   * mechanism the native skills system uses to deliver skill content
   * so it persists in context even when tool outputs are later purged.
   * It's how a skill mined *mid-session* becomes usable now instead of
   * on the next restart.
   *
   * Best-effort: returns false (never throws) if there's no live
   * session client — e.g. an older OpenCode, or a unit-test harness
   * with no server. Callers fall back to returning the content as the
   * tool result, which still puts it in front of the agent.
   */
  const injectSessionNote = async (
    sessionId: string | undefined,
    text: string
  ): Promise<boolean> => {
    const c = client as {
      session?: { prompt?: (a: unknown) => Promise<unknown> }
    }
    if (!sessionId || typeof c.session?.prompt !== "function") return false
    try {
      await c.session.prompt({
        path: { id: sessionId },
        body: { noReply: true, parts: [{ type: "text", text }] },
      })
      return true
    } catch {
      return false
    }
  }

  // Announce the log file in the OpenCode channel so a user looking
  // for it doesn't have to guess. Debug level — informational, not
  // worth the user's foreground attention.
  log("debug", `rich logs at ${fileLog.path()}`)

  // ── 1. Load the store ──────────────────────────────────────────────
  // If the legacy JSON-to-SQLite migration fails (rare — typically
  // when another plugin is touching the DB during startup, or a Bun
  // build mismatch interferes with `bun:sqlite`), we DO NOT crash the
  // plugin: a "db migration" exception during startup was a real
  // failure mode observed in the field when running alongside other
  // heavyweight plugins. Instead we emit a structured event so the
  // cause is in the JSONL log, mirror a clear human-readable line to
  // OpenCode, and continue with an empty fresh database. The next
  // startup will retry the migration — losing memories is recoverable;
  // failing to start is not.
  const repo = await MemoryRepository.load(root, (e) => {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    fileLog.event("store.migration.failed", { reason })
    log("warn",
      `legacy diane.json migration failed (${reason}); ` +
      `starting with an empty database — your .opencode/diane.json is ` +
      `untouched and the next startup will retry the migration.`,
    )
  })

  // ── Nudge state (session-scoped via this closure) ─────────────────
  // "Kinda enforce" the recall-first workflow: if the agent does
  // several raw discovery calls without ever touching a memory tool,
  // append ONE gentle reminder to a discovery tool's output. It never
  // blocks, never mutates file-read output, fires at most once, and
  // goes quiet the moment any memory tool is used.
  const MEMORY_TOOLS = new Set([
    "memory_recall",
    "memory_code_map",
    "memory_outline",
    "memory_ingest_sessions",
    "memory_ingest_git",
    "memory_remember",
    "memory_mine_skills",
    "memory_skill",
  ])
  // Tools whose output is free text and safe to append a line to.
  const NUDGEABLE_DISCOVERY = new Set(["grep", "glob", "bash", "list"])
  // Tools that count toward "doing discovery" (includes read, but we
  // never mutate read output — file contents must stay pristine).
  const DISCOVERY_TOOLS = new Set(["grep", "glob", "bash", "list", "read"])
  let memoryToolUsed = false
  let discoveryCallCount = 0
  let nudgeShown = false

  // ── Code-map freshness (independent of the nudge) ─────────────────
  // When the agent edits code, the edited file's code-map memory must
  // be re-indexed or recall/memory_code_map would serve stale
  // signatures for the rest of the session. These are the structured
  // file-writing tools whose args carry a `filePath`; `bash` is
  // deliberately excluded — an arbitrary shell command's file effects
  // can't be known, so bash-driven changes (and deletions) are a known
  // gap, documented as such.
  const FILE_WRITE_TOOLS = new Set(["write", "edit", "patch"])
  // callID → the path a pending write/edit is about to change, recorded
  // in the before-hook and consumed in the after-hook (once the file is
  // actually on disk in its new form). Bounded to PENDING_MAP_CAP — the
  // matching after-hook normally fires for every before, but a rare
  // tool-execution abort or a plugin reload mid-tool can leave orphan
  // entries; FIFO eviction at the cap keeps the map size finite over
  // long-running sessions.
  const PENDING_MAP_CAP = 256
  const pendingEditPaths = new Map<string, string>()

  /**
   * Insert into a bounded Map keyed by callID, evicting the oldest
   * entry when the cap is exceeded. JavaScript's `Map` preserves
   * insertion order, so iterating keys() yields oldest-first.
   */
  function setBoundedPending(m: Map<string, string>, k: string, v: string): void {
    m.set(k, v)
    while (m.size > PENDING_MAP_CAP) {
      const oldest = m.keys().next().value
      if (oldest === undefined) break
      m.delete(oldest)
    }
  }

  // Re-index one file's code-map after the agent edits it. Defensive:
  // a freshness refresh must never throw into a tool call.
  async function refreshCodeMapAfterEdit(filePath: string): Promise<void> {
    try {
      if (!config.enableCodeMap) return // nothing to keep fresh
      const abs = isAbsolute(filePath) ? filePath : join(root, filePath)
      if (!abs.startsWith(root)) return // only files inside the repo
      const outcome = await ingestCodeMapForFile(repo, root, abs)
      if (outcome === "updated") {
        repo.applyEviction(config)
        log("debug", `code-map: re-indexed ${abs.slice(root.length).replace(/^\/+/, "")} after edit`)
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      log("warn", `code-map refresh after edit failed: ${m}`)
    }
  }

  // ── 2. Idle only on directories that aren't a workable repo ───────
  // "Workable" = a git repo, or a directory with at least one
  // recognised project/build file. This is language-neutral.
  const workable = await detectWorkableRepo(root)
  if (!workable && !config.forceActive) {
    log(
      "info",
      `no git history and no recognised project files — memory plugin idle. ` +
        `Set forceActive: true to override.`
    )
    event("plugin.idle", { reason: "no-workable-repo" })
    fileLog.close()
    return {}
  }

  // ── 3. Background pre-fill on first run / new commits ─────────────
  const prefillDone: Promise<unknown> = config.autoIngestOnStartup
    ? prefillInBackground(
        repo,
        root,
        client,
        config,
        log,
        event,
        (ctx as unknown as { sessionID?: string }).sessionID
      )
    : Promise.resolve()
  // Fire-and-forget for the main path; prefill handles its own errors.
  void prefillDone

  // ── 3b. Optional cross-lingual semantic search (opt-in) ───────────
  // Disabled by default — when off, nothing below runs, no model is
  // downloaded, `@huggingface/transformers` is never imported, and
  // recall is the unchanged pure-lexical path. When on, the model
  // loads in the background; recalls before it is ready simply use
  // lexical search. A failure here (missing optional dependency,
  // blocked download) degrades to lexical search — it never breaks
  // the plugin.
  let embedder: Embedder | undefined
  if (config.enableSemanticSearch) {
    void initSemanticSearch(prefillDone)
  }
  async function initSemanticSearch(prefill: Promise<unknown>): Promise<void> {
    try {
      const e = await createE5Embedder(config.embeddingModel)
      const vs = VectorStore.open(root, e.id)
      repo.attachVectorStore(vs)
      embedder = e // from now on recalls fuse vector similarity with BM25
      log("info", `semantic: model ${e.id} ready (${vs.size()} cached vectors)`)
      event("semantic.ready", { model: e.id, cachedVectors: vs.size() })
      await prefill // every memory must exist before the embedding pass
      const { embedded, pruned } = await embedMissingMemories(repo, vs, e, (m) =>
        log("info", m)
      )
      log(
        "info",
        `semantic: embedding pass done — ${embedded} embedded, ${pruned} pruned, ` +
          `${vs.size()} vectors total`
      )
      event("semantic.embedded", { embedded, pruned, total: vs.size() })
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      log("warn", `semantic search unavailable — ${m}; using lexical search only`)
      event("semantic.unavailable", { reason: m })
    }
  }

  log(
    "info",
    `active: store has ${repo.size()} memories, ${humanBytes(repo.totalBytes())} on disk, budget ${humanBytes(config.maxMemoryBytes)}.`
  )
  // If we adapted to a coexisting plugin, say so once and name what
  // we changed. Silent in the standalone case (peers.found is empty).
  if (peers.found.length > 0) {
    const adjusted: string[] = []
    if (peers.ohMyOpencode && !config.explicitKeys.has("enableNudgeHook")) {
      adjusted.push("nudge hook disabled (oh-my-opencode also rewrites tool output)")
    }
    if ((peers.ohMyOpencode || peers.caveman) && !config.explicitKeys.has("skillsOutputDir")) {
      adjusted.push("mined skills prefixed with 'diane-' to namespace them under .opencode/skills/")
    }
    log(
      "info",
      `coexisting plugin(s) detected (${peers.found.join(", ")})` +
        (adjusted.length > 0 ? ` — ${adjusted.join("; ")}` : " — no compatibility adjustments needed"),
    )
  }
  event("plugin.active", {
    version: PLUGIN_VERSION,
    storeSize: repo.size(),
    bytesTotal: repo.totalBytes(),
    budgetBytes: config.maxMemoryBytes,
    autoIngestOnStartup: config.autoIngestOnStartup,
    enableCodeMap: config.enableCodeMap,
    ingestSessions: config.ingestSessions,
    enableSemanticSearch: config.enableSemanticSearch,
    peers: {
      ohMyOpencode: peers.ohMyOpencode,
      caveman: peers.caveman,
      found: peers.found,
    },
    enableNudgeHook: config.enableNudgeHook,
    minedSkillPrefix: config.minedSkillPrefix,
  })

  // ── Install the agent-facing usage skill ──────────────────────────
  // OpenCode discovers `.opencode/skills/<name>/SKILL.md` files at
  // session start and surfaces their contents to the agent. We write
  // ours on first startup so the agent learns to call memory_recall
  // before raw grep/glob/read — the soft-force adoption mechanism
  // promised in opencode.json: `installUsageSkill: true` (default).
  //
  // Failure here is a quality-of-life regression, never fatal: a
  // read-only project root, a missing parent directory, anything —
  // we log and continue. Plugin startup must never depend on this.
  if (config.installUsageSkill) {
    const res = installUsageSkill(root, config.skillsOutputDir, config.minedSkillPrefix)
    fileLog.event("usage-skill.write", {
      outcome: res.outcome,
      path: res.path,
      error: res.error ? String(res.error) : undefined,
    })
    if (res.outcome === "installed") {
      log("info", `installed usage skill at ${res.path} — the agent will see it at session start`)
    } else if (res.outcome === "failed") {
      log("warn", `could not write the usage skill (${res.path}): ${res.error}`)
    }
    // "preserved" is silent — that's the steady state once installed.
  }

  // ── 4. Live session reflection + git change detection ─────────────
  // Three pieces of state added in this version, all defensive,
  // none capable of breaking a tool call:
  //
  //   (a) LiveSessionRecorder rolls up this session's file edits and
  //       bash commands into ONE memory under `live:${sessionId}`,
  //       updated after each event. Lets the current session recall
  //       what it has already touched, and pre-seeds the trace for
  //       successor sessions.
  //
  //   (b) lastKnownHead is the git HEAD commit SHA observed at the
  //       last check. After each `bash` call we poll it again; a
  //       mismatch means a pull / merge / rebase / checkout happened
  //       in the working tree and the git ingester needs to run again.
  //
  //   (c) gitReingestInFlight coalesces concurrent triggers. If three
  //       bash commands all move HEAD before the first re-ingest
  //       finishes, only one re-ingest pass actually runs; subsequent
  //       detections see the flag and exit. The next post-bash poll
  //       picks up where the previous pass left off.
  //
  // `pendingBashCommands` mirrors the existing `pendingEditPaths` —
  // the before-hook stashes the bash command string keyed by callID
  // and the after-hook consumes it to feed the recorder. Missing
  // entries are silently ignored.
  const sessionIdForRecorder =
    (ctx as unknown as { sessionID?: string }).sessionID ??
    `unknown-${Date.now()}`
  const liveRecorder = config.recordSessionActivity
    ? new LiveSessionRecorder(repo, sessionIdForRecorder)
    : undefined
  const pendingBashCommands = new Map<string, string>()
  let lastKnownHead: string | null = null
  let gitReingestInFlight = false
  // Seed the HEAD baseline asynchronously — no need to block startup,
  // the value only matters once a bash command has executed.
  if (config.autoReingestGitOnHeadChange) {
    void currentHead(root).then((h) => { lastKnownHead = h })
  }

  /**
   * Check whether HEAD has moved since the last poll; if so, queue a
   * background git re-ingest (idempotent — already-known commits are
   * skipped). Coalesces concurrent triggers via `gitReingestInFlight`.
   * Best-effort: any error is logged and swallowed.
   */
  async function reingestGitIfHeadMoved(): Promise<void> {
    if (!config.autoReingestGitOnHeadChange) return
    if (gitReingestInFlight) return
    try {
      const head = await currentHead(root)
      if (head === null || head === lastKnownHead) return
      const previous = lastKnownHead
      lastKnownHead = head
      gitReingestInFlight = true
      log(
        "info",
        `git: HEAD moved ${(previous ?? "?").slice(0, 7)} → ${head.slice(0, 7)} — re-ingesting`,
      )
      event("git.head.changed", { from: previous, to: head })
      // Fire-and-forget — we don't want to block the next tool call on
      // a potentially-multi-second git history scan.
      void (async () => {
        try {
          const git = await ingestGitHistory(
            repo,
            root,
            config.gitHistoryDepth,
            config.coChangeMaxCommits,
            config.coChangeMinOccurrences,
          )
          repo.applyEviction(config)
          await repo.forceFlush()
          log(
            "info",
            `git: re-ingest after HEAD move — scanned ${git.scanned} commits, ` +
              `${git.commitMemories} commit memories, ${git.coChangeMemories} co-change`,
          )
          event("ingest.git.reingested", {
            trigger: "head-change",
            scanned: git.scanned,
            commitMemories: git.commitMemories,
            coChangeMemories: git.coChangeMemories,
          })
        } catch (err) {
          log("warn", `git re-ingest after HEAD move failed: ${err}`)
          event("ingest.git.reingested.failed", { error: String(err) })
        } finally {
          gitReingestInFlight = false
        }
      })()
    } catch (err) {
      log("warn", `git HEAD check failed: ${err}`)
      gitReingestInFlight = false
    }
  }

  // ── 5. Tools ───────────────────────────────────────────────────────
  // Build the full set, then expose only the three the eval showed the
  // agent actually uses (memory_recall, memory_outline, memory_remember)
  // unless `exposeOpsTools` is true. The seven "ops" tools went unused
  // across all 21 diane sessions in the SWE-bench Lite eval — their
  // descriptions only cost system-prompt tokens every turn.
  const allTools = {
      memory_recall: tool({
        description:
          "Search the repo memory store for code structure, file co-change, " +
          "and notes relevant to a task. Returns a token-budgeted digest of " +
          "ranked file signatures, recent commits, and saved notes. " +
          "Cost: typically 500-3000 input tokens of context returned. " +
          "Use when you don't know which file to start with. Skip when the " +
          "user already named the file, or when one read/grep would obviously " +
          "answer the question.",
        args: {
          query: tool.schema.string().describe("Free-form search query — words, file paths, identifiers."),
          category: tool.schema.string().optional().describe("Optional category filter."),
          subject: tool.schema.string().optional().describe("Optional subject filter (file path, task slug, etc.)."),
          limit: tool.schema.number().optional().describe("Hard cap on hit count considered. Default 25."),
          prefer: tool.schema
            .string()
            .optional()
            .describe(
              "Optional intent lean: 'code' (implementation), 'tests' (test files), " +
                "'history' (change history), or 'any'. Set from what the user is asking " +
                "for; omit for general queries."
            ),
          tokenBudget: tool.schema
            .number()
            .optional()
            .describe(
              "Ceiling on the formatted result size, in estimated tokens. Default 1200. " +
                "Ranked hits are packed until the next would overflow."
            ),
        },
        async execute(args) {
          const t0 = performance.now()
          const summary: Record<string, unknown> = {}
          let error: string | undefined
          try {
            const cat = isCategory(args.category) ? args.category : undefined
            const prefer =
              args.prefer === "code" ||
              args.prefer === "tests" ||
              args.prefer === "history" ||
              args.prefer === "any"
                ? args.prefer
                : undefined
            const formatHit = (h: { memory: { category: string; subject: string; content: string }; score: number }): string =>
              `[${h.memory.category} | ${h.memory.subject} | score ${h.score.toFixed(2)}] ${h.memory.content}`
            // When semantic search is on and the model is ready, embed
            // the query so recall can fuse vector similarity with BM25.
            // The embedding is done here, in the async tool handler, so
            // the recall path itself stays synchronous. A failure falls
            // back to lexical-only — it never fails the recall.
            let queryVector: Float32Array | undefined
            if (embedder) {
              try {
                queryVector = await embedder.embedQuery(args.query)
              } catch (e) {
                log(
                  "debug",
                  `semantic: query embed failed, using lexical only — ` +
                    `${e instanceof Error ? e.message : String(e)}`
                )
              }
            }
            const { hits, omitted } = repo.recallDetailed(
              {
                query: args.query,
                category: cat,
                subject: args.subject,
                prefer,
                limit: args.limit ?? 25,
                tokenBudget: args.tokenBudget ?? 1200,
                queryVector,
                personalizedPageRank: config.personalizedPageRank,
              },
              formatHit
            )
            summary.hits = hits.length
            summary.omitted = omitted
            summary.category = cat ?? null
            summary.prefer = prefer ?? null
            summary.semantic = queryVector !== undefined
            summary.hadSubject = args.subject !== undefined
            summary.tokenBudget = args.tokenBudget ?? 1200
            if (hits.length === 0) return "(no memories matched)"

            // Confidence-based payload sizing.
            // The 40-session SWE-bench eval showed diane's failure mode
            // on `pylint-6506` was confidently misrouting: a high BM25
            // score on the wrong file. The fix is to *not* commit to a
            // confident-looking answer unless the score distribution
            // actually supports it.
            //
            //  - top-1 score dominates (ratio top-1 / top-3 > 2.0):
            //    return up to 3 hits with full content. The store
            //    believes it knows the answer.
            //  - moderate spread (1.5 < ratio ≤ 2.0): default behaviour.
            //  - flat scores (ratio ≤ 1.5): the store has no idea which
            //    is best. Return path-only entries — let the agent
            //    pick by name instead of getting blanketed in content
            //    that's no more relevant than a grep.
            const top1 = hits[0].score
            const refScore = hits[Math.min(2, hits.length - 1)].score
            const ratio = refScore > 0 ? top1 / refScore : Infinity
            summary.confidence = ratio >= 2.0 ? "peaked"
                              : ratio > 1.5  ? "moderate"
                              : "flat"
            summary.scoreRatio = Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null

            const lines: string[] = []
            if (ratio >= 2.0) {
              // peaked — top hit(s) only, with full content
              const keep = hits.slice(0, Math.min(3, hits.length))
              for (const h of keep) lines.push(formatHit(h))
              const more = hits.length - keep.length + omitted
              if (more > 0) {
                lines.push(`… (+${more} lower-scoring hits suppressed — top-1 score ${top1.toFixed(2)} dominates)`)
              }
            } else if (ratio <= 1.5) {
              // flat — paths only, no content. Half-page of paths beats
              // a third-page of half-relevant content blocks.
              for (const h of hits) {
                lines.push(`[${h.memory.category} | ${h.memory.subject} | score ${h.score.toFixed(2)}]`)
              }
              if (omitted > 0) {
                lines.push(`… (+${omitted} more omitted to fit the ~${args.tokenBudget ?? 1200}-token budget)`)
              }
              lines.push(`(scores are flat — content omitted. Use memory_recall again with a more specific query, or read the file you want directly.)`)
            } else {
              // moderate — original token-budgeted listing
              for (const h of hits) lines.push(formatHit(h))
              if (omitted > 0) {
                lines.push(
                  `… (+${omitted} more hit${omitted === 1 ? "" : "s"} omitted to fit the ` +
                    `~${args.tokenBudget ?? 1200}-token budget — raise tokenBudget or narrow the query)`
                )
              }
            }
            return lines.join("\n")
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
            throw e
          } finally {
            recordToolCall("memory_recall", args, t0, summary, error)
          }
        },
      }),

      memory_remember: tool({
        description:
          "Save a durable note that a future session can recall instead " +
          "of rediscovering. Use for facts that cost real tool-calls to " +
          "find: a non-obvious file path, an unstated coupling, a " +
          "regression to watch for, a decision the user just made. " +
          "Don't use for transient state.",
        args: {
          subject: tool.schema.string().describe("Short slug (e.g. 'auth/login.py', 'task:add-pagination')."),
          content: tool.schema.string().describe("The note itself — one short paragraph."),
          tags: tool.schema.array(tool.schema.string()).optional().describe("Optional tags for filtering."),
        },
        async execute(args) {
          const t0 = performance.now()
          const summary: Record<string, unknown> = {}
          let error: string | undefined
          try {
            const m = repo.insertIfMissing({
              category: "agent-note",
              subject: args.subject,
              content: args.content,
              tags: args.tags ?? [],
              source: "agent",
            })
            repo.applyEviction(config)
            summary.id = m.id
            summary.sizeBytes = m.sizeBytes
            summary.bytesTotal = repo.totalBytes()
            return `stored: ${m.id} (${humanBytes(repo.totalBytes())} of ${humanBytes(config.maxMemoryBytes)})`
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
            throw e
          } finally {
            recordToolCall("memory_remember", args, t0, summary, error)
          }
        },
      }),

      memory_snapshot: tool({
        description:
          "Record this session's hard-won UNDERSTANDING so a later — or parallel — " +
          "session can resume from it instead of rebuilding it. Unlike memory_remember " +
          "(individual facts), this captures the whole working picture: your mental model " +
          "of the codebase/task, the decisions you've made and why, and conventions or " +
          "constraints you've learned that aren't obvious from the code. Call it when you " +
          "have built up real context — before a long task's context fills, after a key " +
          "decision, or when wrapping up. It replaces this session's previous snapshot " +
          "(one per session) and links the most recent other session as its parent, so " +
          "snapshots form a branchable history. Snapshots are pinned — never evicted. The " +
          "next session's prefill resumes from the latest one automatically.",
        args: {
          summary: tool.schema
            .string()
            .describe("One short paragraph: the working mental model of the codebase/task."),
          decisions: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Decisions made and why — each a short line."),
          conventions: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Conventions or constraints learned that aren't obvious from the code."),
        },
        async execute(args) {
          const t0 = performance.now()
          const summary: Record<string, unknown> = {}
          let error: string | undefined
          try {
            const sessionId =
              (ctx as unknown as { sessionID?: string }).sessionID ?? `unknown-${Date.now()}`
            const res = writeSnapshot(repo, sessionId, {
              summary: args.summary,
              decisions: args.decisions,
              conventions: args.conventions,
            })
            repo.applyEviction(config)
            await repo.forceFlush()
            summary.id = res.id
            summary.parentId = res.parentId ?? null
            summary.decisionCount = args.decisions?.length ?? 0
            summary.conventionCount = args.conventions?.length ?? 0
            return (
              `snapshot saved: ${res.id}` +
              (res.parentId ? ` (parent: ${res.parentId})` : " (first snapshot — no parent)")
            )
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
            throw e
          } finally {
            recordToolCall("memory_snapshot", args, t0, summary, error)
          }
        },
      }),

      memory_outline: tool({
        description:
          "Return a count of memories per category in the store " +
          "(git-history, code-map, etc.). Cheap (~50 tokens out). " +
          "Use once at session start on an unfamiliar repo to decide " +
          "which category to memory_recall next. Skip if you already " +
          "know what file to look at.",
        args: {},
        async execute() {
          const t0 = performance.now()
          const summary: Record<string, unknown> = {}
          let error: string | undefined
          try {
            const counts = repo.countsByCategory()
            summary.totalMemories = repo.size()
            summary.bytesTotal = repo.totalBytes()
            summary.categories = Object.fromEntries(counts)
            if (counts.size === 0) return "(memory is empty)"
            const lines = Array.from(counts.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([c, n]) => `${c}: ${n}`)
            return `${repo.size()} memories total, ${humanBytes(repo.totalBytes())} on disk:\n${lines.join("\n")}`
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
            throw e
          } finally {
            recordToolCall("memory_outline", {}, t0, summary, error)
          }
        },
      }),

      memory_code_map: tool({
        description:
          "Call this BEFORE reading source files to understand how the codebase is laid " +
          "out — it is the Aider-style structural map: per-file signatures of functions, " +
          "classes, methods and types, bodies stripped, so you see the shape of the code " +
          "for a fraction of the tokens that reading the files would cost (~45 tokens per " +
          "file). Ranked by relevance to `query` and co-change-boosted, so a file's " +
          "structurally-coupled neighbours surface too. Use it to find where a symbol " +
          "likely lives, or to orient before diving into a feature area — then `read` only " +
          "the specific files you actually need. Returns nothing useful unless code-map " +
          "ingestion is enabled (config.enableCodeMap, on by default since v0.0.4 — set " +
          "it to false to disable); if it is empty, fall back to memory_recall + targeted reads.",
        args: {
          query: tool.schema
            .string()
            .optional()
            .describe(
              "What you're looking for — a feature, symbol, or file area. " +
                "Omit for a broad map of the most-connected files."
            ),
          tokenBudget: tool.schema
            .number()
            .optional()
            .describe("Ceiling on result size in estimated tokens. Default 1500."),
        },
        async execute(args) {
          const t0 = performance.now()
          const summary: Record<string, unknown> = {}
          let error: string | undefined
          try {
            const formatHit = (h: {
              memory: { category: string; subject: string; content: string }
              score: number
            }): string => `[${h.memory.subject}] ${h.memory.content}`
            // A broad query when none is given: 'definition' appears in
            // every code-map memory body, so it matches them all and the
            // co-change boost + useCount bias do the ranking.
            const { hits, omitted } = repo.recallDetailed(
              {
                query: args.query && args.query.trim() ? args.query : "definition function class",
                category: "code-map",
                limit: 60,
                tokenBudget: args.tokenBudget ?? 1500,
              },
              formatHit
            )
            summary.hits = hits.length
            summary.omitted = omitted
            summary.tokenBudget = args.tokenBudget ?? 1500
            summary.hadQuery = Boolean(args.query && args.query.trim())
            if (hits.length === 0) {
              return (
                "(code map is empty — it is enabled by default; if you set " +
                "config.enableCodeMap: false, re-enable it and restart OpenCode " +
                "so the plugin can parse the tree)"
              )
            }
            const lines = hits.map(formatHit)
            if (omitted > 0) {
              lines.push(
                `… (+${omitted} more file map${omitted === 1 ? "" : "s"} omitted to fit the ` +
                  `~${args.tokenBudget ?? 1500}-token budget — narrow the query or raise tokenBudget)`
              )
            }
            return lines.join("\n")
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
            throw e
          } finally {
            recordToolCall("memory_code_map", args, t0, summary, error)
          }
        },
      }),

      memory_status: tool({
        description: "Stats about the memory store — size, count, budget, last ingest timestamps.",
        args: {},
        async execute() {
          const t0 = performance.now()
          const summary: Record<string, unknown> = {}
          let error: string | undefined
          try {
            const lines: string[] = [
              `version: ${PLUGIN_VERSION}`,
              `count: ${repo.size()}`,
              `bytes: ${humanBytes(repo.totalBytes())} / ${humanBytes(config.maxMemoryBytes)}`,
            ]
            const ingestedAt: Record<string, number | null> = {}
            for (const cat of ["git-history", "project-facts", "session-trace"] as Category[]) {
              const ts = repo.getIngestedAt(cat)
              ingestedAt[cat] = ts ?? null
              lines.push(`${cat}: ${ts ? new Date(ts).toISOString() : "(never ingested)"}`)
            }
            summary.version = PLUGIN_VERSION
            summary.totalMemories = repo.size()
            summary.bytesTotal = repo.totalBytes()
            summary.budgetBytes = config.maxMemoryBytes
            summary.ingestedAt = ingestedAt
            return lines.join("\n")
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
            throw e
          } finally {
            recordToolCall("memory_status", {}, t0, summary, error)
          }
        },
      }),

      memory_ingest_sessions: tool({
        description:
          "Run this EARLY on a returning project — it pulls what past OpenCode sessions " +
          "already did into memory, so you can build on prior work instead of repeating " +
          "it. Each past session contributes a 'task' memory (its opening request) and a " +
          "'trace' memory (distinct files edited + bash commands run). After ingesting, " +
          "memory_recall will surface 'this was tried before' context. Cheap insurance " +
          "against redoing a teammate's — or your own earlier — discovery work.",
        args: {},
        async execute() {
          const t0 = performance.now()
          const summary: Record<string, unknown> = {}
          let error: string | undefined
          try {
            const sessionId =
              (ctx as unknown as { sessionID?: string }).sessionID ?? undefined
            const res = await ingestSessions(repo, client, sessionId)
            repo.applyEviction(config)
            await repo.forceFlush()
            summary.sessions = res.sessions
            summary.taskMemories = res.taskMemories
            summary.traceMemories = res.traceMemories
            summary.errors = res.errors
            return (
              `ingested ${res.sessions} past session(s): ` +
              `${res.taskMemories} task memories + ${res.traceMemories} trace memories. ` +
              (res.errors.length > 0 ? `errors: ${res.errors.join("; ")}` : "")
            )
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
            throw e
          } finally {
            recordToolCall("memory_ingest_sessions", {}, t0, summary, error)
          }
        },
      }),

      memory_ingest_git: tool({
        description:
          "Re-scan git history for new commits since the session started. Useful after " +
          "a 'git pull' / 'git merge' / 'git rebase' where new commits arrived while this " +
          "session was running — the prefill scan only sees what existed at startup. " +
          "Idempotent: already-known commits are skipped (deduped by content hash), so " +
          "only the new ones get added. The plugin also auto-runs this in the background " +
          "when it detects HEAD moved as a side effect of a bash call; this tool is the " +
          "explicit-control version, e.g. after a fetch-only operation that did not move " +
          "HEAD but where you nonetheless know history advanced.",
        args: {},
        async execute() {
          const t0 = performance.now()
          const summary: Record<string, unknown> = {}
          let error: string | undefined
          try {
            // Refuse cleanly on non-git roots — `ingestGitHistory` already
            // handles this internally (returns zero counts), but a direct
            // upfront message is clearer for the agent than a silent zero.
            if (!(await isGitRepo(root))) {
              summary.skipped = "not-a-git-repo"
              return "not a git repository — nothing to ingest"
            }
            const git = await ingestGitHistory(
              repo,
              root,
              config.gitHistoryDepth,
              config.coChangeMaxCommits,
              config.coChangeMinOccurrences,
            )
            repo.applyEviction(config)
            await repo.forceFlush()
            // Refresh the cached HEAD so the next auto-trigger compares
            // against the value we just ingested at.
            try {
              const head = await currentHead(root)
              if (head !== null) lastKnownHead = head
            } catch {
              /* HEAD refresh is best-effort */
            }
            summary.scanned = git.scanned
            summary.commitMemories = git.commitMemories
            summary.coChangeMemories = git.coChangeMemories
            summary.churnMemories = git.churnMemories
            summary.recencyMemories = git.recencyMemories
            event("ingest.git.reingested", {
              trigger: "explicit-tool",
              scanned: git.scanned,
              commitMemories: git.commitMemories,
            })
            return (
              `re-ingested git history: scanned ${git.scanned} commits → ` +
              `${git.commitMemories} commit memories (new entries only — ` +
              `already-known commits skipped), ${git.coChangeMemories} co-change pairs, ` +
              `${git.churnMemories} churn flags, ${git.recencyMemories} recency markers.`
            )
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
            throw e
          } finally {
            recordToolCall("memory_ingest_git", {}, t0, summary, error)
          }
        },
      }),

      memory_mine_skills: tool({
        description:
          "Mine project memory for reusable skill files. Clusters memories by subject; " +
          "any cluster with at least 3 entries becomes a SKILL.md under .opencode/skills/. " +
          "The mined skills are usable IMMEDIATELY in this session — when mining finishes " +
          "a note lists them and you load any one into context with the memory_skill " +
          "tool, no restart required. (OpenCode also auto-loads them as native skills on " +
          "the next start.) RUN THIS when you assess the current task as " +
          "large/complex/multi-step. Runs in the background; this tool returns immediately.",
        args: {
          reason: tool.schema.string().optional().describe("Why mining was triggered (for logs)."),
        },
        async execute(args, toolCtx) {
          const t0 = performance.now()
          const summary: Record<string, unknown> = {}
          let error: string | undefined
          // The session to inject the "skills ready" note into when
          // mining finishes. Prefer the calling tool's session; fall
          // back to the plugin-init session id.
          const sessionId =
            (toolCtx as { sessionID?: string } | undefined)?.sessionID ??
            (ctx as unknown as { sessionID?: string }).sessionID
          try {
            const startedAt = Date.now()
            log("info", `mining started${args.reason ? ` (reason: ${args.reason})` : ""} — running in background`)
            // Fire-and-forget — the background work logs its own
            // mining.complete / mining.failed structured events. The
            // outer tool.call event records just the synchronous
            // "started" portion (which is what the agent sees).
            const miningStarted = performance.now()
            void (async () => {
              try {
                const res = await mineSkills(
                  repo,
                  root,
                  config.skillsOutputDir,
                  config.skillMiningMinCluster,
                  config.minedSkillPrefix,
                )
                await repo.forceFlush()
                const names =
                  res.writtenPaths.length > 0
                    ? res.writtenPaths
                        .map((p) => p.replace(root + "/", ""))
                        .join(", ")
                    : "(none)"
                log(
                  "info",
                  `mining done: ${res.skillsWritten} skill(s) written from ${res.clustersConsidered} candidate cluster(s). ` +
                    `Available now via the memory_skill tool — no restart needed. Files: ${names}`
                )
                // Make the freshly-mined skills usable in THIS session:
                // drop a note into the conversation so the agent knows
                // they exist and can load any of them with memory_skill.
                // OpenCode's own skill discovery only runs at startup,
                // so without this the skills would sit unused until the
                // next launch.
                if (res.skillsWritten > 0) {
                  const mined = await readMinedSkills(root, config.skillsOutputDir, config.minedSkillPrefix)
                  const justMined = mined.filter((s) =>
                    res.writtenPaths.some((p) => p.includes(`/${s.slug}/`))
                  )
                  const injected = await injectSessionNote(
                    sessionId,
                    `[diane] ${res.skillsWritten} skill(s) were just mined from project ` +
                      `memory and are available now — no restart needed:\n` +
                      justMined
                        .map((s) => `  • ${s.slug} — ${s.description}`)
                        .join("\n") +
                      `\nLoad any of them into context with the memory_skill tool ` +
                      `(e.g. memory_skill with name "${justMined[0]?.slug ?? ""}"), ` +
                      `or call memory_skill with no arguments to list them.`
                  )
                  if (!injected) {
                    log(
                      "info",
                      `(could not inject a live session note — call memory_skill to list/load the new skills)`
                    )
                  }
                }
                event("mining.complete", {
                  ms: Math.round(performance.now() - miningStarted),
                  skillsWritten: res.skillsWritten,
                  clustersConsidered: res.clustersConsidered,
                  writtenPaths: res.writtenPaths.map((p) => p.replace(root + "/", "")),
                  reason: args.reason ?? null,
                })
              } catch (err) {
                const m = err instanceof Error ? err.message : String(err)
                log("warn", `mining failed: ${m}`)
                event("mining.failed", {
                  ms: Math.round(performance.now() - miningStarted),
                  error: m,
                  reason: args.reason ?? null,
                })
              }
            })()
            summary.started = true
            summary.startedAt = startedAt
            summary.reason = args.reason ?? null
            return (
              `Skill mining started in background${args.reason ? ` (${args.reason})` : ""}. ` +
              `Started at ${new Date(startedAt).toISOString()}. ` +
              `When it finishes, the new skills are usable immediately in this ` +
              `session — no restart needed: a note will be posted listing them, ` +
              `and you can load any skill into context with the memory_skill tool.`
            )
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
            throw e
          } finally {
            recordToolCall("memory_mine_skills", args, t0, summary, error)
          }
        },
      }),

      memory_skill: tool({
        description:
          "List or load the skills mined by memory_mine_skills. OpenCode discovers " +
          "skills only at startup, so a skill mined during this session isn't a native " +
          "skill yet — this tool bridges that gap. Call with no arguments to LIST the " +
          "skill files currently on disk (including ones mined moments ago); call with " +
          "a `name` to LOAD that skill's instructions into the conversation so you can " +
          "act on them now, no restart. Use it right after memory_mine_skills reports " +
          "new skills.",
        args: {
          name: tool.schema
            .string()
            .optional()
            .describe(
              "Slug of the skill to load (as shown by a no-argument call). " +
                "Omit to list all available skills."
            ),
        },
        async execute(args, toolCtx) {
          const t0 = performance.now()
          const summary: Record<string, unknown> = {}
          let error: string | undefined
          const sessionId =
            (toolCtx as { sessionID?: string } | undefined)?.sessionID ??
            (ctx as unknown as { sessionID?: string }).sessionID
          try {
            // Always read fresh from disk — that's what makes a skill
            // mined mid-session visible here without a restart.
            const skills = await readMinedSkills(root, config.skillsOutputDir, config.minedSkillPrefix)

            // ── LIST mode ────────────────────────────────────────────
            if (!args.name || !args.name.trim()) {
              summary.mode = "list"
              summary.skillCount = skills.length
              if (skills.length === 0) {
                return (
                  "(no skills on disk yet — run memory_mine_skills to mine some " +
                  "from project memory, then call memory_skill again to load them)"
                )
              }
              const lines = skills.map(
                (s) =>
                  `• ${s.slug}${s.generatedByPlugin ? "" : " (external)"} — ${s.description}`
              )
              return (
                `${skills.length} skill(s) available — load one with memory_skill ` +
                `name="<slug>":\n${lines.join("\n")}`
              )
            }

            // ── LOAD mode ────────────────────────────────────────────
            summary.mode = "load"
            const wanted = args.name.trim()
            const skill = skills.find((s) => s.slug === wanted)
            if (!skill) {
              summary.found = false
              return (
                `(no skill "${wanted}" — available: ` +
                `${skills.map((s) => s.slug).join(", ") || "none"})`
              )
            }
            summary.found = true
            summary.slug = skill.slug

            // Inject the skill body into the session as a persistent
            // note. If there's no live session client (older OpenCode,
            // or a test harness), fall back to returning the body as
            // the tool result — the agent gets it either way.
            const note =
              `[diane] The following mined skill is now active for this ` +
              `session — "${skill.name}":\n\n${skill.body}`
            const injected = await injectSessionNote(sessionId, note)
            summary.injected = injected

            if (injected) {
              return (
                `Skill "${skill.slug}" loaded into the session context ` +
                `(${skill.body.length} chars). Its guidance is now active — ` +
                `you can act on it directly.`
              )
            }
            // Fallback path: return the content inline.
            return `Skill "${skill.slug}" — ${skill.description}\n\n${skill.body}`
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
            throw e
          } finally {
            recordToolCall("memory_skill", args, t0, summary, error)
          }
        },
      }),
  } as const
  type AllTools = typeof allTools

  // Default registration: only the three tools the eval showed the
  // agent calls. `exposeOpsTools: true` widens to everything above.
  const exposedTools: Partial<AllTools> = config.exposeOpsTools
    ? allTools
    : {
        memory_recall:   allTools.memory_recall,
        memory_outline:  allTools.memory_outline,
        memory_remember: allTools.memory_remember,
      }

  return {
    tool: exposedTools,

    // ── Live signal: LSP diagnostics → code-health memories ──────────
    // Fires whenever a language server re-analyses a file. We upsert
    // one memory per file so the store always reflects *current*
    // diagnostics. Extraction is defensive: an unrecognised payload
    // shape is a silent no-op, never an error out of the plugin.
    event: async ({ event }: { event: unknown }) => {
      try {
        const e = event as { type?: string; properties?: unknown } | undefined
        if (!e || e.type !== "lsp.client.diagnostics") return
        const res = ingestCodeHealth(repo, e)
        if (res.filesUpdated > 0 || res.filesCleared > 0) {
          repo.applyEviction(config)
          log(
            "debug",
            `code-health: ${res.filesUpdated} file(s) with diagnostics, ` +
              `${res.filesCleared} cleared`
          )
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        log("warn", `code-health event handler failed: ${m}`)
      }
    },

    // ── tool.execute hooks ───────────────────────────────────────────
    // Two jobs ride these hooks:
    //  (1) Code-map freshness — ALWAYS on. When the agent writes/edits
    //      a file, re-index that file so the code map never goes stale
    //      mid-session.
    //  (2) The recall-first nudge — opt-out via config.enableNudgeHook.
    //      If the agent racks up raw discovery calls without ever using
    //      a memory tool, append ONE reminder to a discovery result.
    //      Disable it when another plugin also post-processes tool
    //      output (e.g. oh-my-opencode) so two don't both mutate it.
    // Both are wrapped so they can never break, block, or corrupt a
    // real tool call.
    "tool.execute.before": async (
      input: { tool: string; callID?: string },
      output?: { args?: Record<string, unknown> }
    ) => {
      const name = input?.tool ?? ""
      // (1) Record which file a write/edit is about to change.
      try {
        if (FILE_WRITE_TOOLS.has(name)) {
          const fp = output?.args?.filePath
          if (typeof fp === "string" && fp.length > 0) {
            setBoundedPending(pendingEditPaths, input?.callID ?? "_", fp)
          }
        }
      } catch {
        /* bookkeeping must never break a tool call */
      }
      // (1b) Stash the bash command string so the after-hook can record
      //      it to the live-session memory. The OpenCode bash tool's
      //      arg key is `command`; we also check a couple of common
      //      alternatives (`cmd`, `script`) defensively — an
      //      unrecognised key means the bash recording is skipped for
      //      that call, never an error.
      try {
        if (name === "bash" && liveRecorder) {
          const a = output?.args ?? {}
          const cmd =
            (typeof a.command === "string" ? a.command : undefined) ??
            (typeof a.cmd === "string" ? a.cmd : undefined) ??
            (typeof a.script === "string" ? a.script : undefined)
          if (typeof cmd === "string" && cmd.length > 0) {
            setBoundedPending(pendingBashCommands, input?.callID ?? "_", cmd)
          }
        }
      } catch {
        /* bookkeeping must never break a tool call */
      }
      // (2) Nudge bookkeeping.
      if (config.enableNudgeHook) {
        try {
          if (MEMORY_TOOLS.has(name)) memoryToolUsed = true
          else if (DISCOVERY_TOOLS.has(name)) discoveryCallCount += 1
        } catch {
          /* never let bookkeeping break a tool call */
        }
      }
    },
    "tool.execute.after": async (
      input: { tool: string; callID?: string },
      output: { title: string; output: string; metadata: unknown }
    ) => {
      const name = input?.tool ?? ""
      // (1) The file is now written — re-index its code map. Awaited so
      //     the index is fresh before the agent's next tool call; once
      //     the tree-sitter engine is warm a one-file parse is cheap.
      try {
        const key = input?.callID ?? "_"
        const fp = pendingEditPaths.get(key)
        if (fp !== undefined) {
          pendingEditPaths.delete(key)
          await refreshCodeMapAfterEdit(fp)
          // (1a) Live session recording — feed the recorder the edit.
          //      Wrapped — a failed live recording is not worth
          //      interrupting the agent. Recorder.flush() upserts ONE
          //      memory under `live:${sessionId}`, idempotent on
          //      subject, so frequent flushing is cheap and safe.
          if (liveRecorder) {
            try {
              liveRecorder.recordFileEdit(fp, name)
              liveRecorder.flush()
            } catch {
              /* live-trace recording is best-effort */
            }
          }
        }
      } catch {
        /* a stale-index refresh must never break a tool call */
      }
      // (1b) Bash-specific post-processing: detect what files the shell
      //      command actually touched (via `git status --porcelain`),
      //      refresh the code-map for each up to the configured cap,
      //      and check whether HEAD moved (pull/merge/rebase/checkout)
      //      — if so, queue a background git re-ingest.
      if (name === "bash") {
        // Record the bash command itself into the live trace.
        try {
          const key = input?.callID ?? "_"
          const cmd = pendingBashCommands.get(key)
          pendingBashCommands.delete(key)
          if (cmd !== undefined && liveRecorder) {
            try {
              liveRecorder.recordBash(cmd)
              liveRecorder.flush()
            } catch {
              /* live-trace recording is best-effort */
            }
          }
        } catch {
          /* bash command extraction is best-effort */
        }
        // Refresh code-map for files the bash command modified.
        try {
          if (config.bashFileTrackingMaxFiles > 0 && config.enableCodeMap) {
            const changed = await changedFilesInWorktree(root)
            if (changed.length > 0) {
              const toRefresh = changed.slice(0, config.bashFileTrackingMaxFiles)
              const skipped = changed.length - toRefresh.length
              for (const f of toRefresh) {
                // refreshCodeMapAfterEdit is already defensively wrapped.
                await refreshCodeMapAfterEdit(f)
                if (liveRecorder) {
                  try { liveRecorder.recordFileEdit(f, "bash") }
                  catch { /* best-effort */ }
                }
              }
              if (liveRecorder) {
                try { liveRecorder.flush() } catch { /* best-effort */ }
              }
              if (skipped > 0) {
                log(
                  "debug",
                  `bash post-hook: ${toRefresh.length} file(s) re-indexed, ` +
                    `${skipped} skipped (over bashFileTrackingMaxFiles=${config.bashFileTrackingMaxFiles})`,
                )
              }
            }
          }
        } catch {
          /* bash post-hook scan is best-effort */
        }
        // Detect HEAD movement and queue git re-ingest if needed.
        try {
          await reingestGitIfHeadMoved()
        } catch {
          /* HEAD detection is best-effort */
        }
      }
      // (2) Nudge.
      if (config.enableNudgeHook) {
        try {
          if (nudgeShown || memoryToolUsed) return
          // Only append to free-text discovery output, and only once a
          // couple of discovery calls have gone by — a single read is
          // not worth nagging about. `read` is intentionally excluded
          // from NUDGEABLE_DISCOVERY so file contents stay pristine.
          if (!NUDGEABLE_DISCOVERY.has(name) || discoveryCallCount < 2) return
          if (!output || typeof output.output !== "string") return
          output.output +=
            "\n\n[diane] Several discovery calls so far, no project-memory check yet. " +
            "memory_recall (and memory_code_map) usually answer 'where is X' / 'what changed' " +
            "in one call for ~10x fewer tokens — worth trying before more raw read/grep."
          nudgeShown = true
        } catch {
          /* a nudge is never worth an exception */
        }
      }
    },
  }
}

/* ─── pre-fill orchestration ────────────────────────────────────────── */

async function prefillInBackground(
  repo: MemoryRepository,
  root: string,
  client: unknown,
  config: ResolvedConfig,
  log: (level: "debug" | "info" | "warn" | "error", msg: string) => void,
  event: (name: string, data?: Record<string, unknown>) => void,
  sessionId?: string
): Promise<void> {
  const prefillStarted = performance.now()
  event("prefill.start", { sessionId: sessionId ?? null })
  try {
    // Adaptive sizing first — measure the repo with one cheap signal
    // and tune the size-derived knobs (in place, so the tools' config
    // closure picks them up) before any ingester runs with them.
    const signal = await measureRepo(root, await isGitRepo(root))
    const { summary } = applyAdaptiveTuning(config, signal)
    log("info", `prefill: ${summary}`)
    event("adaptive.tuned", { signal, summary })

    const proj = await ingestProjectFacts(repo, root)
    log("info", `prefill: project-facts ingested ${proj.facts} entries`)
    event("ingest.project", { facts: proj.facts })

    // ── Three new ingest passes (added in v0.0.4) ──────────────────
    // All three are opt-out via config; default-on because (a) they
    // surface high-signal information for typical recalls and (b)
    // cost is bounded by file caps inside each ingester.
    if (config.ingestDocs) {
      try {
        const docs = await ingestDocs(repo, root, {
          maxFiles:        config.docsMaxFiles,
          bodyChars:       config.docsBodyChars,
          maxHeadingLevel: config.docsMaxHeadingLevel,
        })
        if (docs.filesWalked > 0) {
          log(
            "info",
            `prefill: docs ingested ${docs.headingsIndexed} headings across ${docs.filesWalked} files`,
          )
          event("ingest.docs", { ...docs })
        }
      } catch (err) {
        // Ingestion is best-effort — a broken docs/ tree must not
        // stall startup. Log and continue with whatever else works.
        log("warn", `docs ingest failed: ${err}`)
        event("ingest.docs.failed", { error: String(err) })
      }
    }
    if (config.ingestProjectNotes) {
      try {
        const notes = await ingestProjectNotes(repo, root, {
          maxBytes: config.notesMaxBytes,
        })
        if (notes.filesFound > 0) {
          log("info", `prefill: project-notes found ${notes.filesFound} agent-instruction files`)
          event("ingest.project-notes", { ...notes })
        }
      } catch (err) {
        log("warn", `project-notes ingest failed: ${err}`)
        event("ingest.project-notes.failed", { error: String(err) })
      }
    }
    if (config.ingestTableHeaders) {
      try {
        const tables = await ingestTableHeaders(repo, root, {
          maxFiles:  config.tablesMaxFiles,
          maxXlsxMB: config.tablesMaxXlsxMB,
          maxColumns: config.tablesMaxColumns,
        })
        if (tables.filesFound > 0) {
          log(
            "info",
            `prefill: table-headers indexed for ${tables.filesFound} files ` +
              `(formats: ${tables.formatsSupported.join(", ")})`,
          )
          event("ingest.tables", { ...tables })
        }
      } catch (err) {
        log("warn", `tables ingest failed: ${err}`)
        event("ingest.tables.failed", { error: String(err) })
      }
    }
    if (config.ingestCrossRefs) {
      try {
        const xref = await ingestCrossRefs(repo, root, {
          rarityThreshold: config.crossRefsRarityThreshold,
          maxFiles:        config.crossRefsMaxFiles,
          maxEdges:        config.crossRefsMaxEdges,
        })
        if (xref.edgesEmitted > 0) {
          log(
            "info",
            `prefill: cross-refs indexed ${xref.edgesEmitted} edges ` +
              `across ${xref.filesWalked} files ` +
              `(${xref.definitionsExtracted} definitions extracted)`,
          )
          event("ingest.cross-refs", { ...xref, byEvidence: xref.byEvidence })
        }
      } catch (err) {
        log("warn", `cross-refs ingest failed: ${err}`)
        event("ingest.cross-refs.failed", { error: String(err) })
      }
    }

    const git = await ingestGitHistory(
      repo,
      root,
      config.gitHistoryDepth,
      config.coChangeMaxCommits,
      config.coChangeMinOccurrences
    )
    const shapeSummary = Object.entries(git.shapeTagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([t, n]) => `${t}:${n}`)
      .join(", ")
    log(
      "info",
      `prefill: git scanned ${git.scanned} commits → ${git.commitMemories} commit memories, ` +
        `${git.coChangeMemories} co-change, ${git.churnMemories} churn, ` +
        `${git.recencyMemories} recency` +
        (shapeSummary ? ` [shapes: ${shapeSummary}]` : "")
    )
    event("ingest.git", {
      scanned: git.scanned,
      commitMemories: git.commitMemories,
      coChangeMemories: git.coChangeMemories,
      churnMemories: git.churnMemories,
      recencyMemories: git.recencyMemories,
      shapeTagCounts: git.shapeTagCounts,
    })

    if (config.ingestSessions) {
      const sess = await ingestSessions(repo, client)
      log(
        "info",
        `prefill: ingested ${sess.sessions} past session(s) — ` +
          `${sess.taskMemories} task + ${sess.traceMemories} trace memories`
      )
      event("ingest.sessions", {
        sessions: sess.sessions,
        taskMemories: sess.taskMemories,
        traceMemories: sess.traceMemories,
      })
    }

    if (config.enableCodeMap) {
      const cm = await ingestCodeMap(repo, root, undefined, config.codeMapMaxFiles)
      if (cm.unavailableReason) {
        log("warn", `prefill: code-map skipped — ${cm.unavailableReason}`)
        event("ingest.code-map.skipped", { reason: cm.unavailableReason })
      } else {
        log(
          "info",
          `prefill: code-map parsed ${cm.filesParsed} file(s) ` +
            `[${cm.languagesSeen.join(", ") || "none"}], ` +
            `${cm.signaturesExtracted} signatures`
        )
        event("ingest.code-map", {
          filesParsed: cm.filesParsed,
          languagesSeen: cm.languagesSeen,
          signaturesExtracted: cm.signaturesExtracted,
        })
      }
    }

    // Resume point: surface the most recent session snapshot so the
    // agent (and the human reading the log) knows there's accumulated
    // understanding one recall away. A parallel session reads the
    // same shared store, so it sees the same resume point.
    const snap = latestSnapshot(repo, sessionId)
    if (snap) {
      const total = snapshotSummary(repo).count
      log(
        "info",
        `prefill: resuming from session snapshot ${snap.id} ` +
          `(${total} snapshot${total === 1 ? "" : "s"} on record) — ` +
          `recall category 'session-snapshot' to load it`
      )
      event("snapshot.resume", { snapshotId: snap.id, totalSnapshots: total })
    }

    const ev = repo.applyEviction(config)
    if (ev.removed > 0) {
      log("info", `prefill: evicted ${ev.removed} entries to stay within disk budget`)
      event("eviction", {
        removed: ev.removed,
        bytesAfter: repo.totalBytes(),
        budgetBytes: config.maxMemoryBytes,
        trigger: "prefill",
      })
    }
    await repo.forceFlush()
    event("prefill.complete", {
      ms: Math.round(performance.now() - prefillStarted),
      storeSize: repo.size(),
      bytesTotal: repo.totalBytes(),
    })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    log("warn", `prefill failed: ${m}`)
    event("prefill.failed", {
      ms: Math.round(performance.now() - prefillStarted),
      error: m,
    })
  }
}

/* ─── small helpers ─────────────────────────────────────────────────── */

/**
 * Defensively coerce the untrusted `options` object OpenCode passes
 * from opencode.json into a typed UserConfig. Every field is checked
 * for the right primitive type; anything missing or wrong-typed is
 * dropped, so `resolveConfig` then fills the default. A malformed
 * config never throws — at worst the plugin runs on defaults.
 */
function coerceUserConfig(options: unknown): UserConfig {
  if (!options || typeof options !== "object") return {}
  const o = options as Record<string, unknown>
  const cfg: UserConfig = {}
  const num = (k: keyof UserConfig): void => {
    const v = o[k as string]
    if (typeof v === "number" && Number.isFinite(v)) {
      ;(cfg[k] as number) = v
    }
  }
  const bool = (k: keyof UserConfig): void => {
    const v = o[k as string]
    if (typeof v === "boolean") {
      ;(cfg[k] as boolean) = v
    }
  }
  const str = (k: keyof UserConfig): void => {
    const v = o[k as string]
    if (typeof v === "string" && v.length > 0) {
      ;(cfg[k] as string) = v
    }
  }
  num("maxMemoryDiskMB")
  bool("autoIngestOnStartup")
  num("gitHistoryDepth")
  bool("forceActive")
  str("skillsOutputDir")
  num("skillMiningMinCluster")
  bool("ingestSessions")
  bool("enableCodeMap")
  bool("installUsageSkill")
  bool("ingestDocs")
  bool("ingestProjectNotes")
  bool("ingestTableHeaders")
  bool("ingestCrossRefs")
  num("crossRefsRarityThreshold")
  num("crossRefsMaxFiles")
  num("crossRefsMaxEdges")
  num("docsMaxFiles")
  num("docsBodyChars")
  num("docsMaxHeadingLevel")
  num("tablesMaxFiles")
  num("tablesMaxXlsxMB")
  num("tablesMaxColumns")
  num("notesMaxBytes")
  num("coChangeMinOccurrences")
  num("codeMapMaxFiles")
  num("coChangeMaxCommits")
  bool("enableNudgeHook")
  bool("exposeOpsTools")
  bool("adaptive")
  bool("enableSemanticSearch")
  str("embeddingModel")
  bool("personalizedPageRank")
  bool("recordSessionActivity")
  num("bashFileTrackingMaxFiles")
  bool("autoReingestGitOnHeadChange")
  return cfg
}

function resolveConfig(user: UserConfig): ResolvedConfig {
  // Which keys the user actually set — adaptive tuning consults this
  // so it never overrides a deliberate choice.
  const explicitKeys = new Set<keyof UserConfig>(
    (Object.keys(user) as Array<keyof UserConfig>).filter((k) => user[k] !== undefined)
  )
  return {
    maxMemoryBytes: Math.max(1, user.maxMemoryDiskMB ?? 50) * 1024 * 1024,
    autoIngestOnStartup: user.autoIngestOnStartup ?? true,
    gitHistoryDepth: Math.max(10, user.gitHistoryDepth ?? 500),
    forceActive: user.forceActive ?? false,
    skillsOutputDir: user.skillsOutputDir ?? ".opencode/skills",
    minedSkillPrefix: "",
    skillMiningMinCluster: Math.max(2, user.skillMiningMinCluster ?? 3),
    ingestSessions: user.ingestSessions ?? true,
    enableCodeMap: user.enableCodeMap ?? true,
    installUsageSkill: user.installUsageSkill ?? true,
    ingestDocs: user.ingestDocs ?? false,
    ingestProjectNotes: user.ingestProjectNotes ?? false,
    ingestTableHeaders: user.ingestTableHeaders ?? false,
    ingestCrossRefs: user.ingestCrossRefs ?? false,
    crossRefsRarityThreshold: Math.max(1, Math.round(user.crossRefsRarityThreshold ?? 3)),
    crossRefsMaxFiles:        Math.max(1, Math.round(user.crossRefsMaxFiles ?? 2000)),
    crossRefsMaxEdges:        Math.max(1, Math.round(user.crossRefsMaxEdges ?? 10_000)),
    docsMaxFiles:             Math.max(1, Math.round(user.docsMaxFiles ?? 200)),
    docsBodyChars:            Math.max(40, Math.round(user.docsBodyChars ?? 240)),
    docsMaxHeadingLevel:      Math.min(6, Math.max(1, Math.round(user.docsMaxHeadingLevel ?? 3))),
    tablesMaxFiles:           Math.max(1, Math.round(user.tablesMaxFiles ?? 200)),
    tablesMaxXlsxMB:          Math.max(0, user.tablesMaxXlsxMB ?? 50),
    tablesMaxColumns:         Math.max(1, Math.round(user.tablesMaxColumns ?? 40)),
    notesMaxBytes:            Math.max(256, Math.round(user.notesMaxBytes ?? 6144)),
    coChangeMinOccurrences:   Math.max(1, Math.round(user.coChangeMinOccurrences ?? 3)),
    enableNudgeHook: user.enableNudgeHook ?? true,
    exposeOpsTools: user.exposeOpsTools ?? false,
    adaptive: user.adaptive ?? true,
    enableSemanticSearch: user.enableSemanticSearch ?? false,
    embeddingModel: user.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
    personalizedPageRank: user.personalizedPageRank ?? false,
    recordSessionActivity: user.recordSessionActivity ?? true,
    bashFileTrackingMaxFiles: Math.max(0, Math.round(user.bashFileTrackingMaxFiles ?? 20)),
    autoReingestGitOnHeadChange: user.autoReingestGitOnHeadChange ?? true,
    explicitKeys,
    // Size-derived knobs — these are the fixed (medium-tier) defaults;
    // applyAdaptiveTuning overwrites them from the measured repo
    // signal when `adaptive` is true.
    codeMapMaxFiles: Math.max(1, Math.round(user.codeMapMaxFiles ?? 4000)),
    coChangeMaxCommits: Math.max(1, Math.round(user.coChangeMaxCommits ?? 5000)),
  }
}

function pickRoot(directory: string | undefined, worktree: string | undefined): string {
  if (directory && directory !== "/") return directory
  if (worktree && worktree !== "/") return worktree
  return directory || worktree || process.cwd()
}

/**
 * A directory is "workable" if it's a git repo OR contains at least
 * one recognised project/build/CI file. Language-neutral — the list
 * spans every ecosystem we know a manifest filename for, plus a `.git`
 * check. Truly empty or unrecognised directories get the idle path.
 */
async function detectWorkableRepo(root: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises")
  // git repo?
  try {
    const s = await stat(`${root}/.git`)
    if (s.isDirectory() || s.isFile()) return true // .git dir, or worktree .git file
  } catch {
    // not a git repo — fall through to manifest check
  }
  // any recognised project/build/CI file?
  for (const f of [
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "setup.py",
    "requirements.txt",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Gemfile",
    "composer.json",
    "mix.exs",
    "Package.swift",
    "pubspec.yaml",
    "CMakeLists.txt",
    "Makefile",
    "makefile",
    "meson.build",
    "build.zig",
    "build.sbt",
    "project.clj",
    "deno.json",
    "flake.nix",
    "Dockerfile",
    ".gitlab-ci.yml",
  ]) {
    try {
      await stat(`${root}/${f}`)
      return true
    } catch {
      // try next
    }
  }
  return false
}

function isCategory(s: string | undefined): s is Category {
  return (
    s === "git-history" ||
    s === "project-facts" ||
    s === "code-health" ||
    s === "code-map" ||
    s === "session-trace" ||
    s === "session-snapshot" ||
    s === "agent-note" ||
    s === "skill-mined" ||
    s === "custom"
  )
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}
