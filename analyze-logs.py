#!/usr/bin/env python3
"""
analyze-logs.py — build a structured report from opencode-diane
rich logs.

The opencode-diane plugin writes JSON-Lines logs to
`<tmpdir>/diane/diane-<iso>-pid<pid>.jsonl` (one file per
OpenCode process). This script reads those files and produces either a
Markdown report (default — readable in a terminal or pasted into a PR)
or a JSON document (for further analysis or feeding to an LLM).

Every report leads with a **plain-language "What happened" summary** —
a jargon-free account of what the plugin did and *why* it mattered,
written for someone who has never read the plugin's source. Use
`--plain` to print only that summary.

The script is completely standalone: it depends only on the Python
standard library (3.8+) and knows nothing about the plugin's source —
it only knows the record shape the plugin writes. That means you can
ship this script anywhere, or include the structured representation it
emits in a bug report, without dragging the whole plugin along.

Usage
-----

    ./analyze-logs.py                       # latest sessions in default dir
    ./analyze-logs.py --plain               # plain-language summary only
    ./analyze-logs.py --tail 3              # only the 3 most recent
    ./analyze-logs.py --json                # JSON instead of Markdown
    ./analyze-logs.py --dir /custom/path    # custom log directory
    ./analyze-logs.py --file a.jsonl b.jsonl
    ./analyze-logs.py --root /path/to/repo  # only sessions on that repo
    ./analyze-logs.py --timeline            # include the chronological
                                            # event timeline per session
    ./analyze-logs.py --no-aggregate        # skip the cross-session summary
    ./analyze-logs.py --quiet               # minimal output

Record shapes the plugin writes (recap, for self-containment)
-------------------------------------------------------------

Every line of every log file is one JSON object. There are two record
shapes that share the file — they're distinguished by which key is set:

  Prose lines (mirrors of what OpenCode's session log showed):
      {"ts": "...", "service": "diane", "root": "...",
       "level": "info"|"warn"|"debug"|"error", "message": "..."}

  Structured events:
      {"ts": "...", "service": "...", "root": "...",
       "event": "name.subname", ...payload}

Notable events:
    session.start, plugin.idle, plugin.active,
    prefill.start, prefill.complete, prefill.failed,
    adaptive.tuned, ingest.project, ingest.git, ingest.sessions,
    ingest.code-map, ingest.code-map.skipped,
    snapshot.resume, eviction,
    tool.call (with tool, ms, ok, args, result|error),
    mining.complete, mining.failed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any, Dict, Iterable, List, Optional, Tuple

# ─── constants ─────────────────────────────────────────────────────────

SCRIPT_VERSION = "1.0.0"
SCHEMA_VERSION = 1  # bump if the JSON output shape changes incompatibly


def default_log_dir() -> Path:
    """The directory the plugin writes to (mirror of the TS-side default)."""
    return Path(tempfile.gettempdir()) / "diane"


# ─── parsing ───────────────────────────────────────────────────────────


def parse_jsonl_file(path: Path) -> Tuple[List[Dict[str, Any]], int]:
    """
    Read a JSONL file into a list of records. Returns (records,
    parse_failures). Malformed lines are skipped with their count
    surfaced — JSONL is line-oriented so a corrupt line is at most a
    local data loss, not a file-level failure.
    """
    records: List[Dict[str, Any]] = []
    parse_failures = 0
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        # The caller decides how to surface this; we just return empty.
        # The error message ends up in the per-session "errors" channel.
        print(f"warning: cannot read {path}: {e}", file=sys.stderr)
        return [], 0
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            parse_failures += 1
    return records, parse_failures


def parse_iso_ts(ts: Optional[str]) -> Optional[datetime]:
    """Tolerant ISO-8601 parse. The plugin emits with a trailing 'Z'."""
    if not isinstance(ts, str):
        return None
    try:
        # `datetime.fromisoformat` accepts the +00:00 form but not 'Z'
        # until 3.11. Normalise so 3.8+ works.
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


# ─── per-session structured summary ────────────────────────────────────


def _tool_call_stats(tool_calls: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """
    Group tool.call events by tool name and compute median/p95/max ms
    plus ok/failed counts. p95 is computed naively because n is small —
    no numpy or scipy.
    """
    per_tool: Dict[str, Dict[str, List[Any]]] = defaultdict(
        lambda: {"ms": [], "ok": 0, "failed": 0, "errors": []}
    )
    for tc in tool_calls:
        name = tc.get("tool") or "<unknown>"
        bucket = per_tool[name]
        if tc.get("ok"):
            bucket["ok"] += 1
        else:
            bucket["failed"] += 1
            if isinstance(tc.get("error"), str):
                bucket["errors"].append(tc["error"])
        ms = tc.get("ms")
        if isinstance(ms, (int, float)):
            bucket["ms"].append(ms)

    out: Dict[str, Dict[str, Any]] = {}
    for name, bucket in per_tool.items():
        ms_list = sorted(bucket["ms"])
        calls = bucket["ok"] + bucket["failed"]
        if ms_list:
            # p95 on a small sample: the ceiling index into the sorted list.
            p95_idx = max(0, min(len(ms_list) - 1, int(round(0.95 * (len(ms_list) - 1)))))
            p95 = ms_list[p95_idx]
            mdn = int(median(ms_list))
            mx = max(ms_list)
        else:
            p95 = mdn = mx = None
        out[name] = {
            "calls": calls,
            "ok": bucket["ok"],
            "failed": bucket["failed"],
            "ms_median": mdn,
            "ms_p95": p95,
            "ms_max": mx,
            "error_samples": bucket["errors"][:5],  # cap to keep JSON small
        }
    return out


def session_summary(path: Path, records: List[Dict[str, Any]], parse_failures: int) -> Dict[str, Any]:
    """Build the structured per-session summary."""
    if not records:
        return {
            "path": str(path),
            "empty": True,
            "parse_failures": parse_failures,
        }

    # The first record is the session.start header by construction; if
    # it's missing (corrupt file), tolerate it and use the first record
    # for context fields.
    header = next((r for r in records if r.get("event") == "session.start"), records[0])

    first_ts = parse_iso_ts(records[0].get("ts"))
    last_ts = parse_iso_ts(records[-1].get("ts"))
    duration_s: Optional[float] = None
    if first_ts and last_ts:
        duration_s = (last_ts - first_ts).total_seconds()

    # Pull out the substreams. A record either has `event` or `level` —
    # never both — so the partition is clean.
    events_only = [r for r in records if "event" in r]
    prose_only = [r for r in records if "level" in r]

    event_counts: Counter[str] = Counter()
    for r in events_only:
        event_counts[str(r.get("event"))] += 1

    tool_calls = [r for r in events_only if r.get("event") == "tool.call"]
    tool_stats = _tool_call_stats(tool_calls)

    # Capture the ingest.* events' payloads — they hold the meaningful
    # work counts (commits scanned, signatures extracted, etc.).
    ingest_events: Dict[str, Dict[str, Any]] = {}
    for r in events_only:
        name = str(r.get("event", ""))
        if name.startswith("ingest."):
            payload = {
                k: v
                for k, v in r.items()
                if k not in ("ts", "service", "root", "event")
            }
            ingest_events[name] = payload

    # Capture the lifecycle events' payloads — everything that is not a
    # tool call, an ingest.* event, or the session header. The
    # plain-language explainer reads these to describe what each step
    # did and why. Most are singletons; a few (eviction) can recur, so
    # each name maps to a list of payloads.
    key_events: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in events_only:
        name = str(r.get("event", ""))
        if name == "tool.call" or name.startswith("ingest.") or name == "session.start":
            continue
        payload = {
            k: v for k, v in r.items() if k not in ("ts", "service", "root", "event")
        }
        key_events[name].append(payload)

    # Warnings + errors come from two streams: prose lines with
    # level=warn/error, and structured events whose name ends in
    # .failed (prefill.failed, mining.failed) or where ok==false.
    warnings_errors: List[Dict[str, Any]] = []
    for r in records:
        is_prose_problem = r.get("level") in ("warn", "error")
        is_event_problem = (
            isinstance(r.get("event"), str) and r["event"].endswith(".failed")
        ) or (r.get("event") == "tool.call" and r.get("ok") is False)
        if is_prose_problem or is_event_problem:
            warnings_errors.append(
                {
                    "ts": r.get("ts"),
                    "level": r.get("level"),
                    "event": r.get("event"),
                    "message": r.get("message"),
                    "error": r.get("error"),
                    "tool": r.get("tool"),
                }
            )

    # The timeline: every event/log line with its delta-from-start, for
    # callers who want to see the chronological flow rather than the
    # aggregated view. Kept compact.
    timeline: List[Dict[str, Any]] = []
    for r in records:
        rec_ts = parse_iso_ts(r.get("ts"))
        delta_s = (rec_ts - first_ts).total_seconds() if (rec_ts and first_ts) else None
        timeline.append(
            {
                "t": delta_s,
                "event": r.get("event"),
                "level": r.get("level"),
                "message": r.get("message"),
                "tool": r.get("tool"),
                "ms": r.get("ms"),
                "ok": r.get("ok"),
            }
        )

    return {
        "path": str(path),
        "empty": False,
        "start_ts": records[0].get("ts"),
        "end_ts": records[-1].get("ts"),
        "duration_s": duration_s,
        "root": header.get("root"),
        "pid": header.get("pid"),
        "node": header.get("node"),
        "platform": header.get("platform"),
        "cwd": header.get("cwd"),
        "service": header.get("service"),
        "record_count": len(records),
        "event_count": len(events_only),
        "prose_line_count": len(prose_only),
        "event_counts": dict(event_counts),
        "ingest": ingest_events,
        "key_events": dict(key_events),
        "tool_calls_total": len(tool_calls),
        "tool_stats": tool_stats,
        "tool_calls_detail": [
            {
                "ts": tc.get("ts"),
                "tool": tc.get("tool"),
                "ms": tc.get("ms"),
                "ok": tc.get("ok"),
                "args": tc.get("args"),
                "result": tc.get("result"),
                "error": tc.get("error"),
            }
            for tc in tool_calls
        ],
        "warnings_errors": warnings_errors,
        "timeline": timeline,
        "parse_failures": parse_failures,
    }


# ─── cross-session aggregate ───────────────────────────────────────────


def aggregate_summary(sessions: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Cross-session totals — useful when scanning many runs at once."""
    non_empty = [s for s in sessions if not s.get("empty")]
    total_records = sum(s.get("record_count", 0) for s in non_empty)
    total_tool_calls = sum(s.get("tool_calls_total", 0) for s in non_empty)
    total_errors = sum(len(s.get("warnings_errors") or []) for s in non_empty)
    total_parse_failures = sum(s.get("parse_failures", 0) for s in sessions)

    # Per-tool aggregates: re-merge ms lists across sessions for correct
    # p95 across the population, not p95 of per-session p95s (which is
    # a stats error).
    per_tool_ms: Dict[str, List[float]] = defaultdict(list)
    per_tool_ok: Counter[str] = Counter()
    per_tool_failed: Counter[str] = Counter()
    for s in non_empty:
        for tc in s.get("tool_calls_detail") or []:
            tool = tc.get("tool") or "<unknown>"
            ms = tc.get("ms")
            if isinstance(ms, (int, float)):
                per_tool_ms[tool].append(ms)
            if tc.get("ok"):
                per_tool_ok[tool] += 1
            else:
                per_tool_failed[tool] += 1

    per_tool_aggregate: Dict[str, Dict[str, Any]] = {}
    for tool in set(per_tool_ms) | set(per_tool_ok) | set(per_tool_failed):
        ms_list = sorted(per_tool_ms.get(tool, []))
        if ms_list:
            p95_idx = max(0, min(len(ms_list) - 1, int(round(0.95 * (len(ms_list) - 1)))))
            p95 = ms_list[p95_idx]
            mdn = int(median(ms_list))
            mx = max(ms_list)
        else:
            p95 = mdn = mx = None
        per_tool_aggregate[tool] = {
            "calls": per_tool_ok[tool] + per_tool_failed[tool],
            "ok": per_tool_ok[tool],
            "failed": per_tool_failed[tool],
            "ms_median": mdn,
            "ms_p95": p95,
            "ms_max": mx,
        }

    # Event-name histogram across all sessions.
    event_hist: Counter[str] = Counter()
    for s in non_empty:
        for name, n in (s.get("event_counts") or {}).items():
            event_hist[name] += n

    # Distinct roots covered.
    roots = sorted({s.get("root") for s in non_empty if s.get("root")})

    return {
        "sessions_total": len(sessions),
        "sessions_with_data": len(non_empty),
        "total_records": total_records,
        "total_tool_calls": total_tool_calls,
        "total_warnings_errors": total_errors,
        "total_parse_failures": total_parse_failures,
        "roots": roots,
        "event_histogram": dict(event_hist.most_common()),
        "tool_aggregate": per_tool_aggregate,
    }


