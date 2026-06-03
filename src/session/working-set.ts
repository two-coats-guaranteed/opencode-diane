/**
 * working-set.ts — session-scoped decaying working-set prior.
 *
 * As an agent works a task, it reveals its locus: a recall whose file it then
 * edits (the recall→edit signal already captured for provenance) marks that
 * file as part of the current working set. Subsequent recalls in the same
 * session are boosted toward those files and — the load-bearing part — their
 * co-change neighbours, so finding one file of a multi-file change makes the
 * rest easier to surface. Strength decays each recall, so a stale locus fades;
 * a detected query-topic shift flushes the set outright.
 *
 * WHY THIS SHAPE (and how it differs from the router that failed): the learned
 * router died on cross-repo distribution shift. Within a single session the
 * distribution is fixed (one repo, one task), so this sidesteps that failure.
 * It is deterministic (no per-session learning, no calibration) and
 * downside-bounded: an empty or decayed working set contributes no boost, so
 * recall falls straight back to the BM25+history default.
 *
 * MEASURED (offline proxy, 72 multi-target instances): boosting the co-change +
 * same-dir neighbours of an "edited" gold file lifted finding the REMAINING
 * gold from R@5 0.29→0.47 (0.43→0.61 conditioned), MRR 0.14→0.32; helped 60/72,
 * hurt 10/72. See RESULTS.md ("session-adaptation proxy").
 *
 * HONEST LIMITS: the proxy tested a single co-change step, not a full multi-turn
 * session, and could NOT exercise cross-subtask drift — the 10/72 hurt cases.
 * The guards here are (1) per-recall decay and (2) a lexical query-drift flush;
 * a heavier drift signal (the turn-level detector in drift.ts) is the intended
 * next hardening. This ships default-on but instrumented: `summary.wsBoost`
 * records when the prior fired so its real-world effect is visible in the event
 * stream and can be turned off (`enableSessionWorkingSet`) if it regresses.
 */

/** Tokenise text into lowercase alphanumeric terms (camelCase-split, length ≥ 3). */
function tokenizeTerms(text: string): string[] {
  const out: string[] = []
  const decamel = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  for (const raw of decamel.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length >= 3) out.push(raw)
  }
  return out
}

interface SessionState {
  /** file path -> current strength (decays toward 0). */
  files: Map<string, number>
  /** term sets of the last few recall queries, for drift detection. */
  recentTerms: Set<string>[]
  /** consecutive off-topic queries seen (for sustained-drift flushing). */
  driftStreak: number
}

const sessions = new Map<string, SessionState>()

function state(sessionId: string): SessionState {
  let s = sessions.get(sessionId)
  if (!s) {
    s = { files: new Map(), recentTerms: [], driftStreak: 0 }
    sessions.set(sessionId, s)
  }
  return s
}

/** Record that a recalled file was edited — it joins the working set at full strength. */
export function noteUsefulFile(sessionId: string, file: string, initial = 1.0): void {
  const s = state(sessionId)
  s.files.set(file, Math.max(initial, s.files.get(file) ?? 0))
}

/** Age the working set one step: multiply strengths by `factor`, drop any below `floor`. */
export function decaySession(sessionId: string, factor = 0.7, floor = 0.2): void {
  const s = sessions.get(sessionId)
  if (!s) return
  for (const [f, v] of [...s.files]) {
    const nv = v * factor
    if (nv < floor) s.files.delete(f)
    else s.files.set(f, nv)
  }
}

/** Clear a session's working set (e.g. on a detected goal shift). */
export function flushSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s) {
    s.files.clear()
    s.recentTerms = []
  }
}

/** The current working set for a session (file -> strength). */
export function workingSet(sessionId: string): ReadonlyMap<string, number> {
  return sessions.get(sessionId)?.files ?? new Map()
}

/** Test helper: forget all sessions. */
export function clearAllSessions(): void {
  sessions.clear()
}

/**
 * Record the current recall query and flush the working set only on SUSTAINED
 * drift — `flushAfterConsecutive` consecutive off-topic queries. Returns true if
 * it flushed.
 *
 * A measured correction (see RESULTS.md "drift proxy"): flushing on a SINGLE
 * off-topic query fires ~95% of the time across distinct tasks and removes a net
 * benefit — because the boost's value comes from structural co-change coupling,
 * which persists even when query wording changes. So a lone low-overlap query no
 * longer flushes; decay is the primary guard, and the flush is a conservative
 * safety valve for a genuine sustained topic change (the regime the offline
 * proxy could not exercise, where boosting a truly orthogonal locus would hurt).
 *
 * Drift on a query = the fraction of its terms NOT in the recent-query
 * vocabulary exceeds (1 - overlapThreshold). The streak resets on any on-topic
 * query, and on a flush.
 */
