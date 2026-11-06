/**
 * Windows 计划任务失败巡检：每 5 分钟用隐藏的 PowerShell 读根目录计划任务的上次结果，
 * 上次运行时间变了且结果码是失败才提醒；首轮只记基线，不翻旧账。
 * 只读 Task Scheduler，不启动、不停止、不修改任何任务。
 * @module dsh-pet/host/windows-tasks
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readJsonc } from './config/jsonc.ts';
import type { ExternalAlertSink } from './pet-inbox.ts';

export const WINDOWS_TASKS_STATE_FILE = 'windows-task-watch-state.json';
export const WINDOWS_TASKS_CONFIG_FILE = 'windows-task-watch.jsonc';

/** 只看根文件夹，供应商自更新与一次性外部执行器默认排除。 */
export const DEFAULT_EXCLUDE = [
  '^ClaudeOutside-',
  '^OneDrive ',
  '^NVIDIA ',
  '^ZoomUpdate',
  '^GoogleUpdate',
  '^MicrosoftEdgeUpdate',
];

/** 不算失败的结果码：成功、就绪、正在运行、已禁用、从未运行、被用户终止。 */
export const OK_RESULTS = new Set([0, 0x41300, 0x41301, 0x41302, 0x41303, 0x41306]);
const RUNNING = 0x41301;

export const configSchema = z
  .object({
    enabled: z.boolean().optional(),
    exclude: z.array(z.string().max(200)).max(64).optional(),
  })
  .strict();

export const taskRowSchema = z.object({
  name: z.string().min(1).max(260),
  state: z.string().max(40),
  result: z.number().int(),
  lastRun: z.string().max(40).nullable(),
});
export type TaskRow = z.infer<typeof taskRowSchema>;

const stateSchema = z
  .object({
    v: z.literal(1),
    seen: z.record(z.string(), z.string()),
    /** 当前处于失败中的任务：持续失败只提醒一次，成功一次后才重新武装。 */
    failing: z.array(z.string()).max(1024).default([]),
  })
  .strict();
export type WatchState = z.infer<typeof stateSchema>;

/** 固定脚本，不拼接任何外部输入；只输出根文件夹任务的 JSON。 */
export const QUERY_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  "$rows=@(Get-ScheduledTask -TaskPath '\\' | ForEach-Object { $i=$_ | Get-ScheduledTaskInfo;",
  '[pscustomobject]@{name=$_.TaskName;state=[string]$_.State;result=[int64]$i.LastTaskResult;',
  "lastRun=$(if($i.LastRunTime -and $i.LastRunTime.Year -gt 2000){$i.LastRunTime.ToUniversalTime().ToString('o')}else{$null})} })",
  'ConvertTo-Json -InputObject $rows -Compress -Depth 3',
].join('\n');

export const QUERY_OPTIONS = { shell: false, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true } as const;

/** 有符号 int32 结果码统一成无符号再比较（PowerShell 会把 0x8xxxxxxx 给成负数）。 */
export function normalizeResult(code: number): number {
  return code < 0 ? code + 0x1_0000_0000 : code;
}

export function formatResult(code: number): string {
  const u = normalizeResult(code);
  return `0x${u.toString(16).toUpperCase().padStart(8, '0')}（${u}）`;
}

/** 纯函数：给出新状态与要提醒的任务。state 为 null 表示首轮，只记基线（已在失败的也不提醒）。 */
export function diffTasks(
  state: WatchState | null,
  rows: readonly TaskRow[],
  exclude: readonly RegExp[],
): { state: WatchState; failed: TaskRow[] } {
  const seen: Record<string, string> = { ...(state?.seen ?? {}) };
  const failing = new Set(state?.failing ?? []);
  const failed: TaskRow[] = [];
  const present = new Set<string>();
  for (const row of rows) {
    if (exclude.some((re) => re.test(row.name))) continue;
    present.add(row.name);
    if (!row.lastRun || row.state === 'Disabled') continue;
    const result = normalizeResult(row.result);
    // 运行中还没有最终结果，等结束后再看。
    if (result === RUNNING || row.state === 'Running') continue;
    if (seen[row.name] === row.lastRun) continue;
    seen[row.name] = row.lastRun;
    if (OK_RESULTS.has(result)) {
      failing.delete(row.name);
      continue;
    }
    if (!failing.has(row.name) && state) failed.push(row);
    failing.add(row.name);
  }
  for (const name of Object.keys(seen)) if (!present.has(name)) delete seen[name];
  for (const name of [...failing]) if (!present.has(name)) failing.delete(name);
  return { state: { v: 1, seen, failing: [...failing].sort() }, failed };
}

