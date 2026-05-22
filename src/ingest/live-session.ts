/**
 * Live-session activity recorder.
 *
 * The pre-existing `session-trace` category records what *past* sessions
 * physically did (files edited, commands run), pulled from the OpenCode
 * SDK by `ingestSessions`. By design, that ingester explicitly skips
 * the *current* session — past sessions are stable, the current one is
 * still being lived.
 *
 * This module fills the gap: it records the **current** session's
 * activity in-place, in the same `session-trace` category, so:
 *
 *   - Recall within the current session can surface "what have I
 *     touched so far" without scanning the OpenCode SDK at all.
 *   - When this session later becomes a *past* session, its data is
 *     already in the store and ready for resume by parallel/successor
 *     sessions.
 *
 * Design choices:
 *
 *   1. ONE memory per session, keyed by `live:${sessionId}`, updated
 *      in place via `upsertBySubject`. The content is a compact
 *      rolling summary (files edited + bash commands run + counts),
 *      not a full transcript — this is a recall surface, not an audit
 *      log. The JSONL file logger is the audit log.
 *
 *   2. We do not record every tool call (read, grep, glob would flood
 *      the store with noise). We record:
 *       - File-modifying tool calls (write, edit, patch)
 *       - Bash commands (rich signal: build/test/install/checkout/…)
 *       - We deliberately skip pure-discovery calls.
 *
 *   3. Write debouncing — the recorder accumulates events in memory
 *      and only persists when (a) `flushNow()` is called, or (b) an
 *      idle timer expires. This keeps the write-behind buffer from
 *      flushing on every keystroke-of-an-edit.
 *
 *   4. Best-effort — every recording path is wrapped at the call
 *      site. A failure inside this module must never block a tool call
 *      or surface to the agent.
 *
 *   5. Bounded — content is capped at MAX_CONTENT_BYTES, with the
 *      oldest events dropped first when the cap is reached. The
 *      summary line and total counts stay accurate; only the
 *      timeline-detail is truncated.
 */

import type { Category } from "../types.js"
import type { MemoryRepository } from "../store/repository.js"

const CATEGORY: Category = "session-trace"

/** Hard cap on the rolling memory content size. */
const MAX_CONTENT_BYTES = 4096
/** Hard cap on the list of bash commands kept in detail (oldest dropped). */
const MAX_BASH_DETAIL = 30
/** Hard cap on the list of edited files kept (oldest dropped). */
const MAX_EDITED_FILES = 60
/** Truncation length for any individual bash command stored. */
const MAX_BASH_LINE = 160

export interface LiveSessionEvent {
  /** "write" | "edit" | "patch" | "bash" | "code-map-refresh" — for tagging. */
  kind: string
  /** A short, single-line description (file path, truncated command, …). */
  detail: string
  /** Epoch ms. */
  at: number
}

/**
 * Per-plugin-instance state. One LiveSessionRecorder is created at
 * plugin load and lives for the lifetime of the OpenCode session.
 */
export class LiveSessionRecorder {
  private readonly editedFiles = new Set<string>()
  private readonly bashLines: string[] = []
  private editCount = 0
  private bashCount = 0
  private readonly startedAt = Date.now()

  constructor(
    private readonly repo: MemoryRepository,
    private readonly sessionId: string,
  ) {}

  /**
   * Record a file modification (write / edit / patch). Idempotent on
   * file path — recording the same file twice keeps the path in the
   * edited-files set exactly once but increments the edit counter.
   */
  recordFileEdit(filePath: string, _tool: string): void {
    this.editCount += 1
    this.editedFiles.add(filePath)
    if (this.editedFiles.size > MAX_EDITED_FILES) {
      // drop the oldest tracked file — Sets preserve insertion order in JS.
      const first = this.editedFiles.values().next().value
      if (first !== undefined) this.editedFiles.delete(first)
    }
  }

  /**
   * Record a bash command. The command text is truncated to MAX_BASH_LINE
   * characters and the buffer is capped at MAX_BASH_DETAIL entries.
   */
  recordBash(command: string): void {
    this.bashCount += 1
    const truncated = command.length > MAX_BASH_LINE
      ? command.slice(0, MAX_BASH_LINE) + "…"
      : command
    this.bashLines.push(truncated)
    if (this.bashLines.length > MAX_BASH_DETAIL) this.bashLines.shift()
  }

  /**
   * Render the current state as memory content. Format is stable so
   * BM25 tokenisation behaves predictably.
   */
  private renderContent(): string {
    const ageMin = Math.round((Date.now() - this.startedAt) / 60000)
    const lines: string[] = []
    lines.push(
      `Live session ${this.sessionId} (started ${ageMin}m ago): ` +
        `${this.editCount} file edit${this.editCount === 1 ? "" : "s"}, ` +
        `${this.bashCount} bash command${this.bashCount === 1 ? "" : "s"}.`
    )
    if (this.editedFiles.size > 0) {
      lines.push("Files edited: " + [...this.editedFiles].join(", "))
    }
    if (this.bashLines.length > 0) {
      lines.push("Recent bash commands:")
      for (const cmd of this.bashLines) lines.push("  $ " + cmd)
    }
    let content = lines.join("\n")
    // Hard cap on size — drop oldest bash lines until under cap.
    while (content.length > MAX_CONTENT_BYTES && this.bashLines.length > 0) {
      this.bashLines.shift()
      const idx = lines.findIndex((l) => l.startsWith("  $ "))
      if (idx >= 0) lines.splice(idx, 1)
      else break
      content = lines.join("\n")
    }
    // Final hard truncate as a safety net.
    if (content.length > MAX_CONTENT_BYTES) {
      content = content.slice(0, MAX_CONTENT_BYTES - 1) + "…"
    }
    return content
  }

  /**
   * Persist the rolling state as a single memory (upsert by subject).
   * Idempotent: calling it twice with no new events between writes the
   * same memory twice — no duplicates, the existing one is replaced.
   *
   * Tags include all touched files (for recall by file path) plus a
   * `live:${sessionId}` marker so a query can target the current
   * session's trace explicitly.
   */
  flush(): void {
    // Nothing to record? Skip the write — an empty live trace memory
    // would just dilute recall results without adding signal.
    if (this.editCount === 0 && this.bashCount === 0) return

    const tags: string[] = ["live-session", `session:${this.sessionId}`]
    for (const f of this.editedFiles) tags.push(`file:${f}`)

    this.repo.upsertBySubject({
      category: CATEGORY,
      subject: `live:${this.sessionId}`,
      content: this.renderContent(),
      tags,
      source: `session:${this.sessionId}`,
      // NOT pinned — a live trace is transient state. Once this session
      // becomes a past session, ingestSessions may add a more compact
      // trace memory; the LFU eviction can drop the live one as it
      // ages, which is the desired behaviour.
      pinned: false,
    })
  }

  /** Test-only inspection of internal counters. */
  stats(): { editCount: number; bashCount: number; uniqueFiles: number } {
    return {
      editCount: this.editCount,
      bashCount: this.bashCount,
      uniqueFiles: this.editedFiles.size,
    }
  }
}
