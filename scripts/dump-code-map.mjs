#!/usr/bin/env bun
/**
 * dump-code-map.mjs — print diane's code map for a repository
 * as plain text, with no plugin runtime, no OpenCode, no API key.
 *
 * The plugin's `memory_code_map` tool serves a *query-ranked subset*
 * of the code map. This script dumps the *whole* map — one block per
 * source file — which is the artifact directly comparable to a full
 * `aider --show-repo-map`. Used by the aider-comparison CI workflow,
 * and handy on its own for eyeballing what the code-map ingester
 * extracted from a repo.
 *
 * USAGE:
 *   bun scripts/dump-code-map.mjs <repo-path>
 *
 * Output goes to stdout (redirect it to a file). A one-line summary
 * goes to stderr so it doesn't pollute the dumped map. Exit codes:
 *   0  map dumped
 *   1  bad usage / plugin not built
 *   2  code map unavailable (e.g. web-tree-sitter missing) — the
 *      reason is printed to stderr
 */

import { existsSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoPath = process.argv[2] ? resolve(process.argv[2]) : null
if (!repoPath || !existsSync(repoPath)) {
  console.error("usage: bun scripts/dump-code-map.mjs <repo-path>")
  console.error(repoPath ? `  path not found: ${repoPath}` : "  (no repo path given)")
  process.exit(1)
}

const pkgDir = resolve(fileURLToPath(import.meta.url), "..", "..")
const distRepo = join(pkgDir, "dist", "store", "repository.js")
if (!existsSync(distRepo)) {
  console.error("plugin not built — run `bun run build` first.")
  process.exit(1)
}

const { MemoryRepository } = await import(join(pkgDir, "dist", "store", "repository.js"))
const { ingestCodeMap } = await import(join(pkgDir, "dist", "ingest", "code-map.js"))

// Scratch store — never touch the target repo's real .opencode dir.
const scratch = join(pkgDir, ".dump-code-map-tmp")
rmSync(scratch, { recursive: true, force: true })

const repo = await MemoryRepository.load(scratch)
const res = await ingestCodeMap(repo, repoPath, pkgDir)

if (res.unavailableReason) {
  console.error(`code map unavailable: ${res.unavailableReason}`)
  await repo.close()
  rmSync(scratch, { recursive: true, force: true })
  process.exit(2)
}

// One block per code-map memory: the file path as a header, then the
// extracted signatures/shape. Stable order by subject so two runs of
// the script diff cleanly.
const maps = repo
  .allMemories()
  .filter((m) => m.category === "code-map")
  .sort((a, b) => a.subject.localeCompare(b.subject))

for (const m of maps) {
  process.stdout.write(`${m.subject}:\n${m.content}\n\n`)
}

console.error(
  `[dump-code-map] ${res.filesParsed} file(s) parsed, ` +
    `${res.signaturesExtracted} signatures, ` +
    `languages: ${res.languagesSeen.join(", ") || "none"}`
)

await repo.close()
rmSync(scratch, { recursive: true, force: true })
