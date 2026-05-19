/**
 * Eviction policy: least-frequently-used first (the user's
 * explicit requirement), with least-recently-used as tiebreaker.
 * Pinned entries are never evicted.
 *
 * Called after each ingest batch and after explicit agent writes.
 *
 * `currentTotalBytes` is supplied by the caller (the repository
 * already tracks it incrementally) so this function does not
 * recompute the sum, and — importantly — it evicts against the
 * *same* number the repository reports from `totalBytes()`,
 * including the fixed store overhead. Otherwise the effective
 * budget would silently drift by that constant.
 */

import type { Memory } from "../types.js"

export function evictIfOverBudget(
  memories: readonly Memory[],
  maxBytes: number,
  currentTotalBytes: number
): Memory[] {
  let total = currentTotalBytes
  if (total <= maxBytes) return []

  // Eligible = not pinned. Sort ascending by (useCount, usedAt) so
  // the first elements are the cheapest to lose.
  const eligible = memories
    .filter((m) => !m.pinned)
    .slice()
    .sort((a, b) => {
      if (a.useCount !== b.useCount) return a.useCount - b.useCount
      return a.usedAt - b.usedAt
    })

  const removed: Memory[] = []
  for (const m of eligible) {
    if (total <= maxBytes) break
    removed.push(m)
    total -= m.sizeBytes
  }
  return removed
}
