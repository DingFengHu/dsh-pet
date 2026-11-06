/** Hermes 快照边界与提醒折叠，只输出固定安全文案，不传递请求参数或错误详情。 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const text = z.string().max(256);
const profile = text.min(1);
const row = z.object({ profile });
const storedId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
/** 本地提醒标识只接受完整哈希。 */
export const alertId = z.string().regex(/^hermes-(decision|cron|huniu)-[a-f0-9]{64}$/);
/** 跨进程快照只保留提醒所需投影，数组均有上限。 */
export const snapshotSchema = z.object({
  profiles: z.array(z.object({ name: profile, available: z.boolean(), baseUrl: text.optional() })).max(32),
  decisions: z.array(row.extend({ sessionId: text, requestId: text, method: text })).max(512),
  jobs: z
    .array(
      row.extend({
        id: text,
        last_status: text.nullish(),
        last_run_at: z.union([text, z.number()]).nullish(),
        last_failure_at: text.optional(),
        canonical_completions: z.array(text).max(512).optional(),
      }),
    )
    .max(512),
  runs: z
    .array(
      row.extend({
        jobId: text,
        runs: z.array(z.object({ sessionId: text.nullish(), cron_execution_id: text.optional() })).max(5),
      }),
    )
    .max(512),
  incomplete: z.boolean(),
  /** 虎妞桥接只给来信 id 与时间，不含正文；缺省表示未配置。 */
  huniu: z
    .object({
      available: z.boolean(),
      sessionId: text.nullish(),
      messages: z.array(z.object({ id: text.min(1), created: z.number() })).max(64),
    })
    .optional(),
  issues: z
    .array(z.object({ profile: text, stage: text, code: text }))
    .max(128)
    .default([]),
});
/** 虎妞来信固定文案，不搬运正文。 */
export const HUNIU_TITLE = '虎妞发来消息';
export const HUNIU_MESSAGE = '虎妞有一条新消息，请查看「虎妞协作」对话。';
/** Host 内部持久化提醒，比共享 UI 契约多带 profile 与 kind。 */
export const pendingSchema = z
  .object({
    id: alertId,
    profile,
    kind: z.enum(['decision', 'cron', 'huniu']),
    title: z.enum(['Hermes 需要你确认', 'Hermes 定时任务失败', HUNIU_TITLE]),
    message: z.enum(['有一项请求等待处理，请查看对话。', '有一次定时任务执行失败，请查看 Hermes。', HUNIU_MESSAGE]),
    sessionId: storedId.optional(),
  })
  .strict();
/** 自有状态严格验证，不覆盖损坏文件。 */
export const diskSchema = z
  .object({
    stateVersion: z.literal(1),
    dismissed: z.array(alertId).max(2048),
    pending: z.array(pendingSchema).max(512),
    baselineProfiles: z.array(profile).max(32),
    /** 首次读到虎妞账本时把既有来信记为已读，不批量弹旧消息。 */
    huniuBaseline: z.boolean().optional(),
  })
  .strict();
/** Host 持久化状态。 */
export type HermesDisk = z.infer<typeof diskSchema>;
/** 解析后的只读快照。 */
export type HermesSnapshot = z.infer<typeof snapshotSchema>;

