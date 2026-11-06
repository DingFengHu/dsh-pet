/**
 * 套餐额度（订阅窗口）：Codex 走 `codex app-server` 的 account/rateLimits/read，
 * Claude 走 Claude Code CLI 的 get_usage 控制请求（不发模型请求），读不到时回落桌面端的用量记录。
 *
 * 两个 CLI 自己管登录，本模块不读、不传任何凭据。
 * @module dsh-pet/src/host/usage/plan
 */
import { spawn } from 'node:child_process';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { LazySecret } from './secrets.ts';
import { arr, obj, type Loose } from './source.ts';

/** 一个额度窗口。 */
export interface PlanWindow {
  /** 剩余百分比 0-100。 */
  readonly remainingPercent: number;
  /** 已用百分比。 */
  readonly usedPercent: number;
  /** 重置时间（秒级 Unix 时间戳）；未知为 null。 */
  readonly resetsAt: number | null;
}

/** 套餐额度快照。 */
export interface PlanUsage {
  /** 5 小时窗口。 */
  readonly fiveHour: PlanWindow | null;
  /** 周窗口。 */
  readonly weekly: PlanWindow | null;
  /** 套餐名（如 pro）。 */
  readonly plan: string | null;
  /** 数据来源。 */
  readonly source: string;
  /** 数据时间（ms）。 */
  readonly updatedAt: number;
  /** 实时读取失败、展示的是回落数据时的原因。 */
  readonly liveError?: string;
}

const clampPct = (used: number): PlanWindow['remainingPercent'] => Math.max(0, Math.min(100, 100 - used));

/**
 * Codex rateLimits 应答 → 快照。
 *
 * @param result - account/rateLimits/read 的 result。
 * @param now - 当前时间。
 * @returns 快照。
 */
export function summarizeCodex(result: unknown, now = Date.now()): PlanUsage {
  const r = obj(result);
  const bucket = obj(r.rateLimitsByLimitId ? obj(r.rateLimitsByLimitId).codex : r.rateLimits);
  const pick = (minutes: number): PlanWindow | null => {
    const w = [bucket.primary, bucket.secondary].map(obj).find((x) => x.windowDurationMins === minutes);
    if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null;
    return {
      remainingPercent: clampPct(w.usedPercent),
      usedPercent: w.usedPercent,
      resetsAt: typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null,
    };
  };
  const fiveHour = pick(300);
  const weekly = pick(10080);
  if (!fiveHour && !weekly) throw new Error('Codex 没有返回可用的额度数据。');
  return {
    fiveHour,
    weekly,
    plan: typeof bucket.planType === 'string' ? bucket.planType : null,
    source: 'codex-cli',
    updatedAt: now,
  };
}

/**
 * 跑一个按行 JSON 对话的 CLI，直到 onLine 给出结果或超时。
 *
 * @param cli - 可执行文件。
 * @param args - 参数。
 * @param options - cwd、env、超时与首条消息。
 * @param onLine - 每行回调：返回 undefined 继续等，返回值或抛错即结束。
 * @returns onLine 的结果。
 */
