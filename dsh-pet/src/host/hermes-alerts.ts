/**
 * Hermes 提醒状态所有者，所有快照与本地确认串行落盘后才发布。
 * 只拥有自己的 dismissed、pending 与初始 cron 基线，不写 Hermes。
 * 损坏状态不回退覆盖，失败只发布分类错误并保留最后成功的提醒。
 * @module dsh-pet/host/hermes-alerts
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { alertId, alertView, diskSchema, foldSnapshot, snapshotSchema, type HermesDisk } from './hermes-policy.ts';
import type { PollStateStore } from './state.ts';

/** 自有状态文件名，未启用且从未存储时不触碰共享状态。 */
export const HERMES_STATE_FILE = 'hermes-alerts-state.json';

/** 单一实例依赖，可注入写盘以验证失败不会产生假确认。 */
export interface HermesAlertsOptions {
  readonly file: string;
  readonly state: PollStateStore;
  readonly petId: () => string;
  readonly persist?: (next: HermesDisk) => Promise<void>;
}

/** 有界读取本地 JSON 文件，防止损坏文件耗尽内存。 */
export async function readBoundedJson(file: string): Promise<unknown> {
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead === bytes.length) throw new Error('state-too-large');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

/** 创建只有本地确认能力的状态服务，stop 后不再发布。 */
export function createHermesAlerts(options: HermesAlertsOptions) {
  let disk: HermesDisk | undefined;
  let queue: Promise<void> = Promise.resolve();
  let lastJson = '';
  let stale = true;
  let error: string | undefined;
  let stopped = false;
  const publish = (): void => {
    if (stopped) return;
    const view = {
      petId: options.petId(),
      alerts: (disk?.pending ?? []).map(alertView),
      stale,
      ...(error ? { error } : {}),
    };
    const json = JSON.stringify(view);
    if (json === lastJson) return;
    lastJson = json;
    options.state.writeSection('hermesAlerts', view);
  };
  const fail = (code: string): void => {
    stale = true;
    error = code;
    publish();
  };
  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const load = async (): Promise<void> => {
    if (disk) return;
    try {
      disk = diskSchema.parse(await readBoundedJson(options.file));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      disk = { stateVersion: 1, dismissed: [], pending: [], baselineProfiles: [] };
    }
  };
  const persist =
    options.persist ??
    (async (next: HermesDisk): Promise<void> => {
      await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
      const tempPath = `${options.file}.${randomUUID()}.tmp`;
      const handle = await open(tempPath, 'wx', 0o600);
      try {
        try {
          await handle.writeFile(JSON.stringify(next) + '\n', 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tempPath, options.file);
      } finally {
        await rm(tempPath, { force: true });
      }
    });
  const commit = async (next: HermesDisk): Promise<void> => {
    if (JSON.stringify(next) !== JSON.stringify(disk)) await persist(next);
    disk = next;
  };
  return {
    /** 先读取 sticky 状态，未配置或离线也保留已记录提醒。 */
    initialize: (): Promise<void> =>
      run(async () => {
        try {
          await load();
          publish();
        } catch {
          fail('state-load-failed');
        }
      }),
    /** 子进程输出必须完整通过 schema 才可参与折叠。 */
    accept: (raw: unknown): Promise<void> =>
      run(async () => {
        if (stopped) return;
        try {
          await load();
          const snapshot = snapshotSchema.parse(raw);
          await commit(foldSnapshot(disk!, snapshot));
          stale = snapshot.incomplete;
          error = snapshot.incomplete ? 'snapshot-incomplete' : undefined;
          publish();
        } catch (cause) {
          fail(
            cause instanceof Error && cause.message === 'state-capacity-exceeded'
              ? 'state-capacity-exceeded'
              : disk
                ? 'snapshot-or-persist-failed'
                : 'state-load-failed',
          );
        }
      }),
    /** 确认仅对当前可见的精确 id 生效，写盘失败不改变内存。 */
    ack: (id: string): Promise<boolean> =>
      run(async () => {
        if (stopped || !alertId.safeParse(id).success) return false;
        try {
          await load();
          if (!disk!.pending.some((entry) => entry.id === id)) return false;
          if (disk!.dismissed.length >= 2048 && !disk!.dismissed.includes(id))
            throw new Error('state-capacity-exceeded');
          await commit({
            ...disk!,
            dismissed: [...new Set([...disk!.dismissed, id])],
            pending: disk!.pending.filter((entry) => entry.id !== id),
          });
          publish();
          return true;
        } catch (cause) {
          fail(
            cause instanceof Error && cause.message === 'state-capacity-exceeded'
              ? 'state-capacity-exceeded'
              : disk
                ? 'state-persist-failed'
                : 'state-load-failed',
          );
          throw new Error('hermes-local-ack-failed', { cause });
        }
      }),
    /** 离线不会清空已发布提醒。 */
    offline: (code = 'hermes-unavailable'): void => fail(code),
    /** 停止后迟到结果不能再写共享状态。 */
    stop: (): void => {
      stopped = true;
    },
  };
}

/** 路由只依赖精确本地确认，不获得任何 Hermes mutation 能力。 */
export type HermesAlerts = ReturnType<typeof createHermesAlerts>;
