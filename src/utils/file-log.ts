/**
 * Rich, structured logging to disk. A second log sink alongside
 * OpenCode's own session log channel — the existing `log()` callback
 * keeps piping human-readable lines into OpenCode's UI, and this
 * module mirrors them (plus structured events) to a JSONL file under
 * `os.tmpdir()/opencode-diane/`. The file is per-session and per-PID, so
 * parallel OpenCode sessions never interleave; each line is a
 * standalone JSON object so the whole file is greppable AND
 * `jq`-able.
 *
 * Why not into OpenCode's log alone:
 *   - OpenCode's log is human-oriented (single-line strings) and is
 *     scoped to a session's UI panel — easy to lose between turns.
 *   - For debugging the plugin itself (a flush that took 200ms, an
 *     ingester that skipped half its commits, an eviction that fired
 *     under budget) you want timestamped, machine-readable, persistent
 *     records you can keep across sessions and diff.
 *
 * Why JSONL not a text log:
 *   - One line per record, never multi-line, so `tail -f` works.
 *   - Each line is valid JSON, so `jq '.event == "ingest.git"'` works.
 *   - Streams append cleanly even from multiple writers (each line is
 *     atomic on POSIX up to PIPE_BUF, and our records are well under).
 *
 * Failure model: every disk operation can fail (full disk, permission
 * lost, tmpdir on a flaky volume). A failure HERE must never propagate
 * to the host plugin — the file logger is a debugging aid, not a
 * correctness dependency. We try once, drop the stream on any error,
 * and go silent. The OpenCode log channel is unaffected.
 *
 * Retention is the user's problem: we never delete; files accumulate
 * in `os.tmpdir()/opencode-diane/` until the OS clears tmp. On Linux
 * that's typically at reboot or via systemd-tmpfiles; on macOS every
 * few days. Documented in WIKI.
 */

import { mkdirSync, openSync, writeSync, closeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type LogLevel = "debug" | "info" | "warn" | "error"

/**
 * Public surface. `log()` writes a line message (mirrors what
 * OpenCode's own log channel takes); `event()` writes a structured
 * record with a name and a typed payload. `path()` returns the file
 * the logger is writing to — useful at startup to print "rich logs at
 * <path>" so the user can find them. `close()` drains the stream.
 */
export interface FileLogger {
  log(level: LogLevel, message: string): void
  event(name: string, data?: Record<string, unknown>): void
  path(): string
  close(): void
}

export interface CreateFileLoggerOptions {
  /** Service name — used in the filename and on every record. */
  service: string
  /**
   * Fields included on EVERY record (e.g. `{ root: "/path/to/repo" }`).
   * Kept small — they multiply across every line of the file.
   */
  base?: Record<string, unknown>
}

/** Directory the logger writes into. Exported for tests + docs. */
export function richLogsDir(): string {
  return join(tmpdir(), "opencode-diane")
}

/**
 * Best-effort sanitiser for values put on a structured event payload —
 * trims long strings to keep the log file manageable and caps arrays
 * at a sensible length. Used to shape the `args` field of a
 * `tool.call` event before it lands on disk: a tool's free-form
 * `query` or `content` field could in principle be many KB, and we
 * don't want a single log line to dominate the file. The marker
 * `…(+N chars)` / `…(+N items)` is preserved so a reader knows the
 * truncation happened. Returns the trimmed value; doesn't mutate the
 * input. Shallow-recurses through plain objects and arrays — there's
 * no cycle protection because tool args are flat data, but a try
 * around the caller's `JSON.stringify` still catches anything weird.
 */
export function truncateForLog(value: unknown, maxStringLength = 500): unknown {
  if (typeof value === "string") {
    if (value.length <= maxStringLength) return value
    return value.slice(0, maxStringLength) + `…(+${value.length - maxStringLength} chars)`
  }
  if (Array.isArray(value)) {
    const MAX_ITEMS = 20
    const head = value.slice(0, MAX_ITEMS).map((v) => truncateForLog(v, maxStringLength))
    return value.length > MAX_ITEMS
      ? [...head, `…(+${value.length - MAX_ITEMS} items)`]
      : head
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateForLog(v, maxStringLength)
    }
    return out
  }
  return value
}

