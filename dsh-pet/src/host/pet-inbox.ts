/**
 * 外部提醒收件目录：Claude Code hook 等生产者把事件写成 `<数据根>/inbox/*.json`（tmp + rename 原子落盘），
 * 这里轮询读取、严格校验后交给提醒状态，成功落盘才删文件；坏文件直接删，不重试。
 * 只搬运文本显示在气泡里，不执行、不回复任何东西。
 * @module dsh-pet/host/pet-inbox
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** 收件目录名（相对数据根）。 */
export const PET_INBOX_DIR = 'inbox';
const FILE_LIMIT = 16 * 1024;
const BATCH = 64;
/** 过期事件直接丢：等决定的 12 小时后多半已处理，失败提醒保留 3 天。 */
export const MAX_AGE_MS = { decision: 12 * 3600_000, 'task-failed': 3 * 86_400_000, resolved: 3 * 86_400_000 } as const;

const line = z.string().max(200);
/** 生产者写入的事件契约 v1。 */
export const inboxEventSchema = z
  .object({
    v: z.literal(1),
    source: z.enum(['claude', 'windows']),
    kind: z.enum(['decision', 'task-failed', 'resolved']),
    key: z.string().min(1).max(400),
    title: line,
    text: z.string().max(4000),
    session: z.string().max(128).optional(),
    at: z.number().finite(),
  })
  .strict()
  .refine((e) => e.kind === 'resolved' || e.title.length > 0, { message: 'title-required' })
  .refine((e) => e.kind !== 'resolved' || !!e.session, { message: 'session-required' });
/** 已校验事件。 */
export type InboxEvent = z.infer<typeof inboxEventSchema>;

/** 提醒状态对外暴露的最小写入面。 */
export interface ExternalAlertSink {
  /** 同 source+key 幂等，已确认过的不再出现。 */
  push(event: InboxEvent): Promise<'shown' | 'duplicate'>;
  /** 用户已在该会话回话：清掉这个会话在 `at` 之前（含）的未读 decision，之后的新问题保留。 */
  resolve(source: InboxEvent['source'], session: string, at: number): Promise<number>;
}

/** 读一轮：按事件时间顺序交给 sink，sink 抛错时该文件及其后的保留到下轮。返回处理掉的文件数。 */
export async function drainInbox(dir: string, sink: ExternalAlertSink, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  } catch {
    return 0;
  }
  let done = 0;
  const ready: { path: string; event: InboxEvent }[] = [];
  for (const name of names.slice(0, BATCH)) {
    const path = join(dir, name);
    try {
      if ((await stat(path)).size > FILE_LIMIT) throw new Error('too-large');
      const event = inboxEventSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      if (now - event.at > MAX_AGE_MS[event.kind]) throw new Error('stale');
      ready.push({ path, event });
    } catch {
      await rm(path, { force: true });
      done++;
    }
  }
  // 按事件时间处理：“用户已回话”必须排在它要清掉的决定之后；sink 失败就停下，保持顺序到下轮。
  ready.sort((left, right) => left.event.at - right.event.at || left.path.localeCompare(right.path));
  for (const { path, event } of ready) {
    try {
      if (event.kind === 'resolved') await sink.resolve(event.source, event.session!, event.at);
      else await sink.push(event);
    } catch {
      break;
    }
    await rm(path, { force: true });
    done++;
  }
  return done;
}

/** 单飞轮询，返回停止函数。 */
export function startPetInbox(options: { userRoot: string; sink: ExternalAlertSink; intervalMs?: number }): () => void {
  const dir = join(options.userRoot, PET_INBOX_DIR);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = (): void => {
    if (stopped) return;
    void drainInbox(dir, options.sink)
      .catch(() => 0)
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(tick, options.intervalMs ?? 3_000);
        timer.unref?.();
      });
  };
  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
