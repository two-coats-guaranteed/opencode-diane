/**
 * xlsx.ts — minimal XLSX reader, header-row only.
 *
 * XLSX is a ZIP archive of XML files. We need exactly two of them:
 *   - `xl/worksheets/sheet1.xml`   — cell data
 *   - `xl/sharedStrings.xml`       — string table (cells of type "s" are
 *                                    indices into this; not all sheets
 *                                    use it, so it's optional)
 *
 * This file implements the smallest possible code path to extract the
 * first row's cell values:
 *
 *   1. Find the End-of-Central-Directory record at the file tail.
 *   2. Read the Central Directory entries to locate our two files.
 *   3. For each, seek to the local file header, read the compressed
 *      data, and `inflateRaw` it to text.
 *   4. Pull the first `<row>` from the sheet XML, walk its `<c>`
 *      cells, resolving shared-string indices against the table.
 *
 * **Deliberately limited scope.** Standard PKZIP layout only — no
 * ZIP64 (sheets >4 GiB), no encryption, no compression method other
 * than `stored` (0) or `deflated` (8). Spreadsheets violating any of
 * those return `null` and the caller skips the file. Failing closed
 * is correct here: we promise header discoverability, not row data.
 *
 * **No external dependencies.** This module uses only `node:fs/promises`
 * and `node:zlib`. SheetJS/exceljs would handle every edge case but
 * add 1-2 MB of dependency weight for what is a niche feature in a
 * source-code-indexer. The trade is intentional and documented.
 */

import { open, type FileHandle } from "node:fs/promises"
import { inflateRawSync } from "node:zlib"

// ── PKZIP wire-format constants ────────────────────────────────────
const SIG_LOCAL_FILE_HEADER = 0x04034b50
const SIG_CENTRAL_DIRECTORY = 0x02014b50
const SIG_END_OF_CENTRAL_DIR = 0x06054b50

// End-of-Central-Directory record is 22 bytes plus a variable-length
// comment up to 65535 bytes. We scan the last 64 KiB which covers any
// realistic case (XLSX files don't carry archive comments).
const EOCD_SCAN_BYTES = 65_557

// Hard ceilings — bounded work per file even on malicious input.
const MAX_FILE_BYTES = 200 * 1024 * 1024 // 200 MB compressed
const MAX_UNCOMPRESSED_BYTES = 80 * 1024 * 1024 // 80 MB inflated
const MAX_COLUMNS = 256

interface CentralEntry {
  name: string
  localHeaderOffset: number
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
}

/**
 * Public entry point. Returns the first row's cell values, or null
 * if the file isn't a readable XLSX, the sheet is empty, or anything
 * about the structure trips the limits above. Never throws.
 */
export async function readXlsxFirstRow(absPath: string): Promise<string[] | null> {
  let handle: FileHandle | null = null
  try {
    handle = await open(absPath, "r")
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 22 || stat.size > MAX_FILE_BYTES) return null

    const entries = await readCentralDirectory(handle, stat.size)
    if (!entries) return null

    // We need sheet1.xml; sharedStrings.xml is optional.
    const sheet = entries.find((e) => e.name === "xl/worksheets/sheet1.xml")
    if (!sheet) return null
    const sharedEntry = entries.find((e) => e.name === "xl/sharedStrings.xml") ?? null

    const sheetXml = await extractEntryAsText(handle, sheet)
    if (sheetXml === null) return null
    const sharedXml = sharedEntry ? await extractEntryAsText(handle, sharedEntry) : null

    const sharedStrings = sharedXml ? parseSharedStrings(sharedXml) : []
    return parseFirstRow(sheetXml, sharedStrings)
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

/**
 * Locate the End-of-Central-Directory record near the end of the
 * file, then walk the Central Directory entries. Returns null on any
 * structural problem.
 */
async function readCentralDirectory(handle: FileHandle, fileSize: number): Promise<CentralEntry[] | null> {
  const tailSize = Math.min(EOCD_SCAN_BYTES, fileSize)
  const tail = Buffer.alloc(tailSize)
  await handle.read(tail, 0, tailSize, fileSize - tailSize)

  // Scan backwards for the EOCD signature.
  let eocdOffset = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_END_OF_CENTRAL_DIR) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) return null

  const totalEntries = tail.readUInt16LE(eocdOffset + 10)
  const cdSize = tail.readUInt32LE(eocdOffset + 12)
  const cdOffset = tail.readUInt32LE(eocdOffset + 16)
  // ZIP64 sentinel — out of scope.
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) return null

  // Read the Central Directory itself.
  const cd = Buffer.alloc(cdSize)
  await handle.read(cd, 0, cdSize, cdOffset)

  const entries: CentralEntry[] = []
  let p = 0
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > cd.length) return null
    if (cd.readUInt32LE(p) !== SIG_CENTRAL_DIRECTORY) return null
    const compressionMethod = cd.readUInt16LE(p + 10)
    const compressedSize = cd.readUInt32LE(p + 20)
    const uncompressedSize = cd.readUInt32LE(p + 24)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    const localHeaderOffset = cd.readUInt32LE(p + 42)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) return null
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf-8")
    entries.push({ name, localHeaderOffset, compressionMethod, compressedSize, uncompressedSize })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * Read one entry from the ZIP: seek to its local file header, skip
 * the variable-length name+extra fields, read the compressed payload,
 * and inflate it. Returns null if the entry is too big, uses an
 * unsupported compression method, or fails to decompress.
 */
