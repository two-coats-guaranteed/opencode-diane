/**
 * Git history ingestion — fully convention-agnostic.
 *
 * The earlier version classified commits by parsing the *subject
 * line* (conventional commits, bracket tags, gitmoji, English
 * keywords). That is unreliable on real repositories, many of which
 * have no commit-message culture at all ("wip", "fix", ".", "update",
 * non-English text, empty subjects). Message-derived "flavor" was
 * noise dressed up as signal.
 *
 * This version derives everything from STRUCTURE — facts about what
 * the commit physically did, which are true regardless of how (or
 * whether) the author described it:
 *
 *   - diff shape   : files touched, lines +/-, files created/deleted,
 *                    net direction. From `git log --numstat --summary`.
 *   - co-change    : pairs of files modified in the same commit,
 *                    counted across history (mechanical/huge commits
 *                    skipped).
 *   - churn        : how often each file changes — a stability signal.
 *   - recency      : which files were touched in the most recent
 *                    commits.
 *
 * The commit subject is still STORED, verbatim, inside the memory
 * content — it is text the agent may legitimately search for — but it
 * never drives tags or categorisation. It is data, not signal.
 *
 * Output is hard-capped by `gitHistoryDepth`. Re-running ingest is
 * idempotent thanks to insertIfMissing on the repository.
 */

import type { Category } from "../types.js"
import type { MemoryRepository } from "../store/repository.js"
import { isGitRepo, runGit } from "../utils/shell.js"

const CATEGORY: Category = "git-history"

// Co-change: pairs touched together this many times are "coupled".
const COCHANGE_MIN_TIMES = 3
// Commits touching more files than this are mechanical (mass reformat,
// vendoring, lockfile churn) — their file pairs are noise, skip them.
const COCHANGE_MAX_FILES = 8
const PAIR_LIMIT = 200
// Churn: a file modified in at least this fraction of scanned commits,
// AND at least this many times absolutely, is flagged as high-churn.
const CHURN_MIN_FRACTION = 0.15
const CHURN_MIN_ABSOLUTE = 4
const CHURN_LIMIT = 60
// Recency: how many of the most-recent commits feed the "recently
// changed files" memory.
const RECENCY_WINDOW = 12
const MAX_FILES_PER_COMMIT_IN_MEMORY = 8

type FileStatus = "created" | "deleted" | "modified"

interface FileChange {
  path: string
  added: number // -1 means binary/unknown
  deleted: number
  status: FileStatus
}

interface Commit {
  hash: string
  subject: string
  unixTime: number
  files: FileChange[]
  isMerge: boolean
}

export interface GitIngestResult {
  scanned: number
  commitMemories: number
  coChangeMemories: number
  churnMemories: number
  recencyMemories: number
  /**
   * Commits skipped for their own per-commit memory because they are
   * balanced churn (additions ≈ deletions — content moved/reformatted,
   * not created). They still feed co-change and churn signals.
   */
  balancedChurnSkipped: number
  /** Distribution of structural shape tags across commit memories. */
  shapeTagCounts: Record<string, number>
}

/**
 * True when a commit is "balanced churn": substantial, and its added
 * line count is within ~8 % of its deleted count. That near-equality
 * is the convention-free fingerprint of content being *moved or
 * reformatted* rather than written — a file rename (with `--no-renames`
 * a rename shows as +N to the new path, -N from the old), a `.rst`→
 * `.md` doc migration, a reformat. Such commits flood keyword recall
 * (they touch keyword-named files) while carrying no logic signal, so
 * they get no per-commit memory — exactly as merge commits don't.
 *
 * Deliberately conservative: the ≥ 25-line floor spares small commits,
 * and 92 % balance is tight enough that a genuine logic change (which
 * almost never lands added ≈ deleted to within 8 %) is not caught.
 * Pure arithmetic on the diff stat — no message parsing, no language
 * or commit-convention assumptions.
 */
export function isBalancedChurnCommit(files: FileChange[]): boolean {
  if (files.length === 0) return false
  let added = 0
  let deleted = 0
  for (const f of files) {
    if (f.added < 0 || f.deleted < 0) return false // binary — unknown shape
    added += f.added
    deleted += f.deleted
  }
  if (added < 25 || deleted < 25) return false
  const hi = Math.max(added, deleted)
  const lo = Math.min(added, deleted)
  return lo / hi >= 0.92
}

