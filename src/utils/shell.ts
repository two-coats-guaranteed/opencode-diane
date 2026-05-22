/**
 * Tiny exec wrapper for synchronous git calls during ingestion.
 *
 * - returns stdout as a string when the command exits 0
 * - returns null if git isn't installed or the command failed
 *   (never throws — ingestion is best-effort)
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileP = promisify(execFile)

export async function runGit(
  args: string[],
  cwd: string,
  maxBufferMB = 16
): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      maxBuffer: maxBufferMB * 1024 * 1024,
      timeout: 30_000,
    })
    return stdout
  } catch {
    return null
  }
}

/** True if `git` is on PATH and `cwd` is inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const out = await runGit(["rev-parse", "--is-inside-work-tree"], cwd)
  return out !== null && out.trim() === "true"
}

/**
 * The current HEAD commit SHA, or null if the repo has no commits yet
 * or git isn't available. Cheap (microseconds for git itself, dominated
 * by the process-spawn overhead). Suitable for post-bash polling to
 * detect pull/merge/rebase/reset/checkout side effects.
 */
export async function currentHead(cwd: string): Promise<string | null> {
  const out = await runGit(["rev-parse", "HEAD"], cwd)
  if (out === null) return null
  const trimmed = out.trim()
  // `rev-parse HEAD` on an empty repo emits the literal string "HEAD"
  // to stderr and exits non-zero, so a non-null result here is already
  // a real SHA. Belt-and-braces sanity check on length.
  return trimmed.length >= 7 && /^[0-9a-f]+$/i.test(trimmed) ? trimmed : null
}

/**
 * Files modified or newly created in the working tree, parsed from
 * `git status --porcelain=v1`. Returns an empty array if not a git
 * repo or if the call fails — never throws.
 *
 * Selection rules:
 *   - Modified, added, copied, untracked files → included (returned path
 *     is the on-disk one).
 *   - Renames (`R`) → the destination path is returned (the old name has
 *     nothing on disk to re-index).
 *   - Deletions in EITHER staging column → skipped (no file on disk).
 *
 * Path handling:
 *   - C-quoted paths (git's escape for spaces / control chars in
 *     filenames) are unquoted with `JSON.parse`. Unparseable quoting
 *     falls back to the raw form.
 *   - Trailing `\r` from CRLF line endings is stripped (defensive — git
 *     normally outputs LF even on Windows, but third-party tools that
 *     pipe through `cmd.exe` can introduce it).
 *
 * Intended use: poll right after a `bash` tool call to find files the
 * shell command touched that the code-map index does not know about.
 * Cap callers' usage with their own per-call file limit — `bash`
 * commands like `git checkout other-branch` can return thousands.
 */
export async function changedFilesInWorktree(cwd: string): Promise<string[]> {
  const out = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], cwd)
  if (out === null) return []
  const files: string[] = []
  for (const rawLine of out.split("\n")) {
    // Normalise CRLF defensively.
    const line = rawLine.replace(/\r$/, "")
    // Porcelain v1 format: XY<space>path[ -> renamed_path]
    // Minimum well-formed line is `XY p` (4 chars).
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    let path = line.slice(3)
    // Skip any line where EITHER column indicates a deletion — that file
    // is gone from disk (or about to be) and there's nothing to refresh.
    // Covers `D `, ` D`, `DD`, `MD`, `AD`, `RD`, `CD`, …
    if (xy[0] === "D" || xy[1] === "D") continue
    // Renames / copies: `R` or `C` in column 0. The path looks like
    // `src/old.ts -> src/new.ts`; keep the destination (the file that
    // exists on disk).
    if (xy[0] === "R" || xy[0] === "C") {
      const arrow = path.indexOf(" -> ")
      if (arrow >= 0) path = path.slice(arrow + 4)
    }
    // Unquote git's C-quoted paths (when path contains special chars).
    if (path.startsWith('"') && path.endsWith('"')) {
      try {
        path = JSON.parse(path) as string
      } catch {
        /* unparseable quoting — keep the raw form */
      }
    }
    if (path.length > 0) files.push(path)
  }
  return files
}