# ─── Markdown rendering ────────────────────────────────────────────────


def _fmt_duration(seconds: Optional[float]) -> str:
    if seconds is None:
        return "—"
    if seconds < 1:
        return f"{seconds * 1000:.0f} ms"
    if seconds < 60:
        return f"{seconds:.1f} s"
    m, s = divmod(seconds, 60)
    return f"{int(m)}m{s:04.1f}s"


def _fmt_bytes(n: Optional[int]) -> str:
    if not isinstance(n, (int, float)):
        return "—"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def _fmt_payload(payload: Dict[str, Any]) -> str:
    """Compactly summarise an event payload as `key=value, key=value`."""
    parts: List[str] = []
    for k, v in payload.items():
        if isinstance(v, bool):
            parts.append(f"{k}={'yes' if v else 'no'}")
        elif isinstance(v, (int, float, str)) and not isinstance(v, bool):
            s = str(v)
            if len(s) > 80:
                s = s[:80] + "…"
            parts.append(f"{k}={s}")
        elif isinstance(v, list):
            parts.append(f"{k}=[{len(v)}]")
        elif isinstance(v, dict):
            inner = ", ".join(f"{ik}={iv}" for ik, iv in list(v.items())[:6])
            if len(v) > 6:
                inner += f", +{len(v) - 6} more"
            parts.append(f"{k}={{{inner}}}")
    return ", ".join(parts) or "(empty)"


