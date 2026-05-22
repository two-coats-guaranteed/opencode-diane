/**
 * tables.ts — ingest the column headers of tabular files.
 *
 * The premise: data files in a repo have structural value (the column
 * names tell the agent what's in the table — "id, email, signup_date,
 * plan_tier" is enough to know `users.csv` is the user table) without
 * the row data being useful for recall (a million rows of values
 * would just bloat the BM25 index).
 *
 * Header-only ingestion is the right slice: high signal, bounded
 * cost, and the agent can always read the full file on demand via
 * OpenCode's `read` tool when it actually needs row data.
 *
 * **Scope:**
 *   - `.csv` and `.tsv` — first-line parse, no dependency, never loads
 *     more than the first 64 KB of the file.
 *   - `.xlsx`, `.xls`, `.xlsm` — handled via SheetJS (the `xlsx` npm
 *     package), **lazily imported** only when a spreadsheet is
 *     actually encountered, so repos with no spreadsheets never pay
 *     the ~5 MB module-load cost. Each sheet becomes its own memory.
 *   - Walks the project tree with a generous file cap and the same
 *     SKIP_DIRS the other ingesters use.
 *
 * **CSV parsing.** A small inline parser handles quoted fields,
 * embedded commas, escaped quotes, and CRLF line endings. Pulling in
 * a CSV dep for this is not justified.
 *
 * **XLSX safety.** SheetJS is invoked with macros, formulas, and
 * styles disabled — we only need cell values from row 1 of each
 * sheet, nothing else. This significantly reduces the surface a
 * hostile workbook could present.
 */

import { readdir, open } from "node:fs/promises"
import { join, relative, sep, extname, basename } from "node:path"

import type { MemoryRepository } from "../store/repository.js"

const CATEGORY = "project-facts"

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  "coverage",
  ".cache",
  "vendor",
])

const MAX_FILES = 200
const FIRST_LINE_READ_BYTES = 64 * 1024
const MAX_XLSX_BYTES = 50 * 1024 * 1024
const MAX_COLUMNS_TO_LIST = 40
const MAX_SHEETS_PER_WORKBOOK = 20

const CSV_EXTS = new Set([".csv", ".tsv"])
const XLSX_EXTS = new Set([".xlsx", ".xls", ".xlsm"])

export interface TablesIngestOptions {
  maxFiles?: number
  maxXlsxMB?: number
  maxColumns?: number
}

export interface TablesIngestResult {
  filesFound: number
  /**
   * Subset of the formats this pass actually covered. CSV/TSV are
   * always supported. XLSX/XLS appear here only when at least one
   * spreadsheet was found AND SheetJS was successfully loaded; if
   * the dependency is missing at runtime the result reports an
   * `xlsxUnavailableReason` and spreadsheets are silently skipped.
   */
  formatsSupported: ReadonlyArray<string>
  /** Set if a spreadsheet was found but SheetJS could not be loaded. */
  xlsxUnavailableReason?: string
}

