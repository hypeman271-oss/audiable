"""Corpus regression runner.

Hits /api/extract/url and /api/extract against a curated list of
public-domain ebook URLs and files, validates the response shape +
minimum text/sentence counts, exits non-zero on any failure.

Triggered by the freeread.de breakage (silent empty extract → book
view broken downstream). This catches the upstream class of bug for
every URL/file we add to the manifest.

Usage:
    python tests/corpus/runner.py
    python tests/corpus/runner.py --base-url http://localhost:8000
    python tests/corpus/runner.py --key XYZ
    python tests/corpus/runner.py --case gutenberg-tom-sawyer-html

Env vars:
    NARRATIVE_KEY  - bearer token; required unless --key is passed
    NARRATIVE_BASE - base URL; overridden by --base-url
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests

HERE = Path(__file__).parent
MANIFEST = HERE / "manifest.json"
FIXTURES = HERE / "fixtures"
RESULTS = HERE / "results.json"
FAILURES = HERE / "failures.json"

DEFAULT_BASE = "https://narrative-alpha.fly.dev"
# Generous timeouts because some EPUBs are big and Fly cold-starts
# take ~10s if the machine was sleeping.
TIMEOUT_FETCH = 60   # downloading test fixture from upstream
TIMEOUT_EXTRACT = 180  # POSTing to /api/extract


def _load_manifest() -> dict[str, Any]:
    with open(MANIFEST, "r", encoding="utf-8") as f:
        return json.load(f)


def _count_sentences(text: str) -> int:
    """Cheap sentence count. Matches what the client's force-split
    overshoots in the same direction (slight over-count) so the
    min_sentences floor in the manifest works as a reliable signal."""
    # End-of-sentence punctuation followed by whitespace or end.
    # Don't try to be clever — the threshold is a floor, not exact.
    return len(re.findall(r"[.!?](?:\s|$)", text))


def _ensure_fixture(case: dict[str, Any]) -> Path:
    """Download a file case's bytes if not already cached.
    Returns the local path."""
    FIXTURES.mkdir(parents=True, exist_ok=True)
    fmt = case["format"]
    fname = f"{case['id']}.{fmt}"
    path = FIXTURES / fname
    if path.exists() and path.stat().st_size > 0:
        return path
    url = case["download_url"]
    print(f"  fetching {url}", flush=True)
    r = requests.get(url, timeout=TIMEOUT_FETCH, allow_redirects=True, headers={
        # Some sites (notably Standard Ebooks) require a UA.
        "User-Agent": "narrative-corpus-runner/1 (https://narrative-alpha.fly.dev)",
    })
    r.raise_for_status()
    path.write_bytes(r.content)
    return path


def _run_url_case(base: str, key: str, case: dict[str, Any]) -> dict[str, Any]:
    url = f"{base}/api/extract/url"
    headers = {"X-Narrative-Key": key, "Content-Type": "application/json"}
    body = {"url": case["url"]}
    t0 = time.time()
    try:
        resp = requests.post(url, headers=headers, json=body, timeout=TIMEOUT_EXTRACT)
    except requests.RequestException as e:
        return {"ok": False, "reason": f"network: {e}", "elapsed_ms": int((time.time() - t0) * 1000)}
    if resp.status_code != 200:
        return {
            "ok": False,
            "reason": f"HTTP {resp.status_code}",
            "body": resp.text[:300],
            "elapsed_ms": int((time.time() - t0) * 1000),
        }
    try:
        data = resp.json()
    except ValueError as e:
        return {"ok": False, "reason": f"non-JSON: {e}", "elapsed_ms": int((time.time() - t0) * 1000)}
    return _validate(case, data, t0)


def _run_file_case(base: str, key: str, case: dict[str, Any]) -> dict[str, Any]:
    try:
        fixture = _ensure_fixture(case)
    except requests.RequestException as e:
        return {"ok": False, "reason": f"fixture download failed: {e}"}
    url = f"{base}/api/extract"
    headers = {"X-Narrative-Key": key}
    fname = fixture.name
    # Content-Type guess from extension; FastAPI doesn't care for the
    # detection logic, but politeness counts.
    mime = {
        "epub": "application/epub+zip",
        "pdf": "application/pdf",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "md": "text/markdown",
        "txt": "text/plain",
    }.get(case["format"], "application/octet-stream")
    with open(fixture, "rb") as fh:
        t0 = time.time()
        try:
            resp = requests.post(
                url,
                headers=headers,
                files={"file": (fname, fh, mime)},
                timeout=TIMEOUT_EXTRACT,
            )
        except requests.RequestException as e:
            return {"ok": False, "reason": f"network: {e}", "elapsed_ms": int((time.time() - t0) * 1000)}
    if resp.status_code != 200:
        return {
            "ok": False,
            "reason": f"HTTP {resp.status_code}",
            "body": resp.text[:300],
            "elapsed_ms": int((time.time() - t0) * 1000),
        }
    try:
        data = resp.json()
    except ValueError as e:
        return {"ok": False, "reason": f"non-JSON: {e}", "elapsed_ms": int((time.time() - t0) * 1000)}
    return _validate(case, data, t0)


def _validate(case: dict[str, Any], data: dict[str, Any], t0: float) -> dict[str, Any]:
    text = (data.get("text") or "").strip()
    chars = len(text)
    sentences = _count_sentences(text)
    elapsed_ms = int((time.time() - t0) * 1000)
    failures = []
    if chars < case.get("min_chars", 0):
        failures.append(f"chars {chars} < min {case['min_chars']}")
    if sentences < case.get("min_sentences", 0):
        failures.append(f"sentences {sentences} < min {case['min_sentences']}")
    # v225v3.71 (#802): content-level assertions catch silent-empty
    # extracts where char/sentence floors numerically pass but the
    # body is navigation chrome or an error page (the Roy Glashan
    # freeread.de case the user originally hit).
    #
    # content_must_contain — all listed strings must appear
    # content_must_contain_one_of — at least one must appear
    # content_must_not_contain — none of the listed strings may appear
    must = case.get("content_must_contain") or []
    for needle in must:
        if needle not in text:
            failures.append(f"missing required substring {needle!r}")
    any_of = case.get("content_must_contain_one_of") or []
    if any_of and not any(n in text for n in any_of):
        failures.append(f"none of {any_of!r} present")
    forbid = case.get("content_must_not_contain") or []
    for needle in forbid:
        if needle in text:
            failures.append(f"contains forbidden substring {needle!r}")
    return {
        "ok": not failures,
        "reason": "; ".join(failures) if failures else None,
        "chars": chars,
        "sentences": sentences,
        "image_count": len(data.get("images") or []),
        "has_cover": bool(data.get("cover")),
        "elapsed_ms": elapsed_ms,
        "text_head": text[:120],
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base-url", default=os.environ.get("NARRATIVE_BASE", DEFAULT_BASE))
    p.add_argument("--key", default=os.environ.get("NARRATIVE_KEY"))
    p.add_argument("--case", help="Run only this case id (others skipped)")
    p.add_argument("--manifest", default=str(MANIFEST))
    args = p.parse_args()

    if not args.key:
        print("error: pass --key or set NARRATIVE_KEY", file=sys.stderr)
        return 2

    manifest_path = Path(args.manifest)
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    cases = manifest.get("cases", [])
    if args.case:
        cases = [c for c in cases if c["id"] == args.case]
        if not cases:
            print(f"error: no case with id={args.case!r}", file=sys.stderr)
            return 2

    print(f"corpus runner → {args.base_url}  ({len(cases)} cases)")
    print()

    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for case in cases:
        label = f"[{case['id']}] {case.get('source', '')}"
        print(label, flush=True)
        if case["kind"] == "url":
            r = _run_url_case(args.base_url, args.key, case)
        elif case["kind"] == "file":
            r = _run_file_case(args.base_url, args.key, case)
        else:
            r = {"ok": False, "reason": f"unknown kind: {case['kind']}"}
        r["id"] = case["id"]
        results.append(r)
        status = "✓" if r["ok"] else "✗"
        detail = (
            f"chars={r.get('chars')} sentences={r.get('sentences')} "
            f"images={r.get('image_count', 0)} {r.get('elapsed_ms', '?')}ms"
            if r["ok"]
            else r.get("reason", "?")
        )
        print(f"  {status} {detail}", flush=True)
        if not r["ok"]:
            failures.append({**case, "result": r})
        print()

    # Write results + failures for triage.
    with open(RESULTS, "w", encoding="utf-8") as f:
        json.dump({"base_url": args.base_url, "results": results}, f, indent=2)
    if failures:
        with open(FAILURES, "w", encoding="utf-8") as f:
            json.dump({"base_url": args.base_url, "failures": failures}, f, indent=2)

    # Summary.
    total = len(results)
    passed = sum(1 for r in results if r["ok"])
    print(f"summary: {passed}/{total} passed")
    if failures:
        print(f"  failures written to {FAILURES.relative_to(HERE.parent.parent)}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
