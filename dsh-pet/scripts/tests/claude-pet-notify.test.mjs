import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { conversationTitle, handle, scheduledTaskName, toEvent } from '../claude-pet-notify.mjs';

const SCRIPT = fileURLToPath(new URL('../claude-pet-notify.mjs', import.meta.url));
const base = { session_id: 's1', cwd: 'D:\\Projects\\dsh-pet', transcript_path: '/nope' };
const noTask = () => null;
const events = (dir) =>
  readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));

function transcript(firstUser) {
  const dir = mkdtempSync(join(tmpdir(), 'pet-notify-t-'));
  const file = join(dir, 't.jsonl');
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'summary' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: firstUser } }),
    ].join('\n'),
  );
  return file;
}

function titledTranscript(...rows) {
  const file = transcript('普通请求');
  writeFileSync(file, rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n'));
  return file;
}

const titleRow = (customTitle, sessionId = base.session_id) => ({ type: 'custom-title', customTitle, sessionId });

test('从真实 custom-title schema 取当前会话最新名称，忽略其他会话和坏行', () => {
  const file = titledTranscript(
    titleRow('旧名称'),
    titleRow('新的对话名称'),
    titleRow('别的会话', 'other'),
    { type: 'user', sessionId: 's1', message: { content: '不拿用户原文充当标题' } },
    { type: 'custom-title', sessionId: 's1', customTitle: 123 },
    '{"type":"custom-title",',
  );
  assert.equal(conversationTitle({ ...base, transcript_path: file }), '新的对话名称');
});

test('无标题、文件不可读、session 不匹配或缺失均显示未命名，不用项目或猜测的 payload 字段', () => {
  for (const input of [
    base,
    { ...base, transcript_path: transcript('普通请求') },
    { ...base, transcript_path: titledTranscript(titleRow('他人对话', 'other')) },
    { ...base, transcript_path: titledTranscript(titleRow('真实名称')), session_id: undefined },
    { ...base, transcript_path: undefined, title: '猜测字段', session_title: '猜测字段' },
    { ...base, transcript_path: titledTranscript(titleRow('旧名称'), titleRow('  \n ')) },
  ]) {
    assert.equal(conversationTitle(input), '未命名');
  }
});

test('标题在 256 KiB 之外仍能读到，不被长消息截断', () => {
  const file = titledTranscript(titleRow('较早命名'), {
    type: 'assistant',
    message: { content: 'x'.repeat(300 * 1024) },
  });
  assert.equal(conversationTitle({ ...base, transcript_path: file }), '较早命名');
});

test('跨块的 UTF-8 标题保持完整，清理空白并限制显示长度', () => {
  const row = JSON.stringify(titleRow('中文对话'));
  const split = Buffer.byteLength(row.slice(0, row.indexOf('中'))) + 1;
  const file = titledTranscript(row, 'x'.repeat(64 * 1024 - (Buffer.byteLength(row) - split) - 1));
  assert.equal(conversationTitle({ ...base, transcript_path: file }), '中文对话');
  const long = titledTranscript(titleRow(`  标题\n\t${'名'.repeat(200)}  `));
  const title = conversationTitle({ ...base, transcript_path: long });
  assert.equal(title.length, 160);
  assert.ok(title.startsWith('标题 名'));
  assert.ok(title.endsWith('…'));
});

test('AskUserQuestion 变成 decision，带问题原文和真实对话名', () => {
  const e = toEvent(
    {
      ...base,
      transcript_path: titledTranscript(titleRow('修复通知标题')),
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu1',
      tool_input: { questions: [{ question: '用哪个方案？' }, { question: '要部署吗？' }] },
    },
    1,
    noTask,
  );
  assert.equal(e.kind, 'decision');
  assert.equal(e.text, '用哪个方案？\n要部署吗？');
  assert.equal(e.title, 'Claude 中“修复通知标题”的这个任务需要你决定');
  assert.equal(e.key, 'ask:s1:tu1');
});

test('wrap_up 只有带 ask 才提醒', () => {
  const pre = {
    ...base,
    transcript_path: titledTranscript(titleRow('继续完善通知')),
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__ccd_turn__wrap_up',
    tool_use_id: 'w1',
  };
  assert.equal(toEvent({ ...pre, tool_input: { recap: '做完了' } }, 1, noTask), null);
  const e = toEvent({ ...pre, tool_input: { recap: '做完了', ask: '按方案开工吗？' } }, 1, noTask);
  assert.equal(e.kind, 'decision');
  assert.equal(e.text, '按方案开工吗？\n做完了');
  assert.equal(e.title, 'Claude 中“继续完善通知”的这个任务需要你回复');
});

test('只有 permission_prompt 通知才提醒', () => {
  assert.equal(
    toEvent({ ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'x' }, 1, noTask),
    null,
  );
  const e = toEvent(
    {
      ...base,
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    },
    1,
    noTask,
  );
  assert.equal(e.kind, 'decision');
  assert.equal(e.title, 'Claude 中“未命名”的这个任务需要你批准');
  const named = toEvent({
    ...base,
    transcript_path: titledTranscript(titleRow('权限检查')),
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
  });
  assert.equal(named.title, 'Claude 中“权限检查”的这个任务需要你批准');
});

test('StopFailure 只在定时任务会话里算失败', () => {
  const input = { ...base, hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429' };
  assert.equal(toEvent(input, 1, noTask), null);
  const e = toEvent(input, 1, () => 'daily-report');
  assert.equal(e.kind, 'task-failed');
  assert.equal(e.title, 'Claude 定时任务失败 · daily-report');
  assert.equal(e.text, 'rate_limit: 429');
});

test('Stop 需要 [TASK-FAILED] 标记且是定时任务', () => {
  const input = { ...base, hook_event_name: 'Stop', last_assistant_message: '跑完了。\n[TASK-FAILED] 远端 SHA 对不上' };
  assert.equal(
    toEvent({ ...input, last_assistant_message: '全部成功，没有失败' }, 1, () => 't'),
    null,
  );
  assert.equal(toEvent(input, 1, noTask), null);
  const e = toEvent(input, 1, () => 't');
  assert.equal(e.text, '远端 SHA 对不上');
});

test('从 transcript 首条用户消息认出定时任务名', () => {
  const t = transcript('<scheduled-task name="gex-check-1610" file="C:\\x\\SKILL.md">\nThis is an automated run');
  assert.equal(scheduledTaskName(t), 'gex-check-1610');
  assert.equal(scheduledTaskName(transcript([{ type: 'text', text: '<scheduled-task name="arr-form">' }])), 'arr-form');
  assert.equal(scheduledTaskName(transcript('普通消息 <scheduled-task name="x">')), null);
  assert.equal(scheduledTaskName('Z:/missing.jsonl'), null);
});

test('resolved 只在该会话有过 decision 时写出，写一次', () => {
  const inbox = mkdtempSync(join(tmpdir(), 'pet-notify-i-'));
  const prompt = { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
  assert.equal(handle(prompt, inbox, 1), null);
  handle(
    {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'a',
      tool_input: { questions: [{ question: 'Q' }] },
    },
    inbox,
    2,
  );
  assert.equal(handle(prompt, inbox, 3).kind, 'resolved');
  assert.equal(handle(prompt, inbox, 4), null);
  const kinds = events(inbox)
    .map((e) => e.kind)
    .sort();
  assert.deepEqual(kinds, ['decision', 'resolved']);
  for (const e of events(inbox)) (assert.equal(e.v, 1), assert.equal(e.source, 'claude'));
});

test('作为 hook 运行：坏输入也 exit 0 且不输出', () => {
  const inbox = mkdtempSync(join(tmpdir(), 'pet-notify-p-'));
  const env = { ...process.env, DSH_PET_INBOX: inbox };
  const bad = spawnSync(process.execPath, [SCRIPT], { input: 'not json', env, windowsHide: true });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout.length, 0);
  const ok = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({
      ...base,
      transcript_path: titledTranscript(titleRow('端到端标题')),
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'z',
      tool_input: { questions: [{ question: '选哪个？' }] },
    }),
    env,
    windowsHide: true,
  });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.length, 0);
  assert.equal(events(inbox).length, 1);
  assert.equal(events(inbox)[0].title, 'Claude 中“端到端标题”的这个任务需要你决定');
  assert.equal(events(inbox)[0].source, 'claude');
  assert.ok(existsSync(join(inbox, 'open')));
});

test('[TASK-FAILED] 必须独占一行开头，行内提到不算', () => {
  const input = { ...base, hook_event_name: 'Stop', last_assistant_message: '约定是在行内写 [TASK-FAILED] 原因' };
  assert.equal(
    toEvent(input, 1, () => 't'),
    null,
  );
});

test('回答完 AskUserQuestion 也算已处理', () => {
  const inbox = mkdtempSync(join(tmpdir(), 'pet-notify-q-'));
  const ask = {
    ...base,
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'q',
    tool_input: { questions: [{ question: 'Q' }] },
  };
  handle(ask, inbox, 1);
  assert.equal(
    handle({ ...base, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q' }, inbox, 2).kind,
    'resolved',
  );
  assert.equal(handle({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash' }, inbox, 3), null);
});

test('文件名带时间前缀，字典序即时间序', () => {
  const inbox = mkdtempSync(join(tmpdir(), 'pet-notify-n-'));
  const ask = {
    ...base,
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'n',
    tool_input: { questions: [{ question: 'Q' }] },
  };
  handle(ask, inbox, 1793941898023);
  assert.match(
    readdirSync(inbox).find((n) => n.endsWith('.json')),
    /^claude-1793941898023-[a-f0-9]{24}\.json$/,
  );
});
