/**
 * Code-health ingestion — turns OpenCode's LSP diagnostics into a
 * live `code-health` memory category.
 *
 * Unlike git/project/session ingestion (one-shot, at startup), this
 * is a LIVE signal: it's driven by the `lsp.client.diagnostics`
 * plugin event, which fires whenever a language server re-analyses a
 * file. Each fire upserts one memory per file — re-reporting REPLACES
 * the prior state, so the store always reflects current diagnostics,
 * never a pile of stale ones.
 *
 * Why this is convention-free and language-agnostic: LSP normalises
 * diagnostics across 40+ servers into the same shape (severity 1-4,
 * a message, a range). We read the compiler's / type-checker's own
 * output — no heuristics, no per-language logic.
 *
 * The event payload shape is not nailed down across OpenCode
 * versions, so extraction is deliberately defensive — it probes
 * several plausible shapes and silently no-ops if none match, exactly
 * like the session ingester does for SDK responses. The extraction
 * logic is a pure function so it can be unit-tested against mock
 * payloads without a running LSP.
 */

import type { Category } from "../types.js"
import type { MemoryRepository } from "../store/repository.js"

const CATEGORY: Category = "code-health"

/** LSP DiagnosticSeverity. 1=Error 2=Warning 3=Information 4=Hint. */
const SEVERITY_ERROR = 1
const SEVERITY_WARNING = 2

/** Per-file diagnostic rollup extracted from an LSP event. */
export interface FileDiagnostics {
  path: string
  errors: number
  warnings: number
  infos: number
  hints: number
  /** A few representative messages, most-severe first. */
  sampleMessages: string[]
}

export interface CodeHealthIngestResult {
  filesUpdated: number
  filesCleared: number
}

/**
 * Ingest one `lsp.client.diagnostics` event payload. Returns how many
 * file memories were updated / cleared. Never throws — a shape we
 * don't recognise is simply a no-op.
 */
export function ingestCodeHealth(
  repo: MemoryRepository,
  payload: unknown
): CodeHealthIngestResult {
  const result: CodeHealthIngestResult = { filesUpdated: 0, filesCleared: 0 }
  const perFile = extractDiagnostics(payload)
  if (perFile.length === 0) return result

  for (const fd of perFile) {
    const total = fd.errors + fd.warnings + fd.infos + fd.hints
    if (total === 0) {
      // File is clean now — drop any stale code-health memory for it.
      // upsertBySubject with a "clean" body keeps one tiny memory so
      // the agent can positively learn "this file currently has no
      // diagnostics" rather than just missing-data.
      repo.upsertBySubject({
        category: CATEGORY,
        subject: fd.path,
        content: `${fd.path} currently has no LSP diagnostics (clean).`,
        tags: ["code-health", "clean", fd.path],
        source: "lsp:diagnostics",
      })
      result.filesCleared += 1
      continue
    }

    const parts: string[] = []
    if (fd.errors > 0) parts.push(`${fd.errors} error${fd.errors === 1 ? "" : "s"}`)
    if (fd.warnings > 0) parts.push(`${fd.warnings} warning${fd.warnings === 1 ? "" : "s"}`)
    if (fd.infos > 0) parts.push(`${fd.infos} info`)
    if (fd.hints > 0) parts.push(`${fd.hints} hint${fd.hints === 1 ? "" : "s"}`)

    const sample =
      fd.sampleMessages.length > 0
        ? ` Top: ${fd.sampleMessages.slice(0, 3).map((m) => `"${truncate(m, 100)}"`).join("; ")}.`
        : ""

    const tags = ["code-health", fd.path]
    if (fd.errors > 0) tags.push("has-errors")
    else if (fd.warnings > 0) tags.push("has-warnings")

    repo.upsertBySubject({
      category: CATEGORY,
      subject: fd.path,
      content:
        `${fd.path} currently has ${parts.join(", ")} reported by the language server.${sample}`,
      tags,
      source: "lsp:diagnostics",
    })
    result.filesUpdated += 1
  }

  return result
}

