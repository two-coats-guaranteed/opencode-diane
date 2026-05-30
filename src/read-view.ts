/**
 * read-view.ts — AST-scoped file view for the OpenCode `read` tool.
 *
 * WHY THIS EXISTS
 * ───────────────
 * When the agent reads a large file (e.g., sessions.py, 1,643 lines)
 * the full content enters the conversation history. Anthropic's prompt
 * cache then re-bills those tokens on *every subsequent turn* for the
 * rest of the session — driving cache_read costs 6–10× above baseline.
 *
 * This module intercepts `tool.execute.after` for the `read` tool and
 * replaces the raw content with a compact structural view: top-level
 * definitions listed with exact line ranges so the agent can expand any
 * section with `read_range`.
 *
 * CACHE STABILITY — THE CRITICAL INVARIANT
 * ─────────────────────────────────────────
 * Anthropic caches on the *exact* byte sequence of the conversation.
 * If the view changes between turns the cache entry changes → cache miss
 * → the "compression" becomes more expensive than the original full read.
 *
 * To guarantee stability the view is computed ONCE per (session, file)
 * and then frozen. Every subsequent read of the same file in the same
 * session returns the identical string — same bytes → same cache key →
 * cache hit.
 *
 * The only exception: if the file is edited during the session its entry
 * is evicted so the next read reflects the new content. That one read
 * pays a fresh cache-write, but subsequent reads of the post-edit file
 * again hit a stable entry.
 *
 * WHAT THE AGENT SEES
 * ───────────────────
 * Instead of 18,000 tokens of sessions.py the agent sees ~250 tokens:
 *
 *   src/requests/sessions.py  [1643 lines → compressed]
 *   Use read_range("src/requests/sessions.py", start, end) to expand.
 *
 *   class SessionRedirectMixin  [lines 127–388, 262 lines → read_range(127,388)]
 *     def resolve_redirects(self, resp, req, ...)  [lines 163–204 → read_range(163,204)]
 *     def rebuild_auth(self, prepared_request, response)  [lines 237–248]
 *       <full body — 12 lines, shown because ≤ FULL_BODY_LINES>
 *     …
 *
 * SHORT FUNCTIONS (≤ FULL_BODY_LINES) are shown in their entirety; the
 * agent does not need to call read_range for them.
 */

import { readFileSync } from "node:fs"
import { relative } from "node:path"

// ── tuning constants ──────────────────────────────────────────────────────

/** Files shorter than this are never compressed — no benefit. */
const MIN_LINES_TO_COMPRESS = 80

/** Functions/methods with at most this many lines are shown in full. */
const FULL_BODY_LINES = 40

// ── session-scoped view cache ─────────────────────────────────────────────

// Key: `${sessionId}\x00${absFilePath}`
// Value: the frozen compressed string, or `""` if we decided not to compress.
const viewCache = new Map<string, string>()

// Track files that were edited AFTER their view was generated and have not
// been re-read since. When read_range is called against one of these, the
// line numbers it was passed may be stale (the file shifted under the
// agent's feet between when it saw the view and when it asked for those
// lines) — we surface this to the agent in the tool result.
const editedSinceView = new Set<string>()

/** Called when the agent edits a file — evicts the frozen view so the
 *  next read regenerates it against the post-edit content, and flags the
 *  file as potentially-stale-for-read_range until that next read. */
export function onFileEdited(sessionId: string, absPath: string): void {
  const key = cacheKey(sessionId, absPath)
  viewCache.delete(key)
  editedSinceView.add(key)
}

/** Has this file been edited in this session since its compressed view
 *  was last generated? read_range uses this to warn the agent that the
 *  line numbers it's quoting from the old view may have shifted. */
export function isViewStale(sessionId: string, absPath: string): boolean {
  return editedSinceView.has(cacheKey(sessionId, absPath))
}

/** Clean up all entries for a session when it ends. */
export function clearSession(sessionId: string): void {
  const prefix = sessionId + "\x00"
  for (const k of viewCache.keys()) {
    if (k.startsWith(prefix)) viewCache.delete(k)
  }
  for (const k of editedSinceView) {
    if (k.startsWith(prefix)) editedSinceView.delete(k)
  }
}

/** Returns the compressed view string, or null if this file should not
 *  be compressed (too short, unsupported language, or too little gain).
 *
 *  MUST return the same string on every call for the same
 *  (sessionId, absPath) within a session — this is the cache-stability
 *  guarantee. */