async function extractEntryAsText(handle: FileHandle, entry: CentralEntry): Promise<string | null> {
  if (entry.uncompressedSize > MAX_UNCOMPRESSED_BYTES) return null
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) return null // stored or deflated only

  // Read the local file header to learn the name+extra lengths there
  // (they can differ from the central-directory copy in theory).
  const lfh = Buffer.alloc(30)
  await handle.read(lfh, 0, 30, entry.localHeaderOffset)
  if (lfh.readUInt32LE(0) !== SIG_LOCAL_FILE_HEADER) return null
  const lfhNameLen = lfh.readUInt16LE(26)
  const lfhExtraLen = lfh.readUInt16LE(28)
  const dataOffset = entry.localHeaderOffset + 30 + lfhNameLen + lfhExtraLen

  const compressed = Buffer.alloc(entry.compressedSize)
  if (entry.compressedSize > 0) {
    await handle.read(compressed, 0, entry.compressedSize, dataOffset)
  }

  let raw: Buffer
  if (entry.compressionMethod === 0) {
    raw = compressed
  } else {
    try {
      raw = inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES })
    } catch {
      return null
    }
  }
  return raw.toString("utf-8")
}

// ── Tiny XML extraction (regex; we don't need a real parser) ───────
//
// We avoid pulling in an XML library. Two operations are all we need:
//   - From sharedStrings.xml, the ordered sequence of `<t>…</t>` (and
//     `<t xml:space="preserve">…</t>`) under each `<si>`.
//   - From sheet1.xml, the first `<row>…</row>`, and within it each
//     `<c r="A1" t="s">…</c>` cell. The cell value is either a
//     numeric `<v>N</v>` index into the shared-string table (when
//     `t="s"`) or an inline string in `<is><t>…</t></is>`.
//
// XLSX cells use a tightly constrained subset of XML — the writers
// emit predictable shapes. Regex parsing is brittle in general but
// adequate here, especially since we never write XML out.

/**
 * Parse the shared-strings table to an indexable array. Each `<si>`
 * element contributes one entry; the entry is the concatenation of
 * its `<t>` children (rich text broken into runs still flattens to
 * a single string, which is what we want for a header label).
 */
function parseSharedStrings(xml: string): string[] {
  const result: string[] = []
  // Walk <si>…</si> blocks; inside each, gather all <t>…</t> text.
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
  let m: RegExpExecArray | null
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1]
    let combined = ""
    let tm: RegExpExecArray | null
    tRe.lastIndex = 0
    while ((tm = tRe.exec(inner)) !== null) {
      combined += decodeXmlEntities(tm[1])
    }
    result.push(combined)
    if (result.length > 100_000) break // sanity ceiling
  }
  return result
}

/**
 * Extract the first row's cell values from a sheet XML, resolving
 * shared-string indices against the supplied table. Returns null if
 * no row is found, an empty array if the row had no cells.
 */
function parseFirstRow(xml: string, shared: string[]): string[] | null {
  const rowMatch = /<row\b[^>]*>([\s\S]*?)<\/row>/.exec(xml)
  if (!rowMatch) return null
  const rowInner = rowMatch[1]
  // Each <c r="REF" t="TYPE">…</c>. t may be: "s" (shared string),
  // "str" (formula string), "inlineStr" (inline string), absent
  // (number), "b" (boolean). We only render textually.
  const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g
  const cells: string[] = []
  let m: RegExpExecArray | null
  while ((m = cellRe.exec(rowInner)) !== null) {
    const attrs = m[1]
    const inner = m[2]
    const tMatch = /\bt="([^"]+)"/.exec(attrs)
    const type = tMatch ? tMatch[1] : null
    const value = extractCellValue(type, inner, shared)
    cells.push(value)
    if (cells.length > MAX_COLUMNS) break
  }
  return cells
}

function extractCellValue(type: string | null, inner: string, shared: string[]): string {
  if (type === "s") {
    const v = /<v>([\s\S]*?)<\/v>/.exec(inner)
    if (!v) return ""
    const idx = Number.parseInt(v[1].trim(), 10)
    if (!Number.isFinite(idx) || idx < 0 || idx >= shared.length) return ""
    return shared[idx]
  }
  if (type === "inlineStr") {
    const ts: string[] = []
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let m: RegExpExecArray | null
    while ((m = tRe.exec(inner)) !== null) ts.push(decodeXmlEntities(m[1]))
    return ts.join("")
  }
  // Number, formula result, boolean, or untyped — fall through to <v>.
  const v = /<v>([\s\S]*?)<\/v>/.exec(inner)
  return v ? decodeXmlEntities(v[1].trim()) : ""
}

/**
 * Decode the five XML predefined entities. We don't see numeric
 * character references in XLSX cell text in practice; if a writer
 * does emit them, they pass through literally — acceptable for header
 * labels.
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}
