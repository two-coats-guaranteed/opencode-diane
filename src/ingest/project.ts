/**
 * Project-structure ingestion — fully language-agnostic.
 *
 * The earlier version was a Python parser: it understood
 * pyproject.toml's dependency model, pytest config sections, Flask /
 * FastAPI sentinels. None of that transfers to a Rust, Go, Elixir, or
 * C++ repo.
 *
 * This version commits to a strict rule: recognise files by NAME
 * (knowing that `Cargo.toml` is Rust's manifest is a *fact*, like
 * knowing a file extension — not a "convention" in the cultural
 * sense), but summarise them only by FORMAT — JSON → top-level keys,
 * TOML → section headers, YAML → top-level keys, etc. We never reach
 * into a manifest's language-specific semantics.
 *
 * What the agent gets: an orientation map — the repo's shape, which
 * recognised project/build/CI files exist, and the structural
 * skeleton of each. If it needs the actual contents it can `read`
 * the file; the memory's job is to point, not to parse.
 *
 * Everything here works identically on any repository regardless of
 * language or tooling.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { extname, join } from "node:path"
import type { Category } from "../types.js"
import type { MemoryRepository } from "../store/repository.js"

const CATEGORY: Category = "project-facts"

// Directories never worth walking into for an orientation summary.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "dist",
  "build",
  "target",
  ".idea",
  ".vscode",
  "vendor",
  ".gradle",
  ".next",
  ".svelte-kit",
  "coverage",
])

/**
 * Files whose NAME identifies them as a project manifest / build
 * descriptor / CI config / tooling config. This is a flat,
 * language-neutral list — recognising the name is a fact, not a
 * cultural assumption. We do not assume anything about their content
 * beyond their on-disk format.
 */
const RECOGNISED_FILES = [
  // package / build manifests across ecosystems
  "package.json",
  "deno.json",
  "deno.jsonc",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "Gemfile",
  "composer.json",
  "mix.exs",
  "Package.swift",
  "pubspec.yaml",
  "CMakeLists.txt",
  "Makefile",
  "makefile",
  "meson.build",
  "build.zig",
  "build.sbt",
  "project.clj",
  "rebar.config",
  "dune-project",
  "stack.yaml",
  "cabal.project",
  "BUILD",
  "BUILD.bazel",
  "WORKSPACE",
  "flake.nix",
  "default.nix",
  // CI / automation
  ".gitlab-ci.yml",
  "Jenkinsfile",
  ".travis.yml",
  "azure-pipelines.yml",
  "Taskfile.yml",
  "justfile",
  // containers / tooling
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yaml",
  ".editorconfig",
]

export interface ProjectIngestResult {
  facts: number
}

export async function ingestProjectFacts(
  repo: MemoryRepository,
  root: string
): Promise<ProjectIngestResult> {
  let n = 0
  const add = (subject: string, content: string, tags: string[]): void => {
    repo.insertIfMissing({
      category: CATEGORY,
      subject,
      content,
      tags,
      source: "project-ingest",
    })
    n += 1
  }

  // ── 1. Top-level layout ───────────────────────────────────────────
  const top = await safeReaddir(root)
  const dirs: string[] = []
  const files: string[] = []
  for (const e of top) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) dirs.push(e.name)
    } else if (e.isFile()) {
      files.push(e.name)
    }
  }
  add(
    "layout:top-level",
    `Repository root contains directories: ` +
      `${dirs.length ? dirs.sort().join(", ") : "(none)"}. ` +
      `Notable root files: ${files.length ? files.sort().slice(0, 25).join(", ") : "(none)"}.`,
    ["layout", "structure"]
  )

  // ── 1b. File-extension histogram across the whole tree ────────────
  // This is the single most reliable, zero-convention signal for
  // "what kind of repo is this": the language(s) emerge from the data
  // itself. Works for polyglot repos and for repos with no recognised
  // manifest at all. Bounded walk; SKIP_DIRS pruned.
  const census = await treeCensus(root)
  if (census.totalFiles > 0) {
    const extRanked = Array.from(census.extCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([ext, n]) => `${ext}×${n}`)
    add(
      "layout:file-types",
      `File-type census of ${census.totalFiles} files across ${census.totalDirs} ` +
        `directories (extension × count, most common first): ${extRanked.join(", ")}` +
        (census.extCounts.size > 20 ? `, … (+${census.extCounts.size - 20} more types)` : "") +
        `. Largest directories by file count: ${census.topDirs.join(", ")}.`,
      ["layout", "file-types", "languages"]
    )
  }

  // ── 2. Recognised project/build/CI files — format-based summary ───
  const presentRecognised: string[] = []
  for (const name of RECOGNISED_FILES) {
    const full = join(root, name)
    const content = await tryRead(full)
    if (content === null) continue
    presentRecognised.push(name)
    const summary = summariseByFormat(name, content)
    add(
      `file:${name}`,
      `${name} is present. Structural summary: ${summary}`,
      ["project-file", name]
    )
  }
  if (presentRecognised.length > 0) {
    add(
      "manifests:present",
      `Recognised project/build/CI files in this repo: ${presentRecognised.join(", ")}.`,
      ["manifests", "project-file"]
    )
  }

  // ── 3. CI workflow directory (GitHub Actions et al.) ──────────────
  const ghWorkflows = await safeReaddir(join(root, ".github", "workflows"))
  const wfFiles = ghWorkflows
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => e.name)
  for (const wf of wfFiles) {
    const content = await tryRead(join(root, ".github", "workflows", wf))
    if (content === null) continue
    add(
      `ci-workflow:${wf}`,
      `.github/workflows/${wf} is present. Structural summary: ` +
        summariseByFormat(wf, content),
      ["ci", "workflow", wf]
    )
  }
  if (wfFiles.length > 0) {
    add(
      "ci:workflows-present",
      `CI workflow files under .github/workflows/: ${wfFiles.join(", ")}.`,
      ["ci", "workflow"]
    )
  }

  // ── 4. README — first meaningful paragraph (any language) ─────────
  const readme = await readReadmeHead(root)
  if (readme) {
    add("readme:headline", `README opening: ${readme}`, ["readme", "docs"])
  }

  repo.setIngestedAt(CATEGORY, Date.now())
  return { facts: n }
}

