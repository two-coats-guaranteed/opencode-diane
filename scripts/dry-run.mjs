#!/usr/bin/env bun
/**
 * dry-run.mjs — run the plugin's ingesters against a real repository
 * and show, honestly, what the agent would actually get.
 *
 * Unit tests prove recall is small and correct on synthetic data.
 * They do NOT prove the ingested memories are *useful content* or
 * that recall surfaces *relevant* results for the fuzzy questions a
 * developer actually asks. This script closes that gap: point it at a
 * real checkout, and it reports
 *
 *   - the memory inventory (counts per category, bytes),
 *   - a quality read on the git-history signal — commit messages are
 *     taken verbatim, so terse history yields low-signal memories and
 *     the script says so plainly,
 *   - sample memories per category, so you can eyeball the content,
 *   - the result of realistic developer queries (auth, error
 *     handling, config, tests, recent changes…), with the actual top
 *     hits and the token cost.
 *
 * USAGE:
 *   bun scripts/dry-run.mjs <repo-path> [query ...]
 *
 * With no queries it uses a built-in set of generic developer
 * questions. No network, no API calls — just the real ingesters and
 * real BM25 recall over a scratch store.
 */

import { existsSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoPath = process.argv[2] ? resolve(process.argv[2]) : null
if (!repoPath || !existsSync(repoPath)) {
  console.error("usage: bun scripts/dry-run.mjs <repo-path> [query ...]")
  process.exit(1)
}
const userQueries = process.argv.slice(3)

const pkgDir = join(fileURLToPath(import.meta.url), "..", "..")
if (!existsSync(join(pkgDir, "dist", "store", "repository.js"))) {
  console.error("plugin not built — run `bun run build` first.")
  process.exit(1)
}
const { MemoryRepository } = await import(join(pkgDir, "dist", "store", "repository.js"))
const { ingestGitHistory } = await import(join(pkgDir, "dist", "ingest", "git.js"))
const { ingestProjectFacts } = await import(join(pkgDir, "dist", "ingest", "project.js"))
const { ingestCodeMap } = await import(join(pkgDir, "dist", "ingest", "code-map.js"))

const estTokens = (s) => Math.ceil((s ?? "").length / 4)

const scratch = join(pkgDir, ".dry-run-tmp")
rmSync(scratch, { recursive: true, force: true })
const repo = await MemoryRepository.load(scratch)

console.log("══ diane dry run ══════════════════════════════════")
console.log(`repo: ${repoPath}\n`)

/* ─── ingest, exactly as the plugin's prefill does ──────────────────── */

let t = performance.now()
const proj = await ingestProjectFacts(repo, repoPath)
const git = await ingestGitHistory(repo, repoPath, 800)
const cm = await ingestCodeMap(repo, repoPath, pkgDir)
const ingestMs = Math.round(performance.now() - t)

console.log(`ingested in ${ingestMs} ms — ${repo.size()} memories, ` +
  `${(repo.totalBytes() / 1024).toFixed(0)} KB\n`)

/* ─── inventory ─────────────────────────────────────────────────────── */

console.log("── memory inventory ──────────────────────────────────────")
const counts = repo.countsByCategory()
for (const [cat, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat.padEnd(18)} ${n}`)
}
if (git.scanned === 0) {
  console.log("\n  ⚠ no git history scanned — not a git repo, or no commits.")
}
if (cm.unavailableReason) {
  console.log(`\n  ⚠ code map unavailable: ${cm.unavailableReason}`)
}

/* ─── git-history signal quality ────────────────────────────────────── */
// Commit messages are stored verbatim — the plugin derives nothing
// from message *style*. So the value of git-history memories depends
// entirely on whether the project writes descriptive commits. Measure
// it honestly rather than assuming.

const all = repo.allMemories()
const gitMems = all.filter((m) => m.category === "git-history")
if (gitMems.length > 0) {
  const lens = gitMems.map((m) => m.content.length).sort((a, b) => a - b)
  const median = lens[Math.floor(lens.length / 2)]
  const terse = gitMems.filter((m) => m.content.length < 90).length
  const tersePct = Math.round((100 * terse) / gitMems.length)
  console.log("\n── git-history signal ────────────────────────────────────")
  console.log(`  median memory length: ${median} chars`)
  console.log(`  terse (<90 chars):    ${tersePct}% of git-history memories`)
  let verdict
  if (median >= 160 && tersePct < 25) verdict = "GOOD — descriptive commits, high-signal memories"
  else if (median >= 110) verdict = "MODERATE — usable, but some commits are terse"
  else verdict = "LOW — many commits are terse; expect weak git-history recall here"
  console.log(`  verdict: ${verdict}`)
  if (verdict.startsWith("LOW")) {
    console.log(
      "  → on this repo the code-map and session-trace categories will\n" +
        "    carry more weight than git history."
    )
  }
}

/* ─── sample memories ───────────────────────────────────────────────── */

console.log("\n── sample memories (what the agent actually sees) ────────")
for (const cat of [...counts.keys()]) {
  const sample = all.filter((m) => m.category === cat).slice(0, 2)
  for (const m of sample) {
    const body = m.content.length > 220 ? m.content.slice(0, 220) + "…" : m.content
    console.log(`  [${cat} | ${m.subject}]`)
    console.log(`    ${body}`)
  }
}

/* ─── realistic retrieval ───────────────────────────────────────────── */

const QUERIES = userQueries.length > 0
  ? userQueries
  : [
      "authentication and tokens",
      "error handling",
      "logging configuration",
      "performance optimization",
      "tests and test coverage",
      "recent bug fixes",
    ]

console.log("\n── retrieval on realistic developer queries ──────────────")
console.log("(judge for yourself whether the top hits are relevant)\n")
let totalRecallTokens = 0
for (const q of QUERIES) {
  const hits = repo.recall({ query: q, limit: 3, tokenBudget: 1200 })
  console.log(`  ❯ "${q}"`)
  if (hits.length === 0) {
    console.log("      (no hits)")
  } else {
    for (const h of hits) {
      const line = `[${h.memory.category} | ${h.memory.subject}] ${h.memory.content}`
      const shown = line.length > 200 ? line.slice(0, 200) + "…" : line
      console.log(`      ${h.score.toFixed(2)}  ${shown}`)
      totalRecallTokens += estTokens(line)
    }
  }
  console.log("")
}

/* ─── prefer: the query-dependent intent lean ───────────────────────── */
// Show the same query under prefer:"code" vs prefer:"tests" — the lean
// is meant to be set by the agent from what the user actually asked.

const probe = QUERIES[0]
console.log("── prefer lean: same query, different intent ─────────────")
console.log(`(query: "${probe}")\n`)
for (const mode of ["code", "tests"]) {
  const hits = repo.recall({ query: probe, limit: 2, tokenBudget: 800, prefer: mode })
  console.log(`  prefer:"${mode}"`)
  if (hits.length === 0) {
    console.log("      (no hits)")
  } else {
    for (const h of hits) {
      const line = `[${h.memory.category} | ${h.memory.subject}]`
      console.log(`      ${h.score.toFixed(2)}  ${line}`)
    }
  }
  console.log("")
}

/* ─── honest summary ────────────────────────────────────────────────── */

console.log("── summary ───────────────────────────────────────────────")
console.log(`  ${repo.size()} memories from a ${ingestMs} ms ingest.`)
console.log(`  ${QUERIES.length} sample recalls cost ~${totalRecallTokens} tokens total`)
console.log(`  (~${Math.round(totalRecallTokens / QUERIES.length)} tokens per query).`)
console.log(
  "  This shows what's stored and retrieved — it does NOT prove a live\n" +
    "  agent will choose to call recall, or use the results well. That\n" +
    "  only shows up inside a real OpenCode session."
)

await repo.close()
rmSync(scratch, { recursive: true, force: true })
