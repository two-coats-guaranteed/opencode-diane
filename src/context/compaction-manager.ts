/**
 * compaction-manager.ts — per-session orchestration of the Memex loop:
 * detect goal shift → archive (mask) the stale segment's observations →
 * re-insert an archived segment's observations when the goal drifts back.
 *
 * This is the stateful glue between the pure detector (drift.ts) and the
 * pure transforms (compactor.ts). It owns one record per session and is
 * driven entirely from the `experimental.chat.messages.transform` hook.
 *
 * The hook hands us the full message list every request. On each call we:
 *   1. find the latest user turn and run the drift detector on it;
 *   2. if the goal shifted, archive the just-closed segment — mask its
 *      tool observations and stash the originals under the segment's
 *      centroid (the Memex "index");
 *   3. check whether this new turn is similar to any *archived* segment;
 *      if so, "dereference" it — restore its observations into the live
 *      list (re-insertion), because the conversation has returned to it.
 *
 * Everything is best-effort and wrapped by the caller: a failure here must
 * never break the conversation. Default-off; only constructed when the
 * feature flag is set.
 */

import {
  LexicalDriftDetector,
  EmbeddingDriftDetector,
  cosineVec,
  tokenizeTerms,
  type DriftConfig,
  type TurnEmbedder,
} from "./drift.js"
import {
  maskObservations,
  restoreObservations,
  estimatedTokensSaved,
  type MsgLike,
  type StashEntry,
} from "./compactor.js"

export interface CompactionConfig extends DriftConfig {
  /** Don't compact until the conversation has at least this many messages —
   *  short sessions have nothing worth archiving. */
  minMessagesToCompact: number
  /** Minimum tool-output size (chars) to bother masking. */
  minObservationChars: number
  /** Similarity at/above which an archived segment is considered "returned
   *  to" and its observations are re-inserted. */
  recallThreshold: number
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  // Lexical defaults (used when no embedder is supplied).
  driftThreshold: 0.20,
  minSegmentTurns: 2,
  minMessagesToCompact: 8,
  minObservationChars: 400,
  recallThreshold: 0.45,
}

/** One archived (compacted) segment: its centroid index + masked stash. */
interface ArchivedSegment {
  /** Lexical centroid (term→count) OR embedding centroid, by backend. */
  lexicalCentroid?: Map<string, number>
  vectorCentroid?: Float32Array
  stash: StashEntry[]
  restored: boolean
}

interface SessionState {
  lexical?: LexicalDriftDetector
  embedding?: EmbeddingDriftDetector
  archives: ArchivedSegment[]
  // running lexical centroid mirror for archival when using lexical backend
  // (the detector keeps its own; we snapshot at shift time)
  lastTurnTerms?: Map<string, number>
  /** How many user turns we've already fed the detector (so each
   *  transform only observes genuinely new turns, in order). */
  observedUserCount: number
}

export interface CompactionResult {
  shifted: boolean
  masked: number
  restored: number
  tokensSaved: number
  similarity: number
}

const NOOP: CompactionResult = {
  shifted: false, masked: 0, restored: 0, tokensSaved: 0, similarity: Number.NaN,
}

export class CompactionManager {
  private sessions = new Map<string, SessionState>()

  constructor(
    private readonly config: CompactionConfig,
    /** Optional embedder; when present the embedding backend is used. */
    private readonly embedder?: TurnEmbedder,
  ) {}

