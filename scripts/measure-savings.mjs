#!/usr/bin/env node
/**
 * measure-savings.mjs — estimate how many tokens diane saves on
 * a given repository, with no model, no GPU, and no API key required.
 *
 * Token counting is arithmetic, not inference. By default this uses
 * the same ~4-chars-per-token heuristic the plugin uses internally;
 * if the optional `tiktoken` package is installed it will use real
 * BPE counts instead (`npm i -D tiktoken`). The ratio barely moves
 * between the two — the heuristic is within ~10-15% of tiktoken for
 * English + code — so the heuristic is fine for a go/no-go read.
 *
 * USAGE:
 *   node scripts/measure-savings.mjs <repo-path> ["task description"] [--code-map]
 *
 * EXAMPLES:
 *   node scripts/measure-savings.mjs ../some-small-lib
 *   node scripts/measure-savings.mjs /work/big-monorepo "fix the auth retry bug" --code-map
 *
 * WHAT IT DOES — and why it's a fair comparison, not a rigged one:
 *
 *   "Without plugin" side: runs a FIXED, realistic discovery recipe a
 *   competent agent would run when dropped into an unfamiliar repo for
 *   this task — recent git history, a tree listing, reading the few
 *   files whose names match the task keywords, and a grep. It does not
 *   know the answer in advance; it discovers the way an agent would.
 *
 *   "With plugin" side: prefills the store exactly as the plugin does
 *   on startup, then runs the same two or three memory tool calls an
 *   agent would (`memory_outline`, `memory_recall`, and — if
 *   --code-map — `memory_code_map`), each token-budgeted.
 *
 *   Both sides print exactly what they ran, so you can audit the
 *   comparison. The script never inflates the "without" side: every
 *   command output is capped the way OpenCode caps real tool output.
 *
 * NOTE ON REPO SIZE: the saving scales with how much there is to
 * rediscover. On a tiny repo the "without" cost is already low, so the
 * percentage will be modest — that is correct, not a failure. The win
 * grows with history depth, file count, and co-change density. Run it
 * on a small repo AND a large one; expect a small number on the first
 * and a large one on the second.
 */

import { execFileSync } from "node:child_process"
import { readdirSync, statSync, existsSync } from "node:fs"
import { join, resolve, basename, extname } from "node:path"
import { fileURLToPath } from "node:url"

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
  tokenMethod = "~4 chars/token heuristic (install tiktoken for exact counts)"
}

/* ─── args ──────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)
const useCodeMap = argv.includes("--code-map")
const positional = argv.filter((a) => !a.startsWith("--"))
const repoPath = positional[0] ? resolve(positional[0]) : null
const task = positional[1] || "understand and modify this codebase"

if (!repoPath || !existsSync(repoPath)) {
  console.error("usage: node scripts/measure-savings.mjs <repo-path> [\"task\"] [--code-map]")
  console.error(repoPath ? `  path not found: ${repoPath}` : "  (no repo path given)")
  process.exit(1)
}

/* ─── locate the built plugin ───────────────────────────────────────── */

const pkgDir = resolve(fileURLToPath(import.meta.url), "..", "..")
const distRepo = join(pkgDir, "dist", "store", "repository.js")
if (!existsSync(distRepo)) {
  console.error("plugin not built — run `bun run build` first.")
  process.exit(1)
}
const { MemoryRepository } = await import(join(pkgDir, "dist", "store", "repository.js"))
const { ingestGitHistory } = await import(join(pkgDir, "dist", "ingest", "git.js"))
const { ingestProjectFacts } = await import(join(pkgDir, "dist", "ingest", "project.js"))
const { ingestCodeMap } = await import(join(pkgDir, "dist", "ingest", "code-map.js"))

/* ─── helpers ───────────────────────────────────────────────────────── */

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { cwd: repoPath, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 })
  } catch (e) {
    return (e && (e.stdout || "")) || ""
  }
}
// OpenCode caps tool output; mirror that so the "without" side is not
// artificially inflated by one enormous command.
const CAP_CHARS = 16000
const cap = (s) => (s.length > CAP_CHARS ? s.slice(0, CAP_CHARS) + "\n…[output truncated]" : s)

// Stopwords — keeping these in the keyword list would make the
// "without" grep match everything and unfairly inflate the baseline,
// and they're useless as recall query terms too.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your",
  "you", "are", "can", "has", "have", "was", "were", "will", "would",
  "should", "could", "fix", "add", "use", "make", "get", "set", "run",
  "new", "all", "any", "out", "how", "why", "what", "when", "where",
])
const taskWords = task
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter((w) => w.length >= 3 && !STOPWORDS.has(w))

const isGit = existsSync(join(repoPath, ".git"))

/* ─── WITHOUT plugin: a realistic discovery recipe ──────────────────── */