/* ─── format-based summarisers (never language-specific) ────────────── */

/**
 * Summarise a config/manifest file by its on-disk FORMAT only. We
 * look at the file extension (and a couple of well-known extensionless
 * names) to pick a structural extractor. No file's meaning is
 * interpreted — only its skeleton is reported.
 */
export function summariseByFormat(name: string, content: string): string {
  const ext = extname(name).toLowerCase()
  const lower = name.toLowerCase()

  if (ext === ".json" || ext === ".jsonc") return summariseJson(content)
  if (ext === ".toml") return summariseToml(content)
  if (ext === ".yaml" || ext === ".yml") return summariseYaml(content)
  if (ext === ".xml") return summariseXml(content)
  if (
    lower === "makefile" ||
    lower === "justfile" ||
    lower === "dockerfile" ||
    name === "BUILD" ||
    name === "WORKSPACE"
  ) {
    return summariseLineOriented(name, content)
  }
  // Unknown / plain — report size and first non-empty line.
  return summarisePlain(content)
}

function summariseJson(content: string): string {
  try {
    const obj = JSON.parse(stripJsonComments(content)) as unknown
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const keys = Object.keys(obj as Record<string, unknown>)
      const annotated = keys.slice(0, 25).map((k) => {
        const v = (obj as Record<string, unknown>)[k]
        if (Array.isArray(v)) return `${k}[${v.length}]`
        if (v && typeof v === "object") {
          return `${k}{${Object.keys(v as object).length}}`
        }
        return k
      })
      return (
        `JSON object, top-level keys: ${annotated.join(", ")}` +
        (keys.length > 25 ? `, … (+${keys.length - 25})` : "")
      )
    }
    if (Array.isArray(obj)) return `JSON array of ${obj.length} items`
    return "JSON scalar value"
  } catch {
    return `unparseable JSON (${countLines(content)} lines)`
  }
}

function summariseToml(content: string): string {
  // Section headers: [section] and [[array.of.tables]].
  const sections: string[] = []
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*(\[\[?[^\]]+\]\]?)/)
    if (m) sections.push(m[1])
  }
  // Bare top-level keys before the first section.
  const topKeys: string[] = []
  for (const line of content.split("\n")) {
    if (/^\s*\[/.test(line)) break
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)
    if (m) topKeys.push(m[1])
  }
  const parts: string[] = []
  if (topKeys.length) parts.push(`top-level keys: ${topKeys.slice(0, 12).join(", ")}`)
  if (sections.length) {
    parts.push(
      `sections: ${sections.slice(0, 20).join(", ")}` +
        (sections.length > 20 ? `, … (+${sections.length - 20})` : "")
    )
  }
  return parts.length
    ? `TOML — ${parts.join("; ")}`
    : `TOML (${countLines(content)} lines, no sections detected)`
}

function summariseYaml(content: string): string {
  // Top-level keys = lines matching `key:` at zero indentation.
  const keys: string[] = []
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_.-]+):/)
    if (m) keys.push(m[1])
  }
  if (keys.length === 0) {
    return `YAML (${countLines(content)} lines, no top-level keys detected)`
  }
  return (
    `YAML — top-level keys: ${keys.slice(0, 20).join(", ")}` +
    (keys.length > 20 ? `, … (+${keys.length - 20})` : "")
  )
}

