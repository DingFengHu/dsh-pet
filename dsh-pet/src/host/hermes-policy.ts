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
export const alertId = z.string().regex(/^hermes-(decision|cron|huniu|claude|claude-fail|win-fail)-[a-f0-9]{64}$/);
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
  issues: z
    .array(z.object({ profile: text, stage: text, code: text }))
    .max(128)
    .default([]),
});
/** 虎妞转发消息的气泡标题。 */
export const HUNIU_TITLE = '虎妞';
/** 虎妞经专用隧道转发的原文，按收到顺序显示，只能本地确认。 */
const huniuPendingSchema = z
  .object({
    id: alertId,
    profile: z.literal('default'),
    kind: z.literal('huniu'),
    title: z.literal(HUNIU_TITLE),
    message: z.string().min(1).max(4096),
    at: z.number().finite(),
  })
  .strict();
/** Hermes 自身提醒只用固定文案。 */
const hermesPendingSchema = z
  .object({
    id: alertId,
    profile,
    kind: z.enum(['decision', 'cron']),
    title: z.enum(['Hermes 需要你确认', 'Hermes 定时任务失败']),
    message: z.enum(['有一项请求等待处理，请查看对话。', '有一次定时任务执行失败，请查看 Hermes。']),
    sessionId: storedId.optional(),
  })
  .strict();
/** 收件目录来的外部提醒：Claude 等你决定 / 定时任务失败、Windows 计划任务失败。 */
export const EXTERNAL_KINDS = ['claude', 'claude-fail', 'win-fail'] as const;
export type ExternalKind = (typeof EXTERNAL_KINDS)[number];
const externalPendingSchema = z
  .object({
    id: alertId,
    profile: z.literal('default'),
    kind: z.enum(EXTERNAL_KINDS),
    title: z.string().min(1).max(200),
    message: z.string().min(1).max(4096),
    at: z.number().finite(),
    /** 生产者会话 id，只用于“用户已回话”时清掉该会话的决定，不生成链接。 */
    session: z.string().max(128).optional(),
  })
  .strict();
/** Host 内部持久化提醒，比共享 UI 契约多带 profile 与 kind。 */
export const pendingSchema = z.union([hermesPendingSchema, huniuPendingSchema, externalPendingSchema]);
/** 自有状态严格验证，不覆盖损坏文件。 */
export const diskSchema = z
  .object({
    stateVersion: z.literal(1),
    dismissed: z.array(alertId).max(2048),
    pending: z.array(pendingSchema).max(512),
    baselineProfiles: z.array(profile).max(32),
    /** dfh.8 的旧字段，只为读旧状态文件保留，不再使用。 */
    huniuBaseline: z.boolean().optional(),
  })
  .strict();
/** Host 持久化状态。 */
export type HermesDisk = z.infer<typeof diskSchema>;
/** 解析后的只读快照。 */
export type HermesSnapshot = z.infer<typeof snapshotSchema>;

/** 构造无分隔歧义的稳定标识。 */
export function makeAlertId(kind: 'decision' | 'cron' | 'huniu' | ExternalKind, parts: readonly string[]): string {
  return `hermes-${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

function validSession(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && storedId.safeParse(value).success ? value : undefined;
}

const KIND_ORDER = { decision: 0, claude: 1, huniu: 2, cron: 3, 'claude-fail': 4, 'win-fail': 4 } as const;

/** 外部提醒（Claude、Windows）只经本地确认或会话回话消失，不进 Hermes 快照折叠。 */
export function isExternalKind(kind: string): kind is ExternalKind {
  return (EXTERNAL_KINDS as readonly string[]).includes(kind);
}

/** 待确认请求在前，虎妞消息居中，各类失败最后；同一档位要么都带时间要么都不带，按时间或 id 排。 */
export function sortPending(entries: HermesDisk['pending']): HermesDisk['pending'] {
  return entries.sort(
    (left, right) =>
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      ('at' in left && 'at' in right ? left.at - right.at : 0) ||
      left.id.localeCompare(right.id),
  );
}

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
  if (dismissed.size > 2048 || pending.size > 512) throw new Error('state-capacity-exceeded');
  for (const entry of snapshot.profiles) {
    if (complete(entry.name, ['profiles', 'discovery', 'gateway', 'jobs'])) baselineProfiles.add(entry.name);
  }
  return diskSchema.parse({
    stateVersion: 1,
    dismissed: [...dismissed],
    pending: sortPending([...pending.values()]),
    baselineProfiles: [...baselineProfiles],
  });
}

/** 只从已验证 stored id 构造 Hermes 深链，不接受 helper 提供的任意 URL。 */
export function alertView(entry: HermesDisk['pending'][number]): {
  id: string;
  title: string;
  message: string;
  url?: string;
} {
  const sessionId = 'sessionId' in entry ? validSession(entry.sessionId) : undefined;
  const url = sessionId && entry.profile === 'default' ? `hermes://open/${encodeURIComponent(sessionId)}` : undefined;
  return {
    id: entry.id,
    title: entry.title,
    message: entry.message,
    ...(url ? { url } : {}),
  };
}
