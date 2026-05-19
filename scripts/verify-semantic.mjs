#!/usr/bin/env bun
/**
 * verify-semantic.mjs — verify the REAL multilingual-e5 model does
 * cross-lingual retrieval, on Russian / English / Chinese fixtures.
 *
 * The `semantic.test.ts` suite proves diane's pipeline (vector store,
 * RRF fusion, recall) is correct, using a deterministic stub embedder
 * — so CI never has to download a model. THIS script is the other
 * half: it loads the actual e5 model and confirms the model itself
 * places the three languages in a shared space. Run it once, in an
 * environment where the Hugging Face Hub is reachable:
 *
 *     bun add @huggingface/transformers      # optional dependency
 *     bun run scripts/verify-semantic.mjs
 *
 * It downloads ~120 MB on first run (then cached). Exit code 0 means
 * every cross-lingual query retrieved the right passage.
 */

const MODEL = process.env.EMBEDDING_MODEL || "Xenova/multilingual-e5-small"

let pipeline
try {
  ;({ pipeline } = await import("@huggingface/transformers"))
} catch {
  console.error("✗ optional dependency '@huggingface/transformers' is not installed.")
  console.error("  install it first:  bun add @huggingface/transformers")
  process.exit(1)
}

console.log(`loading ${MODEL} (first run downloads ~120 MB, then cached)…`)
let extract
try {
  extract = await pipeline("feature-extraction", MODEL)
} catch (e) {
  console.error(`✗ could not load the model: ${e?.message || e}`)
  console.error("  this script needs network access to the Hugging Face Hub.")
  process.exit(1)
}

// e5 is asymmetric — queries and passages take different prefixes.
async function embed(text) {
  const t = await extract(text, { pooling: "mean", normalize: true })
  return t.data
}
function cosine(a, b) {
  let d = 0
  for (let i = 0; i < a.length; i++) d += a[i] * b[i] // both are L2-normalised
  return d
}

// Three code comments, each in a different language, each a different
// concept — mirroring tests/semantic.test.ts.
const passages = [
  { id: "EN auth", text: "passage: // Validate the user credentials and open an authenticated session." },
  { id: "ZH database", text: "passage: // 数据库查询结果的缓存层，减少重复查询开销。" },
  { id: "RU config", text: "passage: // Разбор файла конфигурации при запуске приложения." },
]
// Each query is in a different language from the passage it should match.
const queries = [
  { q: "query: аутентификация пользователя", lang: "RU", expect: "EN auth" },
  { q: "query: database query cache layer", lang: "EN", expect: "ZH database" },
  { q: "query: 配置文件解析", lang: "ZH", expect: "RU config" },
]

const pVecs = []
for (const p of passages) pVecs.push({ id: p.id, vec: await embed(p.text) })

let allOk = true
console.log("")
for (const { q, lang, expect } of queries) {
  const qVec = await embed(q)
  const ranked = pVecs
    .map((p) => ({ id: p.id, score: cosine(qVec, p.vec) }))
    .sort((a, b) => b.score - a.score)
  const ok = ranked[0].id === expect
  allOk &&= ok
  console.log(`${ok ? "✓" : "✗"} ${lang} query → expected「${expect}」`)
  for (const r of ranked) {
    console.log(`    ${r.id === ranked[0].id ? "→" : " "} ${r.id.padEnd(12)} ${r.score.toFixed(4)}`)
  }
}

console.log("")
if (allOk) {
  console.log("✓ all cross-lingual queries retrieved the correct passage — e5 works as expected.")
  process.exit(0)
} else {
  console.log("✗ at least one cross-lingual query missed — inspect the scores above.")
  process.exit(1)
}