export async function ingestGitHistory(
  repo: MemoryRepository,
  root: string,
  depth: number,
  coChangeMaxCommits = Infinity,
  coChangeMinOccurrences = COCHANGE_MIN_TIMES
): Promise<GitIngestResult> {
  const result: GitIngestResult = {
    scanned: 0,
    commitMemories: 0,
    coChangeMemories: 0,
    churnMemories: 0,
    recencyMemories: 0,
    balancedChurnSkipped: 0,
    shapeTagCounts: {},
  }
  if (!(await isGitRepo(root))) return result

  // `--numstat` gives per-file added/deleted line counts; `--summary`
  // adds "create mode" / "delete mode" lines so we can tell new and
  // removed files apart. Both are structural, language-neutral.
  const SEP = "\u241F"
  const FMT = `${SEP}%H${SEP}%P${SEP}%at${SEP}%s${SEP}`
  const stdout = await runGit(
    [
      "log",
      `-${depth}`,
      "--no-color",
      "--numstat",
      "--summary",
      "--no-renames",
      `--pretty=format:${FMT}`,
    ],
    root
  )
  if (!stdout) return result

  const commits = parseGitLog(stdout, SEP)
  result.scanned = commits.length

  // ── Per-commit memories — every non-merge commit gets one, EXCEPT
  //    balanced-churn commits (renames / reformats / doc migrations):
  //    they flood keyword recall with no logic signal. They still feed
  //    the co-change and churn passes below — only the noisy per-commit
  //    memory is dropped, the same way merge commits are.
  for (const c of commits) {
    if (c.isMerge) continue // merge commits rarely carry their own diff
    if (isBalancedChurnCommit(c.files)) {
      result.balancedChurnSkipped += 1
      continue
    }
    const shape = deriveShapeTags(c.files)
    for (const t of shape) {
      result.shapeTagCounts[t] = (result.shapeTagCounts[t] ?? 0) + 1
    }
    ingestCommitMemory(repo, c, shape)
    result.commitMemories += 1
  }

  // ── File co-modification ──────────────────────────────────────────
  // The pair-counting below is O(commits × files-per-commit²). On a
  // very large history that is the one genuinely super-linear pass in
  // the plugin, so adaptive config can cap it: above the cutoff,
  // co-change is skipped entirely (commit/churn/recency still run).
  if (commits.length <= coChangeMaxCommits) {
    const pairCounts = new Map<string, number>()
    for (const c of commits) {
      if (c.isMerge || c.files.length > COCHANGE_MAX_FILES) continue
      const paths = c.files.map((f) => f.path).sort()
      for (let i = 0; i < paths.length; i++) {
        for (let j = i + 1; j < paths.length; j++) {
          const key = `${paths[i]}\u0000${paths[j]}`
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
        }
      }
    }
    const pairs: Array<{ a: string; b: string; n: number }> = []
    for (const [k, n] of pairCounts) {
      if (n < coChangeMinOccurrences) continue
      const sep = k.indexOf("\u0000")
      pairs.push({ a: k.slice(0, sep), b: k.slice(sep + 1), n })
    }
    pairs.sort((x, y) => y.n - x.n)
    for (const p of pairs.slice(0, PAIR_LIMIT)) {
      repo.insertIfMissing({
        category: CATEGORY,
        subject: `co-change:${p.a}`,
        content:
          `${p.a} and ${p.b} were modified together in ${p.n} of the last ` +
          `${commits.length} commits — they are likely coupled.`,
        tags: ["co-change", p.a, p.b],
        source: "git:co-occurrence",
      })
      result.coChangeMemories += 1
    }
  }

  // ── Churn — how often each file changes (stability signal) ────────
  const churn = new Map<string, number>()
  for (const c of commits) {
    if (c.isMerge) continue
    for (const f of c.files) {
      churn.set(f.path, (churn.get(f.path) ?? 0) + 1)
    }
  }
  const nonMerge = commits.filter((c) => !c.isMerge).length || 1
  const churnRanked = Array.from(churn.entries())
    .filter(
      ([, n]) =>
        n >= CHURN_MIN_ABSOLUTE && n / nonMerge >= CHURN_MIN_FRACTION
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, CHURN_LIMIT)
  for (const [path, n] of churnRanked) {
    const pct = Math.round((n / nonMerge) * 100)
    repo.insertIfMissing({
      category: CATEGORY,
      subject: `churn:${path}`,
      content:
        `${path} is high-churn: changed in ${n} of the last ${nonMerge} ` +
        `non-merge commits (${pct}%). Treat it as a hot, frequently-edited file.`,
      tags: ["churn", "hot-file", path],
      source: "git:churn",
    })
    result.churnMemories += 1
  }

  // ── Recency — what was touched most recently ──────────────────────
  const recentNonMerge = commits.filter((c) => !c.isMerge).slice(0, RECENCY_WINDOW)
  if (recentNonMerge.length > 0) {
    const recentFiles: string[] = []
    const seen = new Set<string>()
    for (const c of recentNonMerge) {
      for (const f of c.files) {
        if (!seen.has(f.path)) {
          seen.add(f.path)
          recentFiles.push(f.path)
        }
      }
    }
    const newest = recentNonMerge[0]
    repo.insertIfMissing({
      category: CATEGORY,
      subject: "recency:recently-changed",
      content:
        `Files changed in the last ${recentNonMerge.length} non-merge commits ` +
        `(most recent first): ${recentFiles.slice(0, 25).join(", ")}` +
        (recentFiles.length > 25 ? `, … (+${recentFiles.length - 25})` : "") +
        `. Most recent commit: ${newest.hash.slice(0, 8)}.`,
      tags: ["recency", "recently-changed"],
      source: "git:recency",
    })
    result.recencyMemories += 1
  }

  repo.setIngestedAt(CATEGORY, Date.now())
  return result
}

