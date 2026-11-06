/**
 * 用量服务：把五个来源（Codex / Claude 套餐、Codex / Claude API、DeepSeek）装进各自的缓存外壳，
 * 对外只给一份快照。只在面板打开时被轮询驱动，面板关着不会主动访问任何外部接口。
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
import { createClaudePlanReader, readCodexPlan, type PlanUsage } from './plan.ts';
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
}

const MIN = 60 * 1000;

/**
 * 按配置装配全部来源。
 *
 * @param config - 用量配置。
 * @param cwd - CLI 子进程的工作目录。
 * @returns 来源表。
 */
function buildSources(
  config: UsageConfig,
  cwd: string,
): {
  codex: Source<PlanUsage>;
  claude: Source<PlanUsage>;
  codexApi: Source<ApiUsage>;
  claudeApi: Source<ApiUsage>;
  deepseek: Source<DeepSeekBalance>;
} {
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
    claude: createSource(createClaudePlanReader(config.claudeCli, join(cwd, 'usage-claude-last.json')), {
      refreshMs: MIN,
      retryMs: MIN,
      minForceMs: 30000,
    }),
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
  let sources: Promise<ReturnType<typeof buildSources>> | null = null;
  return {
    async snapshot(force = false, waitMs = 1500) {
      sources ??= loadUsageConfig(userRoot).then((config) => buildSources(config, userRoot));
      const s = await sources;
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
  };
}
