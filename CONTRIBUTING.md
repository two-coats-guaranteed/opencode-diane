# Contributing

Thanks for your interest. The plugin is small, opinionated, and aims
to stay so — but bug reports, PRs, and design feedback are welcome.

## Quick start

```bash
git clone <this repo>
cd opencode-diane
bun install
bun run typecheck && bun run lint && bun run test
```

If everything is green you have a working dev setup.

## Before opening a PR

```bash
bun run typecheck       # tsc --noEmit
bun run lint            # eslint
bun run test            # all 16 suites + 460+ assertions
bun run smoke           # exercises the built dist/
bun run coverage:check  # must stay above the floor
bun run check:size      # publish-tarball size ceiling
```

CI runs the same set on every push and PR; passing locally first
saves a round-trip. The full set finishes in well under a minute on a
laptop.

## Conventions

- **Tests over assertions in comments.** A new behaviour earns a new
  test. The store tests in `tests/store.test.ts` are the model: small,
  targeted, and named for the contract they pin.
- **Defensive at the boundary.** Anything that crosses a process or
  filesystem boundary catches and degrades gracefully — the plugin
  never crashes OpenCode's startup, even if its own DB is unreadable.
  See the migration-failure handling in `src/store/sqlite-store.ts`
  for the pattern.
- **Single source of truth.** Version lives in `package.json` and
  propagates everywhere via `src/index.ts`'s `PLUGIN_VERSION`. Don't
  duplicate.
- **No new top-level dependencies without a reason.** This plugin
  intentionally ships zero runtime deps beyond `@opencode-ai/plugin`
  and `web-tree-sitter` (the latter only if `enableCodeMap` is on).

## Reporting bugs

Use [GitHub Issues](https://github.com/two-coats-guaranteed/opencode-diane/issues).
Helpful: the snippet from the JSONL log under
`$OPENCODE_DIANE_LOG_DIR` (default `os.tmpdir()/opencode-diane/`)
that surrounds the failure — the structured events make
reproduction much easier.

## Releasing (maintainers)

```bash
bun run test && bun run smoke && bun run check:size
bun run clean && bun run build
npm version <patch|minor|major>          # bumps package.json + git tag
npm publish --access public
```

The version flows from `package.json` into the build automatically;
nothing else to update. See WIKI.md → "Development & packaging".
