/**
 * Code-map ingestion — an Aider-style "repo map": for each source
 * file, the *signatures* of its top-level definitions (functions,
 * classes, methods, types) with the bodies stripped. The agent gets
 * the shape of the codebase without reading every file.
 *
 * This is the one part of the plugin that is NOT convention-free or
 * dependency-light, and that is a deliberate, opt-in trade:
 *
 *   - It needs `web-tree-sitter` (~290 KB) plus a vendored `.wasm`
 *     grammar per supported language (~10.3 MB for the eleven below —
 *     C++ alone is 4.7 MB and TypeScript 2.3 MB). The rest of the
 *     plugin is a ~77 KB source drop with one tiny dependency; this
 *     feature is most of the install weight.
 *   - It is inherently language-aware: each grammar needs to know
 *     which node types are "definitions" (or selectors / keys /
 *     elements). That per-language table is the `LANG_SPECS` map
 *     below — contained, declarative, and the only place language
 *     knowledge lives.
 *
 * Because of that, code-map is gated behind `config.enableCodeMap`
 * and defaults OFF. When disabled, none of this loads — `import()` of
 * `web-tree-sitter` only happens inside `ingestCodeMap`. Languages we
 * have no grammar for are simply skipped; the rest of the plugin is
 * unaffected.
 *
 * Signatures are stored one `code-map` memory per file via
 * `upsertBySubject`, so they're recallable, co-change-boosted, and
 * token-budgeted like every other memory, and a re-scan replaces
 * rather than accumulates.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Category } from "../types.js"
import type { MemoryRepository } from "../store/repository.js"
import { mapConcurrent } from "../utils/concurrent.js"

const CATEGORY: Category = "code-map"

/**
 * How many source files the code-map ingester processes in parallel.
 * The tree-sitter parser itself is shared and synchronous (see the
 * note in `ingestCodeMap`), so we benefit specifically from
 * overlapping `readFile` waits across tasks. 16 is conservative —
 * the parser is heavier per call than a plain read, so we don't want
 * a queue of 32+ parses waiting on one CPU.
 */
const CODE_MAP_CONCURRENCY = 16

/** Directories never worth walking for a signature map. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  "dist",
  "build",
  "target",
  "vendor",
  ".next",
  "coverage",
  ".idea",
  ".vscode",
])

/**
 * Per-language knowledge: which tree-sitter node types are the
 * "definitions" we want a signature line for. This is the entire
 * language-specific surface of the plugin.
 */
/**
 * How a language's structure is pulled out of the parse tree:
 *   - "signatures"    — code languages + CSS: walk for definition
 *                       node types, take the line up to the body.
 *   - "json-shape"    — JSON: top-level keys only (whole-tree walk
 *                       would be nested-key noise).
 *   - "html-skeleton" — HTML: elements that carry an `id`, plus the
 *                       major structural tags.
 */
type Extractor = "signatures" | "json-shape" | "html-skeleton"

interface LangSpec {
  grammar: string // wasm filename stem
  /** Node types that are "definitions" (signatures extractor) or the
   *  structural nodes of interest (json-shape / html-skeleton). */
  defNodes: Set<string>
  /** Extraction strategy. Defaults to "signatures" when omitted. */
  extractor?: Extractor
}