# ─── plain-language explainer ──────────────────────────────────────────
#
# Everything above turns the raw log into structured numbers. This
# section turns the structured numbers into plain English: a short
# account of WHAT the plugin did and WHY it mattered, written for
# someone who has never read the plugin's source and does not know
# what "prefill" or "ingest.git" or "p95" mean. The technical sections
# of the report still carry the raw detail; this is the layer a
# non-specialist reads first (and the only thing `--plain` prints).


def _ev(s: Dict[str, Any], name: str) -> Optional[Dict[str, Any]]:
    """First captured payload of a lifecycle event, or None."""
    lst = (s.get("key_events") or {}).get(name) or []
    return lst[0] if lst else None


def _plural(n: int, one: str, many: Optional[str] = None) -> str:
    """Pick the singular or plural word for a count."""
    return one if n == 1 else (many if many is not None else one + "s")


def explain_session(s: Dict[str, Any]) -> List[str]:
    """
    A plain-language, jargon-free account of what the plugin did in one
    session and *why* — each entry is one "what happened, and why it
    mattered" point. No raw event names, no field names, no latency
    percentiles: those live in the technical sections. This is what
    makes the report legible to a non-specialist.
    """
    if s.get("empty"):
        return ["This log file was empty — the plugin recorded no activity for it."]

    out: List[str] = []
    ke = s.get("key_events") or {}
    ingest = s.get("ingest") or {}

    # Idle — the plugin decided there was nothing to do.
    if "plugin.idle" in ke:
        return [
            "The plugin looked at this folder and then stayed switched off: it "
            "is not a Git repository and has no recognised project files (a "
            "package manifest, a build config, and the like), so there was "
            "nothing for it to build a memory from. This is expected behaviour, "
            "not a fault — the plugin only activates for a real project."
        ]

    # Startup.
    active = _ev(s, "plugin.active")
    if active is not None and isinstance(active.get("storeSize"), int):
        n = active["storeSize"]
        out.append(
            f"The memory plugin started up for this project. It loaded the "
            f"memory it had saved on earlier runs — {n} stored "
            f"{_plural(n, 'item')} — and continued from there. (That memory is "
            f"kept in a small database inside the project and survives between "
            f"sessions.)"
        )
    else:
        out.append("The memory plugin started up and loaded its saved memory for this project.")

    # Adaptive sizing.
    tuned = _ev(s, "adaptive.tuned")
    if tuned is not None:
        signal = tuned.get("signal") or {}
        tier, value, basis = signal.get("tier"), signal.get("value"), signal.get("basis")
        if tier and isinstance(value, int) and basis:
            out.append(
                f"It measured how large the repository is — {value:,} {basis} "
                f"— and sized itself for a {tier} project. A larger repository "
                f"is indexed more deeply and a small one more lightly, so the "
                f"plugin does an amount of work that fits the project instead "
                f"of a fixed amount."
            )
        else:
            out.append(
                "It measured the repository's size and adjusted how much "
                "history to index to match it — more for a large project, "
                "less for a small one."
            )

    # Prefill — the headline of most sessions.
    if "prefill.complete" in ke:
        pc = _ev(s, "prefill.complete")
        did: List[str] = []
        g = ingest.get("ingest.git")
        if g is not None and isinstance(g.get("scanned"), int):
            made = g.get("commitMemories")
            made_txt = f"{made}" if isinstance(made, int) else "several"
            made_n = made if isinstance(made, int) else 2
            did.append(
                f"read {g['scanned']:,} {_plural(g['scanned'], 'commit')} of "
                f"Git history and turned them into {made_txt} compact "
                f"{_plural(made_n, 'note')} about which files change together, "
                f"which change most often, and what changed recently"
            )
        p = ingest.get("ingest.project")
        if p is not None and isinstance(p.get("facts"), int):
            did.append(
                f"looked over the project's build and configuration files and "
                f"recorded {p['facts']} plain {_plural(p['facts'], 'fact')} "
                f"about them (the language, the build tooling, and so on)"
            )
        ses = ingest.get("ingest.sessions")
        if ses is not None and isinstance(ses.get("sessions"), int) and ses["sessions"] > 0:
            did.append(
                f"took in {ses['sessions']} earlier coding "
                f"{_plural(ses['sessions'], 'session')} on this project so "
                f"that past work can be found again"
            )
        cm = ingest.get("ingest.code-map")
        if cm is not None and isinstance(cm.get("filesParsed"), int):
            did.append(
                f"parsed {cm['filesParsed']:,} source "
                f"{_plural(cm['filesParsed'], 'file')} into a map of the "
                f"functions and classes they define"
            )
        ms = (pc or {}).get("ms")
        took = (
            f" The whole scan took {_fmt_duration(ms / 1000)}."
            if isinstance(ms, (int, float))
            else ""
        )
        body = (
            "When it started, the plugin scanned the project in the background "
            "and refreshed its memory. This is the step that lets the AI "
            "answer questions like \u201cwhere is this handled?\u201d or "
            "\u201cwhat changed recently?\u201d straight from memory, instead "
            "of opening and searching your files every time — which is much "
            "slower and costs far more tokens. In this run it "
        )
        body += ("; ".join(did) + "." if did else "found nothing new to add since the last run.")
        out.append(body + took)
    elif "prefill.failed" in ke:
        pf = _ev(s, "prefill.failed")
        why = (pf or {}).get("error") or "an unexpected error"
        out.append(
            f"The startup scan did not finish — it stopped with: {why}. The "
            f"assistant still works, but for this session it falls back to "
            f"searching your files directly instead of using prepared memory."
        )

    # Code map skipped.
    skipped = ingest.get("ingest.code-map.skipped")
    if skipped is not None:
        why = skipped.get("reason") or "it was not available"
        out.append(
            f"The optional code map — a structural index of function and class "
            f"signatures — was not built this run ({why}). It is an opt-in "
            f"extra, and the rest of the memory works without it."
        )

    # Eviction.
    if "eviction" in ke:
        removed = sum(
            p.get("removed", 0)
            for p in ke.get("eviction", [])
            if isinstance(p.get("removed"), int)
        )
        if removed > 0:
            out.append(
                f"The memory store reached its size limit, so the {removed} "
                f"least-used {_plural(removed, 'item')} "
                f"{_plural(removed, 'was', 'were')} dropped to make room. "
                f"Items that are used often, and any that are pinned, are "
                f"always kept. This is routine housekeeping — it stops the "
                f"memory from growing without bound."
            )

    # Snapshot resume.
    if "snapshot.resume" in ke:
        out.append(
            "It found a snapshot saved by a previous session and resumed from "
            "it, so the assistant could pick up the thread instead of starting "
            "from a blank slate."
        )

    # Semantic search.
    if "semantic.ready" in ke:
        sr = _ev(s, "semantic.ready")
        model = (sr or {}).get("model") or "a multilingual model"
        msg = (
            f"Cross-lingual semantic search is switched on. The plugin loaded "
            f"its language model ({model}) so that a search written in one "
            f"language can find code and comments written in another."
        )
        emb = _ev(s, "semantic.embedded")
        if emb is not None and isinstance(emb.get("embedded"), int):
            msg += (
                f" In the background it prepared {emb['embedded']} "
                f"{_plural(emb['embedded'], 'memory', 'memories')} for that "
                f"kind of search."
            )
        out.append(msg)
    elif "semantic.unavailable" in ke:
        su = _ev(s, "semantic.unavailable")
        why = (su or {}).get("reason") or "the required package was missing"
        out.append(
            f"Semantic (cross-language) search was switched on but could not "
            f"start ({why}), so the plugin quietly used ordinary keyword search "
            f"instead. Nothing was broken by this — searches simply stayed "
            f"within one language."
        )

    # What the AI did with its memory.
    tool_stats = s.get("tool_stats") or {}
    total = s.get("tool_calls_total") or 0
    if total > 0:
        recalls = (tool_stats.get("memory_recall") or {}).get("calls", 0)
        saves = (tool_stats.get("memory_remember") or {}).get("calls", 0)
        bits: List[str] = []
        if recalls:
            bits.append(f"searched its memory {recalls} {_plural(recalls, 'time')}")
        if saves:
            bits.append(f"saved {saves} new {_plural(saves, 'note')}")
        other = total - recalls - saves
        if other > 0:
            bits.append(f"used other memory tools {other} {_plural(other, 'time')}")
        detail = "; ".join(bits) if bits else f"used memory tools {total} times"
        out.append(
            f"During the session the AI {detail}. Each memory search takes the "
            f"place of several file reads, which is the whole point of the "
            f"plugin — it makes the assistant faster and cheaper to run."
        )
    else:
        out.append(
            "The AI did not use any of the memory tools in this session — no "
            "searches or saved notes were recorded. (The memory was still "
            "prepared and ready; it simply was not queried this time.)"
        )

    # Skill mining.
    mc = _ev(s, "mining.complete")
    if mc is not None and isinstance(mc.get("skillsWritten"), int) and mc["skillsWritten"] > 0:
        n = mc["skillsWritten"]
        out.append(
            f"It also distilled {n} reusable \u201cskill\u201d "
            f"{_plural(n, 'file')} — short how-to notes drawn from repeated "
            f"patterns of work and saved where the AI can reuse them later."
        )

    # Closing — did anything go wrong?
    we = s.get("warnings_errors") or []
    if we:
        out.append(
            f"Finally, {len(we)} {_plural(len(we), 'thing')} "
            f"{_plural(len(we), 'was', 'were')} logged as a warning or error "
            f"this session. The \u201cWarnings & errors\u201d section below "
            f"lists each one — they do not necessarily mean the session "
            f"failed, but they are worth a look."
        )
    else:
        out.append(
            "Nothing was logged as a warning or an error — this session looks clean."
        )

    return out


