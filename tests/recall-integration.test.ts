/**
 * recall-integration.test.ts — exercises the WIRED recall path in index.ts that
 * unit tests miss: the session working-set boost with co-change INJECTION, the
 * `by`-mode gating/fallback, and the rerank's chunk extractor. Drives the real
 * plugin (real git ingestion, real tool.execute hooks, real memory_recall tool)
 * rather than the pure helpers, so a regression in the gating, the
 * bySubject/byId injection lookup, or the compose order is actually caught.
 *
 * Deliberately no embedder: the working-set injection is gated on
 * `enableSessionWorkingSet` only, so it is fully testable without the e5 model.
 * The model-dependent semantic blend / at-recall rerank embedding is left to the
 * pure-function tests plus the fallback assertion here — driving the real model
 * would require an injection seam and an async-readiness wait (flaky), which is a
 * worse trade than leaving that thin glue to its unit coverage.
 *
 * Script-style; run with: bun run tests/recall-integration.test.ts
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"

import { OpencodeDiane } from "../src/index.js"
import { extractFunctionChunks } from "../src/read-view.js"

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
    client: { app: { log: async ({ body }: { body: LogEntry }) => { logs.push(body) } }, session: undefined },
    directory,
    worktree: "/",
    project: { id: "test" },
    $: null,
    serverUrl: new URL("http://localhost"),
    experimental_workspace: { register: () => {} },
  } as never
}

/** True only if `subject` appears as a numbered "Start here" RESULT line
 *  ("N. <subject> — …"), not merely as text inside some other memory's content
 *  (e.g. a commit's file list or the recency roster). This distinguishes a file
 *  the recall actually surfaced from one incidentally mentioned. */
function surfaced(output: string, subject: string): boolean {
  const esc = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^\\s*\\d+\\.\\s+${esc}\\b`, "m").test(output)
}

/** Build a repo where src/auth.py and src/auth_helpers.py CO-CHANGE (committed
 *  together ≥3 times) but use disjoint vocabulary, and a lexically-unrelated
 *  distractor. Commit messages are neutral so only code-map terms drive recall. */
async function buildRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diane-recall-int-"))
  await mkdir(join(root, "src"), { recursive: true })
  const auth = join(root, "src", "auth.py")
  const helpers = join(root, "src", "auth_helpers.py")
  const plotting = join(root, "src", "plotting.py")
  // code-map indexes file paths + signatures (not docstrings), so the query
  // hooks below are file/function names, which is what recall can match.
  await writeFile(auth, "def login_user(name):\n    return name\n")
  await writeFile(helpers, "def make_cookie(value):\n    return value\n")
  await writeFile(plotting, "def render_chart(fig):\n    return fig\n")
  await writeFile(join(root, "README.md"), "# demo\n")
  git(root, ["init", "-q"]); git(root, ["config", "user.email", "t@e.com"]); git(root, ["config", "user.name", "t"])
  git(root, ["add", "."]); git(root, ["commit", "-q", "-m", "init"])
  // auth.py + auth_helpers.py change TOGETHER three more times → co-change edge
  for (let i = 0; i < 3; i++) {
    await writeFile(auth, `def login_user(name):\n    return name  # rev ${i}\n`)
    await writeFile(helpers, `def make_cookie(value):\n    return value  # rev ${i}\n`)
    git(root, ["add", "."]); git(root, ["commit", "-q", "-m", `update ${i}`])
  }
  return root
}

const Q = "login_user" // function name unique to auth.py — no git-memory or filename cross-matches
const Q_OTHER = "render_chart" // function name unique to plotting.py — no path to auth.py / auth_helpers.py / git memories

/** Fire the real before+after edit hooks for `relPath` so a recalled file the
 *  agent "edits" enters the working set via the genuine recall→edit link. */
async function simulateEdit(hooks: Record<string, unknown>, root: string, relPath: string, callID: string): Promise<void> {
  const before = hooks["tool.execute.before"] as (i: unknown, o: unknown) => Promise<void>
  const after = hooks["tool.execute.after"] as (i: unknown, o: unknown) => Promise<void>
  await before({ tool: "write", callID }, { args: { filePath: join(root, relPath) } })
  await after(
    { tool: "write", callID, sessionID: "sess" },
    { title: "", output: "", metadata: {} }
  )
}

