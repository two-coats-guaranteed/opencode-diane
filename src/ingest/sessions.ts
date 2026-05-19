/**
 * Past-session ingestion.
 *
 * Pulls user-task + tool-trace summaries from previous OpenCode
 * sessions in the same project, via the SDK client that the plugin
 * receives in its context. Sessions live in OpenCode's own SQLite
 * store; we read them through the documented client API rather than
 * touching the DB file.
 *
 * Without an LLM, we extract two kinds of facts per session:
 *   1) The user's first message ("the task").
 *   2) The set of distinct file paths the agent edited/wrote and
 *      bash commands it ran ("the trace").
 *
 * One memory per (sessionId, kind) tuple. Re-ingesting the same
 * session is idempotent thanks to insertIfMissing.
 *
 * Defensive: every SDK call is wrapped — different OpenCode versions
 * expose slightly different methods (session.list / session.messages)
 * and the plugin must keep working when one is absent.
 */

import type { Category } from "../types.js"
import type { MemoryRepository } from "../store/repository.js"

const CATEGORY: Category = "session-trace"

export interface SessionIngestResult {
  sessions: number
  taskMemories: number
  traceMemories: number
  errors: string[]
}

export async function ingestSessions(
  repo: MemoryRepository,
  client: unknown,
  currentSessionId?: string
): Promise<SessionIngestResult> {
  const result: SessionIngestResult = {
    sessions: 0,
    taskMemories: 0,
    traceMemories: 0,
    errors: [],
  }

  const sessions = await safeSessionList(client)
  if (!sessions) {
    result.errors.push("SDK session.list unavailable")
    return result
  }

  for (const s of sessions) {
    if (!s.id || s.id === currentSessionId) continue
    result.sessions += 1
    const messages = await safeSessionMessages(client, s.id)
    if (!messages) continue

    const firstUser = messages.find((m) => m.role === "user")
    if (firstUser) {
      const taskText = extractText(firstUser)
      if (taskText) {
        repo.insertIfMissing({
          category: CATEGORY,
          subject: `task:${s.id}`,
          content: `Task in past session "${s.title ?? s.id}": ${truncate(taskText, 320)}`,
          tags: ["task", `session:${s.id}`],
          source: `session:${s.id}`,
        })
        result.taskMemories += 1
      }
    }

    const trace = summarizeTrace(messages)
    if (trace) {
      repo.insertIfMissing({
        category: CATEGORY,
        subject: `trace:${s.id}`,
        content: trace,
        tags: ["trace", `session:${s.id}`],
        source: `session:${s.id}`,
      })
      result.traceMemories += 1
    }
  }
  repo.setIngestedAt(CATEGORY, Date.now())
  return result
}

/* ─── safe SDK probing ─────────────────────────────────────────────── */

interface SessionLike {
  id: string
  title?: string
}
interface MessageLike {
  role?: string
  content?: unknown
  parts?: unknown[]
  info?: { role?: string }
}

async function safeSessionList(client: unknown): Promise<SessionLike[] | null> {
  const c = client as { session?: { list?: (...args: unknown[]) => Promise<unknown> } } | undefined
  if (!c?.session?.list) return null
  try {
    const res = (await c.session.list({})) as { data?: SessionLike[] } | SessionLike[] | undefined
    if (Array.isArray(res)) return res
    if (res && Array.isArray((res as { data?: SessionLike[] }).data)) {
      return (res as { data: SessionLike[] }).data
    }
    return null
  } catch {
    return null
  }
}

async function safeSessionMessages(
  client: unknown,
  sessionId: string
): Promise<MessageLike[] | null> {
  const c = client as {
    session?: {
      messages?: (args: { path?: { id: string } }) => Promise<unknown>
    }
  } | undefined
  if (!c?.session?.messages) return null
  try {
    const res = (await c.session.messages({ path: { id: sessionId } })) as
      | { data?: MessageLike[] }
      | MessageLike[]
      | undefined
    if (Array.isArray(res)) return res
    if (res && Array.isArray((res as { data?: MessageLike[] }).data)) {
      return (res as { data: MessageLike[] }).data
    }
    return null
  } catch {
    return null
  }
}

/* ─── trace extraction ─────────────────────────────────────────────── */

function extractText(m: MessageLike): string {
  if (typeof m.content === "string") return m.content
  if (Array.isArray(m.parts)) {
    const out: string[] = []
    for (const p of m.parts) {
      if (typeof p === "string") out.push(p)
      else if (
        p && typeof p === "object" &&
        typeof (p as { text?: unknown }).text === "string"
      ) {
        out.push((p as { text: string }).text)
      }
    }
    return out.join(" ")
  }
  return ""
}

function summarizeTrace(messages: MessageLike[]): string | null {
  const files = new Set<string>()
  const bashCmds: string[] = []
  for (const m of messages) {
    if (!Array.isArray(m.parts)) continue
    for (const p of m.parts) {
      if (!p || typeof p !== "object") continue
      const obj = p as Record<string, unknown>
      const toolName =
        (obj.tool as string | undefined) ??
        ((obj.metadata as { tool?: string } | undefined)?.tool) ??
        ""
      const args = (obj.args ?? obj.input ?? {}) as Record<string, unknown>
      if (toolName === "edit" || toolName === "write" || toolName === "multiedit" || toolName === "create") {
        const fp =
          (args.filePath as string | undefined) ??
          (args.path as string | undefined) ??
          (args.file_path as string | undefined)
        if (fp) files.add(fp)
      }
      if (toolName === "bash") {
        const cmd = args.command as string | undefined
        if (cmd) bashCmds.push(truncate(cmd, 80))
      }
    }
  }
  if (files.size === 0 && bashCmds.length === 0) return null
  const parts: string[] = []
  if (files.size > 0) {
    parts.push(`edited files: ${Array.from(files).slice(0, 12).join(", ")}`)
  }
  if (bashCmds.length > 0) {
    parts.push(`bash commands: ${bashCmds.slice(0, 6).join(" | ")}`)
  }
  return parts.join(". ")
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…"
}
