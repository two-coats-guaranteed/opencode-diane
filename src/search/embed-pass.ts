/**
 * embed-pass.ts — populate the vector store for memories that don't
 * yet have an embedding.
 *
 * Runs only when semantic search is enabled, in the background, after
 * prefill. It is incremental and crash-safe: vectors are persisted in
 * chunks, so a memory embedded once is never re-embedded across
 * sessions, and an interrupted pass simply resumes. A recall issued
 * before the pass finishes still works — it just fuses against the
 * vectors that exist so far (gracefully degrading toward pure lexical
 * search when few are ready).
 */

import type { Embedder } from "./embedder.js"
import type { MemoryRepository } from "../store/repository.js"
import type { VectorStore } from "../store/vector-store.js"

/** Memories are embedded (and persisted) this many at a time. */
const CHUNK = 64

/**
 * Embed every memory that lacks a vector, and drop vectors for
 * memories that no longer exist (evicted or replaced). Returns the
 * counts. Never throws into the caller — an embedding failure is
 * reported via `log` and ends the pass cleanly, leaving lexical
 * search fully functional.
 */
export async function embedMissingMemories(
  repo: MemoryRepository,
  vectorStore: VectorStore,
  embedder: Embedder,
  log?: (msg: string) => void
): Promise<{ embedded: number; pruned: number }> {
  const memories = repo.allMemories()
  const validIds = new Set(memories.map((m) => m.id))
  const pruned = vectorStore.prune(validIds)

  const todo = memories.filter((m) => !vectorStore.has(m.id))
  let embedded = 0
  try {
    for (let i = 0; i < todo.length; i += CHUNK) {
      const chunk = todo.slice(i, i + CHUNK)
      const texts = chunk.map((m) => `${m.subject}\n${m.content}`)
      const vecs = await embedder.embedPassages(texts)
      vectorStore.putMany(chunk.map((m, j) => ({ id: m.id, vec: vecs[j] })))
      embedded += chunk.length
    }
  } catch (e) {
    log?.(
      `semantic: embedding pass stopped after ${embedded}/${todo.length} — ` +
        `${e instanceof Error ? e.message : String(e)} (lexical search unaffected)`
    )
    return { embedded, pruned }
  }
  return { embedded, pruned }
}
