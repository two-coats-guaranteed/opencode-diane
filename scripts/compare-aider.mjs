#!/usr/bin/env bun
/**
 * compare-aider.mjs — compare aider's repo-map to diane's code
 * map, on the one capability the two tools genuinely share: a
 * tree-sitter structural map of a codebase.
 *
 * This script does NOT run either tool. It reads two text files that
 * were already produced — `aider --show-repo-map` output and
 * `scripts/dump-code-map.mjs` output — and emits a Markdown report
 * comparing them on token cost and (approximate) coverage. Keeping
 * generation out of this script means it has no dependency on aider
 * being installed and is trivial to run anywhere; the CI workflow
 * (`.github/workflows/compare-aider.yml`) does the generation.
 *
 * USAGE:
 *   bun scripts/compare-aider.mjs <aider-map-file> <diane-map-file> [--repo NAME]
 *
 * The report goes to stdout (the workflow appends it to the job
 * summary). Token counting uses real BPE counts if the optional
 * `tiktoken` package is present, else a ~4-chars/token heuristic —
 * identical to `scripts/measure-savings.mjs`, and applied to BOTH
 * inputs so the comparison is apples-to-apples either way.
 *
 * HONESTY: the two artifacts are not the same shape and the report
 * says so. aider's repo-map is a single ranked digest trimmed to a
 * token budget (`--map-tokens`, default 1k) — what aider injects per
 * turn. diane's code map is one stored memory per file; the
 * `memory_code_map` tool serves a query-ranked, separately
 * token-budgeted subset of it. So "total tokens of the full dump" is
 * a coverage/footprint measure, not a head-to-head of what each puts
 * in the model's context. The report frames it that way rather than
 * declaring a winner.
 */

import { existsSync, readFileSync } from "node:fs"
import { basename } from "node:path"

/* ─── args ──────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)
const repoFlag = argv.indexOf("--repo")
const repoName = repoFlag >= 0 ? argv[repoFlag + 1] : null
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--repo")
const [aiderFile, dianeFile] = positional

if (!aiderFile || !dianeFile) {
  console.error("usage: bun scripts/compare-aider.mjs <aider-map-file> <diane-map-file> [--repo NAME]")
  process.exit(1)
}

/* ─── token counting: tiktoken if present, else the 4-char heuristic ── */

let countTokens
let tokenMethod
try {
  const { encoding_for_model } = await import("tiktoken")
  const enc = encoding_for_model("gpt-4")
  countTokens = (s) => enc.encode(s ?? "").length
  tokenMethod = "tiktoken (real BPE counts)"
} catch {
  countTokens = (s) => Math.ceil((s ?? "").length / 4)
  tokenMethod = "~4 chars/token heuristic"
}

/* ─── read inputs ───────────────────────────────────────────────────── */

function readOrEmpty(path) {
  if (!existsSync(path)) return { text: "", missing: true }
  try {
    return { text: readFileSync(path, "utf-8"), missing: false }
  } catch (e) {
    return { text: "", missing: true, error: String(e) }
  }
}

const aider = readOrEmpty(aiderFile)
const diane = readOrEmpty(dianeFile)

/* ─── metrics ───────────────────────────────────────────────────────── */

/**
 * Count file headers in a map. Both tools format a file as a
 * non-indented line ending in `:`. aider additionally draws tree
 * structure with `│` and `⋮`; we exclude indented / box-drawing
 * lines. This is a heuristic and the report labels it as approximate.
 */
function countFiles(text) {
  let n = 0
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    const first = line[0]
    if (first === " " || first === "\t" || first === "│" || first === "⋮") continue
    if (line.trimEnd().endsWith(":")) n++
  }
  return n
}

function analyse(name, src) {
  const text = src.text
  const tokens = countTokens(text)
  const lines = text === "" ? 0 : text.split("\n").length
  const files = countFiles(text)
  return {
    name,
    missing: src.missing === true,
    error: src.error,
    bytes: Buffer.byteLength(text, "utf-8"),
    tokens,
    lines,
    files,
    tokensPerFile: files > 0 ? Math.round(tokens / files) : null,
  }
}

