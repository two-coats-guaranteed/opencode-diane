#!/usr/bin/env bun
/**
 * stress-scale.mjs — measure how the memory store behaves as it grows.
 *
 * The honest scaling question for this plugin is NOT SQLite — SQLite
 * handles far more than this will ever hold. It's the in-memory
 * working set: the repository keeps every memory in a `byId` Map, an
 * inverted index, and a co-change graph, all rebuilt at load. This
 * script measures the costs that actually grow with store size:
 *
 *   - bulk insert        (includes tokenising into the inverted index)
 *   - full flush         (one SQLite transaction, all rows)
 *   - reload             (table scan + index + co-change graph rebuild)
 *   - recall latency     (in-memory BM25 over the whole index)
 *   - incremental flush  (touch a few rows, flush only the delta)
 *   - process RSS        (the real memory footprint at that size)
 *
 * It runs WITHOUT eviction so the curve is the raw underlying scaling.
 * In production the byte budget caps the store — the default is 5 MB,
 * adaptive sizing raises it to at most 20 MB on a large repo — so the
 * report also marks where that realistic ceiling lands on the curve.
 *
 * USAGE:
 *   bun scripts/stress-scale.mjs                 # 10k, 50k, 100k
 *   bun scripts/stress-scale.mjs 25000 250000    # custom ladder
 *
 * No network, no API calls. Just CPU, memory, and a temp SQLite file.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const pkgDir = join(fileURLToPath(import.meta.url), "..", "..")
if (!existsSync(join(pkgDir, "dist", "store", "repository.js"))) {
  console.error("plugin not built — run `bun run build` first.")
  process.exit(1)
}
const { MemoryRepository } = await import(join(pkgDir, "dist", "store", "repository.js"))

const scales = process.argv.slice(2).map((n) => parseInt(n, 10)).filter((n) => n > 0)
const LADDER = scales.length > 0 ? scales : [10_000, 50_000, 100_000]

/* ─── realistic memory generator ────────────────────────────────────
 * A pool of fake file paths; each memory is a git-history-style entry
 * keyed on one file with a few co-changed files as tags. This gives
 * the inverted index real term variety and the co-change graph real
 * edges — a flat "memory N" corpus would understate both costs.
 *
 * Vocabulary matters for honest recall numbers: BM25 recall scales
 * with how many memories match the query terms, not the whole store.
 * A tiny vocabulary makes every query match everything (a pathological
 * O(store) worst case); a realistic repo has thousands of distinct
 * terms so each term hits a bounded fraction. We synthesise ~3 400
 * distinct pseudo-words so the measurement reflects reality. */

const SYLLABLES = [
  "ka", "re", "to", "mi", "nu", "sa", "li", "po",
  "ve", "du", "ze", "fa", "gi", "ho", "ju",
]
// 15^3 = 3 375 distinct all-letter words — each is one clean token.
const VOCAB = []
for (const a of SYLLABLES)
  for (const b of SYLLABLES)
    for (const c of SYLLABLES) VOCAB.push(a + b + c)

const DIRS = ["src", "lib", "core", "api", "store", "util", "net", "db", "cmd", "pkg"]

function buildFilePool(n) {
  // n distinct file paths drawn from the pseudo-word vocabulary.
  const pool = []
  for (let i = 0; i < n; i++) {
    const d = DIRS[i % DIRS.length]
    const w = VOCAB[(i * 31) % VOCAB.length]
    pool.push(`${d}/${w}_${Math.floor(i / DIRS.length)}.ts`)
  }
  return pool
}
function pick(arr, i) {
  return arr[i % arr.length]
}
function sentence(seed) {
  // ~20 words of plausible commit prose drawn from the wide vocab,
  // deterministic from a seed.
  const out = []
  for (let i = 0; i < 20; i++) out.push(VOCAB[(seed * 131 + i * 977) % VOCAB.length])
  return out.join(" ")
}

function memoryFor(i, files) {
  const subject = pick(files, i)
  // 3 co-changed files as tags — the co-change graph edges.
  const tags = [
    "net-addition",
    pick(files, i * 3 + 1),
    pick(files, i * 5 + 2),
    pick(files, i * 7 + 3),
  ]
  return {
    category: "git-history",
    subject,
    content: `Commit ${i.toString(36)}: ${sentence(i)} in ${subject}.`,
    tags,
    source: `git:c${i}`,
  }
}

/* ─── measurement helpers ───────────────────────────────────────────── */

function now() {
  return performance.now()
}
function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1)
}
/** Retained heap after a full GC — the honest "what the store costs"
 *  number. RSS is a high-water mark that includes freed transients and
 *  never shrinks; heapUsed after GC reflects live objects only. */
function heapBytes() {
  if (typeof Bun !== "undefined" && typeof Bun.gc === "function") Bun.gc(true)
  return process.memoryUsage().heapUsed
}
/** Live heap above the process baseline — the store's real cost. */
function heapDeltaMB(baseline) {
  return mb(Math.max(0, heapBytes() - baseline))
}

