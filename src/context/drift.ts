/**
 * drift.ts — online goal-shift detection for a live conversation.
 *
 * Detects when the conversation's goal has shifted significantly, so the
 * context manager can compress the now-stale span (and later re-insert it
 * if the goal drifts back). This is the "trigger" half of a Memex-style
 * indexed-memory loop (Yang et al., 2026): a cheap, per-turn signal that
 * decides when to archive context, kept deliberately separate from the
 * (more dangerous) act of mutating the live message list.
 *
 * Two backends, same contract:
 *
 *   - LexicalDriftDetector — token-overlap cosine over a running bag of
 *     terms. Zero dependencies, always available. Strong in the coding
 *     domain specifically, where a goal change (auth refactor → CI debug)
 *     drags a large vocabulary change with it (filenames, identifiers,
 *     error strings). This is TextTiling's lexical-cohesion idea
 *     (Hearst 1997) applied online to one turn at a time.
 *
 *   - EmbeddingDriftDetector — cosine of the e5 turn embedding against a
 *     running segment centroid. More robust to paraphrase; only available
 *     when semantic search is enabled (diane already loads the model
 *     there). Mirrors production embedding-drift routers (e.g. DriftOS).
 *
 * Both maintain a *centroid* of the current segment and fire a shift when
 * a new turn's similarity to that centroid drops below `driftThreshold`,
 * subject to `minSegmentTurns` hysteresis so a single off-topic aside
 * doesn't thrash the segmentation. On a shift the centroid resets to the
 * new turn.
 *
 * Nothing here mutates conversation state — `observe()` returns a verdict
 * and updates only the detector's own running centroid.
 */

// ── shared contract ─────────────────────────────────────────────────────

export interface DriftVerdict {
  /** True when this turn begins a new goal/topic segment. */
  shifted: boolean
  /** Cosine similarity of this turn to the current segment centroid
   *  (1 = identical direction, 0 = orthogonal). NaN for the first turn. */
  similarity: number
  /** How many turns the now-closed segment ran for (0 if no shift). */
  closedSegmentTurns: number
}

export interface DriftDetector {
  /** Feed the next turn's text; get a shift verdict. */
  observe(text: string): DriftVerdict
  /** Turns observed in the current (open) segment. */
  readonly segmentTurns: number
  /** Reset to empty (e.g. new session). */
  reset(): void
}

export interface DriftConfig {
  /** Similarity at or below which a turn counts as a new segment.
   *  Lexical default 0.20; embedding default 0.55 (cosine scales differ). */
  driftThreshold: number
  /** Minimum turns in a segment before another shift can fire — prevents
   *  a single tangential turn from fragmenting the conversation. */
  minSegmentTurns: number
}

// ── lexical backend ──────────────────────────────────────────────────────

/** Tokenize to lowercase alphanumeric terms ≥ 3 chars, split on
 *  snake_case / camelCase so code identifiers contribute their parts. */
export function tokenizeTerms(text: string): string[] {
  const out: string[] = []
  // split camelCase, then lowercase, then pull alnum runs
  const decamel = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  for (const raw of decamel.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length >= 3) out.push(raw)
  }
  return out
}

export class LexicalDriftDetector implements DriftDetector {
  private centroid = new Map<string, number>()  // term → summed count
  private turns = 0

  constructor(private readonly config: DriftConfig) {}

  get segmentTurns(): number {
    return this.turns
  }

  reset(): void {
    this.centroid = new Map()
    this.turns = 0
  }

  observe(text: string): DriftVerdict {
    const counts = new Map<string, number>()
    for (const t of tokenizeTerms(text)) {
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }

    // First turn of a segment: seed the centroid, no shift.
    if (this.turns === 0) {
      this.centroid = counts
      this.turns = 1
      return { shifted: false, similarity: Number.NaN, closedSegmentTurns: 0 }
    }

    const sim = cosineCounts(counts, this.centroid)
    const canShift = this.turns >= this.config.minSegmentTurns
    if (canShift && sim <= this.config.driftThreshold) {
      const closed = this.turns
      this.centroid = counts   // new segment seeded by this turn
      this.turns = 1
      return { shifted: true, similarity: sim, closedSegmentTurns: closed }
    }

    // Same segment: fold this turn into the centroid.
    for (const [t, c] of counts) {
      this.centroid.set(t, (this.centroid.get(t) ?? 0) + c)
    }
    this.turns += 1
    return { shifted: false, similarity: sim, closedSegmentTurns: 0 }
  }
}

function cosineCounts(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (const v of a.values()) na += v * v
  for (const v of b.values()) nb += v * v
  // iterate the smaller map for the dot product
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const [k, v] of small) {
    const w = big.get(k)
    if (w !== undefined) dot += v * w
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ── embedding backend ────────────────────────────────────────────────────

/** Minimal embedding contract — matches the project's Embedder.embedQuery
 *  but is declared locally so this module has no hard import dependency on
 *  the e5 runtime (and so tests can pass a deterministic stub). */
export interface TurnEmbedder {
  embedQuery(text: string): Promise<Float32Array>
}

export class EmbeddingDriftDetector {
  private centroid: Float32Array | null = null
  private turns = 0

  constructor(
    private readonly embedder: TurnEmbedder,
    private readonly config: DriftConfig,
  ) {}

  get segmentTurns(): number {
    return this.turns
  }

  reset(): void {
    this.centroid = null
    this.turns = 0
  }

  /** Async because embedding is async. Same verdict contract. */
  async observe(text: string): Promise<DriftVerdict> {
    const vec = await this.embedder.embedQuery(text)

    if (this.turns === 0 || this.centroid === null) {
      this.centroid = Float32Array.from(vec)
      this.turns = 1
      return { shifted: false, similarity: Number.NaN, closedSegmentTurns: 0 }
    }

    const sim = cosineVec(vec, this.centroid)
    const canShift = this.turns >= this.config.minSegmentTurns
    if (canShift && sim <= this.config.driftThreshold) {
      const closed = this.turns
      this.centroid = Float32Array.from(vec)
      this.turns = 1
      return { shifted: true, similarity: sim, closedSegmentTurns: closed }
    }

    // Running mean: centroid = (centroid*n + vec) / (n+1)
    const n = this.turns
    for (let i = 0; i < this.centroid.length; i++) {
      this.centroid[i] = (this.centroid[i] * n + vec[i]) / (n + 1)
    }
    this.turns += 1
    return { shifted: false, similarity: sim, closedSegmentTurns: 0 }
  }

  /** Current segment centroid (copy), for archival/recall similarity. */
  centroidCopy(): Float32Array | null {
    return this.centroid ? Float32Array.from(this.centroid) : null
  }
}

export function cosineVec(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
