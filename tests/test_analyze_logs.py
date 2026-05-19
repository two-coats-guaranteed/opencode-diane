#!/usr/bin/env python3
"""
test_analyze_logs.py — tests for analyze-logs.py, focused on the
plain-language explainer.

The explainer exists so a non-specialist — someone who has never read
the plugin's source and does not know what "prefill" or "ingest.git"
or "p95" mean — can read the report and understand WHAT the plugin did
and WHY. "Understanding" cannot be asserted directly, so these tests
check the observable proxies for it:

  * the plain output explains each major step in plain words, using the
    real numbers from the log;
  * it gives the *reason* for things, not only that they happened;
  * it contains NONE of the raw machine identifiers (event names like
    `prefill.complete`, field names like `commitMemories`, jargon like
    `p95`) — a non-specialist must not be handed those to decode;
  * the lifecycle edge cases (idle, failed startup, empty log) are each
    explained in words rather than shown as a bare status code.

Standalone — standard library only, mirroring analyze-logs.py itself.
Run directly (`python3 tests/test_analyze_logs.py`) or via the
`test:analyzer` script; it is wired into CI.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "analyze-logs.py"


def _line(**kw):
    kw.setdefault("ts", "2026-05-19T10:00:00.000Z")
    kw.setdefault("service", "diane")
    kw.setdefault("root", "/work/app")
    return json.dumps(kw)


# ── fixtures: each is one log file's worth of JSONL ────────────────────

NORMAL = "\n".join([
    _line(event="session.start", pid=4242, node="v22.0.0", platform="linux"),
    _line(event="plugin.active", storeSize=312, bytesTotal=4200000),
    _line(event="adaptive.tuned",
          signal={"tier": "large", "value": 9000, "basis": "commits"}, summary="x"),
    _line(event="prefill.start"),
    _line(event="ingest.project", facts=12),
    _line(event="ingest.git", scanned=1500, commitMemories=80, coChangeMemories=20),
    _line(event="ingest.sessions", sessions=3, taskMemories=9),
    _line(event="eviction", removed=12, trigger="prefill"),
    _line(event="prefill.complete", ms=3700, storeSize=380),
    _line(event="tool.call", tool="memory_recall", ms=3, ok=True, args={}),
    _line(event="tool.call", tool="memory_recall", ms=2, ok=True, args={}),
    _line(event="tool.call", tool="memory_remember", ms=1, ok=True, args={}),
]) + "\n"

IDLE = "\n".join([
    _line(root="/work/notes", event="session.start", pid=1),
    _line(root="/work/notes", event="plugin.idle", reason="no-workable-repo"),
]) + "\n"

FAILED = "\n".join([
    _line(event="session.start", pid=7),
    _line(event="plugin.active", storeSize=0),
    _line(event="prefill.start"),
    _line(event="prefill.failed", ms=900, error="could not spawn git"),
]) + "\n"

# A valid file with one corrupt line spliced in.
MALFORMED = NORMAL + "{ this is not valid json at all\n" + _line(
    event="tool.call", tool="memory_recall", ms=2, ok=True) + "\n"

# Raw machine identifiers a non-specialist must never be handed in the
# plain output — event names, field names, and internal jargon.
JARGON = [
    "prefill.complete", "prefill.start", "prefill.failed", "ingest.git",
    "ingest.project", "ingest.sessions", "ingest.code-map", "adaptive.tuned",
    "plugin.active", "plugin.idle", "tool.call", "semantic.ready",
    "snapshot.resume", "mining.complete", "commitmemories", "storesize",
    "bytestotal", "budgetbytes", "cochangememories", "p95", "ms_p95",
    "prefill", "ingest", "eviction",
]


def run(args, files):
    """Write `files` (name→content) to a temp dir, run the script, return (stdout, returncode)."""
    with tempfile.TemporaryDirectory() as d:
        paths = []
        for name, content in files.items():
            p = Path(d) / name
            p.write_text(content, encoding="utf-8")
            paths.append(str(p))
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), "--file", *paths, *args],
            capture_output=True, text=True,
        )
        return proc.stdout, proc.returncode


class PlainLanguageExplainer(unittest.TestCase):
    def test_explains_the_startup_scan_with_real_numbers(self):
        out, rc = run(["--plain"], {"run.jsonl": NORMAL})
        self.assertEqual(rc, 0)
        self.assertIn("scanned the project", out)          # what it did
        self.assertIn("1,500 commits", out)                # the real log number, in words
        self.assertIn(                                     # why it matters
            "instead of opening and searching your files", out,
            "the scan explanation must state WHY it matters, not just that it happened",
        )

    def test_explains_eviction_with_its_reason(self):
        out, _ = run(["--plain"], {"run.jsonl": NORMAL})
        self.assertIn("size limit", out)                   # what triggered it
        self.assertIn("12 least-used", out)                # the real number
        self.assertIn("growing without bound", out)        # why it is done

    def test_explains_adaptive_sizing(self):
        out, _ = run(["--plain"], {"run.jsonl": NORMAL})
        self.assertIn("9,000 commits", out)
        self.assertIn("large project", out)

    def test_explains_what_the_ai_did_with_memory(self):
        out, _ = run(["--plain"], {"run.jsonl": NORMAL})
        self.assertIn("searched its memory 2 times", out)
        self.assertIn("saved 1 new note", out)

    def test_plain_output_contains_no_raw_jargon(self):
        # The core "a non-specialist can read this" check: not one raw
        # event name, field name or piece of jargon survives into the
        # plain view.
        out, _ = run(["--plain"], {"run.jsonl": NORMAL})
        low = out.lower()
        for token in JARGON:
            self.assertNotIn(
                token, low,
                f"plain output must not contain the machine identifier {token!r}",
            )

    def test_output_is_a_numbered_walkthrough(self):
        out, _ = run(["--plain"], {"run.jsonl": NORMAL})
        for marker in ("1.", "2.", "3.", "4."):
            self.assertIn(marker, out)

    def test_idle_session_is_explained_not_just_flagged(self):
        out, _ = run(["--plain"], {"idle.jsonl": IDLE})
        self.assertIn("not a Git repository", out)         # what
        self.assertIn("expected behaviour", out)           # why — it is not a fault
        for token in JARGON:
            self.assertNotIn(token, out.lower())

    def test_failed_startup_is_explained(self):
        out, _ = run(["--plain"], {"failed.jsonl": FAILED})
        self.assertIn("startup scan did not finish", out)         # what
        self.assertIn("could not spawn git", out)                 # the real error, passed through
        self.assertIn("falls back to searching your files", out)  # what it means for the user

    def test_empty_log_is_explained(self):
        out, rc = run(["--plain"], {"empty.jsonl": ""})
        self.assertEqual(rc, 0)
        self.assertIn("empty", out.lower())

    def test_malformed_lines_do_not_break_the_report(self):
        out, rc = run(["--plain"], {"run.jsonl": MALFORMED})
        self.assertEqual(rc, 0)
        self.assertIn("scanned the project", out)  # the good records are still explained

    def test_json_output_carries_the_explanation(self):
        out, rc = run(["--json"], {"run.jsonl": NORMAL})
        self.assertEqual(rc, 0)
        sess = json.loads(out)["sessions"][0]
        self.assertIn("explanation", sess)
        self.assertIsInstance(sess["explanation"], list)
        self.assertGreaterEqual(len(sess["explanation"]), 4)
        self.assertTrue(all(isinstance(x, str) and x.strip() for x in sess["explanation"]))

    def test_full_report_leads_with_the_plain_summary(self):
        # In the default (technical) report the plain section must come
        # FIRST, before the detail — a non-specialist reads it and can
        # stop there.
        out, _ = run([], {"run.jsonl": NORMAL})
        self.assertIn("### What happened", out)
        self.assertIn("### Details", out)
        self.assertLess(out.index("### What happened"), out.index("### Details"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