export async function ingestTableHeaders(
  repo: MemoryRepository,
  root: string,
  opts: TablesIngestOptions = {},
): Promise<TablesIngestResult> {
  const maxFilesLimit   = Math.max(1, Math.round(opts.maxFiles    ?? MAX_FILES))
  const maxXlsxBytes    = Math.max(0, (opts.maxXlsxMB ?? MAX_XLSX_BYTES / (1024 * 1024))) * 1024 * 1024
  const maxColumnsLimit = Math.max(1, Math.round(opts.maxColumns  ?? MAX_COLUMNS_TO_LIST))
  let filesFound = 0
  let sawSpreadsheet = false
  let xlsxLoader: Promise<XlsxModule | { error: string }> | null = null

  const formats = new Set<string>(["csv", "tsv"])
  let xlsxUnavailableReason: string | undefined

  const stack = [root]
  while (stack.length > 0 && filesFound < maxFilesLimit) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name))
        continue
      }
      if (!e.isFile()) continue
      const ext = extname(e.name).toLowerCase()
      const abs = join(dir, e.name)
      const rel = relative(root, abs).split(sep).join("/")

      if (CSV_EXTS.has(ext)) {
        const columns = await readHeaderColumns(abs, ext === ".tsv" ? "\t" : ",")
        if (columns === null) continue
        filesFound += 1
        emit(repo, rel, ext.slice(1).toUpperCase(), null, columns, maxColumnsLimit)
      } else if (XLSX_EXTS.has(ext)) {
        sawSpreadsheet = true
        // First spreadsheet seen: lazy-import SheetJS. Promise is
        // cached so subsequent files reuse the loaded module
        // without repeated dynamic-import cost.
        if (!xlsxLoader) xlsxLoader = loadXlsx()
        const xlsx = await xlsxLoader
        if ("error" in xlsx) {
          // SheetJS missing or failed to load — skip ALL spreadsheets
          // for this pass and surface the reason. The caller logs
          // once; we don't spam per-file warnings.
          if (!xlsxUnavailableReason) xlsxUnavailableReason = xlsx.error
          continue
        }
        const sheets = await readXlsxSheets(xlsx, abs, maxXlsxBytes)
        if (sheets === null) continue
        filesFound += 1
        for (const s of sheets) {
          emit(repo, rel, ext.slice(1).toUpperCase(), s.sheetName, s.columns, maxColumnsLimit)
        }
      } else {
        continue
      }
      if (filesFound >= maxFilesLimit) break
    }
  }

  if (sawSpreadsheet && !xlsxUnavailableReason) {
    formats.add("xlsx")
    formats.add("xls")
  }

  return {
    filesFound,
    formatsSupported: Array.from(formats),
    ...(xlsxUnavailableReason ? { xlsxUnavailableReason } : {}),
  }
}

function emit(
  repo: MemoryRepository,
  rel: string,
  format: string,
  sheetName: string | null,
  columns: string[],
  maxColumns: number,
): void {
  const shown =
    columns.length > maxColumns
      ? columns.slice(0, maxColumns).join(", ") + `, … (${columns.length - maxColumns} more)`
      : columns.join(", ")
  const fileTag = basename(rel, extname(rel)).toLowerCase().replace(/[^a-z0-9]+/g, "-")
  // Single-cell files (CSV/TSV) → `table:<path>` (unchanged from v0.0.4
  // first cut). Spreadsheets → `table:<path>#<sheet>` so multi-sheet
  // workbooks become multiple memories with distinct subjects.
  const subject = sheetName ? `table:${rel}#${slugifySheet(sheetName)}` : `table:${rel}`
  const sheetSuffix = sheetName ? ` sheet "${sheetName}"` : ""
  repo.insertIfMissing({
    category: CATEGORY,
    subject,
    content:
      `${rel}${sheetSuffix} (${format}, ${columns.length} columns): ${shown}. ` +
      `Read the file directly with OpenCode's read tool for row data.`,
    tags: ["table", "schema", format.toLowerCase(), fileTag, ...(sheetName ? ["sheet"] : [])],
    source: "tables-ingest",
  })
}

function slugifySheet(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "sheet"
}

/* ─── CSV / TSV path ────────────────────────────────────────────────── */

async function readHeaderColumns(abs: string, delimiter: string): Promise<string[] | null> {
  let handle
  try {
    handle = await open(abs, "r")
  } catch {
    return null
  }
  try {
    const s = await handle.stat()
    if (!s.isFile() || s.size === 0) return null
    const bytesToRead = Math.min(s.size, FIRST_LINE_READ_BYTES)
    const buf = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buf, 0, bytesToRead, 0)
    if (bytesRead === 0) return null
    const text = buf.subarray(0, bytesRead).toString("utf-8")
    if (text.indexOf("\0") >= 0) return null
    const firstLineEnd = findLineTerminator(text)
    const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)
    if (firstLine.length === 0) return null
    const cols = parseDelimitedLine(firstLine, delimiter)
    if (cols.length < 2) return null
    if (cols.some((c) => c.length > 200)) return null
    return cols.map((c) => c.trim()).filter((c) => c.length > 0)
  } finally {
    await handle.close()
  }
}

function findLineTerminator(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 10 || c === 13) return i
  }
  return -1
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let cur = ""
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '"') {
      i += 1
      while (i < line.length) {
        const d = line[i]
        if (d === '"') {
          if (line[i + 1] === '"') {
            cur += '"'
            i += 2
          } else {
            i += 1
            break
          }
        } else {
          cur += d
          i += 1
        }
      }
    } else if (c === delimiter) {
      out.push(cur)
      cur = ""
      i += 1
    } else {
      cur += c
      i += 1
    }
  }
  out.push(cur)
  return out
}

