/**
 * 外层已用本进程令牌认证过的本机请求标记（独立模式的 file 渲染端，Origin 为 null/file://）。
 * 按 headers 对象标记：请求体回放流与原请求共享同一个 headers，请求结束即可回收。
 * 标记只表示“令牌已核验”，回环地址与本机 Host 仍由使用方自行检查。
 * @module dsh-pet/host/plugin/local-request
 */
import type { IncomingMessage } from 'node:http';

const authenticated = new WeakSet<object>();

/** 独立模式请求安全层在令牌校验通过后调用。 */
export function markAuthenticatedLocalRequest(req: IncomingMessage): void {
  authenticated.add(req.headers);
}

/** 该请求是否已被外层令牌认证。 */
export function isAuthenticatedLocalRequest(req: IncomingMessage): boolean {
  return authenticated.has(req.headers);
}
