#!/usr/bin/env bun
/**
 * verify-semantic.mjs — verify the REAL multilingual-e5 model does
 * cross-lingual retrieval, across NINE languages on each side of every
 * query: English, Chinese, Russian, Japanese, Spanish, Turkish,
 * Mongolian (Cyrillic), Tajik (Cyrillic), and Kyrgyz (Cyrillic).
 *
 * The `semantic.test.ts` suite proves diane's pipeline (vector store,
 * RRF fusion, recall) is correct using a deterministic stub embedder
 * — so CI never has to download a model. THIS script is the other
 * half: it loads the actual e5 model and confirms it places these
 * languages in a shared embedding space.
 *
 * Two tiers, because multilingual-e5-small was trained with very
 * different amounts of data per language:
 *
 *   - CORE tier — English, Chinese, Russian, Japanese, Spanish,
 *     Turkish. These are well-represented in the model's training
 *     data; cross-lingual retrieval here is expected to work. The
 *     exit code reflects this tier: a core-tier miss fails the script.
 *
 *   - EXPERIMENTAL tier — Mongolian, Tajik, Kyrgyz. Low-resource
 *     Cyrillic languages whose coverage in multilingual-e5-small is
 *     real but uneven. Results are REPORTED so you can see how the
 *     model actually handles them on your fixtures, but they do NOT
 *     gate the exit code — a script that hard-failed on Tajik would
 *     break in environments where the model legitimately cannot
 *     handle it well, which is information about the model, not a
 *     bug in the harness. Read the per-query lines below.
 *
 * Run it once, in an environment with network access to the
 * Hugging Face Hub:
 *
 *     bun add @huggingface/transformers      # optional dependency
 *     bun run scripts/verify-semantic.mjs
 *
 * It downloads ~120 MB on first run (then cached). Exit code 0 means
 * every CORE-tier query retrieved the right passage; experimental
 * results are printed alongside.
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

// Nine code comments, each in a different language, each a distinct
// concept (auth ≠ cache ≠ config ≠ websocket ≠ error-handling ≠
// upload-validation ≠ logging ≠ input-validation ≠ retry). Distinct
// topics so a correct cross-lingual match cannot be explained by
// topical bleed between two languages of the same script.
const passages = [
  { id: "EN auth",      text: "passage: // Validate the user credentials and open an authenticated session." },
  { id: "ZH database",  text: "passage: // 数据库查询结果的缓存层，减少重复查询开销。" },
  { id: "RU config",    text: "passage: // Разбор файла конфигурации при запуске приложения." },
  { id: "JA websocket", text: "passage: // WebSocket メッセージを処理し、クライアントへ転送するハンドラ。" },
  { id: "ES error",     text: "passage: // Captura las excepciones lanzadas por el cliente HTTP y las registra." },
  { id: "TR upload",    text: "passage: // Yüklenen dosyaların boyutunu kontrol eden doğrulayıcı." },
  { id: "MN logging",   text: "passage: // Хэрэглэгчийн үйлдлийг бүртгэх лог систем." },
  { id: "TG validation",text: "passage: // Тафтиши маълумоти воридшаванда барои бехатарӣ." },
  { id: "KY retry",     text: "passage: // Кайра аракет кылуу логикасы экспоненциалдуу күтүү менен." },
]

// Each query is in a different language from the passage it should
// match. `tier: "core"` queries gate the exit code; `experimental`
// ones are reported but do not.
const queries = [
  // Core tier — well-resourced languages on both sides.
  { tier: "core",         lang: "RU→EN", q: "query: аутентификация пользователя",          expect: "EN auth" },
  { tier: "core",         lang: "EN→ZH", q: "query: database query cache layer",            expect: "ZH database" },
  { tier: "core",         lang: "ZH→RU", q: "query: 配置文件解析",                            expect: "RU config" },
  { tier: "core",         lang: "ES→JA", q: "query: manejador de mensajes websocket",        expect: "JA websocket" },
  { tier: "core",         lang: "JA→ES", q: "query: HTTP例外のキャプチャ",                    expect: "ES error" },
  { tier: "core",         lang: "EN→TR", q: "query: uploaded file size validator",           expect: "TR upload" },
  // Experimental tier — low-resource Cyrillic languages. Reported,
  // but the exit code does not depend on them.
  { tier: "experimental", lang: "TR→MN", q: "query: kullanıcı eylem günlüğü",                expect: "MN logging" },
  { tier: "experimental", lang: "MN→TG", q: "query: оролт мэдээллийг шалгах",                expect: "TG validation" },
  { tier: "experimental", lang: "TG→KY", q: "query: дубораи кӯшиш бо интизори экспоненциалӣ", expect: "KY retry" },
]

const pVecs = []
for (const p of passages) pVecs.push({ id: p.id, vec: await embed(p.text) })

let coreOk = true
let coreTotal = 0, coreHit = 0
let expTotal = 0, expHit = 0

console.log("")
for (const { q, lang, expect, tier } of queries) {
  const qVec = await embed(q)
  const ranked = pVecs
    .map((p) => ({ id: p.id, score: cosine(qVec, p.vec) }))
    .sort((a, b) => b.score - a.score)
  const hit = ranked[0].id === expect
  if (tier === "core") { coreTotal++; if (hit) coreHit++; else coreOk = false }
  else                  { expTotal++;  if (hit) expHit++ }

  const tag = tier === "core" ? "[core]" : "[exp ]"
  console.log(`${hit ? "✓" : "✗"} ${tag} ${lang}  expected「${expect}」`)
  // Show the top three to make a near-miss legible (ranked 2nd is
  // a different story from ranked last on 9 distractors).
  for (let i = 0; i < Math.min(3, ranked.length); i++) {
    const r = ranked[i]
    const marker = i === 0 ? "→" : " "
    console.log(`    ${marker} ${r.id.padEnd(14)} ${r.score.toFixed(4)}`)
  }
}

console.log("")
console.log(`Core tier         ${coreHit}/${coreTotal}  (must be ${coreTotal}/${coreTotal} for exit 0)`)
console.log(`Experimental tier ${expHit}/${expTotal}  (informational; does not gate exit)`)
console.log("")
if (coreOk) {
  console.log("✓ every core-tier cross-lingual query retrieved the correct passage.")
  if (expHit < expTotal) {
    console.log("  (Some experimental-tier queries missed — this reflects the model's")
    console.log("  uneven coverage of low-resource Cyrillic languages, not a harness")
    console.log("  bug. Inspect the scores above to see how close each came.)")
  }
  process.exit(0)
} else {
  console.log("✗ at least one core-tier cross-lingual query missed — inspect the")
  console.log("  scores above. If the model itself looks wrong on a well-resourced")
  console.log("  language, the embedder may be misconfigured.")
  process.exit(1)
}