/* ─── XLSX / XLS / XLSM path (lazy SheetJS) ────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XlsxModule = any

/**
 * Lazy-load SheetJS. The dynamic import is the whole reason this
 * exists — a repo with no spreadsheets never triggers it, and the
 * ~5 MB module-load cost is amortised across every workbook in the
 * pass once it does. Caller caches the returned promise.
 *
 * If the dependency is missing or fails to load, we return a value
 * with an `error` field — callers degrade to skipping spreadsheets
 * silently rather than crashing the whole ingest.
 */
async function loadXlsx(): Promise<XlsxModule | { error: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("xlsx")
    return mod.default ?? mod
  } catch (err) {
    return { error: `xlsx (SheetJS) could not be loaded: ${err instanceof Error ? err.message : String(err)}` }
  }
}

interface SheetHeaders {
  sheetName: string
  columns: string[]
}

/**
 * Open a workbook and pull row-1 cell values from every sheet. We
 * read the whole file from disk (SheetJS doesn't stream) but pass
 * read options that disable macros, formulas, styles, and number-
 * format parsing — all of which we don't need and which add to both
 * the work and the attack surface a hostile workbook could present.
 *
 * Returns null on any failure (missing file, parse error, oversized,
 * etc.) — same contract as the CSV path: a problematic file is
 * silently skipped, never fatal.
 */
async function readXlsxSheets(xlsx: XlsxModule, abs: string, maxBytes: number = MAX_XLSX_BYTES): Promise<SheetHeaders[] | null> {
  let handle
  try {
    handle = await open(abs, "r")
  } catch {
    return null
  }
  try {
    const s = await handle.stat()
    if (!s.isFile() || s.size === 0 || s.size > maxBytes) return null
  } finally {
    await handle.close()
  }
  let wb
  try {
    wb = xlsx.readFile(abs, {
      // Minimum-surface read: we only want cell values from row 1.
      cellFormula: false,
      cellHTML: false,
      cellNF: false,
      cellStyles: false,
      cellText: false,
      cellDates: false,
      bookVBA: false,
      bookFiles: false,
      bookProps: false,
      bookSheets: false,
    })
  } catch {
    return null
  }
  const sheets: SheetHeaders[] = []
  const names = Array.isArray(wb?.SheetNames) ? wb.SheetNames.slice(0, MAX_SHEETS_PER_WORKBOOK) : []
  for (const name of names) {
    const ws = wb.Sheets?.[name]
    if (!ws) continue
    const cols = extractHeaderRowFromSheet(xlsx, ws)
    if (cols.length < 2) continue
    sheets.push({ sheetName: String(name), columns: cols })
  }
  return sheets.length > 0 ? sheets : null
}

/**
 * Pull cell values from row 1 of one worksheet by walking the sheet's
 * declared range. We deliberately read cells directly (`ws[A1]`,
 * `ws[B1]`, …) rather than `sheet_to_json` so the full row block
 * past row 1 is never materialised. A sheet with 1 M rows costs the
 * same as a sheet with 10.
 */
function extractHeaderRowFromSheet(xlsx: XlsxModule, ws: unknown): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sheet = ws as any
  const ref = typeof sheet["!ref"] === "string" ? sheet["!ref"] : null
  if (!ref) return []
  let range
  try {
    range = xlsx.utils.decode_range(ref)
  } catch {
    return []
  }
  if (!range || !range.s || !range.e) return []
  const row = range.s.r
  const out: string[] = []
  for (let c = range.s.c; c <= range.e.c; c++) {
    if (out.length >= 200) break
    const addr = xlsx.utils.encode_cell({ r: row, c })
    const cell = sheet[addr]
    const v = cell?.v
    if (v === undefined || v === null) {
      out.push("")
      continue
    }
    out.push(String(v))
  }
  // Drop trailing empty cells — common when a sheet has stray cells
  // far to the right of the real table.
  while (out.length > 0 && out[out.length - 1] === "") out.pop()
  return out.map((c) => c.trim()).filter((c) => c.length > 0)
}