/* ─── structural shape derivation (no message parsing) ──────────────── */

/**
 * Derive tags purely from what the commit physically did. Every tag
 * here is a fact about the diff, not an interpretation of intent.
 */
export function deriveShapeTags(files: FileChange[]): string[] {
  const tags: string[] = []
  const n = files.length
  if (n === 0) return ["empty"]

  const created = files.filter((f) => f.status === "created").length
  const deleted = files.filter((f) => f.status === "deleted").length
  let totalAdded = 0
  let totalDeleted = 0
  let hasBinary = false
  for (const f of files) {
    if (f.added < 0 || f.deleted < 0) {
      hasBinary = true
    } else {
      totalAdded += f.added
      totalDeleted += f.deleted
    }
  }

  // size of the change (file count)
  if (n === 1) tags.push("single-file")
  else if (n >= 10) tags.push("many-files")

  // size of the change (line volume)
  const churn = totalAdded + totalDeleted
  if (churn >= 500) tags.push("large-diff")
  else if (churn > 0 && churn <= 10) tags.push("tiny-diff")

  // direction — file-level
  if (created > 0 && created >= n / 2) tags.push("adds-files")
  if (deleted > 0 && deleted >= n / 2) tags.push("removes-files")

  // direction — line-level
  if (totalDeleted > totalAdded * 2 && totalDeleted >= 30) {
    tags.push("net-removal")
  } else if (totalAdded > totalDeleted * 2 && totalAdded >= 30) {
    tags.push("net-addition")
  }

  if (hasBinary) tags.push("touches-binary")

  return tags
}

