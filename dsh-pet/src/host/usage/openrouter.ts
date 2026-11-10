/** OpenRouter 只读额度：账户余额与当前 Key 限额分别解析，账户失败不丢弃 Key 结果。 */
import type { LazySecret } from './secrets.ts';
import { obj } from './source.ts';

// 面板不应无限等待外部服务，单次请求最多等待 15 秒。
const REQUEST_TIMEOUT_MS = 15000;

/** Key 限额周期；null 表示不自动重置。 */
export type OpenRouterReset = 'daily' | 'weekly' | 'monthly' | null;

/** OpenRouter 额度快照，所有金额单位为 USD。 */
export interface OpenRouterUsage {
  readonly limitUsd: number | null;
  readonly remainingUsd: number | null;
  readonly limitReset: OpenRouterReset;
  readonly usageUsd: number;
  readonly dailyUsageUsd: number;
  readonly weeklyUsageUsd: number;
  readonly monthlyUsageUsd: number;
  /** 账户读取失败时为 null，不以零代替未知余额。 */
  readonly account: {
    readonly totalCreditsUsd: number;
    readonly totalUsageUsd: number;
    readonly balanceUsd: number;
  } | null;
  readonly accountError: string | null;
  readonly updatedAt: number;
}

/** 严格校验 API 数值，不接受字符串、缺失或非有限值。 */
function amount(value: unknown, signed = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (!signed && value < 0)) {
    throw new Error('OpenRouter 返回的额度数据格式无效。');
  }
  return value;
}

/** 解析当前 Key；必填字段缺失不伪装成零或无限额。 */
export function parseOpenRouterKey(raw: unknown, now = Date.now()): OpenRouterUsage {
  const payload = obj(obj(raw).data);
  const reset = payload.limit_reset;
  if (reset !== null && reset !== 'daily' && reset !== 'weekly' && reset !== 'monthly') {
    throw new Error('OpenRouter 返回的限额周期无效。');
  }
  const limit = payload.limit === null ? null : amount(payload.limit);
  const remaining = payload.limit_remaining === null ? null : amount(payload.limit_remaining, true);
  if ((limit === null) !== (remaining === null)) throw new Error('OpenRouter 返回的限额数据不完整。');
  return {
    limitUsd: limit,
    remainingUsd: remaining,
    limitReset: reset,
    usageUsd: amount(payload.usage),
    dailyUsageUsd: amount(payload.usage_daily),
    weeklyUsageUsd: amount(payload.usage_weekly),
    monthlyUsageUsd: amount(payload.usage_monthly),
    account: null,
    accountError: null,
    updatedAt: now,
  };
}

/** 解析账户总充值与累计使用；透支余额保留负数。 */
function parseAccount(raw: unknown): NonNullable<OpenRouterUsage['account']> {
  const payload = obj(obj(raw).data);
  const totalCreditsUsd = amount(payload.total_credits);
  const totalUsageUsd = amount(payload.total_usage);
  return { totalCreditsUsd, totalUsageUsd, balanceUsd: totalCreditsUsd - totalUsageUsd };
}

/** 固定官方端点，只返回已分类错误，不转发响应正文或底层网络异常。 */
async function request(endpoint: 'key' | 'credits', apiKey: string, fetcher: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(`https://openrouter.ai/api/v1/${endpoint}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error('OpenRouter 请求失败（网络、超时或重定向）。');
  }
  if (!response.ok) {
    if (endpoint === 'credits' && response.status === 403) {
      throw new Error('OpenRouter 账户余额无权限（HTTP 403，官方要求 Management Key）。');
    }
    throw new Error(`OpenRouter HTTP ${response.status}。`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error('OpenRouter 返回的 JSON 无效。');
  }
}

/** 创建只读读取器；凭据只驻内存，Key 鉴权失败后让现有惰性凭据下次重读。 */
export function createOpenRouterReader(
  secret: LazySecret,
  fetcher: typeof fetch = fetch,
): () => Promise<OpenRouterUsage> {
  return async () => {
    const apiKey = await secret.get();
    let usage: OpenRouterUsage;
    try {
      usage = parseOpenRouterKey(await request('key', apiKey, fetcher));
    } catch (error) {
      if (error instanceof Error && /HTTP (401|403)/.test(error.message)) secret.forget();
      throw error;
    }
    try {
      return { ...usage, account: parseAccount(await request('credits', apiKey, fetcher)) };
    } catch (error) {
      return { ...usage, accountError: error instanceof Error ? error.message : 'OpenRouter 账户额度读取失败。' };
    }
  };
}
