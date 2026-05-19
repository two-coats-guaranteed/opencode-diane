/**
 * BM25 retrieval over the in-memory inverted index.
 *
 * Hierarchical filtering: callers can narrow candidates by category
 * and/or subject before scoring. If neither filter is provided, all
 * docs that contain any query term are considered.
 *
 * k1=1.2, b=0.75 — standard defaults that work well on short docs.
 */

import type { Category, Memory, RecallHit } from "../types.js"
import { InvertedIndex } from "./inverted-index.js"
import { personalizedPageRank } from "./ppr.js"
import { tokenize } from "./tokenize.js"

const K1 = 1.2
const B = 0.75
/**
 * Fraction of a seed hit's BM25 score given to memories pulled in via
 * the co-change graph. Deliberately small (< 1): a co-change-surfaced
 * file always ranks below a direct textual match, but above nothing.
 */
const COCHANGE_BOOST = 0.25
/**
 * Only the top-N textual hits act as seeds for co-change propagation.
 * Keeps the boost focused on what the query actually matched and the
 * extra work bounded.
 */
const SEED_LIMIT = 5
/**
 * Per neighbour file, pull in at most this many memories (ranked by
 * useCount). Stops a hot file with hundreds of commit memories from
 * flooding the result set.
 */
const PROPAGATE_PER_FILE = 3

export interface SearchOptions {
  query: string
  category?: Category
  subject?: string
  /** Cap on returned hits (count). Default 10. */
  limit?: number
  /**
   * Optional pre-computed embedding of `query`. Supplied only when
   * semantic search is enabled — the async embedding is done by the
   * caller so the recall path itself stays synchronous. When present,
   * `recallDetailed` fuses vector similarity with the BM25 ranking;
   * when absent, retrieval is the pure lexical path. `search()` itself
   * ignores this field — fusion happens one level up, in the
   * repository.
   */
  queryVector?: Float32Array
  /**
   * Use Personalized PageRank for the co-change boost instead of the
   * default single-hop propagation. Default off (undefined / false).
   *
   * When on, the co-change graph contribution is computed as a
   * random-walk-with-restart personalized on the query's textual hits
   * — relevance spreads multi-hop and is graded by graph distance.
   * When off, retrieval uses the cheaper one-hop boost. See ppr.ts.
   */
  personalizedPageRank?: boolean
  /**
   * Optional ceiling on the *formatted* size of the result, in
   * estimated tokens. When set, ranked hits are packed until the next
   * hit would overflow; the rest are reported as omitted. This is the
   * Aider-style "the budget is the API" idea — recall output never
   * balloons unpredictably. ~4 chars/token, consistent with the rest
   * of the codebase.
   */
  tokenBudget?: number
  /**
   * Optional, agent-supplied intent lean. The agent calling recall has
   * already understood the user's request — in whatever natural
   * language — so `prefer` lets it pass that understanding through and
   * make ranking query-dependent:
   *   - "code"    — lean toward implementation; gently de-weight
   *                 memories whose path looks test-related
   *   - "tests"   — lean toward test files (when the user really is
   *                 asking about tests, that's exactly what's wanted)
   *   - "history" — lean toward change-history memories
   *   - "any" / omitted — neutral; ranking is unchanged
   * The lean is a mild score multiplier, deliberately never a filter:
   * a strongly-matching test file still surfaces under "code", only
   * lower. This keeps test de-emphasis query-dependent and reversible
   * rather than a blunt exclusion.
   */
  prefer?: "code" | "tests" | "history" | "any"
}

/** ~4 chars per token — the rough heuristic used throughout the plugin. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

/**
 * Pack ranked hits into a token budget. `format` renders one hit to
 * the string the agent will actually see, so the estimate matches the
 * real output. Always returns at least one hit (the top-ranked) even
 * if it alone exceeds the budget — an empty result would be worse
 * than a slightly-over one — but in that case the hit's `content` is
 * truncated so the budget stays a real ceiling rather than a wish.
 * Returns the (possibly content-truncated) kept hits and how many
 * were dropped.
 */
export function packToTokenBudget(
  hits: RecallHit[],
  budget: number,
  format: (h: RecallHit) => string
): { kept: RecallHit[]; omitted: number } {
  if (hits.length === 0) return { kept: [], omitted: 0 }
  const kept: RecallHit[] = []
  let used = 0
  for (const h of hits) {
    const cost = estimateTokens(format(h)) + 1 // +1 for the joining newline
    if (kept.length === 0 && cost > budget) {
      // Mandatory first hit overflows on its own — keep it, but trim
      // its content so the result still respects the ceiling. We trim
      // a shallow clone so the stored Memory object is untouched.
      const room = Math.max(40, budget) * 4 // budget back in chars
      const overhead = format(h).length - h.memory.content.length
      const contentRoom = Math.max(20, room - overhead)
      const trimmed: RecallHit = {
        score: h.score,
        memory: {
          ...h.memory,
          content:
            h.memory.content.length > contentRoom
              ? h.memory.content.slice(0, contentRoom - 1) + "…"
              : h.memory.content,
        },
      }
      kept.push(trimmed)
      break
    }
    if (kept.length > 0 && used + cost > budget) break
    kept.push(h)
    used += cost
  }
  return { kept, omitted: hits.length - kept.length }
}