function talk<T>(
  cli: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; first: Loose; label: string },
  onLine: (message: Loose, send: (m: Loose) => void) => T | undefined,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = createInterface({ input: child.stdout as unknown as NodeJS.ReadableStream });
    let done = false;
    const finish = (error: Error | null, value?: T): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new Error(`${options.label} 额度查询超时。`)), options.timeoutMs);
    const send = (m: Loose): void => {
      child.stdin.write(JSON.stringify(m) + '\n');
    };
    child.on('error', () => finish(new Error(`无法启动 ${options.label} CLI。`)));
    child.stdin.on('error', () => finish(new Error(`${options.label} 查询连接已断开。`)));
    child.on('exit', () => finish(new Error(`${options.label} 在返回额度前退出，请检查登录状态。`)));
    lines.on('line', (line) => {
      let message: Loose;
      try {
        message = obj(JSON.parse(line));
      } catch {
        return;
      }
      try {
        const value = onLine(message, send);
        if (value !== undefined) finish(null, value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    send(options.first);
  });
}

/**
 * 读 Codex 套餐额度（超时自动再试一次）。
 *
 * @param cliOverride - CLI 路径覆盖。
 * @param cwd - 子进程工作目录。
 * @returns 快照。
 */
export async function readCodexPlan(cliOverride: string | null, cwd: string): Promise<PlanUsage> {
  const cli = cliOverride ?? join(process.env.LOCALAPPDATA ?? '', 'Programs/OpenAI/Codex/bin/codex.exe');
  const once = (): Promise<PlanUsage> =>
    talk(
      cli,
      ['app-server', '--stdio'],
      {
        cwd,
        timeoutMs: 12000,
        label: 'Codex',
        first: {
          id: 1,
          method: 'initialize',
          params: {
            clientInfo: { name: 'dsh_pet_usage', title: 'dsh-pet usage', version: '1.0.0' },
            capabilities: null,
          },
        },
      },
      (m, send) => {
        if (m.error && (m.id === 1 || m.id === 2)) throw new Error('无法读取 Codex 额度，请确认 Codex CLI 已登录。');
        if (m.id === 1 && m.result) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (m.id === 2 && m.result) return summarizeCodex(m.result);
        return undefined;
      },
    );
  try {
    return await once();
  } catch (error) {
    if (error instanceof Error && /超时/.test(error.message)) return once();
    throw error;
  }
}

// ---------------------------------------------------------------- Claude

/** Claude 桌面端是 MSIX 包：数据目录在包的 LocalCache 下，外部进程两处都要找。 */
async function claudeDataDirs(): Promise<string[]> {
  const dirs: string[] = [];
  const packages = join(process.env.LOCALAPPDATA ?? '', 'Packages');
  for (const name of await readdir(packages).catch(() => [] as string[]))
    if (name.startsWith('Claude_')) dirs.push(join(packages, name, 'LocalCache/Roaming/Claude'));
  dirs.push(join(process.env.APPDATA ?? '', 'Claude'));
  return dirs;
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

/** 优先独立安装的 Claude Code，否则用桌面端自带的最新 CLI。 */
async function findClaudeCli(override: string | null): Promise<string> {
  if (override) return override;
  const standalone = join(process.env.USERPROFILE ?? '', '.local/bin/claude.exe');
  if (await exists(standalone)) return standalone;
  for (const dir of await claudeDataDirs()) {
    const root = join(dir, 'claude-code');
    const versions = (await readdir(root).catch(() => [] as string[])).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    );
    for (const version of versions)
      for (const hash of await readdir(join(root, version)).catch(() => [] as string[])) {
        const exe = join(root, version, hash, 'claude.exe');
        if (await exists(exe)) return exe;
      }
  }
  throw new Error('未找到 Claude Code CLI。');
}

/**
 * Claude get_usage 应答 → 快照；对结构变化宽容（按 five_hour / seven_day 键名深搜）。
 * rate_limits_available 为 false 说明 CLI 没有登录订阅账号（凭据失效或被清空），直接报未登录。
 *
 * @param response - get_usage 的 response。
 * @param now - 当前时间。
 * @returns 快照。
 */
export function summarizeClaudeUsage(response: unknown, now = Date.now()): PlanUsage {
  const body = obj(response);
  if (body.rate_limits_available === false)
    throw new Error(
      body.subscription_type
        ? 'Claude 账号没有套餐额度数据。'
        : 'Claude CLI 未登录，在终端运行 claude auth login 重新登录。',
    );
  const found: Record<string, Loose> = {};
  const visit = (value: unknown, key: string): void => {
    if (!value || typeof value !== 'object') return;
    if ((key === 'five_hour' || key === 'seven_day') && !found[key]) found[key] = value as Loose;
    for (const [k, v] of Object.entries(value as Loose)) visit(v, k);
  };
  visit(response, '');
  const pick = (w: Loose | undefined): PlanWindow | null => {
    if (!w) return null;
    const used = w.utilization ?? w.used_percentage ?? w.percent_used;
    if (typeof used !== 'number' || !Number.isFinite(used)) return null;
    const reset = w.resets_at ?? w.resetsAt;
    const resetsAt =
      typeof reset === 'number'
        ? reset > 1e12
          ? Math.round(reset / 1000)
          : reset
        : typeof reset === 'string'
          ? Math.round(Date.parse(reset) / 1000)
          : null;
    return {
      remainingPercent: clampPct(used),
      usedPercent: used,
      resetsAt: resetsAt !== null && Number.isFinite(resetsAt) ? resetsAt : null,
    };
  };
  const fiveHour = pick(found.five_hour);
  const weekly = pick(found.seven_day);
  if (!fiveHour && !weekly) throw new Error('Claude CLI 没有返回套餐额度。');
  return { fiveHour, weekly, plan: null, source: 'claude-cli', updatedAt: now };
}

/**
 * 桌面端 plan-usage-history.json → 快照（没有重置时间）。
 *
 * @param history - 记录文件内容。
 * @returns 快照。
 */
export function summarizeClaudeHistory(history: unknown): PlanUsage {
  const samples = arr(obj(history).samples)
    .map(obj)
    .filter((s) => typeof s.t === 'number' && Number.isFinite(s.t) && s.u);
  if (!samples.length) throw new Error('Claude 桌面端暂未记录用量。');
  const latest = samples.reduce((a, b) => ((b.t as number) > (a.t as number) ? b : a));
  const u = obj(latest.u);
  const pick = (used: unknown): PlanWindow | null =>
    typeof used === 'number' && used >= 0 && used <= 100
      ? { remainingPercent: 100 - used, usedPercent: used, resetsAt: null }
      : null;
  const fiveHour = pick(u.fh);
  const weekly = pick(u.sd);
  if (!fiveHour && !weekly) throw new Error('Claude 用量记录格式无法识别。');
  return { fiveHour, weekly, plan: null, source: 'claude-desktop', updatedAt: latest.t as number };
}

/**
 * 模型应答头 anthropic-ratelimit-unified-* → 快照。利用率是 0-1 的小数，重置时间是秒级时间戳。
 *
 * @param headers - 应答头。
 * @param now - 当前时间。
 * @returns 快照。
 */
export function summarizeClaudeHeaders(headers: Headers, now = Date.now()): PlanUsage {
  const pick = (window: string): PlanWindow | null => {
    const raw = headers.get(`anthropic-ratelimit-unified-${window}-utilization`);
    const util = raw === null ? Number.NaN : Number.parseFloat(raw);
    if (!Number.isFinite(util)) return null;
    const used = Math.round(util * 1000) / 10;
    const reset = Number.parseInt(headers.get(`anthropic-ratelimit-unified-${window}-reset`) ?? '', 10);
    return { remainingPercent: clampPct(used), usedPercent: used, resetsAt: Number.isFinite(reset) ? reset : null };
  };
  const fiveHour = pick('5h');
  const weekly = pick('7d');
  if (!fiveHour && !weekly) throw new Error('Claude 应答里没有额度信息。');
  return { fiveHour, weekly, plan: null, source: 'claude-token', updatedAt: now };
}

/** 令牌探针用的地址与模型：最便宜的模型、1 个输出 token。 */
const PROBE_URL = 'https://api.anthropic.com/v1/messages';
const PROBE_MODEL = 'claude-haiku-4-5';

/**
 * 用长期 OAuth 令牌（claude setup-token）读额度。这种令牌没有 user:profile 权限，读不了额度接口，
 * 只能发一次极小的模型请求（1 个输出 token），从应答头取额度；会消耗极少量订阅额度。
 *
 * @param token - 令牌（1Password，只放内存）。
 * @param fetchImpl - fetch（测试注入）。
 * @returns 读取函数。
 */
export function createClaudeTokenProbe(token: LazySecret, fetchImpl: typeof fetch = fetch): () => Promise<PlanUsage> {
  return async () => {
    // 从终端复制的令牌常夹带换行，去掉所有空白。
    const key = (await token.get()).replace(/\s+/g, '');
    let response: Response;
    try {
      response = await fetchImpl(PROBE_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'content-type': 'application/json',
          'user-agent': 'dsh-pet-usage',
        },
        body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      throw new Error('Claude 令牌查询连接失败。');
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      token.forget();
      throw new Error('Claude 长期令牌无效或已过期，请重新运行 claude setup-token 并更新 1Password。');
    }
    if (!response.ok && response.status !== 429) throw new Error(`Claude 令牌查询失败（HTTP ${response.status}）。`);
    return summarizeClaudeHeaders(response.headers);
  };
}

async function readClaudeCli(override: string | null): Promise<PlanUsage> {
  const cli = await findClaudeCli(override);
  const cwd = process.env.USERPROFILE ?? process.cwd();
  return talk(
    cli,
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    {
      cwd,
      env: { ...process.env, CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
      timeoutMs: 20000,
      label: 'Claude',
      first: { type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } },
    },
    (m, send) => {
      if (m.type !== 'control_response') return undefined;
      const response = obj(m.response);
      if (response.request_id === 'init') {
        if (response.subtype === 'error') throw new Error('Claude CLI 初始化失败。');
        send({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } });
      } else if (response.request_id === 'usage') {
        if (response.subtype === 'error') throw new Error('Claude 额度读取失败。');
        const body = obj(response.response);
        if (body.rate_limits === null && body.rate_limits_available === true)
          throw new Error('Claude 额度接口暂时限流，稍后自动重试。');
        return summarizeClaudeUsage(body);
      }
      return undefined;
    },
  );
}

