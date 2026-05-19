/**
 * vector-store.ts — persistence and search for memory embeddings.
 *
 * This is a SELF-CONTAINED, OPT-IN component. It is constructed only
 * when `enableSemanticSearch` is on, and it uses its OWN database file
 * (`.opencode/diane-vectors.db`) — the primary store, its schema, and
 * its migration path are never touched. When the feature is off this
 * file is never imported and the file never created, so the default
 * configuration carries zero cost from semantic search.
 *
 * The cache is keyed to a model id. If the configured embedding model
 * changes, the stored vectors are from a different space and are
 * dropped wholesale on open — a stale vector is worse than none.
 *
 * Vectors are L2-normalised on the way in, so similarity search is a
 * plain dot product.
 */

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

import { dot, normalize, type FusedItem } from "../search/embedder.js"

const DB_REL = ".opencode/diane-vectors.db"

/** Absolute path of the vector database for a project root. */
export function vectorDbPath(root: string): string {
  return join(root, DB_REL)
}

export class VectorStore {
  private db: Database
  /** In-memory mirror — every stored vector, for brute-force search. */
  private mem = new Map<string, Float32Array>()
  /** Vector dimension, learned from the first vector stored. 0 until then. */
  private dim = 0
  readonly modelId: string

  private constructor(db: Database, modelId: string) {
    this.db = db
    this.modelId = modelId
  }

  /**
   * Open (or create) the vector store for a project root, bound to a
   * model id. If a different model produced the existing vectors, they
   * are discarded — vectors from two models are not comparable.
   */
  static open(root: string, modelId: string): VectorStore {
    const path = vectorDbPath(root)
    mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path, { create: true })
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA synchronous = NORMAL")
    db.exec("CREATE TABLE IF NOT EXISTS vectors (memory_id TEXT PRIMARY KEY, vec BLOB NOT NULL)")
    db.exec("CREATE TABLE IF NOT EXISTS vmeta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

    const storedModel = (
      db.query("SELECT value FROM vmeta WHERE key = 'model'").get() as { value: string } | null
    )?.value
    if (storedModel && storedModel !== modelId) {
      // Model changed — the cached vectors live in a different space.
      db.exec("DELETE FROM vectors")
    }
    db.query("INSERT OR REPLACE INTO vmeta (key, value) VALUES ('model', ?)").run(modelId)

    const store = new VectorStore(db, modelId)
    store.loadAll()
    return store
  }

  /** Load every persisted vector into the in-memory mirror. */
  private loadAll(): void {
    const rows = this.db.query("SELECT memory_id, vec FROM vectors").all() as Array<{
      memory_id: string
      vec: Uint8Array
    }>
    for (const row of rows) {
      const f32 = bytesToFloat32(row.vec)
      if (this.dim === 0) this.dim = f32.length
      if (f32.length === this.dim) this.mem.set(row.memory_id, f32)
    }
  }

  /** Number of vectors held. */
  size(): number {
    return this.mem.size
  }

  /** Whether a memory id already has a stored vector. */
  has(id: string): boolean {
    return this.mem.has(id)
  }

  /** The memory ids in `ids` that do NOT yet have a vector — the embedding to-do list. */
  missing(ids: Iterable<string>): string[] {
    const out: string[] = []
    for (const id of ids) if (!this.mem.has(id)) out.push(id)
    return out
  }

  /**
   * Store a batch of (id, vector) pairs — normalised, mirrored in
   * memory, and persisted in one transaction. A vector whose length
   * disagrees with the established dimension is skipped (it cannot
   * have come from the same model) rather than corrupting search.
   */
  putMany(entries: Array<{ id: string; vec: Float32Array }>): void {
    const insert = this.db.query("INSERT OR REPLACE INTO vectors (memory_id, vec) VALUES (?, ?)")
    const tx = this.db.transaction((batch: Array<{ id: string; vec: Float32Array }>) => {
      for (const { id, vec } of batch) {
        if (this.dim === 0) this.dim = vec.length
        if (vec.length !== this.dim) continue
        const n = normalize(vec)
        this.mem.set(id, n)
        insert.run(id, float32ToBytes(n))
      }
    })
    tx(entries)
  }

  /**
   * Drop vectors whose id is not in `validIds` — used to clear out
   * memories that were evicted or replaced. Returns the count removed.
   */
  prune(validIds: Set<string>): number {
    const stale: string[] = []
    for (const id of this.mem.keys()) if (!validIds.has(id)) stale.push(id)
    if (stale.length === 0) return 0
    const del = this.db.query("DELETE FROM vectors WHERE memory_id = ?")
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        del.run(id)
        this.mem.delete(id)
      }
    })
    tx(stale)
    return stale.length
  }

  /**
   * Top-`k` memory ids by cosine similarity to `queryVec` (vectors are
   * normalised, so this is a dot product), highest first. A
   * dimension mismatch yields an empty result rather than a throw.
   */
  search(queryVec: Float32Array, k: number): FusedItem[] {
    if (this.dim === 0 || queryVec.length !== this.dim || k <= 0) return []
    const q = normalize(Float32Array.from(queryVec))
    const scored: FusedItem[] = []
    for (const [id, vec] of this.mem) {
      scored.push({ id, score: dot(q, vec) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close()
  }
}

/** Float32Array → a Buffer of its raw little-endian bytes for BLOB storage. */
function float32ToBytes(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
}

/** Raw BLOB bytes → Float32Array. Copies, so alignment is never an issue. */
function bytesToFloat32(bytes: Uint8Array): Float32Array {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return new Float32Array(copy.buffer)
}
