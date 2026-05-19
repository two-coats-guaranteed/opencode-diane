/**
 * embedder.ts — the small, dependency-free core of optional semantic
 * search: the `Embedder` contract, vector math, and reciprocal-rank
 * fusion.
 *
 * Nothing here imports a model runtime. The real e5 implementation
 * lives in `e5-embedder.ts` and is only loaded when semantic search is
 * switched on; tests substitute a deterministic stub. Keeping the
 * contract and the math here means the fusion/retrieval logic is
 * unit-testable without downloading a 100 MB model.
 */

/**
 * Turns text into a vector. e5 expects asymmetric prefixes — a query
 * and the passage it should match are embedded differently — so the
 * contract has two methods rather than one.
 */
export interface Embedder {
  /** Stable model identifier, e.g. "Xenova/multilingual-e5-small". */
  readonly id: string
  /** Embed a search query. */
  embedQuery(text: string): Promise<Float32Array>
  /** Embed a batch of documents/passages. */
  embedPassages(texts: string[]): Promise<Float32Array[]>
}

/**
 * Default embedding model — small (~120 MB quantized), ~384-dim, and
 * trained on 100+ languages, which is what makes cross-lingual recall
 * (a query in one language, code/comments in another) work.
 */
export const DEFAULT_EMBEDDING_MODEL = "Xenova/multilingual-e5-small"

/** L2-normalise a vector in place and return it. A zero vector is left as-is. */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const norm = Math.sqrt(sum)
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) v[i] /= norm
  }
  return v
}

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0
 * on a length mismatch or a zero vector rather than NaN — a recall
 * must never crash on a malformed vector.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

/** Dot product — equals cosine similarity when both vectors are L2-normalised. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let d = 0
  for (let i = 0; i < a.length; i++) d += a[i] * b[i]
  return d
}

/** An id with a fused score, highest first. */
export interface FusedItem {
  id: string
  score: number
}

/**
 * Reciprocal-rank fusion of several ranked id-lists into one ranking.
 *
 *   score(id) = Σ_lists 1 / (k + rank_in_list)      rank is 1-based
 *
 * RRF is the standard way to merge a lexical (BM25) ranking with a
 * semantic (vector) ranking: it needs no score calibration between the
 * two — only the *positions* — and `k` (60 by convention) damps the
 * influence of low ranks. An id absent from a list simply contributes
 * nothing for that list. Deterministic; ties broken by first
 * appearance so the result is stable.
 */
export function reciprocalRankFusion(lists: string[][], k = 60): FusedItem[] {
  const score = new Map<string, number>()
  const firstSeen = new Map<string, number>()
  let order = 0
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1))
      if (!firstSeen.has(id)) firstSeen.set(id, order++)
    }
  }
  return [...score.entries()]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score || (firstSeen.get(a.id)! - firstSeen.get(b.id)!))
}
