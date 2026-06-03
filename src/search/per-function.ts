/**
 * per-function.ts — per-function embedding support for the semantic
 * ("meaning") recall path.
 *
 * WHY THIS EXISTS (measured): diane's semantic index currently embeds one
 * vector per file (the code-map memory: a path + a flat list of signatures).
 * Offline ranking evaluation showed that representation is weak — a single
 * vector averages a whole file, so a query that matches ONE function is
 * diluted by everything else in the file. Embedding each function separately
 * and scoring a file by the MAX similarity over its functions was 2x better on
 * requests and ~5x better on seaborn (where whole-file embedding had collapsed
 * to R@5 0.11), and rrf(history, per-function) beat bm25+history on seaborn
 * outright and on MRR for requests. See RESULTS.md ("per-function embedding").
 *
 * STATUS: the mechanism here is unit-tested with stub vectors. It is gated
 * behind `semanticPerFunction` (default OFF) and is NOT yet validated
 * end-to-end with diane's live embedder (e5) inside the agent loop — that
 * needs API/agent runs that weren't available when this landed. The offline
 * win used a code-specialised embedder (jina-code); per-function with e5
 * specifically is unverified. Enable only to evaluate.
 *
 * This module is pure (no I/O, no embedder): it turns extracted definition
 * spans into per-function chunk texts, and max-pools per-function similarities
 * back to a per-memory score. The embedding and storage live in the existing
 * vector store; the integration point is documented in repository.ts.
 */

/** A single embeddable code chunk, tied to the memory (file) it belongs to. */
export interface FunctionChunk {
  /** The memory id this chunk belongs to (the file-level code-map memory). */
  memoryId: string
  /** The text to embed: a function's signature + a slice of its body. */
  text: string
}

/** A definition span as produced by the code-map signature extractor. */
export interface DefSpan {
  /** Symbol name (function/class/method). */
  name: string
  /** 1-based start line in the source. */
  startLine: number
  /** 1-based end line (inclusive); may be undefined for single-line defs. */
  endLine?: number
}

/**
 * Build per-function chunk texts for one file. Each chunk is the definition's
 * name + the source lines from its start to `min(end, start + maxBodyLines)`,
 * prefixed with the file path so the embedder has file context. Falls back to
 * a single whole-file chunk when no spans are given, so callers always get at
 * least one chunk (and the per-function path degrades to the current
 * whole-file behaviour rather than dropping the file from the index).
 */
export function buildFunctionChunks(
  memoryId: string,
  relPath: string,
  source: string,
  spans: DefSpan[],
  opts: { maxBodyLines?: number; maxChunkChars?: number; maxChunks?: number } = {}
): FunctionChunk[] {
  const maxBody = opts.maxBodyLines ?? 24
  const maxChars = opts.maxChunkChars ?? 1200
  const maxChunks = opts.maxChunks ?? 40
  const lines = source.split("\n")
  if (spans.length === 0) {
    return [{ memoryId, text: `${relPath}\n${source}`.slice(0, maxChars) }]
  }
  const chunks: FunctionChunk[] = []
  for (const span of spans.slice(0, maxChunks)) {
    const lo = Math.max(0, span.startLine - 1)
    const hi = Math.min(lines.length, (span.endLine ?? span.startLine) , lo + maxBody)
    const body = lines.slice(lo, Math.max(hi, lo + 1)).join("\n")
    chunks.push({ memoryId, text: `${relPath} ${span.name}\n${body}`.slice(0, maxChars) })
  }
  return chunks
}

/** A scored chunk: its memory id and the chunk's similarity to the query. */
export interface ScoredChunk {
  memoryId: string
  score: number
}

/**
 * Max-pool per-function similarities to a per-memory score: each memory's
 * score is the highest similarity among its chunks. This is the core of the
 * per-function win — a file is as relevant as its single most relevant
 * function, not its average. Returns memory ids ranked by that max, highest
 * first.
 *
 * With exactly one chunk per memory (the current whole-file indexing), this is
 * an identity over the input scores — so it is a safe generalisation of the
 * existing behaviour.
 */
export function maxPoolByMemory(scored: ScoredChunk[]): Array<{ id: string; score: number }> {
  const best = new Map<string, number>()
  for (const { memoryId, score } of scored) {
    const cur = best.get(memoryId)
    if (cur === undefined || score > cur) best.set(memoryId, score)
  }
  return [...best.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
}

/**
 * Reorder the candidate items within the top `windowSize` positions by
 * `scoreOf` (descending), leaving non-candidate items and everything past the
 * window exactly where they were.
 *
 * Because only positions [0, windowSize) are permuted, the *set* of items in
 * the top N is unchanged for every N >= windowSize — so this cannot reduce
 * Recall@N for N >= windowSize. With windowSize 3 it sharpens which file lands
 * at #1 while provably preserving Recall@3/@5/@10. This is the measured R@1
 * lever (offline: +32% R@1 on requests at zero R@5 cost); full-list reranking,
 * by contrast, *did* cost R@5. Items for which `scoreOf` returns undefined keep
 * their slot (they are not reordered).
 */
export function rerankWindowByScore<T>(
  order: T[],
  windowSize: number,
  isCandidate: (item: T) => boolean,
  scoreOf: (item: T) => number | undefined
): T[] {
  const W = Math.min(windowSize, order.length)
  const positions: number[] = []
  for (let i = 0; i < W; i++) {
    if (isCandidate(order[i]) && scoreOf(order[i]) !== undefined) positions.push(i)
  }
  if (positions.length < 2) return order.slice()
  const picked = positions.map((p) => order[p])
  picked.sort((a, b) => (scoreOf(b) as number) - (scoreOf(a) as number))
  const out = order.slice()
  positions.forEach((p, k) => {
    out[p] = picked[k]
  })
  return out
}

