/**
 * SQLite-backed durable storage for the memory store.
 *
 * Replaces the old single-JSON-file persistence. The store lives at
 * `.opencode/diane.db` — a real SQLite database in WAL mode.
 *
 * Why this exists: the JSON store rewrote the *entire* file on every
 * debounced flush. On a large repo that is the dominant cost and the
 * reason the plugin didn't scale. SQLite writes only the *changed*
 * rows, in one transaction. That is the whole point of the migration.
 *
 * Scope, stated honestly: this is a durable *log*, not a query engine.
 * The repository still keeps the working set in memory — the `byId`
 * cache and the inverted index, which it needs anyway for the custom
 * co-change-boosted BM25 scoring that FTS5 can't express. SQLite is
 * touched in exactly two places: once at load (a single table scan)
 * and at each flush (one delta transaction). Reads never hit it.
 * Moving retrieval into SQLite (FTS5) would be a separate project.
 *
 * Uses `bun:sqlite` — built into the Bun runtime that OpenCode loads
 * plugins under, so this adds no dependency.
 */

import { Database } from "bun:sqlite"
import { mkdirSync, existsSync, readFileSync, renameSync } from "node:fs"
import { dirname } from "node:path"
import type { Memory, MemoryStoreFile, Category } from "../types.js"

const DB_REL = ".opencode/diane.db"
/** Legacy JSON store — migrated into SQLite on first open, then renamed aside. */
const JSON_REL = ".opencode/diane.json"

