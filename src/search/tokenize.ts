/**
 * Deterministic tokenizer for memory search.
 *
 * Two scripts, two strategies, one pass:
 *
 *  - Latin / digit runs are split identifier-aware, so an agent's
 *    camelCase / snake_case queries match well:
 *      "AuthService.login_user" → ["authservice","auth","service","login","user"]
 *
 *  - CJK runs (Chinese, Japanese kana, Korean) are emitted as
 *    overlapping bigrams:
 *      "数据库连接" → ["数据","据库","库连","连接"]
 *    CJK text has no word delimiters, so a whitespace/punctuation
 *    splitter would drop it entirely. Bigrams give BM25 overlapping
 *    units to match on — a query "数据库" → ["数据","据库"] overlaps a
 *    stored "数据库连接池" — with no dictionary, model, or word
 *    segmenter. This is the same approach Lucene's CJK analyzer and
 *    SQLite FTS5 use; it is deterministic and dependency-free, which
 *    is why it's preferred here over a statistical segmenter (whose
 *    dictionary alone would blow the package size budget).
 *
 * Both indexing and querying call this function, so the two sides
 * always agree regardless of script.
 */

// English stopwords. Not applied to CJK bigrams — there's no reliable
// script-agnostic stopword notion for bigrams, and BM25's IDF already
// down-weights ubiquitous bigrams without a hand-maintained list.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for",
  "from", "has", "have", "if", "in", "into", "is", "it", "its", "of",
  "on", "or", "so", "such", "that", "the", "their", "then", "there",
  "these", "they", "this", "to", "was", "were", "will", "with",
  "we", "us", "you", "your", "i", "me", "my", "do", "does", "did",
])

const MIN_LEN = 2
const MAX_LEN = 32

// CJK scripts handled as bigrams: Han (Chinese, Japanese kanji),
// Hiragana + Katakana (Japanese), Hangul (Korean).
const CJK_SCRIPTS =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}"
// One pass: match either a CJK run OR an ASCII word run. Everything
// else (spaces, punctuation, CJK punctuation) is a separator.
const RUN_RE = new RegExp(`[${CJK_SCRIPTS}]+|[A-Za-z0-9_]+`, "gu")
const CJK_RE = new RegExp(`[${CJK_SCRIPTS}]`, "u")

export function tokenize(text: string): string[] {
  if (!text) return []
  const out: string[] = []

  for (const match of text.matchAll(RUN_RE)) {
    const run = match[0]

    // ── CJK run → overlapping bigrams ───────────────────────────────
    if (CJK_RE.test(run)) {
      // Iterate code points (not UTF-16 units) so astral-plane
      // ideographs (CJK Extension B+) bigram correctly.
      const chars = [...run]
      if (chars.length === 1) {
        // A lone ideograph — rare, but keep it so a single-character
        // query still matches. CJK tokens bypass the Latin MIN_LEN.
        out.push(chars[0])
      } else {
        for (let i = 0; i < chars.length - 1; i++) {
          out.push(chars[i] + chars[i + 1])
        }
      }
      continue
    }

    // ── Latin / digit run → identifier-aware splitting ──────────────
    // camelCase split works because the run is not yet lowercased.
    const camelParts = /[a-z][A-Z]/.test(run) ? run.split(/(?=[A-Z])/u) : [run]
    for (const part of camelParts) {
      const lower = part.toLowerCase()
      const snakeParts = lower.includes("_") ? lower.split("_") : [lower]
      for (const sp of snakeParts) {
        if (sp.length < MIN_LEN || sp.length > MAX_LEN) continue
        if (STOPWORDS.has(sp)) continue
        out.push(sp)
      }
    }
    // Also keep the original (lowercased) full token, so exact-string
    // queries like "authservice" still match documents with "AuthService".
    const full = run.toLowerCase()
    if (
      full.length >= MIN_LEN &&
      full.length <= MAX_LEN &&
      !STOPWORDS.has(full) &&
      !out.includes(full)
    ) {
      out.push(full)
    }
  }
  return out
}

export function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return tf
}