def _what_happened_md(s: Dict[str, Any]) -> str:
    """
    Render the plain-language 'What happened' section for one session —
    a context line plus the numbered explanation. Shared by the full
    Markdown report and the `--plain` view.
    """
    out = ["### What happened\n\n"]
    root = s.get("root") or "this project"
    dur = _fmt_duration(s.get("duration_s"))
    ctx = f"Session on `{root}`"
    if dur != "—":
        ctx += f" — lasted {dur}"
    if isinstance(s.get("record_count"), int):
        ctx += f", {s['record_count']} log {_plural(s['record_count'], 'record')}"
    out.append(ctx + ".\n\n")
    for i, point in enumerate(s.get("explanation") or explain_session(s), 1):
        out.append(f"{i}. {point}\n")
    out.append("\n")
    return "".join(out)


def render_aggregate_md(agg: Dict[str, Any]) -> str:
    out = ["## Across all sessions\n"]
    out.append(
        f"- **Sessions analysed:** {agg['sessions_with_data']} "
        f"(of {agg['sessions_total']} files; "
        f"{agg['total_parse_failures']} malformed line(s))\n"
    )
    out.append(f"- **Records:** {agg['total_records']:,}\n")
    out.append(f"- **Tool calls:** {agg['total_tool_calls']:,}\n")
    out.append(f"- **Warnings / errors:** {agg['total_warnings_errors']}\n")
    if agg["roots"]:
        out.append(f"- **Repos seen:** {', '.join(f'`{r}`' for r in agg['roots'])}\n")
    out.append("\n")

    if agg["tool_aggregate"]:
        out.append("### Tool calls (aggregate)\n\n")
        out.append("| Tool | Calls | OK | Failed | Median ms | p95 ms | Max ms |\n")
        out.append("|---|--:|--:|--:|--:|--:|--:|\n")
        items = sorted(
            agg["tool_aggregate"].items(), key=lambda kv: -kv[1]["calls"]
        )
        for name, st in items:
            out.append(
                f"| `{name}` | {st['calls']} | {st['ok']} | {st['failed']} "
                f"| {st['ms_median'] if st['ms_median'] is not None else '—'} "
                f"| {st['ms_p95'] if st['ms_p95'] is not None else '—'} "
                f"| {st['ms_max'] if st['ms_max'] is not None else '—'} |\n"
            )
        out.append("\n")

    if agg["event_histogram"]:
        out.append("### Event types seen\n\n")
        for name, n in list(agg["event_histogram"].items())[:30]:
            out.append(f"- `{name}` × {n}\n")
        if len(agg["event_histogram"]) > 30:
            out.append(f"- … and {len(agg['event_histogram']) - 30} more types\n")
        out.append("\n")

    return "".join(out)


