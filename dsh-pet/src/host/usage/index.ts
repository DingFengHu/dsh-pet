/**
 * 用量服务：把五个来源（Codex / Claude 套餐、Codex / Claude API、DeepSeek）装进各自的缓存外壳，
 * 对外只给一份快照。面板打开时由页面轮询驱动；面板关着时只做后台预热（startBackground）：
 * 定时刷新不开浏览器标签的来源（Codex / Claude 套餐、DeepSeek），点开面板即是新数。
 * 走专用 Chrome 标签的来源（Codex API 的赠送额度、Claude API）仍只在面板打开时读取。
 * @module dsh-pet/src/host/usage/index
 */
import { join } from 'node:path';

import {
  createClaudeApiReader,
  createCodexApiReader,
  createDeepSeekReader,
  readOpenAiGrants,
  type ApiUsage,
  type DeepSeekBalance,
} from './api-keys.ts';
import { loadUsageConfig, type UsageConfig } from './config.ts';
import { createClaudePlanReader, createClaudeTokenProbe, readCodexPlan, type PlanUsage } from './plan.ts';
import { createLazySecret } from './secrets.ts';
import { createSource, type Source, type SourceSnapshot } from './source.ts';

/** 面板拿到的整份快照。 */
export interface UsageSnapshot {
  readonly codex: SourceSnapshot<PlanUsage>;
  readonly claude: SourceSnapshot<PlanUsage>;
  readonly codexApi: SourceSnapshot<ApiUsage>;
  readonly claudeApi: SourceSnapshot<ApiUsage>;
  readonly deepseek: SourceSnapshot<DeepSeekBalance>;
  readonly generatedAt: number;
}

/** 用量服务。 */
export interface UsageService {
  /**
   * 触发到期来源的读取，最多等 waitMs 让快的来源先回来，然后给出快照。
   * @param force - 用户点了刷新：忽略常规节流（仍受每个来源的最短间隔约束）。
   */
  snapshot(force?: boolean, waitMs?: number): Promise<UsageSnapshot>;
  /** 后台预热：只刷新到期的、不开浏览器标签的来源（按各来源自身节流）。 */
  warm(): Promise<void>;
  /**
   * 启动后台预热定时器（unref，不阻止进程退出）。
   * @param intervalMs - 预热间隔。
   * @param firstDelayMs - 首次预热延迟（避开启动高峰）。
   * @returns 停止函数。
   */
  startBackground(intervalMs?: number, firstDelayMs?: number): () => void;
}

/** 来源表。 */
export interface UsageSources {
  readonly codex: Source<PlanUsage>;
  readonly claude: Source<PlanUsage>;
  readonly codexApi: Source<ApiUsage>;
  readonly claudeApi: Source<ApiUsage>;
  readonly deepseek: Source<DeepSeekBalance>;
}

/** 后台预热的默认间隔。 */
export const BACKGROUND_WARM_MS = 3 * 60 * 1000;

const MIN = 60 * 1000;

/**
 * 按配置装配全部来源。
 *
 * @param config - 用量配置。
 * @param cwd - CLI 子进程的工作目录。
 * @returns 来源表。
 */
function buildSources(config: UsageConfig, cwd: string): UsageSources {
  const op = { python: config.python, readerDir: config.opReaderDir };
  const grants = createSource(() => readOpenAiGrants(config.cdpUrl), {
    refreshMs: 6 * 60 * MIN,
    retryMs: 15 * MIN,
    minForceMs: 15 * MIN,
  });
  const readGrants = async (): Promise<{
    data: Awaited<ReturnType<typeof readOpenAiGrants>> | null;
    error: string | null;
  }> => {
    await grants.ensure();
    const s = grants.peek();
    return { data: s.data, error: s.error };
  };
  return {
    codex: createSource(() => readCodexPlan(config.codexCli, cwd), {
      refreshMs: MIN,
      retryMs: 15000,
      minForceMs: 10000,
    }),
    claude: createSource(
      createClaudePlanReader(config.claudeCli, join(cwd, 'usage-claude-last.json'), {
        tokenProbe: config.claudeOauthItem
          ? createClaudeTokenProbe(createLazySecret(op, config.claudeOauthItem, 'Claude 长期令牌'))
          : undefined,
      }),
      {
        refreshMs: MIN,
        retryMs: MIN,
        minForceMs: 30000,
      },
    ),
    codexApi: createSource(
      createCodexApiReader(config, createLazySecret(op, config.openaiAdminItem, 'OpenAI Admin Key'), readGrants),
      {
        refreshMs: 10 * MIN,
        retryMs: 2 * MIN,
        minForceMs: MIN,
      },
    ),
    claudeApi: createSource(createClaudeApiReader(config), { refreshMs: 10 * MIN, retryMs: 2 * MIN, minForceMs: MIN }),
    deepseek: createSource(createDeepSeekReader(createLazySecret(op, config.deepseekItem, 'DeepSeek API Key')), {
      refreshMs: MIN,
      retryMs: 30000,
      minForceMs: 10000,
    }),
  };
}

/**
 * 创建用量服务。配置在首次使用时读取一次；改 usage.json 后重启大肥鱼生效。
 *
 * @param userRoot - 插件数据根（~/.dsh/dsh-pet），usage.json 在这里，也作 CLI 工作目录。
 * @returns 用量服务。
 */
export function createUsageService(userRoot: string): UsageService {
  return createUsageServiceFrom(() => loadUsageConfig(userRoot).then((config) => buildSources(config, userRoot)));
}

/**
 * 用给定的来源装配创建用量服务（测试注入）。
 *
 * @param load - 惰性装配来源表，只调用一次。
 * @returns 用量服务。
 */
export function createUsageServiceFrom(load: () => Promise<UsageSources>): UsageService {
  let sources: Promise<UsageSources> | null = null;
  const get = (): Promise<UsageSources> => (sources ??= load());
  const service: UsageService = {
    async snapshot(force = false, waitMs = 1500) {
      const s = await get();
      const all = [s.codex, s.claude, s.codexApi, s.claudeApi, s.deepseek];
      const pending = Promise.allSettled(all.map((src) => src.ensure(force)));
      await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
      return {
        codex: s.codex.peek(),
        claude: s.claude.peek(),
        codexApi: s.codexApi.peek(),
        claudeApi: s.claudeApi.peek(),
        deepseek: s.deepseek.peek(),
        generatedAt: Date.now(),
      };
    },
    async warm() {
      const s = await get();
      await Promise.allSettled([s.codex, s.claude, s.deepseek].map((src) => src.ensure(false)));
    },
    startBackground(intervalMs = BACKGROUND_WARM_MS, firstDelayMs = 20000) {
      const tick = (): void => {
        service.warm().catch(() => undefined);
      };
      const first = setTimeout(tick, firstDelayMs);
      const timer = setInterval(tick, intervalMs);
      first.unref?.();
      timer.unref?.();
      return () => {
        clearTimeout(first);
        clearInterval(timer);
      };
    },
  };
  return service;
}
