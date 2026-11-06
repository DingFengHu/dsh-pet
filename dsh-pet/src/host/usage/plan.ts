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
 *
 * @param response - get_usage 的 response。
 * @param now - 当前时间。
 * @returns 快照。
 */
export function summarizeClaudeUsage(response: unknown, now = Date.now()): PlanUsage {
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

/**
 * Claude 套餐额度读取器：上游对用量查询限流（常回 rate_limits: null），失败时沿用上次实时数据
 * （内存 → 落盘缓存 → 桌面端记录，取最新的那份），并在 liveError 里说明，面板据此标注数据时间。
 *
 * @param override - CLI 路径覆盖。
 * @param cacheFile - 上次实时数据的落盘位置（只有额度数字）；null 不落盘。
 * @returns 读取函数。
 */
export function createClaudePlanReader(
  override: string | null,
  cacheFile: string | null = null,
): () => Promise<PlanUsage> {
  let lastLive: PlanUsage | null = null;
  let loaded = false;
  return async () => {
    try {
      lastLive = await readClaudeCli(override);
      if (cacheFile) await writeFile(cacheFile, JSON.stringify(lastLive), 'utf8').catch(() => undefined);
      return lastLive;
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取失败';
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
      const desktop = await readClaudeDesktop();
      const best = lastLive && (!desktop || lastLive.updatedAt > desktop.updatedAt) ? lastLive : desktop;
      if (best) return { ...best, liveError: message };
      throw error;
    }
  };
}