console.log("=".repeat(70))
console.log(`diane — token savings measurement`)
console.log("=".repeat(70))
console.log(`repo:        ${repoPath}`)
console.log(`task:        "${task}"`)
console.log(`token count: ${tokenMethod}`)
console.log(`code-map:    ${useCodeMap ? "enabled" : "disabled (pass --code-map to include)"}`)
console.log("")

const without = []
function record(side, label, text) {
  const t = countTokens(text)
  side.push({ label, tokens: t })
  return t
}

console.log("-".repeat(70))
console.log("WITHOUT plugin — discovery an agent would do for this task:")
console.log("-".repeat(70))

if (isGit) {
  record(without, "git log --oneline -25", cap(sh("git", ["log", "--oneline", "-25"])))
  record(without, "git log --stat -8", cap(sh("git", ["log", "--stat", "-8"])))
}

// a tree listing (capped) — what `ls -R` / a file-glob would cost
let treeListing = ""
const SKIP = new Set([".git", "node_modules", "dist", "build", "target", "vendor", ".venv"])
function walk(dir, depth, acc) {
  if (depth > 4 || acc.lines.length > 600) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue
    const full = join(dir, e.name)
    const rel = full.slice(repoPath.length + 1)
    acc.lines.push(rel)
    if (e.isDirectory()) walk(full, depth + 1, acc)
    else if (e.isFile()) acc.files.push(rel)
  }
}
const acc = { lines: [], files: [] }
walk(repoPath, 0, acc)
treeListing = acc.lines.join("\n")
record(without, `tree listing (${acc.files.length} files seen)`, cap(treeListing))

// read the files whose names best match the task keywords — this is
// exactly what an agent does: grep the tree, read what looks relevant.
const scored = acc.files
  .map((f) => {
    const name = basename(f).toLowerCase()
    const score = taskWords.reduce((s, w) => s + (name.includes(w) ? 2 : f.toLowerCase().includes(w) ? 1 : 0), 0)
    return { f, score }
  })
  .filter((x) => x.score > 0)
  .sort((a, b) => b.score - a.score)

// if nothing matched the task, fall back to the largest source files —
// an agent with no lead reads the obvious entry points.
const SRC_EXT = new Set([".ts", ".tsx", ".js", ".py", ".go", ".rs", ".java", ".rb", ".c", ".cpp", ".h"])
let toRead = scored.slice(0, 3).map((x) => x.f)
if (toRead.length === 0) {
  toRead = acc.files
    .filter((f) => SRC_EXT.has(extname(f)))
    .map((f) => {
      let sz = 0
      try {
        sz = statSync(join(repoPath, f)).size
      } catch {
        /* ignore */
      }
      return { f, sz }
    })
    .sort((a, b) => b.sz - a.sz)
    .slice(0, 3)
    .map((x) => x.f)
}
for (const f of toRead) {
  let body = ""
  try {
    body = execFileSync("cat", [f], { cwd: repoPath, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 })
  } catch {
    /* ignore */
  }
  record(without, `read ${f}`, cap(body))
}

// a grep for the task keywords
if (taskWords.length > 0) {
  const pattern = taskWords.slice(0, 4).join("|")
  const grep = sh("grep", ["-rIn", "-E", pattern, "--", "."])
  record(without, `grep -rIn "${pattern}"`, cap(grep))
}

let withoutTotal = 0
for (const c of without) {
  console.log(`  ${String(c.tokens).padStart(7)} tok  ${c.label}`)
  withoutTotal += c.tokens
}
console.log(`  ${"—".repeat(7)}`)
console.log(`  ${String(withoutTotal).padStart(7)} tok  TOTAL`)

/* ─── WITH plugin: prefill, then the memory tool calls ──────────────── */

console.log("")
console.log("-".repeat(70))
console.log("WITH plugin — prefill once, then the memory calls for this task:")
console.log("-".repeat(70))

// use a scratch store so we never touch the repo's real .opencode dir
const scratch = join(pkgDir, ".measure-tmp-store")
import("node:fs").then((fs) => fs.rmSync(scratch, { recursive: true, force: true }))
const repo = await MemoryRepository.load(scratch)

const t0 = Date.now()
const proj = await ingestProjectFacts(repo, repoPath)
let gitRes = { commitMemories: 0, coChangeMemories: 0, churnMemories: 0 }
if (isGit) gitRes = await ingestGitHistory(repo, repoPath, 500)
let cmRes = null
if (useCodeMap) cmRes = await ingestCodeMap(repo, repoPath, pkgDir)
const prefillMs = Date.now() - t0

console.log(
  `  prefill: ${repo.size()} memories ` +
    `(${gitRes.commitMemories} commit, ${gitRes.coChangeMemories} co-change, ` +
    `${gitRes.churnMemories} churn, ${proj.facts} project-fact` +
    (cmRes ? `, ${cmRes.signaturesExtracted} code-map signatures` : "") +
    `) in ${prefillMs}ms — one-time, in the background`
)
console.log("")

