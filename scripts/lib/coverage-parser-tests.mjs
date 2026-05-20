/**
 * coverage-parser-tests.mjs — regression tests for the parser in
 * scripts/lib/coverage-parser.mjs.
 *
 * Every previous CI break of the coverage gate was about the *shape*
 * of bun's `--coverage` output, never about real coverage falling.
 * These tests pin every shape the parser is expected to handle, so the
 * next bun output-format change is caught here on a developer's
 * machine — not on CI, two weeks after the fact.
 *
 * Each fixture is a stripped-down version of a real bun output. When a
 * future bun release changes the format enough to break parsing, the
 * failing test names the assumption to update.
 *
 * Standalone — node stdlib only (`node:test` + `node:assert`).
 * Filename intentionally omits the `.test.` infix so `bun test` does
 * not discover it; the test job in CI invokes it via `node --test
 * scripts/lib/coverage-parser-tests.mjs`.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { parseCoverageTable, stripAnsi } from "./coverage-parser.mjs"

// ── fixtures ──────────────────────────────────────────────────────────

/** A clean `bun test --coverage` table with no ANSI. */
const PLAIN = `
--------------------------------|---------|---------|-------------------
File                            | % Funcs | % Lines | Uncovered Line #s
--------------------------------|---------|---------|-------------------
All files                       |   91.85 |   91.79 |
 src/index.ts                   |   57.45 |   54.21 | 142,195-206
 src/search/ppr.ts              |  100.00 |  100.00 |
--------------------------------|---------|---------|-------------------

 0 pass
 0 fail
Ran 0 tests across 16 files. [15.82s]
`

/** The exact CI failure mode: ANSI bold around column headers AND
 *  the All-files row. The old literal matcher dies on this. */
const ANSI = `
--------------------------------|---------|---------|-------------------
\x1b[1mFile\x1b[0m                            | \x1b[1m% Funcs\x1b[0m | \x1b[1m% Lines\x1b[0m | Uncovered Line #s
--------------------------------|---------|---------|-------------------
\x1b[1mAll files\x1b[0m                       |   91.85 |   91.79 |
 src/index.ts                   |   57.45 |   54.21 | 142
--------------------------------|---------|---------|-------------------
`

/** A future bun version reorders columns. The parser must still pick
 *  the right value — by header label, not by index. */
const REORDERED = `
File                            | % Lines | % Funcs | Uncovered Line #s
--------------------------------|---------|---------|-------------------
All files                       |   91.79 |   91.85 |
`

/** A future bun version adds extra columns. */
const EXTRA_COLUMNS = `
File                            | % Stmts | % Funcs | % Lines | % Branch | Uncovered
--------------------------------|---------|---------|---------|----------|----------
All files                       |   90.00 |   91.85 |   91.79 |    85.00 |
`

/** Bun ran but no coverage table was emitted (the `--coverage` flag
 *  was missed, or output was redirected — either way, no table). */
const NO_TABLE = `
 0 pass
 0 fail
Ran 0 tests across 16 files. [15.82s]
`

/** Table is present but the All-files data row carries N/A — e.g. a
 *  zero-source run. The parser must say "can't read it" (null), not
 *  fabricate a number. */
const MALFORMED_NUMBERS = `
File                            | % Funcs | % Lines | Uncovered Line #s
--------------------------------|---------|---------|-------------------
All files                       |     N/A |     N/A |
`

// ── parseCoverageTable: happy paths ───────────────────────────────────

test("parses a clean (no ANSI) coverage table", () => {
  const r = parseCoverageTable(PLAIN)
  assert.ok(r, "should not return null on a healthy table")
  assert.equal(r.funcs, 91.85)
  assert.equal(r.lines, 91.79)
})

test("parses through ANSI escapes around headers and the All-files row — the recurrent CI failure mode", () => {
  // The old parser did `line.trim().startsWith("All files")` — that
  // returned `false` here because the ANSI prefix survives `trim`,
  // breaking the gate in CI while local runs (no ANSI) stayed green.
  const r = parseCoverageTable(ANSI)
  assert.ok(r, "ANSI codes must not break table location")
  assert.equal(r.funcs, 91.85)
  assert.equal(r.lines, 91.79)
})

test("looks up values by header label, so column reordering does not flip funcs and lines", () => {
  // If the parser read by position, this would return funcs=91.79
  // (wrong). The header tells us which column is which.
  const r = parseCoverageTable(REORDERED)
  assert.ok(r)
  assert.equal(r.funcs, 91.85, "% Funcs is identified by header, not by index")
  assert.equal(r.lines, 91.79, "% Lines is identified by header, not by index")
})

test("picks the right columns when bun adds extra ones", () => {
  // A future bun adding % Stmts and % Branch must not displace
  // funcs/lines — header-driven lookup keeps it stable.
  const r = parseCoverageTable(EXTRA_COLUMNS)
  assert.ok(r)
  assert.equal(r.funcs, 91.85)
  assert.equal(r.lines, 91.79)
})

// ── parseCoverageTable: failure modes return null, not crashes ────────

test("returns null when the coverage table is absent (does not crash, does not fabricate)", () => {
  assert.equal(parseCoverageTable(NO_TABLE), null)
})

test("returns null on empty input", () => {
  assert.equal(parseCoverageTable(""), null)
})

test("returns null when the data row's numbers cannot be parsed", () => {
  // The honest answer to "I don't know the coverage" is null, not 0
  // or NaN. coverage-check.mjs treats null as a parse failure and
  // dumps the raw output for the developer to inspect.
  assert.equal(parseCoverageTable(MALFORMED_NUMBERS), null)
})

test("returns null when the header is missing but an 'All files' line exists", () => {
  // A misleading partial output must not coerce into a result.
  const partial = `
All files                       |   91.85 |   91.79 |
`
  assert.equal(parseCoverageTable(partial), null)
})

test("returns null when the header is present but no 'All files' row follows", () => {
  const partial = `
File                            | % Funcs | % Lines | Uncovered
--------------------------------|---------|---------|----------
 src/index.ts                   |   57.45 |   54.21 |
`
  assert.equal(parseCoverageTable(partial), null)
})

// ── stripAnsi: targeted unit tests ────────────────────────────────────

test("stripAnsi removes bold, colour, reset, and combined sequences", () => {
  assert.equal(stripAnsi("\x1b[1mbold\x1b[0m"), "bold")
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red")
  assert.equal(stripAnsi("\x1b[1;31mbold-red\x1b[0m"), "bold-red")
  assert.equal(stripAnsi("plain text"), "plain text", "untouched if no escapes")
  assert.equal(stripAnsi(""), "")
})

test("stripAnsi coerces non-string inputs cleanly", () => {
  // Defensive — the parser is fed res.stdout/res.stderr which could
  // be null/undefined when the spawned child produced nothing.
  assert.equal(stripAnsi(null), "null")
  assert.equal(stripAnsi(undefined), "undefined")
})