/* ─── one scale point ───────────────────────────────────────────────── */

async function runScale(n, baseline) {
  const files = buildFilePool(Math.max(200, Math.floor(n / 20)))
  const dir = mkdtempSync(join(tmpdir(), `diane-stress-${n}-`))
  const result = { n }

  // ── build + insert ────────────────────────────────────────────────
  let repo = await MemoryRepository.load(dir)
  let items = []
  for (let i = 0; i < n; i++) items.push(memoryFor(i, files))

  let t = now()
  repo.insertMany(items)
  result.insertMs = Math.round(now() - t)
  result.storeBytes = repo.totalBytes()
  items = null // free the input array — RSS should reflect the store

  // ── full flush (all rows → one SQLite transaction) ────────────────
  t = now()
  await repo.forceFlush()
  result.flushMs = Math.round(now() - t)

  // ── recall while hot ──────────────────────────────────────────────
  // Queries draw from the wide vocabulary, so each term matches a
  // realistic bounded fraction of the store rather than all of it.
  const queries = []
  for (let i = 0; i < 100; i++) {
    queries.push(
      `${pick(VOCAB, i * 17)} ${pick(VOCAB, i * 53 + 1)} ${pick(VOCAB, i * 91 + 2)}`
    )
  }
  t = now()
  for (const q of queries) repo.recall({ query: q, limit: 25, tokenBudget: 1200 })
  result.recall100Ms = Math.round(now() - t)

  result.heapAfterBuild = heapDeltaMB(baseline)
  await repo.close()

  // ── reload: table scan + index + co-change graph rebuild ──────────
  t = now()
  repo = await MemoryRepository.load(dir)
  result.loadMs = Math.round(now() - t)
  result.sizeAfterLoad = repo.size()

  // recall again, on the freshly-loaded store, to confirm it's stable
  t = now()
  for (const q of queries) repo.recall({ query: q, limit: 25, tokenBudget: 1200 })
  result.recallAfterLoadMs = Math.round(now() - t)

  // ── incremental flush: touch 20 rows, flush only the delta ────────
  // recall bumps useCount on hit memories → marks them dirty.
  repo.recall({ query: queries[0], limit: 20, tokenBudget: 4000 })
  t = now()
  await repo.forceFlush()
  result.incrementalFlushMs = Math.round(now() - t)

  result.heapAfterLoad = heapDeltaMB(baseline)
  await repo.close()

  rmSync(dir, { recursive: true, force: true })
  return result
}

/* ─── run the ladder ────────────────────────────────────────────────── */

console.log("── memory store: scaling stress test ─────────────────────")
console.log(`ladder: ${LADDER.map((n) => n.toLocaleString()).join(", ")} memories`)
console.log("(eviction disabled — this is the raw curve; see ceiling note below)\n")

const rows = []
const baseline = heapBytes()
for (const n of LADDER) {
  process.stdout.write(`  running ${n.toLocaleString()} … `)
  const r = await runScale(n, baseline)
  rows.push(r)
  console.log("done")
}

console.log("")
console.log(
  "| memories | store MB | insert | full flush | reload | recall×100 | incr. flush | heap Δ |"
)
console.log("|--:|--:|--:|--:|--:|--:|--:|--:|")
for (const r of rows) {
  console.log(
    `| ${r.n.toLocaleString()} | ${mb(r.storeBytes)} | ${r.insertMs} ms | ` +
      `${r.flushMs} ms | ${r.loadMs} ms | ${r.recallAfterLoadMs} ms | ` +
      `${r.incrementalFlushMs} ms | ${r.heapAfterLoad} MB |`
  )
}

console.log("")
console.log("Notes:")
console.log("- recall×100 = 100 BM25 queries; per-query latency is that ÷ 100.")
console.log("- incr. flush = the SQLite delta-write after touching ~20 rows —")
console.log("  this is the steady-state write cost and should stay near-flat.")
console.log("- reload = full table scan + inverted-index + co-change-graph rebuild.")

// Map the realistic eviction ceiling onto the curve.
const perMemBytes =
  rows.length > 0 ? rows[0].storeBytes / rows[0].n : 300
const ceil5 = Math.round((5 * 1024 * 1024) / perMemBytes)
const ceil20 = Math.round((20 * 1024 * 1024) / perMemBytes)
console.log("")
console.log(
  `Realistic ceiling: at ~${Math.round(perMemBytes)} bytes/memory, the eviction`
)
console.log(
  `budget caps a real store at ~${ceil5.toLocaleString()} memories (default 5 MB)`
)
console.log(
  `and ~${ceil20.toLocaleString()} (adaptive max 20 MB). Rows past that in the`
)
console.log("table above are beyond what eviction would ever allow to accumulate.")
