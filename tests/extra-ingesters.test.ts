/**
 * extra-ingesters.test.ts — pins the behaviour of the two compact
 * v0.0.4 ingesters that share a test harness style (one fixture each,
 * a small set of assertions).
 *
 *   - project-notes: picks up AGENTS.md / CLAUDE.md / .cursorrules /
 *     etc., emits one memory per file + one directory-summary memory,
 *     truncates oversized notes, and is a no-op when none are present.
 *   - tables: reads first-row column headers from .csv and .tsv,
 *     ignores file extensions outside that set, handles quoted CSV
 *     fields, rejects single-column files (not tables), rejects
 *     binary files, never loads row data.
 */

import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ingestProjectNotes } from "../src/ingest/project-notes.js"
import { ingestTableHeaders } from "../src/ingest/tables.js"
import { MemoryRepository } from "../src/store/repository.js"

let passed = 0
let failed = 0
const failures: string[] = []
function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

async function withRepo<T>(root: string, fn: (repo: MemoryRepository) => Promise<T>): Promise<T> {
  const repo = await MemoryRepository.load(root)
  try { return await fn(repo) } finally { await repo.close() }
}

async function main(): Promise<void> {

  // ── project-notes ────────────────────────────────────────────────
  console.log("── project-notes ingester ─────────────────────────────────")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-notes-"))
    await writeFile(join(root, "AGENTS.md"), "Always use bun, never npm.\nRun `bun test` before committing.", "utf-8")
    await writeFile(join(root, "CLAUDE.md"), "When editing, preserve existing comments.", "utf-8")
    await writeFile(join(root, ".cursorrules"), "Prefer functional over OO.", "utf-8")
    // An oversized file to verify truncation.
    await writeFile(join(root, "CONVENTIONS.md"), "x".repeat(20_000), "utf-8")
    try {
      await withRepo(root, async (repo) => {
        const res = await ingestProjectNotes(repo, root)
        assert(res.filesFound === 4, `found all 4 instruction files (got ${res.filesFound})`)

        const mems = repo.allMemories().filter((m) => m.source === "project-notes-ingest")
        // 4 file memories + 1 directory summary = 5
        assert(mems.length === 5, `5 memories total (4 files + 1 summary; got ${mems.length})`)

        const subjects = mems.map((m) => m.subject)
        assert(subjects.includes("agent-instructions:AGENTS.md"), "AGENTS.md entry present")
        assert(subjects.includes("agent-instructions:CLAUDE.md"), "CLAUDE.md entry present")
        assert(subjects.includes("agent-instructions:.cursorrules"), ".cursorrules entry present")
        assert(subjects.includes("agent-instructions:directory"), "summary 'directory' entry present")

        const agentsMem = mems.find((m) => m.subject === "agent-instructions:AGENTS.md")!
        assert(agentsMem.content.includes("Always use bun"), "AGENTS.md content preserved")
        assert(agentsMem.tags.includes("opencode"), "AGENTS.md carries 'opencode' tag")
        assert(agentsMem.tags.includes("agent-instructions"), "AGENTS.md carries 'agent-instructions' tag")

        const big = mems.find((m) => m.subject === "agent-instructions:CONVENTIONS.md")!
        assert(big.content.length < 20_000, "oversized note is truncated")
        assert(big.content.includes("[truncated"), "truncated note carries a [truncated…] marker")

        const summary = mems.find((m) => m.subject === "agent-instructions:directory")!
        assert(
          summary.content.includes("AGENTS.md") && summary.content.includes(".cursorrules"),
          "directory-summary lists every found file by name",
        )
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  // No instruction files → no-op (no summary either).
  {
    const root = await mkdtemp(join(tmpdir(), "diane-notes-empty-"))
    try {
      await withRepo(root, async (repo) => {
        const res = await ingestProjectNotes(repo, root)
        assert(res.filesFound === 0, "no files found → returns 0")
        const mems = repo.allMemories().filter((m) => m.source === "project-notes-ingest")
        assert(mems.length === 0, "no files → no summary either; ingester is a clean no-op")
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  // ── tables ───────────────────────────────────────────────────────
  console.log("")
  console.log("── tables ingester ───────────────────────────────────────")
  {
    const root = await mkdtemp(join(tmpdir(), "diane-tables-"))
    await mkdir(join(root, "data"), { recursive: true })
    await mkdir(join(root, "node_modules/csv-junk"), { recursive: true })

    // Plain CSV.
    await writeFile(
      join(root, "data/users.csv"),
      `id,email,signup_date,plan_tier\n1,a@b.c,2025-01-01,pro\n2,d@e.f,2025-01-02,free\n`,
      "utf-8",
    )
    // TSV.
    await writeFile(
      join(root, "data/events.tsv"),
      `event_id\tuser_id\toccurred_at\tpayload\n1\t1\t2025-01-01\t{}\n`,
      "utf-8",
    )
    // CSV with quoted fields (header contains a comma inside a quoted column name).
    await writeFile(
      join(root, "data/quoted.csv"),
      `"id","name, with comma","date"\n1,"Alice, A.",2025\n`,
      "utf-8",
    )
    // Single-column "CSV" — not a table; should be rejected.
    await writeFile(join(root, "data/loglines.csv"), `some free-form text\nmore text\n`, "utf-8")
    // node_modules CSV — must be skipped.
    await writeFile(join(root, "node_modules/csv-junk/inside.csv"), `a,b,c\n1,2,3\n`, "utf-8")
    // A binary file masquerading as .csv (early NUL byte).
    await writeFile(join(root, "data/binary.csv"), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02, 0x03]))
    // Unrelated extension — should be ignored.
    await writeFile(join(root, "data/notes.txt"), `not a table`, "utf-8")

    try {
      await withRepo(root, async (repo) => {
        const res = await ingestTableHeaders(repo, root)
        assert(res.filesFound === 3, `picks up CSV + TSV + quoted-CSV, skips single-col/binary/node_modules (got ${res.filesFound})`)
        assert(
          res.formatsSupported.includes("csv") && res.formatsSupported.includes("tsv"),
          "formatsSupported lists csv + tsv (XLS/XLSX intentionally absent — deferred)",
        )

        const mems = repo.allMemories().filter((m) => m.source === "tables-ingest")
        const subjects = mems.map((m) => m.subject)
        assert(subjects.includes("table:data/users.csv"), "users.csv ingested")
        assert(subjects.includes("table:data/events.tsv"), "events.tsv ingested")
        assert(subjects.includes("table:data/quoted.csv"), "quoted.csv ingested")

        const users = mems.find((m) => m.subject === "table:data/users.csv")!
        assert(users.content.includes("id, email, signup_date, plan_tier"), "users.csv columns listed")
        assert(users.content.includes("CSV, 4 columns"), "users.csv: format + column count")
        assert(users.tags.includes("table") && users.tags.includes("schema"), "carries 'table' and 'schema' tags")
        assert(
          !users.content.includes("a@b.c"),
          "row data is NEVER loaded — only the header",
        )

        const quoted = mems.find((m) => m.subject === "table:data/quoted.csv")!
        assert(
          quoted.content.includes("name, with comma"),
          "quoted CSV: embedded-comma column name extracted intact (RFC-4180-ish parsing)",
        )

        // Negative assertions.
        assert(!subjects.includes("table:data/loglines.csv"), "single-column 'CSV' rejected")
        assert(!subjects.includes("table:data/binary.csv"), "binary file rejected on NUL byte")
        assert(
          !subjects.some((s) => s.includes("node_modules")),
          "node_modules CSV skipped",
        )

        // Lazy-import contract: with NO spreadsheets in the fixture,
        // `formatsSupported` must NOT include xlsx/xls. The loader was
        // never invoked; SheetJS was never imported. This is the
        // whole point of the lazy design — repos with no spreadsheets
        // pay zero module-load cost.
        assert(
          !res.formatsSupported.includes("xlsx") && !res.formatsSupported.includes("xls"),
          "lazy: no spreadsheets present → SheetJS never loaded → xlsx absent from formatsSupported",
        )
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  // ── XLSX (SheetJS, lazy import) ──────────────────────────────────
  // Build a real workbook on disk with two sheets, each with a distinct
  // header row, and verify both are surfaced as separate memories.
  // Also verify a row-only file is not somehow extracted into row 2
  // (we MUST only read row 1).
  console.log("")
  console.log("── tables ingester: XLSX (lazy SheetJS) ──────────────────")
  {
    const xlsx: any = await import("xlsx")
    const root = await mkdtemp(join(tmpdir(), "diane-xlsx-"))
    await mkdir(join(root, "data"), { recursive: true })

    // Two-sheet workbook: "Users" + "Events". Row 2 onwards contains
    // data we should NEVER index.
    const wb = xlsx.utils.book_new()
    const users = xlsx.utils.aoa_to_sheet([
      ["user_id", "email", "signup_date", "plan_tier"],
      [1, "a@b.c", "2025-01-01", "pro"], // row 2 must NOT appear in memory
      [2, "d@e.f", "2025-01-02", "free"],
    ])
    xlsx.utils.book_append_sheet(wb, users, "Users")
    const events = xlsx.utils.aoa_to_sheet([
      ["event_id", "user_id", "occurred_at", "payload"],
      [1, 1, "2025-01-01", "{}"],
    ])
    xlsx.utils.book_append_sheet(wb, events, "Events")
    xlsx.writeFile(wb, join(root, "data/analytics.xlsx"))

    // A second, single-sheet workbook with a stray short row — should
    // be rejected (the <2 column filter applies per-sheet too).
    const lonely = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(lonely, xlsx.utils.aoa_to_sheet([["just_one_column"], [1], [2]]), "Solo")
    xlsx.writeFile(lonely, join(root, "data/lonely.xlsx"))

    try {
      await withRepo(root, async (repo) => {
        const res = await ingestTableHeaders(repo, root)

        assert(res.filesFound === 1, `analytics.xlsx counted once; lonely.xlsx rejected (got filesFound=${res.filesFound})`)
        assert(
          res.formatsSupported.includes("xlsx"),
          `formatsSupported now includes xlsx (got ${JSON.stringify(res.formatsSupported)})`,
        )
        assert(
          !res.xlsxUnavailableReason,
          `xlsxUnavailableReason is unset when SheetJS loaded (got ${res.xlsxUnavailableReason ?? "undefined"})`,
        )

        const mems = repo.allMemories().filter((m) => m.source === "tables-ingest")
        const subjects = mems.map((m) => m.subject)
        assert(subjects.includes("table:data/analytics.xlsx#users"), "Users sheet → its own memory (subject fragment matches slug)")
        assert(subjects.includes("table:data/analytics.xlsx#events"), "Events sheet → its own memory")

        const usersMem = mems.find((m) => m.subject === "table:data/analytics.xlsx#users")!
        assert(usersMem.content.includes("user_id, email, signup_date, plan_tier"), "Users headers correctly extracted from row 1")
        assert(usersMem.content.includes("sheet \"Users\""), "memory content names the sheet explicitly")
        assert(usersMem.content.includes("XLSX, 4 columns"), "memory content includes format + column count")
        assert(usersMem.tags.includes("sheet"), "spreadsheet memory carries the 'sheet' tag (distinguishes from CSV)")
        assert(
          !usersMem.content.includes("a@b.c") && !usersMem.content.includes("2025-01-01"),
          "row 2+ data is NEVER ingested — only row 1 headers",
        )

        // lonely.xlsx: single-column Solo sheet → rejected by the
        // per-sheet <2 column filter.
        assert(
          !subjects.some((s) => s.startsWith("table:data/lonely.xlsx")),
          "single-column sheet inside an XLSX is rejected (per-sheet, not just per-file)",
        )
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  console.log("")
  console.log("──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

main().catch((err) => { console.error(err); process.exit(2) })
