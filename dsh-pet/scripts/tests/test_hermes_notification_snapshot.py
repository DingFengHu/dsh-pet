"""Run with installed Hermes Python: this_file --hermes-root ABSOLUTE_CHECKOUT."""
import argparse
import asyncio
from contextlib import asynccontextmanager
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--hermes-root", required=True)
args, remaining = parser.parse_known_args()
sys.argv = [sys.argv[0], *remaining]
sys.dont_write_bytecode = True
sys.path.insert(0, args.hermes_root)
# Actual installed official imports, only transport/storage results are faked below.
from hermes_cli import gateway_client, gateway_runtime, profiles
from hermes_constants import get_hermes_home
from gateway.session_events import SessionEvents

spec = importlib.util.spec_from_file_location("notification_snapshot",
    Path(__file__).resolve().parents[1] / "hermes-notification-snapshot.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class SnapshotTests(unittest.TestCase):
    def test_read_only_flow_and_projection(self):
        calls = []
        endpoint = SimpleNamespace(api_origin="http://127.0.0.1:9120", instance_id="owner")
        home = Path(args.hermes_root).parent.resolve()

        class Client:
            async def rpc(self, method, **params):
                calls.append((method, params))
                self_check = {"runtime.describe", "session.active_list", "session.events.since", "approval.pending"}
                if method not in self_check:
                    raise AssertionError("write RPC")
                if method == "session.active_list":
                    return {"sessions": [{"id": "local-1", "title": "DO_NOT_EXPORT", "status": "working"}]}
                if method == "approval.pending":
                    return {"approvals": [{"request_id": "ordinary-1", "command": "DO_NOT_EXPORT",
                                           "description": "DO_NOT_EXPORT", "choices": ["once"]}]}
                if method == "session.events.since":
                    replaying = params.get("replay_epoch") == "epoch-1"
                    return {"replay_epoch": "epoch-1", "truncated": not replaying,
                            "snapshot_required": not replaying, "latest_seq": 1,
                            "events": [{"type": "tool.result", "payload": {"secret": "DO_NOT_EXPORT"}}] if replaying else [],
                            "open_requests": [
                                {"id": "srq-1", "method": "clarify", "params": {"secret": "DO_NOT_EXPORT"}},
                                *[{"id": "spoof-" + method, "method": method, "params": {"secret": "DO_NOT_EXPORT"}}
                                  for method in ("approval.request", "clarify.request", "evil.request", "terminal.read", "theme")]]}
                return {}

        @asynccontextmanager
        async def connect(*, endpoint, max_size):
            self.assertEqual(get_hermes_home(), home)
            self.assertEqual(endpoint.api_origin, "http://127.0.0.1:9120")
            yield Client()

        def get(bound_home, bound_endpoint, path, profile):
            self.assertEqual(bound_home, home)
            self.assertEqual(profile, "default")
            if path == "/api/cron/jobs":
                return [{"id": "job-1", "name": "DO_NOT_EXPORT", "last_status": "ok", "prompt": "DO_NOT_EXPORT",
                         "canonical_completions": ["DO_NOT_EXPORT", "exact-completion"],
                         "last_failure": {"at": "2026-11-05T20:00:00Z", "detail": "DO_NOT_EXPORT"}}]
            return {"runs": [{"id": "local-cron", "cron_execution_id": "exact-completion", "started_at": 1, "error": "DO_NOT_EXPORT"},
                             {"id": "cron_output:job-1:exec:2", "cron_execution_id": "exec:2", "title": "DO_NOT_EXPORT"}]}

        with patch.object(profiles, "profiles_to_serve", return_value=[("default", home)]), \
             patch.object(gateway_runtime, "discover_gateway_endpoint", return_value=SimpleNamespace(state="ready", endpoint=endpoint)), \
             patch.object(gateway_client, "connect_gateway", connect), \
             patch.object(helper, "native_get", get):
            result = asyncio.run(helper.bounded_snapshot())
        self.assertFalse(result["incomplete"])
        self.assertEqual(result["decisions"], [
            {"profile": "default", "sessionId": "local-1", "requestId": "ordinary-1", "method": "approval"},
            {"profile": "default", "sessionId": "local-1", "requestId": "srq-1", "method": "clarify"}])
        self.assertEqual(result["jobs"][0]["canonical_completions"], ["exact-completion"])
        self.assertEqual([r["cron_execution_id"] for r in result["runs"][0]["runs"]], ["exact-completion", "exec:2"])
        self.assertEqual(result["jobs"][0]["last_failure_at"], "2026-11-05T20:00:00Z")
        self.assertEqual([r["sessionId"] for r in result["runs"][0]["runs"]], ["local-cron", None])
        self.assertNotIn("DO_NOT_EXPORT", json.dumps(result))
        self.assertEqual([c[0] for c in calls], ["runtime.describe", "session.active_list", "approval.pending",
                                                "session.events.since", "session.events.since"])
        self.assertEqual(calls[-1][1], {"session_id": "local-1", "last_seen": 0,
                                       "replay_epoch": "epoch-1", "_timeout": 3})

    def decision_read(self, *, events=(), requests=(), approvals=(), waiting=True,
                      truncated=False, reset=False, latest_seq=1, sid="local-1", epoch="epoch-1"):
        calls = []
        class Client:
            async def rpc(self, method, **params):
                calls.append((method, params))
                if method == "approval.pending":
                    return {"approvals": list(approvals)}
                if method != "session.events.since":
                    raise AssertionError("non-passive RPC")
                replaying = "replay_epoch" in params
                return {"replay_epoch": "reset-epoch" if reset and replaying else epoch,
                        "truncated": truncated or not replaying,
                        "snapshot_required": truncated or not replaying,
                        "latest_seq": latest_seq, "open_requests": list(requests),
                        "events": list(events) if replaying else []}
        result = asyncio.run(helper.session_decisions(Client(), sid, waiting))
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[-1][1]["replay_epoch"], epoch)
        return result

    def test_installed_replay_function_with_fake_transport(self):
        stream = SessionEvents()
        stream.publish("local", {"prompt_id": "settled", "question": "DO_NOT_EXPORT"}, event_type="clarify.request")
        stream.publish("local", {"prompt_id": "settled"}, event_type="clarify.settled")
        stream.publish("local", {"prompt_id": "live", "question": "DO_NOT_EXPORT"}, event_type="clarify.request")
        initial = stream.since(None, 0)
        self.assertTrue(initial["truncated"])
        self.assertEqual(initial["events"], [])
        self.assertFalse(stream.since(initial["replay_epoch"], 0)["truncated"])
        class Client:
            async def rpc(self, method, **params):
                if method == "approval.pending":
                    return {"approvals": [{"request_id": "ordinary", "command": "DO_NOT_EXPORT"}]}
                if method != "session.events.since":
                    raise AssertionError("write RPC")
                return {**stream.since(params.get("replay_epoch"), params["last_seen"]), "open_requests": []}
        rows, issues = asyncio.run(helper.session_decisions(Client(), "local", True))
        self.assertEqual(rows, [{"requestId": "ordinary", "method": "approval"},
                                {"requestId": "live", "method": "clarify"}])
        self.assertEqual(issues, [])
        self.assertNotIn("DO_NOT_EXPORT", json.dumps(rows))

    def test_legacy_clarify_request_and_settlement(self):
        event = lambda kind, pid: {"type": kind, "payload": {"prompt_id": pid, "question": "DO_NOT_EXPORT"}}
        events = [event("clarify.request", "gone"), event("clarify.settled", "gone"),
                  event("clarify.request", "bare-prompt")]
        rows, issues = self.decision_read(events=events)
        self.assertEqual(rows, [{"requestId": "bare-prompt", "method": "clarify"}])
        self.assertEqual(issues, [])
        self.assertNotIn("DO_NOT_EXPORT", json.dumps(rows))
        self.assertEqual(self.decision_read(events=events, waiting=False), ([], []))
        self.assertEqual(self.decision_read(events=events[:2]), ([], []))

    def test_gap_fallback_stable_across_sequences_and_reset(self):
        rows, issues = self.decision_read(truncated=True, latest_seq=10)
        self.assertEqual(rows[0]["method"], "waiting")
        self.assertIn("replay_gap", issues)
        self.assertEqual(rows, self.decision_read(truncated=True, latest_seq=999)[0])
        self.assertNotEqual(rows, self.decision_read(truncated=True, sid="another")[0])
        self.assertNotEqual(rows, self.decision_read(truncated=True, epoch="another")[0])
        # An idle/working session's old history gap cannot keep another session's resolved alert alive.
        self.assertEqual(self.decision_read(truncated=True, waiting=False), ([], []))
        reset_rows, reset_issues = self.decision_read(reset=True)
        self.assertEqual(reset_rows[0]["method"], "waiting")
        self.assertIn("replay_gap", reset_issues)
        # Do not fabricate legacy IDs out of an incomplete ring or duplicate known decisions.
        event = {"type": "clarify.request", "payload": {"prompt_id": "stale"}}
        self.assertEqual(self.decision_read(events=[event], truncated=True)[0], rows)
        for kwargs, expected in [({"approvals": [{"request_id": "approval-id"}]}, "approval"),
                                 ({"requests": [{"id": "server-id", "method": "clarify"}]}, "clarify")]:
            known, warnings = self.decision_read(truncated=True, **kwargs)
            self.assertEqual(len(known), 1)
            self.assertEqual(known[0]["method"], expected)
            self.assertIn("replay_gap", warnings)

    def test_bounded_ids_and_independent_reads(self):
        rows, issues = self.decision_read(approvals=[{"request_id": "a" * 300}])
        self.assertEqual(rows, [{"requestId": "a" * 256, "method": "approval"}])
        self.assertEqual(issues, [])
        class Client:
            async def rpc(self, method, **params):
                if method == "approval.pending":
                    raise ValueError("DO_NOT_EXPORT")
                if method != "session.events.since":
                    raise AssertionError("write RPC")
                return {"replay_epoch": "epoch", "truncated": False, "snapshot_required": False,
                        "open_requests": [], "events": [
                            {"type": "clarify.request", "payload": {"prompt_id": "known-clarify"}}]}
        rows, issues = asyncio.run(helper.session_decisions(Client(), "session", True))
        self.assertEqual(rows, [{"requestId": "known-clarify", "method": "clarify"}])
        self.assertIn("approval_read_failed", issues)
        self.assertNotIn("DO_NOT_EXPORT", json.dumps([rows, issues]))

    def test_replay_gap_marks_snapshot_incomplete(self):
        endpoint = SimpleNamespace(api_origin="http://127.0.0.1:9120", instance_id="owner")
        home = Path(args.hermes_root).parent.resolve()
        class Client:
            async def rpc(self, method, **params):
                if method == "runtime.describe":
                    return {}
                if method == "session.active_list":
                    return {"sessions": [{"id": "waiting-session", "status": "waiting", "title": "DO_NOT_EXPORT"}]}
                if method == "approval.pending":
                    return {"approvals": []}
                if method == "session.events.since":
                    return {"replay_epoch": "epoch", "truncated": True, "snapshot_required": True,
                            "open_requests": [], "events": [], "latest_seq": 100}
                raise AssertionError("write RPC")
        @asynccontextmanager
        async def connect(**kwargs):
            yield Client()
        with patch.object(profiles, "profiles_to_serve", return_value=[("default", home)]), \
             patch.object(gateway_runtime, "discover_gateway_endpoint", return_value=SimpleNamespace(state="ready", endpoint=endpoint)), \
             patch.object(gateway_client, "connect_gateway", connect), \
             patch.object(helper, "native_get", return_value=[]):
            result = asyncio.run(helper.bounded_snapshot())
        self.assertTrue(result["incomplete"])
        self.assertEqual(result["issues"], [{"profile": "default", "stage": "decisions", "code": "replay_gap"}])
        self.assertEqual(result["decisions"][0]["method"], "waiting")
        self.assertNotIn("DO_NOT_EXPORT", json.dumps(result))

    def test_unavailable_never_connects(self):
        with patch.object(profiles, "profiles_to_serve", return_value=[("default", Path(args.hermes_root))]), \
             patch.object(gateway_runtime, "discover_gateway_endpoint", return_value=SimpleNamespace(state="absent", endpoint=None)), \
             patch.object(gateway_client, "connect_gateway") as connect:
            result = asyncio.run(helper.bounded_snapshot())
        connect.assert_not_called()
        self.assertTrue(result["incomplete"])
        self.assertEqual(result["issues"][0]["code"], "owner_unavailable")

    def test_http_uses_distinct_profile_bound_native_ticket(self):
        requests = []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size):
                self_size = helper.MAX_BYTES + 1
                if size != self_size: raise AssertionError("unbounded read")
                return b'[]'
        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                if timeout != 3: raise AssertionError("unbounded time")
                return Response()
        home = Path(args.hermes_root)
        endpoint = SimpleNamespace(api_origin="http://127.0.0.1:9120")
        with patch.object(gateway_client, "_session_ticket", return_value="PRIVATE_TICKET") as ticket, \
             patch.object(helper, "build_opener", return_value=Opener()):
            self.assertEqual(helper.native_get(home, endpoint, "/api/cron/jobs", "my profile"), [])
        ticket.assert_called_once_with(home, endpoint, purpose="native-http")
        request = requests[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("X-hermes-gateway-ticket"), "PRIVATE_TICKET")
        self.assertTrue(request.full_url.endswith("?profile=my+profile"))
        self.assertNotIn("PRIVATE_TICKET", request.full_url)

    def test_no_credential_redirect_or_remote_origin(self):
        with self.assertRaises(ValueError):
            helper.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere/")
        with patch.object(gateway_client, "_session_ticket") as ticket:
            with self.assertRaises(ValueError):
                helper.native_get(Path(args.hermes_root), SimpleNamespace(api_origin="https://example.com"),
                                  "/api/cron/jobs", "default")
        ticket.assert_not_called()


if __name__ == "__main__":
    unittest.main()