def render_session_md(s: Dict[str, Any], include_timeline: bool) -> str:
    name = Path(s["path"]).name
    out = [f"## Session — `{name}`\n\n"]

    # Lead with the plain-language account — this is the part a
    # non-specialist reads. The technical sections follow it.
    out.append(_what_happened_md(s))

    if s.get("empty"):
        return "".join(out)

    out.append("### Details\n\n")
    out.append(f"- **Root:** `{s.get('root') or '—'}`\n")
    out.append(f"- **Started:** {s.get('start_ts')}\n")
    out.append(f"- **Duration:** {_fmt_duration(s.get('duration_s'))}\n")
    out.append(
        f"- **PID/platform:** {s.get('pid')} / {s.get('platform')} ({s.get('node')})\n"
    )
    out.append(
        f"- **Records:** {s['record_count']} "
        f"({s['event_count']} events, {s['prose_line_count']} prose lines)\n"
    )

    if s.get("ingest"):
        out.append("\n### Ingestion\n\n")
        for name_, payload in s["ingest"].items():
            out.append(f"- **`{name_}`** — {_fmt_payload(payload)}\n")

    if s.get("tool_stats"):
        out.append("\n### Tool calls\n\n")
        out.append("| Tool | Calls | OK | Failed | Median ms | p95 ms | Max ms |\n")
        out.append("|---|--:|--:|--:|--:|--:|--:|\n")
        items = sorted(s["tool_stats"].items(), key=lambda kv: -kv[1]["calls"])
        for name_, st in items:
            out.append(
                f"| `{name_}` | {st['calls']} | {st['ok']} | {st['failed']} "
                f"| {st['ms_median'] if st['ms_median'] is not None else '—'} "
                f"| {st['ms_p95'] if st['ms_p95'] is not None else '—'} "
                f"| {st['ms_max'] if st['ms_max'] is not None else '—'} |\n"
            )

    if s.get("warnings_errors"):
        out.append("\n### Warnings & errors\n\n")
        for w in s["warnings_errors"][:30]:
            label = w.get("level") or w.get("event") or "?"
            tool = f" [{w['tool']}]" if w.get("tool") else ""
            body = w.get("message") or w.get("error") or "(no detail)"
            if isinstance(body, str) and len(body) > 200:
                body = body[:200] + "…"
            out.append(f"- **{label}**{tool}: {body}\n")
        if len(s["warnings_errors"]) > 30:
            out.append(f"- … and {len(s['warnings_errors']) - 30} more\n")

    if include_timeline:
        out.append("\n### Timeline\n\n```\n")
        for r in s["timeline"]:
            t = r.get("t")
            t_str = f"{t:7.3f}s" if isinstance(t, (int, float)) else "    ?  "
            if r.get("event") == "tool.call":
                ok_mark = "✓" if r.get("ok") else "✗"
                out.append(
                    f"{t_str}  tool.call  {ok_mark} {r.get('tool', '?')} "
                    f"({r.get('ms', '?')}ms)\n"
                )
            elif r.get("event"):
                out.append(f"{t_str}  event      {r['event']}\n")
            elif r.get("level"):
                msg = r.get("message", "")
                if len(msg) > 90:
                    msg = msg[:90] + "…"
                out.append(f"{t_str}  log.{r['level']:<5} {msg}\n")
        out.append("```\n")

    if s.get("parse_failures"):
        out.append(
            f"\n_Note: {s['parse_failures']} malformed JSONL line(s) "
            f"in this file were skipped._\n"
        )

    out.append("\n")
    return "".join(out)


