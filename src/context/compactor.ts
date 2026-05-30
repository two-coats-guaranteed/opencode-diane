/**
 * compactor.ts — observation masking and restoration over a message list.
 *
 * The "compress" and "re-insert" halves of the Memex loop, as pure array
 * transforms so they are fully testable without a live OpenCode session.
 *
 * WHY MASK OBSERVATIONS, NOT REASONING
 * ────────────────────────────────────
 * The JetBrains/TUM study (Lindenbauer et al., 2025) found that for coding
 * agents, compressing the *environment observations* (tool outputs — file
 * reads, command output) while preserving the action+reasoning history in
 * full retains far more decision quality than summarizing everything. Our
 * own eval agreed: tool results are the bulk of the recoverable context.
 * So compaction here targets completed tool-part outputs and leaves text /
 * reasoning parts untouched.
 *
 * NON-LOSSY BY DESIGN
 * ───────────────────
 * Masking replaces a tool output with a short placeholder and stashes the
 * original keyed by (messageID, partIndex). `restoreObservations` splices
 * the originals back in. Because the full text is retained in the stash
 * (and is independently re-fetchable via the OpenCode session API), a
 * compression that later proves premature is fully recoverable — the
 * defence against the "summarization drift" pathology of lossy summary-only
 * memory.
 *
 * CACHE NOTE
 * ──────────
 * Rewriting the message list changes the request prefix and therefore
 * causes a prompt-cache miss on the turn it happens. That is the accepted,
 * deliberate cost of compaction — paid once per goal shift, in exchange for
 * a smaller per-turn context for the remainder of the new segment.
 */

// ── minimal structural types ────────────────────────────────────────────
// Declared locally (not imported from the SDK) so these functions operate
// on the smallest shape they need and stay trivially unit-testable.

export interface MsgPartLike {
  type: string
  // tool parts:
  tool?: string
  state?: {
    status?: string
    output?: string
    [k: string]: unknown
  }
  // text / reasoning parts carry `text`; we never touch those.
  [k: string]: unknown
}

export interface MsgLike {
  info: { id?: string; role?: string; [k: string]: unknown }
  parts: MsgPartLike[]
}

export interface StashEntry {
  messageId: string
  partIndex: number
  /** The original tool output text that was masked. */
  original: string
  /** The tool name, for the placeholder and for selective restore. */
  tool: string
}

const MASK_TAG = "[diane:masked]"

/** A completed tool part whose output is large enough to be worth masking. */
function isMaskableToolPart(part: MsgPartLike, minChars: number): boolean {
  return (
    part.type === "tool" &&
    part.state != null &&
    part.state.status === "completed" &&
    typeof part.state.output === "string" &&
    part.state.output.length >= minChars &&
    !part.state.output.startsWith(MASK_TAG)   // don't double-mask
  )
}

export interface MaskOptions {
  /** Only mask tool outputs at least this many chars long. Default 400. */
  minChars?: number
  /** Build the placeholder shown in place of the masked output. */
  placeholder?: (tool: string, originalChars: number) => string
}

/**
 * Mask maskable tool-part outputs in messages whose index is < boundary.
 * Mutates `messages` in place and returns the stash of originals.
 *
 * `boundary` is an index into `messages`: everything before it is the
 * "stale" span (the goal the conversation just moved off of); messages at
 * or after `boundary` are left fully intact.
 */
export function maskObservations(
  messages: MsgLike[],
  boundary: number,
  opts: MaskOptions = {},
): StashEntry[] {
  const minChars = opts.minChars ?? 400
  const placeholder =
    opts.placeholder ??
    ((tool, n) =>
      `${MASK_TAG} ${tool} output (${n} chars) compacted after a goal shift. ` +
      `Recoverable on demand.`)

  const stash: StashEntry[] = []
  const end = Math.max(0, Math.min(boundary, messages.length))

  for (let m = 0; m < end; m++) {
    const msg = messages[m]
    if (!msg || !Array.isArray(msg.parts)) continue
    const messageId = String(msg.info?.id ?? `idx-${m}`)
    for (let p = 0; p < msg.parts.length; p++) {
      const part = msg.parts[p]
      if (!isMaskableToolPart(part, minChars)) continue
      const original = part.state!.output as string
      stash.push({ messageId, partIndex: p, original, tool: String(part.tool ?? "tool") })
      part.state!.output = placeholder(String(part.tool ?? "tool"), original.length)
    }
  }
  return stash
}

/**
 * Restore previously-masked tool outputs into `messages`, matching by
 * (messageID, partIndex). Mutates in place; returns the count restored.
 *
 * `predicate` optionally limits which stash entries to restore (e.g. only
 * those belonging to a segment whose goal has become relevant again).
 */
export function restoreObservations(
  messages: MsgLike[],
  stash: StashEntry[],
  predicate?: (entry: StashEntry) => boolean,
): number {
  if (stash.length === 0) return 0
  // Index messages by id for O(1) lookup; fall back to idx-N synthesis.
  const byId = new Map<string, MsgLike>()
  for (let m = 0; m < messages.length; m++) {
    const id = String(messages[m]?.info?.id ?? `idx-${m}`)
    byId.set(id, messages[m])
  }

  let restored = 0
  for (const entry of stash) {
    if (predicate && !predicate(entry)) continue
    const msg = byId.get(entry.messageId)
    if (!msg || !Array.isArray(msg.parts)) continue
    const part = msg.parts[entry.partIndex]
    if (!part || part.type !== "tool" || part.state == null) continue
    // Only restore if it is still masked (avoid clobbering a newer value).
    if (typeof part.state.output === "string" && part.state.output.startsWith(MASK_TAG)) {
      part.state.output = entry.original
      restored += 1
    }
  }
  return restored
}

/** Rough token estimate (chars/4) of the masking savings in a stash. */
export function estimatedTokensSaved(stash: StashEntry[]): number {
  let chars = 0
  for (const e of stash) chars += e.original.length
  return Math.round(chars / 4)
}
