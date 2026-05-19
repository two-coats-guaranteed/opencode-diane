/**
 * Repository — the single source of truth for memory CRUD at runtime.
 *
 * Holds the in-memory working set, the inverted index, and a debounced
 * write-behind layer over a SQLite store. All public operations keep
 * the index in sync; the index is never accessed directly from
 * outside. The public API is identical to the JSON-era repository —
 * the storage swap is entirely behind this class.
 *
 * Storage model:
 *
 *   - SQLite (`bun:sqlite`, see sqlite-store.ts) is the durable
 *     backing. It is written incrementally — only changed rows, in one
 *     transaction per flush — replacing the JSON store's whole-file
 *     rewrite. It is read exactly once, at `load()`.
 *
 *   - `byId` is an in-memory cache that fully mirrors the store. It
 *     stays a full mirror because the inverted index needs every doc
 *     in memory anyway (IDF, avgdl, the co-change graph), so caching
 *     the Memory objects alongside costs little and keeps every read
 *     O(1) — recall never touches SQLite.
 *
 *   - Writes are write-behind: `insert` / `upsertBySubject` /
 *     `removeMemory` / useCount bumps mutate the cache + index
 *     immediately and record the changed id in a pending buffer
 *     (`pendingDirty` / `pendingDeleted`). The debounced `flush`
 *     drains that buffer into SQLite in a single transaction. This
 *     batching is what makes SQLite a win rather than a wash — per-row
 *     transactions during ingestion would be slower than the JSON
 *     file; one transaction per debounce is far faster.
 *
 * Performance notes:
 *
 *   - The cache is a `Map<id, Memory>` — insert / delete / lookup are
 *     all O(1). `removeMemory` and `applyEviction` work off the cache.
 *
 *   - `insertIfMissing` consults `dedupKeys`, an in-memory Set of
 *     compact composite keys, for O(1) idempotency. (SQLite is not
 *     consulted: a not-yet-flushed insert is in the buffer, not the
 *     DB, so the in-memory view is the authoritative one.)
 *
 *   - `totalBytes` is a running counter; `countsByCategory` reads the
 *     inverted index's `byCategory` map — both O(1) / O(categories).
 *
 *   - BM25 search is O(query terms × candidates); eviction sorts once
 *     per *batch*.
 */

import type { Memory, RecallHit, Category, ResolvedConfig } from "../types.js"
import { InvertedIndex } from "../search/inverted-index.js"
import { search, packToTokenBudget, type SearchOptions } from "../search/bm25.js"
import { reciprocalRankFusion } from "../search/embedder.js"
import { evictIfOverBudget } from "./eviction.js"
import { SqliteStore, type LoadedStore } from "./sqlite-store.js"
import type { VectorStore } from "./vector-store.js"

const PERSIST_DEBOUNCE_MS = 400
const STORE_OVERHEAD_BYTES = 64

let idCounter = 0

