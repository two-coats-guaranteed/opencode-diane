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
 * Defensive parsing — every previous CI break here was caused by the
 * captured-output shape, not by real coverage falling. Specifically:
 *   - bun auto-enables ANSI colours when it senses a CI terminal, so
 *     the "All files" row arrived prefixed by `\x1b[1m…` and a literal
 *     `startsWith("All files")` matcher quietly returned nothing;
 *   - bun across versions reorders or renames the table columns, so
 *     a fixed cell index (`cells[1]`/`cells[2]`) is brittle.
 * This version strips ANSI before matching, forces NO_COLOR on the
 * child, finds the table columns by parsing the header rather than
 * by position, and dumps the raw run to disk on every failure so the
 * uploaded coverage/ artefact carries the diagnosis.
 *
 * On any failure this script also prints the FULL captured output:
 * a suite failure is reported by the suite itself in that output;
 * a missing coverage table only makes sense with the raw output in
 * front of you.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { parseCoverageTable } from "./lib/coverage-parser.mjs"

// Floors. Bun measures a little differently than c8 did; these sit a
// few points below the real current numbers as a regression guard,
// not as an absolute target. Raise them if real coverage climbs.
const MIN_LINES = 78
const MIN_FUNCS = 78

// Production deps the suites need at runtime. We check these explicitly
// because their absence is by far the most common cause of `bun test`
// returning a non-zero exit code on a fresh checkout.
const REQUIRED_DEPS = ["@opencode-ai/plugin"]

// Hard cap on the coverage run — 10 minutes is generous; anything
// longer is a hang the CI minute budget can't absorb either.
const RUN_TIMEOUT_MS = 10 * 60 * 1000

const COVERAGE_DIR = "coverage"
const RAW_OUTPUT_PATH = join(COVERAGE_DIR, "last-run.txt")
const RULE = "──────────────────────────────────────────────────────────"
const indent = (s) =>
  s.split("\n").map((l) => "  │ " + l).join("\n")

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
  stdio: ["ignore", "pipe", "pipe"],
  // Force no ANSI from the child — CI runners often satisfy bun's
  // colour-on heuristic even on a pipe.
  env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CLICOLOR: "0" },
  timeout: RUN_TIMEOUT_MS,
  maxBuffer: 32 * 1024 * 1024,
})

if (res.error && res.error.code === "ETIMEDOUT") {
  console.error(`  ✗ \`bun test --coverage\` timed out after ${RUN_TIMEOUT_MS / 60000} minutes`)
  console.log(RULE)
  process.exit(1)
}

const rawOutput = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trimEnd()

// Always persist the raw run for the uploaded coverage/ artefact, so
// a CI failure has full diagnostics attached without re-running.
try {
  mkdirSync(COVERAGE_DIR, { recursive: true })
  writeFileSync(RAW_OUTPUT_PATH, rawOutput + "\n")
} catch {
  /* best-effort — the run continues either way */
}

/** Print the whole captured run, clearly fenced, so the user can see it. */
function dumpOutput() {
  console.error("")
  console.error("  ── full output of `bun test --coverage` ──────────────────")
  console.error(indent(rawOutput || "(no output captured)"))
  console.error(`  ${RULE}`)
  console.error(`  (also written to ${RAW_OUTPUT_PATH})`)
}

// ── a suite hard-failed ─────────────────────────────────────────────
if (res.status !== 0) {
  console.error(`  ✗ \`bun test --coverage\` exited ${res.status} — a suite failed`)
  const cantFind = rawOutput
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
  console.error("  one that fails (bun test interleaves all 16 at once).")
  console.log(RULE)
  process.exit(1)
}

// ── run succeeded — parse the coverage table ────────────────────────
// All parsing logic lives in scripts/lib/coverage-parser.mjs and is
// unit-tested by scripts/lib/coverage-parser-tests.mjs against the
// CI-shape failure modes (ANSI, column reordering, malformed rows).
const parsed = parseCoverageTable(rawOutput)
if (!parsed) {
  console.error("  ✗ run succeeded but no coverage table was found")
  console.error("  → this bun build may have changed the --coverage output;")
  console.error("    inspect the raw output below and update the parser at")
  console.error("    scripts/lib/coverage-parser.mjs (its tests will tell you")
  console.error("    what assumption broke)")
  dumpOutput()
  console.log(RULE)
  process.exit(1)
}

const { funcs, lines: linesPct } = parsed

console.log(`  functions: ${funcs.toFixed(2)}%  (floor ${MIN_FUNCS}%)`)
console.log(`  lines:     ${linesPct.toFixed(2)}%  (floor ${MIN_LINES}%)`)

let failed = false
if (linesPct < MIN_LINES) {
  console.error(`  ✗ line coverage ${linesPct.toFixed(2)}% is below the ${MIN_LINES}% floor`)
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
