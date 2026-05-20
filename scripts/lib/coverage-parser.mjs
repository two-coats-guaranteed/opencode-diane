/**
 * coverage-parser.mjs — pure parsing logic for `bun test --coverage`
 * output, extracted from coverage-check.mjs so it can be unit-tested
 * in isolation by node:test (no Bun, no spawned children).
 *
 * Every previous CI break in the coverage gate was about the *shape*
 * of bun's captured output, never about real coverage falling, so the
 * tests in coverage-parser-tests.mjs pin the shape contract directly:
 *
 *   - ANSI escape sequences around the column headers and around the
 *     "All files" row do not break parsing (the recurrent CI failure
 *     mode);
 *   - the values are looked up by header label, not by cell position,
 *     so a future bun version reordering or renaming the columns is
 *     caught by the test rather than by CI;
 *   - a missing or malformed table returns `null` rather than throwing
 *     or fabricating a zero.
 *
 * If a new bun release changes the output enough to break parsing,
 * the failing test names the assumption to update — the diagnosis is
 * a one-glance read of the fixture, not a CI guessing game.
 */

/** Remove ANSI SGR escape sequences from a string. Bun emits these
 *  around table cells in CI even when stdout is piped, because its
 *  colour heuristic fires on the CI environment markers. */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, "")
}

/**
 * Parse the "All files" coverage summary from `bun test --coverage`
 * output. Returns `{ funcs, lines, headerLine, allFilesLine }` on
 * success, or `null` if the table can't be located or its numbers
 * can't be read. Robust to ANSI codes, column reordering between bun
 * versions, extra columns, and whitespace variation. Pure — takes a
 * string, returns a value, no I/O.
 */
export function parseCoverageTable(rawOutput) {
  const output = stripAnsi(rawOutput)
  const allLines = output.split("\n")

  // The header row carries both the literal "File" label and the
  // "% Funcs" / "% Lines" column titles. We find it by content rather
  // than by position because bun prints separator rules before and
  // after, and the table may be preceded by suite output.
  const headerLine = allLines.find(
    (l) => /\bFile\b/.test(l) && /%\s*Funcs/i.test(l) && /%\s*Lines/i.test(l)
  )
  const allFilesLine = allLines.find((l) => /^\s*All files\b/.test(l))
  if (!headerLine || !allFilesLine) return null

  // Map column header → index, then read the same indices from the
  // data row. This survives bun ever reordering or renaming columns;
  // a positional read (`cells[1]`/`cells[2]`) does not.
  const headerCells = headerLine.split("|").map((c) => c.trim())
  const funcsIdx = headerCells.findIndex((c) => /%\s*Funcs/i.test(c))
  const linesIdx = headerCells.findIndex((c) => /%\s*Lines/i.test(c))
  if (funcsIdx < 0 || linesIdx < 0) return null

  const allCells = allFilesLine.split("|").map((c) => c.trim())
  const funcs = parseFloat(allCells[funcsIdx])
  const linesPct = parseFloat(allCells[linesIdx])
  if (!Number.isFinite(funcs) || !Number.isFinite(linesPct)) return null

  return { funcs, lines: linesPct, headerLine, allFilesLine }
}
