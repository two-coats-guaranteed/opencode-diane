/**
 * function-trace.ts — agent-session provenance, indexed by function.
 *
 * The HAFixAgent / Code-Researcher result (2025) is that injecting the
 * *history* of a buggy location — what changed there and why — materially
 * improves an agent's repair quality, at no extra turn cost. Those systems
 * mine git history (`git blame` → blame commit → message + diff).
 *
 * Diane has a second, complementary history source that no other agent
 * has in accessible form: **its own prior sessions**. When an agent edits
 * a function, the causally interesting facts are not just "the file
 * changed" (which `session-trace` already records) but:
 *
 *   - *which function* was worked on,
 *   - *what the agent was looking for* when it got there (the recall query
 *     that pointed it at the function), and
 *   - *which session / task* it happened in.
 *
 * That is the agent-side analogue of a blame commit's message+diff, and it
 * captures something git history never will: what an *agent* understood and
 * attempted, including work that was never committed.
 *
 * This module records one rolling memory per function (newest session's
 * work replaces older — provenance is "what happened last here", bounded to
 * one entry per function so the store can't balloon), and retrieves the
 * provenance for a function so `memory_recall` can fuse it into its
 * response exactly the way it already fuses the function body.
 *
 * Causal-link precision: the caller only records a trace when a recall in
 * this session actually pointed at the file being edited — i.e. there is a
 * real recall→edit link, not merely "some file changed". No link, no trace.
 */

import type { Category, Memory } from "../types.js"
import type { MemoryRepository } from "../store/repository.js"

const CATEGORY: Category = "function-trace"

/** Normalize a function signature / file into a stable, compact key. */
export function provenanceKey(filePath: string, functionSig: string | null): string {
  const file = filePath.split("/").pop() ?? filePath
  if (functionSig && functionSig.trim().length > 0) {
    // pull the identifier out of e.g. "def resolve_redirects(self, resp, ...)"
    const m = functionSig.match(/(?:def|function|fn|class)\s+([A-Za-z0-9_]+)/)
    const name = m ? m[1] : functionSig.trim().slice(0, 60).replace(/\s+/g, "_")
    return `${file}::${name}`
  }
  return file
}

export interface FunctionTraceInput {
  sessionId: string
  filePath: string
  /** The signature recall pointed at (may be null → file-level trace). */
  functionSig: string | null
  /** The recall query that led the agent to this function ("the why"). */
  recallQuery: string
  /** Optional: the session's task (first user message), if known. */
  task?: string
}

/**
 * Record (rolling, one per function) that an agent worked on a function in
 * this session. Idempotent per key via upsertBySubject — the most recent
 * session's work is what a future recall surfaces.
 */
export function recordFunctionTrace(
  repo: MemoryRepository,
  input: FunctionTraceInput,
): string | null {
  try {
    const key = provenanceKey(input.filePath, input.functionSig)
    const where = input.functionSig
      ? `\`${shortSig(input.functionSig)}\` in ${input.filePath}`
      : input.filePath
    const why = input.recallQuery.trim().slice(0, 160)
    const taskPart = input.task ? ` (task: ${input.task.trim().slice(0, 120)})` : ""
    const content =
      `A previous agent session worked on ${where}${taskPart}, ` +
      `reached via recall query: "${why}".`

    const mem = repo.upsertBySubject({
      category: CATEGORY,
      subject: `functrace:${key}`,
      content,
      tags: [
        "function-trace",
        `func:${key}`,
        `file:${input.filePath.split("/").pop() ?? input.filePath}`,
        `session:${input.sessionId}`,
      ],
      source: `session:${input.sessionId}`,
    })
    return mem?.id ?? null
  } catch {
    return null
  }
}

/**
 * Look up prior-session provenance for a function/file. Returns the most
 * relevant trace's content string, or null. Matches on the precise
 * function key first, then falls back to any trace for the same file.
 */
export function lookupFunctionTrace(
  repo: MemoryRepository,
  filePath: string,
  functionSig: string | null,
): string | null {
  try {
    const key = provenanceKey(filePath, functionSig)
    const fileTag = `file:${filePath.split("/").pop() ?? filePath}`

    let fileLevel: string | null = null
    for (const m of iterTraces(repo)) {
      if (m.subject === `functrace:${key}`) {
        return m.content // exact function match — best
      }
      if (fileLevel === null && m.tags?.includes(fileTag)) {
        fileLevel = m.content // remember a file-level fallback
      }
    }
    return fileLevel
  } catch {
    return null
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function* iterTraces(repo: MemoryRepository): Iterable<Memory> {
  // Prefer an index-backed category fetch when available; fall back to a
  // full scan filtered by category. Either way this is bounded by the
  // (small) number of function-trace memories.
  const anyRepo = repo as unknown as {
    getByCategory?: (c: Category) => Memory[]
    allMemories?: () => Memory[]
    all?: () => Memory[]
  }
  const direct = anyRepo.getByCategory?.(CATEGORY)
  if (Array.isArray(direct)) {
    yield* direct
    return
  }
  const all = anyRepo.allMemories?.() ?? anyRepo.all?.() ?? []
  for (const m of all) if (m.category === CATEGORY) yield m
}

function shortSig(sig: string): string {
  // keep up to the first "(" plus a closing marker, so signatures stay short
  const paren = sig.indexOf("(")
  if (paren > 0) return sig.slice(0, paren).trim() + "(…)"
  return sig.trim().slice(0, 60)
}
