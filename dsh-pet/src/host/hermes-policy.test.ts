/** Hermes helper 契约、安全深链及不可猜测的 cron 运行映射回归。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alertView,
  CRON_FALLBACK,
  DECISION_FALLBACK,
  diskSchema,
  foldSnapshot,
  makeAlertId,
  snapshotSchema,
  type HermesDisk,
} from './hermes-policy.ts';

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

test('等待处理的提醒与 Claude 同款：标题带对话名和要做的事，正文是问题或审批原文', () => {
  const decision = (method: string, extra: Record<string, unknown> = {}) => ({
    profile: 'default',
    sessionId: 'session-1',
    requestId: method,
    method,
    ...extra,
  });
  const next = foldSnapshot(
    disk(),
    snapshot({
      decisions: [
        decision('approval', { title: '发布计划', text: '删除构建目录\r\nrm -rf build' }),
        decision('clarify', { title: '  ', text: '选哪个方案？\n何时发布？' }),
      ],
    }),
  );
  const shown = new Map(next.pending.map((entry) => [entry.id, alertView(entry)]));
  assert.deepEqual(
    ['approval', 'clarify'].map((method) => {
      const view = shown.get(makeAlertId('decision', ['default', 'session-1', method]))!;
      return [view.title, view.message, view.url];
    }),
    [
      ['Hermes 中“发布计划”的这个任务需要你批准', '删除构建目录\nrm -rf build', 'hermes://open/session-1'],
      ['Hermes 中“未命名”的这个任务需要你决定', '选哪个方案？\n何时发布？', 'hermes://open/session-1'],
    ],
  );
  // 同一请求后来读到正文就补上；标题、正文超长截断，不让整份状态过不了校验。
  const bare = foldSnapshot(disk(), snapshot({ decisions: [decision('clarify')] }));
  assert.equal(bare.pending[0]!.message, DECISION_FALLBACK);
  const filled = foldSnapshot(
    bare,
    snapshot({ decisions: [decision('clarify', { title: '题'.repeat(500), text: '问'.repeat(2000) })] }),
  );
  assert.equal(filled.pending.length, 1);
  assert.equal(filled.pending[0]!.id, bare.pending[0]!.id);
  assert.equal(filled.pending[0]!.message, '问'.repeat(1199) + '…');
  assert.ok(filled.pending[0]!.title.length <= 200);
  assert.ok(filled.pending[0]!.title.endsWith('…”的这个任务需要你决定'));
});

test('定时任务失败与 Claude 同款：标题带任务名，正文是 Hermes 记录的失败原因', () => {
  const named = { ...job, name: '字幕日更', failure_detail: '<@819671906382643210>\n来源被拦 **BLOCKED_SOURCE**' };
  const first = foldSnapshot(disk(), snapshot({ jobs: [named], runs }));
  assert.deepEqual(
    [first.pending[0]!.title, first.pending[0]!.message],
    ['Hermes 定时任务失败 · 字幕日更', '来源被拦 **BLOCKED_SOURCE**'],
  );
  // 投递失败、配置被拦用各自那次运行的错误，不拿旧的 agent 失败原因顶替。
  const delivery = foldSnapshot(
    disk(),
    snapshot({
      jobs: [
        {
          ...named,
          last_failure_at: '',
          last_status: 'delivery_failed',
          last_error: 'agent 错误',
          last_delivery_error: 'Discord 403',
        },
      ],
    }),
  );
  assert.equal(delivery.pending[0]!.message, 'Discord 403');
  // 配置被拦的那次运行同时记了同时间戳的 sticky failure：只提醒一条，并去掉 Hermes 的控制标记。
  const blocked = foldSnapshot(
    disk(),
    snapshot({
      jobs: [
        {
          ...named,
          last_status: 'blocked_config',
          failure_detail: "[blocked_config:silent] delivery platform 'weixin' has no credentials",
          last_error: "[blocked_config:silent] delivery platform 'weixin' has no credentials",
        },
      ],
    }),
  );
  assert.deepEqual(
    blocked.pending.map((entry) => entry.message),
    ["delivery platform 'weixin' has no credentials"],
  );
  // 截断不切开 emoji。
  const emoji = foldSnapshot(disk(), snapshot({ jobs: [{ ...job, name: 'a'.repeat(78) + '😀' + 'b'.repeat(10) }] }));
  assert.equal(emoji.pending[0]!.title, `Hermes 定时任务失败 · ${'a'.repeat(78)}…`);
  // 没有任务名、没有原因时退回原来的泛化文案。
  const bare = foldSnapshot(disk(), snapshot({ jobs: [job], runs }));
  assert.deepEqual([bare.pending[0]!.title, bare.pending[0]!.message], ['Hermes 定时任务失败', CRON_FALLBACK]);
  // 升级前留下的固定文案在下一轮快照补成原文，id 与会话链接不变；读不到原因时不把已有原文冲掉。
  const upgraded = foldSnapshot(bare, snapshot({ jobs: [named] }));
  assert.equal(upgraded.pending.length, 1);
  assert.deepEqual(
    [upgraded.pending[0]!.id, upgraded.pending[0]!.title, upgraded.pending[0]!.message],
    [bare.pending[0]!.id, 'Hermes 定时任务失败 · 字幕日更', '来源被拦 **BLOCKED_SOURCE**'],
  );
  assert.equal(alertView(upgraded.pending[0]!).url, 'hermes://open/session-1');
  assert.deepEqual(foldSnapshot(upgraded, snapshot({ jobs: [job] })).pending, upgraded.pending);
  // 只读到任务名、没读到原因：标题补上名字，正文保持兜底文案。
  const nameOnly = foldSnapshot(bare, snapshot({ jobs: [{ ...job, name: '字幕日更' }] }));
  assert.deepEqual(
    [nameOnly.pending[0]!.title, nameOnly.pending[0]!.message],
    ['Hermes 定时任务失败 · 字幕日更', CRON_FALLBACK],
  );
});

test('旧版固定文案的状态文件仍能读入', () => {
  const id = makeAlertId('decision', ['default', 'session-1', 'old']);
  const legacy = {
    stateVersion: 1,
    dismissed: [],
    pending: [{ id, profile: 'default', kind: 'decision', title: 'Hermes 需要你确认', message: DECISION_FALLBACK }],
    baselineProfiles: ['default'],
  };
  assert.equal(diskSchema.parse(legacy).pending[0]!.title, 'Hermes 需要你确认');
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
  assert.deepEqual(
    [first.pending[0]!.title, first.pending[0]!.message],
    ['Hermes 中“未命名”的这个任务需要你处理', DECISION_FALLBACK],
  );
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
  assert.ok(first.kind === 'decision' || first.kind === 'cron');
  const entry = first;
  assert.equal(alertView({ ...entry, profile: 'work' }).url, undefined);
  for (const sessionId of ['../secret', 'a/b', 'a\\b', 'a:b', 'a..b', 'session.id', '%2f', '']) {
    assert.equal(alertView({ ...entry, sessionId }).url, undefined);
  }
  assert.equal(alertView({ ...entry, sessionId: 'valid_ID-123' }).url, 'hermes://open/valid_ID-123');
});

test('DSH 提醒的查看对话固定打开 dsh://open，Claude / Windows 提醒仍无链接', () => {
  const base = { profile: 'default' as const, title: 't', message: 'm', at: 1, session: 'session-x' };
  for (const kind of ['dsh', 'dsh-fail'] as const) {
    assert.equal(alertView({ ...base, id: makeAlertId(kind, ['dsh', 'k']), kind }).url, 'dsh://open');
  }
  for (const kind of ['claude', 'claude-fail', 'win-fail'] as const) {
    assert.equal(alertView({ ...base, id: makeAlertId(kind, ['x', 'k']), kind }).url, undefined);
  }
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
