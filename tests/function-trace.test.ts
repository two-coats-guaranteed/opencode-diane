/**
 * function-trace.test.ts — session-provenance record + retrieval.
 *
 * Script-style; run with: bun run tests/function-trace.test.ts
 */

import {
  provenanceKey,
  recordFunctionTrace,
  lookupFunctionTrace,
} from "../src/ingest/function-trace.js"
import { MemoryRepository } from "../src/store/repository.js"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

let passed = 0
let failed = 0
const failures: string[] = []
function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

const tmpRoots: string[] = []
async function freshRepo(): Promise<MemoryRepository> {
  const root = await mkdtemp(join(tmpdir(), "diane-functrace-"))
  tmpRoots.push(root)
  return MemoryRepository.load(root)
}

async function main(): Promise<void> {
  // ── key normalization ─────────────────────────────────────────────────
  console.log("\n── provenanceKey ────────────────────────────────────────")
  {
    assert(
      provenanceKey("src/requests/sessions.py", "def resolve_redirects(self, resp, req)") ===
        "sessions.py::resolve_redirects",
      "extracts function name from a python def signature"
    )
    assert(
      provenanceKey("a/b/Foo.ts", "export class FooBar {") === "Foo.ts::FooBar",
      "extracts class name from a TS signature"
    )
    assert(
      provenanceKey("src/x/util.py", null) === "util.py",
      "file-level key when no function given"
    )
    assert(
      provenanceKey("src/x/util.py", "def f(): pass").startsWith("util.py::f"),
      "basename is used, not full path"
    )
  }

  // ── record + exact-function lookup ────────────────────────────────────
  console.log("\n── record → exact function lookup ───────────────────────")
  {
    const repo = await freshRepo()
    const id = recordFunctionTrace(repo, {
      sessionId: "sess_A",
      filePath: "src/requests/sessions.py",
      functionSig: "def resolve_redirects(self, resp, req, stream=False)",
      recallQuery: "redirect method not preserved on 301",
    })
    assert(id !== null, "recordFunctionTrace returns a memory id")

    const hit = lookupFunctionTrace(
      repo,
      "src/requests/sessions.py",
      "def resolve_redirects(self, resp, req, stream=False)"
    )
    assert(hit !== null, "exact function lookup finds the trace")
    assert(
      !!hit && hit.includes("resolve_redirects") && hit.includes("redirect method not preserved"),
      "trace content carries the function and the recall query (the why)"
    )
  }

  // ── file-level fallback when function differs ─────────────────────────
  console.log("\n── file-level fallback ──────────────────────────────────")
  {
    const repo = await freshRepo()
    recordFunctionTrace(repo, {
      sessionId: "sess_B",
      filePath: "src/requests/sessions.py",
      functionSig: "def rebuild_auth(self, prepared_request, response)",
      recallQuery: "auth header dropped across hosts",
    })
    // ask about a DIFFERENT function in the same file → file-level fallback
    const hit = lookupFunctionTrace(
      repo,
      "src/requests/sessions.py",
      "def merge_environment_settings(self)"
    )
    assert(hit !== null, "falls back to a file-level trace when no exact match")
    assert(!!hit && hit.includes("rebuild_auth"), "fallback returns the same-file trace")

    // a totally unrelated file → no trace
    const miss = lookupFunctionTrace(repo, "src/other/models.py", "def foo()")
    assert(miss === null, "unrelated file returns no trace")
  }

  // ── rolling: newest session's work replaces older for same function ───
  console.log("\n── rolling (one entry per function, newest wins) ────────")
  {
    const repo = await freshRepo()
    recordFunctionTrace(repo, {
      sessionId: "sess_old",
      filePath: "src/x/handler.py",
      functionSig: "def handle(self, req)",
      recallQuery: "first investigation",
    })
    recordFunctionTrace(repo, {
      sessionId: "sess_new",
      filePath: "src/x/handler.py",
      functionSig: "def handle(self, req)",
      recallQuery: "second investigation refined",
    })
    const hit = lookupFunctionTrace(repo, "src/x/handler.py", "def handle(self, req)")
    assert(!!hit && hit.includes("second investigation"), "newest provenance is what surfaces")
    // exactly one function-trace memory for this key (rolling, not appended)
    const all = repo.allMemories().filter(
      (m) => m.category === "function-trace" && m.subject === "functrace:handler.py::handle"
    )
    assert(all.length === 1, "rolling: exactly one memory per function key")
  }

  // ── task is included when supplied ────────────────────────────────────
  console.log("\n── optional task inclusion ──────────────────────────────")
  {
    const repo = await freshRepo()
    recordFunctionTrace(repo, {
      sessionId: "sess_T",
      filePath: "src/x/q.py",
      functionSig: "def run(self)",
      recallQuery: "query planner cost",
      task: "optimize the query planner indexes",
    })
    const hit = lookupFunctionTrace(repo, "src/x/q.py", "def run(self)")
    assert(!!hit && hit.includes("optimize the query planner"), "task text is fused when present")
  }

  for (const r of tmpRoots) { try { await rm(r, { recursive: true, force: true }) } catch { /* cleanup best-effort */ } }

  // ── summary ────────────────────────────────────────────────────────────
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