async function readClaudeDesktop(): Promise<PlanUsage | null> {
  for (const dir of await claudeDataDirs()) {
    try {
      return summarizeClaudeHistory(JSON.parse(await readFile(join(dir, 'plan-usage-history.json'), 'utf8')));
    } catch {
      /* 下一处 */
    }
  }
  return null;
}

/** 令牌探针的最短间隔：每次都是一次真实模型请求，所以最多每 15 分钟一次。 */
export const TOKEN_PROBE_MIN_MS = 15 * 60 * 1000;

/** createClaudePlanReader 的可选项。 */
export interface ClaudePlanReaderOptions {
  /** CLI 读不到时的令牌探针；未配置令牌时不传。 */
  readonly tokenProbe?: () => Promise<PlanUsage>;
  /** 探针最短间隔（ms）。 */
  readonly probeMinMs?: number;
  /** CLI 读取（测试注入）。 */
  readonly readCli?: () => Promise<PlanUsage>;
  /** 桌面端记录读取（测试注入）。 */
  readonly readDesktop?: () => Promise<PlanUsage | null>;
  /** 时钟（测试注入）。 */
  readonly now?: () => number;
}

/**
 * Claude 套餐额度读取器：先走 CLI 的 get_usage；读不到（限流、CLI 未登录）时，若配置了长期令牌，
 * 按节流发一次令牌探针。都不行就沿用上次实时数据（内存 → 落盘缓存 → 桌面端记录，取最新的那份），
 * 并在 liveError 里说明，面板据此标注数据时间。节流期内上次探针结果仍新鲜时直接返回它，不算过期。
 *
 * @param override - CLI 路径覆盖。
 * @param cacheFile - 上次实时数据的落盘位置（只有额度数字）；null 不落盘。
 * @param options - 令牌探针与测试注入。
 * @returns 读取函数。
 */