def render_markdown(report: Dict[str, Any], args: argparse.Namespace) -> str:
    out = ["# opencode-diane — log analysis\n\n"]
    out.append(
        f"_Generated by `analyze-logs.py` v{SCRIPT_VERSION} at "
        f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} "
        f"from `{report['source_dir']}`._\n\n"
    )

    if not args.no_aggregate and report["sessions"]:
        out.append(render_aggregate_md(report["aggregate"]))

    out.append("---\n\n")
    for s in report["sessions"]:
        out.append(render_session_md(s, include_timeline=args.timeline))
    return "".join(out)


def render_plain(report: Dict[str, Any]) -> str:
    """
    Plain-language only — the 'what happened and why' for each session,
    with none of the technical tables. This is the view for someone who
    just wants to know what the plugin did, in words.
    """
    out = ["# opencode-diane — what happened\n\n"]
    out.append(
        "A plain-language account of what the memory plugin did in each "
        "logged session — what each step was for, and why it mattered. Run "
        "the analyzer without `--plain` for the full report with timings, "
        "per-tool tables and the event timeline.\n\n"
    )
    if not report["sessions"]:
        out.append("_No log sessions were found._\n")
        return "".join(out)
    for s in report["sessions"]:
        out.append(f"## Session — `{Path(s['path']).name}`\n\n")
        out.append(_what_happened_md(s))
    return "".join(out)