export function dbFilePath(root: string): string {
  return `${root}/${DB_REL}`
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL,
  source      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  used_at     INTEGER NOT NULL,
  use_count   INTEGER NOT NULL,
  size_bytes  INTEGER NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** A row as stored in the `memories` table. */
interface MemoryRow {
  id: string
  category: string
  subject: string
  content: string
  tags: string
  source: string
  created_at: number
  used_at: number
  use_count: number
  size_bytes: number
  pinned: number
}

/** What the repository gets back from a load. */
export interface LoadedStore {
  memories: Memory[]
  meta: MemoryStoreFile["meta"]
}

function rowToMemory(r: MemoryRow): Memory {
  return {
    id: r.id,
    category: r.category as Category,
    subject: r.subject,
    content: r.content,
    tags: JSON.parse(r.tags) as string[],
    source: r.source,
    createdAt: r.created_at,
    usedAt: r.used_at,
    useCount: r.use_count,
    sizeBytes: r.size_bytes,
    // pinned is optional on Memory — only set it when actually pinned,
    // matching how the rest of the codebase treats the field.
    pinned: r.pinned === 1 ? true : undefined,
  }
}

function emptyMeta(): MemoryStoreFile["meta"] {
  return { ingestedAt: {}, lastEvictionAt: null, schema: 1 }
}

export class SqliteStore {
  private db: Database
  // Prepared statements — created once, reused for every flush. This
  // is the other half of "use SQLite well": the query planner runs
  // once per statement, not once per row.
  private readonly upsertStmt
  private readonly deleteStmt
  private readonly metaUpsertStmt

  private constructor(db: Database) {
    this.db = db
    // WAL: concurrent-read friendly and the right default for a store
    // two OpenCode sessions might touch at once. NORMAL synchronous is
    // safe under WAL and much faster than FULL.
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA synchronous = NORMAL")
    db.exec(SCHEMA)

    this.upsertStmt = db.query(
      `INSERT INTO memories
         (id, category, subject, content, tags, source,
          created_at, used_at, use_count, size_bytes, pinned)
       VALUES
         ($id, $category, $subject, $content, $tags, $source,
          $createdAt, $usedAt, $useCount, $sizeBytes, $pinned)
       ON CONFLICT(id) DO UPDATE SET
         category   = excluded.category,
         subject    = excluded.subject,
         content    = excluded.content,
         tags       = excluded.tags,
         source     = excluded.source,
         created_at = excluded.created_at,
         used_at    = excluded.used_at,
         use_count  = excluded.use_count,
         size_bytes = excluded.size_bytes,
         pinned     = excluded.pinned`
    )
    this.deleteStmt = db.query(`DELETE FROM memories WHERE id = $id`)
    this.metaUpsertStmt = db.query(
      `INSERT INTO meta (key, value) VALUES ($key, $value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
  }

  /**
   * Open (or create) the store for a project root. On first open, if
   * there is a legacy JSON store and no DB yet, the JSON is migrated
   * into the fresh DB and renamed aside. Returns the store handle and
   * everything in it (the repository reads this once at construction).
   */
  static open(root: string, log?: (msg: string) => void): { store: SqliteStore; loaded: LoadedStore } {
    const dbPath = dbFilePath(root)
    mkdirSync(dirname(dbPath), { recursive: true })
    const dbExisted = existsSync(dbPath)
    const db = new Database(dbPath, { create: true })
    const store = new SqliteStore(db)

    if (!dbExisted) {
      const migrated = store.migrateFromJson(root)
      if (migrated > 0 && log) {
        log(`migrated ${migrated} memories from legacy diane.json`)
      }
    }

    return { store, loaded: store.loadAll() }
  }

  /** Read the whole store back — called once, at repository construction. */
  loadAll(): LoadedStore {
    const rows = this.db.query(`SELECT * FROM memories`).all() as MemoryRow[]
    const memories = rows.map(rowToMemory)

    const meta = emptyMeta()
    const metaRows = this.db.query(`SELECT key, value FROM meta`).all() as Array<{
      key: string
      value: string
    }>
    for (const { key, value } of metaRows) {
      try {
        if (key === "ingestedAt") meta.ingestedAt = JSON.parse(value)
        else if (key === "lastEvictionAt") meta.lastEvictionAt = JSON.parse(value)
        else if (key === "schema") meta.schema = JSON.parse(value)
      } catch {
        /* a corrupt meta row falls back to the default — non-fatal */
      }
    }
    return { memories, meta }
  }

  /**
   * Persist a delta in ONE transaction: upsert every memory in
   * `dirty`, delete every id in `deleted`, write `meta`. This is the
   * incremental write that replaces the JSON whole-file rewrite —
   * three changed memories cost three row writes, not a re-serialise
   * of the entire store. A single transaction also means the flush is
   * atomic: a crash mid-flush leaves the DB at the previous state, no
   * temp-file-rename dance required.
   */
  flush(dirty: Iterable<Memory>, deleted: Iterable<string>, meta: MemoryStoreFile["meta"]): void {
    const run = this.db.transaction(() => {
      for (const m of dirty) {
        this.upsertStmt.run({
          $id: m.id,
          $category: m.category,
          $subject: m.subject,
          $content: m.content,
          $tags: JSON.stringify(m.tags),
          $source: m.source,
          $createdAt: m.createdAt,
          $usedAt: m.usedAt,
          $useCount: m.useCount,
          $sizeBytes: m.sizeBytes,
          $pinned: m.pinned ? 1 : 0,
        })
      }
      for (const id of deleted) {
        this.deleteStmt.run({ $id: id })
      }
      this.metaUpsertStmt.run({ $key: "ingestedAt", $value: JSON.stringify(meta.ingestedAt) })
      this.metaUpsertStmt.run({ $key: "lastEvictionAt", $value: JSON.stringify(meta.lastEvictionAt) })
      this.metaUpsertStmt.run({ $key: "schema", $value: JSON.stringify(meta.schema) })
    })
    run()
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close()
  }

  /**
   * One-time legacy migration: if a `diane.json` exists, load
   * it, bulk-insert into the fresh DB in one transaction, and rename
   * the JSON to `.json.migrated` so it is not re-migrated and the user
   * keeps a backup. Returns the number of memories migrated (0 if
   * there was nothing to migrate or the JSON was unreadable).
   */
  private migrateFromJson(root: string): number {
    const jsonPath = `${root}/${JSON_REL}`
    if (!existsSync(jsonPath)) return 0

    let parsed: MemoryStoreFile
    try {
      parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as MemoryStoreFile
    } catch {
      return 0 // corrupt JSON — start fresh, leave the file untouched
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.memories)) {
      return 0
    }

    const meta = parsed.meta ?? emptyMeta()
    this.flush(parsed.memories, [], meta)

    try {
      renameSync(jsonPath, `${jsonPath}.migrated`)
    } catch {
      /* best effort — if the rename fails the DB now exists, so the
         next open won't re-migrate anyway */
    }
    return parsed.memories.length
  }
}
