/**
 * token-savings.test.ts — does the plugin actually save tokens versus
 * bare OpenCode?
 *
 * The claim "diane saves tokens" only means something if it's
 * measured, so this suite measures it. The method mirrors
 * `scripts/measure-savings.mjs`, turned into gated assertions:
 *
 *   Baseline (bare OpenCode): the raw material an agent pulls into
 *   context when it has no memory plugin — real `git log -p`, real
 *   `cat` of config files, a real `git log --stat`. Output is capped
 *   at 16 000 chars per command, exactly the way OpenCode caps tool
 *   output, so the baseline is never inflated by one giant command.
 *
 *   With plugin: the repo is ingested the way the plugin does on
 *   startup, then the same information need is served by a
 *   token-budgeted `recall`.
 *
 * Token counting is the ~4-chars-per-token heuristic (the same one
 * the plugin uses internally). The assertions are on RATIOS, not
 * absolute counts — a ratio is robust to the exact tokenizer, so the
 * heuristic is honest here. Every case prints its real measured
 * numbers so the comparison is auditable, and the thresholds are set
 * conservatively below what's actually observed: the test guards the
 * direction and rough magnitude of the saving, it doesn't pretend to
 * a precision it doesn't have.
 *
 * Honesty note baked into the cases: the saving scales with how much
 * there is to rediscover. These cases build a fixture with enough
 * history that the saving is unambiguous. On a trivial repo the
 * baseline is already cheap and the saving is modest — that is
 * correct behaviour, not a bug, and case D guards the floor (the
 * plugin's own footprint stays bounded and never *costs* more).
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

import { MemoryRepository } from "../src/store/repository.js"
import { ingestGitHistory } from "../src/ingest/git.js"
import { ingestProjectFacts } from "../src/ingest/project.js"

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

/** ~4 chars/token — the heuristic the plugin itself uses. Ratios of
 *  this are stable across real tokenizers, which is all we assert on. */
const estTokens = (s: string): number => Math.ceil((s ?? "").length / 4)

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" })
}

/** Run a command, capture stdout, swallow non-zero exit (return what
 *  was produced) — the agent sees partial output too. */
function sh(cwd: string, cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (e) {
    const err = e as { stdout?: string }
    return err.stdout ?? ""
  }
}

/** OpenCode caps tool output; mirror it so the baseline isn't inflated
 *  by one enormous command dump. */
const CAP_CHARS = 16_000
const cap = (s: string): string =>
  s.length > CAP_CHARS ? s.slice(0, CAP_CHARS) + "\n…[output truncated]" : s

const fmtHit = (h: {
  memory: { category: string; subject: string; content: string }
}): string => `[${h.memory.category} | ${h.memory.subject}] ${h.memory.content}`

/**
 * Build a fixture git repo with enough history that rediscovery has a
 * real cost: four source files, ~10 commits each, plus the kind of
 * config/readme files a project-facts pass would read. Commit
 * messages are deliberately plain prose — the plugin derives nothing
 * from message *style*, so the fixture mustn't either.
 */