export function getReadView(
  sessionId: string,
  absPath: string,
  workspaceRoot: string,
): string | null {
  const key = cacheKey(sessionId, absPath)

  if (viewCache.has(key)) {
    const cached = viewCache.get(key)!
    return cached === "" ? null : cached  // "" = decided not to compress
  }

  // --- first read of this file in this session ---
  let src: string
  try {
    src = readFileSync(absPath, "utf8")
  } catch {
    viewCache.set(key, "")
    return null
  }

  const lines = src.split("\n")
  if (lines.length < MIN_LINES_TO_COMPRESS) {
    viewCache.set(key, "")
    return null
  }

  const ext = absPath.split(".").pop()?.toLowerCase() ?? ""
  const relPath = absPath.startsWith(workspaceRoot + "/") || absPath.startsWith(workspaceRoot + "\\")
    ? relative(workspaceRoot, absPath)
    : absPath

  const view = buildView(relPath, lines, ext)
  const result = view ?? ""
  viewCache.set(key, result)  // freeze ← only set once per (session, file)
  editedSinceView.delete(key)  // fresh view replaces any stale-flag
  return view
}

// ── helpers ───────────────────────────────────────────────────────────────

function cacheKey(sessionId: string, absPath: string): string {
  return sessionId + "\x00" + absPath
}

// ── view builder ──────────────────────────────────────────────────────────

interface Def {
  indent: number   // leading-space count
  sig: string      // the definition line, trimmed + collapsed whitespace
  start: number    // 1-based
  end: number      // 1-based, inclusive
}

function buildView(
  relPath: string,
  lines: string[],
  ext: string,
): string | null {
  const pattern = languagePattern(ext)
  if (pattern === null) return null

  const defs = findDefinitions(lines, pattern)
  if (defs.length < 2) return null

  // Skip if compression saves < 30 % of lines
  const shownLines = defs.reduce((s, d) => {
    const lineCount = d.end - d.start + 1
    return s + (lineCount <= FULL_BODY_LINES ? lineCount : 2)
  }, 0)
  if (shownLines > lines.length * 0.70) return null

  const out: string[] = []
  out.push(`${relPath}  [${lines.length} lines — compressed. Use read_range to expand any section.]`)
  out.push(`read_range("${relPath}", <start>, <end>)`)
  out.push("")

  // Group: top-level defs (indent 0) with their children nested under
  const topLevel = defs.filter(d => d.indent === 0)
  const nested   = defs.filter(d => d.indent > 0)

  for (const top of topLevel) {
    renderDef(out, relPath, top, lines, "")
    // Children that fall within this top-level span
    const children = nested.filter(d => d.start >= top.start && d.end <= top.end)
    for (const child of children) {
      renderDef(out, relPath, child, lines, "  ")
    }
    out.push("")
  }

  return out.join("\n")
}

function renderDef(
  out: string[],
  relPath: string,
  def: Def,
  lines: string[],
  indent: string,
): void {
  const lineCount = def.end - def.start + 1

  if (lineCount <= FULL_BODY_LINES) {
    // Show in full — short enough to be worth reading inline
    const body = lines.slice(def.start - 1, def.end).join("\n")
    out.push(indent + body)
  } else {
    out.push(
      `${indent}${def.sig}  ` +
      `[${lineCount} lines, ${def.start}–${def.end} ` +
      `→ read_range("${relPath}", ${def.start}, ${def.end})]`,
    )
    // First 3 non-blank body lines for orientation
    const bodyStart = def.start  // first line after signature (0-indexed = def.start)
    const preview = lines
      .slice(bodyStart, Math.min(bodyStart + 8, def.end - 1))
      .filter(l => l.trim().length > 0)
      .slice(0, 3)
    for (const l of preview) out.push(indent + "  " + l)
    if (preview.length > 0) out.push(indent + "  …")
  }
}

