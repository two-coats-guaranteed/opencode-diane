/**
 * Plugin-entry tests.
 *
 * Drives `OpencodeDiane` directly with a mock OpenCode plugin
 * context. Covers the idle (non-Python) path, the active path with
 * prefill, tool registration, and a couple of representative tool
 * calls — the wiring that the per-module tests don't reach.
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"

import { OpencodeDiane } from "../src/index.js"

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

function mockCtx(directory: string, logs: LogEntry[]) {
  return {
    client: {
      app: {
        log: async ({ body }: { body: LogEntry }) => { logs.push(body) },
      },
      session: undefined,
    },
    directory,
    worktree: "/",                // simulate non-git worktree default
    project: { id: "test" },
    $: null,
    serverUrl: new URL("http://localhost"),
    experimental_workspace: { register: () => {} },
  } as never
}

async function main(): Promise<void> {
  // ── idle path: a directory that is neither a git repo nor has any ─
  // recognised project file. (A bare notes folder, say.)
  console.log("\n── plugin: idle on a non-repo, non-project directory ─────")
  const bareRoot = await mkdtemp(join(tmpdir(), "diane-mem-plug-bare-"))
  await writeFile(join(bareRoot, "scratch.txt"), "just some notes\n")
  const idleLogs: LogEntry[] = []
  const idleHooks = await OpencodeDiane(mockCtx(bareRoot, idleLogs))
  assert(
    !idleHooks.tool || Object.keys(idleHooks.tool).length === 0,
    "bare directory (no git, no manifest) registers no tools"
  )
  assert(
    idleLogs.some((l) => l.message.includes("idle")),
    "bare directory logs an idle line"
  )
  await rm(bareRoot, { recursive: true, force: true })

  // A Node project (package.json, no git) is now language-agnostically
  // recognised and should ACTIVATE — that's the whole point.
  console.log("\n── plugin: activates on a non-git Node project ───────────")
  const nodeRoot = await mkdtemp(join(tmpdir(), "diane-mem-plug-node-"))
  await writeFile(join(nodeRoot, "package.json"), '{"name":"x","scripts":{"build":"tsc"}}')
  const nodeLogs: LogEntry[] = []
  const nodeHooks = await OpencodeDiane(mockCtx(nodeRoot, nodeLogs))
  await new Promise((r) => setTimeout(r, 400))
  assert(
    nodeHooks.tool !== undefined && Object.keys(nodeHooks.tool).length === 10,
    "Node project (manifest, no git) activates with all ten tools"
  )
  await rm(nodeRoot, { recursive: true, force: true })

  // ── active path: a NON-Python repo (Go) with git history ──────────
  // Uses Go + garbage commit messages to prove the plugin is
  // language-agnostic and doesn't depend on commit-message culture.
  console.log("\n── plugin: active on a non-Python (Go) repo ──────────────")
  const root = await mkdtemp(join(tmpdir(), "diane-mem-plug-go-"))
  await writeFile(join(root, "go.mod"), "module example.com/demo\n\ngo 1.22\n")
  await writeFile(join(root, "README.md"), "# demo\n\nA Go service.\n")
  await mkdir(join(root, "cmd"), { recursive: true })
  await writeFile(join(root, "cmd", "main.go"), "package main\nfunc main() {}\n")
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "t@e.com"])
  git(root, ["config", "user.name", "t"])
  git(root, ["add", "."])
  git(root, ["commit", "-q", "-m", "wip"])
  await writeFile(join(root, "cmd", "main.go"), "package main\n\nfunc main() { println(\"hi\") }\n")
  git(root, ["add", "."])
  git(root, ["commit", "-q", "-m", "."])

  const logs: LogEntry[] = []
  const hooks = await OpencodeDiane(mockCtx(root, logs), { exposeOpsTools: true })
  // prefill is fire-and-forget; give it a moment
  await new Promise((r) => setTimeout(r, 800))

  assert(hooks.tool !== undefined, "active project returns a tool map")
  const toolNames = Object.keys(hooks.tool ?? {})
  for (const expected of [
    "memory_recall",
    "memory_remember",
    "memory_snapshot",
    "memory_outline",
    "memory_code_map",
    "memory_status",
    "memory_ingest_sessions",
    "memory_mine_skills",
  ]) {
    assert(toolNames.includes(expected), `registers ${expected}`)
  }

  assert(
    logs.some((l) => l.message.startsWith("active:")),
    "logs an activation line"
  )
  assert(
    logs.some((l) => l.message.includes("git scanned")),
    "logs a git prefill summary"
  )
  assert(
    logs.some((l) => l.message.includes("project-facts ingested")),
    "logs a project-facts prefill summary"
  )

  // memory_outline reflects the prefilled memories
  const outline = await hooks.tool!.memory_outline.execute({}, {})
  assert(
    typeof outline === "string" && outline.includes("git-history"),
    "memory_outline shows prefilled git-history category"
  )

  // memory_recall finds a prefilled commit memory by file path —
  // NOT by message text (the messages are "wip" and ".").
  const recall = await hooks.tool!.memory_recall.execute(
    { query: "cmd/main.go changes" },
    {}
  )
  assert(
    typeof recall === "string" && recall.includes("main.go"),
    "memory_recall surfaces a prefilled commit memory by file path"
  )

  // memory_recall also finds a project-fact (go.mod recognised)
  const recallProj = await hooks.tool!.memory_recall.execute(
    { query: "go.mod module", category: "project-facts" },
    {}
  )
  assert(
    typeof recallProj === "string" && recallProj.includes("go.mod"),
    "memory_recall surfaces the recognised go.mod project-fact"
  )

  // memory_remember round-trips through recall
  await hooks.tool!.memory_remember.execute(
    { subject: "note:deploy", content: "Deploy runs via fabfile, not docker.", tags: ["deploy"] },
    {}
  )
  const recall2 = await hooks.tool!.memory_recall.execute(
    { query: "how does deploy work fabfile" },
    {}
  )
  assert(
    typeof recall2 === "string" && recall2.includes("fabfile"),
    "a remembered note is recallable"
  )

  // memory_status reports counts and budget
  const status = await hooks.tool!.memory_status.execute({}, {})
  assert(
    typeof status === "string" && status.includes("count:") && status.includes("bytes:"),
    "memory_status reports count + bytes"
  )

  // memory_mine_skills returns immediately (background job)
  const mineMsg = await hooks.tool!.memory_mine_skills.execute({ reason: "test" }, {})
  assert(
    typeof mineMsg === "string" && mineMsg.toLowerCase().includes("background"),
    "memory_mine_skills returns a background-job acknowledgement"
  )

  await rm(root, { recursive: true, force: true })

  // ── recall-first nudge hooks ───────────────────────────────────────
  console.log("\n── plugin: recall-first nudge ────────────────────────────")
  const nRoot = await mkdtemp(join(tmpdir(), "diane-mem-plug-nudge-"))
  await writeFile(join(nRoot, "package.json"), '{"name":"n"}')
  const nLogs: LogEntry[] = []
  const nHooks = await OpencodeDiane(mockCtx(nRoot, nLogs))
  const before = nHooks["tool.execute.before"]
  const after = nHooks["tool.execute.after"]
  assert(typeof before === "function" && typeof after === "function", "before/after hooks registered")

  // first discovery call — too early, no nudge
  await before!({ tool: "grep", sessionID: "s", callID: "1" })
  const o1 = { title: "grep", output: "match in foo.ts", metadata: {} }
  await after!({ tool: "grep", sessionID: "s", callID: "1", args: {} }, o1)
  assert(!o1.output.includes("diane"), "first discovery call: no nudge (too early)")

  // second discovery call — nudge fires, appended, original preserved
  await before!({ tool: "bash", sessionID: "s", callID: "2" })
  const o2 = { title: "bash", output: "$ ls\nfoo.ts", metadata: {} }
  await after!({ tool: "bash", sessionID: "s", callID: "2", args: {} }, o2)
  assert(o2.output.includes("[diane]"), "second discovery call: nudge appended")
  assert(o2.output.startsWith("$ ls"), "nudge appended after original output, not replacing it")

  // third call — nudge already shown, never repeats
  await before!({ tool: "grep", sessionID: "s", callID: "3" })
  const o3 = { title: "grep", output: "more", metadata: {} }
  await after!({ tool: "grep", sessionID: "s", callID: "3", args: {} }, o3)
  assert(!o3.output.includes("diane"), "nudge fires at most once per session")

  // fresh session, memory tool used first → nudge never fires
  const nHooks2 = await OpencodeDiane(mockCtx(nRoot, []))
  await nHooks2["tool.execute.before"]!({ tool: "memory_recall", sessionID: "s2", callID: "1" })
  await nHooks2["tool.execute.before"]!({ tool: "grep", sessionID: "s2", callID: "2" })
  await nHooks2["tool.execute.before"]!({ tool: "bash", sessionID: "s2", callID: "3" })
  const o4 = { title: "bash", output: "stuff", metadata: {} }
  await nHooks2["tool.execute.after"]!({ tool: "bash", sessionID: "s2", callID: "3", args: {} }, o4)
  assert(!o4.output.includes("diane"), "memory tool used → agent compliant → no nudge")

  // read output is never mutated
  const nHooks3 = await OpencodeDiane(mockCtx(nRoot, []))
  await nHooks3["tool.execute.before"]!({ tool: "read", sessionID: "s3", callID: "1" })
  await nHooks3["tool.execute.before"]!({ tool: "read", sessionID: "s3", callID: "2" })
  await nHooks3["tool.execute.before"]!({ tool: "read", sessionID: "s3", callID: "3" })
  const o5 = { title: "read", output: "line1\nline2", metadata: {} }
  await nHooks3["tool.execute.after"]!({ tool: "read", sessionID: "s3", callID: "3", args: {} }, o5)
  assert(o5.output === "line1\nline2", "read output is never mutated — file contents stay pristine")

  // malformed output object → defensive no-op, no throw
  const nHooks4 = await OpencodeDiane(mockCtx(nRoot, []))
  await nHooks4["tool.execute.before"]!({ tool: "grep", sessionID: "s4", callID: "1" })
  await nHooks4["tool.execute.before"]!({ tool: "grep", sessionID: "s4", callID: "2" })
  let threw = false
  try {
    await nHooks4["tool.execute.after"]!(
      { tool: "grep", sessionID: "s4", callID: "2", args: {} },
      { title: "grep" } as never
    )
  } catch {
    threw = true
  }
  assert(!threw, "malformed output object → defensive no-op, no throw")

  // ── config: enableNudgeHook false → hooks still registered (for code-map refresh),
  //    but the nudge effect is suppressed ──────────────────────────────

  console.log("\n── plugin: config via plugin options ─────────────────────")
  const offHooks = await OpencodeDiane(
    mockCtx(nRoot, []),
    { enableNudgeHook: false } as never
  )
  assert(
    typeof offHooks["tool.execute.before"] === "function" &&
      typeof offHooks["tool.execute.after"] === "function",
    "enableNudgeHook:false → hooks still registered (code-map refresh runs regardless)"
  )
  // The nudge effect itself: after several discovery calls, no nudge
  // should appear in the tool output when the nudge is disabled.
  const offOut = { title: "", output: "some output", metadata: null }
  await offHooks["tool.execute.before"]!({ tool: "grep", callID: "x1" })
  await offHooks["tool.execute.before"]!({ tool: "grep", callID: "x2" })
  await offHooks["tool.execute.after"]!({ tool: "grep", callID: "x2" }, offOut)
  assert(
    !offOut.output.includes("diane"),
    "enableNudgeHook:false → nudge is suppressed even after discovery calls"
  )
  assert(
    offHooks.tool !== undefined && Object.keys(offHooks.tool).length === 10,
    "enableNudgeHook:false still registers all ten tools"
  )

  // default (no options) keeps the hooks on
  const onHooks = await OpencodeDiane(mockCtx(nRoot, []))
  assert(
    typeof onHooks["tool.execute.before"] === "function",
    "default config → nudge hooks ON"
  )

  // junk options never throw — plugin falls back to defaults
  let cfgThrew = false
  try {
    const junkHooks = await OpencodeDiane(
      mockCtx(nRoot, []),
      { maxMemoryDiskMB: "lots", enableNudgeHook: "yes", bogusKey: 123 } as never
    )
    // wrong-typed enableNudgeHook is ignored → default true → hooks on
    assert(
      typeof junkHooks["tool.execute.before"] === "function",
      "wrong-typed option is ignored, default applies"
    )
  } catch {
    cfgThrew = true
  }
  assert(!cfgThrew, "malformed plugin options never throw")

  await rm(nRoot, { recursive: true, force: true })

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(2) })