def render_quiet(report: Dict[str, Any]) -> str:
    """One-line-per-session minimal output."""
    lines = []
    for s in report["sessions"]:
        if s.get("empty"):
            lines.append(f"{Path(s['path']).name}: (empty)")
            continue
        lines.append(
            f"{Path(s['path']).name}: root={s.get('root') or '—'} "
            f"records={s['record_count']} tool_calls={s['tool_calls_total']} "
            f"warn/err={len(s.get('warnings_errors') or [])} "
            f"duration={_fmt_duration(s.get('duration_s'))}"
        )
    return "\n".join(lines) + ("\n" if lines else "")


# ─── orchestration ─────────────────────────────────────────────────────


def collect_files(args: argparse.Namespace) -> Tuple[List[Path], Path]:
    """Resolve --file or --dir/--tail into a concrete file list."""
    if args.file:
        files = [Path(f) for f in args.file]
        source_dir = files[0].parent if files else default_log_dir()
        missing = [f for f in files if not f.is_file()]
        if missing:
            for f in missing:
                print(f"warning: {f} not found", file=sys.stderr)
        files = [f for f in files if f.is_file()]
        return files, source_dir

    d = Path(args.dir) if args.dir else default_log_dir()
    if not d.is_dir():
        return [], d
    # Most recent first by mtime; the plugin uses ISO-timestamped names
    # so name-sort and mtime-sort agree, but mtime is more robust to
    # filename changes.
    all_files = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if args.tail:
        all_files = all_files[: args.tail]
    return all_files, d


