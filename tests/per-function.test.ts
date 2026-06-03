/**
 * per-function.test.ts — per-function chunking + max-pool scoring.
 *
 * Script-style; run with: bun run tests/per-function.test.ts
 */

import {
  buildFunctionChunks,
  maxPoolByMemory,
  rerankWindowByScore,
  type ScoredChunk,
} from "../src/search/per-function.js"

let passed = 0
let failed = 0
const failures: string[] = []
function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

async function main(): Promise<void> {
  console.log("\n── buildFunctionChunks ───────────────────────────────────")
  {
    const src = [
      "import os",
      "def resolve_redirects(self, resp):",
      "    strip = True",
      "    return strip",
      "class CaseInsensitiveDict:",
      "    def __init__(self):",
      "        self._store = {}",
    ].join("\n")
    const chunks = buildFunctionChunks("m1", "requests/sessions.py", src, [
      { name: "resolve_redirects", startLine: 2, endLine: 4 },
      { name: "CaseInsensitiveDict", startLine: 5, endLine: 7 },
    ])
    assert(chunks.length === 2, "one chunk per definition span")
    assert(chunks[0].memoryId === "m1", "chunk carries its memory id")
    assert(
      chunks[0].text.includes("requests/sessions.py resolve_redirects"),
      "chunk is prefixed with file path + symbol name"
    )
    assert(chunks[0].text.includes("strip = True"), "chunk includes the definition body")
    assert(
      !chunks[0].text.includes("CaseInsensitiveDict"),
      "a chunk spans only its own definition, not the whole file"
    )
    assert(chunks[1].text.includes("CaseInsensitiveDict"), "second chunk is the second definition")
  }

  {
    const chunks = buildFunctionChunks("m2", "a/b.py", "x = 1\ny = 2", [])
    assert(chunks.length === 1, "no spans -> single whole-file fallback chunk")
    assert(chunks[0].text.includes("a/b.py") && chunks[0].text.includes("x = 1"), "fallback keeps file context")
  }

  {
    const body = Array.from({ length: 100 }, (_, i) => `    line${i}`).join("\n")
    const src = `def big():\n${body}`
    const chunks = buildFunctionChunks("m3", "f.py", src, [{ name: "big", startLine: 1, endLine: 101 }], {
      maxBodyLines: 5,
    })
    assert(chunks[0].text.split("\n").length <= 6, "body is capped at maxBodyLines (+ header)")
  }

  console.log("\n── maxPoolByMemory ───────────────────────────────────────")
  {
    const scored: ScoredChunk[] = [
      { memoryId: "fileA", score: 0.20 },
      { memoryId: "fileA", score: 0.91 },
      { memoryId: "fileA", score: 0.15 },
      { memoryId: "fileB", score: 0.40 },
      { memoryId: "fileB", score: 0.42 },
    ]
    const ranked = maxPoolByMemory(scored)
    assert(
      ranked.map((r) => r.id).join(",") === "fileA,fileB",
      "a memory scores as its single best chunk, ranked by that max"
    )
    assert(Math.abs(ranked[0].score - 0.91) < 1e-6, "fileA max is 0.91")
    assert(Math.abs(ranked[1].score - 0.42) < 1e-6, "fileB max is 0.42")
  }

  {
    const scored: ScoredChunk[] = [
      { memoryId: "x", score: 0.7 },
      { memoryId: "y", score: 0.3 },
      { memoryId: "z", score: 0.5 },
    ]
    const ranked = maxPoolByMemory(scored)
    assert(
      ranked.map((r) => r.id).join(",") === "x,z,y",
      "one chunk per memory is an identity ranking (backward-compatible)"
    )
  }

  assert(maxPoolByMemory([]).length === 0, "empty input -> empty output")

  console.log("\n── rerankWindowByScore (R@1 lever, R@5-safe) ─────────────")
  {
    type H = { f: string; file: boolean }
    const order: H[] = [
      { f: "a.py", file: true },
      { f: "b.py", file: true },
      { f: "c.py", file: true },
      { f: "d.py", file: true },
      { f: "e.py", file: true },
    ]
    const sc: Record<string, number> = { "a.py": 0.1, "b.py": 0.9, "c.py": 0.3, "d.py": 0.8, "e.py": 0.7 }
    const out = rerankWindowByScore(order, 3, (h) => h.file, (h) => sc[h.f])
    assert(out.slice(0, 3).map((h) => h.f).join(",") === "b.py,c.py,a.py", "top-3 reordered by score desc")
    assert(out[3].f === "d.py" && out[4].f === "e.py", "positions past the window are untouched")
    // R@5-safety: the top-5 SET is identical (only top-3 permuted)
    const before = new Set(order.slice(0, 5).map((h) => h.f))
    const after = new Set(out.slice(0, 5).map((h) => h.f))
    assert([...before].every((x) => after.has(x)) && before.size === after.size, "top-5 set preserved (cannot reduce Recall@5)")
  }
  {
    // non-file items in the window keep their slot
    type H = { f: string; file: boolean }
    const order: H[] = [
      { f: "code.py", file: true },
      { f: "churn:x.py", file: false },
      { f: "other.py", file: true },
    ]
    const sc: Record<string, number> = { "code.py": 0.2, "other.py": 0.9 }
    const out = rerankWindowByScore(order, 3, (h) => h.file, (h) => sc[h.f])
    assert(out[1].f === "churn:x.py", "non-candidate keeps its position")
    assert(out[0].f === "other.py" && out[2].f === "code.py", "only candidate positions are permuted")
  }
  {
    // fewer than 2 scorable candidates -> unchanged
    type H = { f: string; file: boolean }
    const order: H[] = [{ f: "a.py", file: true }, { f: "b.py", file: true }]
    const out = rerankWindowByScore(order, 3, (h) => h.file, (h) => (h.f === "a.py" ? 0.5 : undefined))
    assert(out.map((h) => h.f).join(",") === "a.py,b.py", "single scorable candidate leaves order unchanged")
  }

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