const LANG_SPECS: Record<string, LangSpec> = {
  javascript: {
    grammar: "tree-sitter-javascript",
    defNodes: new Set([
      "function_declaration",
      "generator_function_declaration",
      "class_declaration",
      "method_definition",
    ]),
  },
  typescript: {
    grammar: "tree-sitter-typescript",
    defNodes: new Set([
      "function_declaration",
      "generator_function_declaration",
      "class_declaration",
      "abstract_class_declaration",
      "method_definition",
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
    ]),
  },
  python: {
    grammar: "tree-sitter-python",
    defNodes: new Set(["function_definition", "class_definition"]),
  },
  go: {
    grammar: "tree-sitter-go",
    defNodes: new Set([
      "function_declaration",
      "method_declaration",
      "type_declaration",
    ]),
  },
  rust: {
    grammar: "tree-sitter-rust",
    defNodes: new Set([
      "function_item",
      "struct_item",
      "enum_item",
      "trait_item",
      "impl_item",
      "mod_item",
      "macro_definition",
      "type_item",
    ]),
  },
  java: {
    grammar: "tree-sitter-java",
    defNodes: new Set([
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "record_declaration",
      "annotation_type_declaration",
      "method_declaration",
      "constructor_declaration",
    ]),
  },
  c: {
    grammar: "tree-sitter-c",
    defNodes: new Set([
      "function_definition",
      "struct_specifier",
      "union_specifier",
      "enum_specifier",
      "type_definition",
    ]),
  },
  cpp: {
    grammar: "tree-sitter-cpp",
    defNodes: new Set([
      "function_definition",
      "class_specifier",
      "struct_specifier",
      "union_specifier",
      "enum_specifier",
      "namespace_definition",
      "template_declaration",
      "type_definition",
    ]),
  },
  css: {
    // A CSS "definition" is a selector rule or at-rule. The signatures
    // extractor's "text up to the first {" already yields exactly the
    // selector (`.nav > li`, `@media (max-width: 600px)`), so CSS uses
    // the same path as code — it just has different node types.
    grammar: "tree-sitter-css",
    defNodes: new Set(["rule_set", "media_statement", "keyframes_statement", "supports_statement"]),
  },
  json: {
    // JSON has no definitions; its "shape" is its top-level keys.
    // NOTE: the project-facts ingester already summarises recognised
    // JSON manifests by their keys — code-map JSON extends that to
    // *every* .json file in the tree, at the cost of some overlap.
    grammar: "tree-sitter-json",
    defNodes: new Set(["pair"]),
    extractor: "json-shape",
  },
  html: {
    // HTML has no definitions; its useful skeleton is the set of
    // elements bearing an `id` plus the major structural landmarks.
    grammar: "tree-sitter-html",
    defNodes: new Set(["element"]),
    extractor: "html-skeleton",
  },
  csharp: {
    // C# definition nodes: types (class/interface/struct/enum/record/delegate),
    // namespace containers, constructors, and methods. Properties are
    // intentionally excluded — they dominate DTO classes but add little
    // navigation value beyond the containing type.
    grammar: "tree-sitter-c_sharp",
    defNodes: new Set([
      "class_declaration",
      "interface_declaration",
      "struct_declaration",
      "enum_declaration",
      "record_declaration",
      "delegate_declaration",
      "namespace_declaration",
      "file_scoped_namespace_declaration",
      "constructor_declaration",
      "method_declaration",
      "operator_declaration",
      "event_declaration",
    ]),
  },
  php: {
    // PHP definition nodes: functions, methods, and all type-like constructs.
    // Namespaces included — they reveal the file's logical location within
    // the package tree and are one of the most useful facts for navigation.
    grammar: "tree-sitter-php",
    defNodes: new Set([
      "function_definition",
      "method_declaration",
      "class_declaration",
      "interface_declaration",
      "trait_declaration",
      "enum_declaration",
      "namespace_definition",
    ]),
  },
}

const EXT_TO_LANG: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  // C vs C++: .h is ambiguous; convention says plain .h → C, and the
  // C++-specific header suffixes → cpp. tree-sitter is error-tolerant,
  // so a C++ .h parsed as C still yields most of its signatures.
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".c++": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".hh": "cpp",
  ".h++": "cpp",
  ".css": "css",
  ".json": "json",
  ".jsonc": "json",
  ".html": "html",
  ".htm": "html",
  ".cs": "csharp",
  ".php": "php",
  ".phtml": "php",
}

/** Don't parse files larger than this — huge generated files are noise. */
const MAX_FILE_BYTES = 400 * 1024
/** Default cap on files scanned — adaptive config overrides per repo size. */
const DEFAULT_MAX_FILES = 4000
/** Cap signatures stored per file — keeps each memory compact. */
const MAX_SIGS_PER_FILE = 40

export interface CodeMapIngestResult {
  filesParsed: number
  filesSkippedUnsupported: number
  signaturesExtracted: number
  languagesSeen: string[]
  /** Set when the feature couldn't run at all (e.g. web-tree-sitter missing). */
  unavailableReason?: string
}

