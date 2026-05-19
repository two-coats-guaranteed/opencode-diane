#!/usr/bin/env bun
/**
 * coverage-check.mjs — run the suites under `bun test --coverage` and
 * fail if line/function coverage falls below the thresholds.
 *
 * Why a script instead of Bun's built-in `coverageThreshold`: the test
 * suites use their own assertion harness, not `bun:test` primitives,
 * so `bun test` reports "0 tests" and its native threshold gate is a
 * no-op. The suites still *run* (and still self-gate on pass/fail via
 * the `test` script), and `bun test --coverage` still instruments and
 * reports accurate coverage — this script just parses that report and
 * enforces the floor, the same role the old c8 `--check-coverage` had.
 *
 * Self-diagnosis: if `bun test --coverage` exits non-zero because a
 * dependency couldn't be resolved (e.g. `@opencode-ai/plugin` not in
 * node_modules), we say so explicitly and point at `bun install`,
 * instead of leaving the user staring at a generic "a suite failed".
 * Real assertion failures still surface as before.
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

// Floors. Bun measures a little differently than c8 did; these sit a
// few points below the real current numbers as a regression guard,
// not as an absolute target. Raise them if real coverage climbs.
const MIN_LINES = 78
const MIN_FUNCS = 78

// Production deps the suites need at runtime. We check these explicitly
// because their absence is by far the most common cause of `bun test`
// returning a non-zero exit code on a fresh checkout.
const REQUIRED_DEPS = ["@opencode-ai/plugin"]

console.log("── coverage gate (bun test --coverage) ───────────────────")

// Preflight: a missing top-level dependency is a one-line answer
// (`bun install`) — surface that *before* spending several seconds on
// a doomed coverage run.
const missingDeps = REQUIRED_DEPS.filter(
  (d) => !existsSync(join("node_modules", d, "package.json"))
)
if (missingDeps.length > 0) {
  console.error(`  ✗ missing in node_modules: ${missingDeps.join(", ")}`)
  console.error(`  → run \`bun install\` and try again`)
  console.log("──────────────────────────────────────────────────────────")
  process.exit(1)
}

const res = spawnSync("bun", ["test", "--coverage"], {
  encoding: "utf-8",
  // coverage summary is printed to stderr by bun; capture both
  stdio: ["ignore", "pipe", "pipe"],
})

const output = (res.stdout ?? "") + "\n" + (res.stderr ?? "")

// If any suite hard-failed, surface that first — and try to give a
// specific reason where we can. A `Cannot find module` line is the
// fingerprint of a node_modules problem that slipped past the
// preflight (e.g. a transitive that didn't get installed); say so.
let suiteIssue = null
if (res.status !== 0) {
  const cantFind = output
    .split("\n")
    .find((l) => l.includes("Cannot find module") || l.includes("Cannot find package"))
  if (cantFind) {
    suiteIssue = `module resolution failed — ${cantFind.trim()}`
    console.error(`  ✗ ${suiteIssue}`)
    console.error(`  → check your node_modules; \`bun install\` usually resolves this`)
  } else {
    suiteIssue = `\`bun test --coverage\` exited ${res.status} — a suite failed`
    console.error(`  ✗ ${suiteIssue}`)
  }
}

// The summary row looks like:
//   All files            |   83.86 |   82.44 |
// columns: <name> | % Funcs | % Lines | <uncovered>
const row = output.split("\n").find((l) => l.trim().startsWith("All files"))
if (!row) {
  console.error("  ✗ could not find the 'All files' coverage row in bun output")
  console.log("──────────────────────────────────────────────────────────")
  process.exit(1)
}

const cells = row.split("|").map((c) => c.trim())
const funcs = parseFloat(cells[1])
const lines = parseFloat(cells[2])

if (!Number.isFinite(funcs) || !Number.isFinite(lines)) {
  console.error(`  ✗ could not parse coverage numbers from: ${row.trim()}`)
  console.log("──────────────────────────────────────────────────────────")
  process.exit(1)
}

console.log(`  functions: ${funcs.toFixed(2)}%  (floor ${MIN_FUNCS}%)`)
console.log(`  lines:     ${lines.toFixed(2)}%  (floor ${MIN_LINES}%)`)

let failed = suiteIssue !== null
if (lines < MIN_LINES) {
  console.error(`  ✗ line coverage ${lines.toFixed(2)}% is below the ${MIN_LINES}% floor`)
  failed = true
}
if (funcs < MIN_FUNCS) {
  console.error(`  ✗ function coverage ${funcs.toFixed(2)}% is below the ${MIN_FUNCS}% floor`)
  failed = true
}
if (!failed) console.log("  ✓ coverage within thresholds")

console.log("──────────────────────────────────────────────────────────")
process.exit(failed ? 1 : 0)
