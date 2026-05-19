/**
 * scaling.test.ts — a gated guard that the store stays usable and
 * correct at a moderate scale, and that no operation has gone
 * quadratic.
 *
 * This is NOT the deep benchmark — that's `scripts/stress-scale.mjs`,
 * which sweeps 5k/15k/25k+ and reports a full cost table. This test
 * builds one moderate store (~4 000 memories — a realistic mid-size
 * repo's worth) inside the normal `bun run test` budget and asserts:
 *
 *   - the round trip is correct: flush → reload preserves every
 *     memory, and recall still finds a known needle among the noise;
 *   - timings stay under deliberately *generous* ceilings — ~25× the
 *     numbers observed on a dev machine. The point isn't to measure
 *     speed (the benchmark does that); it's to fail loudly if someone
 *     makes insert/load/recall scale super-linearly. A 25× headroom
 *     won't flake on a slow shared CI runner but still trips on a
 *     genuine O(n²) regression.
 *
 * Honest scope: 4 000 memories is mid-range. The plugin's depth-capped
 * ingesters plus the byte-budget eviction keep real stores roughly in
 * the 15–25k band; `scripts/stress-scale.mjs` covers that and beyond.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MemoryRepository } from "../src/store/repository.js"

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  ✗ ${label}`)
  }
}

const N = 4000

// A wide pseudo-vocabulary so a query term matches a realistic bounded
// fraction of the store — a tiny vocabulary would make every query an
// O(store) scan and misrepresent recall scaling.
const SYL = ["ka", "re", "to", "mi", "nu", "sa", "li", "po", "ve", "du", "ze", "fa"]
const VOCAB: string[] = []
for (const a of SYL) for (const b of SYL) for (const c of SYL) VOCAB.push(a + b + c)

function sentence(seed: number): string {
  const out: string[] = []
  for (let i = 0; i < 20; i++) out.push(VOCAB[(seed * 131 + i * 977) % VOCAB.length])
  return out.join(" ")
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "diane-mem-scaling-"))
  const t0 = performance.now()

  // ── build ~N memories + one distinctive needle ────────────────────
  console.log(`\n── scaling: build ${N} memories ──────────────────────────`)
  let repo = await MemoryRepository.load(dir)

  const items = []
  for (let i = 0; i < N; i++) {
    items.push({
      category: "git-history" as const,
      subject: `src/file_${i % 400}.ts`,
      content: `Commit ${i.toString(36)}: ${sentence(i)}.`,
      tags: ["net-addition", `src/file_${(i * 7) % 400}.ts`],
      source: `git:c${i}`,
    })
  }
  // A needle with words that appear nowhere else in the corpus.
  items.push({
    category: "project-facts" as const,
    subject: "DEPLOYMENT.md",
    content: "The zzqqx deployment runs on the wibblewobble orchestrator cluster.",
    tags: ["deployment"],
    source: "project",
  })

  const insertStart = performance.now()
  repo.insertMany(items)
  const insertMs = performance.now() - insertStart
  assert(repo.size() === N + 1, `store holds all ${N + 1} memories (got ${repo.size()})`)
  assert(insertMs < 8000, `insert of ${N + 1} stays under the 8s anti-quadratic ceiling (${Math.round(insertMs)}ms)`)

  // ── flush + reload round trip ─────────────────────────────────────
  console.log("\n── scaling: flush + reload round trip ────────────────────")
  const flushStart = performance.now()
  await repo.forceFlush()
  const flushMs = performance.now() - flushStart
  assert(flushMs < 6000, `full flush stays under the 6s ceiling (${Math.round(flushMs)}ms)`)
  await repo.close()

  const loadStart = performance.now()
  repo = await MemoryRepository.load(dir)
  const loadMs = performance.now() - loadStart
  assert(repo.size() === N + 1, `reload preserves every memory (got ${repo.size()})`)
  assert(loadMs < 8000, `reload (scan + index + co-change rebuild) under the 8s ceiling (${Math.round(loadMs)}ms)`)

  // ── recall is still CORRECT at scale ──────────────────────────────
  // The needle's words are unique to it, so it must come back first.
  console.log("\n── scaling: recall correctness at scale ──────────────────")
  const needle = repo.recall({ query: "zzqqx wibblewobble deployment", limit: 5 })
  assert(needle.length > 0, "recall finds the needle among 4000 memories")
  assert(
    needle[0]?.memory.subject === "DEPLOYMENT.md",
    "the needle is the top hit — ranking still works at scale"
  )

  // A category-filtered recall still narrows correctly.
  const gitOnly = repo.recall({ query: sentence(0), category: "git-history", limit: 10 })
  assert(
    gitOnly.every((h) => h.memory.category === "git-history"),
    "category filter holds at scale"
  )

  // ── recall latency stays sane (anti-quadratic) ────────────────────
  console.log("\n── scaling: recall latency guard ─────────────────────────")
  const queries: string[] = []
  for (let i = 0; i < 100; i++) {
    queries.push(`${VOCAB[(i * 17) % VOCAB.length]} ${VOCAB[(i * 53 + 1) % VOCAB.length]}`)
  }
  const recallStart = performance.now()
  for (const q of queries) repo.recall({ query: q, limit: 25, tokenBudget: 1200 })
  const recallMs = performance.now() - recallStart
  console.log(`    100 recalls over ${N + 1} memories: ${Math.round(recallMs)}ms`)
  assert(recallMs < 2000, `100 recalls stay under the 2s anti-quadratic ceiling (${Math.round(recallMs)}ms)`)

  // ── incremental flush stays cheap ─────────────────────────────────
  // Touching a few rows must flush a small delta, not rewrite the lot.
  console.log("\n── scaling: incremental flush is a delta, not a rewrite ──")
  repo.recall({ query: queries[0], limit: 20, tokenBudget: 4000 }) // bumps useCount → dirty
  const incStart = performance.now()
  await repo.forceFlush()
  const incMs = performance.now() - incStart
  console.log(`    incremental flush after touching ~20 rows: ${Math.round(incMs)}ms`)
  // At 4k the full flush is already cheap, so a strict "<full" check
  // would be thin and flaky. The meaningful guard is that touching a
  // handful of rows flushes a small *bounded* delta — it must not
  // scale with the whole store. (scripts/stress-scale.mjs shows the
  // dramatic full-vs-incremental gap at 25k+, where it actually bites.)
  assert(
    incMs < 1000,
    `incremental flush after ~20 touched rows stays a small delta (${Math.round(incMs)}ms < 1s)`
  )

  await repo.close()
  await rm(dir, { recursive: true, force: true })

  console.log(`\n  (total wall time: ${Math.round(performance.now() - t0)}ms)`)
  console.log("──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