/* ─── defensive extraction ──────────────────────────────────────────── */

/**
 * Pull per-file diagnostic rollups out of an LSP event payload of
 * unknown shape. Handles the shapes seen / plausible across OpenCode
 * versions:
 *
 *   { path|uri, diagnostics: [...] }
 *   { properties: { path|uri, diagnostics: [...] } }
 *   { type, properties: { ... } }                    (raw event)
 *   { path|uri, diagnostics: { [uri]: [...] } }       (grouped)
 *   { diagnostics: { [uri]: [...] } }                 (server-wide map)
 *
 * Anything unrecognised yields an empty array.
 */
export function extractDiagnostics(payload: unknown): FileDiagnostics[] {
  if (!payload || typeof payload !== "object") return []

  // Unwrap a raw event envelope: { type, properties }
  let p = payload as Record<string, unknown>
  if (p.properties && typeof p.properties === "object") {
    p = p.properties as Record<string, unknown>
  }

  const out: FileDiagnostics[] = []

  // Shape A/B: a single file + a diagnostics array.
  const singlePath = pickPath(p)
  const diagField = p.diagnostics

  if (singlePath && Array.isArray(diagField)) {
    out.push(rollup(singlePath, diagField))
    return out
  }

  // Shape D/E: diagnostics is a map of uri/path -> array.
  if (diagField && typeof diagField === "object" && !Array.isArray(diagField)) {
    for (const [key, val] of Object.entries(diagField as Record<string, unknown>)) {
      if (Array.isArray(val)) out.push(rollup(normalisePath(key), val))
    }
    return out
  }

  // Shape: the payload itself is a uri -> array map.
  let looksLikeMap = false
  for (const val of Object.values(p)) {
    if (Array.isArray(val)) {
      looksLikeMap = true
      break
    }
  }
  if (looksLikeMap && !singlePath) {
    for (const [key, val] of Object.entries(p)) {
      if (Array.isArray(val)) out.push(rollup(normalisePath(key), val))
    }
  }

  return out
}

function pickPath(obj: Record<string, unknown>): string | null {
  const candidate = obj.path ?? obj.uri ?? obj.file ?? obj.filePath ?? obj.fileName
  return typeof candidate === "string" ? normalisePath(candidate) : null
}

/** Strip a `file://` scheme and decode, so memories key on a plain path. */
function normalisePath(p: string): string {
  let s = p
  if (s.startsWith("file://")) {
    s = s.slice("file://".length)
    try {
      s = decodeURIComponent(s)
    } catch {
      // leave as-is if it isn't valid percent-encoding
    }
  }
  return s
}

/** Roll a raw diagnostics array up into severity counts + samples. */
function rollup(path: string, diagnostics: unknown[]): FileDiagnostics {
  const fd: FileDiagnostics = {
    path,
    errors: 0,
    warnings: 0,
    infos: 0,
    hints: 0,
    sampleMessages: [],
  }
  // Collect messages with their severity so we can sample most-severe first.
  const withSeverity: Array<{ severity: number; message: string }> = []

  for (const d of diagnostics) {
    if (!d || typeof d !== "object") continue
    const obj = d as Record<string, unknown>
    const severity = typeof obj.severity === "number" ? obj.severity : SEVERITY_WARNING
    const message =
      typeof obj.message === "string"
        ? obj.message
        : typeof obj.msg === "string"
          ? obj.msg
          : ""
    switch (severity) {
      case SEVERITY_ERROR:
        fd.errors += 1
        break
      case SEVERITY_WARNING:
        fd.warnings += 1
        break
      case 3:
        fd.infos += 1
        break
      case 4:
        fd.hints += 1
        break
      default:
        fd.warnings += 1
    }
    if (message) withSeverity.push({ severity, message })
  }

  withSeverity.sort((a, b) => a.severity - b.severity) // 1=error first
  fd.sampleMessages = withSeverity.slice(0, 5).map((x) => x.message)
  return fd
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…"
}