const fmtHit = (h) => `[${h.memory.category} | ${h.memory.subject}] ${h.memory.content}`
const withSide = []

// memory_outline — the cheap orientation call
const counts = repo.countsByCategory()
const outline = Array.from(counts.entries())
  .map(([c, n]) => `${c}: ${n}`)
  .join("\n")
record(withSide, "memory_outline()", outline)

// memory_recall(task) — token-budgeted, co-change-boosted
const recall = repo.recallDetailed({ query: task, limit: 25, tokenBudget: 1200 }, fmtHit)
record(
  withSide,
  `memory_recall("${task}")`,
  recall.hits.map(fmtHit).join("\n") + (recall.omitted ? `\n…(+${recall.omitted} omitted)` : "")
)

// memory_code_map(task) — only if enabled
if (useCodeMap) {
  const cm = repo.recallDetailed(
    { query: task, category: "code-map", limit: 60, tokenBudget: 1500 },
    fmtHit
  )
  record(
    withSide,
    `memory_code_map("${task}")`,
    cm.hits.map(fmtHit).join("\n") + (cm.omitted ? `\n…(+${cm.omitted} omitted)` : "")
  )
}

let withTotal = 0
for (const c of withSide) {
  console.log(`  ${String(c.tokens).padStart(7)} tok  ${c.label}`)
  withTotal += c.tokens
}
console.log(`  ${"—".repeat(7)}`)
console.log(`  ${String(withTotal).padStart(7)} tok  TOTAL`)

/* ─── verdict ───────────────────────────────────────────────────────── */

import("node:fs").then((fs) => fs.rmSync(scratch, { recursive: true, force: true }))

// How much did recall actually find? A near-empty result is NOT a
// saving — it means the agent would fall back to raw discovery
// anyway, so the honest "with" cost is the memory calls PLUS that
// fallback. We report both the optimistic and the honest number.
const recallHitCount = recall.hits.length
const storeThin = repo.size() < 5 || recallHitCount === 0

console.log("")
console.log("=".repeat(70))

if (storeThin) {
  // The store had little or nothing relevant — be explicit, do not
  // dress this up as a 100% win.
  console.log(
    `RESULT: inconclusive on this repo/task. The memory store ended up ` +
      `${repo.size() < 5 ? "nearly empty" : "with no hits for this task"} ` +
      `(${repo.size()} memories, ${recallHitCount} recall hits).`
  )
  if (!isGit) {
    console.log(
      `Reason: this is not a git repository, so the biggest source of memories ` +
        `(commit history, co-change, churn) was unavailable.`
    )
  } else {
    console.log(
      `Reason: recall found nothing for "${task}" — try task wording that matches ` +
        `terms actually used in the codebase, or a repo with more history.`
    )
  }
  console.log(
    `The plugin saves tokens by ANSWERING discovery from memory; with an empty ` +
      `store there's nothing to answer from. This is expected on tiny or fresh repos.`
  )
} else {
  // Honest "with" cost: if recall coverage is thin (1-2 hits), assume
  // the agent still does a chunk of fallback discovery.
  const coverage = recallHitCount >= 5 ? "good" : recallHitCount >= 3 ? "partial" : "thin"
  const fallbackFactor = coverage === "good" ? 0 : coverage === "partial" ? 0.4 : 0.7
  const honestWith = Math.round(withTotal + withoutTotal * fallbackFactor)
  const saved = withoutTotal - honestWith
  const pct = withoutTotal > 0 ? Math.round((100 * saved) / withoutTotal) : 0

  console.log(
    `RESULT: ~${withoutTotal} tokens of raw discovery  →  ~${honestWith} tokens with the plugin`
  )
  console.log(
    `        ${pct > 0 ? `${pct}% reduction (~${saved} tokens saved)` : "no net saving"} ` +
      `· recall coverage: ${coverage} (${recallHitCount} hits)`
  )
  if (coverage !== "good") {
    console.log(
      `        (coverage is ${coverage}, so this assumes the agent still does ~${Math.round(
        fallbackFactor * 100
      )}% of the fallback discovery — the honest, not the optimistic, number.)`
    )
  }
  console.log(
    `        Best case if recall fully covers the task: ~${withTotal} tokens ` +
      `(${withoutTotal > 0 ? Math.round((100 * (withoutTotal - withTotal)) / withoutTotal) : 0}% reduction).`
  )
}
console.log(
  `Note: the "with" cost recurs per task; prefill (${prefillMs}ms) is one-time per session. ` +
    `Re-run with different task strings and on both a small and a large repo to see how it scales.`
)
console.log("=".repeat(70))
