import { mkdtemp, rm, writeFile, mkdir, rename } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { MemoryRepository } from "../src/store/repository.js"
import { dbFilePath } from "../src/store/sqlite-store.js"
import { evictIfOverBudget } from "../src/store/eviction.js"
import type { Memory, ResolvedConfig } from "../src/types.js"

let passed = 0
let failed = 0
const failures: string[] = []

/**
 * Timing facility. `time(label, fn)` runs `fn`, records and prints the
 * elapsed wall-clock ms, and stores it in `timings` so the suite can
 * print a summary table at the end. Lines are prefixed `[timing]` so
 * they're greppable across test runs (used to compare the JSON-era
 * baseline against the SQLite rewrite).
 *
 * ── Baseline: JSON storage, Bun runtime (median of 3 runs) ──────────
 *   bulk insert 4000 distinct .......... ~110 ms
 *   idempotent re-insert 4000 ..........  ~13 ms
 *   upsertBySubject x2000 ..............  ~52 ms
 *   forceFlush (~6000 to disk) .........  ~18 ms
 *   load (reload from disk) ............ ~105 ms
 *   recall x100 ....................... ~720 ms   (pure in-memory BM25)
 *   applyEviction (halve budget) .......  ~30 ms
 *
 * ── After: SQLite storage, Bun runtime (median of 3 runs) ───────────
 *   bulk insert 4000 distinct .......... ~110 ms   (wash)
 *   idempotent re-insert 4000 ..........  ~16 ms   (wash; in-memory dedup)
 *   upsertBySubject x2000 ..............  ~48 ms   (wash)
 *   forceFlush (~6000 to disk) .........  ~27 ms   (slightly slower)
 *   load (reload from disk) ............ ~108 ms   (wash)
 *   recall x100 ....................... ~663 ms   (wash — storage-independent)
 *   applyEviction (halve budget) .......  ~27 ms   (wash)
 *
 * Honest reading: at this 4000-entry (~1 MB) scale SQLite is NOT
 * faster — a small store is cheap to rewrite wholesale and SQLite's
 * per-transaction overhead doesn't pay for itself; the single bulk
 * `forceFlush` is even a touch slower. The migration's win is the
 * large-store steady state, measured separately below in the
 * "large-store flush scaling" section: on a 15000-entry store,
 * touching 20 memories and flushing costs ~4 ms with SQLite's
 * incremental write versus ~32 ms for the JSON-style whole-file
 * rewrite it replaced (~7-8x), and that gap widens with store size —
 * the incremental flush is constant in the number of *changed* rows
 * while the JSON rewrite is linear in the *whole* store. The
 * migration is justified by that scaling behaviour, plus crash-safety
 * (WAL vs temp-file-rename) and real concurrent-session semantics —
 * not by small-store speed. Recall is in-memory BM25 and
 * storage-independent — unchanged, as the numbers confirm.
 */
const timings: Array<{ label: string; ms: number }> = []
function time<T>(label: string, fn: () => T): T {
  const t0 = performance.now()
  const out = fn()
  const ms = performance.now() - t0
  timings.push({ label, ms })
  console.log(`  [timing] ${label}: ${ms.toFixed(1)}ms`)
  return out
}
async function timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now()
  const out = await fn()
  const ms = performance.now() - t0
  timings.push({ label, ms })
  console.log(`  [timing] ${label}: ${ms.toFixed(1)}ms`)
  return out
}

function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

/**
 * A complete ResolvedConfig with the given budget — one place to keep
 * the shape current so tests don't rot when ResolvedConfig grows.
 */
function evictionConfig(maxMemoryBytes: number): ResolvedConfig {
  return {
    maxMemoryBytes,
    autoIngestOnStartup: false,
    gitHistoryDepth: 0,
    forceActive: false,
    skillsOutputDir: ".opencode/skills",
    skillMiningMinCluster: 3,
    ingestSessions: false,
    enableCodeMap: false,
    enableNudgeHook: true,
    adaptive: true,
    explicitKeys: new Set(),
    codeMapMaxFiles: 4000,
    coChangeMaxCommits: 5000,
  }
}