/**
 * Walk the tree, parse every supported source file, store one
 * `code-map` memory per file. Never throws — on any failure it
 * returns a result with `unavailableReason` set and the caller logs
 * it. `root` is the repo root; `packageDir` is where the vendored
 * grammar `.wasm` files live (resolved by the caller, or defaulted
 * relative to this module). `maxFiles` caps the walk — adaptive
 * config sizes it to the repo; it defaults to DEFAULT_MAX_FILES.
 */
/**
 * The tree-sitter engine — `web-tree-sitter` initialised plus a grammar
 * loader — is heavy to set up (wasm init, then a `.wasm` load per
 * language), so it is built once and cached for the life of the
 * process. Both the full prefill walk and the per-file live refresh
 * share it; that shared cache is what makes re-indexing one file after
 * an edit cheap rather than a cold start every time.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodeMapEngine = { ParserClass: any; getLanguage: (lang: string) => Promise<unknown | null> }
let enginePromise: Promise<CodeMapEngine | { unavailableReason: string }> | null = null

async function buildEngine(
  packageDir?: string
): Promise<CodeMapEngine | { unavailableReason: string }> {
  // web-tree-sitter is a heavy, optional dependency — only touch it
  // when code-map is actually being run.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ParserClass: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let LanguageClass: any
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("web-tree-sitter")
    // web-tree-sitter 0.25.x exposes `Parser` and `Language` as named
    // exports; the grammar loader moved from `Parser.Language.load` to a
    // standalone `Language.load`. Fall back through the older shapes so
    // a version bump in either direction degrades gracefully.
    ParserClass = mod.Parser ?? mod.default?.Parser ?? mod.default ?? mod
    LanguageClass = mod.Language ?? mod.default?.Language ?? ParserClass?.Language
    await ParserClass.init()
    if (typeof LanguageClass?.load !== "function") {
      throw new Error("web-tree-sitter: no Language.load entry point")
    }
  } catch (err) {
    return {
      unavailableReason:
        "web-tree-sitter unavailable: " +
        (err instanceof Error ? err.message : String(err)),
    }
  }
  const grammarsDir = resolveGrammarsDir(packageDir)
  const languageCache = new Map<string, unknown | null>()
  async function getLanguage(lang: string): Promise<unknown | null> {
    if (languageCache.has(lang)) return languageCache.get(lang) ?? null
    const spec = LANG_SPECS[lang]
    if (!spec) {
      languageCache.set(lang, null)
      return null
    }
    try {
      const wasmPath = join(grammarsDir, `${spec.grammar}.wasm`)
      const L = await LanguageClass.load(wasmPath)
      languageCache.set(lang, L)
      return L
    } catch {
      languageCache.set(lang, null) // grammar missing/incompatible — skip lang
      return null
    }
  }
  return { ParserClass, getLanguage }
}

/** Lazily build (once) and return the shared tree-sitter engine. */
async function getEngine(
  packageDir?: string
): Promise<CodeMapEngine | { unavailableReason: string }> {
  if (!enginePromise) enginePromise = buildEngine(packageDir)
  const engine = await enginePromise
  // Don't cache a transient failure — let a later call retry.
  if ("unavailableReason" in engine) enginePromise = null
  return engine
}

/**
 * Parse one source file and upsert its `code-map` memory. Shared by
 * the full prefill walk and the per-file live refresh, so both produce
 * byte-identical memories (same subject, same body shape) — which is
 * what lets `upsertBySubject` cleanly replace a stale entry. Never
 * throws; failures just leave counters untouched.
 */
