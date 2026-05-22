/**
 * usage-skill.ts — soft-forces the agent to actually USE Diane.
 *
 * OpenCode discovers any `.opencode/skills/<name>/SKILL.md` in the
 * project and surfaces its content to the agent at session start, so
 * a skill file is the highest-signal place to put "here's how to use
 * this plugin, here's when to call which tool" instructions. This
 * module writes that file at plugin startup.
 *
 * **Soft, not hard.** The skill is installed ONLY when the file does
 * not already exist, so a user can:
 *   - delete the file to remove the nudge (it won't come back unless
 *     they re-enable installation explicitly with a fresh repo),
 *   - edit the file to customise the wording (their edits survive
 *     every subsequent startup),
 *   - set `installUsageSkill: false` to never write it at all.
 *
 * The skill content is fixed text (no codegen, no templating) so the
 * agent's instructions don't churn version-over-version.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** Subdirectory name relative to `skillsOutputDir`. The prefix
 *  (`""` standalone, `"diane-"` when a peer plugin is detected) is
 *  applied at the call site so this stays one name in one place. */
export const USAGE_SKILL_SLUG = "using-memory"

/** Filename inside the slug directory. OpenCode's skill discovery
 *  expects this name; do not rename. */
const SKILL_FILENAME = "SKILL.md"

/**
 * Skill content surfaced to the agent. Hand-tuned wording — short,
 * directive, ordered by what the agent does first.
 *
 * Three design notes for future editors:
 *   1. Lead with the workflow, not the architecture. The agent needs
 *      to know *what to do first*, not *how the recall is scored*.
 *   2. Quantify the savings ("typically replaces 3-8 raw calls") so
 *      the agent has a concrete reason to choose recall over grep.
 *   3. Keep the tool list flat. Every line is one tool, one purpose;
 *      do not group or nest, the agent reads this fast.
 */
function skillContent(): string {
  return `---
name: using-memory
description: ALWAYS call memory_recall before raw code discovery (grep, glob, read). The opencode-diane plugin keeps a persistent searchable store of this repo's structure, git history, project facts, and past sessions — a single recall typically replaces 3-8 raw discovery calls.
---

# Using opencode-diane's memory

This project has the \`opencode-diane\` plugin loaded. It keeps a
persistent, searchable store of structural facts about this repo so
the same things don't have to be re-discovered every session.

## Workflow — do this in order

For ANY task that touches existing code, your first step is **always**:

1. **\`memory_recall { query: "<what you're looking for>" }\`** — a
   single recall typically replaces 3-8 raw \`grep\`/\`glob\`/\`read\`
   calls. The store already knows the code map, git history, project
   facts, and lessons from past sessions in this repo. Try it first;
   only fall back to raw discovery if it returns nothing relevant.

2. **Targeted file reads** — after recall, \`read\` only the specific
   files the recall pointed at. Skip directory-wide grepping unless
   recall came up dry.

3. **\`memory_remember { content: "..." }\`** — when you discover
   something worth keeping (an invariant, a non-obvious connection,
   a file you'll touch again), save it so the next session inherits
   the finding instead of re-deriving it.

## Tools available

- \`memory_recall\` — query the store. **Call this first.**
- \`memory_status\` — store size, last-ingest times, plugin version.
  Useful to confirm the plugin is actually loaded.
- \`memory_remember\` — save a fact for future sessions.
- \`memory_code_map\` — tree-sitter signatures for any file or
  directory; the structural shape of the codebase.
- \`memory_outline\` — compact outline of one file.
- \`memory_ingest_sessions\` — pull lessons from past OpenCode sessions.
- \`memory_ingest_code_health\` — lint/typecheck/test signal as
  memories.
- \`memory_mine_skills\` — distill recurring task patterns into
  \`SKILL.md\` files.
- \`memory_skill\` — read one mined skill.

## When NOT to use memory

- Trivial one-off file reads (\`read package.json\`) — skip recall.
- Writing brand-new code with no existing context — recall first
  anyway, but the answer may be empty; that's fine.

This skill file was written by the plugin on first install. Delete it
to remove the nudge; edit it to customise; set
\`installUsageSkill: false\` in your \`opencode.json\` to never write
it at all.
`
}

/**
 * Write the SKILL.md if (and only if) it does not already exist.
 * Returns one of three outcomes for the caller to log:
 *
 *   - "installed"  — file did not exist; we wrote it.
 *   - "preserved"  — file already exists; we left it alone (user
 *                    customisation, or already installed).
 *   - "failed"     — write threw (read-only project root, etc.);
 *                    the error is returned so the caller logs it.
 *                    Never propagates: a failed soft-force is a
 *                    quality-of-life regression, not a reason to
 *                    crash the plugin.
 */
export function installUsageSkill(
  root: string,
  skillsOutputDir: string,
  slugPrefix: string,
): { outcome: "installed" | "preserved" | "failed"; path: string; error?: unknown } {
  const slug = `${slugPrefix}${USAGE_SKILL_SLUG}`
  const dir = join(root, skillsOutputDir, slug)
  const path = join(dir, SKILL_FILENAME)

  if (existsSync(path)) {
    return { outcome: "preserved", path }
  }

  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, skillContent(), "utf-8")
    return { outcome: "installed", path }
  } catch (error) {
    return { outcome: "failed", path, error }
  }
}
