/**
 * In-memory inverted index plus auxiliary indexes used for hierarchical
 * filtering. Rebuilt from the store on plugin startup; kept consistent
 * by the repository on every CRUD.
 */

import type { Category, Memory } from "../types.js"
import { termFreq, tokenize } from "./tokenize.js"

/** Per-memory bookkeeping used by BM25 scoring. */
interface DocInfo {
  /** Token → term frequency. */
  tf: Map<string, number>
  /** Total token count (used as |d| in BM25). */
  length: number
}

export class InvertedIndex {
  /** token → set of memory ids that contain it */
  readonly postings = new Map<string, Set<string>>()
  /** memory id → per-doc bookkeeping */
  readonly docs = new Map<string, DocInfo>()
  /** category → set of memory ids */
  readonly byCategory = new Map<Category, Set<string>>()
  /** subject → set of memory ids */
  readonly bySubject = new Map<string, Set<string>>()

  /**
   * Undirected file co-change graph: file path → set of file paths it
   * was modified together with. Built from the `co-change` memories
   * the git ingester produces (tags = ["co-change", fileA, fileB]).
   * Used by BM25 search to propagate score to structurally-related
   * files — the Aider PageRank idea, one hop, over edges we already
   * compute. Survives restarts because co-change memories persist.
   */
  readonly coChange = new Map<string, Set<string>>()

  /** Running sum of doc lengths — for avgdl. */
  totalLength = 0
  /** Number of indexed docs. */
  docCount = 0

  rebuildFromAll(memories: Memory[]): void {
    this.postings.clear()
    this.docs.clear()
    this.byCategory.clear()
    this.bySubject.clear()
    this.coChange.clear()
    this.totalLength = 0
    this.docCount = 0
    for (const m of memories) this.add(m)
  }

  add(memory: Memory): void {
    // Build searchable text from subject + content + tags
    const text = `${memory.subject} ${memory.content} ${memory.tags.join(" ")}`
    const tokens = tokenize(text)
    const tf = termFreq(tokens)
    this.docs.set(memory.id, { tf, length: tokens.length })
    this.totalLength += tokens.length
    this.docCount += 1
    for (const token of tf.keys()) {
      let set = this.postings.get(token)
      if (!set) {
        set = new Set()
        this.postings.set(token, set)
      }
      set.add(memory.id)
    }
    let catSet = this.byCategory.get(memory.category)
    if (!catSet) {
      catSet = new Set()
      this.byCategory.set(memory.category, catSet)
    }
    catSet.add(memory.id)
    let subSet = this.bySubject.get(memory.subject)
    if (!subSet) {
      subSet = new Set()
      this.bySubject.set(memory.subject, subSet)
    }
    subSet.add(memory.id)
    this.indexCoChangeEdge(memory)
  }

  remove(memory: Memory): void {
    const info = this.docs.get(memory.id)
    if (info) {
      this.totalLength -= info.length
      this.docCount -= 1
      for (const token of info.tf.keys()) {
        const set = this.postings.get(token)
        if (set) {
          set.delete(memory.id)
          if (set.size === 0) this.postings.delete(token)
        }
      }
      this.docs.delete(memory.id)
    }
    this.byCategory.get(memory.category)?.delete(memory.id)
    this.bySubject.get(memory.subject)?.delete(memory.id)
    this.removeCoChangeEdge(memory)
  }

  avgDocLength(): number {
    return this.docCount > 0 ? this.totalLength / this.docCount : 0
  }

  /** Files structurally coupled to `file` (one hop). Empty if none. */
  coChangeNeighbors(file: string): ReadonlySet<string> | undefined {
    return this.coChange.get(file)
  }

  /**
   * A co-change memory carries tags `["co-change", fileA, fileB]`.
   * If this memory is one, record the undirected edge. Anything else
   * is ignored. Edges are de-duplicated by Set semantics, so the same
   * pair appearing in multiple memories is harmless.
   */
  private indexCoChangeEdge(memory: Memory): void {
    const pair = coChangePair(memory)
    if (!pair) return
    const [a, b] = pair
    addEdge(this.coChange, a, b)
    addEdge(this.coChange, b, a)
  }

  private removeCoChangeEdge(memory: Memory): void {
    const pair = coChangePair(memory)
    if (!pair) return
    const [a, b] = pair
    this.coChange.get(a)?.delete(b)
    this.coChange.get(b)?.delete(a)
    if (this.coChange.get(a)?.size === 0) this.coChange.delete(a)
    if (this.coChange.get(b)?.size === 0) this.coChange.delete(b)
  }
}

function coChangePair(memory: Memory): [string, string] | null {
  if (!memory.tags.includes("co-change")) return null
  // tags = ["co-change", fileA, fileB]
  const files = memory.tags.filter((t) => t !== "co-change")
  if (files.length < 2) return null
  return [files[0], files[1]]
}

function addEdge(graph: Map<string, Set<string>>, from: string, to: string): void {
  let set = graph.get(from)
  if (!set) {
    set = new Set()
    graph.set(from, set)
  }
  set.add(to)
}
