/**
 * docs.ts — ingest project documentation as recallable section
 * pointers.
 *
 * The premise: long-form docs are something the agent can already
 * `read`; what it can't do is *find* the right section to read in a
 * 30-file `docs/` tree without grepping the whole thing first. This
 * ingester emits one memory per heading (H1/H2/H3) with the heading
 * text, the first paragraph of body, and `path:line` so a
 * `memory_recall { query: "installation" }` returns
 *
 *     docs/install.md:15  ## Installation
 *     This project uses bun. Run `bun install` …
 *
 * — a direct pointer the agent can act on without any directory walk.
 *
 * **Scope** (deliberately conservative — see the design notes at the
 * bottom for what was considered and rejected):
 *
 *   - Walks `<root>/docs/` recursively for `*.md` and `*.markdown`.
 *   - Adds a fixed set of conventional root-level docs files (the
 *     `ROOT_DOCS` list — CHANGELOG, CONTRIBUTING, ARCHITECTURE, …).
 *   - Skips README.md — that's handled by the project ingester for
 *     the headline paragraph, and full-file ingestion of READMEs
 *     would create duplicate entries for the same content.
 *   - Skips dotfiles, `node_modules`, `.git`, and the standard
 *     SKIP_DIRS used by every other ingester.
 *   - Caps headings per file to prevent a runaway TOC, and caps
 *     files walked to prevent a runaway monorepo. Both caps are
 *     intentionally generous; the goal is "doesn't blow up on a 500-
 *     file vendored docs tree" not "hits a tight budget."
 *
 * **Granularity choice — one memory per heading, not per file.**
 * Per-file would mean recall returns "docs/api.md mentions install"
 * — true but useless, the agent still has to read the file. Per-
 * heading returns the SECTION, which is the actionable unit. Costs
 * a small memory-table inflation that's bounded by the cap.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"

import type { MemoryRepository } from "../store/repository.js"

/** Categories existing memories already use; reusing `project-facts`
 *  keeps the docs entries discoverable by the same `category` filter
 *  the agent reaches for when it wants "facts about this repo." A new
 *  category would just split a single mental model into two. */
const CATEGORY = "project-facts"

/** Directories the project ingester also skips. Mirrored here so
 *  walking a repo's `docs/` doesn't accidentally descend into a
 *  vendored copy under `docs/node_modules` etc. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  "coverage",
  ".cache",
  "vendor",
])

/** Conventional root-level markdown files that aren't the README and
 *  aren't agent-instruction files (those go to project-notes.ts).
 *  Each one is checked at the root only — no recursion. */
const ROOT_DOCS = [
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "ARCHITECTURE.md",
  "ROADMAP.md",
  "TODO.md",
  "HISTORY.md",
  "NOTES.md",
  "SECURITY.md",
  "GOVERNANCE.md",
  "MAINTAINERS.md",
  "AUTHORS.md",
  "CODE_OF_CONDUCT.md",
]

/** Headings deeper than this are typically internal section markers
 *  inside a long doc — useful inside the file, but rarely worth a
 *  top-level recall pointer. H1/H2/H3 only. */
const MAX_HEADING_LEVEL = 3

/** Per-file cap — most docs have under 30 H1-H3 headings; a file
 *  with more is almost certainly auto-generated. */
const MAX_HEADINGS_PER_FILE = 50

/** Hard cap on files walked in one ingest pass. Bounded walk so a
 *  500-file vendored docs tree can't stall startup. */
const MAX_FILES = 200

/** Skip files larger than this — typically auto-generated catalogs
 *  with no manually-authored structure worth recalling. */
const MAX_FILE_BYTES = 256 * 1024

/** Bytes of body following a heading to capture as context — enough
 *  for one decent paragraph, not so much that 50 headings turn into
 *  a wall of duplicated prose. */
const BODY_CHARS = 240

export interface DocsIngestOptions {
  maxFiles?: number
  bodyChars?: number
  maxHeadingLevel?: number
}

export interface DocsIngestResult {
  filesWalked: number
  headingsIndexed: number
}

export async function ingestDocs(
  repo: MemoryRepository,
  root: string,
  opts: DocsIngestOptions = {},
): Promise<DocsIngestResult> {
  const maxFilesLimit  = Math.max(1, Math.round(opts.maxFiles  ?? MAX_FILES))
  const bodyCharsLimit = Math.max(40, Math.round(opts.bodyChars ?? BODY_CHARS))
  const maxLevel       = Math.min(6, Math.max(1, Math.round(opts.maxHeadingLevel ?? MAX_HEADING_LEVEL)))
  let filesWalked = 0
  let headingsIndexed = 0

  const add = (subject: string, content: string, tags: string[]): void => {
    repo.insertIfMissing({
      category: CATEGORY,
      subject,
      content,
      tags,
      source: "docs-ingest",
    })
    headingsIndexed += 1
  }

  const seen = new Set<string>()

  // ── 1. <root>/docs/ recursive walk ────────────────────────────────
  const docsDir = join(root, "docs")
  if (await isDirectory(docsDir)) {
    const stack = [docsDir]
    while (stack.length > 0 && filesWalked < maxFilesLimit) {
      const dir = stack.pop()!
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue
        const abs = join(dir, e.name)
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) stack.push(abs)
          continue
        }
        if (!e.isFile()) continue
        if (!isMarkdown(e.name)) continue
        if (seen.has(abs)) continue
        seen.add(abs)
        filesWalked += 1
        if (filesWalked > maxFilesLimit) break
        await ingestOneFile(abs, root, add, MAX_HEADINGS_PER_FILE, bodyCharsLimit, maxLevel)
      }
    }
  }

  // ── 2. Root-level conventional docs ───────────────────────────────
  for (const name of ROOT_DOCS) {
    if (filesWalked >= maxFilesLimit) break
    const abs = join(root, name)
    if (seen.has(abs)) continue
    if (!(await isFile(abs))) continue
    seen.add(abs)
    filesWalked += 1
    await ingestOneFile(abs, root, add, MAX_HEADINGS_PER_FILE, bodyCharsLimit, maxLevel)
  }

  return { filesWalked, headingsIndexed }
}

