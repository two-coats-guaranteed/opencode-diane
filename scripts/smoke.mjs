#!/usr/bin/env bun
/**
 * smoke.mjs — exercises the BUILT plugin (dist/), not the source.
 *
 * Every suite under tests/ runs against src/ under Bun. That proves the
 * source is correct but never touches the compiled output that
 * actually ships. This script closes that gap: it imports
 * dist/index.js exactly as OpenCode would, drives the plugin through
 * a mock context, and asserts the build is wired up — entry point
 * resolves, plugin activates, tools register, a tool runs, hooks are
 * shaped right. It is intentionally shallow: depth is the unit
 * suites' job; this is the "did the build come out usable" tripwire.
 *
 * Run after `bun run build`. Exits non-zero on any failure.
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    console.log(`  ✗ ${msg}`)
  }
}

const pkgDir = resolve(fileURLToPath(import.meta.url), "..", "..")
const distEntry = join(pkgDir, "dist", "index.js")

console.log("── smoke: built dist/ ────────────────────────────────────")

if (!existsSync(distEntry)) {
  console.error("  ✗ dist/index.js missing — run `bun run build` first.")
  process.exit(1)
}
ok(true, "dist/index.js exists")

// Import the built entry point exactly as OpenCode's loader would.
let mod
try {
  mod = await import(distEntry)
} catch (err) {
  console.error(`  ✗ importing dist/index.js threw: ${err?.message ?? err}`)
  process.exit(1)
}
const plugin = mod.OpencodeDiane
ok(typeof plugin === "function", "dist exports OpencodeDiane as a function")

// A mock plugin context — a real git repo so prefill has something
// to do, and a no-op SDK client.
const root = await mkdtemp(join(tmpdir(), "diane-smoke-"))
await writeFile(join(root, "package.json"), '{"name":"smoke-fixture"}')
try {
  execSync("git init -q && git add -A && git -c user.email=s@s.s -c user.name=s commit -qm init", {
    cwd: root,
  })
} catch {
  /* git not available — plugin still activates on the manifest */
}

const logs = []
const ctx = {
  client: { app: { log: async ({ body }) => logs.push(body?.message ?? "") }, session: undefined },
  directory: root,
  worktree: "/",
  project: { id: "smoke" },
  sessionID: "smoke-session",
  $: null,
  serverUrl: new URL("http://localhost"),
  experimental_workspace: { register: () => {} },
}

let hooks
try {
  hooks = await plugin(ctx)
} catch (err) {
  console.error(`  ✗ plugin(ctx) threw: ${err?.message ?? err}`)
  await rm(root, { recursive: true, force: true })
  process.exit(1)
}
ok(hooks !== null && typeof hooks === "object", "plugin(ctx) returns a hooks object")
ok(hooks.tool !== undefined, "hooks include a tool map")

const toolNames = Object.keys(hooks.tool ?? {})
ok(toolNames.length === 9, `registers all nine tools (got ${toolNames.length})`)
for (const expected of ["memory_recall", "memory_remember", "memory_snapshot", "memory_outline", "memory_skill"]) {
  ok(toolNames.includes(expected), `registers ${expected}`)
}

// Let background prefill settle, then exercise a couple of tools.
await new Promise((r) => setTimeout(r, 600))

try {
  const outline = await hooks.tool.memory_outline.execute({}, {})
  ok(typeof outline === "string" && outline.length > 0, "memory_outline runs and returns text")
} catch (err) {
  ok(false, `memory_outline threw: ${err?.message ?? err}`)
}

try {
  const remembered = await hooks.tool.memory_remember.execute(
    { subject: "smoke/test", content: "smoke-test note", tags: ["smoke"] },
    {}
  )
  ok(typeof remembered === "string" && remembered.includes("stored"), "memory_remember runs and stores")
  const recalled = await hooks.tool.memory_recall.execute({ query: "smoke-test note" }, {})
  ok(typeof recalled === "string" && recalled.includes("smoke"), "memory_recall round-trips the note")
} catch (err) {
  ok(false, `remember/recall round-trip threw: ${err?.message ?? err}`)
}

// Default config keeps the nudge hooks on — confirm they're shaped right.
ok(
  typeof hooks["tool.execute.before"] === "function" &&
    typeof hooks["tool.execute.after"] === "function",
  "nudge hooks registered and callable"
)

await rm(root, { recursive: true, force: true })

console.log("──────────────────────────────────────────────────────────")
console.log(`  ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
