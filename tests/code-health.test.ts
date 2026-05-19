/**
 * code-health ingestion tests (#1).
 *
 * Covers the pure `extractDiagnostics` shape-prober against the
 * several plausible `lsp.client.diagnostics` payload layouts, and the
 * `ingestCodeHealth` upsert behaviour — re-reporting a file must
 * REPLACE its prior memory, never accumulate stale ones.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { MemoryRepository } from "../src/store/repository.js"
import { extractDiagnostics, ingestCodeHealth } from "../src/ingest/code-health.js"

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  ✗ ${label}`)
  }
}

async function main(): Promise<void> {
  // ── defensive extraction across payload shapes ─────────────────────
  console.log("\n── code-health: extractDiagnostics shapes ────────────────")

  // Shape A: { path, diagnostics: [...] }
  const a = extractDiagnostics({
    path: "src/a.ts",
    diagnostics: [
      { severity: 1, message: "Cannot find name 'foo'" },
      { severity: 2, message: "unused variable" },
      { severity: 1, message: "type mismatch" },
    ],
  })
  assert(a.length === 1, "shape A: single file extracted")
  assert(a[0].errors === 2 && a[0].warnings === 1, "shape A: severity counts correct")
  assert(a[0].sampleMessages.length === 3, "shape A: messages sampled")
  assert(
    a[0].sampleMessages[0].includes("Cannot find") || a[0].sampleMessages[0].includes("type mismatch"),
    "shape A: samples are error-severity first"
  )

  // Shape B: raw event envelope { type, properties: { uri, diagnostics } }
  const b = extractDiagnostics({
    type: "lsp.client.diagnostics",
    properties: {
      uri: "file:///home/u/proj/src/b.go",
      diagnostics: [{ severity: 2, message: "shadowed declaration" }],
    },
  })
  assert(b.length === 1, "shape B: raw event envelope unwrapped")
  assert(b[0].path === "/home/u/proj/src/b.go", "shape B: file:// scheme stripped")
  assert(b[0].warnings === 1, "shape B: warning counted")

  // Shape C: grouped map { diagnostics: { uri: [...] } }
  const c = extractDiagnostics({
    diagnostics: {
      "src/x.rs": [{ severity: 1, message: "borrow error" }],
      "src/y.rs": [
        { severity: 3, message: "note" },
        { severity: 4, message: "hint" },
      ],
    },
  })
  assert(c.length === 2, "shape C: grouped uri→array map → two files")
  const cx = c.find((f) => f.path === "src/x.rs")
  const cy = c.find((f) => f.path === "src/y.rs")
  assert(cx !== undefined && cx.errors === 1, "shape C: per-file error count")
  assert(cy !== undefined && cy.infos === 1 && cy.hints === 1, "shape C: info + hint counted")

  // Shape D: payload itself is a uri→array map
  const d = extractDiagnostics({
    "src/z.py": [{ severity: 1, message: "syntax error" }],
  })
  assert(d.length === 1 && d[0].errors === 1, "shape D: bare uri→array map handled")

  // Garbage shapes never throw, always yield []
  assert(extractDiagnostics(null).length === 0, "garbage: null → []")
  assert(extractDiagnostics(undefined).length === 0, "garbage: undefined → []")
  assert(extractDiagnostics("a string").length === 0, "garbage: string → []")
  assert(extractDiagnostics(42).length === 0, "garbage: number → []")
  assert(extractDiagnostics({ unrelated: "junk" }).length === 0, "garbage: unrecognised object → []")
  // a diagnostic missing severity defaults to warning, not a throw
  const noSev = extractDiagnostics({ path: "p.ts", diagnostics: [{ message: "no severity" }] })
  assert(noSev.length === 1 && noSev[0].warnings === 1, "missing severity defaults to warning")

  // ── upsert: live replace, not accumulate ───────────────────────────
  console.log("\n── code-health: ingest upsert behaviour ──────────────────")
  const root = await mkdtemp(join(tmpdir(), "diane-codehealth-"))
  const repo = await MemoryRepository.load(root)

  // first report: 2 errors
  let res = ingestCodeHealth(repo, {
    path: "src/a.ts",
    diagnostics: [
      { severity: 1, message: "err one" },
      { severity: 1, message: "err two" },
    ],
  })
  assert(res.filesUpdated === 1, "first report: one file updated")
  let health = repo.allMemories().filter((m) => m.category === "code-health")
  assert(health.length === 1, "first report: exactly one code-health memory")
  assert(health[0].content.includes("2 errors"), "first report: content says '2 errors'")
  assert(health[0].tags.includes("has-errors"), "first report: tagged has-errors")

  // second report on the SAME file: now 1 warning — must replace
  ingestCodeHealth(repo, {
    path: "src/a.ts",
    diagnostics: [{ severity: 2, message: "just a warning" }],
  })
  health = repo.allMemories().filter((m) => m.category === "code-health")
  assert(health.length === 1, "second report: STILL one memory (replaced, not accumulated)")
  assert(
    health[0].content.includes("1 warning") && !health[0].content.includes("error"),
    "second report: content updated to '1 warning'"
  )

  // third report: file is clean now
  res = ingestCodeHealth(repo, { path: "src/a.ts", diagnostics: [] })
  assert(res.filesCleared === 1, "clean report: counted as cleared")
  health = repo.allMemories().filter((m) => m.category === "code-health")
  assert(health.length === 1 && health[0].content.includes("clean"), "clean report: one memory, marked clean")

  // a different file coexists
  ingestCodeHealth(repo, { path: "src/b.ts", diagnostics: [{ severity: 1, message: "boom" }] })
  health = repo.allMemories().filter((m) => m.category === "code-health")
  assert(health.length === 2, "distinct files → distinct memories")

  // recallable
  const hit = repo.recall({ query: "a.ts diagnostics clean", category: "code-health" })
  assert(hit.length > 0, "code-health memories are recallable")

  // garbage payload into ingest → no-op, no throw, no memories added
  const before = repo.size()
  ingestCodeHealth(repo, { nonsense: true })
  assert(repo.size() === before, "garbage payload into ingest is a silent no-op")

  await rm(root, { recursive: true, force: true })

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
