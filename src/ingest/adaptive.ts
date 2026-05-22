/**
 * Adaptive configuration — scale size-derived settings to the repo.
 *
 * The plugin's fixed defaults (gitHistoryDepth 500, a 4000-file
 * code-map cap, a 5 MB budget) are a reasonable middle. They are
 * wasteful on a 50-commit toy and inadequate on a 100k-commit
 * monorepo. Rather than a pile of per-knob heuristics, this module
 * takes ONE measured signal — commit count, or file count when
 * there's no git — classifies the repo into one named tier, and a
 * lookup table picks the numbers. One input, three tiers, inspectable
 * and logged: that keeps adaptation predictable.
 *
 * Adaptation only fills knobs the user did NOT set explicitly
 * (`ResolvedConfig.explicitKeys`); an explicit value always wins.
 * It is gated by `config.adaptive` (default true).
 */

import type { ResolvedConfig } from "../types.js"
import { runGit } from "../utils/shell.js"

export type RepoTier = "small" | "medium" | "large"

/**
 * The tier table. Each tier names the size-derived knobs.
 *
 *   - gitHistoryDepth   — commits the git ingester walks.
 *   - maxMemoryDiskMB   — disk budget. Deliberately uniform across
 *                         tiers: the 50 MB default is generous enough
 *                         for every realistic repo (a depth-capped
 *                         large repo's store is ~6–8 MB), so the
 *                         budget no longer needs to scale with size.
 *                         The knob is kept in the table so a future
 *                         version could raise it for genuine
 *                         monorepos; adaptation never lowers it.
 *   - codeMapMaxFiles   — cap on files the code-map ingester parses.
 *   - coChangeMaxCommits— above this commit count the O(commits ×
 *                         files²) co-change pass is skipped entirely.
 */
interface TierSettings {
  gitHistoryDepth: number
  maxMemoryDiskMB: number
  codeMapMaxFiles: number
  coChangeMaxCommits: number
}

const TIERS: Record<RepoTier, TierSettings> = {
  small: {
    gitHistoryDepth: 250,
    maxMemoryDiskMB: 50, // uniform across tiers — see the note above
    codeMapMaxFiles: 1500,
    coChangeMaxCommits: 5000,
  },
  medium: {
    gitHistoryDepth: 500,
    maxMemoryDiskMB: 50,
    codeMapMaxFiles: 4000,
    coChangeMaxCommits: 5000,
  },
  large: {
    gitHistoryDepth: 1500,
    maxMemoryDiskMB: 50,
    codeMapMaxFiles: 10000,
    // co-change is the one genuinely super-linear pass; on very large
    // histories it is skipped rather than risking a stall.
    coChangeMaxCommits: 5000,
  },
}

/** Commit-count thresholds for the git-available path. */
const SMALL_MAX_COMMITS = 150
const LARGE_MIN_COMMITS = 2000
/** File-count thresholds for the no-git fallback path. */
const SMALL_MAX_FILES = 400
const LARGE_MIN_FILES = 5000

export interface RepoSignal {
  /** What was measured: a git commit count, or a tree file count. */
  basis: "commits" | "files"
  value: number
  tier: RepoTier
}

/**
 * Measure the repo with one cheap call and classify it. Uses
 * `git rev-list --count HEAD` when git is present; otherwise counts
 * files in the tree (bounded — we stop early once past the large
 * threshold, since the exact number past that doesn't matter).
 * Never throws — on any failure it returns the `medium` tier, i.e.
 * the plugin's existing fixed defaults.
 */
export async function measureRepo(root: string, hasGit: boolean): Promise<RepoSignal> {
  if (hasGit) {
    const out = await runGit(["rev-list", "--count", "HEAD"], root)
    const n = out ? parseInt(out.trim(), 10) : NaN
    if (Number.isFinite(n)) {
      return { basis: "commits", value: n, tier: tierForCommits(n) }
    }
    // git present but rev-list failed (empty repo, detached, etc.) —
    // fall through to the file-count basis.
  }
  const files = await countFiles(root)
  return { basis: "files", value: files, tier: tierForFiles(files) }
}

