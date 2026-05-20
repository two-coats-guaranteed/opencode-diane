/**
 * peer-detection.ts — detect known coexisting OpenCode plugins by
 * reading the user's `opencode.json` config(s). Pure result: a record
 * naming which peers are listed alongside us, used to apply
 * compatibility defaults at startup.
 *
 * **Conservative by design.** This file knows only about plugins we
 * have actually validated against (oh-my-opencode and caveman today)
 * and only triggers when the user has listed them explicitly. It
 * never sniffs running processes, never imports peer packages, and
 * never modifies anything on disk. Standalone — when no peer is
 * found — behaviour is byte-for-byte the documented default.
 *
 * Why detect at all: two compatibility decisions need to be made at
 * startup, not at recall-time:
 *   - whether to install the `tool.execute.after` nudge (oh-my-opencode
 *     also rewrites tool output and two plugins both touching
 *     `output.output` interleave unpredictably);
 *   - whether to namespace mined skill subdirectories so we don't
 *     write into the same slugs caveman creates (`caveman`,
 *     `caveman-commit`, etc.) under the shared `.opencode/skills/`
 *     directory OpenCode discovers from.
 *
 * Both are also user-overrideable via explicit config — auto-detection
 * fills the option ONLY when the user didn't.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface PeerPlugins {
  /** oh-my-opencode (or its newer rename oh-my-openagent, or the slim
   *  fork) is listed in an opencode config we can see. */
  ohMyOpencode: boolean
  /** A caveman variant is listed. Multiple npm packages exist
   *  (`caveman-opencode-plugin`, `caveman-opencode`, `opencode-caveman`,
   *  and the in-repo `caveman` plugin from JuliusBrussee/caveman) so
   *  we match any of them. */
  caveman: boolean
  /** Raw list of plugin names we read, for the startup log line. */
  found: string[]
}

const OH_MY_OPENCODE = /^(oh-my-opencode(-slim)?|oh-my-openagent)$/i
const CAVEMAN = /(^|\/|@)(caveman-opencode(-plugin)?|opencode-caveman|caveman)$/i

/**
 * Read project-local and user-global opencode config files and return
 * which known peers appear in the `plugin` array. Plugin entries can
 * be either a string `"name"` or an array `["name", options]`; we
 * pick out the name in either shape.
 */
export function detectPeerPlugins(projectRoot: string): PeerPlugins {
  // Same search path OpenCode itself uses: project first, then global.
  // We take the UNION — if a plugin is listed in either, it counts.
  const candidates = [
    join(projectRoot, "opencode.json"),
    join(projectRoot, "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
  ]
  const names: string[] = []
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const text = readFileSync(path, "utf-8")
      const cfg = JSON.parse(stripJsoncComments(text)) as {
        plugin?: Array<string | [string, ...unknown[]] | { name?: string }>
      }
      const arr = Array.isArray(cfg.plugin) ? cfg.plugin : []
      for (const entry of arr) {
        if (typeof entry === "string") {
          names.push(entry)
        } else if (Array.isArray(entry) && typeof entry[0] === "string") {
          names.push(entry[0])
        } else if (entry && typeof entry === "object" && typeof (entry as { name?: string }).name === "string") {
          names.push((entry as { name: string }).name)
        }
      }
    } catch {
      // Unreadable or non-JSON config — move on; this is best-effort
      // detection, not a validation pass.
    }
  }
  const unique = Array.from(new Set(names))
  return {
    ohMyOpencode: unique.some((n) => OH_MY_OPENCODE.test(n)),
    caveman: unique.some((n) => CAVEMAN.test(n)),
    found: unique,
  }
}

/**
 * Strip `/* ... *\/` and `//` line comments from a JSONC-style string.
 * Conservative — doesn't handle `//` inside string literals, which is
 * effectively never the case in an `opencode.json` plugin array. If
 * JSON.parse still fails after stripping, the caller treats the file
 * as unreadable and moves on.
 */
function stripJsoncComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
}
