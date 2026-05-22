/**
 * Tests for `mapConcurrent` — the bounded-parallel map helper used by
 * the ingesters. The properties under test are exactly the ones the
 * ingesters depend on:
 *
 *   1. Results are returned in INPUT ORDER (not completion order).
 *   2. At most `concurrency` tasks run simultaneously.
 *   3. An empty input list returns [] without spawning workers.
 *   4. A rejection in one task does not strand the other workers.
 *   5. concurrency >= items.length degrades to "all at once".
 */

import { mapConcurrent } from "../src/utils/concurrent.js"

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── basic: empty input returns [] ────────────────────────")
  {
    const out = await mapConcurrent<number, number>([], 4, async (n) => n * 2)
    assert(Array.isArray(out) && out.length === 0, "empty input → empty output")
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── results are in INPUT order, not completion order ─────")
  {
    // Each item sleeps a random time; without index-aware result
    // slotting, the output would be in completion order. With it, it
    // matches input order.
    const items = [0, 1, 2, 3, 4, 5, 6, 7]
    const out = await mapConcurrent(items, 4, async (n) => {
      // Reverse the natural completion order — later items finish faster.
      await sleep((8 - n) * 5)
      return n * 10
    })
    assert(
      JSON.stringify(out) === JSON.stringify([0, 10, 20, 30, 40, 50, 60, 70]),
      "results returned in input order even when completion order is reversed",
    )
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── concurrency cap is respected ─────────────────────────")
  {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 20 }, (_, i) => i)
    await mapConcurrent(items, 4, async () => {
      inFlight += 1
      if (inFlight > peak) peak = inFlight
      await sleep(10)
      inFlight -= 1
      return null
    })
    assert(peak === 4, `peak in-flight = ${peak}, expected 4`)
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── concurrency >= items.length degrades to full parallel ─")
  {
    let inFlight = 0
    let peak = 0
    const items = [1, 2, 3]
    await mapConcurrent(items, 100, async () => {
      inFlight += 1
      if (inFlight > peak) peak = inFlight
      await sleep(5)
      inFlight -= 1
      return null
    })
    assert(peak === 3, "concurrency clamped to items.length when larger")
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── concurrency = 1 = sequential ─────────────────────────")
  {
    let inFlight = 0
    let peak = 0
    await mapConcurrent([1, 2, 3, 4], 1, async () => {
      inFlight += 1
      if (inFlight > peak) peak = inFlight
      await sleep(3)
      inFlight -= 1
      return null
    })
    assert(peak === 1, "concurrency=1 runs strictly serially")
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── concurrency = 0 falls back to 1 (clamp, no deadlock) ─")
  {
    const out = await mapConcurrent([10, 20], 0, async (n) => n)
    assert(
      JSON.stringify(out) === JSON.stringify([10, 20]),
      "concurrency=0 still completes (clamped to 1 internally)",
    )
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── one rejection surfaces, others still settle ──────────")
  {
    const completed: number[] = []
    let rejected = false
    try {
      await mapConcurrent([0, 1, 2, 3, 4], 2, async (n) => {
        await sleep(5)
        if (n === 2) throw new Error("boom on 2")
        completed.push(n)
        return n
      })
    } catch (err) {
      rejected = true
      assert(
        (err as Error).message.includes("boom on 2"),
        "the original error message propagates",
      )
    }
    assert(rejected, "the call rejects when any task rejects")
    // All non-throwing tasks should still have run. (We don't assert
    // a specific count because workers may have already grabbed items
    // when the rejection happens, but at least 0 and 1 will have
    // completed since they execute before 2 in input order with
    // concurrency=2.)
    assert(
      completed.includes(0) && completed.includes(1),
      "non-failing tasks before the failure still completed",
    )
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── fn is called with item AND index ─────────────────────")
  {
    const seen: Array<[string, number]> = []
    await mapConcurrent(["a", "b", "c"], 2, async (item, i) => {
      seen.push([item, i])
      return item
    })
    // Order of `seen` may interleave but pairs must be correct.
    const sorted = seen.slice().sort((x, y) => x[1] - y[1])
    assert(
      JSON.stringify(sorted) === JSON.stringify([["a", 0], ["b", 1], ["c", 2]]),
      "fn receives (item, index) matched correctly",
    )
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── summary ──────────────────────────────────────────────")
  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

await main()
