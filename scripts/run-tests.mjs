#!/usr/bin/env bun
/**
 * Test runner — auto-discovers every `tests/*.test.ts` file and runs
 * each in its own Bun process. The runner exists because the previous
 * inline `bun tests/x.test.ts && bun tests/y.test.ts && …` chain in
 * package.json went stale every time a test file was added. With
 * auto-discovery, new tests are picked up automatically and the only
 * place that needs updating is the tests directory itself.
 *
 * Each test prints its own pass/fail summary. We aggregate counts and
 * fail the run if any single suite fails. Stdout from each test is
 * passed through verbatim so the output is identical to running them
 * one by one — and CI logs stay readable.
 */

import { readdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const testsDir = "tests"
const files = readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort()

if (files.length === 0) {
  console.error("test runner: no tests/*.test.ts files found")
  process.exit(1)
}

console.log(`running ${files.length} test suite(s)…\n`)

let suitesPassed = 0
let suitesFailed = 0
const failedSuites = []

for (const f of files) {
  const path = join(testsDir, f)
  const res = spawnSync("bun", [path], { stdio: "inherit" })
  if (res.status === 0) {
    suitesPassed += 1
  } else {
    suitesFailed += 1
    failedSuites.push(f)
  }
}

console.log("\n" + "═".repeat(60))
console.log(
  `${suitesPassed}/${files.length} suites passed` +
    (suitesFailed > 0 ? `, ${suitesFailed} failed: ${failedSuites.join(", ")}` : ""),
)

process.exit(suitesFailed > 0 ? 1 : 0)