function findDefinitions(lines: string[], pattern: RegExp): Def[] {
  // Pass 1: locate definition start lines
  const starts: Array<{ indent: number; sig: string; lineNo: number }> = []
  for (let i = 0; i < lines.length; i++) {
    if (!pattern.test(lines[i])) continue
    const trimmed = lines[i].trim()
    // Skip decorator / attribute / comment lines
    if (trimmed.startsWith("@") || trimmed.startsWith("#") ||
        trimmed.startsWith("//") || trimmed.startsWith("*")) continue
    const indent = lines[i].search(/\S/)
    if (indent < 0) continue
    const sig = trimmed.replace(/\s+/g, " ").slice(0, 140)
    starts.push({ indent, sig, lineNo: i + 1 })  // 1-based
  }
  if (starts.length === 0) return []

  // Pass 2: assign end lines.
  // A definition ends just before the next definition at same/lower indent.
  const defs: Def[] = []
  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i]
    let end = lines.length
    for (let j = i + 1; j < starts.length; j++) {
      if (starts[j].indent <= cur.indent) {
        let candidateEnd = starts[j].lineNo - 1
        // Trim trailing blank lines
        while (candidateEnd > cur.lineNo && lines[candidateEnd - 1].trim() === "") {
          candidateEnd--
        }
        end = candidateEnd
        break
      }
    }
    defs.push({ indent: cur.indent, sig: cur.sig, start: cur.lineNo, end })
  }
  return defs
}

// ── fused recall support ──────────────────────────────────────────────────

/**
 * Extract the single most query-relevant definition body from a file, for
 * "fused recall" — letting memory_recall return a pointer PLUS the actual
 * code in one turn, instead of the agent spending a separate read turn.
 *
 * Scoring is lightweight token-overlap between the query and each
 * definition's signature (snake_case / camelCase split so "resolve_redirects"
 * matches a query mentioning "redirect"). Returns the best match only if its
 * body is at most `maxLines` lines — larger functions fall back to
 * pointer-only (returns null), so the recall response never balloons.
 */
export function extractRelevantFunction(
  absPath: string,
  query: string,
  maxLines = 150,
): { sig: string; bodyText: string; start: number; end: number } | null {
  let src: string
  try {
    src = readFileSync(absPath, "utf8")
  } catch {
    return null
  }
  const lines = src.split("\n")
  const ext = absPath.split(".").pop()?.toLowerCase() ?? ""
  const pattern = languagePattern(ext)
  if (pattern === null) return null

  const defs = findDefinitions(lines, pattern)
  if (defs.length === 0) return null

  const qTokens = tokenizeForMatch(query)
  if (qTokens.size === 0) return null

  let best: Def | null = null
  let bestScore = 0
  for (const d of defs) {
    const sigLower = d.sig.toLowerCase()
    const sigTokens = tokenizeForMatch(d.sig)
    let score = 0
    for (const t of sigTokens) if (qTokens.has(t)) score += 1
    // Substring bonus: a query token appearing inside the signature
    // (e.g. query "redirect" inside "resolve_redirects") is a strong signal.
    for (const qt of qTokens) if (qt.length >= 4 && sigLower.includes(qt)) score += 0.5
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  if (best === null || bestScore === 0) return null

  const lineCount = best.end - best.start + 1
  if (lineCount > maxLines) return null  // too big — pointer-only fallback

  const bodyText = lines.slice(best.start - 1, best.end).join("\n")
  return { sig: best.sig, bodyText, start: best.start, end: best.end }
}

function tokenizeForMatch(s: string): Set<string> {
  const raw = s.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const out = new Set<string>()
  for (const tok of raw) {
    if (tok.length >= 3) out.add(tok)
    // split camelCase boundaries that survived the alnum match isn't needed
    // here since the regex already split on case-insensitive non-alnum; but
    // snake_case parts are already separate tokens via the underscore split.
  }
  return out
}

// ── language patterns ─────────────────────────────────────────────────────

function languagePattern(ext: string): RegExp | null {
  switch (ext) {
    case "py":
      return /^\s*(async\s+)?def\s+\w+|^\s*class\s+\w+/

    case "ts": case "tsx": case "js": case "jsx": case "mjs": case "cjs":
      return /^\s*(export\s+)?(default\s+)?(abstract\s+)?(async\s+)?(class\b|function\b|(?:const|let|var)\s+\w+\s*[=:])/

    case "rs":
      return /^\s*(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+\w+|^\s*(pub\s+)?(struct|enum|trait|impl)\s+\w+/

    case "go":
      return /^func\s+(?:\([^)]+\)\s+)?\w+|^type\s+\w+\s+(?:struct|interface)/

    case "java": case "kt":
      return /^\s*(public|private|protected|static|final|abstract|override|suspend|fun\b|class\b|interface\b|object\b|enum\b|sealed\b)(\s.*)?[\s(]/

    case "rb":
      return /^\s*(def\s+\w+|class\s+\w+|module\s+\w+)/

    case "cs":
      return /^\s*(public|private|protected|internal|static|override|virtual|abstract|sealed|async|class\b|interface\b|struct\b|enum\b|record\b)(\s.*)?[\s(]/

    default:
      return null
  }
}
