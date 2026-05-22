/**
 * project-notes.ts — ingest the small set of root-level files where
 * humans put house rules for AI agents.
 *
 * These are the files an agent should know about WITHIN THE FIRST
 * RECALL of a session: AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules,
 * .windsurfrules, COPILOT.md. They typically contain "in this repo,
 * always do X, never do Y, our naming convention is Z" — exactly the
 * kind of facts that, missed, lead to revert PRs.
 *
 * **Whole-file content, not headings.** Unlike `docs.ts` (which slices
 * into sections), these files are short (typically under 4 KB) and
 * their structure is rarely worth indexing — every line might be
 * load-bearing. One memory per file with the full content (truncated
 * to MAX_NOTE_BYTES) is the right granularity.
 *
 * **Root-level only.** No recursion. A `monorepo-package/.cursorrules`
 * is a per-package instruction that belongs to the package's owner,
 * not Diane.
 */

import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import type { MemoryRepository } from "../store/repository.js"

const CATEGORY = "project-facts"

/** The files we look for, with friendly display names. The list is
 *  intentionally conservative — only files that are conventionally
 *  written for human consumption by AI agents, not arbitrary config
 *  files. */
const NOTE_FILES: Array<{ name: string; label: string; tags: string[] }> = [
  { name: "AGENTS.md", label: "AGENTS.md (OpenCode agent instructions)", tags: ["agents", "opencode"] },
  { name: "CLAUDE.md", label: "CLAUDE.md (Claude Code instructions)", tags: ["claude-code", "anthropic"] },
  { name: "GEMINI.md", label: "GEMINI.md (Gemini Code instructions)", tags: ["gemini", "google"] },
  { name: "COPILOT.md", label: "COPILOT.md (GitHub Copilot instructions)", tags: ["copilot", "github"] },
  { name: "CONVENTIONS.md", label: "CONVENTIONS.md (project conventions)", tags: ["conventions"] },
  { name: ".cursorrules", label: ".cursorrules (Cursor IDE rules)", tags: ["cursor"] },
  { name: ".windsurfrules", label: ".windsurfrules (Windsurf rules)", tags: ["windsurf"] },
  { name: ".clinerules", label: ".clinerules (Cline agent rules)", tags: ["cline"] },
]

/** Truncate point. Most agent-instruction files are well under this;
 *  the few that aren't typically pad with examples or rationale that
 *  the agent can `read` directly if needed. We index the lede. */
const MAX_NOTE_BYTES = 6 * 1024

export interface ProjectNotesIngestOptions {
  maxBytes?: number
}

export interface ProjectNotesIngestResult {
  filesFound: number
}

export async function ingestProjectNotes(
  repo: MemoryRepository,
  root: string,
  opts: ProjectNotesIngestOptions = {},
): Promise<ProjectNotesIngestResult> {
  let filesFound = 0
  const maxBytes = Math.max(256, Math.round(opts.maxBytes ?? MAX_NOTE_BYTES))
  const allTags = new Set<string>(["agent-instructions", "house-rules"])

  for (const { name, label, tags } of NOTE_FILES) {
    const abs = join(root, name)
    let content: string
    try {
      const s = await stat(abs)
      if (!s.isFile()) continue
      const raw = await readFile(abs, "utf-8")
      content =
        raw.length > maxBytes
          ? raw.slice(0, maxBytes - 1).trimEnd() + "\n…[truncated; read the file directly for the rest]"
          : raw
    } catch {
      continue
    }

    filesFound += 1
    for (const t of tags) allTags.add(t)

    repo.insertIfMissing({
      category: CATEGORY,
      // `agent-instructions:<name>` is a stable subject the agent
      // can also match on directly with `memory_recall { query:
      // "agent instructions" }`.
      subject: `agent-instructions:${name}`,
      content: `${label}\n${"─".repeat(label.length)}\n${content}`,
      tags: ["agent-instructions", "house-rules", ...tags],
      source: "project-notes-ingest",
    })
  }

  // One summary memory: "this repo has these instruction files" — so
  // an agent that just ran a categorical recall ("what should I know
  // about this repo?") sees a directory of the instruction files at
  // a glance, even if none of the individual notes happened to match
  // its query keywords.
  if (filesFound > 0) {
    const present: string[] = []
    for (const { name } of NOTE_FILES) {
      try {
        const s = await stat(join(root, name))
        if (s.isFile()) present.push(name)
      } catch { /* not present */ }
    }
    repo.insertIfMissing({
      category: CATEGORY,
      subject: "agent-instructions:directory",
      content:
        `This repository has the following agent-instruction files in its root: ` +
        `${present.join(", ")}. These typically contain conventions, rules, and ` +
        `house style the agent should follow. Read them before making large changes.`,
      tags: Array.from(allTags),
      source: "project-notes-ingest",
    })
  }

  return { filesFound }
}
