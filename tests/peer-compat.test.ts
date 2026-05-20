/**
 * peer-compat.test.ts — pins the four-cell co-existence matrix:
 *
 *   ┌──────────────────────────┬─────────────┬──────────────────────┐
 *   │ scenario                 │ nudge hook  │ mined-skill subdirs  │
 *   ├──────────────────────────┼─────────────┼──────────────────────┤
 *   │ alone                    │ on          │ <slug>/              │
 *   │ + oh-my-opencode         │ OFF         │ diane-<slug>/        │
 *   │ + caveman                │ on          │ diane-<slug>/        │
 *   │ + both                   │ OFF         │ diane-<slug>/        │
 *   │ + peer, user overrode    │ as user set │ as user set          │
 *   └──────────────────────────┴─────────────┴──────────────────────┘
 *
 * The CRITICAL row is the first: standalone behaviour must stay
 * byte-for-byte the documented default. Compatibility code is only
 * allowed to act when a known peer is listed in opencode.json AND the
 * user hasn't pinned the relevant option themselves.
 *
 * Run: bun tests/peer-compat.test.ts
 */

import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { detectPeerPlugins } from "../src/utils/peer-detection.js"

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

/**
 * Write a project-local opencode.json with the given plugin array,
 * and return its containing root. The detector reads
 * `<root>/opencode.json` first (project-local takes precedence).
 */
async function projectWith(plugins: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diane-peers-"))
  await writeFile(
    join(root, "opencode.json"),
    JSON.stringify({ plugin: plugins }, null, 2),
    "utf-8",
  )
  return root
}