async function parseAndStoreFile(
  repo: MemoryRepository,
  root: string,
  path: string,
  lang: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parser: any,
  getLanguage: (lang: string) => Promise<unknown | null>,
  result: CodeMapIngestResult
): Promise<void> {
  let src: string
  try {
    const s = await stat(path)
    if (!s.isFile() || s.size > MAX_FILE_BYTES) {
      result.filesSkippedUnsupported += 1
      return
    }
    src = await readFile(path, "utf-8")
  } catch {
    return
  }
  const L = await getLanguage(lang)
  if (!L) {
    result.filesSkippedUnsupported += 1
    return
  }
  const spec = LANG_SPECS[lang]
  let items: string[]
  try {
    parser.setLanguage(L)
    const tree = parser.parse(src)
    const extractor = spec.extractor ?? "signatures"
    if (extractor === "json-shape") {
      items = extractJsonShape(tree.rootNode, src)
    } else if (extractor === "html-skeleton") {
      items = extractHtmlSkeleton(tree.rootNode, src)
    } else {
      items = extractSignatures(tree.rootNode, src, spec.defNodes)
    }
  } catch {
    return
  }
  if (!result.languagesSeen.includes(lang)) result.languagesSeen.push(lang)
  result.filesParsed += 1
  result.signaturesExtracted += items.length

  // The noun in the summary line depends on what was extracted —
  // "definitions" for code, "selectors" for CSS, "keys" for JSON,
  // "elements" for HTML — so the agent reads it correctly.
  const noun =
    lang === "css"
      ? "selector"
      : lang === "json"
        ? "top-level key"
        : lang === "html"
          ? "landmark element"
          : "definition"
  const rel = path.startsWith(root) ? path.slice(root.length).replace(/^\/+/, "") : path
  const shown = items.slice(0, MAX_SIGS_PER_FILE)
  const body =
    shown.length === 0
      ? `${rel} (${lang}): no ${noun}s found.`
      : `${rel} (${lang}) — ${items.length} ${noun}${items.length === 1 ? "" : "s"}: ` +
        shown.join(" · ") +
        (items.length > shown.length ? ` … (+${items.length - shown.length} more)` : "")

  repo.upsertBySubject({
    category: CATEGORY,
    subject: rel,
    content: body,
    tags: ["code-map", lang, rel],
    source: "tree-sitter:code-map",
  })
}

/**
 * Re-index the code-map for a SINGLE file. This is what keeps the index
 * honest when the agent edits code mid-session: the edited file's stale
 * signature memory is replaced (via `upsertBySubject`) with one parsed
 * from the file as it is now. Reuses the cached engine, so after the
 * initial prefill a refresh is just a one-file parse. Never throws.
 *
 * Returns: "updated" (re-indexed, incl. a newly created file),
 * "unsupported" (extension has no grammar — nothing to do),
 * "unavailable" (tree-sitter could not load), or "error".
 */
export async function ingestCodeMapForFile(
  repo: MemoryRepository,
  root: string,
  absPath: string,
  packageDir?: string
): Promise<"updated" | "unsupported" | "unavailable" | "error"> {
  const lang = EXT_TO_LANG[extname(absPath).toLowerCase()]
  if (!lang) return "unsupported"
  let engine: CodeMapEngine | { unavailableReason: string }
  try {
    engine = await getEngine(packageDir)
  } catch {
    return "error"
  }
  if ("unavailableReason" in engine) return "unavailable"
  const result: CodeMapIngestResult = {
    filesParsed: 0,
    filesSkippedUnsupported: 0,
    signaturesExtracted: 0,
    languagesSeen: [],
  }
  try {
    const parser = new engine.ParserClass()
    await parseAndStoreFile(repo, root, absPath, lang, parser, engine.getLanguage, result)
  } catch {
    return "error"
  }
  return result.filesParsed > 0 ? "updated" : "unsupported"
}

