/**
 * Concurrency stress tests for the parallel ingest paths.
 *
 * These guard two empirical safety properties of the v0.0.6
 * bounded-parallel refactor:
 *
 *   (1) ingestCodeMap shares a single tree-sitter parser across
 *       16 concurrent tasks. The static-analysis claim is that
 *       the post-await synchronous block (setLanguage → parse →
 *       extract → upsertBySubject) runs atomically, so cross-task
 *       interleaving cannot mis-configure the parser for another
 *       task's source. We verify this empirically: an 8-file
 *       fixture with four different languages and distinctive
 *       per-language definition names is ingested in parallel,
 *       and every distinctive name must land in the file with
 *       the right extension. A leak — e.g. a Go signature
 *       extracted from a Python file because the parser was
 *       reconfigured mid-task — would fail loudly.
 *
 *   (2) mapConcurrent must return results in input order even
 *       under heavy parallelism, with no swaps and no drops.
 *       We construct 500 files each containing a marker derived
 *       from its own name, read them via mapConcurrent at
 *       width 32, and verify both that the count matches and
 *       that every position holds *its own* content.
 *
 * If tree-sitter wasm cannot load in this environment (CI runners
 * occasionally fail this), test (1) skips gracefully — the
 * unavailableReason is the diane-internal signal for that — and
 * test (2), which doesn't depend on tree-sitter, runs anyway.
 */

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises"
import { join, dirname, extname, sep, relative } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { MemoryRepository } from "../src/store/repository.js"
import { ingestCodeMap } from "../src/ingest/code-map.js"
import { mapConcurrent } from "../src/utils/concurrent.js"

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

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")

async function testSharedParserSafety(): Promise<void> {
  console.log("\n── concurrent code-map: shared-parser language safety ─")
  const root = await mkdtemp(join(tmpdir(), "diane-stress-codemap-"))
  try {
    // Four languages, two files each — eight files total, parsed
    // concurrently at CODE_MAP_CONCURRENCY = 16, so all eight enter
    // the parallel pool at once. Distinctive per-language names mean
    // any parser miscue would show up as a name landing in a wrong
    // file.
    const fixtures: Array<[string, string]> = [
      ["a.ts", "export function unique_TS_alpha() { return 1 }"],
      ["b.ts", "export function unique_TS_beta() { return 2 }"],
      ["c.py", "def unique_PY_gamma():\n    return 3\n"],
      ["d.py", "def unique_PY_delta():\n    return 4\n"],
      ["e.go", "package x\nfunc unique_GO_epsilon() int { return 5 }\n"],
      ["f.go", "package x\nfunc unique_GO_zeta() int { return 6 }\n"],
      ["g.rs", "pub fn unique_RS_eta() -> i32 { 7 }\n"],
      ["h.rs", "pub fn unique_RS_theta() -> i32 { 8 }\n"],
    ]
    for (const [name, src] of fixtures) await writeFile(join(root, name), src)

    const repo = await MemoryRepository.load(root)
    try {
      const result = await ingestCodeMap(repo, root, PACKAGE_DIR)

      if (result.unavailableReason) {
        console.log(`  ⊘ skip: tree-sitter unavailable (${result.unavailableReason})`)
        return
      }

      assert(result.filesParsed === 8, "all 8 files parsed under concurrency")

      const hits = repo.recall({ query: "unique", limit: 100 })
      const nameToSubject = new Map<string, string>()
      const expectedNames = [
        "unique_TS_alpha", "unique_TS_beta",
        "unique_PY_gamma", "unique_PY_delta",
        "unique_GO_epsilon", "unique_GO_zeta",
        "unique_RS_eta", "unique_RS_theta",
      ] as const
      for (const h of hits) {
        for (const name of expectedNames) {
          if (h.memory.content.includes(name)) nameToSubject.set(name, h.memory.subject)
        }
      }

      assert(
        nameToSubject.size === 8,
        `all 8 distinctive names extracted (found ${nameToSubject.size})`,
      )

      // The strict check: every name must appear ONLY in the file
      // of its own language. A language leak (parser miscue) would
      // surface here as, say, a Python `def` extracted from a `.go`
      // file (extractor would yield nothing) or — worse — as a Go
      // signature extracted from a `.py` file (parser was still
      // configured for Go when the Python task's parse ran).
      let leaks = 0
      for (const [name, subject] of nameToSubject) {
        const wantsExt =
          name.startsWith("unique_TS_") ? ".ts" :
          name.startsWith("unique_PY_") ? ".py" :
          name.startsWith("unique_GO_") ? ".go" : ".rs"
        if (!subject.endsWith(wantsExt)) {
          leaks += 1
          console.log(`    LEAK: ${name} surfaced in ${subject} (expected ${wantsExt})`)
        }
      }
      assert(leaks === 0, "no cross-language parser leaks under concurrent load")
    } finally {
      await repo.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function testMapConcurrentOrderUnderLoad(): Promise<void> {
  console.log("\n── mapConcurrent: 500-file in-order read at width=32 ─")
  const root = await mkdtemp(join(tmpdir(), "diane-stress-collect-"))
  try {
    const n = 500
    for (let i = 0; i < n; i++) {
      const dir = join(root, `d${Math.floor(i / 100)}`)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, `file${i}.txt`),
        `marker-line-for-${i}\nbody\n`,
      )
    }

    // Walk the tree to get the canonical path order. This
    // mirrors what the cross-refs collectFiles phase-1 walk does.
    const paths: string[] = []
    async function walk(dir: string): Promise<void> {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(join(dir, e.name))
        else if (e.isFile() && extname(e.name) === ".txt") paths.push(join(dir, e.name))
      }
    }
    await walk(root)
    assert(paths.length === n, `walked all ${n} files`)

    // The same kind of reader callback cross-refs uses.
    const reads = await mapConcurrent(paths, 32, async (abs) => {
      const content = await readFile(abs, "utf-8")
      const rel = relative(root, abs).split(sep).join("/")
      return { abs, rel, content }
    })

    assert(reads.length === n, `mapConcurrent returned all ${n} results`)

    let swaps = 0
    let contentMismatches = 0
    for (let i = 0; i < n; i++) {
      if (reads[i].abs !== paths[i]) swaps += 1
      // The marker line encodes the file's own identity. A swap or a
      // shared buffer would surface as the wrong number here.
      const fname = reads[i].abs.split("/").pop() ?? ""
      const fileIndex = fname.replace("file", "").replace(".txt", "")
      const expectedMarker = `marker-line-for-${fileIndex}`
      if (!reads[i].content.startsWith(expectedMarker)) contentMismatches += 1
    }
    assert(swaps === 0, "no position swaps in 500-file parallel read")
    assert(contentMismatches === 0, "every result holds its own file's content")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await testSharedParserSafety()
  await testMapConcurrentOrderUnderLoad()

  console.log("\n── summary ──────────────────────────────────────────────")
  if (failed > 0) {
    console.log(`  ${passed} passed, ${failed} failed`)
    for (const f of failures) console.log(`    ✗ ${f}`)
    process.exit(1)
  }
  console.log(`  ${passed} passed, 0 failed`)
}

await main()