async function readState(file: string): Promise<WatchState | null> {
  try {
    return stateSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // 损坏状态当首轮重建基线，宁可漏一次也不批量翻旧账。
    return null;
  }
}

async function writeState(file: string, state: WatchState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(state) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

function loadConfig(userRoot: string): z.infer<typeof configSchema> {
  const path = join(userRoot, WINDOWS_TASKS_CONFIG_FILE);
  if (!existsSync(path) || statSync(path).size > 16 * 1024) return {};
  return configSchema.parse(readJsonc(path));
}

/** 一轮巡检：先把提醒交给 sink，全部成功后才推进状态，失败下轮重来（sink 幂等）。 */
export async function checkOnce(options: {
  userRoot: string;
  sink: ExternalAlertSink;
  rows: readonly TaskRow[];
  now?: number;
}): Promise<TaskRow[]> {
  const config = loadConfig(options.userRoot);
  const exclude = [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])].map((p) => new RegExp(p, 'i'));
  const file = join(options.userRoot, WINDOWS_TASKS_STATE_FILE);
  const previous = await readState(file);
  const { state, failed } = diffTasks(previous, options.rows, exclude);
  for (const row of failed) {
    await options.sink.push({
      v: 1,
      source: 'windows',
      kind: 'task-failed',
      key: `win:${row.name}:${row.lastRun}`,
      title: `Windows 计划任务失败 · ${row.name}`.slice(0, 200),
      text: `结果码 ${formatResult(row.result)}，运行于 ${new Date(row.lastRun!).toLocaleString('zh-CN', { hour12: false })}`,
      at: options.now ?? Date.now(),
    });
  }
  await writeState(file, state);
  return failed;
}

/** 解析 PowerShell 输出（单个对象时 ConvertTo-Json 也包成数组）。 */
export function parseRows(stdout: string): TaskRow[] {
  const raw = JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]') as unknown;
  return z
    .array(taskRowSchema)
    .max(1024)
    .parse(Array.isArray(raw) ? raw : [raw]);
}

/** 只在 Windows 启动；配置 enabled:false 时整轮跳过。返回停止函数。 */
export function startWindowsTaskWatch(options: {
  userRoot: string;
  sink: ExternalAlertSink;
  execute?: typeof execFile;
  intervalMs?: number;
  log?: (line: string) => void;
}): () => void {
  if (process.platform !== 'win32' && !options.execute) return () => {};
  let stopped = false;
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(tick, options.intervalMs ?? 5 * 60_000);
    timer.unref?.();
  };
  const tick = (): void => {
    if (stopped) return;
    try {
      if (loadConfig(options.userRoot).enabled === false) return schedule();
    } catch {
      options.log?.('[windows-tasks] config invalid, skipped');
      return schedule();
    }
    child = (options.execute ?? execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', QUERY_SCRIPT],
      QUERY_OPTIONS,
      (cause, stdout) => {
        child = undefined;
        if (stopped) return;
        const run = async (): Promise<void> => {
          if (cause) throw cause;
          const failed = await checkOnce({
            userRoot: options.userRoot,
            sink: options.sink,
            rows: parseRows(String(stdout)),
          });
          if (failed.length) options.log?.(`[windows-tasks] ${failed.length} failed task(s) reported`);
        };
        void run()
          .catch(() => options.log?.('[windows-tasks] check failed'))
          .finally(schedule);
      },
    );
  };
  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    child?.kill();
  };
}
