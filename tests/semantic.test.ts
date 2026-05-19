/**
 * semantic.test.ts — tests for the opt-in cross-lingual semantic
 * search: the vector math, reciprocal-rank fusion, the vector store,
 * the opt-in gating (no regression when off), and end-to-end
 * cross-lingual retrieval across Russian / English / Chinese.
 *
 * Why a stub instead of the real e5 model: the cross-lingual *quality*
 * is a property of the e5 model (Microsoft's), benchmarked by its
 * authors — not something this repo's CI should re-prove by
 * downloading a 100 MB model on every run. What this suite proves is
 * that DIANE'S pipeline — vector store, RRF fusion, the recall path —
 * correctly surfaces a cross-lingual match GIVEN an embedder that
 * places the three languages in a shared space. `ConceptStubEmbedder`
 * is exactly that: a deterministic embedder with a built-in trilingual
 * concept lexicon, implementing the real `Embedder` interface. The
 * real e5 model is exercised separately by `scripts/verify-semantic.mjs`.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { MemoryRepository } from "../src/store/repository.js"
import { VectorStore } from "../src/store/vector-store.js"
import { embedMissingMemories } from "../src/search/embed-pass.js"
import {
  cosineSimilarity,
  dot,
  normalize,
  reciprocalRankFusion,
  type Embedder,
} from "../src/search/embedder.js"

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

/**
 * A deterministic, dependency-free stand-in for a multilingual
 * embedding model. It carries a small concept lexicon whose synonyms
 * span Russian, English and Chinese (Russian entries are stems, to
 * absorb inflection). Text is embedded as a normalised bag-of-concepts
 * vector — so "user", "пользователь" and "用户" all land on the same
 * axis. That is cross-lingual *by construction*: precisely the
 * property the real e5 model provides, with none of the download.
 */
class ConceptStubEmbedder implements Embedder {
  readonly id = "stub/concept-trilingual"
  private static readonly CONCEPTS: string[][] = [
    ["user", "пользовател", "用户"],
    ["auth", "login", "session", "credential", "аутентифик", "сесси", "认证", "登录"],
    ["database", "数据库", "база данных", "баз данных", "данных"],
    ["cache", "缓存", "кэш"],
    ["config", "配置", "конфигурац", "настройк"],
    ["parse", "parsing", "解析", "разбор", "парс"],
    ["file", "文件", "файл"],
    ["network", "connection", "网络", "连接", "сет", "соединени"],
    ["error", "错误", "ошибк"],
  ]

  private vector(text: string): Float32Array {
    const lower = text.toLowerCase()
    const v = new Float32Array(ConceptStubEmbedder.CONCEPTS.length)
    ConceptStubEmbedder.CONCEPTS.forEach((syns, i) => {
      if (syns.some((s) => lower.includes(s))) v[i] = 1
    })
    return normalize(v)
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.vector(text)
  }
  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.vector(t))
  }
}

