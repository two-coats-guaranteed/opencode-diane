/**
 * working-set.test.ts — session working-set prior.
 * Script-style; run with: bun run tests/working-set.test.ts
 */

import {
  noteUsefulFile,
  decaySession,
  flushSession,
  workingSet,
  clearAllSessions,
  noteQueryAndMaybeFlush,
  computeBoostedScores,
} from "../src/session/working-set.js"

let passed = 0
let failed = 0
const failures: string[] = []
function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

async function main(): Promise<void> {
  console.log("\n── working-set state ──────────────────────────────────────")
  {
    clearAllSessions()
    noteUsefulFile("s1", "src/auth/session.py")
    assert(workingSet("s1").get("src/auth/session.py") === 1.0, "edited file enters the set at full strength")
    assert(workingSet("s2").size === 0, "working set is per-session")
  }
  {
    clearAllSessions()
    noteUsefulFile("s1", "a.py")
    decaySession("s1", 0.5, 0.2)
    assert(Math.abs((workingSet("s1").get("a.py") ?? 0) - 0.5) < 1e-9, "decay multiplies strength")
    decaySession("s1", 0.3, 0.2) // 0.5*0.3 = 0.15 < floor 0.2 -> dropped
    assert(workingSet("s1").get("a.py") === undefined, "decay drops files below the floor")
  }
  {
    clearAllSessions()
    noteUsefulFile("s1", "a.py")
    noteUsefulFile("s1", "b.py")
    flushSession("s1")
    assert(workingSet("s1").size === 0, "flush clears the working set")
  }

  console.log("\n── query-drift flush (sustained) ──────────────────────────")
  {
    clearAllSessions()
    noteUsefulFile("s1", "src/auth/session.py")
    const f1 = noteQueryAndMaybeFlush("s1", "session redirect auth header handling")
    assert(f1 === false, "first query establishes context, no flush")
    const f2 = noteQueryAndMaybeFlush("s1", "auth header redirect on session resolve")
    assert(f2 === false, "on-topic follow-up does not flush")
    assert(workingSet("s1").size === 1, "working set survives an on-topic query")
    // a SINGLE off-topic query must NOT flush (measured: too aggressive)
    const f3 = noteQueryAndMaybeFlush("s1", "matplotlib colormap normalization gradient palette")
    assert(f3 === false, "a single off-topic query does NOT flush (sustained drift required)")
    assert(workingSet("s1").size === 1, "working set survives one off-topic query")
    // a SECOND consecutive off-topic query (sustained drift) flushes
    const f4 = noteQueryAndMaybeFlush("s1", "colorbar tick locator axes scale ticks")
    assert(f4 === true, "two consecutive off-topic queries flush (sustained drift)")
    assert(workingSet("s1").size === 0, "working set cleared after sustained drift")
  }
  {
    // an on-topic query between off-topic ones resets the streak
    clearAllSessions()
    noteUsefulFile("s1", "src/auth/session.py")
    noteQueryAndMaybeFlush("s1", "session auth redirect header")
    assert(noteQueryAndMaybeFlush("s1", "matplotlib colormap palette gradient") === false, "off-topic #1: no flush")
    assert(noteQueryAndMaybeFlush("s1", "session auth header cookie redirect") === false, "on-topic again resets the drift streak")
    assert(noteQueryAndMaybeFlush("s1", "numpy array broadcasting dtype stride") === false, "single off-topic after reset does not flush")
    assert(workingSet("s1").size === 1, "intervening on-topic query preserved the working set")
  }

  console.log("\n── computeBoostedScores ───────────────────────────────────")
  {
    // injection: a co-change neighbour not in base gets surfaced
    const base = new Map([["top.py", 10], ["other.py", 4]])
    const ws = new Map([["edited.py", 1.0]])
    const neigh: Record<string, string[]> = { "edited.py": ["target.py"] }
    const out = computeBoostedScores(base, ws, (f) => neigh[f], { alpha: 0.5, self: 0.1, beta: 0 })
    assert(out.has("target.py"), "co-change neighbour is injected even though base lacks it")
    assert(Math.abs((out.get("target.py") ?? 0) - 0.5) < 1e-9, "injected score = alpha * strength")
    assert(Math.abs((out.get("top.py") ?? 0) - 1.0) < 1e-9, "base scores are normalised to [0,1]")
  }
  {
    // self-boost: a working-set file present as a candidate is bumped
    const base = new Map([["edited.py", 8], ["x.py", 8]])
    const ws = new Map([["edited.py", 1.0]])
    const out = computeBoostedScores(base, ws, () => undefined, { alpha: 0.5, self: 0.3, beta: 0 })
    assert((out.get("edited.py") ?? 0) > (out.get("x.py") ?? 0), "self-boost lifts the working-set file above an equal-scored peer")
  }
  {
    // same-dir: a sibling of a working-set file gets the beta bump
    const base = new Map([["src/auth/login.py", 5], ["src/db/conn.py", 5]])
    const ws = new Map([["src/auth/session.py", 1.0]])
    const out = computeBoostedScores(base, ws, () => undefined, { alpha: 0.5, self: 0, beta: 0.2 })
    assert((out.get("src/auth/login.py") ?? 0) > (out.get("src/db/conn.py") ?? 0), "same-dir sibling is boosted over an unrelated file")
  }
  {
    // empty working set -> normalised base, no change in order
    const base = new Map([["a.py", 6], ["b.py", 3]])
    const out = computeBoostedScores(base, new Map(), () => undefined)
    assert(Math.abs((out.get("a.py") ?? 0) - 1.0) < 1e-9 && Math.abs((out.get("b.py") ?? 0) - 0.5) < 1e-9, "empty working set just normalises base")
  }

  console.log("\n──────────────────────────────────────────────────────────")
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