function newId(): string {
  // Random-ish + counter — collision-free within a process.
  idCounter += 1
  return `mem_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

/**
 * Fast, allocation-light string hash (djb2). Keeps dedup keys compact
 * even when `content` is long.
 */
function hash32(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/** Composite key used for O(1) idempotent-insert checks. */
function dedupKey(category: string, subject: string, content: string): string {
  return `${category}\u0000${subject}\u0000${hash32(content)}`
}

export class MemoryRepository {
  /** In-memory cache — a full mirror of the SQLite store, insertion-ordered. */
  private byId = new Map<string, Memory>()
  /** Store metadata (ingest timestamps, last eviction). */
  private meta: LoadedStore["meta"]
  private index = new InvertedIndex()
  private root: string
  private sqlite: SqliteStore
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  /** O(1) idempotency: composite key → memory id (in-memory, mirrors the cache). */
  private dedupKeys = new Map<string, string>()
  /** Running sum of `sizeBytes` over all memories (+ fixed overhead). */
  private bytesTotal = STORE_OVERHEAD_BYTES

  // ── write-behind buffer ───────────────────────────────────────────
  /** Ids changed (inserted/updated) since the last flush. */
  private pendingDirty = new Set<string>()
  /** Ids deleted since the last flush. */
  private pendingDeleted = new Set<string>()
  /** Whether `meta` changed since the last flush. */
  private metaDirty = false

  /**
   * Optional semantic-search index. Attached by the plugin only when
   * `enableSemanticSearch` is on; `undefined` otherwise, in which case
   * every recall takes the unchanged pure-lexical path.
   */
  private vectorStore?: VectorStore

  private constructor(root: string, sqlite: SqliteStore, loaded: LoadedStore) {
    this.root = root
    this.sqlite = sqlite
    this.meta = loaded.meta
    for (const m of loaded.memories) {
      this.byId.set(m.id, m)
      this.dedupKeys.set(dedupKey(m.category, m.subject, m.content), m.id)
      this.bytesTotal += m.sizeBytes
    }
    this.index.rebuildFromAll(loaded.memories)
  }

  /**
   * Open the store for a project root and build the repository.
   * Stays async to preserve the historical API even though
   * `bun:sqlite` is synchronous — callers `await` this.
   */
  static async load(root: string): Promise<MemoryRepository> {
    const { store, loaded } = SqliteStore.open(root)
    return new MemoryRepository(root, store, loaded)
  }

  /** Total number of stored memories. O(1). */
  size(): number {
    return this.byId.size
  }

  /** Total disk-bytes estimate — O(1), maintained incrementally. */
  totalBytes(): number {
    return this.bytesTotal
  }

  /** Per-category counts — O(categories), read straight from the index. */
  countsByCategory(): Map<Category, number> {
    const m = new Map<Category, number>()
    for (const [cat, ids] of this.index.byCategory) {
      if (ids.size > 0) m.set(cat, ids.size)
    }
    return m
  }

  insert(opts: {
    category: Category
    subject: string
    content: string
    tags?: string[]
    source: string
    pinned?: boolean
  }): Memory {
    const now = Date.now()
    const sizeBytes = Buffer.byteLength(
      opts.content + opts.subject + (opts.tags ?? []).join(","),
      "utf-8"
    )
    const mem: Memory = {
      id: newId(),
      category: opts.category,
      subject: opts.subject,
      content: opts.content,
      tags: opts.tags ?? [],
      source: opts.source,
      createdAt: now,
      usedAt: now,
      useCount: 0,
      sizeBytes,
      pinned: opts.pinned,
    }
    this.byId.set(mem.id, mem)
    this.dedupKeys.set(dedupKey(mem.category, mem.subject, mem.content), mem.id)
    this.bytesTotal += sizeBytes
    this.index.add(mem)
    this.markDirty(mem.id)
    return mem
  }

  /** Insert many in one shot; faster than insert-loop on large batches. */
  insertMany(
    items: Array<{
      category: Category
      subject: string
      content: string
      tags?: string[]
      source: string
      pinned?: boolean
    }>
  ): Memory[] {
    const result: Memory[] = []
    for (const item of items) result.push(this.insert(item))
    return result
  }

  /**
   * Insert one memory only if the (category, subject, content) tuple
   * doesn't already exist. Returns the existing entry if so. This is
   * how ingestion stays idempotent across plugin restarts.
   *
   * O(1) via the in-memory `dedupKeys` index. SQLite is intentionally
   * not consulted — a not-yet-flushed insert lives in the write-behind
   * buffer, so the in-memory view is the authoritative one.
   */
  insertIfMissing(opts: {
    category: Category
    subject: string
    content: string
    tags?: string[]
    source: string
    pinned?: boolean
  }): Memory {
    const key = dedupKey(opts.category, opts.subject, opts.content)
    const existingId = this.dedupKeys.get(key)
    if (existingId !== undefined) {
      const existing = this.byId.get(existingId)
      if (existing) return existing
      // dedup index pointed at a since-removed entry — fall through.
    }
    return this.insert(opts)
  }

  /**
   * Insert a memory, first removing any existing memories that share
   * its (category, subject). For "live" single-valued facts — a
   * file's current LSP diagnostics, a file's current signature map —
   * re-reporting must REPLACE prior state, not accumulate stale
   * copies.
   *
   * O(memories sharing that subject) via the inverted index.
   */
  upsertBySubject(opts: {
    category: Category
    subject: string
    content: string
    tags?: string[]
    source: string
    pinned?: boolean
  }): Memory {
    const ids = this.index.bySubject.get(opts.subject)
    if (ids) {
      for (const id of [...ids]) {
        const mem = this.byId.get(id)
        if (mem && mem.category === opts.category) this.removeMemory(mem)
      }
    }
    return this.insert(opts)
  }

  /** Remove a single memory, keeping every index + counter + buffer consistent. O(1). */
  private removeMemory(mem: Memory): void {
    this.byId.delete(mem.id)
    this.dedupKeys.delete(dedupKey(mem.category, mem.subject, mem.content))
    this.bytesTotal -= mem.sizeBytes
    this.index.remove(mem)
    this.markDeleted(mem.id)
  }

  /**
   * Attach a semantic vector index. Once attached, a recall that
   * carries a `queryVector` fuses vector similarity with the lexical
   * ranking; a recall without one, or before this is called, is
   * unaffected. Idempotent.
   */
  attachVectorStore(vs: VectorStore): void {
    this.vectorStore = vs
  }

  /**
   * Rank candidates for a recall.
   *
   * With no vector store attached, or no `queryVector` supplied, this
   * is exactly the historical lexical path — `search()` and nothing
   * else. That keeps the default (semantic-search-off) configuration
   * byte-for-byte unchanged.
   *
   * With both present, it fuses two rankings via reciprocal-rank
   * fusion: the BM25 lexical ranking and a vector-similarity ranking.
   * A larger candidate pool is drawn from each side so a hit that is
   * strong in only one ranking can still surface, then the fused list
   * is trimmed back to `limit`. Vector candidates are filtered to the
   * same category/subject scope as the lexical query.
   */
  private rankCandidates(opts: SearchOptions): RecallHit[] {
    if (!this.vectorStore || !opts.queryVector) {
      return search(this.index, this.byId, opts)
    }
    const limit = opts.limit ?? 25
    const pool = Math.max(limit, 50)
    const lexical = search(this.index, this.byId, { ...opts, limit: pool })
    const vector = this.vectorStore.search(opts.queryVector, pool).filter((r) => {
      const m = this.byId.get(r.id)
      if (!m) return false
      if (opts.category && m.category !== opts.category) return false
      if (opts.subject && m.subject !== opts.subject) return false
      return true
    })
    const fused = reciprocalRankFusion([
      lexical.map((h) => h.memory.id),
      vector.map((v) => v.id),
    ])
    const hits: RecallHit[] = []
    for (const f of fused) {
      const m = this.byId.get(f.id)
      if (m) hits.push({ memory: m, score: f.score })
      if (hits.length >= limit) break
    }
    return hits
  }

  /**
   * Budget-aware recall. `search()` ranks (and count-limits via
   * `opts.limit`); if `opts.tokenBudget` is set *and* a `format`
   * function is supplied, the ranked hits are then packed to that
   * token ceiling. `useCount`/`usedAt` are bumped only for the hits
   * actually KEPT.
   */
  recallDetailed(
    opts: SearchOptions,
    format?: (h: RecallHit) => string
  ): { hits: RecallHit[]; omitted: number } {
    const ranked = this.rankCandidates(opts)
    let kept = ranked
    let omitted = 0
    if (opts.tokenBudget && opts.tokenBudget > 0 && format) {
      const packed = packToTokenBudget(ranked, opts.tokenBudget, format)
      kept = packed.kept
      omitted = packed.omitted
    }
    const now = Date.now()
    for (const h of kept) {
      // packToTokenBudget may hand back a shallow clone with trimmed
      // content — always bump the REAL stored memory by id.
      const real = this.byId.get(h.memory.id)
      if (real) {
        real.useCount += 1
        real.usedAt = now
        this.markDirty(real.id)
      }
    }
    return { hits: kept, omitted }
  }

  /** Count-limited recall (no token budgeting). Stable convenience API. */
  recall(opts: SearchOptions): RecallHit[] {
    return this.recallDetailed(opts).hits
  }

  /**
   * All memories, insertion-ordered. Materialised from the cache on
   * each call — O(n), but only the infrequent readers (outline,
   * mining, snapshot scan) use it; the frequent mutating paths stay
   * O(1).
   */
  allMemories(): readonly Memory[] {
    return [...this.byId.values()]
  }

  setIngestedAt(category: Category, ts: number): void {
    this.meta.ingestedAt[category] = ts
    this.markMetaDirty()
  }

  getIngestedAt(category: Category): number | undefined {
    return this.meta.ingestedAt[category]
  }

  applyEviction(config: ResolvedConfig): { removed: number } {
    const removed = evictIfOverBudget(
      [...this.byId.values()],
      config.maxMemoryBytes,
      this.bytesTotal
    )
    if (removed.length === 0) return { removed: 0 }
    for (const mem of removed) {
      this.byId.delete(mem.id)
      this.dedupKeys.delete(dedupKey(mem.category, mem.subject, mem.content))
      this.bytesTotal -= mem.sizeBytes
      this.index.remove(mem)
      this.markDeleted(mem.id)
    }
    this.meta.lastEvictionAt = Date.now()
    this.markMetaDirty()
    return { removed: removed.length }
  }

  // ── write-behind buffer bookkeeping ───────────────────────────────

  /** Record `id` as changed; schedule a flush. */
  private markDirty(id: string): void {
    this.pendingDirty.add(id)
    this.pendingDeleted.delete(id)
    this.scheduleFlush()
  }

  /** Record `id` as deleted; schedule a flush. */
  private markDeleted(id: string): void {
    this.pendingDeleted.add(id)
    this.pendingDirty.delete(id)
    this.scheduleFlush()
  }

  /** Record that `meta` changed; schedule a flush. */
  private markMetaDirty(): void {
    this.metaDirty = true
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      // The debounced flush runs detached — a write failure (project
      // dir removed mid-session, disk full, permissions) must not
      // surface as an unhandled rejection that takes down the host.
      // The pending buffers are only cleared on success, so a failed
      // flush is retried on the next mutation.
      void this.flush().catch(() => {
        /* buffers retained → retried on next mutation */
      })
    }, PERSIST_DEBOUNCE_MS)
  }

  /**
   * Drain the write-behind buffer into SQLite in one transaction.
   * Stays async to preserve the historical API; the work itself is
   * synchronous (`bun:sqlite`). The pending sets are cleared only
   * after the transaction succeeds — if it throws, they are retained
   * and retried.
   */
  async flush(): Promise<void> {
    if (this.pendingDirty.size === 0 && this.pendingDeleted.size === 0 && !this.metaDirty) {
      return
    }
    const dirty: Memory[] = []
    for (const id of this.pendingDirty) {
      const mem = this.byId.get(id)
      if (mem) dirty.push(mem)
    }
    const deleted = [...this.pendingDeleted]

    // If this throws, the sets below are NOT cleared — the next
    // mutation reschedules and retries.
    this.sqlite.flush(dirty, deleted, this.meta)

    this.pendingDirty.clear()
    this.pendingDeleted.clear()
    this.metaDirty = false
  }

  /** Flush synchronously now — used by tools and tests. */
  async forceFlush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  /**
   * Flush and close the underlying database handle. Not part of the
   * historical API, but tests create many short-lived repositories and
   * should release their handles; in the plugin's own lifecycle the
   * repository lives for the whole session and the OS reclaims the
   * handle at process exit.
   */
  async close(): Promise<void> {
    await this.forceFlush()
    this.sqlite.close()
  }
}