async function buildFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diane-mem-savings-"))
  await mkdir(join(root, "src"), { recursive: true })

  git(root, ["init", "--initial-branch=main", "-q"])
  git(root, ["config", "user.email", "fixture@test"])
  git(root, ["config", "user.name", "Fixture"])

  // A package.json with enough substance that reading it costs real
  // tokens — this is the baseline cost for "what is this project".
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "fixture-service",
        version: "2.4.1",
        description:
          "An order-processing service with an HTTP API, a Postgres-backed " +
          "store, token authentication, and a background reconciliation worker.",
        main: "src/server.ts",
        scripts: {
          build: "tsc -p tsconfig.json",
          test: "node --test",
          start: "node dist/server.js",
          lint: "eslint src",
          migrate: "node dist/db.js --migrate",
        },
        dependencies: {
          express: "^4.19.0",
          pg: "^8.11.0",
          jsonwebtoken: "^9.0.0",
          pino: "^9.0.0",
          zod: "^3.23.0",
        },
        devDependencies: {
          typescript: "^5.6.0",
          eslint: "^9.0.0",
          "@types/express": "^4.17.0",
        },
      },
      null,
      2
    )
  )
  await writeFile(
    join(root, "README.md"),
    [
      "# fixture-service",
      "",
      "Order-processing service. HTTP API in front of a Postgres store,",
      "token auth on every route, and a background worker that reconciles",
      "pending orders against the payment provider.",
      "",
      "## Layout",
      "- `src/server.ts` — HTTP routes and middleware wiring",
      "- `src/auth.ts`   — token issue/verify and the auth middleware",
      "- `src/db.ts`     — Postgres connection pool and query helpers",
      "- `src/util.ts`   — shared retry/backoff and logging helpers",
      "",
      "## Build",
      "`npm run build` then `npm start`. Run `npm run migrate` first on a",
      "fresh database.",
    ].join("\n")
  )
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          strict: true,
          outDir: "dist",
          rootDir: "src",
          declaration: true,
        },
        include: ["src"],
      },
      null,
      2
    )
  )
  git(root, ["add", "."])
  git(root, ["commit", "-q", "-m", "initial project scaffolding"])

  // Four files, each evolving over ~10 commits. Each commit appends a
  // realistic block of code so `git log -p` has real bulk.
  const files = ["auth", "db", "server", "util"] as const
  const messagesByFile: Record<string, string[]> = {
    auth: [
      "add token verification middleware",
      "support refresh tokens",
      "reject expired tokens with a clear error",
      "cache the signing key lookup",
      "add a constant-time comparison for token secrets",
      "handle the missing-Authorization-header case",
      "log auth failures with the request id",
      "allow a configurable token lifetime",
      "tighten the audience claim check",
      "split verify and decode into separate helpers",
    ],
    db: [
      "add the Postgres connection pool",
      "add a query helper with parameter binding",
      "retry transient connection errors",
      "add a migration runner",
      "close idle connections on shutdown",
      "add a transaction helper",
      "surface slow queries in the log",
      "add an index on orders.status",
      "batch the reconciliation reads",
      "guard against pool exhaustion",
    ],
    server: [
      "wire up the express app and routes",
      "add request logging middleware",
      "add the orders create endpoint",
      "add the orders status endpoint",
      "return 400 on a malformed body",
      "add a health check route",
      "compress responses over a threshold",
      "add graceful shutdown handling",
      "rate-limit the create endpoint",
      "add the orders cancel endpoint",
    ],
    util: [
      "add an exponential backoff helper",
      "add a structured logger wrapper",
      "add a deadline-aware sleep",
      "add a small LRU cache",
      "add a typed environment-variable reader",
      "add a retry wrapper around async calls",
      "add a clock abstraction for tests",
      "add a redaction helper for secrets in logs",
      "add a deep-freeze utility",
      "add a chunk helper for batching",
    ],
  }

  for (let round = 0; round < 10; round++) {
    for (const f of files) {
      const path = join(root, "src", `${f}.ts`)
      // Append a plausible block — enough lines that a patch is bulky.
      const block = [
        ``,
        `// change ${round + 1}: ${messagesByFile[f][round]}`,
        `export function ${f}Step${round + 1}(input: string, attempt = 0): string {`,
        `  const normalized = input.trim().toLowerCase()`,
        `  if (normalized.length === 0) {`,
        `    throw new Error("${f}Step${round + 1}: empty input")`,
        `  }`,
        `  const tag = "${f}-" + (round_${round + 1}_constant())`,
        `  return normalized + ":" + tag + ":" + String(attempt)`,
        `}`,
        `function round_${round + 1}_constant(): number {`,
        `  return ${round + 1} * 7 + ${f.length}`,
        `}`,
      ].join("\n")
      // Append to whatever's there (file may not exist on round 0).
      const prior = round === 0 ? `// src/${f}.ts — part of fixture-service\n` : ""
      const { appendFile, readFile } = await import("node:fs/promises")
      if (round === 0) {
        await writeFile(path, prior + block + "\n")
      } else {
        const existing = await readFile(path, "utf-8")
        await appendFile(path, block + "\n")
        void existing
      }
      git(root, ["add", "."])
      git(root, ["commit", "-q", "-m", messagesByFile[f][round]])
    }
  }
  return root
}