  /** Drop a session's state (e.g. on session end). */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private stateFor(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId)
    if (!s) {
      s = { archives: [], observedUserCount: 0 }
      if (this.embedder) {
        s.embedding = new EmbeddingDriftDetector(this.embedder, this.config)
      } else {
        s.lexical = new LexicalDriftDetector(this.config)
      }
      this.sessions.set(sessionId, s)
    }
    return s
  }

  /**
   * Process one transform-hook invocation. Mutates `messages` in place
   * (masking / restoring). Returns what it did. Async because the
   * embedding backend embeds the latest turn.
   */
  async onTransform(sessionId: string, messages: MsgLike[]): Promise<CompactionResult> {
    if (!Array.isArray(messages) || messages.length < this.config.minMessagesToCompact) {
      return NOOP
    }

    const userTexts = allUserTexts(messages)
    if (userTexts.length === 0) return NOOP

    const state = this.stateFor(sessionId)
    // Observe any user turns we haven't seen yet (catch-up on first call,
    // then exactly one new turn per subsequent call). Only the LATEST
    // turn's verdict drives masking/restoration; earlier turns just prime
    // the detector's segment centroid.
    const start = Math.min(state.observedUserCount, userTexts.length)
    if (start >= userTexts.length) return NOOP  // nothing new this call

    // The boundary for masking is "everything before the latest user turn".
    const boundary = lastUserIndex(messages)

    let result: CompactionResult = NOOP
    if (state.embedding) {
      result = await this.viaEmbedding(state, messages, userTexts, start, boundary)
    } else {
      result = this.viaLexical(state, messages, userTexts, start, boundary)
    }
    state.observedUserCount = userTexts.length
    return result
  }

  // ── lexical path ───────────────────────────────────────────────────────
  private viaLexical(
    state: SessionState,
    messages: MsgLike[],
    userTexts: string[],
    start: number,
    boundary: number,
  ): CompactionResult {
    const det = state.lexical!
    let verdict = { shifted: false, similarity: Number.NaN, closedSegmentTurns: 0 }
    let prevTerms = state.lastTurnTerms
    for (let i = start; i < userTexts.length; i++) {
      prevTerms = state.lastTurnTerms
      verdict = det.observe(userTexts[i])
      state.lastTurnTerms = termCounts(userTexts[i])
    }
    const turnTerms = termCounts(userTexts[userTexts.length - 1])

    let masked = 0
    let restored = 0
    let tokensSaved = 0

    if (verdict.shifted) {
      const stash = maskObservations(messages, boundary, {
        minChars: this.config.minObservationChars,
      })
      if (stash.length > 0) {
        state.archives.push({
          lexicalCentroid: prevTerms ?? turnTerms,
          stash,
          restored: false,
        })
        masked = stash.length
        tokensSaved = estimatedTokensSaved(stash)
      }
      restored = this.maybeRestoreLexical(state, messages, turnTerms)
    }

    return { shifted: verdict.shifted, masked, restored, tokensSaved, similarity: verdict.similarity }
  }

  private maybeRestoreLexical(
    state: SessionState,
    messages: MsgLike[],
    turnTerms: Map<string, number>,
  ): number {
    let restored = 0
    for (const arc of state.archives) {
      if (arc.restored || !arc.lexicalCentroid) continue
      const sim = cosineCountsLocal(turnTerms, arc.lexicalCentroid)
      if (sim >= this.config.recallThreshold) {
        restored += restoreObservations(messages, arc.stash)
        arc.restored = true
      }
    }
    return restored
  }

  // ── embedding path ───────────────────────────────────────────────────
  private async viaEmbedding(
    state: SessionState,
    messages: MsgLike[],
    userTexts: string[],
    start: number,
    boundary: number,
  ): Promise<CompactionResult> {
    const det = state.embedding!
    let verdict = { shifted: false, similarity: Number.NaN, closedSegmentTurns: 0 }
    let centroidBefore = det.centroidCopy()
    for (let i = start; i < userTexts.length; i++) {
      centroidBefore = det.centroidCopy()
      verdict = await det.observe(userTexts[i])
    }

    let masked = 0
    let restored = 0
    let tokensSaved = 0

    if (verdict.shifted) {
      const stash = maskObservations(messages, boundary, {
        minChars: this.config.minObservationChars,
      })
      if (stash.length > 0 && centroidBefore) {
        state.archives.push({ vectorCentroid: centroidBefore, stash, restored: false })
        masked = stash.length
        tokensSaved = estimatedTokensSaved(stash)
      }
      const fresh = det.centroidCopy()
      if (fresh) restored = this.maybeRestoreEmbedding(state, messages, fresh)
    }

    return { shifted: verdict.shifted, masked, restored, tokensSaved, similarity: verdict.similarity }
  }

  private maybeRestoreEmbedding(
    state: SessionState,
    messages: MsgLike[],
    turnVec: Float32Array,
  ): number {
    let restored = 0
    for (const arc of state.archives) {
      if (arc.restored || !arc.vectorCentroid) continue
      const sim = cosineVec(turnVec, arc.vectorCentroid)
      if (sim >= this.config.recallThreshold) {
        restored += restoreObservations(messages, arc.stash)
        arc.restored = true
      }
    }
    return restored
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function lastUserIndex(messages: MsgLike[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info?.role === "user") return i
  }
  return messages.length
}

function allUserTexts(messages: MsgLike[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m?.info?.role !== "user") continue
    const text = (m.parts ?? [])
      .filter((p) => p.type === "text" && typeof (p as unknown as { text?: string }).text === "string")
      .map((p) => (p as unknown as { text: string }).text)
      .join(" ")
      .trim()
    if (text.length > 0) out.push(text)
  }
  return out
}

function termCounts(text: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of tokenizeTerms(text)) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

function cosineCountsLocal(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0
  for (const v of a.values()) na += v * v
  for (const v of b.values()) nb += v * v
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const [k, v] of small) {
    const w = big.get(k)
    if (w !== undefined) dot += v * w
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