const A = analyse("aider --show-repo-map", aider)
const T = analyse("diane code map (full dump)", diane)

/* ─── report ────────────────────────────────────────────────────────── */

const out = []
out.push("## aider repo-map vs diane code-map\n")
if (repoName) out.push(`**Repository:** \`${repoName}\`\n`)
out.push(`**Token counting:** ${tokenMethod}\n`)
out.push(
  `**Inputs:** \`${basename(aiderFile)}\` (aider) · \`${basename(dianeFile)}\` (diane)\n`
)
out.push("")

if (A.missing || T.missing) {
  out.push("> ⚠️ One or both map files were missing or empty:")
  if (A.missing) out.push(`> - aider map \`${aiderFile}\` — missing/empty${A.error ? ` (${A.error})` : ""}`)
  if (T.missing) out.push(`> - diane map \`${dianeFile}\` — missing/empty${T.error ? ` (${T.error})` : ""}`)
  out.push("")
  out.push(
    "> If the aider side is empty, aider likely couldn't start (it needs " +
      "a model configured even for `--show-repo-map`). If the diane side " +
      "is empty, the code-map ingester reported no parseable files."
  )
  out.push("")
}

out.push("| Metric | aider repo-map | diane code map |")
out.push("|---|--:|--:|")
out.push(`| Tokens (whole artifact) | ${A.tokens.toLocaleString()} | ${T.tokens.toLocaleString()} |`)
out.push(`| Files covered (approx.) | ${A.files} | ${T.files} |`)
out.push(
  `| Tokens per file (approx.) | ${A.tokensPerFile ?? "—"} | ${T.tokensPerFile ?? "—"} |`
)
out.push(`| Bytes | ${A.bytes.toLocaleString()} | ${T.bytes.toLocaleString()} |`)
out.push("")

// A like-for-like takeaway, stated carefully.
if (!A.missing && !T.missing && A.tokensPerFile && T.tokensPerFile) {
  const denser = A.tokensPerFile < T.tokensPerFile ? "aider" : "diane"
  const ratio = (
    Math.max(A.tokensPerFile, T.tokensPerFile) / Math.min(A.tokensPerFile, T.tokensPerFile)
  ).toFixed(2)
  out.push(
    `Per file, **${denser}**'s map is more compact (~${ratio}× fewer tokens per ` +
      `file on this repo). Whether that's better depends on the use: a denser ` +
      `map covers more of the tree per token; a richer per-file entry gives the ` +
      `model more to work with before it has to open the file.`
  )
  out.push("")
}

out.push("### What this does and doesn't show\n")
out.push(
  "- **Why the token counts differ.** aider's repo-map embeds the " +
    "*critical source lines* of each definition (the actual `class`/`def`/" +
    "`fn` lines from the file); diane's code map lists *signatures* " +
    "as a compact one-line-per-file digest. aider gives the model more raw " +
    "code per file; diane gives a denser index. Neither is strictly " +
    "better — it's a richness-vs-density trade."
)
out.push(
  "- **It's a fair comparison of one shared capability** — a tree-sitter " +
    "structural map — measured with one tokenizer applied to both."
)
out.push(
  "- **It is not a head-to-head of context cost.** aider's repo-map is a " +
    "single ranked digest trimmed to `--map-tokens` (default 1k) and sent " +
    "every turn. diane stores one memory per file and the " +
    "`memory_code_map` tool serves a *query-ranked, separately budgeted* " +
    "subset — so the figures above are a coverage/footprint measure of the " +
    "full maps, not what each injects per request."
)
out.push(
  "- **Different scopes.** aider's repo-map is the whole of aider's repo " +
    "awareness. diane's code map is one of several memory categories " +
    "(git history, project facts, session traces) — the code map is the " +
    "only part that overlaps aider."
)
out.push(
  "- **File counts are approximate** — derived by counting non-indented " +
    "`path:` headers in each artifact's text."
)
out.push("")

const report = out.join("\n")
process.stdout.write(report + "\n")

// Non-zero exit only if BOTH inputs were unusable — a one-sided miss
// is still a useful (if partial) report, so don't fail the job for it.
if (A.missing && T.missing) process.exit(1)
