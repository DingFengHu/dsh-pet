"""Bounded, read-only notifications from an already-running official Hermes owner.

No ensure/start, activate/resume, approval answers, migration, or raw state/log reads.
Native HTTP tickets are same-user, single-use, purpose='native-http', profile-bound.
Run history is the canonical REST projection (sessions plus script-only executions),
not proof of failure by itself. Only genuine session rows provide a chat target.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import redirect_stderr, redirect_stdout
import io
import hashlib
import json
import logging
import os
from pathlib import Path
import sys
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_BYTES = 2 * 1024 * 1024
MAX_PROFILES = 32
MAX_SESSIONS = 128
MAX_JOBS = 256
MAX_TOTAL_ROWS = 512
RUN_LIMIT = 5


def text(value, limit=256):
    return value[:limit] if isinstance(value, str) else ""


def subset(row, keys):
    return {key: (value[:256] if isinstance(value, str) else value)
            for key in keys if (value := row.get(key)) is None
            or isinstance(value, (str, bool, int, float))}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("redirect_refused")


def native_get(home, endpoint, path, profile):
    """Use the installed issuer and HTTP auth header, never browser credentials."""
    from hermes_cli.gateway_client import _session_ticket
    from hermes_cli.dashboard_auth.native_http import HEADER
    origin = endpoint.api_origin
    parsed = urlsplit(origin)
    if (parsed.scheme not in ("http", "https") or parsed.hostname not in ("127.0.0.1", "::1", "localhost")
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ("", "/")):
        raise ValueError("invalid_origin")
    ticket = _session_ticket(home, endpoint, purpose="native-http")
    url = origin.rstrip("/") + path + ("&" if "?" in path else "?") + urlencode({"profile": profile})
    request = Request(url, headers={HEADER: ticket, "Accept": "application/json"}, method="GET")
    with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=3) as response:
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("response_too_large")
    return json.loads(raw)


async def session_decisions(client, sid, waiting):
    """Passive canonical approvals, supported server requests, then legacy clarify replay."""
    found = {}
    issues = []
    epoch = ""
    gap = False

    def add(rid, method):
        if isinstance(rid, str) and rid:
            if len(found) < 64:
                found.setdefault(text(rid), method)
            else:
                issues.append("limit_reached")

    try:
        approvals = await client.rpc("approval.pending", session_id=sid, _timeout=3)
        pending = approvals.get("approvals")
        if not isinstance(pending, list):
            raise ValueError("invalid_approvals")
        if len(pending) > 64:
            issues.append("limit_reached")
        for item in pending[:64]:
            if isinstance(item, dict):
                add(item.get("request_id"), "approval")
    except Exception:
        issues.append("approval_read_failed")
        gap = True
    try:
        initial = await client.rpc("session.events.since", session_id=sid, last_seen=0, _timeout=3)
        epoch = text(initial.get("replay_epoch"))
        if not epoch:
            raise ValueError("missing_epoch")
        # A missing epoch deliberately returns truncated/events=[] even for an intact ring.
        replay = await client.rpc("session.events.since", session_id=sid, last_seen=0,
                                  replay_epoch=epoch, _timeout=3)
        requests = replay.get("open_requests")
        if not isinstance(requests, list):
            raise ValueError("invalid_requests")
        if len(requests) > 64:
            issues.append("limit_reached")
        for request in requests[:64]:
            # These are server request verbs, NOT arbitrary *.request event names.
            if isinstance(request, dict) and request.get("method") in ("approval", "clarify"):
                add(request.get("id"), request["method"])
        current_epoch = text(replay.get("replay_epoch"))
        replay_gap = (current_epoch != epoch or replay.get("truncated") is not False
                      or replay.get("snapshot_required") is not False)
        # active_list refreshes canonical controls: no waiting means no legacy clarify to reconstruct.
        gap = gap or (replay_gap and waiting)
        epoch = current_epoch or epoch
        events = replay.get("events")
        if not isinstance(events, list) or len(events) > 4096:
            raise ValueError("invalid_events")
        if not replay_gap and waiting:
            pending_clarify = {}
            for event in events:
                if not isinstance(event, dict):
                    continue
                payload = event.get("payload")
                pid = payload.get("prompt_id") if isinstance(payload, dict) else None
                if not isinstance(pid, str) or not pid:
                    continue
                if event.get("type") == "clarify.request":
                    pending_clarify[pid] = True
                elif event.get("type") == "clarify.settled":
                    pending_clarify.pop(pid, None)
            for pid in pending_clarify:
                add(pid, "clarify")
    except Exception:
        issues.append("replay_read_failed")
        gap = True
    if gap:
        issues.append("replay_gap")
        # ponytail: no passive full clarify endpoint; replay gaps stay generic, never attach/resume.
        if waiting and not found:
            stable = hashlib.sha256(json.dumps([sid, epoch]).encode()).hexdigest()[:32]
            add("waiting:" + stable, "waiting")
    return [{"requestId": rid, "method": method} for rid, method in found.items()], issues


async def snapshot():
    from hermes_constants import get_hermes_home, set_hermes_home_override, reset_hermes_home_override
    from hermes_cli.profiles import profiles_to_serve
    from hermes_cli.gateway_runtime import discover_gateway_endpoint
    from hermes_cli.gateway_client import connect_gateway

    out = {"ownerId": "", "baseUrl": "", "profiles": [], "decisions": [],
           "jobs": [], "runs": [], "incomplete": False, "issues": []}

    def issue(profile, stage, code="read_failed"):
        out["incomplete"] = True
        if len(out["issues"]) < 128:
            out["issues"].append({"profile": profile, "stage": stage, "code": code})

    profiles = profiles_to_serve(True, include_standalone=True, include_parked=True)
    if len(profiles) > MAX_PROFILES:
        issue("", "profiles", "limit_reached")
    for name, home in profiles[:MAX_PROFILES]:
        name = text(name)
        record = {"name": name, "available": False, "baseUrl": ""}
        out["profiles"].append(record)
        token = set_hermes_home_override(home)
        try:
            discovery = await asyncio.to_thread(discover_gateway_endpoint, get_hermes_home(), timeout=1)
            endpoint = discovery.endpoint
            if endpoint is None or discovery.state != "ready":
                issue(name, "discovery", "owner_unavailable")
                continue
            record["baseUrl"] = endpoint.api_origin
            if not out["ownerId"]:
                out["ownerId"] = text(endpoint.instance_id)
                out["baseUrl"] = endpoint.api_origin
            # Explicit endpoint is mandatory: the default connect_gateway path may START an owner.
            async with connect_gateway(endpoint=endpoint, max_size=MAX_BYTES) as client:
                await client.rpc("runtime.describe", _timeout=3)
                active = await client.rpc("session.active_list", _timeout=3)
                sessions = active.get("sessions", [])
                if not isinstance(sessions, list):
                    raise ValueError("invalid_sessions")
                if len(sessions) > MAX_SESSIONS:
                    issue(name, "decisions", "limit_reached")
                for session in sessions[:MAX_SESSIONS]:
                    if len(out["decisions"]) >= MAX_TOTAL_ROWS:
                        issue(name, "decisions", "limit_reached")
                        break
                    if not isinstance(session, dict) or not isinstance(session.get("id"), str):
                        continue
                    sid = session["id"]
                    decisions, codes = await session_decisions(client, sid, session.get("status") == "waiting")
                    for code in set(codes):
                        issue(name, "decisions", code)
                    for decision in decisions:
                        if len(out["decisions"]) >= MAX_TOTAL_ROWS:
                            issue(name, "decisions", "limit_reached")
                            break
                        out["decisions"].append({"profile": name, "sessionId": text(sid), **decision})
                record["available"] = True
            try:
                jobs = await asyncio.to_thread(native_get, home, endpoint, "/api/cron/jobs", name)
                if not isinstance(jobs, list):
                    raise ValueError("invalid_jobs")
                if len(jobs) > MAX_JOBS:
                    issue(name, "jobs", "limit_reached")
                for job in jobs[:MAX_JOBS]:
                    if len(out["jobs"]) >= MAX_TOTAL_ROWS:
                        issue(name, "jobs", "limit_reached")
                        break
                    if not isinstance(job, dict) or not isinstance(job.get("id"), str):
                        continue
                    safe = subset(job, ("id", "enabled", "last_status", "last_run_at",
                                        "next_run_at", "failure_streak"))
                    completions = job.get("canonical_completions")
                    safe["canonical_completions"] = ([text(completions[-1])]
                        if isinstance(completions, list) and completions and isinstance(completions[-1], str) else [])
                    safe["profile"] = name
                    failure = job.get("last_failure")
                    safe["last_failure_at"] = text(failure.get("at")) if isinstance(failure, dict) else ""
                    out["jobs"].append(safe)
                    # Only alert candidates need chat resolution. Healthy jobs need no history I/O.
                    if not safe["last_failure_at"] and job.get("last_status") not in ("error", "failed", "delivery_failed", "blocked_config"):
                        continue
                    try:
                        history = await asyncio.to_thread(native_get, home, endpoint,
                            "/api/cron/jobs/" + quote(job["id"], safe="") + "/runs?limit=" + str(RUN_LIMIT), name)
                        rows = history.get("runs", [])
                        if not isinstance(rows, list):
                            raise ValueError("invalid_runs")
                        runs = []
                        for run in rows[:RUN_LIMIT]:
                            if not isinstance(run, dict):
                                continue
                            row = subset(run, ("id", "started_at", "ended_at", "is_active", "scheduler_owned"))
                            row["cron_execution_id"] = text(run.get("cron_execution_id"))
                            rid = text(run.get("id"))
                            row["sessionId"] = rid if rid and not rid.startswith("cron_output:") else None
                            runs.append(row)
                        out["runs"].append({"profile": name, "jobId": text(job["id"]), "runs": runs})
                    except Exception:
                        issue(name, "runs")
            except Exception:
                issue(name, "jobs")
        except Exception:
            issue(name, "gateway")
        finally:
            reset_hermes_home_override(token)
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-root", required=True, type=Path)
    parser.add_argument("--home", type=Path, default=None)
    args = parser.parse_args()
    # Never print supplied paths or exception text: either may include credentials.
    if not args.hermes_root.is_absolute() or not (args.hermes_root / "hermes_constants.py").is_file():
        print('{"incomplete":true,"code":"invalid_hermes_root"}')
        return 1
    if args.home is not None:
        if not args.home.is_absolute() or not args.home.is_dir():
            print('{"incomplete":true,"code":"invalid_home"}')
            return 1
        os.environ["HERMES_HOME"] = str(args.home)
    sys.path.insert(0, str(args.hermes_root))
    sys.dont_write_bytecode = True
    logging.disable(logging.CRITICAL)
    try:
        # Imported libraries sometimes log configuration warnings. Nothing raw leaves this helper.
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            result = asyncio.run(bounded_snapshot())
    except Exception:
        result = {"ownerId": "", "baseUrl": "", "profiles": [], "decisions": [],
                  "jobs": [], "runs": [], "incomplete": True, "code": "snapshot_failed"}
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":"), allow_nan=False))
    return 0


async def bounded_snapshot():
    async with asyncio.timeout(40):
        return await snapshot()


if __name__ == "__main__":
    raise SystemExit(main())
