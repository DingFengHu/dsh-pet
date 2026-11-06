/**
 * 用量面板的本机私有配置：`~/.dsh/dsh-pet/usage.json`。
 *
 * 只放标识符（1Password 条目 ID、Claude Console 组织 ID、读取器目录），从不放凭据本身；
 * 仓库是公开的，所以这些本机标识不进代码。缺项时对应来源显示「未配置」，不影响其他来源。
 * @module dsh-pet/src/host/usage/config
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { obj } from './source.ts';

/** 赠送额度的兜底配置（来源页面读不到时才用）。 */
export interface CreditFallback {
  /** 每期赠送金额（USD）。 */
  readonly grantUsd: number;
  /** 每月刷新日（纽约时间）。 */
  readonly resetDay: number;
  /** 已知的到期日（UTC 0 点，ms）；之后按月推算。 */
  readonly expiresAt: number | null;
}

/** 解析后的用量配置。 */
export interface UsageConfig {
  /** 1Password 只读读取器（hermes_reader.py）所在目录。 */
  readonly opReaderDir: string | null;
  /** 运行读取器的 Python。 */
  readonly python: string;
  /** DeepSeek API Key 的 1Password 条目 ID。 */
  readonly deepseekItem: string | null;
  /** OpenAI 组织 Admin Key 的 1Password 条目 ID。 */
  readonly openaiAdminItem: string | null;
  /** Claude 长期 OAuth 令牌（claude setup-token）的 1Password 条目 ID；CLI 读不到额度时兜底。 */
  readonly claudeOauthItem: string | null;
  /** Claude Console 组织 ID。 */
  readonly claudeConsoleOrg: string | null;
  /** 已登录 OpenAI / Claude Console 的专用 Chrome 的 CDP 地址。 */
  readonly cdpUrl: string;
  /** Codex CLI 路径覆盖。 */
  readonly codexCli: string | null;
  /** Claude Code CLI 路径覆盖。 */
  readonly claudeCli: string | null;
  /** 赠送额度兜底。 */
  readonly credits: { readonly codex: CreditFallback; readonly claude: CreditFallback };
}

/** 配置文件名（落在插件数据根）。 */
export const USAGE_CONFIG_FILE = 'usage.json';

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * 解析单个赠送额度兜底。
 *
 * @param raw - 原始对象。
 * @returns 合法化后的兜底。
 */
function credit(raw: unknown): CreditFallback {
  const o = obj(raw);
  const grant = typeof o.grantUsd === 'number' && o.grantUsd > 0 ? o.grantUsd : 200;
  const day =
    Number.isInteger(o.resetDay) && (o.resetDay as number) >= 1 && (o.resetDay as number) <= 31
      ? (o.resetDay as number)
      : 1;
  const expires = typeof o.expiresAt === 'string' ? Date.parse(o.expiresAt + 'T00:00:00Z') : Number.NaN;
  return { grantUsd: grant, resetDay: day, expiresAt: Number.isFinite(expires) ? expires : null };
}

/**
 * 把原始 JSON 收敛成配置；任何字段非法都回落默认，不抛错。
 *
 * @param raw - usage.json 的内容。
 * @returns 解析后的配置。
 */
export function parseUsageConfig(raw: unknown): UsageConfig {
  const o = obj(raw);
  const op = obj(o.onePassword);
  const items = obj(op.items);
  const credits = obj(o.credits);
  return {
    opReaderDir: str(op.readerDir),
    python: str(op.python) ?? 'python',
    deepseekItem: str(items.deepseek),
    openaiAdminItem: str(items.openaiAdmin),
    claudeOauthItem: str(items.claudeOauth),
    claudeConsoleOrg: str(o.claudeConsoleOrg),
    cdpUrl: str(o.cdpUrl) ?? 'http://127.0.0.1:9222',
    codexCli: str(o.codexCli),
    claudeCli: str(o.claudeCli),
    credits: { codex: credit(credits.codex), claude: credit(credits.claude) },
  };
}

/**
 * 读取配置；文件缺失或损坏时返回全默认（各来源会显示「未配置」）。
 *
 * @param userRoot - 插件数据根（~/.dsh/dsh-pet）。
 * @returns 解析后的配置。
 */
export async function loadUsageConfig(userRoot: string): Promise<UsageConfig> {
  try {
    return parseUsageConfig(JSON.parse(await readFile(join(userRoot, USAGE_CONFIG_FILE), 'utf8')));
  } catch {
    return parseUsageConfig({});
  }
}