export function createClaudePlanReader(
  override: string | null,
  cacheFile: string | null = null,
  options: ClaudePlanReaderOptions = {},
): () => Promise<PlanUsage> {
  const now = options.now ?? Date.now;
  const probeMinMs = options.probeMinMs ?? TOKEN_PROBE_MIN_MS;
  const readCli = options.readCli ?? (() => readClaudeCli(override));
  const readDesktop = options.readDesktop ?? readClaudeDesktop;
  let lastLive: PlanUsage | null = null;
  let loaded = false;
  let probeAt = Number.NEGATIVE_INFINITY;
  const remember = async (value: PlanUsage): Promise<PlanUsage> => {
    lastLive = value;
    if (cacheFile) await writeFile(cacheFile, JSON.stringify(value), 'utf8').catch(() => undefined);
    return value;
  };
  return async () => {
    try {
      return await remember(await readCli());
    } catch (error) {
      let message = error instanceof Error ? error.message : '读取失败';
      if (options.tokenProbe) {
        if (now() - probeAt >= probeMinMs) {
          probeAt = now();
          try {
            return await remember({ ...(await options.tokenProbe()), updatedAt: now() });
          } catch (probeError) {
            message += ' 长期令牌兜底也失败：' + (probeError instanceof Error ? probeError.message : '读取失败');
          }
        } else if (lastLive?.source === 'claude-token' && now() - lastLive.updatedAt <= probeMinMs + 5 * 60 * 1000) {
          return lastLive;
        }
      }
      if (!lastLive && !loaded && cacheFile) {
        loaded = true;
        try {
          const saved = obj(JSON.parse(await readFile(cacheFile, 'utf8')));
          if (typeof saved.updatedAt === 'number' && (saved.weekly || saved.fiveHour))
            lastLive = saved as unknown as PlanUsage;
        } catch {
          /* 没有缓存 */
        }
      }
      const desktop = await readDesktop();
      const best = lastLive && (!desktop || lastLive.updatedAt > desktop.updatedAt) ? lastLive : desktop;
      if (best) return { ...best, liveError: message };
      throw error;
    }
  };
}
