#!/usr/bin/env node
/**
 * Claude Code 全局 hook：把“Claude 在等虎哥决定 / 定时任务失败”投进大肥鱼收件目录。
 * 只写事件文件，不拦截、不改 Claude 行为：任何异常都静默 exit 0，stdout 不输出。
 * 部署：复制到 ~/.claude/hooks/pet-notify.mjs，并在 ~/.claude/settings.json 挂到下列事件。
 *
 * 事件契约（一个事件一个文件，tmp + rename 原子落盘，大肥鱼读完即删）：
 *   ~/.dsh/dsh-pet/inbox/claude-<sha>.json
 *   { v:1, source:'claude', kind:'decision'|'task-failed'|'resolved', key, title, text, session?, at }
 * key 是去重键：同一 key 只提醒一次；kind=resolved 清掉同 session 未读的 decision。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const INBOX = process.env.DSH_PET_INBOX || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-pet', 'inbox');
const TEXT_LIMIT = 1200;

const clip = (value, limit = TEXT_LIMIT) => {
  const s = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
};

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

/** 会话可读名：项目目录名。 */
function where(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  return cwd ? basename(cwd.replace(/[\\/]+$/, '')) : 'Claude';
}

/**
 * 定时任务会话识别：Claude Desktop 定时任务的首条用户消息以 `<scheduled-task name="X" ...>` 开头。
 * 只读 transcript 前 256 KiB，任何失败视为非定时任务。
 */
export function scheduledTaskName(transcriptPath) {
  try {
    if (typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) return null;
    const fd = openSync(transcriptPath, 'r');
    let head = '';
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
    for (const line of head.split('\n')) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row?.type !== 'user') continue;
      const c = row.message?.content;
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
            : '';
      const m = /^\s*<scheduled-task name="([^"]{1,120})"/.exec(text);
      return m ? m[1] : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 定时任务主动声明失败的固定标记（见 ~/.claude/CLAUDE.md 约定）。 */
export const FAIL_MARK = /^\[TASK-FAILED\][ \t]*(.*)$/m;

/** 把 hook 输入折成 0 或 1 个事件；纯函数，便于测试。 */
export function toEvent(input, now = Date.now(), resolveTask = scheduledTaskName) {
  const event = input.hook_event_name;
  const session = typeof input.session_id === 'string' ? input.session_id.slice(0, 128) : undefined;
  const at = now;
  const place = where(input);
  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') {
    const qs = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [];
    const text = qs
      .map((q) => clip(q?.question, 400))
      .filter(Boolean)
      .join('\n');
    if (!text) return null;
    return {
      kind: 'decision',
      key: `ask:${session}:${input.tool_use_id ?? text}`,
      title: `Claude 要你做决定 · ${place}`,
      text,
      session,
      at,
    };
  }
  if (event === 'PreToolUse' && input.tool_name === 'mcp__ccd_turn__wrap_up') {
    const ask = clip(input.tool_input?.ask, 400);
    if (!ask) return null;
    const recap = clip(input.tool_input?.recap, 400);
    return {
      kind: 'decision',
      key: `wrap:${session}:${input.tool_use_id ?? ask}`,
      title: `Claude 等你回复 · ${place}`,
      text: recap ? `${ask}\n${recap}` : ask,
      session,
      at,
    };
  }
  if (event === 'Notification' && input.notification_type === 'permission_prompt') {
    const text = clip(input.message || '有一个操作等你批准');
    return { kind: 'decision', key: `perm:${session}:${now}`, title: `Claude 等你批准 · ${place}`, text, session, at };
  }
  // 回答完 AskUserQuestion（PostToolUse）与用户发新消息一样，算已处理。
  if (event === 'UserPromptSubmit' || (event === 'PostToolUse' && input.tool_name === 'AskUserQuestion')) {
    if (!session) return null;
    return { kind: 'resolved', key: `resolved:${session}:${now}`, title: '', text: '', session, at };
  }
  if (event === 'StopFailure') {
    const task = resolveTask(input.transcript_path);
    if (!task) return null;
    const detail = clip([input.error, input.error_details].filter(Boolean).join(': ') || 'API 错误');
    return {
      kind: 'task-failed',
      key: `taskfail:${session}`,
      title: `Claude 定时任务失败 · ${task}`,
      text: detail,
      session,
      at,
    };
  }
  if (event === 'Stop') {
    const m = FAIL_MARK.exec(String(input.last_assistant_message ?? ''));
    if (!m) return null;
    const task = resolveTask(input.transcript_path);
    if (!task) return null;
    return {
      kind: 'task-failed',
      key: `taskfail:${session}`,
      title: `Claude 定时任务失败 · ${task}`,
      text: clip(m[1] || '任务报告失败，请查看该次运行'),
      session,
      at,
    };
  }
  return null;
}

export function writeEvent(event, inbox = INBOX) {
  mkdirSync(inbox, { recursive: true });
  const record = { v: 1, source: 'claude', ...event };
  const name = `claude-${String(record.at).padStart(13, '0')}-${createHash('sha256').update(record.key).digest('hex').slice(0, 24)}.json`;
  const tmp = join(inbox, `.${name}.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(record), 'utf8');
  renameSync(tmp, join(inbox, name));
}

/** 只有发过 decision 的会话，用户回话时才发 resolved，避免每条消息都落一个文件。 */
export function handle(input, inbox = INBOX, now = Date.now()) {
  const event = toEvent(input, now);
  if (!event) return null;
  const marker = event.session
    ? join(inbox, 'open', `${createHash('sha256').update(event.session).digest('hex').slice(0, 32)}`)
    : null;
  if (event.kind === 'resolved') {
    if (!marker || !existsSync(marker)) return null;
    writeEvent(event, inbox);
    rmSync(marker, { force: true });
    return event;
  }
  writeEvent(event, inbox);
  if (event.kind === 'decision' && marker) {
    mkdirSync(join(inbox, 'open'), { recursive: true });
    writeFileSync(marker, '', 'utf8');
  }
  return event;
}

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]).replace(/\\/g, '/'));
if (isMain) {
  try {
    handle(readStdin());
  } catch {
    /* hook 永不影响 Claude */
  }
  process.exit(0);
}
