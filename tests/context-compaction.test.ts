/**
 * context-compaction.test.ts — drift detector + compactor + manager.
 *
 * Script-style (matches the repo's other test files): run with
 *   bun run tests/context-compaction.test.ts
 */

import {
  LexicalDriftDetector,
  EmbeddingDriftDetector,
  tokenizeTerms,
  cosineVec,
  type DriftConfig,
} from "../src/context/drift.js"
import {
  maskObservations,
  restoreObservations,
  estimatedTokensSaved,
  type MsgLike,
} from "../src/context/compactor.js"
import {
  CompactionManager,
  DEFAULT_COMPACTION_CONFIG,
} from "../src/context/compaction-manager.js"

let passed = 0
let failed = 0
const failures: string[] = []
function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`) }
}

// ── fixtures ─────────────────────────────────────────────────────────────

function toolMsg(id: string, tool: string, output: string): MsgLike {
  return {
    info: { id, role: "assistant", sessionID: "s1" },
    parts: [
      { type: "tool", tool, state: { status: "completed", output } } as never,
    ],
  }
}
function userMsg(id: string, text: string): MsgLike {
  return {
    info: { id, role: "user", sessionID: "s1" },
    parts: [{ type: "text", text } as never],
  }
}
function textMsg(id: string, text: string): MsgLike {
  return {
    info: { id, role: "assistant", sessionID: "s1" },
    parts: [{ type: "text", text } as never], // reasoning/text — must survive
  }
}

const bigOutput = (label: string) => `${label}: ` + "x".repeat(600)

async function main(): Promise<void> {
  const cfg: DriftConfig = { driftThreshold: 0.2, minSegmentTurns: 2 }

  // ── tokenizer ───────────────────────────────────────────────────────
  console.log("\n── tokenizer: camelCase / snake_case split ──────────────")
  {
    const t = tokenizeTerms("resolveRedirects rebuild_auth FooBar x")
    assert(t.includes("resolve") && t.includes("redirects"), "splits camelCase")
    assert(t.includes("rebuild") && t.includes("auth"), "splits snake_case")
    assert(!t.includes("x"), "drops <3-char tokens")
  }

  // ── lexical detector ──────────────────────────────────────────────────
  console.log("\n── lexical drift detector ───────────────────────────────")
  {
    const d = new LexicalDriftDetector(cfg)
    const v1 = d.observe("fix the authentication redirect handling in sessions")
    assert(!v1.shifted && Number.isNaN(v1.similarity), "first turn: no shift, NaN sim")

    const v2 = d.observe("the auth redirect session cookie also needs the fix")
    assert(!v2.shifted, "on-topic second turn: no shift")
    assert(v2.similarity > 0.2, "on-topic similarity above threshold")

    // hysteresis: even a divergent turn won't fire before minSegmentTurns…
    const dd = new LexicalDriftDetector({ driftThreshold: 0.2, minSegmentTurns: 3 })
    dd.observe("alpha beta gamma delta")
    const e2 = dd.observe("epsilon zeta eta theta")  // turn 2 < min 3
    assert(!e2.shifted, "no shift before minSegmentTurns even if divergent")

    // …then a clearly different goal does fire
    const d3 = new LexicalDriftDetector(cfg)
    d3.observe("optimize the database query planner indexes")
    d3.observe("the query planner cost model needs tuning")
    const shift = d3.observe("update the React dropdown component CSS styling")
    assert(shift.shifted, "divergent goal after min turns: shift fires")
    assert(shift.closedSegmentTurns === 2, "reports closed segment length")
    assert(d3.segmentTurns === 1, "new segment seeded by shifting turn")
  }

  // ── embedding detector (deterministic stub) ──────────────────────────
  console.log("\n── embedding drift detector (stub embedder) ─────────────")
  {
    // stub: map text → one-hot-ish vector by first letter bucket, so
    // "same bucket" = similar, "different bucket" = orthogonal.
    const stub = {
      async embedQuery(text: string): Promise<Float32Array> {
        const v = new Float32Array(26)
        const c = text.trim().toLowerCase().charCodeAt(0) - 97
        if (c >= 0 && c < 26) v[c] = 1
        else v[0] = 1
        return v
      },
    }
    const d = new EmbeddingDriftDetector(stub, { driftThreshold: 0.5, minSegmentTurns: 2 })
    const a1 = await d.observe("apple auth")
    assert(!a1.shifted, "embed: first turn no shift")
    await d.observe("apricot access")          // same 'a' bucket
    const b = await d.observe("zebra zone")     // 'z' bucket — orthogonal
    assert(b.shifted, "embed: orthogonal turn after min turns shifts")
    assert(d.centroidCopy() !== null, "embed: centroid available for archival")
  }

  // ── cosineVec sanity ──────────────────────────────────────────────────
  console.log("\n── cosineVec ────────────────────────────────────────────")
  {
    const a = Float32Array.from([1, 0, 0])
    const b = Float32Array.from([1, 0, 0])
    const c = Float32Array.from([0, 1, 0])
    assert(Math.abs(cosineVec(a, b) - 1) < 1e-6, "identical vectors → 1")
    assert(Math.abs(cosineVec(a, c)) < 1e-6, "orthogonal vectors → 0")
  }

  // ── compactor: mask + restore ─────────────────────────────────────────
  console.log("\n── compactor: maskObservations / restoreObservations ────")
  {
    const messages: MsgLike[] = [
      userMsg("u1", "do the auth thing"),
      toolMsg("t1", "read", bigOutput("sessions.py")),
      textMsg("a1", "I see the redirect handling, let me reason about it carefully"),
      toolMsg("t2", "bash", bigOutput("pytest output")),
      userMsg("u2", "now switch to the CSS work"),  // boundary at index 4
    ]
    const boundary = 4
    const stash = maskObservations(messages, boundary, { minChars: 400 })
    assert(stash.length === 2, "masks both large tool outputs before boundary")
    assert(
      (messages[1].parts[0].state!.output as string).startsWith("[diane:masked]"),
      "tool output replaced with placeholder"
    )
    assert(
      (messages[2].parts[0] as unknown as { text: string }).text.includes("reason about it"),
      "reasoning/text part left untouched"
    )
    assert(estimatedTokensSaved(stash) > 100, "reports token savings")

    // idempotent: re-masking doesn't double-stash
    const again = maskObservations(messages, boundary, { minChars: 400 })
    assert(again.length === 0, "masking is idempotent (no double-mask)")

    // restore
    const n = restoreObservations(messages, stash)
    assert(n === 2, "restores both masked outputs")
    assert(
      (messages[1].parts[0].state!.output as string).startsWith("sessions.py:"),
      "original output is back verbatim"
    )

    // selective restore
    const msgs2: MsgLike[] = [
      toolMsg("t1", "read", bigOutput("a")),
      toolMsg("t2", "bash", bigOutput("b")),
      userMsg("u1", "x"),
    ]
    const s2 = maskObservations(msgs2, 2, { minChars: 400 })
    const restoredRead = restoreObservations(msgs2, s2, (e) => e.tool === "read")
    assert(restoredRead === 1, "selective restore honors predicate")
    assert(
      (msgs2[1].parts[0].state!.output as string).startsWith("[diane:masked]"),
      "non-matching entry stays masked"
    )
  }

  // ── compactor: small outputs and non-tool parts are ignored ───────────
  console.log("\n── compactor: leaves small / non-tool parts alone ───────")
  {
    const messages: MsgLike[] = [
      toolMsg("t1", "read", "short"),                  // < minChars
      textMsg("a1", "reasoning ".repeat(100)),         // text, never masked
      userMsg("u1", "shift now"),
    ]
    const stash = maskObservations(messages, 2, { minChars: 400 })
    assert(stash.length === 0, "short output and text parts are not masked")
  }

  // ── manager: end-to-end stash on shift, restore on drift-back ─────────
  console.log("\n── manager: archive on shift, re-insert on drift-back ───")
  {
    const mgr = new CompactionManager({
      ...DEFAULT_COMPACTION_CONFIG,
      minMessagesToCompact: 4,
      minObservationChars: 400,
      driftThreshold: 0.2,
      minSegmentTurns: 2,
      recallThreshold: 0.4,
    })

    // Build a conversation: segment A (auth/redirect) with big observations,
    // then a shift to segment B (CSS), then a return to segment A vocabulary.
    const convo: MsgLike[] = [
      userMsg("u1", "fix the authentication redirect session cookie handling"),
      toolMsg("t1", "read", bigOutput("sessions auth redirect")),
      userMsg("u2", "the redirect auth session logic still drops the cookie"),
      toolMsg("t2", "bash", bigOutput("pytest auth redirect failures")),
    ]
    let r = await mgr.onTransform("s1", convo)
    assert(!r.shifted, "manager: no shift while on the same goal")

    // user pivots hard to an unrelated goal (CSS / dropdown component)
    convo.push(userMsg("u3", "completely different task now: style the dropdown component css"))
    r = await mgr.onTransform("s1", convo)
    assert(r.shifted, "manager: detects the goal shift")
    assert(r.masked >= 1, "manager: masks the stale segment's observations")
    assert(r.tokensSaved > 100, "manager: reports tokens saved")
    // the auth observations are now masked
    assert(
      (convo[1].parts[0].state!.output as string).startsWith("[diane:masked]"),
      "manager: prior-segment read output is masked after shift"
    )

    // add a second CSS turn (so the CSS segment runs past minSegmentTurns),
    // then drift BACK to the auth goal
    convo.push(toolMsg("t3", "read", bigOutput("dropdown component css")))
    convo.push(userMsg("u3b", "also adjust the dropdown css hover and focus styles"))
    r = await mgr.onTransform("s1", convo)
    assert(!r.shifted, "manager: second CSS turn stays in the CSS segment")

    convo.push(userMsg("u4", "back to the authentication redirect session cookie bug"))
    r = await mgr.onTransform("s1", convo)
    assert(r.shifted, "manager: detects shift back toward the auth goal")
    assert(r.restored >= 1, "manager: re-inserts the archived auth observations")
    assert(
      (convo[1].parts[0].state!.output as string).startsWith("sessions auth redirect"),
      "manager: original auth read output restored verbatim on drift-back"
    )
  }

  // ── manager: short conversations are left alone ───────────────────────
  console.log("\n── manager: no-op on short conversations ────────────────")
  {
    const mgr = new CompactionManager({ ...DEFAULT_COMPACTION_CONFIG, minMessagesToCompact: 8 })
    const short: MsgLike[] = [userMsg("u1", "hi"), toolMsg("t1", "read", bigOutput("x"))]
    const r = await mgr.onTransform("s1", short)
    assert(!r.shifted && r.masked === 0, "short conversation: no compaction")
  }

  // ── summary ────────────────────────────────────────────────────────────
  console.log("\n──────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

main()