/** Read one .md file and emit one memory per heading (H1-H3, capped). */
async function ingestOneFile(
  abs: string,
  root: string,
  add: (subject: string, content: string, tags: string[]) => void,
  maxHeadings: number,
  bodyChars: number,
  maxLevel: number,
): Promise<void> {
  let raw: string
  try {
    const s = await stat(abs)
    if (s.size > MAX_FILE_BYTES) return
    raw = await readFile(abs, "utf-8")
  } catch {
    return
  }

  const rel = relative(root, abs).split(sep).join("/")
  const lines = raw.split("\n")
  const headings = extractHeadings(lines, maxLevel)
  if (headings.length === 0) return

  // Filename without ".md" → tag candidate ("install", "architecture").
  const fileTag = rel.replace(/\.md$|\.markdown$/i, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()

  let emitted = 0
  for (const h of headings) {
    if (emitted >= maxHeadings) break
    const body = readFollowingBody(lines, h.lineIdx, headings, bodyChars)
    const slug = toSlug(h.text)
    const subject = `docs:${rel}#${slug || `line-${h.line}`}`
    const headingTags = h.text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 5)
    add(
      subject,
      // `path:line` so the agent has a precise pointer it can pass
      // to OpenCode's `read` tool, plus the heading and first paragraph
      // so a recall snippet alone often answers the question.
      `${rel}:${h.line}  ${"#".repeat(h.level)} ${h.text}` +
        (body ? `\n${body}` : ""),
      ["docs", "section", fileTag, ...headingTags],
    )
    emitted += 1
  }
}

interface Heading {
  level: number
  text: string
  line: number // 1-indexed
  lineIdx: number // 0-indexed
}

/** Parse H1-H3 ATX headings (`# `, `## `, `### `). Setext-style
 *  underline headings (`Foo\n===`) are not parsed — rare in modern
 *  projects and supporting them isn't worth the parser complexity. */
function extractHeadings(lines: string[], maxHeadingLevel: number = MAX_HEADING_LEVEL): Heading[] {
  const out: Heading[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Track fenced code blocks so `# comment` inside a code block
    // doesn't get parsed as a heading.
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const level = m[1].length
    if (level > maxHeadingLevel) continue
    const text = m[2].trim()
    if (text.length === 0) continue
    out.push({ level, text, line: i + 1, lineIdx: i })
  }
  return out
}

/** Capture the first ~BODY_CHARS of non-empty, non-heading prose
 *  following a heading, up to the next heading. Skip code fences
 *  (their contents add noise to BM25 without helping the recall
 *  signal). Returns "" if no body is present. */
function readFollowingBody(lines: string[], headingIdx: number, headings: Heading[], bodyChars: number = BODY_CHARS): string {
  const nextHeadingIdx = headings.find((h) => h.lineIdx > headingIdx)?.lineIdx ?? lines.length
  const buf: string[] = []
  let bytes = 0
  let inFence = false
  for (let i = headingIdx + 1; i < nextHeadingIdx; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      if (buf.length > 0) break // we have one paragraph, stop
      continue
    }
    buf.push(trimmed)
    bytes += trimmed.length + 1
    if (bytes >= bodyChars) break
  }
  const joined = buf.join(" ")
  return joined.length > bodyChars ? joined.slice(0, bodyChars - 1) + "…" : joined
}

/** Heading → slug for the memory subject. Keeps the memory subject
 *  stable across re-runs (a heading edit creates a new subject; the
 *  old one decays via the existing pruning rules). */
function toSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

function isMarkdown(name: string): boolean {
  // Pure extension check. The ROOT README is implicitly excluded
  // because (a) the recursive walk only descends `<root>/docs/`,
  // never the project root, and (b) the conventional-root-docs list
  // (`ROOT_DOCS`) doesn't list README. A README INSIDE docs/ — like
  // `docs/README.md`, the typical docs-index file — is fine to walk.
  return /\.(md|markdown)$/i.test(name)
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isFile()
  } catch {
    return false
  }
}

/* ── Design notes (kept here on purpose) ─────────────────────────────
 *
 * Things considered and rejected:
 *
 *   - Walking *all* .md files under `<root>/`: too noisy in repos
 *     that vendor docs (e.g. translations of foreign-language READMEs,
 *     license texts under packages/). The convention is docs/, and
 *     ROOT_DOCS handles the rest.
 *
 *   - Indexing the FULL prose of each section: blows up the memory
 *     store, and recall already has the path:line pointer for the
 *     agent to read the rest on demand. First paragraph is the right
 *     balance between "snippet alone often answers" and "doesn't
 *     duplicate the whole file."
 *
 *   - Tracking heading hierarchy (e.g. "H2 Install > H3 Linux"):
 *     would be valuable but doubles the snippet length and changes
 *     the recall ranking in ways I don't want to assess without
 *     measurement. Punted.
 *
 *   - Honouring Markdown links / TOCs: a real outline parser is
 *     ~200 lines and the cost-benefit is poor — the heading itself
 *     is the actionable token; the link target the agent can grep
 *     for if needed.
 * ────────────────────────────────────────────────────────────────────
 */
