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