export async function ingestCodeMap(
  repo: MemoryRepository,
  root: string,
  packageDir?: string,
  maxFiles: number = DEFAULT_MAX_FILES
): Promise<CodeMapIngestResult> {
  const result: CodeMapIngestResult = {
    filesParsed: 0,
    filesSkippedUnsupported: 0,
    signaturesExtracted: 0,
    languagesSeen: [],
  }

  const engine = await getEngine(packageDir)
  if ("unavailableReason" in engine) {
    result.unavailableReason = engine.unavailableReason
    return result
  }
  const eng = engine // narrowed — closures below need the non-union type

  const parser = new eng.ParserClass()

  // Phase 1: walk the tree and collect (path, language) candidates.
  // Only `readdir` is awaited here; parsing and file reads are
  // deferred to phase 2 so they can run in parallel. The walk
  // preserves the original DFS order (subdirectories descended in
  // listing order) so `maxFiles` selects the same candidate set as
  // the pre-refactor sequential implementation when the cap fires.
  interface Candidate { path: string; lang: string }
  const candidates: Candidate[] = []
  async function walk(dir: string): Promise<void> {
    if (candidates.length >= maxFiles) return
    let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (candidates.length >= maxFiles) return
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
        await walk(join(dir, e.name))
      } else if (e.isFile()) {
        const lang = EXT_TO_LANG[extname(e.name).toLowerCase()]
        if (!lang) continue
        candidates.push({ path: join(dir, e.name), lang })
      }
    }
  }
  await walk(root)

  // Phase 2: parse and store, with bounded parallelism on the file
  // reads. The tree-sitter parser is shared across tasks, which is
  // safe because the parser-using sequence (`parser.setLanguage(L);
  // parser.parse(src)`) is fully synchronous: no `await` appears
  // between `setLanguage` and `parse`, so the JS event loop cannot
  // interleave another task into the middle of one parse. Only the
  // `readFile` step inside `parseAndStoreFile` yields control,
  // which is exactly the point — that's what we parallelise.
  await mapConcurrent(candidates, CODE_MAP_CONCURRENCY, async ({ path, lang }) => {
    await parseAndStoreFile(repo, root, path, lang, parser, eng.getLanguage, result)
  })

  result.languagesSeen.sort()
  repo.setIngestedAt(CATEGORY, Date.now())
  return result
}

/* ─── signature extraction ──────────────────────────────────────────── */

/**
 * Depth-first walk collecting one signature line per definition node.
 * A "signature" is the node's source text up to (but not including)
 * its body — i.e. up to the first `{` or the first newline, whichever
 * comes first — trimmed and length-capped. That captures
 * `func (s *Server) Start() error`, `def parse(self, text):`,
 * `interface Config`, etc. without any of the body. Pure function of
 * (tree, source) so it is unit-testable without a repo.
 */
export function extractSignatures(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rootNode: any,
  src: string,
  defNodes: Set<string>
): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function visit(node: any): void {
    if (defNodes.has(node.type)) {
      const sig = signatureOf(node, src)
      if (sig && !seen.has(sig)) {
        seen.add(sig)
        out.push(sig)
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i))
    }
  }
  visit(rootNode)
  return out
}

// A line that is purely a C# attribute (`[Obsolete]`), Rust attribute
// (`#[derive(...)]`), or Java/Python annotation/decorator (`@Override`,
// `@staticmethod`). The whole-line anchors (`^…$`) matter: they keep an
// inline form like `[Foo] public void Bar()` from being mistaken for a
// metadata-only line and skipped.
const ATTRIBUTE_LINE_RE = /^(#?\[.*\]|@[\w.]+(\s*\([^)]*\))?)$/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function signatureOf(node: any, src: string): string | null {
  const full = src.slice(node.startIndex, node.endIndex)
  // A definition node often spans leading attribute/annotation lines
  // before the actual declaration (pervasive in C#, common in Java,
  // always-separate-line in Python). Drop those leading lines so the
  // signature is the declaration itself, not `[DebuggerStepThrough]`.
  const lines = full.split("\n")
  let start = 0
  while (start < lines.length - 1) {
    const t = lines[start].trim()
    if (t.length === 0 || ATTRIBUTE_LINE_RE.test(t)) start += 1
    else break
  }
  const rest = lines.slice(start).join("\n")
  // Cut at the body: first `{` or first newline, whichever is first.
  let cut = rest.length
  const brace = rest.indexOf("{")
  const nl = rest.indexOf("\n")
  if (brace >= 0) cut = Math.min(cut, brace)
  if (nl >= 0) cut = Math.min(cut, nl)
  let sig = rest.slice(0, cut).trim()
  // Python defs end with `:` — keep it; collapse internal whitespace.
  sig = sig.replace(/\s+/g, " ")
  if (sig.length > 140) sig = sig.slice(0, 137) + "…"
  return sig.length > 0 ? sig : null
}

/* ─── structural extractors for non-code formats ────────────────────── */

