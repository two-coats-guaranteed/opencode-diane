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
 * reports accurate coverage — this script parses that report and
 * enforces the floor, the role the old c8 `--check-coverage` had.
 *
 * On any failure this script prints the FULL captured output of the
 * `bun test --coverage` run. A suite failure is reported by the suite
 * itself (its own `✗` lines and error are in that output); a missing
 * coverage table likewise only makes sense with the raw output in
 * front of you. Hiding it behind a generic "a suite failed" — as an
 * earlier version of this script did — leaves the user with nothing
 * to act on. The captured output is the diagnosis; show it.
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

const RULE = "──────────────────────────────────────────────────────────"
const indent = (s) =>
  s
    .split("\n")
    .map((l) => "  │ " + l)
    .join("\n")

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
  console.log(RULE)
  process.exit(1)
}

const res = spawnSync("bun", ["test", "--coverage"], {
  encoding: "utf-8",
  // coverage summary is printed to stderr by bun; capture both streams
  stdio: ["ignore", "pipe", "pipe"],
})

const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trimEnd()

/** Print the whole captured run, clearly fenced, so the user can see it. */
function dumpOutput() {
  console.error("")
  console.error("  ── full output of `bun test --coverage` ──────────────────")
  console.error(indent(output || "(no output captured)"))
  console.error(`  ${RULE}`)
}

// ── a suite hard-failed ─────────────────────────────────────────────
// `bun test` aborts the run when a suite calls process.exit(1) on an
// assertion failure, so a non-zero status usually also means no
// coverage table was produced. The failing suite's own `✗` line and
// error text are in `output` — show all of it.
if (res.status !== 0) {
  console.error(`  ✗ \`bun test --coverage\` exited ${res.status} — a suite failed`)
  const cantFind = output
    .split("\n")
    .find((l) => l.includes("Cannot find module") || l.includes("Cannot find package"))
  if (cantFind) {
    console.error(`  ✗ module resolution failed — ${cantFind.trim()}`)
    console.error(`  → your node_modules looks incomplete; run \`bun install\``)
  }
  dumpOutput()
  console.error("")
  console.error("  Coverage cannot be measured until every suite passes.")
  console.error("  For an isolated, clearly-named per-suite view, run:")
  console.error("      bun run test")
  console.error("  which runs each suite in its own process and names the")
  console.error("  one that fails (bun test interleaves all 14 at once).")
  console.log(RULE)
  process.exit(1)
}

// ── run succeeded — locate the coverage table ───────────────────────
// The summary row looks like:
//   All files            |   83.86 |   82.44 |
// columns: <name> | % Funcs | % Lines | <uncovered>
const row = output.split("\n").find((l) => l.trim().startsWith("All files"))
if (!row) {
  console.error("  ✗ the run passed but no 'All files' coverage row was found")
  console.error("  → this Bun build may format `--coverage` differently;")
  console.error("    inspect the raw output below and adjust the parser")
  dumpOutput()
  console.log(RULE)
  process.exit(1)
}

const cells = row.split("|").map((c) => c.trim())
const funcs = parseFloat(cells[1])
const lines = parseFloat(cells[2])

if (!Number.isFinite(funcs) || !Number.isFinite(lines)) {
  console.error(`  ✗ could not parse coverage numbers from: ${row.trim()}`)
  dumpOutput()
  console.log(RULE)
  process.exit(1)
}

console.log(`  functions: ${funcs.toFixed(2)}%  (floor ${MIN_FUNCS}%)`)
console.log(`  lines:     ${lines.toFixed(2)}%  (floor ${MIN_LINES}%)`)

let failed = false
if (lines < MIN_LINES) {
  console.error(`  ✗ line coverage ${lines.toFixed(2)}% is below the ${MIN_LINES}% floor`)
  failed = true
}
if (funcs < MIN_FUNCS) {
  console.error(`  ✗ function coverage ${funcs.toFixed(2)}% is below the ${MIN_FUNCS}% floor`)
  failed = true
}
if (failed) dumpOutput()
else console.log("  ✓ coverage within thresholds")

console.log(RULE)
process.exit(failed ? 1 : 0)
