/**
 * ppr.test.ts — tests for the opt-in Personalized PageRank co-change
 * boost: the PageRank computation itself, and its effect on recall.
 *
 * The expected behaviour, versus the default one-hop boost:
 *   - PPR reaches MULTI-HOP files — a file two co-change hops from a
 *     textual hit is surfaced, where one-hop stops at direct
 *     neighbours;
 *   - it GRADES by graph distance — a one-hop file outranks a two-hop
 *     file;
 *   - it stays BOUNDED — a purely PPR-surfaced hit never outranks a
 *     real textual match;
 *   - it is DETERMINISTIC — the same graph yields the same scores;
 *   - it is OFF BY DEFAULT — without the flag, recall is byte-for-byte
 *     the one-hop path.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { MemoryRepository } from "../src/store/repository.js"
import { personalizedPageRank } from "../src/search/ppr.js"

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

/** Build an undirected graph from edge pairs. */
function graphOf(edges: Array<[string, string]>): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>()
  const link = (a: string, b: string): void => {
    if (!g.has(a)) g.set(a, new Set())
    g.get(a)!.add(b)
  }
  for (const [a, b] of edges) { link(a, b); link(b, a) }
  return g
}

function sum(values: Iterable<number>): number {
  let s = 0
  for (const v of values) s += v
  return s
}

async function main(): Promise<void> {
  // ── Personalized PageRank: the computation ─────────────────────────
  console.log("\n── ppr: the PageRank computation ─────────────────────────")

  // Chain A — B — C, personalized entirely on A.
  const chain = graphOf([["A", "B"], ["B", "C"]])
  const r = personalizedPageRank(chain, new Map([["A", 1]]))
  assert(Math.abs(sum(r.values()) - 1) < 1e-6, "scores form a distribution (sum ≈ 1)")
  assert(
    r.get("C")! < r.get("A")! && r.get("C")! < r.get("B")!,
    "the most graph-distant node from the seed scores lowest",
  )
  assert(r.get("A")! > 0.15, "the seed retains at least its restart mass")
  assert(
    (r.get("C") ?? 0) > 0,
    "a two-hop node still gets a non-zero score — the multi-hop reach",
  )

  // A disconnected component gets none of the mass.
  const split = graphOf([["A", "B"], ["D", "E"]])
  const rSplit = personalizedPageRank(split, new Map([["A", 1]]))
  assert(
    (rSplit.get("D") ?? 0) < 1e-9 && (rSplit.get("E") ?? 0) < 1e-9,
    "a node unreachable from the seed set scores ~0",
  )
  assert((rSplit.get("B") ?? 0) > 0, "a reachable node in the seed's component scores > 0")

  // Determinism: identical inputs → identical outputs.
  const again = personalizedPageRank(chain, new Map([["A", 1]]))
  assert(
    [...r.keys()].every((k) => r.get(k) === again.get(k)),
    "the computation is deterministic — two runs are bit-identical",
  )

  // Degenerate inputs.
  assert(
    personalizedPageRank(chain, new Map()).size === 0,
    "empty personalization yields an empty result",
  )
  // A personalized node with no edges keeps its own mass (dangling).
  const lonely = personalizedPageRank(graphOf([["A", "B"]]), new Map([["Z", 1]]))
  assert((lonely.get("Z") ?? 0) > 0.99, "a seed file absent from the graph keeps its restart mass")

  // ── recall integration: multi-hop reach ───────────────────────────
  // Files alpha — beta — gamma form a co-change chain. Only alpha has
  // a textual match. One-hop reaches beta; PPR also reaches gamma.
  console.log("\n── ppr: recall integration (multi-hop reach) ─────────────")
  const root = await mkdtemp(join(tmpdir(), "diane-ppr-"))
  try {
    const repo = await MemoryRepository.load(root)
    repo.insert({
      category: "code-map",
      subject: "src/alpha.ts",
      content: "the alpha orchestrator — entry point zephyrqx",
      source: "test",
    })
    repo.insert({
      category: "code-map",
      subject: "src/beta.ts",
      content: "beta module — helper routines",
      source: "test",
    })
    repo.insert({
      category: "code-map",
      subject: "src/gamma.ts",
      content: "gamma module — utility routines",
      source: "test",
    })
    // Co-change edges: alpha↔beta and beta↔gamma (alpha and gamma are
    // NOT directly coupled — gamma is two hops from alpha).
    repo.insert({
      category: "git-history",
      subject: "co-change:src/alpha.ts",
      content: "src/alpha.ts and src/beta.ts changed together in 6 commits",
      tags: ["co-change", "src/alpha.ts", "src/beta.ts"],
      source: "test",
    })
    repo.insert({
      category: "git-history",
      subject: "co-change:src/beta.ts",
      content: "src/beta.ts and src/gamma.ts changed together in 5 commits",
      tags: ["co-change", "src/beta.ts", "src/gamma.ts"],
      source: "test",
    })

    const subjectsOf = (hits: Array<{ memory: { subject: string } }>): Set<string> =>
      new Set(hits.map((h) => h.memory.subject))

    // Default (PPR off): one hop only — beta is reached, gamma is not.
    const oneHop = repo.recall({ query: "zephyrqx", limit: 20 })
    const oneHopSubjects = subjectsOf(oneHop)
    assert(oneHopSubjects.has("src/alpha.ts"), "default: the textual hit (alpha) surfaces")
    assert(
      oneHopSubjects.has("src/beta.ts"),
      "default: the direct co-change neighbour (beta) surfaces",
    )
    assert(
      !oneHopSubjects.has("src/gamma.ts"),
      "default (one-hop): the two-hop file (gamma) is NOT reached",
    )

    // PPR on: the walk reaches gamma too.
    const ppr = repo.recall({ query: "zephyrqx", limit: 20, personalizedPageRank: true })
    const pprSubjects = subjectsOf(ppr)
    assert(
      pprSubjects.has("src/gamma.ts"),
      "PPR: the two-hop file (gamma) IS surfaced — the multi-hop reach",
    )
    assert(
      ppr[0]?.memory.subject === "src/alpha.ts",
      "PPR: the textual hit still ranks #1 — the boost stays bounded",
    )
    const betaRank = ppr.findIndex((h) => h.memory.subject === "src/beta.ts")
    const gammaRank = ppr.findIndex((h) => h.memory.subject === "src/gamma.ts")
    assert(
      betaRank >= 0 && gammaRank >= 0 && betaRank < gammaRank,
      "PPR: the one-hop file (beta) outranks the two-hop file (gamma)",
    )

    // Recall is deterministic with PPR on.
    const pprAgain = repo.recall({ query: "zephyrqx", limit: 20, personalizedPageRank: true })
    assert(
      ppr.length === pprAgain.length &&
        ppr.every((h, i) => h.memory.id === pprAgain[i]?.memory.id),
      "PPR recall is deterministic — two runs give the same ranking",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(2) })
