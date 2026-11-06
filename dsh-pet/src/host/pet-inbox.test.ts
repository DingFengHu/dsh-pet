/** 外部收件目录：严格契约、成功才删、sink 失败保留。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainInbox, type ExternalAlertSink, type InboxEvent } from './pet-inbox.ts';

const ok = {
  v: 1,
  source: 'claude',
  kind: 'decision',
  key: 'ask:s:1',
  title: 'Claude 要你做决定',
  text: '选哪个？',
  session: 's',
  at: 1,
};

function recorder(fail = false): ExternalAlertSink & { pushed: InboxEvent[]; resolved: string[] } {
  const pushed: InboxEvent[] = [];
  const resolved: string[] = [];
  return {
    pushed,
    resolved,
    push: async (e) => {
      if (fail) throw new Error('disk');
      pushed.push(e);
      return 'shown';
    },
    resolve: async (source, session, at) => {
      resolved.push(`${source}:${session}:${at}`);
      return 1;
    },
  };
}

test('合法事件交给 sink 后删除，坏文件与 tmp 分开处理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-'));
  await writeFile(join(dir, 'a.json'), JSON.stringify(ok));
  await writeFile(join(dir, 'b.json'), JSON.stringify({ ...ok, extra: 1 }));
  await writeFile(join(dir, 'c.json'), '{broken');
  await writeFile(join(dir, 'd.json'), JSON.stringify({ ...ok, kind: 'resolved', title: '', text: '' }));
  await writeFile(join(dir, '.e.json.x.tmp'), JSON.stringify(ok));
  const sink = recorder();
  assert.equal(await drainInbox(dir, sink, 2), 4);
  assert.deepEqual(
    sink.pushed.map((e) => e.key),
    ['ask:s:1'],
  );
  assert.deepEqual(sink.resolved, ['claude:s:1']);
  assert.deepEqual(await readdir(dir), ['.e.json.x.tmp']);
});

test('sink 写盘失败时文件留到下一轮', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-'));
  await writeFile(join(dir, 'a.json'), JSON.stringify(ok));
  assert.equal(await drainInbox(dir, recorder(true), 2), 0);
  assert.deepEqual(await readdir(dir), ['a.json']);
  const sink = recorder();
  assert.equal(await drainInbox(dir, sink, 2), 1);
  assert.equal(sink.pushed.length, 1);
});

test('非 resolved 必须有标题，resolved 必须有会话，目录不存在不报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-'));
  await writeFile(join(dir, 'a.json'), JSON.stringify({ ...ok, title: '' }));
  const noSession = { ...ok, session: undefined };
  await writeFile(join(dir, 'b.json'), JSON.stringify({ ...noSession, kind: 'resolved' }));
  const sink = recorder();
  await drainInbox(dir, sink, 2);
  assert.equal(sink.pushed.length + sink.resolved.length, 0);
  assert.equal(await drainInbox(join(dir, 'missing'), sink), 0);
});

test('过期事件丢弃不提醒：决定 12 小时、失败 3 天', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-'));
  const h = 3600_000;
  await writeFile(join(dir, 'a.json'), JSON.stringify({ ...ok, key: 'old-decision', at: 0 }));
  await writeFile(join(dir, 'b.json'), JSON.stringify({ ...ok, key: 'fail', kind: 'task-failed', at: 0 }));
  const sink = recorder();
  assert.equal(await drainInbox(dir, sink, 13 * h), 2);
  assert.deepEqual(
    sink.pushed.map((e) => e.key),
    ['fail'],
  );
});

test('按事件时间处理而不是文件名：先决定后回话，回话能清掉决定', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-'));
  await writeFile(join(dir, 'a.json'), JSON.stringify({ ...ok, kind: 'resolved', title: '', text: '', at: 3 }));
  await writeFile(join(dir, 'z.json'), JSON.stringify({ ...ok, at: 1 }));
  const order: string[] = [];
  const sink: ExternalAlertSink = {
    push: async (e) => (order.push(`push:${e.at}`), 'shown'),
    resolve: async () => (order.push('resolve'), 1),
  };
  await drainInbox(dir, sink, 5);
  assert.deepEqual(order, ['push:1', 'resolve']);
});

test('前一个 sink 失败时后面的事件也留到下一轮，不打乱顺序', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-'));
  await writeFile(join(dir, 'a.json'), JSON.stringify({ ...ok, at: 1 }));
  await writeFile(join(dir, 'b.json'), JSON.stringify({ ...ok, kind: 'resolved', title: '', text: '', at: 2 }));
  const resolved: string[] = [];
  const sink: ExternalAlertSink = {
    push: async () => Promise.reject(new Error('disk')),
    resolve: async () => (resolved.push('x'), 1),
  };
  assert.equal(await drainInbox(dir, sink, 5), 0);
  assert.deepEqual(resolved, []);
  assert.deepEqual((await readdir(dir)).sort(), ['a.json', 'b.json']);
});
