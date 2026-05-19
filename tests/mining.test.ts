import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { MemoryRepository } from "../src/store/repository.js"
import { mineSkills } from "../src/mining/skill-miner.js"

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

async function main(): Promise<void> {
  console.log("\n── skill mining ──────────────────────────────────────────")
  const root = await mkdtemp(join(tmpdir(), "diane-mem-mine-"))
  const repo = await MemoryRepository.load(root)

  // Seed two clusters and one singleton
  for (let i = 0; i < 5; i++) {
    repo.insert({
      category: "git-history", subject: "auth/login.py",
      content: `Bugfix in commit ${i}: handle None password`,
      tags: ["bugfix", "auth"], source: `git:${i}`,
    })
  }
  for (let i = 0; i < 4; i++) {
    repo.insert({
      category: "git-history", subject: "billing/invoices.py",
      content: `Feature in commit ${i}: invoice template change`,
      tags: ["feature", "billing"], source: `git:b${i}`,
    })
  }
  repo.insert({
    category: "agent-note", subject: "lonely/file.py",
    content: "Singleton — should not become a skill",
    tags: [], source: "agent",
  })

  const res = await mineSkills(repo, root, ".opencode/skills", 3)
  assert(res.skillsWritten === 2, `wrote 2 skills (got ${res.skillsWritten})`)

  const skillDirs = await readdir(join(root, ".opencode/skills"))
  assert(skillDirs.length === 2, "two skill directories created")

  // Check one skill's structure
  const firstDir = skillDirs[0]
  const skillFile = join(root, ".opencode/skills", firstDir, "SKILL.md")
  await stat(skillFile) // throws if missing
  const text = await readFile(skillFile, "utf-8")
  assert(text.startsWith("---\n"), "skill file starts with YAML frontmatter")
  assert(/^name:\s+/m.test(text), "frontmatter has name")
  assert(/^description:\s+.+/m.test(text), "frontmatter has description")
  // OpenCode requires description ≥ 20 chars
  const descMatch = text.match(/^description:\s+(.+)$/m)
  assert((descMatch?.[1].length ?? 0) >= 20, "description meets ≥20 char OpenCode requirement")
  assert(/^license:\s+MIT/m.test(text), "frontmatter declares license")
  assert(/^compatibility:\s+opencode/m.test(text), "frontmatter declares compatibility")
  assert(text.includes("## When to use"), "body includes 'When to use' section")
  assert(text.includes("## Known patterns"), "body lists known patterns")
  assert(text.split("- ").length - 1 >= 3, "body has at least 3 bulleted entries")

  // Mining wrote one memory per skill into the store
  const minedCount = repo
    .allMemories()
    .filter((m) => m.category === "skill-mined").length
  assert(minedCount === 2, `${minedCount} skill-mined memories recorded`)

  await rm(root, { recursive: true, force: true })

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
}

main().catch((err) => { console.error(err); process.exit(2) })
