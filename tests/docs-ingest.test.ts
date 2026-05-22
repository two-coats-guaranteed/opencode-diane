/**
 * docs-ingest.test.ts — pins the markdown ingester's behaviour:
 *
 *   - Walks `<root>/docs/` recursively for .md files.
 *   - Picks up conventional root-level docs (CHANGELOG.md etc.) and
 *     skips README (owned by the project ingester).
 *   - Emits one memory per H1/H2/H3 heading with the path:line
 *     pointer and the first paragraph as snippet.
 *   - Caps headings per file and total files walked.
 *   - Skips dotfiles, node_modules, and large files.
 *   - Doesn't treat `#` inside fenced code blocks as headings.
 */

import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ingestDocs } from "../src/ingest/docs.js"
import { MemoryRepository } from "../src/store/repository.js"

let passed = 0
let failed = 0
const failures: string[] = []
function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

async function withRepo<T>(root: string, fn: (repo: MemoryRepository) => Promise<T>): Promise<T> {
  const repo = await MemoryRepository.load(root)
  try { return await fn(repo) }
  finally { await repo.close() }
}

async function main(): Promise<void> {
  console.log("── docs ingester ─────────────────────────────────────────")

  // ── Fixture: a realistic docs/ tree ──────────────────────────────
  const root = await mkdtemp(join(tmpdir(), "diane-docs-"))
  await mkdir(join(root, "docs"), { recursive: true })
  await mkdir(join(root, "docs/api"), { recursive: true })
  await mkdir(join(root, "docs/node_modules/junk"), { recursive: true })

  await writeFile(
    join(root, "docs/install.md"),
    `# Installation

Run \`bun install\` and then \`bun run build\` to get a working dev tree.

## Linux

Install bun first via the official script. Make sure your shell has
\`~/.bun/bin\` on PATH.

## macOS

Use Homebrew: \`brew install bun\`.

### Apple Silicon

Native binary works out of the box; no special steps needed.
`,
    "utf-8",
  )

  await writeFile(
    join(root, "docs/api/auth.md"),
    `# Authentication

The auth subsystem uses JWT bearer tokens.

\`\`\`
# This is a comment in a code block — NOT a heading
\`\`\`

## Login flow

The POST /auth/login endpoint accepts email and password.
`,
    "utf-8",
  )

  // README under docs/ is fine; only the ROOT README is skipped.
  await writeFile(
    join(root, "docs/README.md"),
    `# Docs Overview

Index of documentation pages.
`,
    "utf-8",
  )

  await writeFile(
    join(root, "docs/node_modules/junk/inside.md"),
    `# Should not be walked\n`,
    "utf-8",
  )

  // Conventional root-level docs.
  await writeFile(join(root, "CHANGELOG.md"), `# Changelog\n\n## 0.0.4\n\nNew features.`, "utf-8")
  await writeFile(join(root, "CONTRIBUTING.md"), `# How to contribute\n\nFork and PR.`, "utf-8")

  // Root README must be skipped — it's owned by project ingester.
  await writeFile(join(root, "README.md"), `# My Project\n\nDescription.`, "utf-8")

  try {
    await withRepo(root, async (repo) => {
      const res = await ingestDocs(repo, root)

      // ── File-walk gating ─────────────────────────────────────────
      assert(res.filesWalked >= 4, `walked ≥4 files (install, auth, docs/README, CHANGELOG, CONTRIBUTING). Got ${res.filesWalked}`)
      assert(res.headingsIndexed > 0, `indexed at least one heading. Got ${res.headingsIndexed}`)

      const all = repo.allMemories().filter((m) => m.category === "project-facts")
      const subjects = all.map((m) => m.subject)

      // README at the root is owned elsewhere; docs ingester must not duplicate.
      assert(
        !subjects.some((s) => s === "docs:README.md#my-project"),
        "root README is NOT ingested by docs (project ingester owns it)",
      )

      // docs/README.md (different file, inside docs/) IS ingested.
      assert(
        subjects.some((s) => s.startsWith("docs:docs/README.md#")),
        "docs/README.md (the in-tree one) IS ingested",
      )

      // node_modules content is excluded.
      assert(
        !subjects.some((s) => s.includes("node_modules")),
        "node_modules tree is skipped",
      )

      // Specific headings present with the expected slug shape.
      const installH1 = all.find((m) => m.subject === "docs:docs/install.md#installation")
      assert(!!installH1, "H1 'Installation' present as docs:docs/install.md#installation")
      assert(
        installH1!.content.includes("docs/install.md:1") && installH1!.content.includes("# Installation"),
        "install H1 carries the path:line pointer and the heading line",
      )
      assert(installH1!.content.includes("bun install"), "install H1 body captured the first paragraph")

      // H3 included (we cap at level 3).
      assert(
        subjects.some((s) => s === "docs:docs/install.md#apple-silicon"),
        "H3 'Apple Silicon' indexed (H1-H3 included)",
      )

      // Heading inside a fenced code block must NOT be parsed.
      assert(
        !subjects.some((s) => s.includes("this-is-a-comment-in-a-code-block")),
        "comment-style `#` inside ``` code fence is NOT parsed as a heading",
      )

      // Conventional root docs are ingested.
      assert(
        subjects.some((s) => s.startsWith("docs:CHANGELOG.md#")),
        "CHANGELOG.md (root, conventional) is ingested",
      )
      assert(
        subjects.some((s) => s.startsWith("docs:CONTRIBUTING.md#")),
        "CONTRIBUTING.md (root, conventional) is ingested",
      )

      // Tag carries 'docs' + file tag → recall via category/tag works.
      const installEntries = all.filter((m) => m.subject.startsWith("docs:docs/install.md#"))
      assert(
        installEntries.every((m) => m.tags.includes("docs")),
        "every docs entry carries the 'docs' tag",
      )
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  // ── Idempotency: re-running ingest does not duplicate ────────────
  {
    const root2 = await mkdtemp(join(tmpdir(), "diane-docs-idem-"))
    await mkdir(join(root2, "docs"), { recursive: true })
    await writeFile(join(root2, "docs/a.md"), `# A\n\nbody`, "utf-8")
    try {
      await withRepo(root2, async (repo) => {
        await ingestDocs(repo, root2)
        const n1 = repo.size()
        await ingestDocs(repo, root2)
        const n2 = repo.size()
        assert(n1 === n2, `idempotent: store size unchanged after second ingest (${n1} → ${n2})`)
      })
    } finally {
      await rm(root2, { recursive: true, force: true })
    }
  }

  // ── No docs dir, no conventional root files → no-op ──────────────
  {
    const root3 = await mkdtemp(join(tmpdir(), "diane-docs-empty-"))
    try {
      await withRepo(root3, async (repo) => {
        const res = await ingestDocs(repo, root3)
        assert(res.filesWalked === 0, "no docs and no conventional root files: walks 0 files")
        assert(res.headingsIndexed === 0, "no docs: indexes 0 headings")
      })
    } finally {
      await rm(root3, { recursive: true, force: true })
    }
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