async function main(): Promise<void> {
  // ── vector math ────────────────────────────────────────────────────
  console.log("\n── semantic: vector math ─────────────────────────────────")
  const a = Float32Array.from([3, 4])
  assert(Math.abs(cosineSimilarity(a, a) - 1) < 1e-6, "cosine of a vector with itself is 1")
  assert(
    Math.abs(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))) < 1e-6,
    "cosine of orthogonal vectors is 0"
  )
  assert(
    cosineSimilarity(Float32Array.from([1, 2, 3]), Float32Array.from([1, 2])) === 0,
    "length mismatch yields 0, not NaN"
  )
  const n = normalize(Float32Array.from([3, 4]))
  assert(Math.abs(Math.hypot(n[0], n[1]) - 1) < 1e-6, "normalize produces a unit vector")
  const u1 = normalize(Float32Array.from([2, 1, 0]))
  const u2 = normalize(Float32Array.from([1, 3, 1]))
  assert(
    Math.abs(dot(u1, u2) - cosineSimilarity(u1, u2)) < 1e-6,
    "dot product equals cosine for normalised vectors"
  )

  // ── reciprocal-rank fusion ─────────────────────────────────────────
  console.log("\n── semantic: reciprocal-rank fusion ──────────────────────")
  const fusedBoth = reciprocalRankFusion([
    ["a", "b", "c"],
    ["b", "d", "a"],
  ])
  assert(fusedBoth[0].id === "b", "an item ranked high in both lists wins the fusion")
  assert(
    fusedBoth.some((f) => f.id === "d"),
    "an item present in only one list still appears in the fused result"
  )
  // The cross-modal point: a doc the lexical list misses entirely but
  // the vector list ranks #1 must still surface near the top.
  const crossModal = reciprocalRankFusion([
    ["lex1", "lex2", "lex3", "lex4"],
    ["vec_only", "lex1"],
  ])
  assert(
    crossModal[0].id === "vec_only" || crossModal[1].id === "vec_only",
    "a vector-only top hit surfaces high after fusion"
  )
  assert(reciprocalRankFusion([]).length === 0, "fusing nothing yields nothing")

  // ── vector store ───────────────────────────────────────────────────
  console.log("\n── semantic: vector store ────────────────────────────────")
  const vsRoot = await mkdtemp(join(tmpdir(), "diane-vec-"))
  {
    const vs = VectorStore.open(vsRoot, "stub/concept-trilingual")
    vs.putMany([
      { id: "m1", vec: Float32Array.from([1, 0, 0]) },
      { id: "m2", vec: Float32Array.from([0, 1, 0]) },
      { id: "m3", vec: Float32Array.from([0, 0, 1]) },
    ])
    assert(vs.size() === 3, "putMany stores every vector")
    assert(vs.has("m2") && !vs.has("mX"), "has() reflects what is stored")
    assert(
      vs.missing(["m1", "m2", "mX", "mY"]).sort().join(",") === "mX,mY",
      "missing() lists exactly the ids without a vector"
    )
    const top = vs.search(Float32Array.from([0.9, 0.1, 0]), 2)
    assert(top.length === 2 && top[0].id === "m1", "search ranks the nearest vector first")
    assert(
      vs.search(Float32Array.from([1, 0]), 3).length === 0,
      "a dimension-mismatched query returns nothing, not a throw"
    )
    const pruned = vs.prune(new Set(["m1", "m3"]))
    assert(pruned === 1 && !vs.has("m2"), "prune drops vectors whose id is no longer valid")
    vs.close()
  }
  {
    // Persistence: a fresh open of the same store sees the saved vectors.
    const reopened = VectorStore.open(vsRoot, "stub/concept-trilingual")
    assert(reopened.size() === 2, "vectors persist across a close + reopen")
    assert(reopened.has("m1") && reopened.has("m3"), "the surviving ids are the right ones")
    reopened.close()
  }
  {
    // Model change: vectors from a different model are not comparable,
    // so opening under a new model id discards them.
    const swapped = VectorStore.open(vsRoot, "some/other-model")
    assert(swapped.size() === 0, "changing the embedding model drops the stale vector cache")
    swapped.close()
  }
  await rm(vsRoot, { recursive: true, force: true })

  // ── gating: no vector store ⇒ pure lexical, unchanged ──────────────
  console.log("\n── semantic: gating (off ⇒ no behaviour change) ──────────")
  const gateRoot = await mkdtemp(join(tmpdir(), "diane-gate-"))
  {
    const repo = await MemoryRepository.load(gateRoot)
    repo.insert({
      category: "project-facts",
      subject: "readme.md",
      content: "the build uses a Makefile and a CI workflow",
      source: "test",
    })
    // No vector store attached. A queryVector is supplied anyway — the
    // recall must ignore it and take the unchanged lexical path.
    const withVec = repo.recall({
      query: "build",
      queryVector: Float32Array.from([1, 0, 0]),
      limit: 5,
    })
    const withoutVec = repo.recall({ query: "build", limit: 5 })
    assert(
      withVec.length === withoutVec.length &&
        withVec.every((h, i) => h.memory.id === withoutVec[i]?.memory.id),
      "with no vector store, a queryVector changes nothing — recall stays purely lexical"
    )
  }
  await rm(gateRoot, { recursive: true, force: true })

  // ── graceful degradation: vector store attached but empty ──────────
  console.log("\n── semantic: graceful degradation (empty index) ──────────")
  const degRoot = await mkdtemp(join(tmpdir(), "diane-deg-"))
  {
    const repo = await MemoryRepository.load(degRoot)
    repo.insert({
      category: "project-facts",
      subject: "api.ts",
      content: "exports the public API surface",
      source: "test",
    })
    const vs = VectorStore.open(degRoot, "stub/concept-trilingual")
    repo.attachVectorStore(vs) // attached, but the embedding pass has not run
    const hits = repo.recall({
      query: "api",
      queryVector: Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0]),
      limit: 5,
    })
    assert(
      hits.length === 1 && hits[0].memory.subject === "api.ts",
      "recall still works before the embedding pass has populated any vectors"
    )
    vs.close()
  }
  await rm(degRoot, { recursive: true, force: true })

  // ── embedding pass ─────────────────────────────────────────────────
  console.log("\n── semantic: embedding pass ──────────────────────────────")
  const passRoot = await mkdtemp(join(tmpdir(), "diane-pass-"))
  {
    const repo = await MemoryRepository.load(passRoot)
    const stub = new ConceptStubEmbedder()
    for (let i = 0; i < 5; i++) {
      repo.insert({
        category: "code-map",
        subject: `file${i}.ts`,
        content: `function f${i}() handles user data`,
        source: "test",
      })
    }
    const vs = VectorStore.open(passRoot, stub.id)
    const r1 = await embedMissingMemories(repo, vs, stub)
    assert(r1.embedded === 5 && vs.size() === 5, "embedding pass embeds every un-embedded memory")
    const r2 = await embedMissingMemories(repo, vs, stub)
    assert(r2.embedded === 0, "a second pass embeds nothing — already-embedded memories are skipped")
    vs.close()
  }
  await rm(passRoot, { recursive: true, force: true })

  // ── cross-lingual retrieval: Russian / English / Chinese ───────────
  // Three memories, each a code comment in a DIFFERENT language and
  // about a DIFFERENT concept. A query in one language must retrieve
  // the memory about that concept regardless of the language it is
  // written in — and lexical search alone must NOT (different scripts
  // share no tokens), which is the whole point of the feature.
  console.log("\n── semantic: cross-lingual recall (RU · EN · ZH) ─────────")
  const clRoot = await mkdtemp(join(tmpdir(), "diane-xling-"))
  {
    const repo = await MemoryRepository.load(clRoot)
    const stub = new ConceptStubEmbedder()

    const mAuth = repo.insert({
      category: "code-map",
      subject: "src/auth/login.ts",
      // English comment.
      content:
        "// Validate the user credentials and open an authenticated session.\n" +
        "export function login(user: string, password: string) {}",
      source: "test",
    })
    const mDb = repo.insert({
      category: "code-map",
      subject: "internal/db/pool.go",
      // Chinese comment: "cache layer for database query results".
      content:
        "// 数据库查询结果的缓存层，减少重复查询开销。\n" +
        "func QueryWithCache(sql string) {}",
      source: "test",
    })
    const mCfg = repo.insert({
      category: "code-map",
      subject: "src/config/loader.rs",
      // Russian comment: "parse the configuration file at startup".
      content:
        "// Разбор файла конфигурации при запуске приложения.\n" +
        "fn load_config(path: &str) {}",
      source: "test",
    })

    const vs = VectorStore.open(clRoot, stub.id)
    await embedMissingMemories(repo, vs, stub)
    repo.attachVectorStore(vs)

    // RU query → EN-commented memory.
    const ruQuery = "аутентификация пользователя"
    const ruLexical = repo.recall({ query: ruQuery, limit: 5 })
    assert(
      !ruLexical.some((h) => h.memory.id === mAuth.id),
      "lexical search alone: a Russian query does NOT reach the English memory (no shared tokens)"
    )
    const ruSemantic = repo.recall({
      query: ruQuery,
      queryVector: await stub.embedQuery(ruQuery),
      limit: 5,
    })
    assert(
      ruSemantic[0]?.memory.id === mAuth.id,
      "RU → EN: a Russian query top-ranks the English-commented auth memory"
    )

    // EN query → ZH-commented memory.
    const enQuery = "database query cache layer"
    const enSemantic = repo.recall({
      query: enQuery,
      queryVector: await stub.embedQuery(enQuery),
      limit: 5,
    })
    assert(
      enSemantic[0]?.memory.id === mDb.id,
      "EN → ZH: an English query top-ranks the Chinese-commented database memory"
    )

    // ZH query → RU-commented memory.
    const zhQuery = "配置文件解析"
    const zhSemantic = repo.recall({
      query: zhQuery,
      queryVector: await stub.embedQuery(zhQuery),
      limit: 5,
    })
    assert(
      zhSemantic[0]?.memory.id === mCfg.id,
      "ZH → RU: a Chinese query top-ranks the Russian-commented config memory"
    )

    // Same-language recall is not regressed by the semantic path.
    const enSame = repo.recall({
      query: "user login session",
      queryVector: await stub.embedQuery("user login session"),
      limit: 5,
    })
    assert(
      enSame[0]?.memory.id === mAuth.id,
      "same-language recall still works with semantic search on"
    )
    vs.close()
  }
  await rm(clRoot, { recursive: true, force: true })

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(2) })
