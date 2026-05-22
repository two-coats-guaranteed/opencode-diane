/**
 * skill-activation.test.ts — proves a skill mined *during* a session
 * is usable in that same session, with no OpenCode restart.
 *
 * OpenCode discovers native skills only at startup, so a SKILL.md
 * written mid-session is invisible to the agent until the next
 * launch. The plugin closes that gap with the `memory_skill` tool:
 * registered once at init, it reads the skills directory FRESH on
 * every call, so it surfaces skills created after init — and it loads
 * a chosen skill's content into the live conversation via OpenCode's
 * `session.prompt` message-insertion pattern.
 *
 * The decisive assertion is the ordering one: the plugin (hence the
 * `memory_skill` tool) is built at T0; a skill is written at T1 > T0;
 * `memory_skill` finds and loads it at T2 > T1. A tool that only saw
 * startup-time skills could not do that.
 *
 * What this test can and can't prove: the filesystem half (discover +
 * read a skill written post-init) is verified directly and
 * deterministically. The injection half depends on OpenCode's
 * `client.session.prompt`, for which there is no server in a unit
 * test — so it's verified against a recording mock: we assert the
 * tool calls `session.prompt` with `noReply: true` and the skill's
 * body. That's the documented mechanism OpenCode's own native skills
 * use; the test confirms the plugin drives it correctly.
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { OpencodeDiane } from "../src/index.js"
import { MemoryRepository } from "../src/store/repository.js"
import { mineSkills, readMinedSkills } from "../src/mining/skill-miner.js"

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

/** A captured `session.prompt` call. */
interface PromptCall {
  path?: { id?: string }
  body?: { noReply?: boolean; parts?: Array<{ type?: string; text?: string }> }
}

/**
 * Mock OpenCode plugin context. `session.prompt` records its calls so
 * the test can check the injection payload — this is the stand-in for
 * a live OpenCode server.
 */
function mockCtx(directory: string, prompts: PromptCall[]) {
  return {
    client: {
      app: { log: async () => {} },
      session: {
        prompt: async (payload: PromptCall) => {
          prompts.push(payload)
          return {}
        },
      },
    },
    directory,
    worktree: directory,
    project: { id: "test" },
    $: null,
    serverUrl: new URL("http://localhost"),
    sessionID: "session-under-test",
  } as never
}