function summariseXml(content: string): string {
  const root = content.match(/<([A-Za-z_][\w.-]*)[\s>]/)?.[1]
  if (!root) return `XML (${countLines(content)} lines)`
  // Immediate-ish child tags (first occurrence of each distinct tag).
  const childTags = new Set<string>()
  for (const m of content.matchAll(/<([A-Za-z_][\w.-]*)[\s>/]/g)) {
    if (m[1] !== root) childTags.add(m[1])
    if (childTags.size >= 15) break
  }
  return (
    `XML — root <${root}>, child tags seen: ${Array.from(childTags).join(", ") || "(none)"}`
  )
}

function summariseLineOriented(name: string, content: string): string {
  const lines = content.split("\n")
  const lower = name.toLowerCase()
  if (lower === "makefile" || lower === "justfile") {
    // Target-looking lines: "name:" at column 0 (not ".PHONY" etc.).
    const targets: string[] = []
    for (const line of lines) {
      const m = line.match(/^([A-Za-z0-9_][\w./-]*)\s*:/)
      if (m && !m[1].startsWith(".")) targets.push(m[1])
    }
    return targets.length
      ? `${name} — targets: ${targets.slice(0, 20).join(", ")}` +
          (targets.length > 20 ? `, … (+${targets.length - 20})` : "")
      : `${name} (${lines.length} lines, no targets detected)`
  }
  if (lower === "dockerfile") {
    // Instruction keywords used (FROM, RUN, COPY, ...).
    const instr = new Set<string>()
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z]+)\s/)
      if (m) instr.add(m[1])
    }
    return `Dockerfile — instructions used: ${Array.from(instr).join(", ") || "(none)"}`
  }
  return `${name} (${lines.length} lines)`
}

function summarisePlain(content: string): string {
  const lines = content.split("\n")
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? ""
  return (
    `${lines.length} lines; first line: ` +
    `"${truncate(firstNonEmpty.trim(), 100)}"`
  )
}

/* ─── helpers ───────────────────────────────────────────────────────── */

interface TreeCensus {
  totalFiles: number
  totalDirs: number
  /** file extension (lowercased, with dot) or "(no-ext)" → count */
  extCounts: Map<string, number>
  /** directory paths (relative) with the most files, "name (N)" */
  topDirs: string[]
}

/**
 * Bounded recursive walk producing a file-extension histogram. This
 * is purely structural — it reports what file types physically exist
 * and where, never interpreting them. SKIP_DIRS are pruned. Depth and
 * total file count are capped so this stays fast on huge monorepos.
 */
async function treeCensus(root: string): Promise<TreeCensus> {
  const MAX_DEPTH = 8
  const MAX_FILES = 20_000
  const extCounts = new Map<string, number>()
  const dirFileCounts = new Map<string, number>()
  let totalFiles = 0
  let totalDirs = 0

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || totalFiles >= MAX_FILES) return
    const entries = await safeReaddir(dir)
    let filesHere = 0
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
        totalDirs += 1
        await walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1)
      } else if (e.isFile()) {
        if (totalFiles >= MAX_FILES) break
        totalFiles += 1
        filesHere += 1
        const ext = extname(e.name).toLowerCase() || "(no-ext)"
        extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1)
      }
    }
    if (filesHere > 0) dirFileCounts.set(rel || ".", filesHere)
  }

  await walk(root, "", 0)

  const topDirs = Array.from(dirFileCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([d, n]) => `${d} (${n})`)

  return { totalFiles, totalDirs, extCounts, topDirs }
}

async function safeReaddir(
  dir: string
): Promise<Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function tryRead(path: string): Promise<string | null> {
  try {
    const s = await stat(path)
    if (!s.isFile()) return null
    // Don't pull huge files into memory for a structural summary.
    if (s.size > 512 * 1024) {
      return `__OVERSIZE__${s.size}`
    }
    return await readFile(path, "utf-8")
  } catch {
    return null
  }
}

async function readReadmeHead(root: string): Promise<string | null> {
  for (const name of [
    "README.md",
    "README.rst",
    "README.txt",
    "README",
    "readme.md",
  ]) {
    const text = await tryRead(join(root, name))
    if (!text || text.startsWith("__OVERSIZE__")) continue
    for (const line of text.split("\n")) {
      const cleaned = line.replace(/^[#=\-*\s>]+/, "").trim()
      if (cleaned.length > 0) {
        return cleaned.length > 200 ? cleaned.slice(0, 197) + "…" : cleaned
      }
    }
  }
  return null
}

function stripJsonComments(s: string): string {
  // Tolerate JSONC: strip // line comments and /* */ blocks. Naive but
  // good enough for a structural summary (we only need Object.keys).
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function countLines(s: string): number {
  return s.split("\n").length
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…"
}