async function main(): Promise<void> {
  const root = await buildRepo()

  console.log("\n── working-set co-change injection (the wired path) ───────")
  const logs: LogEntry[] = []
  const hooks = (await OpencodeDiane(mockCtx(root, logs))) as unknown as Record<string, unknown>
  await new Promise((r) => setTimeout(r, 1200)) // prefill: code-map + git + co-change
  const tool = (hooks.tool as Record<string, { execute: (a: unknown, c: unknown) => Promise<unknown> }>)
  assert(tool?.memory_recall !== undefined, "plugin activated with memory_recall")

  // Baseline FIRST, before anything is in the working set: an unrelated query
  // surfaces its own file but NOT auth_helpers.py. (diane's base recall is
  // already co-change-boosted, so a query for auth.py would surface
  // auth_helpers.py independently of the working set — which is exactly why we
  // isolate using a query that has no lexical or co-change path to auth_helpers.)
  const rOtherBaseline = (await tool.memory_recall.execute({ query: Q_OTHER }, {})) as string
  assert(surfaced(rOtherBaseline, "src/plotting.py"), "baseline: an unrelated query surfaces its own file (plotting.py)")
  assert(
    !surfaced(rOtherBaseline, "src/auth_helpers.py"),
    "baseline: the unrelated query does NOT surface auth_helpers.py as a result (no lexical or co-change path to it)"
  )

  // Recall auth.py — this sets lastRecall to auth.py IMMEDIATELY before the edit,
  // so the recall→edit link fires and auth.py enters the working set.
  const r0 = (await tool.memory_recall.execute({ query: Q }, {})) as string
  assert(typeof r0 === "string" && surfaced(r0, "src/auth.py"), "recall surfaces the lexically-matching auth.py")
  await simulateEdit(hooks, root, "src/auth.py", "c1")

  // Now the SAME unrelated query: auth_helpers.py should appear purely because
  // the working set remembers the edited auth.py and injects its co-change
  // neighbour — a single topic-shift does not flush (sustained-drift guard).
  const rOtherBoosted = (await tool.memory_recall.execute({ query: Q_OTHER }, {})) as string
  assert(
    surfaced(rOtherBoosted, "src/auth_helpers.py"),
    "INJECTION (isolated): after editing auth.py, a query for an unrelated file still surfaces auth.py's co-change neighbour auth_helpers.py as a result — only the working-set prior can do this"
  )
  assert(surfaced(rOtherBoosted, "src/plotting.py"), "the query's own lexical match is still present alongside the injected neighbour")

  console.log("\n── by-mode gating / graceful fallback (no model) ─────────")
  const rName = (await tool.memory_recall.execute({ query: Q, by: "name" }, {})) as string
  assert(typeof rName === "string" && surfaced(rName, "src/auth.py"), "by:'name' returns lexical results")
  const rMeaning = (await tool.memory_recall.execute({ query: Q, by: "meaning" }, {})) as string
  assert(
    typeof rMeaning === "string" && surfaced(rMeaning, "src/auth.py"),
    "by:'meaning' with semantic OFF degrades to lexical instead of failing"
  )

  console.log("\n── gating: enableSessionWorkingSet:false suppresses injection")
  const root2 = await buildRepo()
  const logs2: LogEntry[] = []
  const hooks2 = (await OpencodeDiane(mockCtx(root2, logs2), { enableSessionWorkingSet: false } as never)) as unknown as Record<string, unknown>
  await new Promise((r) => setTimeout(r, 1200))
  const tool2 = hooks2.tool as Record<string, { execute: (a: unknown, c: unknown) => Promise<unknown> }>
  await tool2.memory_recall.execute({ query: Q }, {}) // sets lastRecall to auth.py
  await simulateEdit(hooks2, root2, "src/auth.py", "c1") // edit — but the prior is disabled
  const r2 = (await tool2.memory_recall.execute({ query: Q_OTHER }, {})) as string
  assert(surfaced(r2, "src/plotting.py"), "flag off: lexical recall still works")
  assert(
    !surfaced(r2, "src/auth_helpers.py"),
    "flag off: NO injection — with the working-set prior disabled, the unrelated query cannot surface auth_helpers.py"
  )

  console.log("\n── extractFunctionChunks (the rerank's chunk extractor) ───")
  const cfRoot = await mkdtemp(join(tmpdir(), "diane-cf-"))
  const pyPath = join(cfRoot, "mod.py")
  await writeFile(
    pyPath,
    [
      "def alpha(x):",
      '    """first"""',
      "    return x + 1",
      "",
      "def beta(y):",
      '    """second"""',
      "    return y * 2",
    ].join("\n")
  )
  const chunks = extractFunctionChunks(pyPath, { maxFns: 12, maxLinesPerFn: 10 })
  assert(chunks.length === 2, "extractFunctionChunks finds both functions")
  assert(chunks[0].text.includes("alpha") && chunks[0].text.includes("return x + 1"), "chunk carries the function's signature and body")
  assert(chunks.some((c) => c.text.includes("beta")), "second function is extracted too")
  assert(extractFunctionChunks(join(cfRoot, "nope.py")).length === 0, "unreadable file yields no chunks (no throw)")

  await rm(root, { recursive: true, force: true })
  await rm(root2, { recursive: true, force: true })
  await rm(cfRoot, { recursive: true, force: true })

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