async function main(): Promise<void> {
  const root = await buildFixture()
  const scratch = await mkdtemp(join(tmpdir(), "diane-mem-savings-store-"))

  // Ingest exactly as the plugin's prefill does.
  const repo = await MemoryRepository.load(scratch)
  const proj = await ingestProjectFacts(repo, root)
  const git_ = await ingestGitHistory(repo, root, 500)
  await repo.forceFlush()
  console.log(
    `\n  [fixture] ${git_.scanned} commits ingested → ${repo.size()} memories ` +
      `(${git_.commitMemories} commit, ${proj.facts} project-fact)`
  )

  // ── Case A: recent history of one file ────────────────────────────
  console.log("\n── token savings — A: history of a single file ───────────")
  {
    // Baseline: what an agent runs to learn a file's recent history.
    const baseline = cap(sh(root, "git", ["log", "-p", "--follow", "--", "src/auth.ts"]))
    const baselineTok = estTokens(baseline)

    // With plugin: a recall scoped to that file.
    const recall = repo.recallDetailed(
      { query: "auth token verification middleware", subject: "src/auth.ts", limit: 25, tokenBudget: 1200 },
      fmtHit
    )
    const withText = recall.hits.map(fmtHit).join("\n")
    const withTok = estTokens(withText)
    const ratio = withTok > 0 ? baselineTok / withTok : Infinity

    console.log(`    baseline (git log -p --follow src/auth.ts): ${baselineTok} tok`)
    console.log(`    with plugin (memory_recall scoped to file):  ${withTok} tok  (${recall.hits.length} hits)`)
    console.log(`    ratio: ${ratio.toFixed(1)}x cheaper`)

    assert(recall.hits.length > 0, "A: recall actually found the file's history")
    assert(withTok < baselineTok, "A: recall is cheaper than raw git log -p")
    assert(withTok * 2 < baselineTok, "A: recall is at least 2x cheaper than raw git log -p")
  }

  // ── Case B: what is this project / how is it built ────────────────
  console.log("\n── token savings — B: project facts vs reading configs ───")
  {
    // Baseline: read the files an agent reads to understand a project.
    const baselineParts = [
      sh(root, "cat", ["package.json"]),
      sh(root, "cat", ["tsconfig.json"]),
      sh(root, "cat", ["README.md"]),
    ]
    const baseline = cap(baselineParts.join("\n"))
    const baselineTok = estTokens(baseline)

    const recall = repo.recallDetailed(
      { query: "project build dependencies typescript service", category: "project-facts", limit: 25, tokenBudget: 1200 },
      fmtHit
    )
    const withText = recall.hits.map(fmtHit).join("\n")
    const withTok = estTokens(withText)
    const ratio = withTok > 0 ? baselineTok / withTok : Infinity

    console.log(`    baseline (cat package.json tsconfig.json README.md): ${baselineTok} tok`)
    console.log(`    with plugin (memory_recall project-facts):            ${withTok} tok  (${recall.hits.length} hits)`)
    console.log(`    ratio: ${ratio.toFixed(1)}x cheaper`)

    assert(recall.hits.length > 0, "B: recall found project facts")
    assert(withTok < baselineTok, "B: project-facts recall is cheaper than reading the config files")
  }

  // ── Case C: capstone — a realistic session, end to end ────────────
  console.log("\n── token savings — C: whole orientation, end to end ──────")
  {
    // Baseline: the discovery recipe an agent runs when dropped into
    // an unfamiliar repo — recent history + per-commit stat + reading
    // the entry point. This mirrors measure-savings.mjs's recipe.
    const baselineParts = [
      sh(root, "git", ["log", "--oneline", "-25"]),
      sh(root, "git", ["log", "--stat", "-8"]),
      sh(root, "cat", ["src/server.ts"]),
    ]
    const baselineTok = baselineParts.reduce((s, p) => s + estTokens(cap(p)), 0)

    // With plugin: the calls an agent makes instead — an outline plus
    // two recalls. Each recall is independently token-budgeted.
    const counts = repo.countsByCategory()
    const outline = Array.from(counts.entries())
      .map(([c, n]) => `${c}: ${n}`)
      .join("\n")
    const recall1 = repo.recallDetailed(
      { query: "orders endpoint server routes", limit: 25, tokenBudget: 1200 },
      fmtHit
    )
    const recall2 = repo.recallDetailed(
      { query: "database connection pool migration", limit: 25, tokenBudget: 1200 },
      fmtHit
    )
    const withTok =
      estTokens(outline) +
      estTokens(recall1.hits.map(fmtHit).join("\n")) +
      estTokens(recall2.hits.map(fmtHit).join("\n"))
    const ratio = withTok > 0 ? baselineTok / withTok : Infinity
    const savedPct = baselineTok > 0 ? (100 * (baselineTok - withTok)) / baselineTok : 0

    console.log(`    baseline (git log oneline+stat, cat entry point): ${baselineTok} tok`)
    console.log(`    with plugin (outline + 2 budgeted recalls):       ${withTok} tok`)
    console.log(`    ratio: ${ratio.toFixed(1)}x cheaper — ${savedPct.toFixed(0)}% fewer tokens`)

    assert(withTok < baselineTok, "C: a realistic memory session is cheaper than raw discovery")
    assert(savedPct > 25, "C: the end-to-end saving is a substantial fraction (>25%)")
  }

  // ── Case D: the plugin's own footprint stays bounded ──────────────
  // Honesty floor: a "saving" is only real if the WITH side can't run
  // away. Every recall is token-budgeted; verify the budget actually
  // holds, so no query can blow the context window.
  console.log("\n── token savings — D: recall footprint is bounded ────────")
  {
    const budget = 1200
    let worst = 0
    for (const q of [
      "auth token",
      "database connection retry",
      "server endpoint logging",
      "backoff retry helper",
      "everything orders reconciliation worker",
    ]) {
      const r = repo.recallDetailed({ query: q, limit: 60, tokenBudget: budget }, fmtHit)
      const tok = estTokens(r.hits.map(fmtHit).join("\n"))
      worst = Math.max(worst, tok)
    }
    // The budget is a soft target — the final hit can overshoot and
    // there's the omitted-marker — so allow generous slack but assert
    // it can't balloon. 2x the budget is the ceiling we hold.
    console.log(`    worst-case recall output across 5 queries: ${worst} tok  (budget ${budget})`)
    assert(worst < budget * 2, "D: recall output stays within ~2x its token budget — footprint can't run away")
  }

  await repo.close()
  await rm(root, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })

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
