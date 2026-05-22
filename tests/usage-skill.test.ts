/**
 * usage-skill.test.ts — pins the soft-force adoption contract:
 *
 *   - First run with installUsageSkill: true → SKILL.md written.
 *   - Second run → file is preserved, NOT rewritten (so user edits
 *     and user deletions both survive correctly).
 *   - Wrong slugPrefix → write lands in the prefixed slug, not the
 *     unprefixed one (so peer-detection wiring is honoured).
 *   - Write failure → returns `"failed"` with the error, never
 *     throws.
 *
 * Run: bun tests/usage-skill.test.ts
 */

import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { installUsageSkill, USAGE_SKILL_SLUG } from "../src/utils/usage-skill.js"

let passed = 0
let failed = 0
const failures: string[] = []
function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

async function main(): Promise<void> {
  console.log("── usage-skill ───────────────────────────────────────────")

  // ── First-run install ────────────────────────────────────────────
  {
    const root = await mkdtemp(join(tmpdir(), "diane-usage-skill-"))
    const res = installUsageSkill(root, ".opencode/skills", "")
    assert(res.outcome === "installed", "first run: outcome is 'installed'")
    assert(
      res.path.endsWith(`/.opencode/skills/${USAGE_SKILL_SLUG}/SKILL.md`),
      "first run: path lands under the standalone (no-prefix) slug",
    )
    const content = await readFile(res.path, "utf-8")
    assert(content.includes("name: using-memory"), "SKILL.md carries the frontmatter name")
    assert(content.includes("memory_recall"), "SKILL.md mentions memory_recall — the primary tool")
    assert(content.includes("3-8 raw"), "SKILL.md quantifies the savings so the agent has a reason")
    assert(content.includes("delete it") || content.includes("Delete it") || content.includes("delete this file") || content.includes("Delete this file") || content.includes("installUsageSkill"), "SKILL.md tells the user how to opt out")
    await rm(root, { recursive: true, force: true })
  }

  // ── Second run preserves user edits ──────────────────────────────
  {
    const root = await mkdtemp(join(tmpdir(), "diane-usage-skill-preserve-"))
    const first = installUsageSkill(root, ".opencode/skills", "")
    assert(first.outcome === "installed", "preserve-test: first install succeeded")

    // Simulate a user editing the file.
    const customised = "---\nname: using-memory\ndescription: my override\n---\nmy custom text"
    await writeFile(first.path, customised, "utf-8")

    const second = installUsageSkill(root, ".opencode/skills", "")
    assert(second.outcome === "preserved", "second run: outcome is 'preserved' (file already existed)")
    const onDisk = await readFile(first.path, "utf-8")
    assert(onDisk === customised, "user edits survive the second startup byte-for-byte")
    await rm(root, { recursive: true, force: true })
  }

  // ── Peer-detection prefix wiring ─────────────────────────────────
  {
    const root = await mkdtemp(join(tmpdir(), "diane-usage-skill-prefix-"))
    const res = installUsageSkill(root, ".opencode/skills", "diane-")
    assert(res.outcome === "installed", "prefixed install succeeded")
    assert(
      res.path.endsWith(`/.opencode/skills/diane-${USAGE_SKILL_SLUG}/SKILL.md`),
      "with peer prefix: file lands at `.opencode/skills/diane-using-memory/SKILL.md`",
    )
    assert(
      !existsSync(join(root, ".opencode/skills", USAGE_SKILL_SLUG, "SKILL.md")),
      "with peer prefix: no unprefixed copy is written",
    )
    await rm(root, { recursive: true, force: true })
  }

  // ── Write failure returns 'failed', does not throw ───────────────
  // The plugin must not crash when the project root is read-only or
  // unreachable — installing a skill is best-effort. We simulate by
  // pointing at a root whose `.opencode` is actually a regular file,
  // so the recursive mkdirSync underneath blows up reliably (this is
  // less fragile than chmod, which root bypasses).
  {
    const root = await mkdtemp(join(tmpdir(), "diane-usage-skill-fail-"))
    await writeFile(join(root, ".opencode"), "not a directory", "utf-8")
    let threw = false
    let res
    try {
      res = installUsageSkill(root, ".opencode/skills", "")
    } catch {
      threw = true
    }
    assert(!threw, "write failure does not throw")
    assert(res?.outcome === "failed", "write failure outcome is 'failed'")
    assert(res?.error !== undefined, "write failure carries the underlying error for the caller to log")
    await rm(root, { recursive: true, force: true })
  }

  console.log("")
  console.log("──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

main().catch((err) => { console.error(err); process.exit(2) })
