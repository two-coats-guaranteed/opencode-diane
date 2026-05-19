/**
 * Session snapshots — branchable, versioned "understanding" carried
 * across sessions.
 *
 * The `session-trace` category already records what a *past* session
 * physically did (files edited, commands run). A snapshot records
 * something different and harder-won: the *understanding* a session
 * built up — the mental model, the decisions made, the conventions
 * learned — the stuff that is normally lost when a context window
 * fills and compacts.
 *
 * This is the harness-side, no-model translation of the
 * "contextual memory virtualisation" idea: instead of a DAG data
 * structure, each snapshot is one pinned memory, and the parent link
 * is just a `parent:<id>` tag. The set of snapshots and their parent
 * tags *is* the DAG — readable, hand-editable, no new storage shape.
 *
 *   - A later session resumes from the most recent snapshot.
 *   - A parallel session reads the same shared store, so it forks
 *     from the same point automatically.
 *   - Recording a new snapshot that tags an older one as `parent`
 *     is a branch.
 *
 * Snapshots are pinned, so the LFU disk-budget eviction never drops
 * them — accumulated understanding outlives transient facts.
 */

import type { Category, Memory } from "../types.js"
import type { MemoryRepository } from "../store/repository.js"

const CATEGORY: Category = "session-snapshot"

/** Structured payload the agent supplies when taking a snapshot. */
export interface SnapshotInput {
  /** One short paragraph: the working mental model of the codebase/task. */
  summary: string
  /** Decisions made and why — each a short line. */
  decisions?: string[]
  /** Conventions/constraints learned that aren't obvious from the code. */
  conventions?: string[]
}

export interface SnapshotWriteResult {
  id: string
  parentId: string | null
}

/**
 * Record a session snapshot. `sessionId` keys it; if a snapshot for
 * the same session already exists it is replaced (a session's
 * understanding is updated in place, not duplicated). The most recent
 * *other* session's snapshot is recorded as the `parent` — that link
 * is what makes the snapshot set a branchable history.
 */
export function writeSnapshot(
  repo: MemoryRepository,
  sessionId: string,
  input: SnapshotInput
): SnapshotWriteResult {
  const parentId = latestSnapshotId(repo, sessionId)

  const lines: string[] = [input.summary.trim()]
  if (input.decisions && input.decisions.length > 0) {
    lines.push(
      "Decisions: " + input.decisions.map((d) => d.trim()).filter(Boolean).join(" | ")
    )
  }
  if (input.conventions && input.conventions.length > 0) {
    lines.push(
      "Conventions: " + input.conventions.map((c) => c.trim()).filter(Boolean).join(" | ")
    )
  }
  const content = `Session understanding (${sessionId}): ` + lines.join(". ")

  const tags = ["session-snapshot", `session:${sessionId}`]
  if (parentId) tags.push(`parent:${parentId}`)

  // upsertBySubject → one snapshot per session, replace-in-place.
  const mem = repo.upsertBySubject({
    category: CATEGORY,
    subject: `snapshot:${sessionId}`,
    content,
    tags,
    source: `session:${sessionId}`,
    pinned: true, // accumulated understanding must outlive eviction
  })

  return { id: mem.id, parentId }
}

/**
 * The most recent snapshot to resume from — the newest snapshot that
 * does NOT belong to `excludeSessionId` (so a session never resumes
 * from itself). Returns null when there are no prior snapshots.
 */
export function latestSnapshot(
  repo: MemoryRepository,
  excludeSessionId?: string
): Memory | null {
  let best: Memory | null = null
  for (const m of repo.allMemories()) {
    if (m.category !== CATEGORY) continue
    if (excludeSessionId && m.subject === `snapshot:${excludeSessionId}`) continue
    if (!best || m.createdAt > best.createdAt) best = m
  }
  return best
}

function latestSnapshotId(repo: MemoryRepository, excludeSessionId: string): string | null {
  return latestSnapshot(repo, excludeSessionId)?.id ?? null
}

/**
 * A compact, human-readable lineage for `memory_status` / logs:
 * how many snapshots exist and when the most recent was taken.
 */
export function snapshotSummary(repo: MemoryRepository): {
  count: number
  latestAt: number | null
} {
  let count = 0
  let latestAt: number | null = null
  for (const m of repo.allMemories()) {
    if (m.category !== CATEGORY) continue
    count += 1
    if (latestAt === null || m.createdAt > latestAt) latestAt = m.createdAt
  }
  return { count, latestAt }
}
