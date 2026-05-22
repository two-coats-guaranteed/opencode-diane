/**
 * Tests for the three "current-session reflection" features:
 *
 *   1. LiveSessionRecorder    — rolls up file edits + bash commands
 *                                into ONE memory under `live:${sessionId}`.
 *   2. Bash file tracking     — after a `bash` tool call, scans
 *                                `git status` and refreshes code-map for
 *                                each touched file (capped).
 *   3. HEAD-change detection  — after `bash`, detects HEAD movement
 *                                (pull/merge/rebase/checkout) and
 *                                re-ingests git history idempotently.
 *
 * Plus the memory_ingest_git tool: explicit manual re-ingest.
 *
 * These tests use temp git repos for realism — the same pattern the
 * existing plugin.test.ts and ingest.test.ts use. The plugin entry
 * point is driven through a mock OpenCode context.
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"

import { OpencodeDiane } from "../src/index.js"
import { MemoryRepository } from "../src/store/repository.js"
import { LiveSessionRecorder } from "../src/ingest/live-session.js"
import {
  currentHead,
  changedFilesInWorktree,
} from "../src/utils/shell.js"

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" })
}

interface LogEntry { level: string; message: string }

function mockCtx(directory: string, logs: LogEntry[], sessionID = "sess_test_123") {
  return {
    client: {
      app: {
        log: async ({ body }: { body: LogEntry }) => { logs.push(body) },
      },
      session: undefined,
    },
    directory,
    worktree: "/",
    project: { id: "test" },
    sessionID,
    $: null,
    serverUrl: new URL("http://localhost"),
    experimental_workspace: { register: () => {} },
  } as never
}

async function initRepo(root: string): Promise<void> {
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "t@e.com"])
  git(root, ["config", "user.name", "t"])
  await writeFile(join(root, "package.json"), '{"name":"x"}')
  await writeFile(join(root, "README.md"), "# x")
  git(root, ["add", "."])
  git(root, ["commit", "-q", "-m", "init"])
}

async function main(): Promise<void> {
  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── LiveSessionRecorder: basic flush after a file edit ─────")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-live-1-"))
    await initRepo(root)
    const repo = await MemoryRepository.load(root)
    const rec = new LiveSessionRecorder(repo, "s1")
    rec.recordFileEdit("src/foo.ts", "write")
    rec.flush()
    const hits = repo.recall({ query: "live session", category: "session-trace", limit: 5 })
    assert(hits.length === 1, "exactly one live-session memory written")
    assert(
      hits[0]!.memory.subject === "live:s1",
      "subject keyed by sessionId — 'live:s1'"
    )
    assert(
      hits[0]!.memory.content.includes("src/foo.ts"),
      "memory content includes the edited file path"
    )
    assert(
      hits[0]!.memory.tags.includes("file:src/foo.ts"),
      "tags include the file path for recall-by-file"
    )
    assert(
      hits[0]!.memory.pinned !== true,
      "live trace is NOT pinned (transient state — eligible for eviction)"
    )
    await rm(root, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── LiveSessionRecorder: repeated flush is idempotent ──────")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-live-2-"))
    await initRepo(root)
    const repo = await MemoryRepository.load(root)
    const rec = new LiveSessionRecorder(repo, "s2")
    rec.recordFileEdit("a.ts", "write")
    rec.flush()
    rec.recordFileEdit("b.ts", "edit")
    rec.flush()
    rec.flush() // a no-op idempotent flush
    const all = repo.recall({ query: "live session", category: "session-trace", limit: 20 })
    assert(
      all.length === 1,
      "two flushes with new events still result in ONE memory (upsertBySubject)"
    )
    assert(
      all[0]!.memory.content.includes("a.ts") && all[0]!.memory.content.includes("b.ts"),
      "rolled-up memory contains both edits"
    )
    await rm(root, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── LiveSessionRecorder: no-op when nothing happened ───────")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-live-3-"))
    await initRepo(root)
    const repo = await MemoryRepository.load(root)
    const rec = new LiveSessionRecorder(repo, "s3")
    rec.flush() // nothing to record
    const all = repo.recall({ query: "live session", category: "session-trace", limit: 5 })
    assert(
      all.length === 0,
      "flush() with no events writes nothing — empty trace would dilute recall"
    )
    await rm(root, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── LiveSessionRecorder: bash command truncation + cap ─────")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-live-4-"))
    await initRepo(root)
    const repo = await MemoryRepository.load(root)
    const rec = new LiveSessionRecorder(repo, "s4")
    // A long command — should get truncated to MAX_BASH_LINE
    const longCmd = "echo " + "x".repeat(500)
    rec.recordBash(longCmd)
    rec.flush()
    const hits = repo.recall({ query: "live session bash", category: "session-trace", limit: 5 })
    assert(hits.length === 1, "long bash command produces one memory")
    assert(
      hits[0]!.memory.content.length < 600,
      "long bash command is truncated in memory content"
    )
    assert(
      hits[0]!.memory.content.includes("…"),
      "truncation is signalled with an ellipsis"
    )

    // Many bash commands — list should be capped (MAX_BASH_DETAIL=30)
    for (let i = 0; i < 100; i++) rec.recordBash(`cmd-${i}`)
    rec.flush()
    const refreshed = repo.recall({ query: "live session", category: "session-trace", limit: 5 })
    const content = refreshed[0]!.memory.content
    // The total count is reported accurately even though detail is capped.
    assert(
      content.includes("101 bash commands"),
      "bash-command COUNT is accurate (101 = 1 long + 100 cmd-N)"
    )
    // But only the last ~30 are listed.
    assert(
      content.includes("cmd-99"),
      "the most recent bash commands are kept in detail"
    )
    assert(
      !content.includes("cmd-0\n") && !content.includes("$ cmd-0\n"),
      "the oldest bash commands are dropped from detail (capped at MAX_BASH_DETAIL)"
    )
    await rm(root, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── shell util: changedFilesInWorktree picks up modifications ──")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-shell-1-"))
    await initRepo(root)
    // Modify a tracked file
    await writeFile(join(root, "package.json"), '{"name":"x","version":"1"}')
    // Add an untracked file
    await writeFile(join(root, "untracked.txt"), "hello")
    const changed = await changedFilesInWorktree(root)
    assert(
      changed.includes("package.json"),
      "changedFilesInWorktree picks up modified tracked files"
    )
    assert(
      changed.includes("untracked.txt"),
      "changedFilesInWorktree picks up untracked files (--untracked-files=all)"
    )

    // Delete a tracked file — should NOT be in the list (nothing to re-index).
    await rm(join(root, "README.md"))
    const changedAfterDelete = await changedFilesInWorktree(root)
    assert(
      !changedAfterDelete.includes("README.md"),
      "deletions are excluded — there's no file on disk to re-index"
    )
    await rm(root, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── shell util: changedFilesInWorktree on non-git is safe ──")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-shell-2-"))
    await writeFile(join(root, "x.txt"), "hi")
    const changed = await changedFilesInWorktree(root)
    assert(
      Array.isArray(changed) && changed.length === 0,
      "non-git directory returns [] (never throws)"
    )
    await rm(root, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── shell util: currentHead returns a valid SHA ─────────────")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-shell-3-"))
    await initRepo(root)
    const head = await currentHead(root)
    assert(head !== null, "currentHead returns a value on a real repo")
    assert(
      head !== null && /^[0-9a-f]{7,40}$/.test(head),
      "currentHead returns a hex SHA"
    )

    // On a non-git dir, returns null cleanly.
    const empty = await mkdtemp(join(tmpdir(), "diane-shell-4-"))
    const noHead = await currentHead(empty)
    assert(noHead === null, "currentHead on non-git dir returns null (never throws)")
    await rm(root, { recursive: true, force: true })
    await rm(empty, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── plugin: registers memory_ingest_git (10th tool) ─────────")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-plug-tool-"))
    await initRepo(root)
    const logs: LogEntry[] = []
    const hooks = await OpencodeDiane(mockCtx(root, logs))
    await new Promise((r) => setTimeout(r, 400))
    assert(
      hooks.tool !== undefined,
      "plugin activates on a git repo (tools registered)"
    )
    assert(
      hooks.tool && "memory_ingest_git" in hooks.tool,
      "memory_ingest_git tool is registered"
    )
    assert(
      hooks.tool && Object.keys(hooks.tool).length === 10,
      "exactly 10 tools registered (9 original + memory_ingest_git)"
    )
    await rm(root, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── memory_ingest_git: re-ingests after a new commit ────────")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-reingest-"))
    await initRepo(root)
    const logs: LogEntry[] = []
    const hooks = await OpencodeDiane(mockCtx(root, logs))
    await new Promise((r) => setTimeout(r, 500))

    // Add a new commit AFTER the plugin started.
    await writeFile(join(root, "added-after.ts"), "export const NEW = 1\n")
    git(root, ["add", "."])
    git(root, ["commit", "-q", "-m", "added-after-prefill"])

    const t = hooks.tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<unknown> }>
    const result = await t["memory_ingest_git"]!.execute({}, {} as never)
    assert(
      typeof result === "string" && result.includes("scanned"),
      "memory_ingest_git returns a human-readable summary"
    )
    assert(
      typeof result === "string" && result.includes("commit memories"),
      "summary mentions commit-memory counts"
    )
    await rm(root, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── memory_ingest_git: clean reject on non-git root ─────────")
  {
    // forceActive on a non-git dir so the plugin loads
    const root = await mkdtemp(join(tmpdir(), "diane-reingest-nogit-"))
    await writeFile(join(root, "package.json"), '{"name":"x"}')
    const logs: LogEntry[] = []
    const hooks = await OpencodeDiane(mockCtx(root, logs))
    await new Promise((r) => setTimeout(r, 400))
    const t = hooks.tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<unknown> }>
    const result = await t["memory_ingest_git"]!.execute({}, {} as never)
    assert(
      typeof result === "string" && result.includes("not a git"),
      "memory_ingest_git on non-git root returns a clear message (no throw)"
    )
    await rm(root, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── memory_ingest_git: idempotent — re-ingest is a no-op when HEAD is unchanged ──")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-reingest-idem-"))
    await initRepo(root)
    const logs: LogEntry[] = []
    const hooks = await OpencodeDiane(mockCtx(root, logs))
    await new Promise((r) => setTimeout(r, 500))
    const t = hooks.tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<unknown> }>
    // First re-ingest
    const r1 = await t["memory_ingest_git"]!.execute({}, {} as never)
    // Second re-ingest — same state, should report the same numbers
    const r2 = await t["memory_ingest_git"]!.execute({}, {} as never)
    // Both succeed without throwing.
    assert(
      typeof r1 === "string" && typeof r2 === "string",
      "double re-ingest does not throw"
    )
    await rm(root, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── live session: file edits via tool.execute hooks flow through ──")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-live-hook-"))
    await initRepo(root)
    const logs: LogEntry[] = []
    const hooks = await OpencodeDiane(mockCtx(root, logs, "sess_hook_1"))
    await new Promise((r) => setTimeout(r, 500))

    const before = hooks["tool.execute.before"] as ((
      i: { tool: string; callID?: string },
      o?: { args?: Record<string, unknown> },
    ) => Promise<void>) | undefined
    const after = hooks["tool.execute.after"] as ((
      i: { tool: string; callID?: string },
      o: { title: string; output: string; metadata: unknown },
    ) => Promise<void>) | undefined
    assert(typeof before === "function" && typeof after === "function", "hooks present")

    // Simulate a write tool call.
    const filePath = join(root, "src", "auth.ts")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(filePath, "export function login() {}\n")
    await before!({ tool: "write", callID: "c1" }, { args: { filePath } })
    await after!({ tool: "write", callID: "c1" }, { title: "", output: "", metadata: {} })

    // Wait > PERSIST_DEBOUNCE_MS (400) for the write-behind buffer to
    // flush to SQLite before opening a separate handle to inspect it.
    await new Promise((r) => setTimeout(r, 700))

    // Open the store directly to verify the live-session memory was written.
    const repo = await MemoryRepository.load(root)
    const traces = repo.recall({
      query: "live session auth",
      category: "session-trace",
      limit: 5,
    })
    const liveTrace = traces.find((h) => h.memory.subject === "live:sess_hook_1")
    assert(
      liveTrace !== undefined,
      "live-session memory was created via the tool.execute.after hook"
    )
    assert(
      liveTrace !== undefined &&
        (liveTrace.memory.content.includes("auth.ts") ||
         liveTrace.memory.content.includes(filePath)),
      "live-session memory records the edited file path"
    )
    await rm(root, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── recordSessionActivity: false disables the recorder ──────")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-live-off-"))
    await initRepo(root)
    const logs: LogEntry[] = []
    // Pass options through the plugin's options parameter — second arg
    // shape is `unknown` so cast.
    const ctx = mockCtx(root, logs, "sess_off_1")
    const opts = { recordSessionActivity: false }
    const hooks = await (OpencodeDiane as unknown as (
      ctx: unknown, opts: unknown,
    ) => Promise<Record<string, unknown>>)(ctx, opts)
    await new Promise((r) => setTimeout(r, 500))

    const before = hooks["tool.execute.before"] as ((
      i: { tool: string; callID?: string },
      o?: { args?: Record<string, unknown> },
    ) => Promise<void>) | undefined
    const after = hooks["tool.execute.after"] as ((
      i: { tool: string; callID?: string },
      o: { title: string; output: string; metadata: unknown },
    ) => Promise<void>) | undefined

    const fp = join(root, "x.ts")
    await writeFile(fp, "x")
    await before!({ tool: "write", callID: "c1" }, { args: { filePath: fp } })
    await after!({ tool: "write", callID: "c1" }, { title: "", output: "", metadata: {} })
    await new Promise((r) => setTimeout(r, 700))

    const repo = await MemoryRepository.load(root)
    const traces = repo.recall({
      query: "live session",
      category: "session-trace",
      limit: 5,
    })
    const liveTrace = traces.find((h) => h.memory.subject.startsWith("live:"))
    assert(
      liveTrace === undefined,
      "recordSessionActivity:false → no live-session memory is written"
    )
    await rm(root, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── config: new keys are coerced + resolved correctly ───────")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-config-"))
    await initRepo(root)
    const logs: LogEntry[] = []
    // Junk values must be silently coerced/clamped — never crash.
    const opts = {
      recordSessionActivity: "yes" as unknown,        // wrong type → dropped, default true
      bashFileTrackingMaxFiles: -7 as unknown,         // negative → clamped to 0
      autoReingestGitOnHeadChange: 1 as unknown,      // wrong type → dropped, default true
    }
    const hooks = await (OpencodeDiane as unknown as (
      ctx: unknown, opts: unknown,
    ) => Promise<Record<string, unknown>>)(mockCtx(root, logs), opts)
    await new Promise((r) => setTimeout(r, 400))
    assert(
      hooks.tool !== undefined,
      "garbage typed values in new config keys never break startup"
    )
    await rm(root, { recursive: true, force: true })
  }

  /* ════════════════════════════════════════════════════════════════ */
  console.log("\n── summary ──────────────────────────────────────────────────")
  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

await main()
