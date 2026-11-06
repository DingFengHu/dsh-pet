/**
 * AI 用量面板的数据路由：GET /usage（?refresh=1 为手动刷新）。
 *
 * 只读、只回数字与错误文案；凭据只在用量服务内存里，从不出现在应答中。
 * @module dsh-pet/src/host/routes/usage
 */
import { failResult, internalError, methodNotAllowed, okResult } from './result.ts';
import type { RouteHandler } from './types.ts';

/** 用量快照路由。 */
export const handleUsageRoutes: RouteHandler = async (deps, { rest, method, url }) => {
  if (rest !== 'usage') return undefined;
  if (method !== 'GET') return methodNotAllowed();
  if (!deps.usage) return failResult('unsupported', '当前宿主未启用用量面板');
  try {
    return okResult(await deps.usage.snapshot(url.searchParams.get('refresh') === '1'));
  } catch {
    return internalError();
  }
};
