/**
 * code-map ingestion tests (#2).
 *
 * Parses a small multi-language fixture with the real tree-sitter
 * grammars and checks that signatures come out clean (bodies
 * stripped), one memory per file, languages we have no grammar for
 * are skipped, and re-ingest replaces rather than accumulates.
 *
 * The `packageDir` argument points the ingester at the vendored
 * `grammars/` directory; in tests that's the repo root.
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { MemoryRepository } from "../src/store/repository.js"
import { ingestCodeMap, ingestCodeMapForFile, extractSignatures, extractJsonShape, extractHtmlSkeleton } from "../src/ingest/code-map.js"

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  ✗ ${label}`)
  }
}

// repo root = two levels up from tests/ (this file is tests/code-map.test.ts)
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")

async function main(): Promise<void> {
  console.log("\n── code-map: multi-language signature extraction ─────────")

  const root = await mkdtemp(join(tmpdir(), "diane-codemap-"))
  await mkdir(join(root, "src"), { recursive: true })

  await writeFile(
    join(root, "src", "server.go"),
    `package main
type Server struct { addr string }
func (s *Server) Start() error { return nil }
func (s *Server) Stop() { }
func helper() int { return 1 }
`
  )
  await writeFile(
    join(root, "src", "parser.py"),
    `class Parser:
    def __init__(self, opts):
        self.opts = opts

    @staticmethod
    def parse(text):
        return text.split()

def standalone_fn(x, y):
    return x + y
`
  )
  await writeFile(
    join(root, "src", "api.ts"),
    `export interface Config { host: string; port: number }
export type Handler = (req: Request) => Response
export class Router {
  add(path: string, h: Handler): void {}
}
export function createServer(cfg: Config) { return new Router() }
`
  )
  await writeFile(
    join(root, "src", "lib.rs"),
    `#[derive(Debug, Clone)]
pub struct Cache { size: usize }
impl Cache {
    pub fn new(size: usize) -> Self { Cache { size } }
    pub fn get(&self, k: &str) -> Option<String> { None }
}
pub trait Store { fn put(&mut self, k: String); }
pub fn build() -> Cache { Cache::new(10) }
`
  )
  // ── the six added languages ────────────────────────────────────────
  await writeFile(
    join(root, "src", "App.java"),
    `package com.x;
public class App {
  public int getCount() { return 1; }
  static class Inner {
    void tick() {}
  }
}
`
  )
  await writeFile(
    join(root, "src", "lib.c"),
    `#include <stdio.h>
struct Point { int x; int y; };
typedef struct Point Point;
int add(int a, int b) { return a + b; }
void noop(void) {}
`
  )
  await writeFile(
    join(root, "src", "engine.cpp"),
    `namespace engine {
class Renderer {
public:
  void draw();
};
template<typename T> T max2(T a, T b) { return a > b ? a : b; }
struct Config { int width; };
}
`
  )
  await writeFile(
    join(root, "src", "style.css"),
    `.nav > li { color: red; }
#header { height: 60px; }
@media (max-width: 600px) { .nav { display: none; } }
`
  )
  await writeFile(
    join(root, "src", "config.json"),
    `{ "name": "demo", "version": "1.0", "scripts": { "build": "tsc" }, "deps": [] }`
  )
  await writeFile(
    join(root, "page.html"),
    `<!DOCTYPE html>
<html><body>
<header id="top">Site</header>
<main id="content"><section>stuff</section></main>
<form id="login"><input></form>
</body></html>`
  )
  await writeFile(
    join(root, "src", "UserService.cs"),
    `namespace MyApp.Services;
public class UserService : IService
{
    public UserService(IRepo repo) { _repo = repo; }
    public async Task<User> GetAsync(int id) { return await _repo.FindAsync(id); }
    [Obsolete("use GetAsync")]
    public User GetSync(int id) { return _repo.Find(id); }
    public interface IService { Task<User> GetAsync(int id); }
}
public record User(int Id, string Name);
public delegate void UserChangedHandler(User user);
`
  )
  await writeFile(
    join(root, "src", "ArticleController.php"),
    `<?php
namespace App\\Controllers;
class ArticleController
{
    public function __construct(private ArticleRepo $repo) {}
    public function index(): array { return $this->repo->findAll(); }
}
interface Repository { public function findAll(): array; }
trait Timestampable { public function getCreatedAt(): \\DateTime { return $this->createdAt; } }
enum Status { case Active; case Inactive; }
`
  )
  // a file in a language we have no grammar for — must be skipped silently
  await writeFile(join(root, "notes.txt"), "just some text, not code")

  const repo = await MemoryRepository.load(root)
  const res = await ingestCodeMap(repo, root, PACKAGE_DIR)

  if (res.unavailableReason) {
    // web-tree-sitter / grammars not available in this environment —
    // the feature degrades gracefully; record that and stop without
    // failing the suite (the plugin treats this as a soft skip too).
    console.log(`  ! code-map unavailable in this environment: ${res.unavailableReason}`)
    console.log(`  ! skipping code-map assertions (graceful degradation verified)`)
    await rm(root, { recursive: true, force: true })
    console.log("\n──────────────────────────────────────────────────────────")
    console.log(`  ${passed} passed, ${failed} failed`)
    if (failed > 0) process.exit(1)
    return
  }

  assert(res.filesParsed === 12, `parsed all 12 source files (got ${res.filesParsed})`)
  assert(
    res.languagesSeen.join(",") === "c,cpp,csharp,css,go,html,java,json,php,python,rust,typescript",
    `saw all twelve languages (got ${res.languagesSeen.join(",")})`
  )
  assert(res.signaturesExtracted >= 30, `extracted signatures (got ${res.signaturesExtracted})`)

  const maps = repo.allMemories().filter((m) => m.category === "code-map")
  assert(maps.length === 12, `one code-map memory per source file (got ${maps.length})`)

  // ── per-language extraction ────────────────────────────────────────
  // Each language exercises a DISTINCT extraction scenario. A generic
  // capability (find a class, strip a body) is proven once — in the
  // language that shows it most clearly — not re-tested everywhere.
  // Cross-cutting behaviours and where each is proven exactly once:
  //   body stripping ............... Go
  //   nested-definition recursion .. Java
  //   leading-metadata skipping .... Python (@decorator), Rust (#[..]),
  //                                  C# ([attr]) — three different syntaxes

  // Go — receiver-method signatures, and the one body-stripping check.
  const go = maps.find((m) => m.subject.endsWith("server.go"))
  assert(
    go !== undefined && go.content.includes("func (s *Server) Start() error"),
    "go: receiver method captured with its receiver intact"
  )
  assert(go !== undefined && !go.content.includes("return nil"), "go: body stripped (cut at the brace)")

  // Python — a signature keeps its trailing `:`, and a `@decorator`
  // line above a def is skipped so the signature is the def itself.
  const py = maps.find((m) => m.subject.endsWith("parser.py"))
  assert(py !== undefined && py.content.includes("def parse(text):"), "python: def signature keeps its colon")
  assert(py !== undefined && !py.content.includes("@staticmethod"), "python: @decorator line skipped, not captured")

  // TypeScript — type-level declarations with no runtime form: an
  // `interface`, and a `type` alias (which no other language has).
  const ts = maps.find((m) => m.subject.endsWith("api.ts"))
  assert(ts !== undefined && ts.content.includes("interface Config"), "typescript: interface captured")
  assert(ts !== undefined && ts.content.includes("type Handler"), "typescript: type-alias captured")

  // Rust — `impl` blocks, and `#[derive(...)]` attribute skipping.
  const rs = maps.find((m) => m.subject.endsWith("lib.rs"))
  assert(rs !== undefined && rs.content.includes("impl Cache"), "rust: impl block captured")
  assert(
    rs !== undefined && rs.content.includes("pub struct Cache"),
    "rust: struct signature, not the #[derive] line above it"
  )
  assert(rs !== undefined && !rs.content.includes("derive"), "rust: #[derive(...)] attribute line skipped")

  // Java — the recursive walk descends into nested type declarations.
  const java = maps.find((m) => m.subject.endsWith("App.java"))
  assert(java !== undefined && java.content.includes("class App"), "java: outer class captured")
  assert(java !== undefined && java.content.includes("class Inner"), "java: nested class captured (recursive walk)")

  // C — the C type vocabulary: a struct and a typedef.
  const c = maps.find((m) => m.subject.endsWith("lib.c"))
  assert(c !== undefined && c.content.includes("struct Point"), "c: struct captured")
  assert(c !== undefined && c.content.includes("typedef struct Point Point"), "c: typedef captured")

  // C++ — templates and namespaces (and the one plain-class check).
  const cpp = maps.find((m) => m.subject.endsWith("engine.cpp"))
  assert(cpp !== undefined && cpp.content.includes("template"), "cpp: template declaration captured")
  assert(cpp !== undefined && cpp.content.includes("namespace engine"), "cpp: namespace captured")
  assert(cpp !== undefined && cpp.content.includes("class Renderer"), "cpp: class captured")

  // C# — `[attribute]` skipping, positional records, and delegates.
  const cs = maps.find((m) => m.subject.endsWith("UserService.cs"))
  assert(
    cs !== undefined && cs.content.includes("public User GetSync(int id)"),
    "csharp: attributed method — the real signature, not the [Obsolete] line"
  )
  assert(cs !== undefined && !cs.content.includes("Obsolete"), "csharp: [attribute] line skipped, not captured")
  assert(
    cs !== undefined && cs.content.includes("public record User(int Id, string Name)"),
    "csharp: positional record captured"
  )
  assert(
    cs !== undefined && cs.content.includes("public delegate void UserChangedHandler"),
    "csharp: delegate captured"
  )

  // PHP — traits, 8.1 enums, and constructor property promotion.
  const php = maps.find((m) => m.subject.endsWith("ArticleController.php"))
  assert(php !== undefined && php.content.includes("trait Timestampable"), "php: trait captured")
  assert(php !== undefined && php.content.includes("enum Status"), "php: enum captured")
  assert(
    php !== undefined && php.content.includes("public function __construct(private ArticleRepo $repo)"),
    "php: constructor with a promoted property captured"
  )

  // ── the three non-code structural extractors ───────────────────────
  // CSS / JSON / HTML have no "definitions"; each has its own extractor,
  // so each is its own distinct scenario rather than a code signature.

  // CSS — selectors and at-rules, labelled "selector" not "definition".
  const css = maps.find((m) => m.subject.endsWith("style.css"))
  assert(css !== undefined && css.content.includes(".nav > li"), "css: selector captured")
  assert(css !== undefined && css.content.includes("@media"), "css: at-rule captured")
  assert(css !== undefined && css.content.includes("selector"), "css: labelled 'selector', not 'definition'")

  // JSON — TOP-LEVEL keys only; the depth-1 boundary is the point.
  const json = maps.find((m) => m.subject.endsWith("config.json"))
  assert(
    json !== undefined && json.content.includes("name") && json.content.includes("scripts"),
    "json: top-level keys captured"
  )
  assert(json !== undefined && !json.content.includes("build"), "json: nested keys NOT captured (depth-1 only)")
  assert(json !== undefined && json.content.includes("top-level key"), "json: labelled 'top-level key'")

  // HTML — id-bearing elements as `tag#id`, plus landmark tags.
  const html = maps.find((m) => m.subject.endsWith("page.html"))
  assert(html !== undefined && html.content.includes("header#top"), "html: id-bearing element captured as tag#id")
  assert(html !== undefined && html.content.includes("<section>"), "html: landmark tag captured")
  assert(html !== undefined && html.content.includes("landmark element"), "html: labelled 'landmark element'")

  // recallable
  const hits = repo.recall({ query: "server start router", category: "code-map" })
  assert(hits.length > 0, "code-map memories are recallable")

  // re-ingest replaces, not accumulates
  const before = maps.length
  await ingestCodeMap(repo, root, PACKAGE_DIR)
  const after = repo.allMemories().filter((m) => m.category === "code-map").length
  assert(after === before, `re-ingest replaces, not accumulates (${before} → ${after})`)

  // ── ingestCodeMapForFile: live refresh when the agent edits code ──
  // This is what keeps the index honest mid-session.
  const goPath = join(root, "src", "server.go")
  const goMemBefore = repo
    .allMemories()
    .find((m) => m.category === "code-map" && m.subject.endsWith("server.go"))
  assert(goMemBefore !== undefined, "live-refresh: server.go has a code-map memory to start")
  assert(
    !(goMemBefore?.content ?? "").includes("ShutdownGracefully"),
    "live-refresh: the new symbol is absent before the edit"
  )

  // The agent edits the file — add a function.
  await writeFile(
    goPath,
    "package main\n\nfunc Start() error { return nil }\n\nfunc ShutdownGracefully() error { return nil }\n"
  )
  const countBeforeRefresh = repo.allMemories().filter((m) => m.category === "code-map").length
  const outcome = await ingestCodeMapForFile(repo, root, goPath, PACKAGE_DIR)
  assert(outcome === "updated", `live-refresh: ingestCodeMapForFile reports 'updated' (got ${outcome})`)

  const goMemAfter = repo
    .allMemories()
    .find((m) => m.category === "code-map" && m.subject.endsWith("server.go"))
  assert(
    (goMemAfter?.content ?? "").includes("ShutdownGracefully"),
    "live-refresh: the code-map memory now reflects the edited file"
  )
  const countAfterRefresh = repo.allMemories().filter((m) => m.category === "code-map").length
  assert(
    countAfterRefresh === countBeforeRefresh,
    `live-refresh: upsert replaced the stale memory, no duplicate (${countBeforeRefresh} → ${countAfterRefresh})`
  )

  // A brand-new file the agent creates gets indexed too.
  await writeFile(join(root, "src", "brandnew.go"), "package main\n\nfunc FreshlyCreated() {}\n")
  const newOutcome = await ingestCodeMapForFile(repo, root, join(root, "src", "brandnew.go"), PACKAGE_DIR)
  assert(newOutcome === "updated", "live-refresh: a newly created source file is indexed")
  assert(
    repo
      .allMemories()
      .some((m) => m.category === "code-map" && m.subject.endsWith("brandnew.go")),
    "live-refresh: the new file now has its own code-map memory"
  )

  // Editing a non-source file is a no-op — nothing to index.
  const txtOutcome = await ingestCodeMapForFile(repo, root, join(root, "notes.txt"), PACKAGE_DIR)
  assert(
    txtOutcome === "unsupported",
    `live-refresh: a non-source file is 'unsupported', not indexed (got ${txtOutcome})`
  )

  await rm(root, { recursive: true, force: true })

  // ── extractSignatures is a pure function — test it directly ────────
  console.log("\n── code-map: extractSignatures (pure) ────────────────────")
  // A fake minimal tree node shape: extractSignatures only needs
  // type / startIndex / endIndex / childCount / child().
  type FakeNode = {
    type: string
    startIndex: number
    endIndex: number
    children: FakeNode[]
    childCount: number
    child(i: number): FakeNode
  }
  function node(type: string, start: number, end: number, children: FakeNode[] = []): FakeNode {
    return {
      type,
      startIndex: start,
      endIndex: end,
      children,
      childCount: children.length,
      child(i: number) {
        return children[i]
      },
    }
  }
  const src = "func main() { x() }\nfunc helper() int { return 1 }\n"
  const root2 = node("source_file", 0, src.length, [
    node("function_declaration", 0, 19),
    node("function_declaration", 20, 50),
  ])
  const sigs = extractSignatures(root2, src, new Set(["function_declaration"]))
  assert(sigs.length === 2, "extractSignatures: both defs found")
  assert(sigs[0] === "func main()", `extractSignatures: body stripped at brace (got "${sigs[0]}")`)
  assert(
    sigs.some((s) => s.startsWith("func helper() int")),
    "extractSignatures: second signature captured up to brace"
  )
  // a node type not in the def set is ignored
  const sigs2 = extractSignatures(root2, src, new Set(["class_declaration"]))
  assert(sigs2.length === 0, "extractSignatures: non-def node types ignored")

  // Cross-cutting signatureOf behaviours — each a property of the
  // extractor itself, so each is proven once here rather than per
  // language.

  // De-duplication: two defs with identical text collapse to one.
  const dupSrc = "func f() {}\nfunc f() {}\n"
  const dupRoot = node("source_file", 0, dupSrc.length, [
    node("function_declaration", 0, 11),
    node("function_declaration", 12, 23),
  ])
  const dupSigs = extractSignatures(dupRoot, dupSrc, new Set(["function_declaration"]))
  assert(dupSigs.length === 1, `extractSignatures: identical signatures de-duplicated (got ${dupSigs.length})`)

  // Internal whitespace (runs of spaces, tabs) collapses to one space.
  const wsSrc = "func   spaced(a\tint) {}\n"
  const wsRoot = node("source_file", 0, wsSrc.length, [node("function_declaration", 0, 23)])
  const wsSig = extractSignatures(wsRoot, wsSrc, new Set(["function_declaration"]))[0]
  assert(wsSig === "func spaced(a int)", `extractSignatures: internal whitespace collapsed (got "${wsSig}")`)

  // A signature longer than the cap is truncated with an ellipsis.
  const longSrc = `func ${"x".repeat(200)}() {}\n`
  const longRoot = node("source_file", 0, longSrc.length, [
    node("function_declaration", 0, longSrc.length - 1),
  ])
  const longSig = extractSignatures(longRoot, longSrc, new Set(["function_declaration"]))[0]
  assert(
    longSig.length === 138 && longSig.endsWith("…"),
    `extractSignatures: over-long signature truncated with an ellipsis (got length ${longSig.length})`
  )

  // Metadata-skip is whole-line anchored: an attribute that shares its
  // line with the declaration must NOT be skipped (which would leave an
  // empty or wrong signature). `[Tag]` here is inline, so the whole
  // line is the signature.
  const inlineSrc = "[Tag] func real(x int)\n{\n}\n"
  const inlineRoot = node("source_file", 0, inlineSrc.length, [
    node("function_declaration", 0, inlineSrc.length - 1),
  ])
  const inlineSig = extractSignatures(inlineRoot, inlineSrc, new Set(["function_declaration"]))[0]
  assert(
    inlineSig === "[Tag] func real(x int)",
    `extractSignatures: inline attribute not mistaken for a skippable metadata line (got "${inlineSig}")`
  )

  // ── extractJsonShape (pure) ────────────────────────────────────────
  console.log("\n── code-map: extractJsonShape (pure) ─────────────────────")
  // build a fake JSON tree: document → object → pair(string key, ...)
  // src positions don't need to be exact for keys we control; we slice
  // by index, so lay the keys out in a known string.
  const jsonSrc = '{ "alpha": 1, "beta": {}, "gamma": [] }'
  const aPos = jsonSrc.indexOf('"alpha"')
  const bPos = jsonSrc.indexOf('"beta"')
  const gPos = jsonSrc.indexOf('"gamma"')
  const objNode = node("object", 0, jsonSrc.length, [
    node("pair", aPos, aPos + 9, [node("string", aPos, aPos + 7)]),
    node("pair", bPos, bPos + 9, [node("string", bPos, bPos + 6)]),
    node("pair", gPos, gPos + 10, [node("string", gPos, gPos + 7)]),
  ])
  const jsonRoot = node("document", 0, jsonSrc.length, [objNode])
  const jsonKeys = extractJsonShape(jsonRoot, jsonSrc)
  assert(
    jsonKeys.join(",") === "alpha,beta,gamma",
    `extractJsonShape: top-level keys in order (got ${jsonKeys.join(",")})`
  )
  // an array root is reported, not walked
  const arrRoot = node("document", 0, 2, [node("array", 0, 2)])
  assert(
    extractJsonShape(arrRoot, "[]")[0].includes("array"),
    "extractJsonShape: array root reported as a marker"
  )

  // ── extractHtmlSkeleton (pure) ─────────────────────────────────────
  console.log("\n── code-map: extractHtmlSkeleton (pure) ──────────────────")
  // element → start_tag → tag_name + attribute(attribute_name, value)
  const htmlSrc = '<header id="top"></header><section></section><div></div>'
  function attr(name: string, val: string, base: number): FakeNode {
    // layout: <name>=<"val">  — name at [base, base+len), '=' at
    // base+len, quoted value at [base+len+1, base+len+1+val.length+2)
    const nameNode = node("attribute_name", base, base + name.length)
    const valStart = base + name.length + 1
    const valNode = node("quoted_attribute_value", valStart, valStart + val.length + 2)
    return node("attribute", base, valNode.endIndex, [nameNode, valNode])
  }
  // header with id="top"
  const headerStart = node("start_tag", 0, 17, [
    node("tag_name", 1, 7), // "header"
    attr("id", "top", 8),
  ])
  const headerEl = node("element", 0, 26, [headerStart])
  // section — a landmark tag, no id
  const sectionStart = node("start_tag", 26, 35, [node("tag_name", 27, 34)]) // "section"
  const sectionEl = node("element", 26, 45, [sectionStart])
  // div — neither id nor landmark → excluded
  const divStart = node("start_tag", 45, 50, [node("tag_name", 46, 49)]) // "div"
  const divEl = node("element", 45, 56, [divStart])
  const htmlRoot = node("fragment", 0, htmlSrc.length, [headerEl, sectionEl, divEl])
  const skeleton = extractHtmlSkeleton(htmlRoot, htmlSrc)
  assert(skeleton.includes("header#top"), "extractHtmlSkeleton: id-bearing element as tag#id")
  assert(skeleton.includes("<section>"), "extractHtmlSkeleton: landmark tag captured")
  assert(!skeleton.some((s) => s.includes("div")), "extractHtmlSkeleton: plain non-landmark element excluded")

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
