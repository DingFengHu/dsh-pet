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
