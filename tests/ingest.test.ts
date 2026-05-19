/**
 * Ingestion tests — language-agnostic.
 *
 * The git tests deliberately use a repo whose commit messages carry
 * NO usable signal ("wip", ".", "更新", "", "asdf") to prove the
 * ingester derives everything from diff structure and never from the
 * message text. The project test uses a Rust-flavoured repo to prove
 * the project ingester is not Python-specific.
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"

import { MemoryRepository } from "../src/store/repository.js"
import { ingestProjectFacts, summariseByFormat } from "../src/ingest/project.js"
import { ingestGitHistory, deriveShapeTags, isBalancedChurnCommit } from "../src/ingest/git.js"

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

async function main(): Promise<void> {
  // ── format summarisers (pure, no language assumptions) ─────────────
  console.log("\n── summariseByFormat: format-driven, not language-driven ──")
  const jsonSummary = summariseByFormat(
    "package.json",
    JSON.stringify({ name: "x", version: "1", scripts: { a: 1, b: 2 }, deps: ["p"] })
  )
  assert(jsonSummary.includes("JSON object"), "JSON file → JSON object summary")
  assert(jsonSummary.includes("scripts{2}"), "JSON nested object annotated with size")
  assert(jsonSummary.includes("deps[1]"), "JSON nested array annotated with length")

  const tomlSummary = summariseByFormat(
    "Cargo.toml",
    `[package]\nname = "x"\nedition = "2021"\n\n[dependencies]\nserde = "1"\n\n[dev-dependencies]\ncriterion = "0.5"\n`
  )
  assert(tomlSummary.includes("[package]"), "TOML file → section headers")
  assert(tomlSummary.includes("[dependencies]"), "TOML lists every section")
  assert(tomlSummary.includes("[dev-dependencies]"), "TOML lists dev section too")

  const yamlSummary = summariseByFormat("action.yml", "name: CI\non: [push]\njobs:\n  build:\n    x: 1\n")
  assert(yamlSummary.includes("YAML"), "YAML file → YAML summary")
  assert(yamlSummary.includes("jobs"), "YAML lists top-level keys")

  const mkSummary = summariseByFormat("Makefile", "build:\n\tcc x.c\ntest:\n\t./a.out\n.PHONY: build\n")
  assert(mkSummary.includes("build") && mkSummary.includes("test"), "Makefile → target list")
  assert(!mkSummary.includes(".PHONY"), "Makefile skips dot-prefixed pseudo-targets")

  const dockerSummary = summariseByFormat("Dockerfile", "FROM alpine\nRUN apk add x\nCOPY . /app\n")
  assert(dockerSummary.includes("FROM") && dockerSummary.includes("RUN"), "Dockerfile → instruction set")

  // ── project facts on a NON-Python repo (Rust) ──────────────────────
  console.log("\n── ingest: project facts (language-agnostic) ─────────────")
  const rRoot = await mkdtemp(join(tmpdir(), "diane-mem-proj-"))
  await writeFile(join(rRoot, "Cargo.toml"), `[package]
name = "ferris-tool"
version = "0.3.0"
edition = "2021"

[dependencies]
serde = "1"
clap = "4"
`)
  await writeFile(join(rRoot, "Cargo.lock"), "# lockfile\n")
  await writeFile(join(rRoot, "README.md"), "# ferris-tool\n\nA CLI written in Rust for testing.\n")
  await writeFile(join(rRoot, "Makefile"), "build:\n\tcargo build\ntest:\n\tcargo test\n")
  await mkdir(join(rRoot, "src"), { recursive: true })
  await writeFile(join(rRoot, "src", "main.rs"), "fn main() {}\n")
  await writeFile(join(rRoot, "src", "lib.rs"), "pub fn x() {}\n")
  await mkdir(join(rRoot, "src", "cmd"), { recursive: true })
  await writeFile(join(rRoot, "src", "cmd", "run.rs"), "pub fn run() {}\n")
  await mkdir(join(rRoot, ".github", "workflows"), { recursive: true })
  await writeFile(join(rRoot, ".github", "workflows", "ci.yml"), "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n")
  await writeFile(join(rRoot, "Dockerfile"), "FROM rust:1\nRUN cargo build\n")

  const rRepo = await MemoryRepository.load(rRoot)
  const rRes = await ingestProjectFacts(rRepo, rRoot)
  assert(rRes.facts > 4, `project ingest produced multiple facts on a Rust repo (got ${rRes.facts})`)

  const cargoHit = rRepo.recall({ query: "Cargo.toml dependencies", category: "project-facts" })
  assert(cargoHit.length > 0, "Cargo.toml is recognised and summarised")
  assert(
    cargoHit.some((h) => h.memory.content.includes("[dependencies]")),
    "Cargo.toml summary is format-based (section headers), not Rust-semantic"
  )

  const layoutHit = rRepo.recall({ query: "repository layout directories" })
  assert(layoutHit.length > 0, "top-level layout is captured")
  assert(
    layoutHit.some((h) => h.memory.content.includes("src")),
    "layout memory names the src directory"
  )

  // Extension histogram — the convention-free "what language" signal.
  const censusHit = rRepo.recall({ query: "file type census extensions languages" })
  assert(censusHit.length > 0, "file-type census memory exists")
  assert(
    censusHit.some((h) => h.memory.content.includes(".rs×3")),
    "census counts all 3 .rs files across nested dirs"
  )
  assert(
    censusHit.some((h) => h.memory.tags.includes("languages")),
    "census memory is tagged 'languages' (it IS the language signal)"
  )

  const mkHit = rRepo.recall({ query: "Makefile build test targets" })
  assert(mkHit.length > 0, "Makefile is recognised and its targets captured")

  const ciHit = rRepo.recall({ query: "github workflow ci" })
  assert(ciHit.length > 0, "GitHub workflow files are captured")

  const dockerHit = rRepo.recall({ query: "Dockerfile instructions" })
  assert(dockerHit.length > 0, "Dockerfile is recognised")

  const readmeHit = rRepo.recall({ query: "ferris-tool readme" })
  assert(readmeHit.length > 0, "README headline is captured")
  assert(
    readmeHit.some((h) => h.memory.tags.includes("readme")),
    "README memory is tagged readme"
  )

  // Idempotent
  const beforeP = rRepo.size()
  await ingestProjectFacts(rRepo, rRoot)
  assert(rRepo.size() === beforeP, "re-ingesting project facts is idempotent")

  await rm(rRoot, { recursive: true, force: true })

  // ── shape derivation: pure structure, no message input ─────────────
  console.log("\n── deriveShapeTags: structural, never message-based ──────")
  assert(
    deriveShapeTags([{ path: "a", added: 3, deleted: 1, status: "modified" }]).includes("single-file"),
    "1-file commit → single-file"
  )
  const manyFiles = Array.from({ length: 12 }, (_, i) => ({
    path: `f${i}`, added: 2, deleted: 0, status: "modified" as const,
  }))
  assert(deriveShapeTags(manyFiles).includes("many-files"), "12-file commit → many-files")
  assert(
    deriveShapeTags([{ path: "a", added: 600, deleted: 50, status: "modified" }]).includes("large-diff"),
    "650-line commit → large-diff"
  )
  assert(
    deriveShapeTags([{ path: "a", added: 2, deleted: 1, status: "modified" }]).includes("tiny-diff"),
    "3-line commit → tiny-diff"
  )
  assert(
    deriveShapeTags([
      { path: "a", added: 10, deleted: 0, status: "created" },
      { path: "b", added: 5, deleted: 0, status: "created" },
    ]).includes("adds-files"),
    "all-new-files commit → adds-files"
  )
  assert(
    deriveShapeTags([
      { path: "a", added: 0, deleted: 0, status: "deleted" },
      { path: "b", added: 0, deleted: 0, status: "deleted" },
    ]).includes("removes-files"),
    "all-deleted-files commit → removes-files"
  )
  assert(
    deriveShapeTags([{ path: "a", added: 5, deleted: 200, status: "modified" }]).includes("net-removal"),
    "mostly-deletions commit → net-removal"
  )
  assert(
    deriveShapeTags([{ path: "a", added: 200, deleted: 5, status: "modified" }]).includes("net-addition"),
    "mostly-additions commit → net-addition"
  )
  assert(
    deriveShapeTags([{ path: "img.png", added: -1, deleted: -1, status: "modified" }]).includes("touches-binary"),
    "binary file (numstat '-') → touches-binary"
  )
  assert(deriveShapeTags([]).includes("empty"), "empty commit → empty (no throw)")

  // ── isBalancedChurnCommit: rename/reformat detection ──────────────
  // Balanced churn (additions ≈ deletions) marks content that was
  // moved or reformatted, not written — it gets no per-commit memory.
  console.log("\n── isBalancedChurnCommit: arithmetic, never message-based ─")
  assert(
    isBalancedChurnCommit([
      { path: "old.rst", added: 0, deleted: 90, status: "deleted" },
      { path: "new.md", added: 90, deleted: 0, status: "created" },
    ]),
    "pure rename (+90 new / -90 old) → balanced churn"
  )
  assert(
    isBalancedChurnCommit([{ path: "doc.md", added: 84, deleted: 84, status: "modified" }]),
    "in-place reformat (+84/-84) → balanced churn"
  )
  assert(
    !isBalancedChurnCommit([{ path: "a.ts", added: 200, deleted: 5, status: "modified" }]),
    "a real feature commit (+200/-5) is NOT balanced churn"
  )
  assert(
    !isBalancedChurnCommit([{ path: "a.ts", added: 12, deleted: 11, status: "modified" }]),
    "a small commit (+12/-11) is below the 25-line floor — NOT skipped"
  )
  assert(
    !isBalancedChurnCommit([{ path: "a.ts", added: 100, deleted: 80, status: "modified" }]),
    "a refactor netting clearly positive (+100/-80, 80%) is NOT balanced churn"
  )
  assert(
    !isBalancedChurnCommit([{ path: "img.png", added: -1, deleted: -1, status: "modified" }]),
    "a binary change (unknown line shape) is NOT treated as balanced churn"
  )
  assert(!isBalancedChurnCommit([]), "empty commit is NOT balanced churn (no throw)")

  // ── git history: messages carry NO signal, structure carries all ──
  console.log("\n── ingest: git history (culture-free commit messages) ────")
  const gRoot = await mkdtemp(join(tmpdir(), "diane-mem-git-"))
  git(gRoot, ["init", "--initial-branch=main", "-q"])
  git(gRoot, ["config", "user.email", "test@example.com"])
  git(gRoot, ["config", "user.name", "test"])

  // Commit 1: create two files. Message: garbage.
  await writeFile(join(gRoot, "core.rs"), "fn a() {}\n".repeat(5))
  await writeFile(join(gRoot, "util.rs"), "fn u() {}\n".repeat(5))
  git(gRoot, ["add", "."])
  git(gRoot, ["commit", "-q", "-m", "wip"])

  // Commits 2-4: modify the same two files together. Messages: noise.
  // Each iteration must change content or git has nothing to commit.
  let rev = 8
  for (const msg of [".", "更新", "asdf"]) {
    rev += 3
    await writeFile(join(gRoot, "core.rs"), "fn a() {}\n".repeat(rev))
    await writeFile(join(gRoot, "util.rs"), "fn u() {}\n".repeat(rev))
    git(gRoot, ["add", "."])
    git(gRoot, ["commit", "-q", "-m", msg])
  }

  // Commit 5: a big net-removal. Empty message.
  await writeFile(join(gRoot, "core.rs"), "fn a() {}\n")
  git(gRoot, ["add", "."])
  git(gRoot, ["commit", "-q", "--allow-empty-message", "-m", ""])

  // Commit 6: add a sizeable file (a normal net-addition commit).
  await writeFile(join(gRoot, "big.rs"), "fn x() {}\n".repeat(40))
  git(gRoot, ["add", "."])
  git(gRoot, ["commit", "-q", "-m", "add big"])

  // Commit 7: a PURE RENAME. With `--no-renames` the ingester sees
  // -40 from the old path and +40 to the new — balanced churn, so this
  // commit gets NO per-commit memory (it carries no logic signal).
  git(gRoot, ["mv", "big.rs", "renamed.rs"])
  git(gRoot, ["commit", "-q", "-m", "rename big"])

  const gRepo = await MemoryRepository.load(gRoot)
  const gRes = await ingestGitHistory(gRepo, gRoot, 50)
  assert(gRes.scanned >= 7, `scanned all commits (got ${gRes.scanned})`)
  assert(
    gRes.commitMemories + gRes.balancedChurnSkipped === gRes.scanned,
    `every commit either emits a memory or is skipped as balanced churn ` +
      `(${gRes.commitMemories} + ${gRes.balancedChurnSkipped} = ${gRes.scanned})`
  )
  assert(
    gRes.balancedChurnSkipped >= 1,
    `the pure-rename commit was skipped as balanced churn (got ${gRes.balancedChurnSkipped})`
  )
  // Structure-derived facts that don't depend on the garbage messages:
  assert(gRes.coChangeMemories >= 1, "core.rs + util.rs co-change detected from structure")
  assert(gRes.churnMemories >= 1, "high-churn file detected from structure")
  assert(gRes.recencyMemories === 1, "a recency memory is emitted")
  assert(
    Object.keys(gRes.shapeTagCounts).length > 0,
    "structural shape tags were derived"
  )

  // The garbage message is STORED verbatim (searchable) but is not a tag.
  const wipHit = gRepo.recall({ query: "wip", category: "git-history" })
  assert(wipHit.length > 0, "verbatim commit message is still searchable text")
  const allGitMems = gRepo.allMemories().filter((m) => m.category === "git-history")
  const anyMessageTag = allGitMems.some((m) =>
    m.tags.some((t) => ["wip", "asdf", "更新", "bugfix", "feature", "refactor"].includes(t))
  )
  assert(!anyMessageTag, "no tag is ever derived from the commit message text")

  // co-change memory names both coupled files
  const coHit = gRepo.recall({ query: "core util coupled together" })
  assert(
    coHit.some((h) => h.memory.content.includes("core.rs") && h.memory.content.includes("util.rs")),
    "co-change memory names both coupled files"
  )

  // churn memory flags the hot file
  const churnHit = gRepo.recall({ query: "high churn hot file core" })
  assert(
    churnHit.some((h) => h.memory.tags.includes("hot-file")),
    "churn memory is tagged hot-file"
  )

  // Idempotent
  const beforeG = gRepo.size()
  await ingestGitHistory(gRepo, gRoot, 50)
  assert(gRepo.size() === beforeG, "re-ingesting git history is idempotent")

  await rm(gRoot, { recursive: true, force: true })

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(2) })