function tierForCommits(n: number): RepoTier {
  if (n <= SMALL_MAX_COMMITS) return "small"
  if (n >= LARGE_MIN_COMMITS) return "large"
  return "medium"
}

function tierForFiles(n: number): RepoTier {
  if (n <= SMALL_MAX_FILES) return "small"
  if (n >= LARGE_MIN_FILES) return "large"
  return "medium"
}

/** Directories not worth walking when sizing the repo. */
const SKIP = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  "vendor",
  ".next",
  "coverage",
])

/**
 * Bounded file count: walks the tree but stops once it is clearly
 * past the "large" threshold — the exact count beyond that point
 * doesn't change the tier, so there's no reason to keep walking a
 * huge tree.
 */
async function countFiles(root: string): Promise<number> {
  const { readdir } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const CEILING = LARGE_MIN_FILES + 1
  let count = 0

  async function walk(dir: string, depth: number): Promise<void> {
    if (count >= CEILING || depth > 8) return
    let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (count >= CEILING) return
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || e.name.startsWith(".")) continue
        await walk(join(dir, e.name), depth + 1)
      } else if (e.isFile()) {
        count += 1
      }
    }
  }

  await walk(root, 0)
  return count
}

/**
 * Apply size-derived tuning to a resolved config, **mutating it in
 * place**. The config object is shared (the plugin's tools and hooks
 * close over it at startup, before background prefill runs the
 * measurement), so a returned copy wouldn't reach them — a one-time
 * in-place settle does. Only knobs the user did NOT set explicitly
 * are touched. Returns a short human-readable description of what
 * changed, for the prefill log.
 *
 * When `config.adaptive` is false this is a no-op.
 */
export function applyAdaptiveTuning(
  config: ResolvedConfig,
  signal: RepoSignal
): { summary: string } {
  if (!config.adaptive) {
    return { summary: "adaptive tuning off — using fixed defaults" }
  }

  const t = TIERS[signal.tier]
  const changes: string[] = []

  if (!config.explicitKeys.has("gitHistoryDepth") && config.gitHistoryDepth !== t.gitHistoryDepth) {
    config.gitHistoryDepth = t.gitHistoryDepth
    changes.push(`gitHistoryDepth=${t.gitHistoryDepth}`)
  }
  if (!config.explicitKeys.has("maxMemoryDiskMB")) {
    // The budget is tier-independent (all tiers carry the 50 MB
    // default), so this normally makes no change. Adaptation only ever
    // RAISES the budget, never lowers it — `Math.max` keeps that
    // invariant if a future tier table sets a larger value.
    const mb = Math.max(50, t.maxMemoryDiskMB)
    const bytes = mb * 1024 * 1024
    if (config.maxMemoryBytes !== bytes) {
      config.maxMemoryBytes = bytes
      changes.push(`budget=${mb}MB`)
    }
  }
  // codeMapMaxFiles and coChangeMaxCommits are user-exposable since
  // v0.0.4 — respect an explicit override; otherwise follow the tier.
  if (!config.explicitKeys.has("codeMapMaxFiles") && config.codeMapMaxFiles !== t.codeMapMaxFiles) {
    config.codeMapMaxFiles = t.codeMapMaxFiles
    changes.push(`codeMapMaxFiles=${t.codeMapMaxFiles}`)
  }
  if (!config.explicitKeys.has("coChangeMaxCommits")) {
    config.coChangeMaxCommits = t.coChangeMaxCommits
  }

  const coChangeNote =
    signal.basis === "commits" && signal.value > t.coChangeMaxCommits
      ? ", co-change skipped (history too large)"
      : ""

  const changeSummary =
    changes.length > 0 ? changes.join(", ") : "no changes (already at tier defaults)"

  const summary =
    `repo tier=${signal.tier} (${signal.value} ${signal.basis}) — ` +
    changeSummary +
    coChangeNote

  return { summary }
}
