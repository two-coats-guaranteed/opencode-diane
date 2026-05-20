# Changelog

All notable changes to this project are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
on the understanding that the public surface for SemVer purposes is the
tool list (`memory_*`) and the documented `UserConfig` options.

## [0.0.3] — Unreleased

First public preview release.

### Added
- Nine `memory_*` tools (`recall`, `remember`, `status`, `code_map`,
  `outline`, `ingest_sessions`, `mine_skills`, `skill`,
  `ingest_code_health`).
- BM25 lexical recall with one-hop co-change boosting; opt-in
  Personalized PageRank for multi-hop recall (`personalizedPageRank`).
- Tree-sitter code-map across 10 languages plus JSON/CSS/HTML
  (`enableCodeMap`).
- Cross-lingual semantic search via a small multilingual e5 model
  (`enableSemanticSearch`, optional `@huggingface/transformers`).
- Skill mining: cluster-derived `SKILL.md` files from past sessions.
- Structured JSONL logs under `$OPENCODE_DIANE_LOG_DIR` (or
  `os.tmpdir()/opencode-diane/`) with `analyze-logs.py` reader.
- Plugin version flows from `package.json#version` to the
  `plugin.active` event and `memory_status` output — single source of
  truth, no second place to update.
- Defensive legacy-JSON → SQLite migration that never crashes plugin
  startup even when another plugin is contending for the database.
- `QUICKSTART.md` for the impatient; `WIKI.md` for the curious.

### Reliability
- `MemoryRepository.load` accepts an `onMigrationError` callback so a
  failed legacy migration logs cleanly and the plugin continues with
  an empty database rather than failing to start. Regression test in
  `tests/store.test.ts`.
- Auto-detects coexisting plugins (`oh-my-opencode`/`oh-my-openagent`/
  `oh-my-opencode-slim`, and any `caveman` packaging) by reading the
  `plugin` array in `opencode.json`. When a peer is present and the
  user hasn't overridden the relevant option, disables the
  tool-output nudge hook (oh-my-opencode also rewrites tool output)
  and prefixes mined-skill subdirectories with `diane-` (so skills
  in the shared `.opencode/skills/` directory don't collide with the
  peer's slugs). Standalone behaviour is unchanged. Tests in
  `tests/peer-compat.test.ts`.

### Coverage
- 460+ assertions across 16 suites; 91%+ line coverage; size ceiling
  enforced in CI.
