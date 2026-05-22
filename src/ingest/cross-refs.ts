/**
 * cross-refs.ts — grammar-agnostic edge discovery between files.
 *
 * The hard part isn't finding connections; the hard part is finding
 * them with FEW false positives. Single-signal heuristics (regex
 * "import" detection, free-text identifier mentions) all have
 * meaningful FP rates that mislead the agent's navigation. This
 * ingester uses MULTI-SIGNAL CORROBORATION:
 *
 *   - Filesystem-grounded signals (path-resolves-to-existing-file)
 *     emit edges alone — the disk grounds them.
 *   - Lexical signals (identifier mention) only emit edges when
 *     corroborated by a SECOND orthogonal signal (rarity + import-
 *     line context, OR rarity + filename-class coupling).
 *
 * Four passes:
 *
 *   1. Definition extraction (language-keyed regex). Builds a map
 *      `identifier → Set<defining-file>`.
 *   2. Import-path resolution. For each file, find import-like lines,
 *      try to resolve the named module/path to an actual file under
 *      the project root. Existing → edge.
 *   3. Config path-strings. For .json/.yaml/.toml, walk string values
 *      and try to resolve them as relative file paths. Existing → edge.
 *   4. Corroborated identifier mentions. Tokenise each file line by
 *      line; for tokens that are defined elsewhere AND rarity-gated,
 *      emit an edge only when *also* corroborated by either an
 *      import-line context or filename-class coupling.
 *
 * Edges with the same (source, target) pair are merged; the evidence
 * list grows but only one memory is written per edge.
 *
 * **What this catches that code-map doesn't:** any cross-file
 * connection in a language tree-sitter doesn't have a grammar for
 * (Ruby, Pascal, Perl, Lua, Elixir, Erlang, Tcl, Nim, Zig, Swift,
 * Kotlin, Scala, Haskell, OCaml, F#, Clojure, Pascal, VB, …), plus
 * config-style cross-references in JSON/YAML/TOML files.
 *
 * **What it doesn't catch:** dynamic loads (`require(varName)`),
 * reflection-based dispatch, anything where the connection only
 * exists at runtime. Those are out of scope for any static technique.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, sep, extname, dirname, basename } from "node:path"

import type { MemoryRepository } from "../store/repository.js"
import { mapConcurrent } from "../utils/concurrent.js"

const CATEGORY = "project-facts"

/**
 * How many file stat+read pairs the cross-refs ingester runs in
 * parallel. 32 is comfortably below any reasonable open-file ulimit
 * (Linux default 1024, macOS 256) and saturates SSD throughput
 * without thrashing on a network mount. Tuning higher gives
 * diminishing returns; lower defeats the purpose.
 */
const READ_CONCURRENCY = 32

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
  "tmp",
  "__pycache__",
])

/* ── caps ──────────────────────────────────────────────────────────── */

const MAX_FILES = 2000
const MAX_FILE_BYTES = 256 * 1024
const MAX_DEFS_PER_FILE = 200
const MAX_TOKENS_PER_FILE = 50_000 // tokenisation guard for huge files
const MAX_EDGES_TOTAL = 10_000

/* ── language-keyed definition patterns ────────────────────────────── */
/*
 * Each pattern uses /m (multiline ^/$) with one capture group: the
 * identifier name. `g` so we can iterate matches with matchAll.
 *
 * Coverage notes per language. The list is curated by what we observe
 * in real code, not what a language grammar would consider complete.
 */