function ingestCommitMemory(
  repo: MemoryRepository,
  c: Commit,
  shapeTags: string[]
): void {
  const paths = c.files.map((f) => f.path)
  const subject = paths[0] ?? `tree:${c.hash.slice(0, 8)}`
  const fileList =
    paths.slice(0, MAX_FILES_PER_COMMIT_IN_MEMORY).join(", ") +
    (paths.length > MAX_FILES_PER_COMMIT_IN_MEMORY
      ? `, … (+${paths.length - MAX_FILES_PER_COMMIT_IN_MEMORY})`
      : "")

  let totalAdded = 0
  let totalDeleted = 0
  for (const f of c.files) {
    if (f.added > 0) totalAdded += f.added
    if (f.deleted > 0) totalDeleted += f.deleted
  }

  const dateStr = c.unixTime
    ? new Date(c.unixTime * 1000).toISOString().slice(0, 10)
    : "unknown-date"

  // The subject is included VERBATIM, quoted, as plain searchable
  // text. We do not parse it. Structural facts carry the meaning.
  const subjectText = c.subject.trim()
    ? `Message: "${truncate(c.subject.trim(), 140)}". `
    : "Message: (empty). "

  repo.insertIfMissing({
    category: CATEGORY,
    subject,
    content:
      `Commit ${c.hash.slice(0, 8)} (${dateStr}). ${subjectText}` +
      `Changed ${c.files.length} file(s), +${totalAdded}/-${totalDeleted} lines. ` +
      `Files: ${fileList || "(none)"}.`,
    // Tags are structural shape + the touched file paths. No flavor
    // derived from the message.
    tags: [...shapeTags, ...paths.slice(0, 4)],
    source: `git:${c.hash}`,
  })
}

/* ─── parsing ───────────────────────────────────────────────────────── */

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…"
}

/**
 * Parse `git log --numstat --summary` output framed by our SEP-based
 * pretty format. Each commit chunk is:
 *
 *   SEP HASH SEP PARENTS SEP UNIXTIME SEP SUBJECT SEP
 *   <added>\t<deleted>\t<path>          (numstat lines)
 *   ...
 *    create mode 100644 <path>          (summary lines)
 *    delete mode 100644 <path>
 *    ...
 */
function parseGitLog(stdout: string, sep: string): Commit[] {
  const commits: Commit[] = []
  const chunks = stdout.split(sep)
  // chunks[0] is the text before the first SEP (empty). Then each
  // commit is 5 fields: hash, parents, unixtime, subject, body-block.
  let i = 1
  while (i < chunks.length) {
    const hash = (chunks[i] ?? "").trim()
    const parents = (chunks[i + 1] ?? "").trim()
    const unixTime = parseInt((chunks[i + 2] ?? "").trim(), 10) || 0
    const subject = (chunks[i + 3] ?? "").replace(/^\s+/, "").replace(/\s+$/, "")
    const body = chunks[i + 4] ?? ""
    if (!hash) break

    const created = new Set<string>()
    const removed = new Set<string>()
    const numstat: Array<{ path: string; added: number; deleted: number }> = []

    for (const rawLine of body.split("\n")) {
      const line = rawLine.replace(/\r$/, "")
      if (!line.trim()) continue

      // summary lines: " create mode 100644 path", " delete mode 100644 path"
      const create = line.match(/^\s+create mode \d+ (.+)$/)
      if (create) {
        created.add(create[1].trim())
        continue
      }
      const del = line.match(/^\s+delete mode \d+ (.+)$/)
      if (del) {
        removed.add(del[1].trim())
        continue
      }
      // other summary lines (" mode change ...", " rename ...") — ignore
      if (/^\s+(mode change|rename) /.test(line)) continue

      // numstat line: "<added>\t<deleted>\t<path>" — binary shows "-\t-\t"
      const ns = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/)
      if (ns) {
        const added = ns[1] === "-" ? -1 : parseInt(ns[1], 10)
        const deleted = ns[2] === "-" ? -1 : parseInt(ns[2], 10)
        numstat.push({ path: ns[3].trim(), added, deleted })
      }
      // anything else (shouldn't happen) — skip
    }

    const files: FileChange[] = numstat.map((n) => ({
      path: n.path,
      added: n.added,
      deleted: n.deleted,
      status: created.has(n.path)
        ? "created"
        : removed.has(n.path)
          ? "deleted"
          : "modified",
    }))
    // A pure-deletion commit may have numstat "0 0 path" or be present
    // only in the summary block — fold any summary-only deletes in.
    for (const path of removed) {
      if (!files.some((f) => f.path === path)) {
        files.push({ path, added: 0, deleted: 0, status: "deleted" })
      }
    }

    const isMerge = parents.split(/\s+/).filter(Boolean).length > 1
    commits.push({ hash, subject, unixTime, files, isMerge })
    i += 5
  }
  return commits
}
