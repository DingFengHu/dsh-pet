/** Hermes helper 契约、安全深链及不可猜测的 cron 运行映射回归。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertView, foldSnapshot, makeAlertId, snapshotSchema, type HermesDisk } from './hermes-policy.ts';

const disk = (): HermesDisk => ({ stateVersion: 1, dismissed: [], pending: [], baselineProfiles: ['default'] });
const snapshot = (extra: Record<string, unknown> = {}) =>
  snapshotSchema.parse({
    profiles: [{ name: 'default', available: true }],
    decisions: [],
    jobs: [],
    runs: [],
    incomplete: false,
    ...extra,
  });
const job = {
  profile: 'default',
  id: 'job-1',
  last_status: 'error',
  last_failure_at: '2026-11-05T12:00:00Z',
  last_run_at: '2026-11-05T12:00:00Z',
  canonical_completions: ['execution-1'],
};
const runs = [
  { profile: 'default', jobId: 'job-1', runs: [{ sessionId: 'session-1', cron_execution_id: 'execution-1' }] },
];

test('只接受 canonical approval.pending/open_requests 的 bare approval 和 clarify', () => {
  const methods = [
    'approval',
    'clarify',
    'approval.request',
    'clarify.request',
    'terminal.read',
    'waiting',
    'xapproval',
  ];
  const next = foldSnapshot(
    disk(),
    snapshot({
      decisions: methods.map((method) => ({ profile: 'default', sessionId: 'session-1', requestId: method, method })),
    }),
  );
  assert.deepEqual(
    new Set(next.pending.map((entry) => entry.id)),
    new Set(methods.slice(0, 2).map((method) => makeAlertId('decision', ['default', 'session-1', method]))),
  );
});

test('真实等待但重放缺口用稳定泛化提醒，缺口恢复后清除，不接收无证据 waiting', () => {
  const decision = {
    profile: 'default',
    sessionId: 'session-1',
    requestId: 'waiting:' + 'a'.repeat(32),
    method: 'waiting',
  };
  const gap = snapshot({
    decisions: [decision],
    incomplete: true,
    issues: [{ profile: 'default', stage: 'decisions', code: 'replay_gap' }],
  });
  const first = foldSnapshot(disk(), gap);
  assert.equal(first.pending.length, 1);
  assert.equal(foldSnapshot(first, gap).pending[0]!.id, first.pending[0]!.id);
  assert.equal(foldSnapshot(first, snapshot()).pending.length, 0);
  assert.equal(foldSnapshot(disk(), snapshot({ decisions: [decision] })).pending.length, 0);
});

test('sticky agent failure 不吞掉后续 delivery_failed 或 blocked_config，不论旧失败是否已确认', () => {
  const first = foldSnapshot(disk(), snapshot({ jobs: [job] }));
  for (const acknowledged of [false, true]) {
    const previous = acknowledged ? { ...first, dismissed: [first.pending[0]!.id], pending: [] } : first;
    for (const status of ['delivery_failed', 'blocked_config']) {
      const next = foldSnapshot(
        previous,
        snapshot({ jobs: [{ ...job, last_status: status, last_run_at: '2026-11-05T13:00:00Z' }] }),
      );
      assert.equal(next.pending.length, acknowledged ? 1 : 2);
      assert.ok(next.pending.some((entry) => entry.id !== first.pending[0]!.id));
    }
  }
  assert.equal(
    foldSnapshot(
      disk(),
      snapshot({ jobs: [{ ...job, last_failure_at: '', last_run_at: '', last_status: 'blocked_config' }] }),
    ).pending.length,
    0,
  );
});

test('cron 仅用同一失败时间及 canonical execution ID 精确映射，不能选首个成功 session', () => {
  const exact = foldSnapshot(disk(), snapshot({ jobs: [job], runs }));
  assert.equal(alertView(exact.pending[0]!).url, 'hermes://open/session-1');
  const laterSuccess = snapshot({ jobs: [{ ...job, last_run_at: '2026-11-05T13:00:00Z', last_status: 'ok' }] });
  assert.equal(alertView(foldSnapshot(exact, laterSuccess).pending[0]!).url, 'hermes://open/session-1');
  for (const changed of [
    { jobs: [{ ...job, last_run_at: '2026-11-05T13:00:00Z', last_status: 'ok' }], runs },
    {
      jobs: [{ ...job, last_run_at: '2026-11-05T13:00:00Z', last_status: 'ok', canonical_completions: ['success'] }],
      runs: [{ ...runs[0], runs: [{ sessionId: 'unrelated-success', cron_execution_id: 'success' }] }],
    },
    { jobs: [{ ...job, canonical_completions: ['execution-1', 'other'] }], runs },
    { jobs: [job], runs: [{ ...runs[0], runs: [...runs[0]!.runs, ...runs[0]!.runs] }] },
    { jobs: [{ ...job, canonical_completions: [] }], runs },
    { jobs: [{ ...job, canonical_completions: ['other'] }], runs },
    { jobs: [job], runs: [{ ...runs[0], runs: [{ sessionId: 'unrelated-success' }] }] },
    {
      jobs: [job],
      runs: [{ ...runs[0], runs: [{ sessionId: 'cron_output:job-1', cron_execution_id: 'execution-1' }] }],
    },
  ]) {
    assert.equal(alertView(foldSnapshot(disk(), snapshot(changed)).pending[0]!).url, undefined);
  }
  const mixed = [
    { ...runs[0], runs: [{ sessionId: 'unrelated-success', cron_execution_id: 'other' }, ...runs[0]!.runs] },
  ];
  assert.equal(
    alertView(foldSnapshot(disk(), snapshot({ jobs: [job], runs: mixed })).pending[0]!).url,
    'hermes://open/session-1',
  );
});

test('深链仅允许 default profile 与安全 stored ID，持久化旧行也不能绕过', () => {
  const first = foldSnapshot(disk(), snapshot({ jobs: [job], runs })).pending[0]!;
  assert.ok(first.kind !== 'huniu');
  const entry = first;
  assert.equal(alertView({ ...entry, profile: 'work' }).url, undefined);
  for (const sessionId of ['../secret', 'a/b', 'a\\b', 'a:b', 'a..b', 'session.id', '%2f', '']) {
    assert.equal(alertView({ ...entry, sessionId }).url, undefined);
  }
  assert.equal(alertView({ ...entry, sessionId: 'valid_ID-123' }).url, 'hermes://open/valid_ID-123');
});

test('首次基线 tombstone 达到上限时 fail closed，不截断旧 tombstone', () => {
  const previous = {
    ...disk(),
    baselineProfiles: [],
    dismissed: Array.from({ length: 2048 }, (_, index) => makeAlertId('cron', [String(index)])),
  };
  assert.throws(() => foldSnapshot(previous, snapshot({ jobs: [job] })));
  assert.equal(previous.dismissed.length, 2048);
});