export function noteQueryAndMaybeFlush(
  sessionId: string,
  query: string,
  opts: {
    overlapThreshold?: number
    window?: number
    minTerms?: number
    flushAfterConsecutive?: number
  } = {}
): boolean {
  const overlapThreshold = opts.overlapThreshold ?? 0.2
  const window = opts.window ?? 3
  const minTerms = opts.minTerms ?? 3
  const flushAfterConsecutive = opts.flushAfterConsecutive ?? 2
  const s = state(sessionId)
  const terms = new Set(tokenizeTerms(query))
  let flushed = false
  if (terms.size >= minTerms && s.recentTerms.length > 0 && s.files.size > 0) {
    const recent = new Set<string>()
    for (const set of s.recentTerms) for (const t of set) recent.add(t)
    let shared = 0
    for (const t of terms) if (recent.has(t)) shared += 1
    const overlap = shared / terms.size
    if (overlap < overlapThreshold) {
      s.driftStreak += 1
      if (s.driftStreak >= flushAfterConsecutive) {
        flushSession(sessionId)
        s.driftStreak = 0
        flushed = true
      }
    } else {
      s.driftStreak = 0
    }
  }
  // record this query's terms (after the check) for the next comparison
  const s2 = state(sessionId)
  s2.recentTerms.push(terms)
  if (s2.recentTerms.length > window) s2.recentTerms.shift()
  return flushed
}

/**
 * Apply the working-set prior to a base score map, returning boosted scores.
 * Pure (no session state, no I/O). Base scores are normalised to [0,1] first so
 * the boost is comparable across queries of different score magnitudes.
 *
 *   - self  : a working-set file that is itself a candidate gets a mild bump.
 *   - alpha : each working-set file's co-change neighbours get a boost ∝ the
 *             file's strength — this can INJECT a neighbour the lexical search
 *             missed entirely (score 0), which is where the multi-file recall
 *             gain comes from.
 *   - beta  : candidates sharing a directory with a working-set file get a
 *             smaller bump (a cheap structural-sibling signal); applied only
 *             over scored/injected candidates, never a global file scan.
 *
 * Injected neighbours appear in the returned map with a score even if they were
 * not in `base`; the caller is responsible for fetching their memory to surface
 * them.
 */
export function computeBoostedScores(
  base: ReadonlyMap<string, number>,
  ws: ReadonlyMap<string, number>,
  neighborsOf: (file: string) => Iterable<string> | undefined,
  opts: { alpha?: number; self?: number; beta?: number } = {}
): Map<string, number> {
  const alpha = opts.alpha ?? 0.4
  const self = opts.self ?? 0.15
  const beta = opts.beta ?? 0.15
  let maxBase = 0
  for (const v of base.values()) if (v > maxBase) maxBase = v
  const norm = maxBase > 0 ? maxBase : 1
  const out = new Map<string, number>()
  for (const [f, v] of base) out.set(f, v / norm)
  if (ws.size === 0) return out

  const dirOf = (f: string): string => {
    const i = f.lastIndexOf("/")
    return i >= 0 ? f.slice(0, i) : ""
  }
  // working-set directories with their strongest member's strength
  const wsDirs = new Map<string, number>()
  for (const [w, s] of ws) {
    const d = dirOf(w)
    wsDirs.set(d, Math.max(wsDirs.get(d) ?? 0, s))
  }

  for (const [w, s] of ws) {
    if (out.has(w)) out.set(w, (out.get(w) as number) + self * s)
    const neigh = neighborsOf(w)
    if (neigh) {
      for (const n of neigh) out.set(n, (out.get(n) ?? 0) + alpha * s)
    }
  }
  if (beta > 0) {
    for (const k of [...out.keys()]) {
      if (ws.has(k)) continue
      const d = dirOf(k)
      const ds = wsDirs.get(d)
      if (ds !== undefined) out.set(k, (out.get(k) as number) + beta * ds)
    }
  }
  return out
}
