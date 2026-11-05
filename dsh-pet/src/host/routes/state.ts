/**
 * 轮询侧数据：/state 全局快照（支持 since/timeout 长轮询）、/work-status 工作状态写入。
 *
 * 不生成状态，只汇总 store 里的当前值。
 * 依赖（PetRouteDeps）显式传入，模块内不读全局、不建状态。
 * @module dsh-pet/src/host/routes/state
 */
import { parseStateWaitQuery } from '../state.ts';
import { type RouteResult } from '../http.ts';
import { HOST_WORK_STATUS_STATES, TASK_TEXT_MAX, type HostWorkStatusState } from '../work-status.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { failResult, invalidJson, methodNotAllowed, okResult, payloadTooLarge } from './result.ts';

/** 轮询状态领域：未命中返回 undefined，命中返回应答。 */
export async function handleStateRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { EXTERNAL_WORK_SESSION, nextExternalWorkSeq, publishWorkStatus, state, workStatus } = deps;
  const { body, method, rest, signal, url } = input;

  // 轮询状态（/state，GET，no-cache）是前端轮询的唯一数据源：只读、纯内存、零副作用——
  // 在这里触发外部调用或模型生成会把所有人的轮询拖死；也不碰磁盘（配置变更信号走 sections.config）。
  //
  // 长轮询：带 `?since=&timeout=`（成对必填）时，版本与当前相同就挂起，直到任意叶子被写过或超时；
  // 不带 = 立刻返回全量。等待语义与 GET /playback/{id} 的 wait 同一套（上限同值、断线同一个 signal）。
  if (rest === 'state') {
    if (method !== 'GET') return methodNotAllowed();
    const headers = { 'cache-control': 'no-cache, no-store' };
    const parsed = parseStateWaitQuery(url.searchParams.get('since'), url.searchParams.get('timeout'));
    // since/timeout 是业务参数：给错了是调用方的问题，但仍属「请求已进处理器」
    if (parsed.kind === 'error') return failResult('bad-request', parsed.error);
    const current = state.read();
    // 两者都没传 → 立刻返回；已经有新东西 → 也立刻返回（别白等一整个 timeout）。
    // timeout=0 走挂起分支，下一拍就醒，等价「立刻返回」，这里不特判。
    if (parsed.kind === 'none' || current.counter !== parsed.since) {
      return okResult(current, headers);
    }
    const since = parsed.since;
    return await new Promise<RouteResult>((resolveWait) => {
      let settled = false;
      /** 收尾：只认第一次（唤醒 / 超时 / 取消 / 调用方断开 都可能先后到达） */
      const settle = (result: RouteResult): void => {
        if (settled) return;
        settled = true;
        resolveWait(result);
      };
      // 唤醒时才 read()：store 保证「叶子已写定」之后才叫醒，所以这里拿到的一定是新状态
      const cancel = state.wait({
        since,
        timeoutMs: parsed.timeoutMs,
        onWake: () => settle(okResult(state.read(), headers)),
      });
      // 调用方断开：取消等待者（清掉它的超时定时器），以「无需应答」收尾。
      const onAbort = (): void => {
        cancel();
        settle({ kind: 'none' });
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // 外部写入工作状态：POST 设置固定外部槽 `api` 的档位（task 省略 = 保留，null = 清空），
  // DELETE 清空回空闲（幂等）。只解决「外部程序把状态告诉桌宠」，不做多写者仲裁/租约/会话管理；
  // 外部槽与会话一起参与现有优先级（waiting > error > working > thinking > result > success）。
  if (rest === 'work-status') {
    if (method === 'DELETE') {
      if (workStatus.clear(EXTERNAL_WORK_SESSION)) publishWorkStatus();
      return { kind: 'text', status: 204, body: '' };
    }
    if (method !== 'POST') return methodNotAllowed();
    if (Buffer.byteLength(body ?? '', 'utf8') > 8 * 1024) return payloadTooLarge('body too large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? '');
    } catch {
      return invalidJson();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalidJson();
    const payload = parsed as { state?: unknown; task?: unknown };
    const state = payload.state;
    if (typeof state !== 'string' || !(HOST_WORK_STATUS_STATES as readonly string[]).includes(state))
      return failResult('bad-request', `state 必须是 ${HOST_WORK_STATUS_STATES.join(' / ')} 之一`);
    let task: string | null | undefined;
    if (Object.prototype.hasOwnProperty.call(payload, 'task')) {
      if (payload.task === null) {
        task = null;
      } else if (typeof payload.task === 'string') {
        const trimmed = payload.task.trim();
        if (trimmed === '') {
          task = null;
        } else if (Array.from(trimmed).length > TASK_TEXT_MAX) {
          return failResult('bad-request', `task too long (max ${TASK_TEXT_MAX} code points)`);
        } else {
          task = trimmed;
        }
      } else {
        return failResult('bad-request', 'invalid task');
      }
    }
    workStatus.setState(EXTERNAL_WORK_SESSION, state as HostWorkStatusState, nextExternalWorkSeq());
    if (task !== undefined) workStatus.setTask(EXTERNAL_WORK_SESSION, task);
    publishWorkStatus();
    return okResult({
      state: workStatus.stateOf(EXTERNAL_WORK_SESSION) ?? state,
      task: workStatus.taskOf(EXTERNAL_WORK_SESSION),
    });
  }

  return undefined;
}
