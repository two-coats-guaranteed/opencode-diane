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
 * No embeddings, no LLM, no convention assumptions.
 *
 * Tools exposed to the agent:
 *   memory_recall          — hierarchical search over the store
 *   memory_remember        — add an explicit note
 *   memory_outline         — table of contents (counts per category)
 *   memory_status          — store size, hit stats
 *   memory_ingest_sessions — pull facts from past OpenCode sessions
 *   memory_mine_skills     — turn clusters into .opencode/skills/<x>/SKILL.md (background)
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

import { MemoryRepository } from "./store/repository.js"
import { ingestGitHistory } from "./ingest/git.js"
import { ingestProjectFacts } from "./ingest/project.js"
import { ingestSessions } from "./ingest/sessions.js"
import { ingestCodeHealth } from "./ingest/code-health.js"
import { ingestCodeMap, ingestCodeMapForFile } from "./ingest/code-map.js"
import { writeSnapshot, latestSnapshot, snapshotSummary } from "./ingest/session-snapshot.js"
import { measureRepo, applyAdaptiveTuning } from "./ingest/adaptive.js"
import { createE5Embedder } from "./search/e5-embedder.js"
import { DEFAULT_EMBEDDING_MODEL, type Embedder } from "./search/embedder.js"
import { VectorStore } from "./store/vector-store.js"
import { embedMissingMemories } from "./search/embed-pass.js"
import { isGitRepo } from "./utils/shell.js"
import { isAbsolute, join } from "node:path"
import { createFileLogger, truncateForLog } from "./utils/file-log.js"
import { mineSkills, readMinedSkills } from "./mining/skill-miner.js"
import type { Category, ResolvedConfig, UserConfig } from "./types.js"

const SERVICE = "opencode-diane"

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
  const repo = await MemoryRepository.load(root)

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
  // actually on disk in its new form).
  const pendingEditPaths = new Map<string, string>()

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
  event("plugin.active", {
    storeSize: repo.size(),
    bytesTotal: repo.totalBytes(),
    budgetBytes: config.maxMemoryBytes,
    autoIngestOnStartup: config.autoIngestOnStartup,
    enableCodeMap: config.enableCodeMap,
    ingestSessions: config.ingestSessions,
    enableSemanticSearch: config.enableSemanticSearch,
  })

  // ── 4. Tools ───────────────────────────────────────────────────────
  return {
    tool: {
      memory_recall: tool({
        description:
          "ALWAYS call this FIRST when a task touches existing code — before any " +
          "read/grep/glob/bash discovery. A single recall typically replaces 3-8 " +
          "discovery calls and costs ~10x fewer tokens: on a real repo, a recall pair " +
          "answered a 'work on feature X' task in ~700 tokens versus ~5,400 tokens of raw " +
          "git-log/cat/grep. Skipping it and going straight to read/grep is the slow, " +
          "expensive path. The store holds compact facts mined from git history (commit " +
          "diff-shapes, file co-change, churn, recency), project files (manifests/build/CI " +
          "summarised by format), live code-health diagnostics, the code map (file " +
          "signatures), past OpenCode sessions, and notes saved earlier. Results are " +
          "co-change-boosted — a hit about file X also surfaces files X is historically " +
          "modified with, so you find related context a grep would miss. Output is capped " +
          "at `tokenBudget` (default 1200) so the cost is predictable. Workflow: recall " +
          "first, act on what comes back, and only fall to raw discovery for the specific " +
          "gaps recall didn't cover. Pass `category` to narrow to git-history, " +
          "project-facts, code-health, code-map, session-trace, session-snapshot, " +
          "agent-note, or " +
          "skill-mined; pass `subject` to narrow to a file path or task name. " +
          "Pass `prefer` to make ranking match intent: 'tests' when the user asks " +
          "about tests/test coverage, 'code' when they want the implementation " +
          "(gently down-ranks test files), 'history' for change history. Omit it for " +
          "general queries — it is a mild lean, never a filter.",
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
            const lines = hits.map(formatHit)
            if (omitted > 0) {
              lines.push(
                `… (+${omitted} more hit${omitted === 1 ? "" : "s"} omitted to fit the ` +
                  `~${args.tokenBudget ?? 1200}-token budget — raise tokenBudget or narrow the query)`
              )
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
          "Save a note into project memory so a FUTURE turn can recall it instead of " +
          "rediscovering it. Use this whenever you learn something non-obvious that cost " +
          "you tool calls to find — a tricky file path, a non-obvious coupling, a decision " +
          "the user just made, a regression to watch for. Treat it as the write-side of " +
          "the recall-first workflow: what you remember now is what you (or the next " +
          "session) won't have to grep for later. Use sparingly — only durable facts, " +
          "never transient state. The note becomes searchable via memory_recall.",
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
          "Call this ONCE at the start of a session on an unfamiliar repo — it is the " +
          "cheapest possible orientation (a few tokens) and tells you what the memory " +
          "store already knows: how many entries per category. Use it to decide what to " +
          "memory_recall next instead of guessing. If categories like git-history or " +
          "code-map have entries, that knowledge is one recall away — don't rediscover it " +
          "with raw tools.",
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
          "ingestion is enabled (config.enableCodeMap, off by default because it carries a " +
          "heavier dependency); if it is empty, fall back to memory_recall + targeted reads.",
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
                "(code map is empty — enable it with config.enableCodeMap, then restart " +
                "OpenCode so the plugin can parse the tree)"
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
              `count: ${repo.size()}`,
              `bytes: ${humanBytes(repo.totalBytes())} / ${humanBytes(config.maxMemoryBytes)}`,
            ]
            const ingestedAt: Record<string, number | null> = {}
            for (const cat of ["git-history", "project-facts", "session-trace"] as Category[]) {
              const ts = repo.getIngestedAt(cat)
              ingestedAt[cat] = ts ?? null
              lines.push(`${cat}: ${ts ? new Date(ts).toISOString() : "(never ingested)"}`)
            }
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
                  config.skillMiningMinCluster
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
                  const mined = await readMinedSkills(root, config.skillsOutputDir)
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
            const skills = await readMinedSkills(root, config.skillsOutputDir)

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
    },

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
            pendingEditPaths.set(input?.callID ?? "_", fp)
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
        }
      } catch {
        /* a stale-index refresh must never break a tool call */
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

    const git = await ingestGitHistory(
      repo,
      root,
      config.gitHistoryDepth,
      config.coChangeMaxCommits
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
  bool("enableNudgeHook")
  bool("adaptive")
  bool("enableSemanticSearch")
  str("embeddingModel")
  bool("personalizedPageRank")
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
    skillMiningMinCluster: Math.max(2, user.skillMiningMinCluster ?? 3),
    ingestSessions: user.ingestSessions ?? true,
    enableCodeMap: user.enableCodeMap ?? false,
    enableNudgeHook: user.enableNudgeHook ?? true,
    adaptive: user.adaptive ?? true,
    enableSemanticSearch: user.enableSemanticSearch ?? false,
    embeddingModel: user.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
    personalizedPageRank: user.personalizedPageRank ?? false,
    explicitKeys,
    // Size-derived knobs — these are the fixed (medium-tier) defaults;
    // applyAdaptiveTuning overwrites them from the measured repo
    // signal when `adaptive` is true.
    codeMapMaxFiles: 4000,
    coChangeMaxCommits: 5000,
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