def build_report(files: List[Path], source_dir: Path, root_filter: Optional[str]) -> Dict[str, Any]:
    sessions: List[Dict[str, Any]] = []
    for f in files:
        records, parse_failures = parse_jsonl_file(f)
        s = session_summary(f, records, parse_failures)
        if root_filter and s.get("root") != root_filter:
            continue
        # The plain-language "what happened and why" account — attached
        # here so it rides along in both the Markdown and the JSON
        # output.
        s["explanation"] = explain_session(s)
        sessions.append(s)
    # Sort newest-first by start_ts so the report leads with what
    # someone debugging is most likely to want.
    sessions.sort(key=lambda s: s.get("start_ts") or "", reverse=True)

    return {
        "tool": "analyze-logs.py",
        "tool_version": SCRIPT_VERSION,
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_dir": str(source_dir),
        "file_count": len(files),
        "sessions": sessions,
        "aggregate": aggregate_summary(sessions),
    }


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="analyze-logs.py",
        description=(
            "Build a structured Markdown or JSON report from "
            "opencode-diane's rich JSONL logs. Standalone "
            "(stdlib only); reads from the plugin's tmpdir output."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  ./analyze-logs.py                 # latest sessions, Markdown\n"
            "  ./analyze-logs.py --plain         # plain-language summary only\n"
            "  ./analyze-logs.py --json --tail 5 # 5 newest, JSON for an LLM\n"
            "  ./analyze-logs.py --timeline      # include chronological event listing\n"
            "  ./analyze-logs.py --root /repo    # filter to a specific repo\n"
        ),
    )
    p.add_argument("--dir", help="log directory (default: <tmpdir>/diane)")
    p.add_argument(
        "--file", nargs="+", help="specific .jsonl file(s); overrides --dir/--tail"
    )
    p.add_argument(
        "--tail", type=int, help="only the N most-recent files (by mtime)"
    )
    p.add_argument("--root", help="only sessions whose repo root == this path")
    p.add_argument(
        "--json", action="store_true", help="emit JSON instead of Markdown"
    )
    p.add_argument(
        "--timeline",
        action="store_true",
        help="include the chronological event timeline per session (Markdown only)",
    )
    p.add_argument(
        "--no-aggregate",
        action="store_true",
        help="omit the cross-session aggregate section (Markdown only)",
    )
    p.add_argument(
        "--quiet",
        action="store_true",
        help="minimal one-line-per-session output (overrides --json)",
    )
    p.add_argument(
        "--plain",
        action="store_true",
        help="plain-language 'what happened and why' only — no technical "
        "tables; the view for a non-specialist (overrides --json)",
    )
    p.add_argument(
        "--version", action="version", version=f"analyze-logs.py {SCRIPT_VERSION}"
    )
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    files, source_dir = collect_files(args)
    if not files:
        print(
            f"no .jsonl files found in {source_dir}\n"
            f"(does the plugin run produce logs there yet?)",
            file=sys.stderr,
        )
        # Still return success for an empty dir — useful in scripts.
        # A genuine error (e.g. --file pointed at a missing path) is
        # already a stderr warning above; treat that as non-fatal too.
        return 0

    report = build_report(files, source_dir, args.root)

    if args.quiet:
        sys.stdout.write(render_quiet(report))
    elif args.plain:
        sys.stdout.write(render_plain(report))
    elif args.json:
        json.dump(report, sys.stdout, indent=2, default=str)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(render_markdown(report, args))
    return 0


if __name__ == "__main__":
    sys.exit(main())
