/**
 * Hermes 快照边界与提醒折叠。标题带对话名或任务名，正文是 Hermes 自己卡片上已脱敏的问题、
 * 审批说明或失败原因（2026-11-14 起，与 Claude 提醒同款）；认证票据、任务提示词与异常原文仍不传递。
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const text = z.string().max(256);
/** helper 按码点截断，这里按 UTF-16 留一倍余量，折叠时再截到显示长度。 */
const label = z.string().max(512);
const body = z.string().max(2048);
const profile = text.min(1);
const row = z.object({ profile });
const storedId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
/** 本地提醒标识只接受完整哈希。 */
export const alertId = z
  .string()
  .regex(/^hermes-(decision|cron|huniu|claude|claude-fail|win-fail|dsh|dsh-fail)-[a-f0-9]{64}$/);
/** 跨进程快照只保留提醒所需投影，数组均有上限。 */
export const snapshotSchema = z.object({
  profiles: z.array(z.object({ name: profile, available: z.boolean(), baseUrl: text.optional() })).max(32),
  decisions: z
    .array(
      row.extend({
        sessionId: text,
        requestId: text,
        method: text,
        /** 会话标题与等待处理的内容（问题原文、审批说明），缺失时退回泛化文案。 */
        title: label.optional(),
        text: body.optional(),
      }),
    )
    .max(512),
  jobs: z
    .array(
      row.extend({
        id: text,
        last_status: text.nullish(),
        last_run_at: z.union([text, z.number()]).nullish(),
        last_failure_at: text.optional(),
        /** 任务名与失败原因，只有提醒候选任务才带原因。 */
        name: label.nullish(),
        failure_detail: body.optional(),
        last_error: body.optional(),
        last_delivery_error: body.optional(),
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
/** 等待处理的请求缺正文、定时任务缺失败原因时的兜底文案。 */
export const DECISION_FALLBACK = '有一项请求等待处理，请查看对话。';
export const CRON_FALLBACK = '有一次定时任务执行失败，请查看 Hermes。';
/** Hermes 自身提醒：标题带对话名或任务名，正文是问题原文、审批说明或失败原因。旧状态文件里的固定文案同样合法。 */
const hermesPendingSchema = z
  .object({
    id: alertId,
    profile,
    kind: z.enum(['decision', 'cron']),
    title: z.string().min(1).max(200),
    message: z.string().min(1).max(4096),
    sessionId: storedId.optional(),
  })
  .strict();
/** 收件目录来的外部提醒：Claude / DSH 等你决定或任务失败、Windows 计划任务失败。 */
export const EXTERNAL_KINDS = ['claude', 'claude-fail', 'win-fail', 'dsh', 'dsh-fail'] as const;
export type ExternalKind = (typeof EXTERNAL_KINDS)[number];
const externalPendingSchema = z
  .object({
    id: alertId,
    profile: z.literal('default'),
    kind: z.enum(EXTERNAL_KINDS),
    title: z.string().min(1).max(200),
    message: z.string().min(1).max(4096),
    at: z.number().finite(),
    /** 生产者会话 id，只用于“用户已回话”时清掉该会话的决定，不拼进链接（DSH 提醒固定打开 `dsh://open`）。 */
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

/** 统一换行，去掉 Discord 提及和 Hermes 的 `[blocked_config…]` 控制标记，截断到显示长度（不切开代理对）。 */
function clip(value: string | null | undefined, limit: number): string {
  const cleaned = (value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<@[!&]?\d+>/g, '')
    .replace(/\[blocked_config[^\]]*\]\s*/g, '')
    .trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : cleaned;
}

const DECISION_NEED: Record<string, string> = { approval: '需要你批准', clarify: '需要你决定' };

const KIND_ORDER = {
  decision: 0,
  claude: 1,
  dsh: 1,
  huniu: 2,
  cron: 3,
  'claude-fail': 4,
  'win-fail': 4,
  'dsh-fail': 4,
} as const;

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
        title: `Hermes 中“${clip(decision.title, 80) || '未命名'}”的这个任务${DECISION_NEED[decision.method] ?? '需要你处理'}`,
        message: clip(decision.text, 1200) || DECISION_FALLBACK,
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
    // Hermes 给配置被拦、投递失败的那次运行也记一条同时间戳的 sticky failure：同一次运行只提醒一条。
    const sameRun = !!job.last_failure_at && String(runAt) === job.last_failure_at;
    if (
      trustworthyRunAt &&
      ((['delivery_failed', 'blocked_config'].includes(status) && !sameRun) ||
        (!job.last_failure_at && ['error', 'failed'].includes(status)))
    )
      failures.push({ at: String(runAt), kind: status });
    for (const failure of failures) {
      const id = makeAlertId('cron', [job.profile, job.id, failure.at, failure.kind]);
      if (!baselineProfiles.has(job.profile)) {
        dismissed.add(id);
        continue;
      }
      if (dismissed.has(id)) continue;
      const name = clip(job.name, 80);
      const reason =
        failure.kind === 'failure'
          ? job.failure_detail
          : failure.kind === 'delivery_failed'
            ? job.last_delivery_error || job.last_error
            : job.last_error || job.last_delivery_error;
      const words = {
        title: name ? `Hermes 定时任务失败 · ${name}` : 'Hermes 定时任务失败',
        message: clip(reason, 1200) || CRON_FALLBACK,
      };
      const existing = pending.get(id);
      if (existing) {
        // 同一次失败只补全文字（升级前留下的固定文案、上一轮没读到名字或原因），读不到的不冲掉已有的；
        // 会话关联保持首次判定。
        if (existing.kind === 'cron')
          pending.set(id, {
            ...existing,
            ...(name ? { title: words.title } : {}),
            ...(words.message !== CRON_FALLBACK ? { message: words.message } : {}),
          });
        continue;
      }
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
        ...words,
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
  // DSH 提醒的“查看对话”：DSH 没有按会话的深链（Windows 上任何 dsh:// 都只聚焦主窗口），
  // 所以固定打开 DSH 主窗口；气泡标题已带会话名，用户在侧栏点开即可。
  const url =
    entry.kind === 'dsh' || entry.kind === 'dsh-fail'
      ? 'dsh://open'
      : sessionId && entry.profile === 'default'
        ? `hermes://open/${encodeURIComponent(sessionId)}`
        : undefined;
  return {
    id: entry.id,
    title: entry.title,
    message: entry.message,
    ...(url ? { url } : {}),
  };
}
