/**
 * Skill miner — turns clusters of related memories into
 * OpenCode-compatible SKILL.md files.
 *
 * Clustering is deterministic and cheap: group memories by `subject`,
 * keep groups with at least `minCluster` entries (default 3), and
 * write one skill per such group. The skill description is built
 * from the subject + the most-used tags across the cluster, so it
 * triggers when the agent's task mentions the same area.
 *
 * Output: `<root>/<skillsOutputDir>/<slug>/SKILL.md`. Each file has
 * YAML frontmatter (name, description, license, compatibility,
 * metadata) followed by a bullet-list body summarising the cluster.
 */

import { mkdir, writeFile, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Memory } from "../types.js"
import type { MemoryRepository } from "../store/repository.js"

const MAX_BODY_BULLETS = 12
const MAX_SKILLS_PER_RUN = 30

/**
 * A skill file found on disk, parsed enough to surface in the
 * `memory_skill` tool. `body` is the SKILL.md content with the YAML
 * frontmatter stripped — the instructional part an agent actually
 * wants injected into context.
 */
export interface MinedSkillInfo {
  slug: string
  name: string
  description: string
  path: string
  body: string
  generatedByPlugin: boolean
}

/**
 * Read the skill files currently on disk under
 * `<root>/<skillsOutputDir>`. This is read FRESH on every call — it's
 * what lets the `memory_skill` tool surface skills written *after*
 * OpenCode started (e.g. by `memory_mine_skills` mid-session), which
 * OpenCode's own startup-time skill discovery cannot do.
 *
 * Tolerant by construction: a missing directory yields an empty list,
 * and an unreadable or frontmatter-less skill folder is skipped
 * rather than throwing. Never throws.
 *
 * `slugPrefix`, if non-empty, filters the results to subdirectories
 * whose name starts with the prefix — used when a coexisting plugin
 * (caveman, oh-my-opencode) writes its own skills into the shared
 * `.opencode/skills/` directory and we want to surface only ours.
 * Default `""` returns everything, matching the standalone behaviour.
 */
export async function readMinedSkills(
  root: string,
  skillsOutputDir: string,
  slugPrefix: string = "",
): Promise<MinedSkillInfo[]> {
  const base = join(root, skillsOutputDir)
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch {
    return [] // no skills directory yet — nothing mined
  }

  // When a prefix is configured we only surface subdirectories matching
  // it — peer plugins' subdirs (e.g. caveman's `caveman-commit/`) are
  // theirs to list, not ours.
  if (slugPrefix.length > 0) {
    entries = entries.filter((e) => e.startsWith(slugPrefix))
  }

  const out: MinedSkillInfo[] = []
  for (const slug of entries) {
    const path = join(base, slug, "SKILL.md")
    let raw: string
    try {
      raw = await readFile(path, "utf-8")
    } catch {
      continue // not a skill directory, or unreadable — skip
    }
    const parsed = parseSkillFile(raw)
    out.push({
      slug,
      name: parsed.name || slug,
      description: parsed.description || "(no description)",
      path,
      body: parsed.body,
      generatedByPlugin: parsed.generatedByPlugin,
    })
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug))
  return out
}

/**
 * Split a SKILL.md into its frontmatter-derived fields and its body.
 * Frontmatter is the block between the first two `---` lines; the body
 * is everything after. Deliberately a small hand parser — no YAML
 * dependency — because we only need `name` and `description`.
 */
function parseSkillFile(raw: string): {
  name: string
  description: string
  body: string
  generatedByPlugin: boolean
} {
  const lines = raw.split("\n")
  let name = ""
  let description = ""
  let generatedByPlugin = false
  let body = raw

  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1)
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line)
        if (!m) continue
        if (m[1] === "name") name = m[2].trim()
        else if (m[1] === "description") description = m[2].trim()
      }
      if (raw.includes("generated_by: opencode-diane")) generatedByPlugin = true
      body = lines
        .slice(end + 1)
        .join("\n")
        .trim()
    }
  }
  return { name, description, body, generatedByPlugin }
}

export interface MineResult {
  clustersConsidered: number
  skillsWritten: number
  writtenPaths: string[]
}