async function main(): Promise<void> {
  console.log("── peer-compat: detection ────────────────────────────────")

  // ── Detection ────────────────────────────────────────────────────
  // The detector reads `opencode.json` shapes that OpenCode itself
  // accepts: plain string, or [name, options] tuple, or {name: "..."}.
  // All three are exercised below; missing all three yields no peers.

  {
    const root = await projectWith(["opencode-diane"])
    const peers = detectPeerPlugins(root)
    assert(!peers.ohMyOpencode && !peers.caveman, "alone: no peer detected")
    assert(peers.found.length === 1 && peers.found[0] === "opencode-diane", "alone: ourselves are listed but not counted as a peer")
    await rm(root, { recursive: true, force: true })
  }

  {
    const root = await projectWith(["opencode-diane", "oh-my-opencode"])
    const peers = detectPeerPlugins(root)
    assert(peers.ohMyOpencode, "string entry: oh-my-opencode detected")
    assert(!peers.caveman, "string entry: caveman is not falsely detected")
    await rm(root, { recursive: true, force: true })
  }

  {
    // Newer rename — must still match.
    const root = await projectWith(["oh-my-openagent", "opencode-diane"])
    const peers = detectPeerPlugins(root)
    assert(peers.ohMyOpencode, "oh-my-openagent (the renamed package) detected")
    await rm(root, { recursive: true, force: true })
  }

  {
    // Slim fork — must also match.
    const root = await projectWith(["oh-my-opencode-slim", "opencode-diane"])
    const peers = detectPeerPlugins(root)
    assert(peers.ohMyOpencode, "oh-my-opencode-slim fork detected")
    await rm(root, { recursive: true, force: true })
  }

  {
    // Several caveman packages exist under different names. Match all.
    const root = await projectWith(["opencode-diane", "caveman-opencode-plugin"])
    const peers = detectPeerPlugins(root)
    assert(peers.caveman, "caveman-opencode-plugin detected")
    await rm(root, { recursive: true, force: true })
  }

  {
    const root = await projectWith(["opencode-diane", "caveman-opencode"])
    const peers = detectPeerPlugins(root)
    assert(peers.caveman, "caveman-opencode detected")
    await rm(root, { recursive: true, force: true })
  }

  {
    const root = await projectWith(["opencode-diane", "opencode-caveman"])
    const peers = detectPeerPlugins(root)
    assert(peers.caveman, "opencode-caveman detected (yet another packaging)")
    await rm(root, { recursive: true, force: true })
  }

  {
    // The in-repo plugin from JuliusBrussee/caveman is just named
    // "caveman" — match that too without false-positiving on, say,
    // a hypothetical "cavemania" package.
    const root = await projectWith(["caveman"])
    const peers = detectPeerPlugins(root)
    assert(peers.caveman, "bare 'caveman' (JuliusBrussee/caveman in-repo plugin) detected")
    await rm(root, { recursive: true, force: true })
  }

  {
    // Tuple entry: ["name", {options}] — common when a plugin takes
    // configuration. The detector must extract the name.
    const root = await projectWith([
      ["opencode-diane", { enableCodeMap: true }],
      ["caveman-opencode-plugin", { defaultMode: "full" }],
    ])
    const peers = detectPeerPlugins(root)
    assert(peers.caveman, "tuple-form plugin entries: name is extracted")
    await rm(root, { recursive: true, force: true })
  }

  {
    const root = await projectWith(["oh-my-opencode", "caveman-opencode-plugin"])
    const peers = detectPeerPlugins(root)
    assert(peers.ohMyOpencode && peers.caveman, "both peers detected together")
    await rm(root, { recursive: true, force: true })
  }

  {
    // Malformed config — must not throw, must return all-false.
    const root = await mkdtemp(join(tmpdir(), "diane-peers-bad-"))
    await writeFile(join(root, "opencode.json"), "{ not valid json {{", "utf-8")
    const peers = detectPeerPlugins(root)
    assert(!peers.ohMyOpencode && !peers.caveman, "malformed config: no peers, no throw")
    await rm(root, { recursive: true, force: true })
  }

  {
    // JSONC with comments — must parse after stripping.
    const root = await mkdtemp(join(tmpdir(), "diane-peers-jsonc-"))
    await writeFile(
      join(root, "opencode.jsonc"),
      `// project config
       {
         /* the diane plugin and caveman */
         "plugin": ["opencode-diane", "caveman-opencode-plugin"]
       }`,
      "utf-8",
    )
    const peers = detectPeerPlugins(root)
    assert(peers.caveman, "JSONC with // and /* */ comments: parses correctly")
    await rm(root, { recursive: true, force: true })
  }

  {
    // No opencode.json at all — must return all-false. This is the
    // standalone scenario for users who haven't created the file yet.
    const root = await mkdtemp(join(tmpdir(), "diane-peers-empty-"))
    const peers = detectPeerPlugins(root)
    assert(!peers.ohMyOpencode && !peers.caveman, "no opencode.json: no peers")
    assert(peers.found.length === 0, "no opencode.json: found list is empty")
    await rm(root, { recursive: true, force: true })
  }

  // ── Skill prefix round-trip ───────────────────────────────────────
  // The prefix has to be applied consistently at WRITE time (mineSkills)
  // and at READ time (readMinedSkills) — otherwise mining writes
  // `diane-foo/` and the next read can't find it. This is the contract
  // a peer can rely on.
  console.log("")
  console.log("── peer-compat: skill prefix round-trip ──────────────────")

  const { readMinedSkills } = await import("../src/mining/skill-miner.js")
  const skillRoot = await mkdtemp(join(tmpdir(), "diane-peer-skills-"))
  const skillsDir = ".opencode/skills"
  await mkdir(join(skillRoot, skillsDir, "diane-database-migrations"), { recursive: true })
  await writeFile(
    join(skillRoot, skillsDir, "diane-database-migrations", "SKILL.md"),
    "---\nname: database-migrations\ndescription: db migrations\n---\nbody",
    "utf-8",
  )
  await mkdir(join(skillRoot, skillsDir, "caveman-commit"), { recursive: true })
  await writeFile(
    join(skillRoot, skillsDir, "caveman-commit", "SKILL.md"),
    "---\nname: caveman-commit\ndescription: tiny commits\n---\nbody",
    "utf-8",
  )

  // Without prefix: surface everything (standalone behaviour).
  const allSkills = await readMinedSkills(skillRoot, skillsDir)
  assert(allSkills.length === 2, "no prefix: surfaces both diane- and peer skills (standalone)")

  // With "diane-" prefix: surface only ours. Caveman's slugs are
  // invisible to memory_skill, as they should be.
  const oursOnly = await readMinedSkills(skillRoot, skillsDir, "diane-")
  assert(oursOnly.length === 1, "with prefix: surfaces only diane- entries (1 of 2)")
  assert(
    oursOnly[0].slug === "diane-database-migrations",
    "with prefix: the right entry was kept",
  )

  await rm(skillRoot, { recursive: true, force: true })

  // ── done ─────────────────────────────────────────────────────────
  console.log("")
  console.log("──────────────────────────────────────────────────────────")
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
