/**
 * Session-ingestion tests.
 *
 * `ingestSessions` talks to the OpenCode SDK client. We feed it a
 * mock client that mimics the documented `session.list` /
 * `session.messages` shape (and some intentionally malformed shapes)
 * to prove the defensive parsing holds up.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { MemoryRepository } from "../src/store/repository.js"
import { ingestSessions } from "../src/ingest/sessions.js"

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

/** A mock client mimicking the OpenCode SDK session API. */
function mockClient(sessions: unknown, messagesById: Record<string, unknown>) {
  return {
    session: {
      list: async () => sessions,
      messages: async ({ path }: { path?: { id: string } }) => {
        return messagesById[path?.id ?? ""] ?? { data: [] }
      },
    },
  }
}

async function main(): Promise<void> {
  console.log("\n── ingest: sessions ──────────────────────────────────────")

  const root = await mkdtemp(join(tmpdir(), "diane-mem-sess-"))
  const repo = await MemoryRepository.load(root)

  // Two past sessions, documented {data: [...]} envelope shape.
  const sessions = {
    data: [
      { id: "sess_a", title: "Add pagination to the API" },
      { id: "sess_b", title: "Fix flaky auth test" },
      { id: "sess_current", title: "current session" },
    ],
  }
  const messagesById = {
    sess_a: {
      data: [
        { role: "user", content: "Please add cursor-based pagination to the list endpoint." },
        {
          role: "assistant",
          parts: [
            { tool: "edit", args: { filePath: "api/list.py" } },
            { tool: "edit", args: { filePath: "api/pagination.py" } },
            { tool: "bash", args: { command: "pytest tests/test_list.py -q" } },
          ],
        },
      ],
    },
    sess_b: {
      data: [
        {
          role: "user",
          parts: [{ text: "The auth test is flaky, please fix it." }],
        },
        {
          role: "assistant",
          parts: [
            { tool: "write", args: { path: "tests/test_auth.py" } },
            { tool: "bash", args: { command: "pytest tests/test_auth.py" } },
          ],
        },
      ],
    },
  }

  const client = mockClient(sessions, messagesById)
  const res = await ingestSessions(repo, client, "sess_current")

  assert(res.sessions === 2, `ingested 2 sessions, skipped the current one (got ${res.sessions})`)
  assert(res.taskMemories === 2, `extracted 2 task memories (got ${res.taskMemories})`)
  assert(res.traceMemories === 2, `extracted 2 trace memories (got ${res.traceMemories})`)
  assert(res.errors.length === 0, "no errors with well-formed client")

  // The user's task text should be searchable.
  const taskHit = repo.recall({ query: "cursor pagination list endpoint", category: "session-trace" })
  assert(taskHit.length > 0, "task memory is searchable by its text")

  // The trace should mention the edited files.
  const traceHit = repo.recall({ query: "pagination.py edited files", category: "session-trace" })
  assert(
    traceHit.some((h) => h.memory.content.includes("api/pagination.py")),
    "trace memory captured the edited file paths"
  )
  // The trace also captures the bash commands run.
  const bashHit = repo.recall({ query: "pytest test_auth", category: "session-trace" })
  assert(
    bashHit.some((h) => h.memory.content.includes("pytest")),
    "trace memory captured bash commands"
  )

  // Re-ingest is idempotent.
  const before = repo.size()
  await ingestSessions(repo, client, "sess_current")
  assert(repo.size() === before, "re-ingesting the same sessions adds nothing")

  // ── defensive paths ────────────────────────────────────────────────
  // Client with no session API at all.
  const repo2 = await MemoryRepository.load(await mkdtemp(join(tmpdir(), "diane-mem-sess2-")))
  const noApi = await ingestSessions(repo2, {}, undefined)
  assert(noApi.sessions === 0, "missing session API → 0 sessions, no throw")
  assert(noApi.errors.length > 0, "missing session API is reported as an error string")

  // Client whose list throws.
  const throwing = {
    session: {
      list: async () => { throw new Error("boom") },
      messages: async () => ({ data: [] }),
    },
  }
  const threw = await ingestSessions(repo2, throwing, undefined)
  assert(threw.sessions === 0, "a throwing session.list is swallowed gracefully")

  // Bare-array envelope (some SDK versions return the array directly).
  const repo3 = await MemoryRepository.load(await mkdtemp(join(tmpdir(), "diane-mem-sess3-")))
  const bareClient = mockClient(
    [{ id: "s1", title: "bare array session" }],
    { s1: [{ role: "user", content: "do the thing" }] }
  )
  const bareRes = await ingestSessions(repo3, bareClient, undefined)
  assert(bareRes.sessions === 1, "bare-array session list shape is handled")
  assert(bareRes.taskMemories === 1, "bare-array message list shape is handled")

  await rm(root, { recursive: true, force: true })

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(2) })