export async function mineSkills(
  repo: MemoryRepository,
  root: string,
  skillsOutputDir: string,
  minCluster: number,
  slugPrefix: string = "",
): Promise<MineResult> {
  const all = repo.allMemories()

  // ── Cluster by subject ─────────────────────────────────────────────
  const groups = new Map<string, Memory[]>()
  for (const m of all) {
    let list = groups.get(m.subject)
    if (!list) {
      list = []
      groups.set(m.subject, list)
    }
    list.push(m)
  }
  const candidates = Array.from(groups.entries()).filter(
    ([, ms]) => ms.length >= minCluster
  )

  // Order so the most signal-rich clusters get written first when we
  // hit the per-run cap.
  candidates.sort((a, b) => b[1].length - a[1].length)

  const writtenPaths: string[] = []
  let skillsWritten = 0
  const outputBase = join(root, skillsOutputDir)

  for (const [subject, members] of candidates) {
    if (skillsWritten >= MAX_SKILLS_PER_RUN) break
    const skill = buildSkill(subject, members)
    if (!skill) continue
    // Prefix the on-disk subdirectory name AND the memory-store subject
    // so peer plugins (caveman, oh-my-opencode) writing into the shared
    // `.opencode/skills/` directory don't collide with us, and the
    // subsequent `readMinedSkills(prefix)` round-trip finds the same
    // entries. Empty prefix is the standalone behaviour and the path
    // is byte-for-byte unchanged.
    const namespacedSlug = `${slugPrefix}${skill.slug}`
    const dir = join(outputBase, namespacedSlug)
    await mkdir(dir, { recursive: true })
    const path = join(dir, "SKILL.md")
    await writeFile(path, skill.content, "utf-8")
    // Record a memory pointing at the skill so future mining doesn't
    // re-emit the same one and the agent can find it via recall.
    repo.insertIfMissing({
      category: "skill-mined",
      subject: namespacedSlug,
      content:
        `Mined skill "${skill.name}" (description: ${skill.description}). ` +
        `Backed by ${members.length} memories on subject "${subject}". ` +
        `File: ${path.replace(root + "/", "")}`,
      tags: ["skill", skill.slug],
      source: `skill-miner:${skill.slug}`,
    })
    writtenPaths.push(path)
    skillsWritten += 1
  }

  return {
    clustersConsidered: candidates.length,
    skillsWritten,
    writtenPaths,
  }
}

interface BuiltSkill {
  slug: string
  name: string
  description: string
  content: string
}

function buildSkill(subject: string, members: Memory[]): BuiltSkill | null {
  const slug = toSlug(subject)
  if (!slug) return null
  const name = slug

  // Tag frequency
  const tagCount = new Map<string, number>()
  for (const m of members) {
    for (const t of m.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1)
  }
  const topTags = Array.from(tagCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, 6)

  // Description: 20+ char minimum required by OpenCode skill spec.
  const description = padDescription(
    `Recurring patterns and past actions associated with "${subject}". ` +
      `Use when the user's task mentions ${subject}` +
      (topTags.length > 0 ? ` or any of: ${topTags.slice(0, 4).join(", ")}.` : ".")
  )

  const bullets: string[] = []
  // Sort members by useCount desc so the most-relevant memories appear first.
  const sorted = members.slice().sort((a, b) => b.useCount - a.useCount)
  for (const m of sorted.slice(0, MAX_BODY_BULLETS)) {
    bullets.push(`- (${m.category}, source ${m.source}): ${oneLine(m.content)}`)
  }
  const omitted = members.length > MAX_BODY_BULLETS ? members.length - MAX_BODY_BULLETS : 0

  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "license: MIT",
    "compatibility: opencode",
    "metadata:",
    "  generated_by: opencode-diane",
    `  subject: "${escapeYaml(subject)}"`,
    `  cluster_size: ${members.length}`,
    `  top_tags: [${topTags.map((t) => `"${escapeYaml(t)}"`).join(", ")}]`,
    "---",
    "",
  ].join("\n")

  const body =
    `# ${name}\n\n` +
    `This skill was mined automatically from project memory: a cluster of ${members.length} entries on subject "${subject}".\n\n` +
    `## When to use\n\n` +
    `${description}\n\n` +
    `## Known patterns\n\n` +
    bullets.join("\n") +
    (omitted > 0 ? `\n- … and ${omitted} more entries\n` : "\n") +
    `\n## Source\n\n` +
    `Generated by \`opencode-diane\` skill miner. ` +
    `Backing memories live in \`.opencode/diane.json\` under subject ` +
    `\`${escapeYaml(subject)}\`. Re-run \`memory_mine_skills\` to refresh.\n`

  return { slug, name, description, content: frontmatter + body }
}

function toSlug(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

function padDescription(s: string): string {
  if (s.length >= 20) return s
  return s + " ".repeat(20 - s.length)
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 240)
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"')
}
