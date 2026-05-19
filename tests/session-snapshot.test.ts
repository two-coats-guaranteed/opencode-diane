/**
 * session-snapshot tests (parked idea A).
 *
 * Covers writeSnapshot / latestSnapshot / snapshotSummary: one
 * snapshot per session (replace-in-place), parent linkage forming a
 * branchable history, pinned so eviction can't drop it, and resume
 * selection that never returns the current session's own snapshot.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { MemoryRepository } from "../src/store/repository.js"
import {
  writeSnapshot,
  latestSnapshot,
  snapshotSummary,
} from "../src/ingest/session-snapshot.js"
import type { ResolvedConfig } from "../src/types.js"

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

// A tiny disk budget so the eviction test is cheap to trigger.
function tinyBudgetConfig(bytes: number): ResolvedConfig {
  return {
    maxMemoryBytes: bytes,
    autoIngestOnStartup: true,
    gitHistoryDepth: 500,
    forceActive: false,
    skillsOutputDir: ".opencode/skills",
    skillMiningMinCluster: 3,
    ingestSessions: true,
    enableCodeMap: false,
    enableNudgeHook: true,
    adaptive: true,
    explicitKeys: new Set(),
    codeMapMaxFiles: 4000,
    coChangeMaxCommits: 5000,
  }
}

async function main(): Promise<void> {
  console.log("\n── session-snapshot: write, resume, lineage ──────────────")

  const root = await mkdtemp(join(tmpdir(), "diane-snapshot-"))
  const repo = await MemoryRepository.load(root)

  // first snapshot — no parent
  const r1 = writeSnapshot(repo, "sess-1", {
    summary: "Auth module uses a custom JWT layer in src/auth.",
    decisions: ["Chose middleware over decorators for guard logic"],
    conventions: ["All times are UTC epoch ms"],
  })
  assert(r1.parentId === null, "first snapshot has no parent")
  let snaps = repo.allMemories().filter((m) => m.category === "session-snapshot")
  assert(snaps.length === 1, "first snapshot stored as one memory")
  assert(snaps[0].pinned === true, "snapshot is pinned (eviction-proof)")
  assert(
    snaps[0].content.includes("Decisions:") && snaps[0].content.includes("Conventions:"),
    "snapshot content includes decisions and conventions"
  )
  assert(
    snaps[0].tags.includes("session:sess-1"),
    "snapshot tagged with its session id"
  )

  // second session snapshots — parent links to sess-1's snapshot
  const r2 = writeSnapshot(repo, "sess-2", {
    summary: "Extended auth work: added refresh tokens.",
  })
  assert(r2.parentId === r1.id, "second snapshot links the first as parent")
  snaps = repo.allMemories().filter((m) => m.category === "session-snapshot")
  assert(snaps.length === 2, "two distinct sessions → two snapshots")
  const s2 = snaps.find((m) => m.subject === "snapshot:sess-2")
  assert(
    s2 !== undefined && s2.tags.includes(`parent:${r1.id}`),
    "parent linkage recorded as a tag — the DAG edge"
  )

  // re-snapshot the SAME session — replace in place, not accumulate
  const r1b = writeSnapshot(repo, "sess-1", {
    summary: "Auth module — revised understanding after deeper review.",
  })
  snaps = repo.allMemories().filter((m) => m.category === "session-snapshot")
  assert(snaps.length === 2, "re-snapshotting a session replaces, does not accumulate")
  const s1 = snaps.find((m) => m.subject === "snapshot:sess-1")
  assert(
    s1 !== undefined && s1.content.includes("revised understanding"),
    "re-snapshot updates content in place"
  )
  assert(r1b.parentId === r2.id, "re-snapshot re-links parent to the now-latest other session")

  // ── resume selection ───────────────────────────────────────────────
  console.log("\n── session-snapshot: resume selection ────────────────────")
  // latest overall
  const latest = latestSnapshot(repo)
  assert(latest !== null, "latestSnapshot returns something when snapshots exist")

  // a session never resumes from itself: excluding the newest session
  // must return a different session's snapshot
  const newestSubject = latest!.subject // e.g. "snapshot:sess-1" (just re-written)
  const newestSession = newestSubject.replace("snapshot:", "")
  const resumeFor = latestSnapshot(repo, newestSession)
  assert(
    resumeFor !== null && resumeFor.subject !== newestSubject,
    "latestSnapshot(excludeSession) never returns that session's own snapshot"
  )

  // with only one session's snapshot, excluding it yields null
  const solo = await mkdtemp(join(tmpdir(), "diane-snapshot-solo-"))
  const soloRepo = await MemoryRepository.load(solo)
  writeSnapshot(soloRepo, "only-sess", { summary: "lone snapshot" })
  assert(
    latestSnapshot(soloRepo, "only-sess") === null,
    "single-session store: excluding it leaves nothing to resume from"
  )
  await rm(solo, { recursive: true, force: true })

  // ── lineage summary ────────────────────────────────────────────────
  const sum = snapshotSummary(repo)
  assert(sum.count === 2, "snapshotSummary counts all snapshots")
  assert(sum.latestAt !== null && sum.latestAt > 0, "snapshotSummary reports a latest timestamp")

  // ── pinned snapshots survive eviction ──────────────────────────────
  console.log("\n── session-snapshot: survives eviction ───────────────────")
  // flood the store with evictable agent-notes under a tiny budget
  for (let i = 0; i < 200; i++) {
    repo.insert({
      category: "agent-note",
      subject: `note-${i}`,
      content: `disposable note number ${i} with some filler text to take up bytes`,
      tags: ["disposable"],
      source: "test",
    })
  }
  const ev = repo.applyEviction(tinyBudgetConfig(2000))
  assert(ev.removed > 0, "eviction ran and removed entries under the tiny budget")
  const survivors = repo.allMemories().filter((m) => m.category === "session-snapshot")
  assert(
    survivors.length === 2,
    `both pinned snapshots survived eviction (got ${survivors.length})`
  )

  // still recallable after eviction
  const hits = repo.recall({ query: "auth jwt understanding", category: "session-snapshot" })
  assert(hits.length > 0, "snapshots remain recallable after eviction")

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