export function search(
  index: InvertedIndex,
  byId: Map<string, Memory>,
  opts: SearchOptions
): RecallHit[] {
  const queryTokens = tokenize(opts.query)
  if (queryTokens.length === 0) return []
  const limit = opts.limit ?? 10

  // 1) Compute candidate set: union of postings for query terms,
  //    further intersected with category/subject filters if any.
  const candidates = new Set<string>()
  for (const token of queryTokens) {
    const ids = index.postings.get(token)
    if (!ids) continue
    for (const id of ids) candidates.add(id)
  }
  if (opts.category) intersectInPlace(candidates, index.byCategory.get(opts.category))
  if (opts.subject) intersectInPlace(candidates, index.bySubject.get(opts.subject))
  if (candidates.size === 0) return []

  // 2) Compute IDF for each unique query term.
  const N = index.docCount || 1
  const idf = new Map<string, number>()
  const uniqueQueryTokens = Array.from(new Set(queryTokens))
  for (const t of uniqueQueryTokens) {
    const df = index.postings.get(t)?.size ?? 0
    // BM25+ style: log((N - df + 0.5) / (df + 0.5) + 1) — always positive.
    idf.set(t, Math.log((N - df + 0.5) / (df + 0.5) + 1))
  }

  // 3) Score each candidate.
  const avgdl = index.avgDocLength() || 1
  const scoreById = new Map<string, number>()
  for (const id of candidates) {
    const doc = index.docs.get(id)
    const mem = byId.get(id)
    if (!doc || !mem) continue
    let score = 0
    for (const t of uniqueQueryTokens) {
      const tf = doc.tf.get(t) ?? 0
      if (tf === 0) continue
      const wt = idf.get(t) ?? 0
      const num = tf * (K1 + 1)
      const denom = tf + K1 * (1 - B + (B * doc.length) / avgdl)
      score += wt * (num / denom)
    }
    // Small recency / popularity bias so that all-else-equal we return
    // recently-touched and frequently-used entries first.
    score += Math.log1p(mem.useCount) * 0.05
    if (score > 0) scoreById.set(id, score)
  }

  // 3b) Co-change graph boost — the Aider PageRank idea.
  //     A well-scoring memory about file X *pulls in* memories about
  //     files X is historically modified together with, even when
  //     those files don't textually match the query — surfacing
  //     structurally-related context the query alone would miss.
  //
  //     Two strategies, selected by `opts.personalizedPageRank`:
  //       - default (off): ONE HOP — boost the direct co-change
  //         neighbours of the top textual hits. O(seeds × neighbours),
  //         fully inspectable.
  //       - on: PERSONALIZED PAGERANK — a restart-biased random walk
  //         over the whole co-change graph, so relevance reaches
  //         multi-hop files, graded by graph distance.
  //
  //     Either way it is bounded and low-scored so it can't drown
  //     direct matches: only the top SEED_LIMIT textual hits seed it,
  //     each file contributes ≤ PROPAGATE_PER_FILE memories (most-used
  //     first), and a pulled-in hit always ranks below a real textual
  //     match.
  if (scoreById.size > 0 && index.coChange.size > 0) {
    const seeds = Array.from(scoreById.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, SEED_LIMIT)
    if (opts.personalizedPageRank) {
      applyPprBoost(index, byId, scoreById, seeds)
    } else {
      applyOneHopBoost(index, byId, scoreById, seeds)
    }
  }

  // 3c) Intent lean — query-dependent and agent-supplied. Applied
  //     last, as a *mild* multiplier, so it nudges ranking without
  //     ever filtering: a much stronger match still wins regardless of
  //     `prefer`. This is why test de-emphasis here is safe — a query
  //     that genuinely wants tests still gets them.
  if (opts.prefer && opts.prefer !== "any") {
    for (const [id, s] of scoreById) {
      const mem = byId.get(id)
      if (!mem) continue
      const m = preferMultiplier(opts.prefer, mem)
      if (m !== 1) scoreById.set(id, s * m)
    }
  }

  const hits: RecallHit[] = []
  for (const [id, score] of scoreById) {
    const mem = byId.get(id)
    if (mem) hits.push({ memory: mem, score })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

/**
 * Whether a memory's subject path looks test-related. Deliberately
 * minimal and language-neutral: it asks only whether the *word*
 * "test"/"tests" appears as a token of the path. The plugin's own
 * tokenizer extracts that word equally from a `test/` directory, a
 * `_test.go` / `.test.ts` filename, or a `test_x.py` one — so this is
 * one universal signal, not a per-ecosystem catalogue to overfit. It
 * checks tokens, not substrings, so `latest`, `contest`, `testimony`
 * are not mistaken for tests.
 */
/**
 * One-hop co-change boost (the default). Lifts memories about the
 * direct co-change neighbours of the seed files: a neighbour memory's
 * score is raised to `seedScore × COCHANGE_BOOST`, never above its own
 * textual score, and at most `PROPAGATE_PER_FILE` memories per file.
 */
function applyOneHopBoost(
  index: InvertedIndex,
  byId: Map<string, Memory>,
  scoreById: Map<string, number>,
  seeds: Array<[string, number]>
): void {
  for (const [seedId, seedScore] of seeds) {
    const seedMem = byId.get(seedId)
    if (!seedMem) continue
    const seedFile = fileOfSubject(seedMem.subject)
    if (!seedFile) continue
    const neighbors = index.coChangeNeighbors(seedFile)
    if (!neighbors) continue
    for (const neighborFile of neighbors) {
      const memIds = index.bySubject.get(neighborFile)
      if (!memIds) continue
      // Most-used memories about the neighbour file first.
      const ranked = Array.from(memIds)
        .map((id) => byId.get(id))
        .filter((m): m is Memory => m !== undefined)
        .sort((a, b) => b.useCount - a.useCount)
        .slice(0, PROPAGATE_PER_FILE)
      const propagated = seedScore * COCHANGE_BOOST
      for (const m of ranked) {
        const current = scoreById.get(m.id) ?? 0
        // Never lower an existing (textual) score; only lift.
        if (propagated > current) scoreById.set(m.id, propagated)
      }
    }
  }
}

/**
 * Personalized PageRank co-change boost (opt-in). Runs a
 * restart-biased random walk over the whole co-change graph, seeded on
 * the textual hits, and lifts memories about every file the walk
 * reaches — graded by the walk's stationary score, so a direct
 * neighbour is lifted more than a two-hop file. Bounded: the boost is
 * scaled so the most-central file receives at most
 * `topSeedScore × COCHANGE_BOOST`, keeping any pulled-in hit below the
 * strongest textual match.
 */
function applyPprBoost(
  index: InvertedIndex,
  byId: Map<string, Memory>,
  scoreById: Map<string, number>,
  seeds: Array<[string, number]>
): void {
  // Personalization vector: each seed's file, weighted by its BM25 score.
  const personalization = new Map<string, number>()
  for (const [id, score] of seeds) {
    const file = fileOfSubject(byId.get(id)?.subject ?? "")
    if (file) personalization.set(file, (personalization.get(file) ?? 0) + score)
  }
  if (personalization.size === 0) return

  const ppr = personalizedPageRank(index.coChange, personalization)
  let maxScore = 0
  for (const v of ppr.values()) if (v > maxScore) maxScore = v
  if (maxScore <= 0) return

  // Scale so the most-central file gets at most topSeedScore × COCHANGE_BOOST.
  const topSeedScore = seeds[0][1]
  for (const [file, prob] of ppr) {
    const boost = (prob / maxScore) * topSeedScore * COCHANGE_BOOST
    if (boost <= 1e-9) continue
    const memIds = index.bySubject.get(file)
    if (!memIds) continue
    const ranked = Array.from(memIds)
      .map((id) => byId.get(id))
      .filter((m): m is Memory => m !== undefined)
      .sort((a, b) => b.useCount - a.useCount)
      .slice(0, PROPAGATE_PER_FILE)
    for (const m of ranked) {
      // Additive: the stationary score already aggregates every path
      // from every seed, so PPR lifts each file once, on top of any
      // textual score that memory already has.
      scoreById.set(m.id, (scoreById.get(m.id) ?? 0) + boost)
    }
  }
}

function subjectLooksLikeTest(subject: string): boolean {
  for (const tok of tokenize(subject)) {
    if (tok === "test" || tok === "tests") return true
  }
  return false
}

/**
 * The mild, query-dependent ranking lean for `prefer`. Multipliers are
 * gentle constants by design — a nudge, not a gate — and are not tuned
 * to any particular repository.
 */
function preferMultiplier(
  prefer: "code" | "tests" | "history",
  mem: Memory
): number {
  const isTest = subjectLooksLikeTest(mem.subject)
  if (prefer === "tests") return isTest ? 1.5 : 1.0
  if (prefer === "history") return mem.category === "git-history" ? 1.3 : 1.0
  // prefer === "code": lean toward structural code, away from tests.
  let m = mem.category === "code-map" ? 1.25 : 1.0
  if (isTest) m *= 0.6
  return m
}

/**
 * Extract the file path a memory's subject is "about", or null.
 * Commit memories use the bare path as subject; co-change and churn
 * memories prefix it (`co-change:foo`, `churn:foo`). Tree-style
 * placeholders (`tree:abc1234`) and non-file subjects return null.
 */
function fileOfSubject(subject: string): string | null {
  if (subject.startsWith("co-change:")) return subject.slice("co-change:".length)
  if (subject.startsWith("churn:")) return subject.slice("churn:".length)
  if (subject.startsWith("tree:")) return null
  if (subject.startsWith("recency:")) return null
  if (subject.includes(":")) return null // other category-prefixed subjects
  return subject || null
}

function intersectInPlace(
  target: Set<string>,
  other: Set<string> | undefined
): void {
  if (!other) {
    target.clear()
    return
  }
  for (const id of target) if (!other.has(id)) target.delete(id)
}
