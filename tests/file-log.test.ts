import { readFileSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"

import { createFileLogger, richLogsDir, truncateForLog } from "../src/utils/file-log.js"

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  ✗ ${label}`)
  }
}

/**
 * Read all JSON-Lines from a file, parsing each. Throws on the first
 * malformed line — the whole point of JSONL is one record per line, so
 * a malformed line is a test failure.
 */
function readJsonl(path: string): Array<Record<string, unknown>> {
  const text = readFileSync(path, "utf-8")
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/**
 * With synchronous writes (openSync + writeSync) the file is durable
 * the moment `log`/`event` returns — no waiting on a stream flush.
 * Kept as a no-op so the test reads naturally as "do work, then read
 * back what was written." If we ever switched back to buffered I/O,
 * this becomes the place to await a flush.
 */
async function flushTick(): Promise<void> {
  /* no-op; sync writes are durable on return */
}

async function main(): Promise<void> {
  // ── basic write + readback ────────────────────────────────────────
  console.log("\n── file-log: basic write + readback ──────────────────────")
  const lg = createFileLogger({ service: "test-fl", base: { root: "/fake/root", run: "t1" } })

  // Path must land in os.tmpdir()/opencode-diane/ and have the right shape.
  assert(lg.path().startsWith(richLogsDir()), "log file is under tmpdir()/opencode-diane/")
  assert(dirname(lg.path()) === richLogsDir(), "log file is directly in the rich-logs dir")
  assert(lg.path().endsWith(".jsonl"), "log file has .jsonl extension")
  assert(
    lg.path().includes(`pid${process.pid}`),
    "log filename embeds the current pid for per-process uniqueness"
  )
  assert(existsSync(lg.path()), "log file exists on disk after construction")

  lg.log("info", "hello world")
  lg.log("warn", "something interesting")
  lg.event("custom.thing", { count: 42, name: "answer" })
  lg.close()
  await flushTick()

  const recs = readJsonl(lg.path())
  // Header (session.start) + 2 log() lines + 1 event() = 4 records.
  assert(recs.length === 4, `wrote 4 records (got ${recs.length})`)

  // Every record must carry the service + base fields + a ts.
  for (const r of recs) {
    assert(typeof r.ts === "string", "record has a ts timestamp")
    assert(r.service === "test-fl", "record carries service name")
    assert(r.root === "/fake/root", "record carries base.root")
    assert(r.run === "t1", "record carries base.run")
  }

  // ── header record ─────────────────────────────────────────────────
  console.log("\n── file-log: header (session.start) ──────────────────────")
  assert(recs[0].event === "session.start", "first record is the session.start header")
  assert(recs[0].pid === process.pid, "header includes pid")
  assert(typeof recs[0].node === "string" && (recs[0].node as string).startsWith("v"), "header includes node version")
  assert(typeof recs[0].platform === "string", "header includes platform")
  assert(typeof recs[0].cwd === "string", "header includes cwd")

  // ── log() record shape ────────────────────────────────────────────
  console.log("\n── file-log: log() records ───────────────────────────────")
  assert(recs[1].level === "info" && recs[1].message === "hello world", "log(info, ...) shape")
  assert(recs[2].level === "warn" && recs[2].message === "something interesting", "log(warn, ...) shape")
  assert(recs[1].event === undefined, "log records don't carry an event field")

  // ── event() record shape ──────────────────────────────────────────
  console.log("\n── file-log: event() records ─────────────────────────────")
  assert(recs[3].event === "custom.thing", "event name lands in `event` field")
  assert(recs[3].count === 42, "event payload field copied through")
  assert(recs[3].name === "answer", "event payload field copied through")
  assert(recs[3].level === undefined, "event records don't carry a level")

  // Cleanup — don't leave debug files behind from a passing test.
  unlinkSync(lg.path())

  // ── per-session isolation ─────────────────────────────────────────
  console.log("\n── file-log: per-session isolation ───────────────────────")
  const a = createFileLogger({ service: "iso-a" })
  const b = createFileLogger({ service: "iso-b" })
  // The pid is the same in tests (single process), but the service
  // name + the ms-precise timestamp + a small sleep would normally
  // make them different. The contract we care about: TWO loggers
  // never collide on path within a process.
  assert(a.path() !== b.path(), "two loggers in the same process get distinct paths")
  a.log("info", "from a")
  b.log("info", "from b")
  a.close()
  b.close()
  await flushTick()
  // A's file must not contain B's content and vice versa.
  const aText = readFileSync(a.path(), "utf-8")
  const bText = readFileSync(b.path(), "utf-8")
  assert(aText.includes("from a") && !aText.includes("from b"), "logger a's file is isolated")
  assert(bText.includes("from b") && !bText.includes("from a"), "logger b's file is isolated")
  unlinkSync(a.path())
  unlinkSync(b.path())

  // ── unserialisable payload doesn't crash ──────────────────────────
  console.log("\n── file-log: failure tolerance ───────────────────────────")
  const lg2 = createFileLogger({ service: "test-fl-bad" })
  const circular: Record<string, unknown> = { name: "loop" }
  circular.self = circular
  // Must not throw — the whole point of the failure model is that
  // logging never takes down the host. JSON.stringify on a circular
  // reference would normally throw; the logger swallows it and writes
  // a fallback `log.write_failed` record.
  let threw = false
  try {
    lg2.event("attempted.write", circular)
  } catch {
    threw = true
  }
  assert(!threw, "circular payload doesn't throw")
  // Try BigInt too — also un-JSON-able.
  threw = false
  try {
    lg2.event("attempted.bigint", { big: BigInt(1) as unknown as number })
  } catch {
    threw = true
  }
  assert(!threw, "BigInt payload doesn't throw")
  lg2.close()
  await flushTick()
  // The two attempted writes should have produced fallback records so
  // we don't silently lose every event that happens to be unserialisable.
  const bad = readJsonl(lg2.path())
  const failures2 = bad.filter((r) => r.event === "log.write_failed")
  assert(failures2.length === 2, `got 2 fallback log.write_failed records (got ${failures2.length})`)
  unlinkSync(lg2.path())

  // ── direct file shape check (JSONL parseability of every line) ────
  console.log("\n── file-log: JSONL invariant ─────────────────────────────")
  const lg3 = createFileLogger({ service: "test-fl-jsonl" })
  for (let i = 0; i < 100; i++) lg3.event("burst", { i, marker: `m-${i}` })
  lg3.close()
  await flushTick()
  const all = readFileSync(lg3.path(), "utf-8").split("\n").filter(Boolean)
  let allParsed = true
  for (const line of all) {
    try {
      JSON.parse(line)
    } catch {
      allParsed = false
      break
    }
  }
  assert(allParsed, "every line in the file is independently valid JSON")
  assert(all.length === 101, `100 events + 1 header = 101 lines (got ${all.length})`)
  unlinkSync(lg3.path())

  // ── richLogsDir() identity ────────────────────────────────────────
  console.log("\n── file-log: richLogsDir() ───────────────────────────────")
  assert(richLogsDir() === join(tmpdir(), "opencode-diane"), "richLogsDir() == tmpdir()/opencode-diane")

  // ── truncateForLog ────────────────────────────────────────────────
  console.log("\n── file-log: truncateForLog ──────────────────────────────")
  // Short strings passthrough untouched.
  assert(truncateForLog("hi") === "hi", "short string passes through")
  // Long strings get cut with a marker so a reader sees truncation happened.
  const longString = "a".repeat(1000)
  const truncated = truncateForLog(longString, 500)
  assert(typeof truncated === "string" && (truncated as string).startsWith("aaaa"), "long string truncated keeps the prefix")
  assert((truncated as string).includes("…(+500 chars)"), "truncation marker preserved")
  assert((truncated as string).length < 1000, "result shorter than original")
  // Numbers, booleans, null pass through.
  assert(truncateForLog(42) === 42, "number passes through")
  assert(truncateForLog(true) === true, "boolean passes through")
  assert(truncateForLog(null) === null, "null passes through")
  // Arrays: cap at 20 + marker; element-wise truncation applies.
  const bigArr = Array.from({ length: 25 }, (_, i) => `item-${i}`)
  const truncArr = truncateForLog(bigArr) as unknown[]
  assert(Array.isArray(truncArr) && truncArr.length === 21, "array capped at 20 items + marker (21 total)")
  assert(truncArr[20] === "…(+5 items)", "array overflow marker present")
  // Nested objects truncated recursively.
  const obj = { q: longString, n: 1, tags: ["a", "b"], nested: { x: longString } }
  const truncObj = truncateForLog(obj) as Record<string, unknown>
  assert(typeof truncObj.q === "string" && (truncObj.q as string).includes("…(+"), "object string field truncated")
  assert(truncObj.n === 1, "object number field preserved")
  assert(Array.isArray(truncObj.tags) && (truncObj.tags as unknown[]).length === 2, "small array preserved")
  assert(
    typeof (truncObj.nested as Record<string, unknown>).x === "string" &&
      ((truncObj.nested as Record<string, unknown>).x as string).includes("…(+"),
    "nested object string truncated"
  )
  // Doesn't mutate the input.
  assert(obj.q.length === 1000, "input object unchanged after truncation")
  assert(obj.nested.x.length === 1000, "nested input field unchanged after truncation")
  // Custom maxStringLength.
  assert(typeof truncateForLog("hello world", 5) === "string", "respects custom max length")
  assert(truncateForLog("hello world", 5) === "hello…(+6 chars)", "custom max truncates to N chars")

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