const DEFINITION_PATTERNS: Record<string, RegExp[]> = {
  // Ruby — class, module, def. `self.` prefix for class methods kept
  // out of the capture so `UserService.create` mentions match.
  ".rb": [
    /^\s*class\s+([A-Z][\w:]*)\b/gm,
    /^\s*module\s+([A-Z][\w:]*)\b/gm,
    /^\s*def\s+(?:self\.)?([\w?!]+)/gm,
  ],

  // Pascal / Object Pascal / Delphi. Case-insensitive — Pascal is
  // historically case-insensitive and real code mixes `Procedure`,
  // `procedure`, `PROCEDURE`.
  ".pas": [
    /^\s*unit\s+(\w+)\s*;/gim,
    /^\s*procedure\s+(\w+)/gim,
    /^\s*function\s+(\w+)/gim,
    /\btype\s+(\w+)\s*=\s*(?:class|record|interface|object)\b/gim,
  ],
  ".pp": [
    /^\s*unit\s+(\w+)\s*;/gim,
    /^\s*procedure\s+(\w+)/gim,
    /^\s*function\s+(\w+)/gim,
    /\btype\s+(\w+)\s*=\s*(?:class|record|interface|object)\b/gim,
  ],
  ".dpr": [/^\s*program\s+(\w+)\s*;/gim],

  // Perl — package, sub. Package names can contain `::` (kept in capture).
  ".pl": [
    /^\s*package\s+([\w:]+)\s*;/gm,
    /^\s*sub\s+(\w+)/gm,
  ],
  ".pm": [
    /^\s*package\s+([\w:]+)\s*;/gm,
    /^\s*sub\s+(\w+)/gm,
  ],

  // Lua — function, method, local function. `function Module.name` and
  // `function Module:name` both expose `name`.
  ".lua": [
    /^\s*(?:local\s+)?function\s+(\w+)/gm,
    /^\s*function\s+\w+[.:](\w+)/gm,
    /^\s*(\w+)\s*=\s*function\b/gm,
  ],

  // Elixir — defmodule (dotted), def/defp/defmacro.
  ".ex": [
    /^\s*defmodule\s+([\w.]+)/gm,
    /^\s*defp?\s+(\w+)/gm,
    /^\s*defmacrop?\s+(\w+)/gm,
  ],
  ".exs": [
    /^\s*defmodule\s+([\w.]+)/gm,
    /^\s*defp?\s+(\w+)/gm,
  ],

  // Erlang — module declaration, exported functions.
  ".erl": [
    /^-module\(([\w_]+)\)/gm,
    /^([a-z]\w*)\s*\([^)]*\)\s*->/gm, // function clause
  ],

  // Swift, Kotlin, Scala, Dart, Zig, Nim — class/func/struct + a few.
  ".swift": [
    /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?(?:class|struct|enum|protocol)\s+([A-Z]\w*)\b/gm,
    /^\s*(?:public\s+|private\s+|internal\s+)?func\s+(\w+)/gm,
  ],
  ".kt": [
    /^\s*(?:public\s+|private\s+|internal\s+|protected\s+|open\s+|abstract\s+)*(?:class|interface|object|enum)\s+([A-Z]\w*)\b/gm,
    /^\s*(?:public\s+|private\s+|internal\s+)?fun\s+(\w+)/gm,
  ],
  ".kts": [
    /^\s*(?:public\s+|private\s+|internal\s+)*(?:class|interface|object)\s+([A-Z]\w*)\b/gm,
    /^\s*(?:public\s+|private\s+|internal\s+)?fun\s+(\w+)/gm,
  ],
  ".scala": [
    /^\s*(?:abstract\s+)?(?:class|trait|object|enum)\s+([A-Z]\w*)\b/gm,
    /^\s*def\s+(\w+)/gm,
  ],
  ".dart": [
    /^\s*(?:abstract\s+)?class\s+([A-Z]\w*)\b/gm,
    /^\s*(?:[A-Z]\w*\s+)?(\w+)\s*\([^)]*\)\s*(?:async\s*)?(?:=>|\{)/gm,
  ],
  ".zig": [
    /^\s*(?:pub\s+)?fn\s+(\w+)/gm,
    /^\s*(?:pub\s+)?const\s+([A-Z]\w*)\s*=\s*struct\b/gm,
  ],
  ".nim": [
    /^\s*proc\s+(\w+)/gm,
    /^\s*type\s+(\w+)\b/gm,
  ],

  // OCaml / F# / Haskell / Clojure — module-style declarations.
  ".ml": [
    /^\s*module\s+([A-Z]\w*)\b/gm,
    /^\s*let\s+(\w+)/gm,
  ],
  ".mli": [/^\s*module\s+([A-Z]\w*)\b/gm, /^\s*val\s+(\w+)/gm],
  ".fs": [
    /^\s*module\s+([A-Z]\w*)\b/gm,
    /^\s*let\s+(\w+)/gm,
    /^\s*type\s+([A-Z]\w*)\b/gm,
  ],
  ".hs": [
    /^\s*module\s+([A-Z][\w.]*)\s+(?:where|\()/gm,
    /^([a-z]\w*)\s*::/gm, // top-level type signature
  ],
  ".clj": [/^\s*\(ns\s+([\w.-]+)/gm, /^\s*\(defn-?\s+([\w?!-]+)/gm],

  // Visual Basic, Tcl, R — for completeness.
  ".vb": [
    /^\s*(?:Public\s+|Private\s+|Friend\s+)?(?:Class|Module|Interface|Structure)\s+(\w+)/gim,
    /^\s*(?:Public\s+|Private\s+)?(?:Sub|Function)\s+(\w+)/gim,
  ],
  ".tcl": [/^\s*proc\s+(\w+)/gm],
  ".r": [/^\s*(\w+)\s*<-\s*function\b/gm],

  // Shell scripts — function definitions.
  ".sh": [
    /^\s*(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/gm,
  ],
  ".bash": [
    /^\s*(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/gm,
  ],

  // ── Crystal — Ruby-family with explicit struct keyword ───────────
  // Same surface as Ruby but adds `struct` and supports `def self.x`.
  // We capture leaf names; the rarity gate filters out generic ones.
  ".cr": [
    /^\s*class\s+([A-Z]\w*)/gm,
    /^\s*struct\s+([A-Z]\w*)/gm,
    /^\s*module\s+([A-Z]\w*)/gm,
    /^\s*def\s+(?:self\.)?(\w+[!?=]?)/gm,
  ],

  // ── Julia — function / module / struct (immutable + mutable) ─────
  ".jl": [
    /^\s*function\s+(\w+)/gm,
    /^\s*module\s+([A-Z]\w*)/gm,
    /^\s*(?:mutable\s+)?struct\s+([A-Z]\w*)/gm,
    /^\s*abstract\s+type\s+([A-Z]\w*)/gm,
  ],

  // ── GraphQL — schema types, all the kinds the spec defines ───────
  // SDL is line-oriented for declarations: each definition starts at
  // column 0 with the kind keyword. We cover all six declaration
  // forms. The DSL is a true definition language — types reference
  // each other in field positions (`field: OtherType`), which our
  // mention-based pass picks up downstream.
  ".graphql": [
    /^\s*type\s+([A-Z]\w*)/gm,
    /^\s*input\s+([A-Z]\w*)/gm,
    /^\s*interface\s+([A-Z]\w*)/gm,
    /^\s*enum\s+([A-Z]\w*)/gm,
    /^\s*union\s+([A-Z]\w*)\s*=/gm,
    /^\s*scalar\s+([A-Z]\w*)/gm,
  ],
  ".gql": [
    /^\s*type\s+([A-Z]\w*)/gm,
    /^\s*input\s+([A-Z]\w*)/gm,
    /^\s*interface\s+([A-Z]\w*)/gm,
    /^\s*enum\s+([A-Z]\w*)/gm,
    /^\s*union\s+([A-Z]\w*)\s*=/gm,
    /^\s*scalar\s+([A-Z]\w*)/gm,
  ],

  // ── Protocol Buffers — message / service / enum + import paths ───
  // Proto files have `import "other.proto";` lines that the path-
  // resolved-string pass already picks up. Definitions here let the
  // mention-based pass connect proto files that share types.
  ".proto": [
    /^\s*message\s+([A-Z]\w*)/gm,
    /^\s*service\s+([A-Z]\w*)/gm,
    /^\s*enum\s+([A-Z]\w*)/gm,
  ],

  // ── Thrift — struct / service / exception / enum ─────────────────
  // Like proto but with exception types. Has `include "other.thrift"`
  // import statements that the path pass picks up.
  ".thrift": [
    /^\s*struct\s+([A-Z]\w*)/gm,
    /^\s*service\s+([A-Z]\w*)/gm,
    /^\s*enum\s+([A-Z]\w*)/gm,
    /^\s*exception\s+([A-Z]\w*)/gm,
    /^\s*union\s+([A-Z]\w*)/gm,
  ],

  // ── Verilog / SystemVerilog ──────────────────────────────────────
  // Verilog modules are lowercase by convention; can't reuse the
  // capital-letter `module` pattern from Ruby/OCaml. Anchored by the
  // trailing `#`, `(`, or `;` that follows a real module header.
  ".v": [
    /^\s*module\s+(\w+)\s*[#(;]/gm,
  ],
  ".sv": [
    /^\s*module\s+(\w+)\s*[#(;]/gm,
    /^\s*(?:virtual\s+)?class\s+(\w+)\s*[#(;:]/gm,
    /^\s*interface\s+(\w+)\s*[#(;]/gm,
    /^\s*package\s+(\w+)\s*;/gm,
  ],
  ".vh": [/^\s*module\s+(\w+)\s*[#(;]/gm],
  ".svh": [
    /^\s*(?:virtual\s+)?class\s+(\w+)\s*[#(;:]/gm,
    /^\s*interface\s+(\w+)\s*[#(;]/gm,
    /^\s*package\s+(\w+)\s*;/gm,
  ],

  // ── VHDL ─────────────────────────────────────────────────────────
  // VHDL is case-insensitive (canonically uppercase keywords). The
  // `is`/`of` anchor at the end pins the definition shape and keeps
  // these from matching Ruby/JS `entity` mentions etc.
  ".vhd": [
    /^\s*entity\s+(\w+)\s+is\b/gim,
    /^\s*architecture\s+(\w+)\s+of\s+\w+\s+is\b/gim,
    /^\s*package\s+(\w+)\s+is\b/gim,
    /^\s*configuration\s+(\w+)\s+of\b/gim,
  ],
  ".vhdl": [
    /^\s*entity\s+(\w+)\s+is\b/gim,
    /^\s*architecture\s+(\w+)\s+of\s+\w+\s+is\b/gim,
    /^\s*package\s+(\w+)\s+is\b/gim,
    /^\s*configuration\s+(\w+)\s+of\b/gim,
  ],

  // ── COBOL ────────────────────────────────────────────────────────
  // PROGRAM-ID is the canonical identifier of a COBOL program;
  // section / paragraph names are too noisy to capture wholesale.
  // The `\.` terminator after PROGRAM-ID is required by the
  // grammar — keeps the pattern from matching prose.
  ".cob": [/^\s*PROGRAM-ID\.\s+([\w-]+)\s*\.?/gim],
  ".cbl": [/^\s*PROGRAM-ID\.\s+([\w-]+)\s*\.?/gim],
  ".cpy": [/^\s*PROGRAM-ID\.\s+([\w-]+)\s*\.?/gim],

  // ── Fortran (modern: free-form .f90+) ────────────────────────────
  // Fixed-form .f / .for is column-sensitive and not worth the
  // complexity. Modern Fortran is line-anchored and well-served by
  // these patterns.
  ".f90": [
    /^\s*subroutine\s+(\w+)/gim,
    /^\s*(?:[\w\s(),:*]+?\s+)?function\s+(\w+)\s*\(/gim,
    /^\s*module\s+(\w+)/gim,
    /^\s*program\s+(\w+)/gim,
  ],
  ".f95": [
    /^\s*subroutine\s+(\w+)/gim,
    /^\s*(?:[\w\s(),:*]+?\s+)?function\s+(\w+)\s*\(/gim,
    /^\s*module\s+(\w+)/gim,
    /^\s*program\s+(\w+)/gim,
  ],
  ".f03": [
    /^\s*subroutine\s+(\w+)/gim,
    /^\s*module\s+(\w+)/gim,
  ],
  ".f08": [
    /^\s*subroutine\s+(\w+)/gim,
    /^\s*module\s+(\w+)/gim,
  ],

  // ── Solidity ─────────────────────────────────────────────────────
  // `contract` / `interface` / `library` are the three top-level
  // declaration kinds. Existing `import "..."` pattern already covers
  // Solidity imports; no new import pattern needed.
  ".sol": [
    /^\s*(?:abstract\s+)?contract\s+([A-Z]\w*)/gm,
    /^\s*interface\s+([A-Z]\w*)/gm,
    /^\s*library\s+([A-Z]\w*)/gm,
    /^\s*function\s+(\w+)\s*\(/gm,
  ],

  // ── Vim script ───────────────────────────────────────────────────
  // `function!` is the redefining form, `function` the strict one;
  // both name a function. Optional scope prefix (`s:`, `g:`, `b:`,
  // `w:`, `t:`) is stripped from the capture so the name is the leaf
  // — matches how a `:call MyFunc()` reference appears.
  ".vim": [/^\s*function!?\s+(?:[sgbwt]:)?(\w+)/gm],

  // ── D ───────────────────────────────────────────────────────────
  // D is C-family with a distinct `module` declaration. The Java/C++
  // class/struct/interface patterns under GENERIC handle the rest;
  // here we just add the module decl so `module pkg.thing;` files
  // are picked up. D's `import` is covered by the existing JS-style
  // import pattern.
  ".d": [
    /^\s*module\s+([\w.]+)\s*;/gm,
    /^\s*(?:public\s+|private\s+)?(?:class|struct|interface|enum|template)\s+([A-Z]\w*)/gm,
  ],

  // ── Smalltalk ────────────────────────────────────────────────────
  // The canonical "class A subclass: #B" form. Other Smalltalk
  // dialects (Pharo class definitions across multiple lines) are
  // out of scope for a regex pass — too easy to FP. This single
  // pattern is high-precision.
  ".st": [/^[A-Z][\w]*\s+subclass:\s*#(\w+)/gm],

  // ── Racket / Scheme / Common Lisp ────────────────────────────────
  // Parenthesised forms; we anchor at start of an open paren on the
  // line. Lisp identifiers allow many extra chars (`!`, `?`, `+`,
  // `-`, `*`, `/`, `=`, `<`, `>`). Multi-line definitions are common
  // but the form keyword + name is on the first line — that's what
  // we capture.
  ".rkt": [
    /^\s*\(define(?:-struct)?\s+\(?([\w!?+\-*/=<>]+)/gm,
    /^\s*\(provide\s+([\w!?+\-*/=<>]+)/gm,
  ],
  ".scm": [/^\s*\(define\s+\(?([\w!?+\-*/=<>]+)/gm],
  ".ss": [/^\s*\(define\s+\(?([\w!?+\-*/=<>]+)/gm],
  ".lisp": [
    /^\s*\(defun\s+([\w!?+\-*/=<>]+)/gm,
    /^\s*\(defmacro\s+([\w!?+\-*/=<>]+)/gm,
    /^\s*\(defclass\s+([\w!?+\-*/=<>]+)/gm,
    /^\s*\(defstruct\s+([\w!?+\-*/=<>]+)/gm,
    /^\s*\(defpackage\s+:?([\w!?+\-*/=<>]+)/gm,
  ],
  ".cl": [
    /^\s*\(defun\s+([\w!?+\-*/=<>]+)/gm,
    /^\s*\(defclass\s+([\w!?+\-*/=<>]+)/gm,
  ],

  // ── Modula-2 ─────────────────────────────────────────────────────
  // Modula-2 keywords are uppercase by convention. The MODULE
  // declaration is the canonical identifier; PROCEDUREs inside are
  // captured too. Niche but the user explicitly asked for languages
  // without reliable tree-sitter grammars.
  ".mod": [
    /^\s*MODULE\s+(\w+)\s*;/gm,
    /^\s*PROCEDURE\s+(\w+)/gm,
  ],
  ".m2": [
    /^\s*MODULE\s+(\w+)\s*;/gm,
    /^\s*PROCEDURE\s+(\w+)/gm,
  ],

  // ── Ada ──────────────────────────────────────────────────────────
  // `package Foo is` and `procedure Foo is`. Existing `with Foo;`
  // import line pattern would cover Ada imports if we added one;
  // skipped for now — Ada is rare enough that demand will surface
  // the need before we speculate.
  ".adb": [
    /^\s*package(?:\s+body)?\s+([\w.]+)\s+is\b/gim,
    /^\s*procedure\s+([\w.]+)/gim,
  ],
  ".ads": [
    /^\s*package(?:\s+body)?\s+([\w.]+)\s+is\b/gim,
    /^\s*procedure\s+([\w.]+)/gim,
    /^\s*function\s+(\w+)/gim,
  ],
}

/** Languages we DON'T have a dedicated pattern set for: try a small
 *  generic set so we still get something. Conservative — only the
 *  most universally-marked forms. */
const GENERIC_DEFINITION_PATTERNS: RegExp[] = [
  /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|static\s+)*(?:class|interface|trait|enum|struct)\s+([A-Z]\w*)\b/gm,
  /^\s*(?:def|func|fn|function|defn|defmodule)\s+(\w+)/gm,
]

/* ── import-line patterns ──────────────────────────────────────────── */
/*
 * Each pattern captures a string that names a module or file path the
 * importing file depends on. The resolver below tries to map the
 * captured text to an actual file under the project root.
 */
const IMPORT_PATTERNS: RegExp[] = [
  // Python: `from foo.bar import X` (capture `foo.bar`)
  /^\s*from\s+([\w.]+)\s+import\b/gm,
  // Python / Java / Go / Kotlin: `import foo.bar`
  /^\s*import\s+(?:[\w*{}\s,]+from\s+)?["']?([\w./@-]+)["']?/gm,
  // Ruby: `require 'foo'` and `require_relative './foo'`
  /^\s*require(?:_relative)?\s+["']([^"']+)["']/gm,
  // Rust / Elixir / Perl / PHP: `use foo::Bar`
  /^\s*use\s+([\w:.]+)/gm,
  // C / C++: `#include "foo.h"` or `<foo.h>`
  /^\s*#\s*include\s+[<"]([^>"]+)[>"]/gm,
  // Pascal: `uses Math, SysUtils, MyUnit;` — multiple names in one line
  /^\s*uses\s+([\w\s,]+);/gim,
  // OCaml / F#: `open Foo`
  /^\s*open\s+([\w.]+)/gm,
  // Lua: `require 'foo'`
  /^\s*(?:local\s+\w+\s*=\s*)?require\s*\(?\s*["']([^"']+)["']/gm,
  // Elixir: `alias MyApp.Module` and `import MyApp.Module`
  /^\s*alias\s+([\w.]+)/gm,
  // Shell: `source path/to/script.sh` and the `.` synonym.
  // The trailing path can be quoted or bare.
  /^\s*(?:source|\.)\s+["']?([^"'\s]+)["']?/gm,
  // Verilog / SystemVerilog: `` `include "file.v" ``
  // Backtick-prefix is unique to Verilog preprocessor directives —
  // can't be confused with any other language. Captures the path.
  /^\s*`include\s+["<]([^>"]+)[>"]/gm,
  // COBOL: `COPY copybook.` or `COPY copybook.cpy.`
  // The trailing period is COBOL's statement terminator — required
  // by the grammar so this won't FP-match prose. Case-insensitive
  // because real COBOL mixes cases despite convention.
  /^\s*COPY\s+["']?([\w.-]+)["']?\s*\./gim,
  // Vim script: `:runtime path/to/file.vim` (`!` is the bang variant)
  // — the editor's analogue of `source` for files under the runtimepath.
  /^\s*:?\s*runtime!?\s+(?:[\w/]+\s+)*([\w./~-]+\.vim)\b/gm,
]

/* ── path-resolvable string detection (config files) ──────────────── */

const CONFIG_EXTS = new Set([
  ".json", ".jsonc", ".json5",
  ".yml", ".yaml",
  ".toml",
  // Terraform / OpenTofu — `source = "../modules/x"` is a path-string
  // reference of exactly the kind this ingester catches. Treated as
  // config (not source) since we don't extract HCL definitions.
  ".tf", ".tfvars",
  // Older Unix-style config files — INI sections rarely reference
  // paths but when they do (`include=…`) we want to catch it.
  ".ini", ".cfg", ".conf",
])

/* ── public API ───────────────────────────────────────────────────── */

export interface CrossRefsIngestResult {
  filesWalked: number
  definitionsExtracted: number
  edgesEmitted: number
  /** Breakdown by primary evidence type — for the analyse-logs view. */
  byEvidence: Record<string, number>
}

export interface CrossRefsOptions {
  /** See `UserConfig.crossRefsRarityThreshold`. Defaults to 3. */
  rarityThreshold?: number
  /** See `UserConfig.crossRefsMaxFiles`. Defaults to 2000. */
  maxFiles?: number
  /** See `UserConfig.crossRefsMaxEdges`. Defaults to 10 000. */
  maxEdges?: number
}

export async function ingestCrossRefs(
  repo: MemoryRepository,
  root: string,
  opts: CrossRefsOptions = {},
): Promise<CrossRefsIngestResult> {
  const rarityThreshold = Math.max(1, Math.round(opts.rarityThreshold ?? 3))
  const maxFilesLimit   = Math.max(1, Math.round(opts.maxFiles ?? MAX_FILES))
  const maxEdgesLimit   = Math.max(1, Math.round(opts.maxEdges ?? MAX_EDGES_TOTAL))
  // ── Walk: collect all candidate files ──────────────────────────────
  const allFiles = await collectFiles(root, maxFilesLimit)

  // ── Pass 1: definitions per file → identifier → defining-files map ─
  const defs = new Map<string, Set<string>>()
  // identifier → list of (file, line) for filename-coupling resolution
  // (we keep the file; the line isn't needed for the edge logic).
  let totalDefs = 0
  for (const f of allFiles) {
    const ext = extname(f.rel).toLowerCase()
    const patterns = DEFINITION_PATTERNS[ext] ?? GENERIC_DEFINITION_PATTERNS
    let perFileDefs = 0
    for (const pat of patterns) {
      for (const m of f.content.matchAll(pat)) {
        const ident = m[1]
        if (!ident || !isUsefulIdentifier(ident)) continue
        if (!defs.has(ident)) defs.set(ident, new Set())
        const set = defs.get(ident)!
        if (!set.has(f.rel)) {
          set.add(f.rel)
          perFileDefs += 1
          totalDefs += 1
        }
        // For dotted (Elixir, Python) or double-colon (Perl) namespaced
        // identifiers, ALSO register the trailing segment as defined
        // here. Real-world reference sites use the trailing segment
        // alone after an `alias`/`use` line:
        //
        //   defmodule MyApp.Auth do ...  ← lib/auth.ex
        //   alias MyApp.Auth             ← lib/router.ex
        //   Auth.verify(token)           ← uses bare "Auth"
        //
        // Without this, `Auth` is never in `defs` and the corroboration
        // pass can't connect router.ex → auth.ex via filename coupling.
        // Filename coupling + rarity is what keeps FP low.
        if (/[.:]/.test(ident)) {
          const segments = ident.split(/[.:]+/).filter((s) => s.length > 0)
          const last = segments[segments.length - 1]
          if (last && last !== ident && isUsefulIdentifier(last)) {
            if (!defs.has(last)) defs.set(last, new Set())
            const set2 = defs.get(last)!
            if (!set2.has(f.rel)) {
              set2.add(f.rel)
              totalDefs += 1
            }
          }
        }
        if (perFileDefs >= MAX_DEFS_PER_FILE) break
      }
      if (perFileDefs >= MAX_DEFS_PER_FILE) break
    }
  }

  // ── Edge accumulator. Same (src, tgt) merges. ──────────────────────
  const edges = new Map<string, EdgeEvidence>()
  const fileSet = new Set(allFiles.map((f) => f.rel))

  // ── Pass 2: import-line path resolution ────────────────────────────
  // The captured module/path is normalised to candidate relative paths
  // and checked against fileSet. Existence is the gate.
  for (const f of allFiles) {
    for (const pat of IMPORT_PATTERNS) {
      for (const m of f.content.matchAll(pat)) {
        const raw = m[1]
        if (!raw) continue
        // Pascal `uses` lists are comma-separated.
        const names = raw.includes(",") ? raw.split(",").map((s) => s.trim()) : [raw.trim()]
        for (const name of names) {
          const candidates = resolveImportToFiles(name, f.rel, fileSet)
          for (const tgt of candidates) {
            if (tgt === f.rel) continue
            addEdge(edges, f.rel, tgt, "import-resolved", maxEdgesLimit)
          }
        }
      }
    }
  }

  // ── Pass 3: config-path-strings ────────────────────────────────────
  for (const f of allFiles) {
    if (!CONFIG_EXTS.has(extname(f.rel).toLowerCase())) continue
    // Best-effort JSON parse for .json / .jsonc / .json5. YAML/TOML
    // get a regex-based string-value extractor — full parsers would
    // add a multi-MB dep for a small precision gain; we already gate
    // on filesystem existence so a mis-extracted string is silently
    // dropped, not a FP.
    const stringValues = extractStringsFromConfig(f.content, extname(f.rel).toLowerCase())
    for (const sv of stringValues) {
      const tgt = resolveConfigPath(sv, f.rel, fileSet)
      if (tgt && tgt !== f.rel) {
        addEdge(edges, f.rel, tgt, "config-path", maxEdgesLimit)
      }
    }
  }

  // ── Pass 4: corroborated identifier mentions ───────────────────────
  // For each file F, tokenise line-by-line. For each token that is
  // defined elsewhere AND is rarity-gated, check the corroboration
  // signals before emitting.
  //
  // Performance: each file is tokenised once. Each token is a hashmap
  // lookup against `defs`. O(N × tokens_per_file).
  for (const f of allFiles) {
    if (edges.size >= maxEdgesLimit) break
    const lines = f.content.split("\n")
    const ext = extname(f.rel).toLowerCase()
    let tokensSeen = 0
    for (let i = 0; i < lines.length; i++) {
      if (tokensSeen >= MAX_TOKENS_PER_FILE) break
      const line = lines[i]
      // Skip comment-only lines so identifier mentions inside
      // comments don't fire the corroboration gate. The trimmed-line
      // check means inline trailing comments are still kept — we only
      // skip when the WHOLE line is a comment.
      if (lineIsCommentOnly(line, ext)) continue
      const isImportLine = lineLooksLikeImport(line)
      // When an import-like line contains a literal path string
      // (e.g. shell `source ./lib.sh`, Ruby `load './script.rb'`,
      // shell `. /etc/foo.sh`), the path is a stronger edge signal
      // than identifier matching — it's filesystem-grounded.
      // Extract any `./…`, `../…`, or `/…` substring from the line,
      // resolve against fileSet, and emit an edge if it lands on a
      // real file. This is INDEPENDENT of the identifier rarity gate
      // because the existence-on-disk check is the gate.
      if (isImportLine) {
        // Two alternatives OR'd together:
        //   (1) UNQUOTED leading-slash paths — `source ./lib.sh`,
        //       `. /etc/init.d/foo.sh`. Must start with `./`, `../`,
        //       or `/` (else any identifier could match).
        //   (2) QUOTED paths — `source('lib/stats.R')`,
        //       `load "vendor/x.rb"`. Inside `'…'`/`"…"`/backticks,
        //       any non-whitespace sequence ending in `.<ext>`
        //       qualifies; the filesystem-existence gate grounds it.
        const pathInImport =
          /(?:^|[\s,(=])(\.{0,2}\/[\w./-]+\.\w{1,8})(?=[\s,;)`'"]|$)|['"`]([^'"`\s\\]{2,200}\.\w{1,8})['"`]/g
        let pm
        while ((pm = pathInImport.exec(line)) !== null) {
          const cand = pm[1] ?? pm[2]
          if (!cand) continue
          const resolved = resolveConfigPath(cand, f.rel, fileSet)
          if (resolved && resolved !== f.rel) {
            addEdge(edges, f.rel, resolved, "import-path", maxEdgesLimit)
          }
        }
      }
      // word-shape tokens; skip everything else.
      // Pre-split saves repeated regex work versus matchAll on every iteration.
      const tokens = line.split(/[^\w:]+/).filter((t) => t.length > 0)
      for (const tok of tokens) {
        tokensSeen += 1
        if (tokensSeen >= MAX_TOKENS_PER_FILE) break
        const definingFiles = defs.get(tok)
        if (!definingFiles || definingFiles.size === 0) continue
        // RARITY GATE: identifier defined in too many files is noise.
        if (definingFiles.size > rarityThreshold) continue
        for (const definedIn of definingFiles) {
          if (definedIn === f.rel) continue
          // CORROBORATION: import-line context OR filename-coupling.
          const couples = filenameCouples(definedIn, tok)
          if (!isImportLine && !couples) continue
          const evidence = isImportLine
            ? (couples ? "import+filename" : "import+identifier")
            : "filename+identifier"
          addEdge(edges, f.rel, definedIn, evidence, maxEdgesLimit)
        }
      }
    }
  }

  // ── Emit edges as memories ─────────────────────────────────────────
  const byEvidence: Record<string, number> = {}
  let emitted = 0
  for (const [, ev] of edges) {
    if (emitted >= maxEdgesLimit) break
    const primary = pickPrimaryEvidence(ev.evidences)
    byEvidence[primary] = (byEvidence[primary] ?? 0) + 1
    const evList = Array.from(ev.evidences).sort().join(" + ")
    repo.insertIfMissing({
      category: CATEGORY,
      subject: `xref:${ev.src}->${ev.tgt}`,
      content:
        `${ev.src} references ${ev.tgt} (evidence: ${evList}). ` +
        `Cross-reference inferred without a language grammar; treat as a navigation hint.`,
      tags: ["xref", "cross-reference", primary, ...basenameTagsForPair(ev.src, ev.tgt)],
      source: "cross-refs-ingest",
    })
    emitted += 1
  }

  return {
    filesWalked: allFiles.length,
    definitionsExtracted: totalDefs,
    edgesEmitted: emitted,
    byEvidence,
  }
}

/* ── internals ─────────────────────────────────────────────────────── */

interface CandidateFile {
  abs: string
  rel: string
  content: string
}

interface EdgeEvidence {
  src: string
  tgt: string
  evidences: Set<string>
}

async function collectFiles(root: string, maxFiles: number = MAX_FILES): Promise<CandidateFile[]> {
  // Phase 1: walk the tree and collect candidate ABSOLUTE paths that
  // pass the cheap dirent + extension filter. Directory listings are
  // the only I/O here — `stat` and `readFile` are deferred to phase 2
  // so they can run in parallel.
  //
  // We collect up to `maxFiles` candidate paths. A few may drop out
  // during phase-2 filtering (zero-byte, oversize, or binary files),
  // which is exactly how the original sequential implementation
  // behaved when those filters fired — net result count is the same
  // ±the tiny minority of candidates that fail size/binary checks.
  const candidates: string[] = []
  const stack = [root]
  while (stack.length > 0 && candidates.length < maxFiles) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (candidates.length >= maxFiles) break
      if (e.name.startsWith(".") && !e.name.startsWith(".github") && !e.name.startsWith(".gitlab")) continue
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(abs)
        continue
      }
      if (!e.isFile()) continue
      // Filter by what we actually do something with: definition-
      // patterns key set ∪ config exts ∪ a few extras for the
      // "generic" pattern fallback. Exhaustive list would be 100+
      // extensions; this captures the common cases we want to walk.
      const ext = extname(e.name).toLowerCase()
      if (!shouldWalkPath(e.name, ext)) continue
      candidates.push(abs)
    }
  }

  // Phase 2: stat + readFile per candidate, in parallel. The 32-wide
  // pool is comfortably below any reasonable open-file ulimit and
  // dominates sequential reads on every storage class measured
  // (warm SSD, cold SSD, network mount). `mapConcurrent` returns
  // results in input order; nulls are dropped at the end.
  const reads = await mapConcurrent(candidates, READ_CONCURRENCY, async (abs): Promise<CandidateFile | null> => {
    let s
    try {
      s = await stat(abs)
    } catch {
      return null
    }
    if (!s.isFile() || s.size === 0 || s.size > MAX_FILE_BYTES) return null
    let content: string
    try {
      content = await readFile(abs, "utf-8")
    } catch {
      return null
    }
    if (content.indexOf("\0") >= 0) return null // binary
    const rel = relative(root, abs).split(sep).join("/")
    return { abs, rel, content }
  })

  const out: CandidateFile[] = []
  for (const r of reads) if (r !== null) out.push(r)
  return out
}

/** No-extension filenames worth walking — Docker/Makefile/Ruby
 *  ecosystem files that other parts of the repo legitimately reference
 *  by name. Recognising them here lets the directory-resolution
 *  branch of `resolveConfigPath` find them as targets (e.g. Docker
 *  Compose `build: services/api` → `services/api/Dockerfile`). */
const NO_EXTENSION_BASENAMES = new Set([
  "Dockerfile",
  "Containerfile",
  "Makefile",
  "Rakefile",
  "Gemfile",
  "Vagrantfile",
  "Procfile",
  "Brewfile",
  "Justfile",
])

function shouldWalkPath(basenameStr: string, ext: string): boolean {
  if (shouldWalkExtension(ext)) return true
  if (NO_EXTENSION_BASENAMES.has(basenameStr)) return true
  return false
}

function shouldWalkExtension(ext: string): boolean {
  if (DEFINITION_PATTERNS[ext]) return true
  if (CONFIG_EXTS.has(ext)) return true
  // Generic-pattern extensions — languages we don't have a dedicated
  // pattern set for but the generic patterns still catch some defs.
  const extras = new Set([
    ".java", ".kt", ".kts", ".scala", ".dart", ".cs", ".vb", ".php",
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".py", ".pyi", ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp",
  ])
  return extras.has(ext)
}

function isUsefulIdentifier(s: string): boolean {
  // 3-50 chars; reject very generic names that produce massive FP.
  if (s.length < 3 || s.length > 50) return false
  const GENERIC = new Set([
    "self", "this", "new", "true", "false", "nil", "null", "none",
    "var", "let", "const", "def", "fn", "func", "function", "return",
    "end", "begin", "if", "else", "for", "while", "do", "in", "of",
    "and", "or", "not", "module", "class", "type", "value", "name",
    "data", "item", "list", "map", "set", "get", "put", "key", "val",
    "main", "init", "run", "test", "spec", "src", "lib", "app",
  ])
  return !GENERIC.has(s.toLowerCase())
}

/** Decide whether a single source line looks like an import/require/use
 *  statement in ANY language. Conservative — false negatives are fine
 *  (the filename-coupling signal picks up the slack); false positives
 *  here cost us in the corroboration gate. */
/**
 * Per-extension line-comment prefixes used to skip pure-comment lines
 * during the mention scan. A line whose trimmed content starts with
 * any of these prefixes is not tokenised — preventing the FP where
 * a token like `alu` mentioned in a `; comment` in a Lisp file would
 * filename-couple to `alu.v` and emit a spurious edge.
 *
 * Conservative — we only list extensions where the prefix is
 * unambiguously a comment marker. Languages like JS/Java where `//`
 * is a comment AND `/` is a path separator are listed; the trimmed-
 * line check (`line.trimStart().startsWith(prefix)`) means inline
 * comments preceded by code are NOT stripped, only comment-only
 * lines are skipped.
 */
const LINE_COMMENT_PREFIXES: Record<string, readonly string[]> = {
  // Lisp family — the FP that motivated this table.
  ".lisp": [";"], ".cl": [";"], ".lsp": [";"],
  ".rkt": [";"], ".scm": [";"], ".ss": [";"], ".clj": [";"], ".cljs": [";"],
  // `;` is also a comment marker in assembly + some Scheme dialects.
  ".asm": [";"], ".s": [";"],
  // # — Python, Ruby, Perl, shell, YAML, TOML, R, Tcl, Nim, Crystal, Elixir.
  ".py": ["#"], ".pyi": ["#"],
  ".rb": ["#"], ".pl": ["#"], ".pm": ["#"],
  ".sh": ["#"], ".bash": ["#"], ".zsh": ["#"],
  ".yml": ["#"], ".yaml": ["#"], ".toml": ["#"],
  ".r": ["#"], ".tcl": ["#"], ".nim": ["#"], ".cr": ["#"],
  ".ex": ["#"], ".exs": ["#"],
  // C family — // (block /* */ handled by stripping in regex too)
  ".js": ["//"], ".jsx": ["//"], ".mjs": ["//"], ".cjs": ["//"],
  ".ts": ["//"], ".tsx": ["//"], ".mts": ["//"], ".cts": ["//"],
  ".c": ["//"], ".h": ["//"], ".cpp": ["//"], ".cc": ["//"], ".cxx": ["//"], ".hpp": ["//"], ".hxx": ["//"],
  ".java": ["//"], ".kt": ["//"], ".kts": ["//"], ".scala": ["//"],
  ".swift": ["//"], ".dart": ["//"], ".cs": ["//"],
  ".go": ["//"], ".rs": ["//"], ".sol": ["//"], ".d": ["//"], ".zig": ["//"],
  ".php": ["//", "#"], // PHP supports both
  ".v": ["//"], ".sv": ["//"], ".vh": ["//"], ".svh": ["//"],
  // -- in SQL, Haskell, Ada, VHDL, Lua
  ".sql": ["--"], ".hs": ["--"], ".lhs": ["--"],
  ".lua": ["--"], ".adb": ["--"], ".ads": ["--"],
  ".vhd": ["--"], ".vhdl": ["--"],
  // % in Erlang, MATLAB
  ".erl": ["%"], ".hrl": ["%"], ".m": ["%"],
  // ' in VB
  ".vb": ["'"],
  // " in vim script
  ".vim": ['"'],
  // // in modern Pascal dialects (FPC/Delphi)
  ".pas": ["//"], ".pp": ["//"], ".dpr": ["//"], ".lpr": ["//"],
  // COBOL — *> in free-form, * in fixed-form (col 7). Trimmed-line
  // start with these covers both.
  ".cob": ["*>", "*"], ".cbl": ["*>", "*"], ".cpy": ["*>", "*"],
  // Fortran — ! for free-form .f90+
  ".f90": ["!"], ".f95": ["!"], ".f03": ["!"], ".f08": ["!"],
}

function lineIsCommentOnly(line: string, ext: string): boolean {
  const prefixes = LINE_COMMENT_PREFIXES[ext]
  if (!prefixes) return false
  const trimmed = line.trimStart()
  if (trimmed.length === 0) return false
  for (const p of prefixes) {
    if (trimmed.startsWith(p)) return true
  }
  return false
}

function lineLooksLikeImport(line: string): boolean {
  // Verbs that introduce an import-style cross-file reference in any
  // language we support. `alias` covers Elixir's `alias Foo.Bar`;
  // `source` covers shell's `source ./lib.sh` (and Tcl's `source`).
  return /^\s*(?:import|from|require|require_relative|use|using|include|#\s*include|uses|open|package|extends|implements|alias|source)\b/i.test(line)
}

/**
 * Map an imported name/path to one or more relative file paths under
 * the project root. Tries multiple candidate shapes per import; only
 * those that exist in `fileSet` are returned.
 *
 * Examples (with `fromFile = lib/main.py`):
 *   "foo.bar"          → ["foo/bar.py", "foo/bar/__init__.py", "lib/foo/bar.py", "lib/foo/bar/__init__.py"]
 *   "./user_service"   → ["lib/user_service.rb", "lib/user_service.py", ...]
 *   "../utils"         → ["utils.rb", "utils.py", ...]
 *   "Greeter"          → ["Greeter.pm", "Greeter.pas", ...]
 */
function resolveImportToFiles(rawName: string, fromFile: string, fileSet: Set<string>): string[] {
  if (!rawName) return []
  const fromDir = dirname(fromFile)

  // Discard import names that obviously belong to standard libraries
  // or external packages (no slashes, no path-shape, and the leading
  // segment looks like a stdlib name). False negatives here are
  // cheap; false positives blow up.
  // Heuristic: relative paths (./ or ../) ALWAYS attempt resolution.
  // Bare names attempt resolution but the existence check in fileSet
  // filters most spurious matches.

  const candidates: string[] = []
  const exts = [
    ".rb", ".pl", ".pm", ".pas", ".pp", ".lua", ".ex", ".exs", ".erl",
    ".swift", ".kt", ".kts", ".scala", ".dart", ".zig", ".nim",
    ".ml", ".mli", ".fs", ".hs", ".clj", ".vb", ".tcl", ".r",
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".py", ".pyi", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc",
    ".cs", ".php", ".sh", ".bash",
    "", // shell scripts with no extension
  ]

  const tryWithExts = (base: string): void => {
    for (const ext of exts) {
      candidates.push(`${base}${ext}`)
    }
    // Python-style package init.
    candidates.push(`${base}/__init__.py`)
    candidates.push(`${base}/index.js`)
    candidates.push(`${base}/index.ts`)
    candidates.push(`${base}/mod.rs`)
    candidates.push(`${base}/lib.rs`)
  }

  const normalised = rawName.trim()
  if (!normalised) return []

  // Universal fallback — try the captured name verbatim as a
  // filename, both at the project root and as a sibling of the
  // importing file. Catches cases where the name has a dot that's
  // NOT a module separator but a file extension (COBOL `COPY
  // customer.cpy`, Verilog `\`include "alu.v"`, anything where the
  // pattern captures `name.ext` directly). For dotted module names
  // these candidates won't exist as files, so this branch is a no-op
  // for the dotted-module case.
  candidates.push(normalised)
  candidates.push(pathJoinNoCollapse(fromDir, normalised))

  // Relative path imports
  if (normalised.startsWith("./") || normalised.startsWith("../")) {
    const resolved = pathJoinNoCollapse(fromDir, normalised)
    tryWithExts(resolved)
    // Direct as-is (already has extension)
    candidates.push(resolved)
  } else if (normalised.includes("/") || normalised.includes("\\")) {
    // Path-like but not explicitly relative — try as-is from project root
    tryWithExts(normalised.replace(/\\/g, "/"))
    candidates.push(normalised.replace(/\\/g, "/"))
  } else {
    // Dotted name (Python/Java/Elixir): foo.bar → foo/bar
    // Colon name (Perl): Foo::Bar → Foo/Bar
    const pathish = normalised.replace(/[.:]+/g, "/")
    tryWithExts(pathish)
    // Also try sibling: lib/main.py importing `helpers` may mean lib/helpers.py
    tryWithExts(join(fromDir, pathish).replace(/\\/g, "/"))
    // Try as bare name (Perl `use Greeter` → Greeter.pm at any depth)
    candidates.push(`${normalised}.pm`)
    candidates.push(`${normalised}.pas`)
    candidates.push(`${normalised}.pp`)
    candidates.push(`${normalised}.lua`)
    // sibling versions of bare names
    candidates.push(join(fromDir, `${normalised}.pm`).replace(/\\/g, "/"))
    candidates.push(join(fromDir, `${normalised}.pas`).replace(/\\/g, "/"))
    candidates.push(join(fromDir, `${normalised}.pp`).replace(/\\/g, "/"))
    candidates.push(join(fromDir, `${normalised}.lua`).replace(/\\/g, "/"))
  }

  const found = new Set<string>()
  for (const c of candidates) {
    const normalised = c.replace(/\\/g, "/").replace(/\/+/g, "/")
    if (fileSet.has(normalised)) found.add(normalised)
  }
  return Array.from(found)
}

/**
 * Like `path.join` but preserves "./" prefix and resolves "../" by
 * walking up segments — without depending on node:path's behaviour
 * which collapses to absolute on some inputs.
 */
function pathJoinNoCollapse(from: string, relPath: string): string {
  const parts = (from === "" ? [] : from.split("/"))
  const relParts = relPath.replace(/\\/g, "/").split("/")
  for (const p of relParts) {
    if (p === "" || p === ".") continue
    if (p === "..") {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(p)
  }
  return parts.join("/")
}

/* ── config-string extraction ─────────────────────────────────────── */

function extractStringsFromConfig(content: string, ext: string): string[] {
  if (ext === ".json" || ext === ".jsonc" || ext === ".json5") {
    // Best-effort parse. JSONC: strip // and /* */ first. JSON5 we
    // attempt as JSONC; on parse failure we fall through to the
    // regex extractor.
    const stripped = ext === ".json" ? content : content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    try {
      const obj = JSON.parse(stripped)
      const out: string[] = []
      walkJson(obj, out)
      return out
    } catch {
      // Fall through to regex extractor below.
    }
  }
  // Regex fallback: any double-quoted string. False positives here
  // are fine — they get filtered by the filesystem-existence gate.
  const matches = content.matchAll(/"([^"\n]{1,200})"/g)
  const out: string[] = []
  for (const m of matches) out.push(m[1])
  // YAML: also single-quoted strings, and bare path-shaped scalars
  // (heuristic; the existence gate filters).
  const single = content.matchAll(/'([^'\n]{1,200})'/g)
  for (const m of single) out.push(m[1])
  // YAML/TOML unquoted scalar values. The single most common GitHub
  // Actions / Ansible / Docker Compose / CI-DSL idiom is unquoted —
  //     run: ./scripts/build.sh
  //     path = "lib/x.js"   (TOML, already caught above by quotes)
  //     entrypoint: bin/server
  // — so without this branch we miss the headline use case for
  // low-code-DSL connection discovery. Match `key: value` (YAML) and
  // `key = value` (TOML) where the value is unquoted, contains no
  // whitespace, and isn't a comment. The filesystem-existence gate
  // downstream filters everything that isn't a real file.
  if (ext === ".yml" || ext === ".yaml" || ext === ".toml") {
    const scalarLine = /^[ \t]*-?[ \t]*[\w\-.]+[ \t]*[:=][ \t]*([^\s#'"`[{][^\s#]*?)[ \t]*(?:#.*)?$/gm
    let m: RegExpExecArray | null
    while ((m = scalarLine.exec(content)) !== null) {
      const v = m[1]
      // Reject values that obviously aren't paths: pure numbers,
      // pure booleans, version specifiers, scalar YAML markers.
      if (!v) continue
      if (/^(true|false|null|yes|no|on|off|~)$/i.test(v)) continue
      if (/^-?\d+(\.\d+)?$/.test(v)) continue
      if (/^[a-z]+:\/\//i.test(v)) continue // URLs
      out.push(v)
    }
    // YAML bare-list items: `  - deployment.yaml` — Kustomize's
    // `resources:` list, Ansible's `roles:` list, and most other
    // no-code DSLs use this shape. The previous `scalarLine` regex
    // requires a `key: value` shape and misses these. The same
    // existence gate downstream filters non-paths.
    const bareListItem = /^[ \t]*-[ \t]+([^\s#'"`[{][^\s#]*?)[ \t]*(?:#.*)?$/gm
    while ((m = bareListItem.exec(content)) !== null) {
      const v = m[1]
      if (!v) continue
      if (/^(true|false|null|yes|no|on|off|~)$/i.test(v)) continue
      if (/^-?\d+(\.\d+)?$/.test(v)) continue
      if (/^[a-z]+:\/\//i.test(v)) continue
      out.push(v)
    }
  }
  return out
}

function walkJson(node: unknown, out: string[]): void {
  if (node === null || node === undefined) return
  if (typeof node === "string") {
    if (node.length >= 2 && node.length < 500) out.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const v of node) walkJson(v, out)
    return
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      // Hint-tracking: the key name doesn't gate emission (existence
      // does) but PATH_KEY_HINTS is useful for the evidence label.
      // For now we just descend; key hints are advisory only.
      void k
      walkJson(v, out)
    }
  }
}

/**
 * Map a candidate string from a config file to a relative path under
 * the project root. Tries (a) direct path under root, (b) relative to
 * config file's directory. Returns the resolved file if it exists in
 * `fileSet`; null otherwise.
 */
function resolveConfigPath(value: string, fromFile: string, fileSet: Set<string>): string | null {
  if (!value || value.length < 2 || value.length > 500) return null
  // Skip values that obviously aren't paths.
  if (value.includes("\n")) return null
  // Skip URLs.
  if (/^https?:\/\//.test(value) || /^[a-z]+:\/\//.test(value)) return null

  const fromDir = dirname(fromFile)
  const cleaned = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "")

  const candidates = [
    cleaned, // as-is relative to project root
    pathJoinNoCollapse(fromDir, value).replace(/\/$/, ""), // relative to the config file
  ]

  // Direct file match — covers the typical case: a config value
  // points at an exact file in the repo.
  for (const c of candidates) {
    const norm = c.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "")
    if (fileSet.has(norm)) return norm
  }

  // Directory-shaped match — covers Docker Compose `build:
  // services/api`, GitHub composite actions `uses: ./.github/actions/build`,
  // and any other DSL convention where a value points at a DIRECTORY
  // whose canonical entry file is the actual edge target. We prefer
  // well-known entry-point filenames (Dockerfile, action.yml,
  // package.json, …) when present; otherwise the directory has no
  // canonical entry and we don't fabricate one.
  const ENTRY_FILE_CANDIDATES = [
    "Dockerfile",
    "action.yml",
    "action.yaml",
    "package.json",
    "Cargo.toml",
    "go.mod",
    "index.js",
    "index.ts",
    "main.py",
    "__init__.py",
    "mod.rs",
    "build.gradle",
    "build.gradle.kts",
    "main.tf",
  ]
  for (const c of candidates) {
    const dirNorm = c.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "")
    if (!dirNorm || fileSet.has(dirNorm)) continue
    // Only treat it as a directory if at least one file under that
    // prefix exists. (Avoids fabricating edges to "directories" that
    // are really nonexistent paths.)
    const dirPrefix = dirNorm + "/"
    let hasAnyFile = false
    for (const f of fileSet) {
      if (f.startsWith(dirPrefix)) { hasAnyFile = true; break }
    }
    if (!hasAnyFile) continue
    for (const entry of ENTRY_FILE_CANDIDATES) {
      const probe = dirPrefix + entry
      if (fileSet.has(probe)) return probe
    }
    // Directory exists but has no canonical entry → don't emit;
    // the agent can navigate by directory name from the config
    // memory itself, and we'd rather skip than emit a noisy edge
    // to some random file.
  }

  return null
}

/* ── filename-class coupling ──────────────────────────────────────── */

/**
 * Returns true if the file's basename plausibly corresponds to the
 * identifier — `user_service.rb` ↔ `UserService`, `MyUnit.pas` ↔
 * `MyUnit`. This is a corroboration signal, not the only signal.
 */
function filenameCouples(file: string, identifier: string): boolean {
  const base = basename(file, extname(file))
  const candidates = new Set([
    base,
    toCamelCase(base),
    toPascalCase(base),
  ])
  if (candidates.has(identifier)) return true
  const lc = identifier.toLowerCase()
  for (const c of candidates) {
    if (c.toLowerCase() === lc) return true
  }
  return false
}

function toCamelCase(s: string): string {
  return s.replace(/[_-](\w)/g, (_, c: string) => c.toUpperCase())
}
function toPascalCase(s: string): string {
  const c = toCamelCase(s)
  return c.charAt(0).toUpperCase() + c.slice(1)
}

/* ── edge bookkeeping ─────────────────────────────────────────────── */

function addEdge(
  edges: Map<string, EdgeEvidence>,
  src: string,
  tgt: string,
  evidence: string,
  maxEdges: number = MAX_EDGES_TOTAL,
): void {
  if (edges.size >= maxEdges) return
  const key = `${src}\x00${tgt}`
  let e = edges.get(key)
  if (!e) {
    e = { src, tgt, evidences: new Set() }
    edges.set(key, e)
  }
  e.evidences.add(evidence)
}

function pickPrimaryEvidence(evidences: Set<string>): string {
  // Ordered by confidence: filesystem-grounded signals first.
  const order = [
    "config-path",
    "import-resolved",
    "import+filename",
    "import+identifier",
    "filename+identifier",
  ]
  for (const e of order) {
    if (evidences.has(e)) return e
  }
  return Array.from(evidences)[0] ?? "unknown"
}

function basenameTagsForPair(src: string, tgt: string): string[] {
  const a = basename(src, extname(src)).toLowerCase().replace(/[^a-z0-9]+/g, "-")
  const b = basename(tgt, extname(tgt)).toLowerCase().replace(/[^a-z0-9]+/g, "-")
  const out: string[] = []
  if (a) out.push(a)
  if (b && b !== a) out.push(b)
  return out
}