async function main(): Promise<void> {
  console.log("\n── store ─────────────────────────────────────────────────")
  const root = await mkdtemp(join(tmpdir(), "diane-mem-store-"))
  const repo = await MemoryRepository.load(root)
  assert(repo.size() === 0, "fresh store starts empty")

  const a = repo.insert({
    category: "agent-note",
    subject: "auth/login.py",
    content: "Login flow uses bcrypt and stores hash in users table.",
    tags: ["auth"],
    source: "agent",
  })
  assert(repo.size() === 1, "insert grows the store")
  assert(a.sizeBytes > 0, "insert sets a non-zero sizeBytes")

  // Idempotent insertIfMissing
  const a2 = repo.insertIfMissing({
    category: "agent-note",
    subject: "auth/login.py",
    content: "Login flow uses bcrypt and stores hash in users table.",
    tags: ["auth"],
    source: "agent",
  })
  assert(a.id === a2.id, "insertIfMissing returns existing on exact dup")
  assert(repo.size() === 1, "insertIfMissing didn't double-insert")

  await repo.forceFlush()
  assert(existsSync(dbFilePath(root)), "forceFlush wrote the SQLite database to disk")

  // Reload from disk
  const repo2 = await MemoryRepository.load(root)
  assert(repo2.size() === 1, "store survives a reload")
  const hits = repo2.recall({ query: "bcrypt login" })
  assert(hits.length === 1 && hits[0].memory.subject === "auth/login.py", "BM25 finds the loaded memory")

  // Recall mutates useCount + usedAt
  assert(hits[0].memory.useCount === 1, "useCount increments after recall")

  await repo.close()
  await repo2.close()
  await rm(root, { recursive: true, force: true })

  // ── efficiency + timing: the operations the storage layer governs ──
  // These are instrumented so the JSON-era baseline can be compared
  // against the SQLite rewrite. Each is also a correctness assertion
  // with a loose time bound, not just a benchmark.
  console.log("\n── efficiency + timing ───────────────────────────────────")
  const perfRoot = await mkdtemp(join(tmpdir(), "diane-mem-perf-"))
  const perfRepo = await MemoryRepository.load(perfRoot)

  const N = 4000
  const mkItem = (i: number) => ({
    category: "git-history" as const,
    subject: `file-${i}.py`,
    content: `Commit ${i} (feature): did something to file-${i}.py`,
    tags: ["feature"],
    source: `git:${i}`,
  })

  // 1. Bulk insert of N distinct memories.
  let runningBytes = perfRepo.totalBytes()
  time(`bulk insert ${N} distinct`, () => {
    for (let i = 0; i < N; i++) {
      const m = perfRepo.insertIfMissing(mkItem(i))
      runningBytes += m.sizeBytes
    }
  })
  assert(perfRepo.size() === N, `inserted ${N} distinct memories`)
  assert(
    perfRepo.totalBytes() === runningBytes,
    "running byte counter matches sum of inserted sizeBytes"
  )

  // 2. Idempotent re-insert of all N (the dedup path).
  const reinsertMs = time(`idempotent re-insert ${N}`, () => {
    const t0 = performance.now()
    for (let i = 0; i < N; i++) perfRepo.insertIfMissing(mkItem(i))
    return performance.now() - t0
  })
  assert(perfRepo.size() === N, `re-inserting ${N} duplicates added nothing (idempotent)`)
  assert(reinsertMs < 1000, `${N} idempotent re-inserts stay fast (took ${reinsertMs.toFixed(1)}ms)`)

  // 3. upsertBySubject — the per-LSP-event / per-code-map-file hot path,
  //    exercised against a populated store.
  time(`upsertBySubject x2000 on ${N}-entry store`, () => {
    for (let i = 0; i < 2000; i++) {
      perfRepo.upsertBySubject({
        category: "code-health",
        subject: `file-${i}.py`,
        content: `health: ${i % 3} errors`,
        tags: [],
        source: "lsp",
      })
    }
  })

  // 4. Persist the whole store to disk.
  await timeAsync(`forceFlush (~${perfRepo.size()} entries to disk)`, () => perfRepo.forceFlush())

  // 5. Reload the whole store from disk (cold start cost).
  const reloaded = await timeAsync("MemoryRepository.load (reload from disk)", () =>
    MemoryRepository.load(perfRoot)
  )
  assert(reloaded.size() === perfRepo.size(), "reloaded store has the same entry count")

  // 6. Recall latency — 100 queries against the populated store.
  time("recall x100 queries", () => {
    for (let i = 0; i < 100; i++) {
      reloaded.recall({ query: `file-${i} feature commit`, limit: 10 })
    }
  })

  // 7. Eviction on the populated store.
  const bytesBeforeEvict = perfRepo.totalBytes()
  time("applyEviction (halve budget)", () => {
    const evRes = perfRepo.applyEviction(evictionConfig(Math.floor(bytesBeforeEvict / 2)))
    assert(evRes.removed > 0, `eviction removed entries to meet halved budget (${evRes.removed})`)
  })
  assert(
    perfRepo.totalBytes() <= Math.floor(bytesBeforeEvict / 2),
    "byte counter is back under budget after eviction"
  )
  assert(perfRepo.totalBytes() > 0, "byte counter stays positive (overhead + survivors)")

  await perfRepo.close()
  await reloaded.close()
  await rm(perfRoot, { recursive: true, force: true })

  // ── eviction unit test ─────────────────────────────────────────────
  console.log("\n── eviction ──────────────────────────────────────────────")
  const fakeMems: Memory[] = Array.from({ length: 5 }, (_, i) => ({
    id: `m${i}`,
    category: "agent-note",
    subject: `s${i}`,
    content: "x".repeat(1000),
    tags: [],
    source: "test",
    createdAt: 1_000 + i,
    usedAt: 2_000 + i,
    useCount: i,                 // m0 least used, m4 most used
    sizeBytes: 1000,
  }))
  // 5 entries × 1000 bytes = 5000 total; budget 2500 keeps ~2.
  const removed = evictIfOverBudget(fakeMems, 2500, 5000)
  assert(removed.length === 3, `expected to evict 3 entries (got ${removed.length})`)
  const removedIds = new Set(removed.map((r) => r.id))
  assert(removedIds.has("m0") && removedIds.has("m1") && removedIds.has("m2"), "evicts least-used first")
  assert(!removedIds.has("m3") && !removedIds.has("m4"), "keeps most-used")

  // Pinned entries are never evicted
  const pinned = fakeMems.map((m, i) => ({ ...m, pinned: i === 0 }))
  const removed2 = evictIfOverBudget(pinned, 2500, 5000)
  const removed2Ids = new Set(removed2.map((r) => r.id))
  assert(!removed2Ids.has("m0"), "pinned entry survives eviction")

  // ── Map-as-store integrity ─────────────────────────────────────────
  // The in-memory store is a Map; the on-disk format is still a JSON
  // array materialised at flush. These guard that the swap kept
  // ordering, persistence, counts, and removal-paths correct.
  console.log("\n── map-as-store integrity ────────────────────────────────")
  const mRoot = await mkdtemp(join(tmpdir(), "diane-store-map-"))
  const mRepo = await MemoryRepository.load(mRoot)

  // insertion order must round-trip through flush + reload
  for (let i = 0; i < 6; i++) {
    mRepo.insert({
      category: "agent-note",
      subject: `ord-${i}`,
      content: `ordered note ${i}`,
      tags: [],
      source: "test",
    })
  }
  const orderBefore = mRepo.allMemories().map((m) => m.subject)
  await mRepo.forceFlush()
  const mReload = await MemoryRepository.load(mRoot)
  const orderAfter = mReload.allMemories().map((m) => m.subject)
  assert(
    orderBefore.join(",") === orderAfter.join(","),
    "insertion order is preserved across flush + reload"
  )
  assert(mReload.size() === 6, "all entries survive the round-trip")

  // countsByCategory reads from the index — verify it matches reality
  mReload.insert({ category: "git-history", subject: "f.ts", content: "c", tags: [], source: "t" })
  const counts = mReload.countsByCategory()
  assert(
    counts.get("agent-note") === 6 && counts.get("git-history") === 1,
    "countsByCategory matches actual per-category totals"
  )

  // upsertBySubject removes the prior entry (O(1) Map delete path)
  mReload.upsertBySubject({
    category: "code-health",
    subject: "live.ts",
    content: "2 errors",
    tags: [],
    source: "lsp",
  })
  mReload.upsertBySubject({
    category: "code-health",
    subject: "live.ts",
    content: "now clean",
    tags: [],
    source: "lsp",
  })
  const liveHealth = mReload.allMemories().filter((m) => m.subject === "live.ts")
  assert(liveHealth.length === 1, "upsertBySubject leaves exactly one entry (old one removed)")
  assert(liveHealth[0].content === "now clean", "upsertBySubject kept the newest content")

  // eviction then reload: removed entries must not resurrect from disk
  const sizeBeforeEv = mReload.totalBytes()
  const evN = mReload.applyEviction(evictionConfig(Math.floor(sizeBeforeEv / 2)))
  assert(evN.removed > 0, "eviction removed entries under the halved budget")
  const survivorCount = mReload.size()
  await mReload.forceFlush()
  const mReload2 = await MemoryRepository.load(mRoot)
  assert(
    mReload2.size() === survivorCount,
    "evicted entries stay gone after flush + reload (no resurrection)"
  )

  await mRepo.close()
  await mReload.close()
  await mReload2.close()
  await rm(mRoot, { recursive: true, force: true })

  // ── legacy JSON → SQLite migration ─────────────────────────────────
  // An existing user has a diane.json. First open with the
  // SQLite store must import it and rename the JSON aside.
  console.log("\n── legacy migration ──────────────────────────────────────")
  const migRoot = await mkdtemp(join(tmpdir(), "diane-mem-mig-"))
  await mkdir(join(migRoot, ".opencode"), { recursive: true })
  const legacyJson = {
    version: 1,
    memories: [
      {
        id: "mem_legacy_1",
        category: "agent-note",
        subject: "legacy/thing.ts",
        content: "a note carried over from the JSON era",
        tags: ["legacy"],
        source: "agent",
        createdAt: 1_700_000_000_000,
        usedAt: 1_700_000_000_000,
        useCount: 2,
        sizeBytes: 64,
      },
    ],
    meta: { ingestedAt: { "git-history": 1_700_000_000_000 }, lastEvictionAt: null, schema: 1 },
  }
  await writeFile(
    join(migRoot, ".opencode", "diane.json"),
    JSON.stringify(legacyJson),
    "utf-8"
  )
  const migrated = await MemoryRepository.load(migRoot)
  assert(migrated.size() === 1, "legacy JSON memories are imported into SQLite")
  const migHits = migrated.recall({ query: "carried over JSON era" })
  assert(
    migHits.length === 1 && migHits[0].memory.id === "mem_legacy_1",
    "migrated memory keeps its id and is recallable"
  )
  assert(
    migrated.getIngestedAt("git-history") === 1_700_000_000_000,
    "migrated meta (ingestedAt) is carried over"
  )
  assert(existsSync(dbFilePath(migRoot)), "migration created the SQLite database")
  assert(
    existsSync(join(migRoot, ".opencode", "diane.json.migrated")),
    "legacy JSON is renamed aside after migration"
  )
  assert(
    !existsSync(join(migRoot, ".opencode", "diane.json")),
    "legacy JSON no longer at its original path"
  )
  // Re-opening must NOT re-migrate (the .json is already renamed; DB exists).
  await migrated.close()
  const reopened = await MemoryRepository.load(migRoot)
  assert(reopened.size() === 1, "re-open reads the DB, does not re-migrate")
  await reopened.close()
  await rm(migRoot, { recursive: true, force: true })

  // ── legacy migration: failure path must not crash the plugin ───────
  // The "db migration" failure observed in the field — when running
  // alongside heavyweight other plugins — manifested as a throw out
  // of migrateFromJson that killed startup. The fix wraps the bulk
  // insert; this test pins the behaviour: a migration that fails for
  // ANY reason returns 0, surfaces the cause via the callback, leaves
  // the legacy JSON in place for the next attempt, and the caller
  // continues with an empty fresh database. Failure to start is not
  // recoverable; an empty database is.
  console.log("\n── legacy migration: failure resilience ──────────────────")
  const failRoot = await mkdtemp(join(tmpdir(), "diane-mem-migfail-"))
  await mkdir(join(failRoot, ".opencode"), { recursive: true })
  await writeFile(
    join(failRoot, ".opencode", "diane.json"),
    JSON.stringify(legacyJson),
    "utf-8",
  )

  // Force a flush failure inside the migration. Monkey-patch the
  // prototype rather than an instance — `SqliteStore` is constructed
  // inside open(), so we cannot patch its instance before migration
  // runs. Restore the original after the test so subsequent suites
  // are unaffected.
  const SqliteStoreMod = await import("../src/store/sqlite-store.js")
  const proto = (SqliteStoreMod.SqliteStore as unknown as { prototype: { flush: unknown } }).prototype
  const originalFlush = proto.flush
  proto.flush = function (): void {
    throw new Error("synthetic flush failure — testing the wrap")
  }

  const migrationErrors: unknown[] = []
  let openOk = false
  let openedRepo: MemoryRepository | null = null
  try {
    openedRepo = await MemoryRepository.load(failRoot, (e) => migrationErrors.push(e))
    openOk = true
  } catch {
    openOk = false
  } finally {
    proto.flush = originalFlush
  }

  assert(openOk, "MemoryRepository.load does not throw when migration fails")
  assert(
    migrationErrors.length === 1,
    "the migration-failure callback is invoked exactly once",
  )
  assert(
    migrationErrors[0] instanceof Error &&
      (migrationErrors[0] as Error).message.includes("synthetic flush failure"),
    "the original cause is passed through to the caller, not swallowed",
  )
  assert(openedRepo !== null && openedRepo.size() === 0, "the repository starts empty after a failed migration")
  assert(
    existsSync(join(failRoot, ".opencode", "diane.json")),
    "the legacy JSON file is preserved on failure so the user keeps their data",
  )
  assert(
    !existsSync(join(failRoot, ".opencode", "diane.json.migrated")),
    "no .migrated rename happens on failure",
  )

  await openedRepo?.close()
  await rm(failRoot, { recursive: true, force: true })

  // ── large-store flush scaling: where the SQLite migration pays off ─
  // The 4000-entry timings above show SQLite is *not* faster than JSON
  // at small scale — a ~1 MB store is cheap to rewrite wholesale, and
  // SQLite's per-transaction overhead doesn't pay for itself there.
  // The migration's actual win is the steady-state pattern on a LARGE
  // store: a session changes a handful of memories between debounced
  // flushes. JSON re-serialised and rewrote the *entire* file every
  // time; SQLite writes only the changed rows. This test demonstrates
  // that crossover directly.
  console.log("\n── large-store flush scaling ─────────────────────────────")
  const bigRoot = await mkdtemp(join(tmpdir(), "diane-mem-big-"))
  const bigRepo = await MemoryRepository.load(bigRoot)
  const BIG_N = 15000
  const filler = "x".repeat(380) // ~400-char content per entry → ~6 MB store
  time(`populate ${BIG_N}-entry store (in memory)`, () => {
    for (let i = 0; i < BIG_N; i++) {
      bigRepo.insert({
        category: "git-history",
        subject: `src/module-${i % 500}/file-${i}.ts`,
        content: `Commit ${i}: ${filler}`,
        tags: ["feature", `mod-${i % 500}`],
        source: `git:${i}`,
      })
    }
  })
  // The initial flush writes all BIG_N rows — an unavoidable one-time
  // cost for any storage design (the data has to land on disk once).
  await timeAsync(`initial forceFlush (${BIG_N} rows, first write)`, () => bigRepo.forceFlush())
  await bigRepo.close()

  // Cold load of a large store.
  const bigReload = await timeAsync(`load ${BIG_N}-entry store from disk`, () =>
    MemoryRepository.load(bigRoot)
  )
  assert(bigReload.size() === BIG_N, "large store round-trips intact")

  // Steady state: touch only a handful of memories, then flush.
  for (let i = 0; i < 20; i++) bigReload.recall({ query: `file-${i}`, limit: 1 })
  await timeAsync(`incremental forceFlush (20 changed of ${BIG_N})`, () =>
    bigReload.forceFlush()
  )
  const incrementalMs = timings[timings.length - 1].ms

  // Reference point: what the JSON store did on EVERY flush — re-
  // serialise the whole store and rewrite the file (saveStoreFile was
  // literally writeFile(tmp, JSON.stringify(all)) + rename). Not a
  // strawman: this is the exact work the old flush performed.
  const all = bigReload.allMemories()
  await timeAsync("JSON-model whole-file rewrite (reference)", async () => {
    const tmp = join(bigRoot, "json-model.tmp")
    await writeFile(tmp, JSON.stringify({ version: 1, memories: all, meta: {} }), "utf-8")
    await rename(tmp, join(bigRoot, "json-model.json"))
  })
  const jsonModelMs = timings[timings.length - 1].ms

  assert(
    incrementalMs < jsonModelMs,
    `incremental flush (${incrementalMs.toFixed(1)}ms) beats the JSON whole-file ` +
      `rewrite (${jsonModelMs.toFixed(1)}ms) on a ${BIG_N}-entry store`
  )
  console.log(
    `  → incremental flush is ${(jsonModelMs / incrementalMs).toFixed(1)}x faster ` +
      `than a whole-file rewrite at ${BIG_N} entries`
  )

  await bigReload.close()
  await rm(bigRoot, { recursive: true, force: true })

  // ── timing summary ────────────────────────────────────────────────
  // Greppable block: `[timing-summary]` lines carry the same numbers
  // as the inline `[timing]` lines, gathered in one place for an
  // at-a-glance baseline comparison.
  console.log("\n── timing summary ────────────────────────────────────────")
  for (const t of timings) {
    console.log(`  [timing-summary] ${t.label.padEnd(42)} ${t.ms.toFixed(1).padStart(8)}ms`)
  }

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(2) })
