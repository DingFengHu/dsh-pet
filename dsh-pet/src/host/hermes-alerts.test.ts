/** Hermes 提醒的去重、持久化、局部降级与本地确认回归。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHermesAlerts } from './hermes-alerts.ts';
import { PollStateStore } from './state.ts';
import { handleHermesRoutes } from './routes/hermes.ts';
import { makeAlertId, snapshotSchema } from './hermes-policy.ts';
import type { PetRouteDeps } from './routes/types.ts';

const snapshot = (extra: Record<string, unknown> = {}) => ({
  profiles: [{ name: 'default', available: true }],
  decisions: [{ profile: 'default', sessionId: 'local-1', requestId: 'req-1', method: 'approval' }],
  jobs: [],
  runs: [],
  incomplete: false,
  issues: [],
  ...extra,
});
const job = (at: string, status = 'error') => ({
  profile: 'default',
  id: 'job-1',
  last_status: status,
  last_failure_at: at,
});
const view = (state: PollStateStore) =>
  state.read().sections.hermesAlerts.data as {
    alerts: { id: string; title: string; message: string; url?: string }[];
    stale: boolean;
    error?: string;
  };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-hermes-'));
  const state = new PollStateStore();
  const file = join(dir, 'hermes.json');
  const alerts = createHermesAlerts({ file, state, petId: () => 'main' });
  await alerts.initialize();
  return { dir, file, state, alerts };
}

test('重复快照不推进 counter，确认落盘后抑制旧 id，新请求仍提醒', async () => {
  const { dir, file, state, alerts } = await fixture();
  try {
    await alerts.accept(snapshot());
    const id = view(state).alerts[0]!.id;
    assert.equal(view(state).alerts[0]!.url, 'hermes://open/local-1');
    const counter = state.read().counter;
    await alerts.accept(snapshot());
    await alerts.accept(snapshot({ decisions: [...snapshot().decisions, ...snapshot().decisions] }));
    assert.equal(view(state).alerts.length, 1);
    assert.equal(state.read().counter, counter);
    assert.equal(await alerts.ack(id), true);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).dismissed[0], id);
    assert.equal(await alerts.ack(id), false);
    await alerts.accept(snapshot());
    assert.deepEqual(view(state).alerts, []);
    const restarted = createHermesAlerts({ file, state, petId: () => 'main' });
    await restarted.accept(snapshot());
    assert.deepEqual(view(state).alerts, []);
    await restarted.accept(
      snapshot({
        decisions: [{ profile: 'default', sessionId: 'local-1', requestId: 'req-2', method: 'approval' }],
      }),
    );
    assert.notEqual(view(state).alerts[0]!.id, id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cron 初始历史不提醒，后续失败 sticky 跨成功与重启直到确认，新运行重新提醒', async () => {
  const { dir, file, state, alerts } = await fixture();
  try {
    await alerts.accept(snapshot({ decisions: [], jobs: [job('old')] }));
    assert.deepEqual(view(state).alerts, []);
    await alerts.accept(snapshot({ jobs: [job('new')] }));
    assert.equal(view(state).alerts.length, 2);
    assert.equal(view(state).alerts[0]!.title, 'Hermes 需要你确认');
    const cronId = view(state).alerts[1]!.id;
    await alerts.accept(snapshot({ decisions: [], jobs: [job('new', 'ok')] }));
    assert.equal(view(state).alerts[0]!.id, cronId);
    const restarted = createHermesAlerts({ file, state, petId: () => 'main' });
    await restarted.initialize();
    assert.equal(view(state).alerts[0]!.id, cronId);
    await restarted.ack(cronId);
    await restarted.accept(snapshot({ decisions: [], jobs: [job('new', 'ok')] }));
    assert.deepEqual(view(state).alerts, []);
    await restarted.accept(snapshot({ decisions: [], jobs: [job('newer')] }));
    assert.notEqual(view(state).alerts[0]!.id, cronId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('离线和部分决策失败保留旧行，jobs 失败不阻止成功决策清空', async () => {
  const { dir, state, alerts } = await fixture();
  try {
    await alerts.accept(snapshot());
    alerts.offline();
    assert.equal(view(state).stale, true);
    assert.equal(view(state).alerts.length, 1);
    await alerts.accept(
      snapshot({
        decisions: [],
        incomplete: true,
        issues: [{ profile: 'default', stage: 'decisions', code: 'read_failed' }],
      }),
    );
    assert.equal(view(state).alerts.length, 1);
    await alerts.accept(
      snapshot({
        decisions: [],
        incomplete: true,
        issues: [{ profile: 'default', stage: 'jobs', code: 'read_failed' }],
      }),
    );
    assert.equal(view(state).alerts.length, 0);
    assert.equal(view(state).stale, true);
    await alerts.accept(snapshot());
    await alerts.accept(
      snapshot({ profiles: [{ name: 'default', available: false }], decisions: [], incomplete: true }),
    );
    assert.equal(view(state).alerts.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写盘失败不假确认、不清空可见提醒', async () => {
  const { dir, file, state, alerts } = await fixture();
  try {
    await alerts.accept(snapshot());
    const failing = createHermesAlerts({
      file,
      state,
      petId: () => 'main',
      persist: async () => {
        throw new Error('disk full');
      },
    });
    await failing.initialize();
    const id = view(state).alerts[0]!.id;
    await assert.rejects(failing.ack(id));
    assert.equal(view(state).alerts[0]!.id, id);
    assert.equal(view(state).error, 'state-persist-failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('损坏状态可见失败且不覆盖原文件，快照不接受无界结构', async () => {
  const { dir, file, state } = await fixture();
  try {
    await writeFile(file, 'broken');
    const alerts = createHermesAlerts({ file, state, petId: () => 'main' });
    await alerts.accept(snapshot());
    assert.equal(view(state).error, 'state-load-failed');
    assert.equal(await readFile(file, 'utf8'), 'broken');
    assert.equal(snapshotSchema.safeParse(snapshot({ decisions: Array(513).fill({}) })).success, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('2048 tombstone 不逐出旧确认，容量满时新确认拒绝且提醒保留', async () => {
  const { dir, file, state } = await fixture();
  try {
    const oldId = makeAlertId('decision', ['default', 'local-1', 'req-1']);
    const dismissed = [oldId, ...Array.from({ length: 2047 }, (_, index) => makeAlertId('cron', [String(index)]))];
    const initial = { stateVersion: 1, dismissed, pending: [], baselineProfiles: ['default'] };
    await writeFile(file, JSON.stringify(initial));
    const alerts = createHermesAlerts({ file, state, petId: () => 'main' });
    await alerts.accept(snapshot());
    assert.deepEqual(view(state).alerts, []);
    const active = { profile: 'default', sessionId: 'local-1', requestId: 'new', method: 'clarify' };
    await alerts.accept(snapshot({ decisions: [...snapshot().decisions, active] }));
    assert.equal(view(state).alerts.length, 1);
    const id = view(state).alerts[0]!.id;
    const before = await readFile(file, 'utf8');
    await assert.rejects(alerts.ack(id));
    assert.equal(view(state).alerts[0]!.id, id);
    assert.equal(view(state).error, 'state-capacity-exceeded');
    assert.equal(await readFile(file, 'utf8'), before);
    const restarted = createHermesAlerts({ file, state, petId: () => 'main' });
    await restarted.accept(snapshot({ decisions: [...snapshot().decisions, active] }));
    assert.deepEqual(
      view(state).alerts.map((entry) => entry.id),
      [id],
    );
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).dismissed, dismissed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('确认路由校验精确对象与未知 id，成功仅本地确认', async () => {
  const { dir, state, alerts } = await fixture();
  try {
    await alerts.accept(snapshot());
    const deps = { hermesAlerts: alerts } as PetRouteDeps;
    const call = (body: string, method = 'POST') =>
      handleHermesRoutes(deps, { rest: 'hermes/ack', method, body, url: new URL('http://localhost') });
    const invalid = await call('{');
    const wrongMethod = await call('{}', 'GET');
    assert.equal(invalid?.kind === 'json' && invalid.status, 400);
    assert.equal(wrongMethod?.kind === 'json' && wrongMethod.status, 405);
    for (const body of [
      JSON.stringify({ id: 'x' }),
      JSON.stringify({ id: view(state).alerts[0]!.id, extra: true }),
      JSON.stringify({ id: 'hermes-cron-' + 'a'.repeat(64) }),
    ]) {
      const result = await call(body);
      assert.equal(result?.kind === 'json' && (result.obj as { ok: boolean }).ok, false);
    }
    assert.deepEqual(await call(JSON.stringify({ id: view(state).alerts[0]!.id })), {
      kind: 'json',
      status: 200,
      obj: { ok: true },
      headers: undefined,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const ext = (extra: Record<string, unknown> = {}) =>
  ({
    v: 1,
    source: 'claude',
    kind: 'decision',
    key: 'ask:s1:tu1',
    title: 'Claude 要你做决定 · dsh-pet',
    text: '用哪个方案？',
    session: 's1',
    at: 100,
    ...extra,
  }) as never;

test('外部提醒：显示原文、同 key 幂等、Hermes 快照折叠后仍保留', async () => {
  const { dir, file, state, alerts } = await fixture();
  try {
    assert.equal(await alerts.pushExternal(ext()), 'shown');
    assert.equal(await alerts.pushExternal(ext()), 'duplicate');
    await alerts.pushExternal(
      ext({
        source: 'windows',
        kind: 'task-failed',
        key: 'win:Kofi:t',
        title: 'Windows 计划任务失败 · Kofi',
        text: '',
        session: undefined,
        at: 50,
      }),
    );
    await alerts.accept(snapshot());
    const alerts1 = view(state).alerts;
    // 等决定的两类同在最前，失败在后。
    assert.deepEqual(
      alerts1
        .slice(0, 2)
        .map((a) => a.title)
        .sort(),
      ['Claude 要你做决定 · dsh-pet', 'Hermes 需要你确认'],
    );
    assert.equal(alerts1[2]!.title, 'Windows 计划任务失败 · Kofi');
    const claude = alerts1.find((a) => a.title.startsWith('Claude'))!;
    assert.equal(claude.message, '用哪个方案？');
    assert.equal(claude.url, undefined);
    assert.equal(alerts1[2]!.message, '（无详情）');
    const reloaded = createHermesAlerts({ file, state: new PollStateStore(), petId: () => 'main' });
    await reloaded.initialize();
    assert.equal(await reloaded.pushExternal(ext()), 'duplicate');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('外部提醒确认后不占用永久 dismissed，会话回话清掉该会话的决定', async () => {
  const { dir, file, state, alerts } = await fixture();
  try {
    await alerts.pushExternal(ext());
    await alerts.pushExternal(ext({ key: 'ask:s1:tu2' }));
    await alerts.pushExternal(ext({ key: 'ask:s2:tu3', session: 's2' }));
    await alerts.pushExternal(ext({ kind: 'task-failed', key: 'taskfail:s1', title: 'Claude 定时任务失败 · x' }));
    const first = view(state).alerts.find((a) => a.message === '用哪个方案？')!;
    assert.equal(await alerts.ack(first.id), true);
    const disk = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(disk.dismissed, []);
    await alerts.pushExternal(ext({ key: 'ask:s1:later', text: '回话之后的新问题', at: 500 }));
    assert.equal(await alerts.resolveExternal('claude', 's1', 200), 1);
    assert.equal(await alerts.resolveExternal('windows', 's2', 999), 0);
    // 回话之后才问的新问题保留，s2 的不动，失败提醒不受回话影响。
    assert.deepEqual(
      view(state)
        .alerts.map((a) => a.message)
        .sort(),
      ['回话之后的新问题', '用哪个方案？', '用哪个方案？'].sort(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DSH inbox 端到端：来源、持久化去重、本地确认与 resolved 来源隔离', async () => {
  const { drainInbox } = await import('./pet-inbox.ts');
  const { externalSink } = await import('./hermes-alerts.ts');
  const { mkdir } = await import('node:fs/promises');
  const { dir, file, state, alerts } = await fixture();
  const inbox = join(dir, 'inbox');
  await mkdir(inbox);
  try {
    const event = {
      v: 1,
      source: 'dsh',
      kind: 'decision',
      key: 'ask:s1:tu1',
      title: '需要确认',
      text: 'DSH 问题',
      session: 's1',
      at: 100,
    };
    await writeFile(join(inbox, 'event.json'), JSON.stringify(event));
    assert.equal(await drainInbox(inbox, externalSink(alerts), 200), 1);
    assert.equal(await alerts.pushExternal(ext(event)), 'duplicate');
    const reloaded = createHermesAlerts({ file, state, petId: () => 'main' });
    await reloaded.initialize();
    assert.equal(await reloaded.pushExternal(ext(event)), 'duplicate');
    assert.equal(view(state).alerts[0]!.title, 'DSH · 需要确认');
    // Hermes 退役阶段 4（2026-11-07 授权）：DSH 提醒的“查看对话”打开 DSH 主窗口。
    assert.equal(view(state).alerts[0]!.url, 'dsh://open');
    await reloaded.pushExternal(ext());
    await reloaded.pushExternal(ext({ ...event, key: 'later', at: 500 }));
    await reloaded.pushExternal(ext({ ...event, key: 'other', session: 's2' }));
    await reloaded.pushExternal(ext({ ...event, key: 'fail', kind: 'task-failed' }));
    await writeFile(
      join(inbox, 'event.json'),
      JSON.stringify({ ...event, kind: 'resolved', title: '', text: '', at: 200 }),
    );
    assert.equal(await drainInbox(inbox, externalSink(reloaded), 200), 1);
    assert.equal(view(state).alerts.length, 4);
    assert.equal(await reloaded.resolveExternal('claude', 's1', 200), 1);
    assert.equal(view(state).alerts.length, 3);
    const failure = view(state).alerts.find((a) => a.id.startsWith('hermes-dsh-fail-'))!;
    assert.equal(await reloaded.ack(failure.id), true);
    assert.equal(view(state).alerts.length, 2);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).dismissed, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('外部提醒写盘失败不发布、不吞事件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-hermes-'));
  try {
    const state = new PollStateStore();
    const alerts = createHermesAlerts({
      file: join(dir, 'h.json'),
      state,
      petId: () => 'main',
      persist: async () => {
        throw new Error('disk');
      },
    });
    await assert.rejects(alerts.pushExternal(ext()));
    assert.equal(state.read().sections.hermesAlerts?.data ?? null, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
