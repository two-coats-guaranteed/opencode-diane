import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { MemoryRepository } from "../src/store/repository.js"
import { tokenize } from "../src/search/tokenize.js"

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

async function main(): Promise<void> {
  // ── tokenizer ──────────────────────────────────────────────────────
  console.log("\n── tokenize ──────────────────────────────────────────────")
  const t = tokenize("loginUser auth_service src/AuthService.py")
  assert(t.includes("login"), "splits camelCase")
  assert(t.includes("user"), "captures both camelCase halves")
  assert(t.includes("auth"), "splits snake_case")
  assert(t.includes("service"), "captures snake_case second half")
  assert(t.includes("py"), "captures file extension")
  assert(!t.includes("the"), "drops stopwords")

  // ── tokenizer: CJK (Chinese / Japanese / Korean) ──────────────────
  // CJK text has no word delimiters, so it is emitted as overlapping
  // bigrams. The old ASCII-only splitter discarded it entirely.
  console.log("\n── tokenize: CJK bigrams ─────────────────────────────────")
  const zh = tokenize("数据库连接")
  assert(zh.includes("数据") && zh.includes("据库"), "Chinese run → overlapping bigrams")
  assert(zh.includes("库连") && zh.includes("连接"), "all adjacent Chinese bigrams emitted")
  assert(zh.length === 4, `5-char Chinese run → 4 bigrams (got ${zh.length})`)
  assert(tokenize("中").length === 1, "a lone ideograph is kept as a single token")
  const mixed = tokenize("fix 数据库 bug")
  assert(
    mixed.includes("fix") && mixed.includes("bug"),
    "mixed text: Latin words still tokenised normally"
  )
  assert(
    mixed.includes("数据") && mixed.includes("据库"),
    "mixed text: the Chinese run is also bigrammed (not dropped)"
  )
  assert(
    tokenize("APIガイド").includes("ガイ"),
    "Japanese katakana run → bigrams"
  )
  assert(tokenize("로그인").includes("로그"), "Korean hangul run → bigrams")
  // A Chinese query overlaps a longer stored Chinese phrase via bigrams.
  const q = new Set(tokenize("数据库"))
  const doc = new Set(tokenize("修复数据库连接池超时"))
  assert(
    [...q].some((tok) => doc.has(tok)),
    "a Chinese query shares bigrams with a longer stored Chinese phrase"
  )

  // ── BM25 ranking ───────────────────────────────────────────────────
  console.log("\n── BM25 retrieval ────────────────────────────────────────")
  const root = await mkdtemp(join(tmpdir(), "diane-mem-search-"))
  const repo = await MemoryRepository.load(root)
  repo.insert({
    category: "git-history", subject: "auth/login.py",
    content: "Commit abc123 (bugfix): fixed login bug where password none crashed.",
    tags: ["bugfix", "auth"], source: "git:abc123",
  })
  repo.insert({
    category: "git-history", subject: "auth/login.py",
    content: "Commit def456 (feature): added 2FA flow to login screen.",
    tags: ["feature", "auth"], source: "git:def456",
  })
  repo.insert({
    category: "project-facts", subject: "file:Cargo.toml",
    content: "Cargo.toml is present. Structural summary: TOML — sections: [package], [dependencies]",
    tags: ["project-file", "Cargo.toml"], source: "project-ingest",
  })
  repo.insert({
    category: "agent-note", subject: "tests/test_login.py",
    content: "Tests for login use a fixture user with bcrypt-hashed password.",
    tags: ["auth", "tests"], source: "agent",
  })
  repo.insert({
    category: "git-history", subject: "billing/invoices.py",
    content: "Commit 111: changed invoice template.",
    tags: ["feature"], source: "git:111",
  })

  const hits = repo.recall({ query: "login password" })
  assert(hits.length > 0, "BM25 returns hits for relevant query")
  assert(
    hits[0].memory.content.toLowerCase().includes("login"),
    "top hit is login-related"
  )
  // The login-bug memory has both terms (login + password), should rank first
  const top = hits[0].memory.content.toLowerCase()
  assert(top.includes("password"), "top hit also contains 'password' (multi-term)")

  // Category filter narrows the candidate set
  const hits2 = repo.recall({ query: "login", category: "agent-note" })
  assert(hits2.length === 1, `category filter narrows hits (got ${hits2.length})`)
  assert(hits2[0].memory.category === "agent-note", "filter category matches")

  // Subject filter
  const hits3 = repo.recall({ query: "login", subject: "auth/login.py" })
  assert(hits3.length >= 2, "subject filter returns both auth/login.py entries")
  assert(hits3.every((h) => h.memory.subject === "auth/login.py"), "all hits match subject")

  // Unrelated query yields no hits
  const hits4 = repo.recall({ query: "kubernetes deployment helm chart" })
  assert(hits4.length === 0, "unrelated query returns no hits")

  // Limit honored
  const hits5 = repo.recall({ query: "commit", limit: 2 })
  assert(hits5.length <= 2, "limit caps hit count")

  // ── end-to-end: Chinese content is indexed and retrievable ────────
  // Proves the whole pipeline (tokenize → index → BM25) works for CJK,
  // not just the tokenizer in isolation.
  repo.insert({
    category: "git-history",
    subject: "数据库/连接池.go",
    content: "提交 a1b2c3：修复数据库连接池在高并发下的超时问题。",
    tags: ["bugfix"],
    source: "git:a1b2c3",
  })
  repo.insert({
    category: "git-history",
    subject: "认证/登录.go",
    content: "提交 d4e5f6：为登录流程添加双因素认证。",
    tags: ["feature"],
    source: "git:d4e5f6",
  })
  const zhHits = repo.recall({ query: "数据库连接池" })
  assert(zhHits.length > 0, "a Chinese query retrieves Chinese memories (was impossible before)")
  assert(
    zhHits[0].memory.content.includes("数据库连接池"),
    "the relevant Chinese memory is the top hit"
  )
  // A Chinese query must not pull in the unrelated Chinese memory above it.
  const loginZh = repo.recall({ query: "双因素认证" })
  assert(
    loginZh.length > 0 && loginZh[0].memory.content.includes("双因素认证"),
    "Chinese ranking discriminates — the 2FA query tops the 2FA memory"
  )

  await rm(root, { recursive: true, force: true })

  // ── recall: prefer intent lean (query-dependent ranking) ──────────
  console.log("\n── recall: prefer intent lean ────────────────────────────")
  const pRoot = await mkdtemp(join(tmpdir(), "diane-search-prefer-"))
  const pRepo = await MemoryRepository.load(pRoot)
  // Two memories with identical content — one in a test path, one not.
  pRepo.insert({
    category: "code-map", subject: "src/auth.go",
    content: "authenticate user login session token validation", tags: [], source: "p1",
  })
  pRepo.insert({
    category: "code-map", subject: "tests/auth_test.go",
    content: "authenticate user login session token validation", tags: [], source: "p2",
  })

  const neutral = pRepo.recall({ query: "authenticate user login" })
  assert(neutral.length === 2, "prefer: both memories match the query when neutral")

  const codeLean = pRepo.recall({ query: "authenticate user login", prefer: "code" })
  assert(
    codeLean[0]?.memory.subject === "src/auth.go",
    "prefer:code ranks the implementation file above an equal-content test file"
  )

  const testLean = pRepo.recall({ query: "authenticate user login", prefer: "tests" })
  assert(
    testLean[0]?.memory.subject === "tests/auth_test.go",
    "prefer:tests ranks the test file first"
  )

  // prefer:"any" must skip the lean entirely. Compare ordering, not
  // absolute scores: every recall bumps useCount (which feeds score),
  // so scores drift between calls — but the *order* is the invariant.
  const noPrefer = pRepo.recall({ query: "authenticate user login" })
  const anyLean = pRepo.recall({ query: "authenticate user login", prefer: "any" })
  assert(
    noPrefer.map((h) => h.memory.subject).join(",") ===
      anyLean.map((h) => h.memory.subject).join(",") && anyLean.length > 0,
    "prefer:any leaves ranking identical to omitting prefer"
  )

  // The careful property: prefer:code is a LEAN, not a filter. A test
  // file that is a far stronger textual match still wins under it —
  // because sometimes the test really is what you want.
  pRepo.insert({
    category: "code-map", subject: "tests/parser_test.go",
    content: "parse grammar tokens parse grammar tokens parse grammar tokens", tags: [], source: "p3",
  })
  pRepo.insert({
    category: "code-map", subject: "src/util.go",
    content: "parse helper", tags: [], source: "p4",
  })
  const strong = pRepo.recall({ query: "parse grammar tokens", prefer: "code" })
  assert(
    strong[0]?.memory.subject === "tests/parser_test.go",
    "prefer:code is a lean not a filter — a far stronger test match still wins"
  )

  // history lean: an exact-tie git-history memory is lifted to the top.
  pRepo.insert({
    category: "git-history", subject: "src/auth.go",
    content: "authenticate user login session token validation", tags: [], source: "p5",
  })
  const histLean = pRepo.recall({ query: "authenticate user login", prefer: "history" })
  assert(
    histLean[0]?.memory.category === "git-history",
    "prefer:history lifts a change-history memory above equal-scoring others"
  )

  await pRepo.close()
  await rm(pRoot, { recursive: true, force: true })

  // ── token budget on recall (#3) ────────────────────────────────────
  console.log("\n── token budget ──────────────────────────────────────────")
  const bRoot = await mkdtemp(join(tmpdir(), "diane-search-budget-"))
  const bRepo = await MemoryRepository.load(bRoot)
  for (let i = 0; i < 20; i++) {
    bRepo.insert({
      category: "git-history",
      subject: `file-${i}.ts`,
      content: `Commit abc${i}: changed parsing logic and updated the handler for file-${i}.ts`,
      tags: ["single-file"],
      source: `git:abc${i}`,
    })
  }
  const fmt = (h: { memory: { category: string; subject: string; content: string }; score: number }): string =>
    `[${h.memory.category} | ${h.memory.subject} | score ${h.score.toFixed(2)}] ${h.memory.content}`
  const estTok = (s: string): number => Math.ceil(s.length / 4)

  const unbudgeted = bRepo.recallDetailed({ query: "parsing handler", limit: 25 }, fmt)
  assert(unbudgeted.omitted === 0, "no budget → nothing omitted")
  assert(unbudgeted.hits.length > 3, "no budget → many hits returned")

  const budgeted = bRepo.recallDetailed({ query: "parsing handler", limit: 25, tokenBudget: 80 }, fmt)
  const budgetedTokens = budgeted.hits.reduce((s, h) => s + estTok(fmt(h)), 0)
  assert(budgetedTokens <= 95, `budget 80 respected (~${budgetedTokens} tokens of hits)`)
  assert(budgeted.hits.length < unbudgeted.hits.length, "budget drops some hits")
  assert(
    budgeted.omitted === unbudgeted.hits.length - budgeted.hits.length,
    "omitted count is accurate"
  )
  assert(budgeted.hits.length >= 1, "budget always keeps at least one hit")

  // Oversized sole hit gets content-truncated to respect the ceiling.
  bRepo.insert({
    category: "code-map",
    subject: "huge.ts",
    content: "X".repeat(4000),
    tags: ["code-map"],
    source: "tree-sitter:code-map",
  })
  const tiny = bRepo.recallDetailed({ query: "huge.ts", limit: 5, tokenBudget: 50 }, fmt)
  assert(tiny.hits.length === 1, "oversized sole hit still returned")
  assert(estTok(fmt(tiny.hits[0])) <= 80, "oversized sole hit is truncated toward the budget")

  // useCount bumps the REAL stored memory even when a clone was returned.
  const realHuge = bRepo.allMemories().find((m) => m.subject === "huge.ts")
  assert(realHuge !== undefined && realHuge.useCount > 0, "truncated hit still bumps real memory useCount")

  await rm(bRoot, { recursive: true, force: true })

  // ── co-change graph boost (#4) ─────────────────────────────────────
  console.log("\n── co-change graph boost ─────────────────────────────────")
  const cRoot = await mkdtemp(join(tmpdir(), "diane-search-cochange-"))
  const cRepo = await MemoryRepository.load(cRoot)
  // maker.py — matches the query textually
  for (let i = 0; i < 3; i++) {
    cRepo.insert({
      category: "git-history",
      subject: "src/maker.py",
      content: `Commit mk${i}: changed maker parsing rules`,
      tags: ["single-file", "src/maker.py"],
      source: `git:mk${i}`,
    })
  }
  // detector.py — does NOT contain "parsing"; only reachable via co-change
  for (let i = 0; i < 2; i++) {
    cRepo.insert({
      category: "git-history",
      subject: "src/detector.py",
      content: `Commit dt${i}: detector gender tweak`,
      tags: ["single-file", "src/detector.py"],
      source: `git:dt${i}`,
    })
  }
  // unrelated.py — contains "parsing" but has no co-change edge
  cRepo.insert({
    category: "git-history",
    subject: "src/unrelated.py",
    content: "Commit ur0: unrelated parsing change",
    tags: ["single-file", "src/unrelated.py"],
    source: "git:ur0",
  })
  // the co-change edge maker.py <-> detector.py
  cRepo.insert({
    category: "git-history",
    subject: "co-change:src/maker.py",
    content: "src/maker.py and src/detector.py were modified together in 5 commits — likely coupled.",
    tags: ["co-change", "src/maker.py", "src/detector.py"],
    source: "git:co-occurrence",
  })

  const ccHits = cRepo.recall({ query: "parsing", limit: 20 })
  const ccSubjects = new Set(ccHits.map((h) => h.memory.subject))
  assert(ccSubjects.has("src/maker.py"), "co-change: textual match (maker.py) still surfaces")
  assert(
    ccSubjects.has("src/detector.py"),
    "co-change: coupled file (detector.py) surfaces despite no textual match"
  )
  // a textual match must still outrank a purely co-change-surfaced hit
  const makerRank = ccHits.findIndex((h) => h.memory.subject === "src/maker.py")
  const detectorRank = ccHits.findIndex((h) => h.memory.subject === "src/detector.py")
  assert(
    makerRank >= 0 && detectorRank >= 0 && makerRank < detectorRank,
    "co-change: direct textual match outranks the co-change-boosted file"
  )

  // with no co-change edges at all, nothing extra is pulled in
  const cRoot2 = await mkdtemp(join(tmpdir(), "diane-search-nocochange-"))
  const cRepo2 = await MemoryRepository.load(cRoot2)
  cRepo2.insert({
    category: "git-history",
    subject: "a.py",
    content: "Commit: parsing change in a.py",
    tags: ["a.py"],
    source: "git:a",
  })
  cRepo2.insert({
    category: "git-history",
    subject: "b.py",
    content: "Commit: unrelated b.py change",
    tags: ["b.py"],
    source: "git:b",
  })
  const noEdgeHits = cRepo2.recall({ query: "parsing" })
  assert(
    noEdgeHits.length === 1 && noEdgeHits[0].memory.subject === "a.py",
    "no co-change edges → only textual matches, no spurious pull-in"
  )

  await rm(cRoot, { recursive: true, force: true })
  await rm(cRoot2, { recursive: true, force: true })

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(2) })
