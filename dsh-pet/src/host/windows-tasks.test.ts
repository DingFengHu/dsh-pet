/** Windows 计划任务巡检：首轮基线、状态切换才提醒、固定只读脚本。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { execFile } from 'node:child_process';
import type { ExternalAlertSink, InboxEvent } from './pet-inbox.ts';
import {
  checkOnce,
  diffTasks,
  formatResult,
  parseRows,
  QUERY_OPTIONS,
  QUERY_SCRIPT,
  startWindowsTaskWatch,
  WINDOWS_TASKS_CONFIG_FILE,
  WINDOWS_TASKS_STATE_FILE,
  type TaskRow,
} from './windows-tasks.ts';

const row = (name: string, result: number, lastRun: string | null, state = 'Ready'): TaskRow => ({
  name,
  state,
  result,
  lastRun,
});

function sink(): ExternalAlertSink & { pushed: InboxEvent[] } {
  const pushed: InboxEvent[] = [];
  return { pushed, push: async (e) => (pushed.push(e), 'shown'), resolve: async () => 0 };
}

test('首轮只记基线，已在失败的也不提醒', () => {
  const { state, failed } = diffTasks(null, [row('A', 2, 't1'), row('B', 0, 't1')], []);
  assert.deepEqual(failed, []);
  assert.deepEqual(state.failing, ['A']);
});

test('从正常变失败提醒一次，持续失败不重复，成功后再失败重新提醒', () => {
  let s = diffTasks(null, [row('A', 0, 't1')], []).state;
  let r = diffTasks(s, [row('A', 1, 't2')], []);
  assert.deepEqual(
    r.failed.map((x) => x.name),
    ['A'],
  );
  r = diffTasks(r.state, [row('A', 1, 't3')], []);
  assert.deepEqual(r.failed, []);
  r = diffTasks(r.state, [row('A', 0, 't4')], []);
  r = diffTasks(r.state, [row('A', 0xc000013a - 0x1_0000_0000, 't5')], []);
  assert.deepEqual(
    r.failed.map((x) => x.result),
    [0xc000013a - 0x1_0000_0000],
  );
  s = r.state;
  assert.deepEqual(s.failing, ['A']);
});

test('运行中、禁用、从未运行、被用户终止、排除名单都不提醒', () => {
  const s = diffTasks(null, [], []).state;
  const r = diffTasks(
    s,
    [
      row('Run', 0x41301, 't', 'Running'),
      row('Off', 1, 't', 'Disabled'),
      row('Never', 0x41303, null),
      row('Killed', 0x41306, 't'),
      row('ClaudeOutside-1', 1, 't'),
    ],
    [/^ClaudeOutside-/i],
  );
  assert.deepEqual(r.failed, []);
  assert.equal('ClaudeOutside-1' in r.state.seen, false);
});

test('同一次运行只判断一次，消失的任务从状态里清掉', () => {
  let r = diffTasks({ v: 1, seen: {}, failing: [] }, [row('A', 1, 't1')], []);
  assert.equal(r.failed.length, 1);
  r = diffTasks({ ...r.state, failing: [] }, [row('A', 1, 't1')], []);
  assert.equal(r.failed.length, 0);
  r = diffTasks(r.state, [], []);
  assert.deepEqual(r.state.seen, {});
  assert.deepEqual(r.state.failing, []);
});

test('checkOnce 推送事件、写状态，并支持配置额外排除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wt-'));
  const s = sink();
  await checkOnce({ userRoot: root, sink: s, rows: [row('Kofi', 0, 't1'), row('Watchdog', 0, 't1')] });
  assert.equal(s.pushed.length, 0);
  await writeFile(join(root, WINDOWS_TASKS_CONFIG_FILE), '{ // 注释\n "exclude": ["^Watchdog$"] }');
  await checkOnce({
    userRoot: root,
    sink: s,
    rows: [row('Kofi', 2, '2026-11-06T04:57:45.000Z'), row('Watchdog', 1, 't2')],
    now: 5,
  });
  assert.equal(s.pushed.length, 1);
  const e = s.pushed[0]!;
  assert.equal(e.source, 'windows');
  assert.equal(e.title, 'Windows 计划任务失败 · Kofi');
  assert.match(e.text, /^结果码 0x00000002（2），运行于 /);
  const state = JSON.parse(await readFile(join(root, WINDOWS_TASKS_STATE_FILE), 'utf8'));
  assert.deepEqual(state.failing, ['Kofi']);
});

test('sink 失败时不推进状态，下一轮重推', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wt-'));
  const s = sink();
  await checkOnce({ userRoot: root, sink: s, rows: [row('A', 0, 't1')] });
  const bad: ExternalAlertSink = { push: async () => Promise.reject(new Error('disk')), resolve: async () => 0 };
  await assert.rejects(checkOnce({ userRoot: root, sink: bad, rows: [row('A', 1, 't2')] }));
  await checkOnce({ userRoot: root, sink: s, rows: [row('A', 1, 't2')] });
  assert.equal(s.pushed.length, 1);
});

test('结果码格式与 PowerShell 输出解析', () => {
  assert.equal(formatResult(-1073741510), '0xC000013A（3221225786）');
  assert.equal(parseRows('\uFEFF{"name":"A","state":"Ready","result":0,"lastRun":null}').length, 1);
  assert.equal(parseRows('[]').length, 0);
  assert.throws(() => parseRows('[{"name":""}]'));
});

test('固定只读脚本、隐藏窗口、不经 shell', () => {
  assert.equal(QUERY_OPTIONS.windowsHide, true);
  assert.equal(QUERY_OPTIONS.shell, false);
  assert.match(QUERY_SCRIPT, /Get-ScheduledTask -TaskPath '\\'/);
  assert.doesNotMatch(
    QUERY_SCRIPT,
    /Start-ScheduledTask|Stop-ScheduledTask|Set-ScheduledTask|Register-|Unregister-|Disable-|Enable-/,
  );
});

test('启动即跑一轮并落状态；查询未返回时停止会杀子进程', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wt-'));
  let calls = 0;
  const execute = ((file: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
    calls++;
    assert.equal(file, 'powershell.exe');
    assert.equal(args[args.length - 1], QUERY_SCRIPT);
    setImmediate(() => cb(null, '[{"name":"A","state":"Ready","result":0,"lastRun":"t1"}]'));
    return { kill: () => undefined };
  }) as unknown as typeof execFile;
  const stop = startWindowsTaskWatch({ userRoot: root, sink: sink(), execute, intervalMs: 60_000 });
  await new Promise((r) => setTimeout(r, 50));
  stop();
  assert.equal(calls, 1);
  const state = JSON.parse(await readFile(join(root, WINDOWS_TASKS_STATE_FILE), 'utf8'));
  assert.equal(state.seen.A, 't1');

  let killed = false;
  const hang = (() => ({ kill: () => (killed = true) })) as unknown as typeof execFile;
  const stop2 = startWindowsTaskWatch({ userRoot: root, sink: sink(), execute: hang, intervalMs: 60_000 });
  stop2();
  assert.equal(killed, true);
});