/**
 * Build the per-session filename. Public so tests can predict the
 * shape (the timestamp is "now" and the pid is `process.pid`, so the
 * test doesn't actually call this — it reads `logger.path()`). The
 * ISO timestamp has its colons and dots replaced with dashes so the
 * filename is portable across filesystems.
 */
function buildFilename(service: string, when: Date, pid: number): string {
  const ts = when.toISOString().replace(/[:.]/g, "-")
  return `${service}-${ts}-pid${pid}.jsonl`
}

class FileLoggerImpl implements FileLogger {
  /** Open file descriptor, or null once a write fails / after close. */
  private fd: number | null
  private readonly filePath: string
  private readonly base: Record<string, unknown>

  constructor(opts: CreateFileLoggerOptions) {
    // `service` is part of the filename, so a stray slash or NUL would
    // be a path-injection foot-gun. Tolerate weird values by sanitising.
    const safeService = opts.service.replace(/[^A-Za-z0-9._-]/g, "_") || "service"
    const dir = richLogsDir()
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* tolerated — openSync below will throw, we'll go silent */
    }
    this.filePath = join(dir, buildFilename(safeService, new Date(), process.pid))
    this.base = { service: opts.service, ...(opts.base ?? {}) }

    // Synchronous open + write semantics. Why not createWriteStream:
    // WriteStream buffers writes (16KB highWaterMark by default) and
    // flushes asynchronously; an event "logged" right before a crash
    // can be lost, and the very test below this code initially flaked
    // on that. For debug logs reliability beats per-write speed —
    // log lines are at human pace, not microseconds. A single openSync
    // at construction + writeSync per record gives us atomic appends
    // (POSIX guarantees this for writes ≤ PIPE_BUF, our records are
    // ~200 bytes) and durability on syscall return.
    //
    // "a" flag = O_APPEND | O_CREAT | O_WRONLY. Append is the right
    // semantics here: multiple loggers (parallel sessions) can target
    // the same path without clobbering, and the kernel serialises
    // appends so lines never interleave mid-record.
    let fd: number | null = null
    try {
      fd = openSync(this.filePath, "a")
    } catch {
      fd = null
    }
    this.fd = fd

    // Header record — gives any reader of the file immediate context
    // (which plugin, which process, which node version, which cwd).
    this.event("session.start", {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      cwd: process.cwd(),
    })
  }

  log(level: LogLevel, message: string): void {
    this.write({ level, message })
  }

  event(name: string, data?: Record<string, unknown>): void {
    this.write({ event: name, ...(data ?? {}) })
  }

  private write(fields: Record<string, unknown>): void {
    if (this.fd === null) return
    // Order matters for readability: ts and service first, then base
    // fields (root, etc.), then the event-specific payload last. Use
    // ISO time with ms — coarser timestamps make ordering ambiguous
    // when multiple events fire in the same loop tick.
    let line: string
    try {
      const rec = { ts: new Date().toISOString(), ...this.base, ...fields }
      line = JSON.stringify(rec) + "\n"
    } catch {
      // Unserialisable payload (e.g. a value containing a BigInt or a
      // circular reference). Fall back to a safe placeholder rather
      // than swallowing the event entirely.
      line =
        JSON.stringify({
          ts: new Date().toISOString(),
          ...this.base,
          event: "log.write_failed",
          attempted: String(fields.event ?? fields.level ?? "?"),
        }) + "\n"
    }
    try {
      writeSync(this.fd, line)
    } catch {
      // Disk full, fd closed underneath us, etc. — drop the fd and go
      // silent for the rest of the session. Never propagate.
      try {
        closeSync(this.fd)
      } catch {
        /* ignore */
      }
      this.fd = null
    }
  }

  path(): string {
    return this.filePath
  }

  close(): void {
    if (this.fd === null) return
    try {
      closeSync(this.fd)
    } catch {
      /* ignore — we're shutting down anyway */
    }
    this.fd = null
  }
}

export function createFileLogger(opts: CreateFileLoggerOptions): FileLogger {
  return new FileLoggerImpl(opts)
}
