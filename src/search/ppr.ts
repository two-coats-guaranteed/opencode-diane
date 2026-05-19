/**
 * ppr.ts — Personalized PageRank over the co-change graph.
 *
 * The default co-change boost (bm25.ts step 3b) is a single hop: a
 * textual hit about file X lifts memories about X's *direct* co-change
 * neighbours, and stops there. Personalized PageRank generalises that
 * to the whole graph — a random walk with restart, where the restart
 * (teleport) distribution is concentrated on the query's textual hits.
 * Relevance then spreads across multiple hops and is graded by how
 * reachable each file is from that seed set: a direct neighbour scores
 * higher than a two-hop file, which still scores above an unrelated
 * one.
 *
 * This is opt-in (`personalizedPageRank`, default off). When off,
 * retrieval uses the cheaper one-hop boost and this file is never
 * reached — so the default path keeps its O(seeds × neighbours) cost
 * and its full inspectability.
 *
 * Deterministic: a fixed teleport probability, a fixed node-iteration
 * order, and a fixed convergence tolerance with an iteration cap mean
 * the same graph and personalization always yield the same scores.
 */

export interface PprOptions {
  /** Teleport / restart probability. Default 0.15 (i.e. 0.85 damping). */
  alpha?: number
  /** Hard cap on power-iteration steps. Default 60. */
  maxIterations?: number
  /** L1 convergence threshold — stop once the score vector barely moves. Default 1e-7. */
  tolerance?: number
  /** Safety valve: return empty (skip PPR) if the graph exceeds this node count. Default 100000. */
  maxNodes?: number
}

/**
 * Personalized PageRank over an undirected, unweighted graph.
 *
 * @param graph           adjacency: node → set of neighbour nodes
 * @param personalization restart distribution: node → weight. Weights
 *                        need not be normalised; non-positive weights
 *                        are ignored.
 * @returns node → stationary score, summing to ~1. Empty when the
 *          personalization carries no mass, the graph is empty, or the
 *          graph exceeds `maxNodes`.
 */
export function personalizedPageRank(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  personalization: ReadonlyMap<string, number>,
  options: PprOptions = {}
): Map<string, number> {
  const alpha = options.alpha ?? 0.15
  const maxIterations = options.maxIterations ?? 60
  const tolerance = options.tolerance ?? 1e-7
  const maxNodes = options.maxNodes ?? 100_000

  // ── node set: every graph node, plus every personalized node ─────
  // A personalized file with no co-change history still belongs in the
  // walk — it just becomes a dangling node holding its restart mass.
  const idOf = new Map<string, number>()
  const nodes: string[] = []
  const intern = (name: string): number => {
    let i = idOf.get(name)
    if (i === undefined) {
      i = nodes.length
      idOf.set(name, i)
      nodes.push(name)
    }
    return i
  }
  for (const [node, neighbours] of graph) {
    intern(node)
    for (const nb of neighbours) intern(nb)
  }
  for (const node of personalization.keys()) intern(node)

  const n = nodes.length
  if (n === 0 || n > maxNodes) return new Map()

  // ── personalization vector p, normalised to sum 1 ────────────────
  const p = new Float64Array(n)
  let pTotal = 0
  for (const [node, weight] of personalization) {
    if (weight > 0) {
      p[idOf.get(node)!] += weight
      pTotal += weight
    }
  }
  if (pTotal === 0) return new Map() // nothing to personalize toward
  for (let i = 0; i < n; i++) p[i] /= pTotal

  // ── adjacency as integer arrays (fixed, deterministic order) ─────
  const adj: number[][] = nodes.map(() => [])
  for (const [node, neighbours] of graph) {
    const j = idOf.get(node)!
    for (const nb of neighbours) adj[j].push(idOf.get(nb)!)
  }

  // ── power iteration with dangling-mass redistribution ────────────
  //   r_new[i] = (α + (1-α)·danglingMass)·p[i]  +  (1-α)·Σ_{j→i} r[j]/deg(j)
  // A dangling node (no out-edges) would otherwise leak probability;
  // sending its mass back through p keeps Σr = 1 every iteration.
  let r = Float64Array.from(p)
  let next = new Float64Array(n)
  for (let iter = 0; iter < maxIterations; iter++) {
    let dangling = 0
    for (let i = 0; i < n; i++) if (adj[i].length === 0) dangling += r[i]
    const base = alpha + (1 - alpha) * dangling
    for (let i = 0; i < n; i++) next[i] = base * p[i]
    for (let j = 0; j < n; j++) {
      const out = adj[j]
      if (out.length === 0) continue
      const share = ((1 - alpha) * r[j]) / out.length
      for (const i of out) next[i] += share
    }
    let delta = 0
    for (let i = 0; i < n; i++) delta += Math.abs(next[i] - r[i])
    const swap = r
    r = next
    next = swap
    if (delta < tolerance) break
  }

  const result = new Map<string, number>()
  for (let i = 0; i < n; i++) result.set(nodes[i], r[i])
  return result
}