/** Write a SKILL.md directly — simulates a skill appearing mid-session. */
async function writeSkillFile(
  root: string,
  slug: string,
  name: string,
  description: string,
  body: string
): Promise<void> {
  const dir = join(root, ".opencode", "skills", slug)
  await mkdir(dir, { recursive: true })
  const content =
    `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\n` +
    `compatibility: opencode\nmetadata:\n  generated_by: opencode-diane\n---\n\n` +
    body
  await writeFile(join(dir, "SKILL.md"), content, "utf-8")
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "diane-mem-skillact-"))
  const prompts: PromptCall[] = []

  // ── T0: build the plugin. memory_skill is registered now. ─────────
  console.log("\n── skill activation: tool is registered ──────────────────")
  const hooks = await OpencodeDiane(mockCtx(root, prompts), { forceActive: true, installUsageSkill: false })
  const tools = hooks.tool ?? {}
  assert(typeof tools.memory_skill?.execute === "function", "memory_skill tool is registered")
  const skillTool = tools.memory_skill!

  // ── Before any skill exists: list is empty ────────────────────────
  console.log("\n── skill activation: nothing to list before mining ──────")
  {
    const listed = await skillTool.execute({}, { sessionID: "session-under-test" } as never)
    assert(
      typeof listed === "string" && listed.includes("no skills on disk"),
      "memory_skill reports an empty list before any skill exists"
    )
  }

  // ── T1: a skill appears AFTER the plugin was built ────────────────
  // This is the crux — the plugin (and its memory_skill tool) is
  // already constructed; the skill is created only now.
  console.log("\n── skill activation: skill written mid-session ───────────")
  await writeSkillFile(
    root,
    "auth-middleware",
    "auth-middleware",
    "Recurring patterns for the authentication middleware. Use for auth tasks.",
    "# auth-middleware\n\n## When to use\n\nAuth middleware work.\n\n## Known patterns\n\n- verify tokens in constant time\n- reject expired tokens early"
  )

  // ── T2: the freshly-written skill is discoverable — no restart ────
  {
    const listed = await skillTool.execute({}, { sessionID: "session-under-test" } as never)
    assert(
      typeof listed === "string" && listed.includes("auth-middleware"),
      "memory_skill LISTS a skill created after the plugin initialised (no restart)"
    )
  }

  // ── T2: loading the skill injects it into the live session ────────
  console.log("\n── skill activation: loading injects into the session ────")
  {
    const promptsBefore = prompts.length
    const loaded = await skillTool.execute(
      { name: "auth-middleware" },
      { sessionID: "session-under-test" } as never
    )
    assert(
      typeof loaded === "string" && loaded.includes("loaded into the session context"),
      "memory_skill LOAD reports the skill was loaded into context"
    )
    assert(prompts.length === promptsBefore + 1, "loading the skill made exactly one session.prompt call")
    const call = prompts[prompts.length - 1]
    assert(call.body?.noReply === true, "injection uses noReply:true (persists as a context message)")
    assert(
      call.path?.id === "session-under-test",
      "injection targets the calling session"
    )
    const text = call.body?.parts?.[0]?.text ?? ""
    assert(text.includes("verify tokens in constant time"), "the injected note carries the skill body")
    assert(text.includes("now active"), "the injected note announces the skill as active")
  }

  // ── Loading an unknown skill is graceful ──────────────────────────
  console.log("\n── skill activation: unknown skill is handled ────────────")
  {
    const missing = await skillTool.execute(
      { name: "does-not-exist" },
      { sessionID: "session-under-test" } as never
    )
    assert(
      typeof missing === "string" && missing.includes('no skill "does-not-exist"'),
      "loading an unknown skill returns a clear message, not an error"
    )
  }

  // ── readMinedSkills parses what mineSkills actually writes ────────
  // The mid-session path above used a hand-written SKILL.md; this
  // confirms the real miner's output is equally discoverable, so the
  // mine → memory_skill pipeline is end-to-end consistent.
  console.log("\n── skill activation: real mineSkills output is readable ──")
  {
    const minerStore = await mkdtemp(join(tmpdir(), "diane-mem-skillact-store-"))
    const minerRepo = await MemoryRepository.load(minerStore)
    // A cluster of ≥3 memories on one subject → one mined skill.
    for (let i = 0; i < 5; i++) {
      minerRepo.insertIfMissing({
        category: "git-history",
        subject: "src/db.ts",
        content: `Commit ${i}: change to the database connection pool, retry handling iteration ${i}.`,
        tags: ["database", "pool"],
        source: `git:commit${i}`,
      })
    }
    const mineRes = await mineSkills(minerRepo, root, ".opencode/skills", 3)
    assert(mineRes.skillsWritten >= 1, `mineSkills wrote a skill from the cluster (got ${mineRes.skillsWritten})`)

    // The miner wrote into the SAME skills dir the plugin reads.
    const all = await readMinedSkills(root, ".opencode/skills")
    const slugs = all.map((s) => s.slug)
    assert(slugs.includes("src-db-ts"), `mined skill is discoverable by readMinedSkills (slugs: ${slugs.join(", ")})`)

    // And loadable through the live tool, same session, no restart.
    const promptsBefore = prompts.length
    const loadedMined = await skillTool.execute(
      { name: "src-db-ts" },
      { sessionID: "session-under-test" } as never
    )
    assert(
      typeof loadedMined === "string" && loadedMined.includes("loaded into the session context"),
      "a skill produced by the real miner loads via memory_skill mid-session"
    )
    assert(prompts.length === promptsBefore + 1, "loading the mined skill injected it into the session")

    await minerRepo.close()
    await rm(minerStore, { recursive: true, force: true })
  }

  // ── memory_mine_skills no longer tells the agent to restart ───────
  console.log("\n── skill activation: mine tool points at in-session path ─")
  {
    const mineMsg = await tools.memory_mine_skills!.execute(
      { reason: "test" },
      { sessionID: "session-under-test" } as never
    )
    const msg = typeof mineMsg === "string" ? mineMsg : ""
    assert(
      !/restart opencode/i.test(msg) && /no restart/i.test(msg),
      "memory_mine_skills return text says no restart is needed (not 'restart OpenCode')"
    )
    assert(msg.includes("memory_skill"), "memory_mine_skills return text points at the memory_skill tool")
  }

  // Let the background prefill/mining settle before tearing the dir down.
  await new Promise((r) => setTimeout(r, 400))
  await rm(root, { recursive: true, force: true })

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
