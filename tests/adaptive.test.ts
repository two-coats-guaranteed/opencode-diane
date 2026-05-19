/**
 * adaptive-config tests (idea #2).
 *
 * Covers the tier classification (by commit count and by file count),
 * `applyAdaptiveTuning`'s respect for explicit user keys, the
 * adaptive:false no-op, the "adaptive does not touch the disk budget" rule, and
 * `measureRepo`'s git → file-count fallback.
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"

import { measureRepo, applyAdaptiveTuning } from "../src/ingest/adaptive.js"
import type { ResolvedConfig, UserConfig } from "../src/types.js"

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

/** A baseline ResolvedConfig — medium-tier fixed defaults, nothing explicit. */
function baseConfig(explicit: Array<keyof UserConfig> = []): ResolvedConfig {
  return {
    maxMemoryBytes: 50 * 1024 * 1024,
    autoIngestOnStartup: true,
    gitHistoryDepth: 500,
    forceActive: false,
    skillsOutputDir: ".opencode/skills",
    skillMiningMinCluster: 3,
    ingestSessions: true,
    enableCodeMap: false,
    enableNudgeHook: true,
    adaptive: true,
    explicitKeys: new Set(explicit),
    codeMapMaxFiles: 4000,
    coChangeMaxCommits: 5000,
  }
}

async function main(): Promise<void> {
  console.log("\n── adaptive: tier classification ─────────────────────────")

  // ── tier by commit count ───────────────────────────────────────────
  // small repo: few commits
  const small = await mkdtemp(join(tmpdir(), "diane-adapt-small-"))
  execSync("git init -q", { cwd: small })
  await writeFile(join(small, "a.txt"), "x")
  for (let i = 0; i < 5; i++) {
    execSync(`git -c user.email=t@t.t -c user.name=t commit -q --allow-empty -m c${i}`, {
      cwd: small,
    })
  }
  const smallSig = await measureRepo(small, true)
  assert(smallSig.basis === "commits", "git repo measured by commit count")
  assert(smallSig.tier === "small", `5-commit repo classified small (got ${smallSig.tier})`)
  await rm(small, { recursive: true, force: true })

  // medium repo: between the thresholds (SMALL_MAX=150, LARGE_MIN=2000)
  const medium = await mkdtemp(join(tmpdir(), "diane-adapt-med-"))
  execSync("git init -q", { cwd: medium })
  for (let i = 0; i < 200; i++) {
    execSync(`git -c user.email=t@t.t -c user.name=t commit -q --allow-empty -m c${i}`, {
      cwd: medium,
    })
  }
  const medSig = await measureRepo(medium, true)
  assert(medSig.tier === "medium", `200-commit repo classified medium (got ${medSig.tier})`)
  await rm(medium, { recursive: true, force: true })

  // ── tier by file count (no-git fallback) ───────────────────────────
  console.log("\n── adaptive: no-git file-count fallback ──────────────────")
  const noGit = await mkdtemp(join(tmpdir(), "diane-adapt-nogit-"))
  await mkdir(join(noGit, "src"), { recursive: true })
  for (let i = 0; i < 12; i++) {
    await writeFile(join(noGit, "src", `f${i}.ts`), `export const x${i} = ${i}`)
  }
  const noGitSig = await measureRepo(noGit, false)
  assert(noGitSig.basis === "files", "non-git repo measured by file count")
  assert(noGitSig.tier === "small", `12-file non-git repo classified small (got ${noGitSig.tier})`)

  // hasGit=true but no actual git repo → rev-list fails → file fallback
  const fakeGit = await measureRepo(noGit, true)
  assert(
    fakeGit.basis === "files",
    "hasGit=true but rev-list fails → falls back to file count"
  )
  await rm(noGit, { recursive: true, force: true })

  // ── applyAdaptiveTuning: tier → knobs ──────────────────────────────
  console.log("\n── adaptive: tuning applies tier settings ────────────────")
  const cSmall = baseConfig()
  applyAdaptiveTuning(cSmall, { basis: "commits", value: 50, tier: "small" })
  assert(cSmall.gitHistoryDepth === 250, "small tier sets gitHistoryDepth=250")
  assert(cSmall.codeMapMaxFiles === 1500, "small tier sets codeMapMaxFiles=1500")
  assert(
    cSmall.maxMemoryBytes === 50 * 1024 * 1024,
    "small tier leaves the 50 MB budget untouched (budget is tier-independent)"
  )

  const cLarge = baseConfig()
  applyAdaptiveTuning(cLarge, { basis: "commits", value: 9000, tier: "large" })
  assert(cLarge.gitHistoryDepth === 1500, "large tier sets gitHistoryDepth=1500")
  assert(
    cLarge.maxMemoryBytes === 50 * 1024 * 1024,
    "large tier leaves the 50 MB budget untouched — adaptation never scales it"
  )
  assert(cLarge.codeMapMaxFiles === 10000, "large tier sets codeMapMaxFiles=10000")

  // ── explicit user keys are never overridden ────────────────────────
  console.log("\n── adaptive: explicit keys win ───────────────────────────")
  const cExplicit = baseConfig(["gitHistoryDepth", "maxMemoryDiskMB"])
  cExplicit.gitHistoryDepth = 777 // pretend the user set this
  cExplicit.maxMemoryBytes = 3 * 1024 * 1024 // and this (below default, deliberately)
  applyAdaptiveTuning(cExplicit, { basis: "commits", value: 9000, tier: "large" })
  assert(
    cExplicit.gitHistoryDepth === 777,
    "explicit gitHistoryDepth is not overridden by the tier"
  )
  assert(
    cExplicit.maxMemoryBytes === 3 * 1024 * 1024,
    "explicit budget is not overridden — even below the 50 MB default"
  )
  assert(
    cExplicit.codeMapMaxFiles === 10000,
    "non-user-exposed knobs (codeMapMaxFiles) still take the tier value"
  )

  // ── adaptive:false is a no-op ──────────────────────────────────────
  console.log("\n── adaptive: disabled is a no-op ─────────────────────────")
  const cOff = baseConfig()
  cOff.adaptive = false
  const offResult = applyAdaptiveTuning(cOff, { basis: "commits", value: 9000, tier: "large" })
  assert(cOff.gitHistoryDepth === 500, "adaptive:false leaves gitHistoryDepth at the fixed default")
  assert(cOff.maxMemoryBytes === 50 * 1024 * 1024, "adaptive:false leaves the budget untouched")
  assert(cOff.codeMapMaxFiles === 4000, "adaptive:false leaves codeMapMaxFiles untouched")
  assert(
    offResult.summary.includes("off"),
    "adaptive:false summary says tuning is off"
  )

  // ── summary string is informative ──────────────────────────────────
  const cSum = baseConfig()
  const sumRes = applyAdaptiveTuning(cSum, { basis: "commits", value: 9000, tier: "large" })
  assert(
    sumRes.summary.includes("tier=large") && sumRes.summary.includes("9000 commits"),
    `summary names the tier and the measured value (got: ${sumRes.summary})`
  )

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
