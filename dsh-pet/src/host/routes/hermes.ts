/** Hermes 本地确认路由，不向 Hermes 回答 approval 或发送消息。 */
import { alertId } from '../hermes-policy.ts';
import { failResult, internalError, invalidJson, methodNotAllowed, okResult, payloadTooLarge } from './result.ts';
import type { RouteHandler } from './types.ts';

/** 仅接受单一完整 id，未知或已确认 id 明确失败。 */
export const handleHermesRoutes: RouteHandler = async (deps, { rest, method, body }) => {
  if (rest !== 'hermes/ack') return undefined;
  if (method !== 'POST') return methodNotAllowed();
  if (Buffer.byteLength(body ?? '', 'utf8') > 256) return payloadTooLarge();
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? '');
  } catch {
    return invalidJson();
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== 1 ||
    !('id' in raw) ||
    !alertId.safeParse(raw.id).success
  )
    return failResult('bad-request', '无效的 Hermes 提醒 id');
  try {
    if (!deps.hermesAlerts || !(await deps.hermesAlerts.ack((raw as { id: string }).id)))
      return failResult('bad-request', 'Hermes 提醒不存在');
    return okResult({ ok: true });
  } catch {
    return internalError();
  }
};
