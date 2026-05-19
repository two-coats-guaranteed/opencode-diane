#!/usr/bin/env bun
/**
 * check-size.mjs — fails if the published npm package exceeds a size
 * ceiling.
 *
 * This plugin's footprint is dominated by vendored tree-sitter
 * grammar `.wasm` files — the C++ grammar alone is 4.7 MB. It would
 * be very easy to add "one more grammar" and silently double the
 * install size. This script is the tripwire: it asks npm exactly what
 * it would pack (`npm pack --dry-run --json`) and fails CI if the
 * unpacked size crosses the limit, so a size regression has to be a
 * deliberate, reviewed decision (bump MAX_UNPACKED_MB) rather than an
 * accident.
 *
 * It also sanity-checks that the grammar set is fully included — the
 * `grammars/` directory was once missing from package.json `files`,
 * which this would have caught.
 *
 * Run after `bun run build`. Exits non-zero on violation.
 */

import { execSync } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Ceiling for the UNPACKED package size. C# (5.2 MB) and PHP (1.1 MB)
// were added deliberately in addition to the original 11 grammars; the
// new ceiling reflects that conscious choice. Crossing it again should
// be another conscious, reviewed decision — edit this line and explain why.
const MAX_UNPACKED_MB = 20
// Expected count of vendored grammar wasm files. Bump deliberately
// when adding/removing a language.
const EXPECTED_GRAMMARS = 13

const pkgDir = resolve(fileURLToPath(import.meta.url), "..", "..")

console.log("── package size guard ────────────────────────────────────")

let report
try {
  const out = execSync("npm pack --dry-run --json", { cwd: pkgDir, encoding: "utf-8" })
  report = JSON.parse(out)
} catch (err) {
  console.error(`  ✗ \`npm pack --dry-run\` failed: ${err?.message ?? err}`)
  process.exit(1)
}

const entry = Array.isArray(report) ? report[0] : report
if (!entry || typeof entry.unpackedSize !== "number") {
  console.error("  ✗ could not read unpackedSize from npm pack output")
  process.exit(1)
}

const unpackedMB = entry.unpackedSize / (1024 * 1024)
const packedMB = (entry.size ?? 0) / (1024 * 1024)
const fileCount = entry.entryCount ?? (entry.files?.length ?? 0)

console.log(`  files:     ${fileCount}`)
console.log(`  packed:    ${packedMB.toFixed(2)} MB`)
console.log(`  unpacked:  ${unpackedMB.toFixed(2)} MB  (ceiling ${MAX_UNPACKED_MB} MB)`)

let failed = false

if (unpackedMB > MAX_UNPACKED_MB) {
  console.error(
    `  ✗ unpacked size ${unpackedMB.toFixed(2)} MB exceeds the ${MAX_UNPACKED_MB} MB ceiling.\n` +
      `    If this growth is intentional, raise MAX_UNPACKED_MB in scripts/check-size.mjs.`
  )
  failed = true
} else {
  console.log("  ✓ within size ceiling")
}

// Grammar-set completeness: every vendored .wasm must actually ship.
const files = (entry.files ?? []).map((f) => (typeof f === "string" ? f : f.path))
const grammarFiles = files.filter((p) => /grammars\/.*\.wasm$/.test(p))
if (grammarFiles.length !== EXPECTED_GRAMMARS) {
  console.error(
    `  ✗ expected ${EXPECTED_GRAMMARS} grammar .wasm files in the package, ` +
      `found ${grammarFiles.length}. Check package.json "files" and the grammars/ dir.`
  )
  failed = true
} else {
  console.log(`  ✓ all ${EXPECTED_GRAMMARS} grammar wasm files included`)
}

console.log("──────────────────────────────────────────────────────────")
process.exit(failed ? 1 : 0)