/** 构造无分隔歧义的稳定标识。 */
export function makeAlertId(kind: 'decision' | 'cron' | 'huniu', parts: readonly string[]): string {
  return `hermes-${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

function validSession(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && storedId.safeParse(value).success ? value : undefined;
}

const KIND_ORDER = { decision: 0, huniu: 1, cron: 2 } as const;

/** 把完整 profile 的决策替换，部分 profile 保留旧行，cron 失败只经本地确认消失。 */
export function foldSnapshot(previous: HermesDisk, snapshot: HermesSnapshot): HermesDisk {
  const dismissed = new Set(previous.dismissed);
  const baselineProfiles = new Set(previous.baselineProfiles);
  const complete = (name: string, stages: readonly string[]): boolean =>
    snapshot.profiles.some((entry) => entry.name === name && entry.available) &&
    !snapshot.issues.some((issue) => (issue.profile === name || issue.profile === '') && stages.includes(issue.stage));
  const pending = new Map(
    previous.pending
      .filter(
        (entry) =>
          entry.kind !== 'decision' || !complete(entry.profile, ['profiles', 'discovery', 'gateway', 'decisions']),
      )
      .map((entry) => [entry.id, entry]),
  );
  for (const decision of snapshot.decisions) {
    const unresolvedWaiting =
      decision.method === 'waiting' &&
      /^waiting:[a-f0-9]{32}$/.test(decision.requestId) &&
      snapshot.incomplete &&
      snapshot.issues.some(
        (issue) => issue.profile === decision.profile && issue.stage === 'decisions' && issue.code === 'replay_gap',
      );
    if (
      (!['approval', 'clarify'].includes(decision.method) && !unresolvedWaiting) ||
      !decision.requestId ||
      !decision.sessionId
    )
      continue;
    const id = makeAlertId('decision', [decision.profile, decision.sessionId, decision.requestId]);
    const sessionId = validSession(decision.sessionId);
    if (!dismissed.has(id))
      pending.set(id, {
        id,
        profile: decision.profile,
        kind: 'decision',
        title: 'Hermes 需要你确认',
        message: '有一项请求等待处理，请查看对话。',
        ...(sessionId ? { sessionId } : {}),
      });
  }
  for (const job of snapshot.jobs) {
    if (!job.id) continue;
    const failures: { at: string; kind: string }[] = [];
    // sticky agent failure 与当前投递/配置失败是不同事件，不让旧 tombstone 吞掉新故障。
    if (job.last_failure_at) failures.push({ at: job.last_failure_at, kind: 'failure' });
    const status = job.last_status ?? '';
    const runAt = job.last_run_at;
    const trustworthyRunAt =
      typeof runAt === 'number'
        ? Number.isFinite(runAt) && runAt > 0
        : typeof runAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(runAt) && Number.isFinite(Date.parse(runAt));
    if (
      trustworthyRunAt &&
      (['delivery_failed', 'blocked_config'].includes(status) ||
        (!job.last_failure_at && ['error', 'failed'].includes(status)))
    )
      failures.push({ at: String(runAt), kind: status });
    for (const failure of failures) {
      const id = makeAlertId('cron', [job.profile, job.id, failure.at, failure.kind]);
      if (!baselineProfiles.has(job.profile)) {
        dismissed.add(id);
        continue;
      }
      if (dismissed.has(id) || pending.has(id)) continue;
      const completions = job.canonical_completions;
      const executionId = completions?.[completions.length - 1];
      // 只有当前 canonical completion 的不可变 execution ID 能证明 session 归属。
      // 较早 sticky failure 在后来成功后不靠时间邻近或历史数组位置猜链接。
      const matches =
        executionId && String(runAt ?? '') === failure.at
          ? snapshot.runs
              .filter((entry) => entry.profile === job.profile && entry.jobId === job.id)
              .flatMap((entry) => entry.runs)
              .filter((run) => run.cron_execution_id === executionId)
          : [];
      const sessionId = matches.length === 1 ? validSession(matches[0]!.sessionId) : undefined;
      pending.set(id, {
        id,
        profile: job.profile,
        kind: 'cron',
        title: 'Hermes 定时任务失败',
        message: '有一次定时任务执行失败，请查看 Hermes。',
        ...(sessionId ? { sessionId } : {}),
      });
    }
  }
  const huniu = snapshot.huniu;
  let huniuBaseline = previous.huniuBaseline === true;
  if (huniu?.available) {
    const sessionId = validSession(huniu.sessionId);
    for (const message of huniu.messages) {
      const id = makeAlertId('huniu', [message.id]);
      if (!huniuBaseline) {
        dismissed.add(id);
        continue;
      }
      if (dismissed.has(id) || pending.has(id)) continue;
      pending.set(id, {
        id,
        profile: 'default',
        kind: 'huniu',
        title: HUNIU_TITLE,
        message: HUNIU_MESSAGE,
        ...(sessionId ? { sessionId } : {}),
      });
    }
    huniuBaseline = true;
  }
  if (dismissed.size > 2048 || pending.size > 512) throw new Error('state-capacity-exceeded');
  for (const entry of snapshot.profiles) {
    if (complete(entry.name, ['profiles', 'discovery', 'gateway', 'jobs'])) baselineProfiles.add(entry.name);
  }
  return diskSchema.parse({
    stateVersion: 1,
    dismissed: [...dismissed],
    pending: [...pending.values()].sort(
      (left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || left.id.localeCompare(right.id),
    ),
    baselineProfiles: [...baselineProfiles],
    ...(huniuBaseline ? { huniuBaseline } : {}),
  });
}

/** 只从已验证 stored id 构造 Hermes 深链，不接受 helper 提供的任意 URL。 */
export function alertView(entry: HermesDisk['pending'][number]): {
  id: string;
  title: string;
  message: string;
  url?: string;
} {
  const sessionId = validSession(entry.sessionId);
  const url = sessionId && entry.profile === 'default' ? `hermes://open/${encodeURIComponent(sessionId)}` : undefined;
  return {
    id: entry.id,
    title: entry.title,
    message: entry.message,
    ...(url ? { url } : {}),
  };
}