/**
 * JSON "shape": the TOP-LEVEL keys only (or a marker if the root is an
 * array / scalar). A whole-tree walk would emit every nested key,
 * which is noise — so this descends exactly one object level. Pure
 * function of (tree, source); unit-testable without a repo.
 */
export function extractJsonShape(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rootNode: any,
  src: string
): string[] {
  // Find the root value node: tree-sitter-json wraps it in `document`.
  let root = rootNode
  if (root && root.type === "document" && root.childCount > 0) {
    // first non-comment child
    for (let i = 0; i < root.childCount; i++) {
      const c = root.child(i)
      if (c && c.type !== "comment") {
        root = c
        break
      }
    }
  }
  if (!root) return []
  if (root.type === "array") return ["[root is a JSON array]"]
  if (root.type !== "object") return [`[root is a JSON ${root.type}]`]

  const keys: string[] = []
  for (let i = 0; i < root.childCount; i++) {
    const pair = root.child(i)
    if (!pair || pair.type !== "pair") continue
    // a `pair` is `key : value`; the key is the first `string` child.
    let keyText: string | null = null
    for (let j = 0; j < pair.childCount; j++) {
      const k = pair.child(j)
      if (k && k.type === "string") {
        keyText = src.slice(k.startIndex, k.endIndex).replace(/^["']|["']$/g, "")
        break
      }
    }
    if (keyText) keys.push(keyText)
  }
  return keys
}

/**
 * HTML "skeleton": elements that carry an `id` (rendered `tag#id`) and
 * the major structural landmark tags (`header`, `main`, `nav`, `form`,
 * `section`, …). A flat list of every element would be noise; this is
 * the part of the document an agent actually navigates by. Pure
 * function of (tree, source).
 */
const HTML_LANDMARK_TAGS = new Set([
  "header", "footer", "main", "nav", "aside", "section", "article",
  "form", "table", "dialog", "template",
])

export function extractHtmlSkeleton(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rootNode: any,
  src: string
): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function visit(node: any): void {
    if (node.type === "element" || node.type === "script_element" || node.type === "style_element") {
      // The start tag holds the tag name and attributes.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let startTag: any = null
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i)
        if (c && (c.type === "start_tag" || c.type === "self_closing_tag")) {
          startTag = c
          break
        }
      }
      if (startTag) {
        let tagName = ""
        let idValue: string | null = null
        for (let i = 0; i < startTag.childCount; i++) {
          const c = startTag.child(i)
          if (!c) continue
          if (c.type === "tag_name") {
            tagName = src.slice(c.startIndex, c.endIndex)
          } else if (c.type === "attribute") {
            // attribute = attribute_name [= (quoted_)attribute_value]
            let attrName = ""
            let attrVal = ""
            for (let j = 0; j < c.childCount; j++) {
              const a = c.child(j)
              if (!a) continue
              if (a.type === "attribute_name") {
                attrName = src.slice(a.startIndex, a.endIndex)
              } else if (a.type === "quoted_attribute_value" || a.type === "attribute_value") {
                attrVal = src.slice(a.startIndex, a.endIndex).replace(/^["']|["']$/g, "")
              }
            }
            if (attrName.toLowerCase() === "id" && attrVal) idValue = attrVal
          }
        }
        if (tagName) {
          let entry: string | null = null
          if (idValue) entry = `${tagName}#${idValue}`
          else if (HTML_LANDMARK_TAGS.has(tagName.toLowerCase())) entry = `<${tagName}>`
          if (entry && !seen.has(entry)) {
            seen.add(entry)
            out.push(entry)
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i))
  }
  visit(rootNode)
  return out
}

/* ─── grammar path resolution ───────────────────────────────────────── */

/**
 * Locate the vendored `grammars/` directory. Callers can pass the
 * package directory explicitly; otherwise we resolve it relative to
 * this compiled module — `dist/ingest/code-map.js` → `../../grammars`.
 */
function resolveGrammarsDir(packageDir?: string): string {
  if (packageDir) return join(packageDir, "grammars")
  try {
    const here = fileURLToPath(import.meta.url) // .../dist/ingest/code-map.js
    return join(here, "..", "..", "..", "grammars")
  } catch {
    return join(process.cwd(), "grammars")
  }
}
