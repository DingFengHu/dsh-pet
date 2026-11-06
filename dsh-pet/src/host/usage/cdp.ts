/**
 * 经专用 Chrome（已登录 platform.openai.com / platform.claude.com）读取控制台页面。
 *
 * 每次读取自开一个后台标签、用完即关，从不碰其他标签；不读 Cookie、存储或令牌，
 * 只在页面里跑同源请求或读页面文本，拿回数字。
 * @module dsh-pet/src/host/usage/cdp
 */

/** 一条 CDP 连接。 */
interface CdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  close(): void;
}

/**
 * 连接浏览器级 CDP WebSocket。
 *
 * @param wsUrl - webSocketDebuggerUrl。
 * @returns 连接。
 */
function connect(wsUrl: string): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        error?: { message?: string };
        result?: Record<string, unknown>;
      };
      const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!p || msg.id === undefined) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP'));
      else p.resolve(msg.result ?? {});
    };
    ws.onerror = () => reject(new Error('CDP'));
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error('CDP 连接已断开'));
      pending.clear();
    };
    ws.onopen = () =>
      resolve({
        send: (method, params = {}, sessionId) =>
          new Promise((res, rej) => {
            const msgId = ++id;
            pending.set(msgId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
          }),
        close: () => ws.close(),
      });
  });
}

/** 一次页面读取的参数。 */
export interface PageReadOptions {
  /** CDP HTTP 地址。 */
  readonly cdpUrl: string;
  /** 打开的地址。 */
  readonly url: string;
  /** 页面落定后 location.href 必须以它开头。 */
  readonly expectPrefix: string;
  /** 允许中途停留的 origin 前缀（站内跳转）。 */
  readonly sameSite: string;
  /** 在页面里求值的表达式（可返回 Promise）。 */
  readonly expression: string;
  /** 站名（错误文案用）。 */
  readonly site: string;
  /** 整体超时（ms）。 */
  readonly timeoutMs: number;
}

/**
 * 开后台标签 → 等页面落定 → 求值 → 关标签。
 *
 * @param o - 读取参数。
 * @returns 表达式的值（按值返回）。
 */
export async function readInBrowserTab(o: PageReadOptions): Promise<unknown> {
  let version: { webSocketDebuggerUrl?: string };
  try {
    version = (await fetch(o.cdpUrl + '/json/version', { signal: AbortSignal.timeout(3000) }).then((r) =>
      r.json(),
    )) as typeof version;
  } catch {
    throw new Error(`专用 Chrome 未运行，无法读取 ${o.site}。`);
  }
  if (!version.webSocketDebuggerUrl) throw new Error('专用 Chrome 未提供 CDP 地址。');
  const cdp = await connect(version.webSocketDebuggerUrl).catch(() => {
    throw new Error('无法连接专用 Chrome。');
  });
  let targetId: string | null = null;
  const deadline = setTimeout(() => cdp.close(), o.timeoutMs);
  try {
    targetId = String((await cdp.send('Target.createTarget', { url: o.url, background: true })).targetId);
    const sessionId = String((await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId);
    const evaluate = async (expression: string): Promise<unknown> => {
      const out = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      const exc = out.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
      if (exc) throw new Error(exc.exception?.description ?? exc.text ?? 'evaluate');
      return (out.result as { value?: unknown } | undefined)?.value;
    };
    for (let i = 0; ; i++) {
      const state = (await evaluate('[location.href, document.readyState]').catch(() => null)) as
        [string, string] | null;
      if (state && state[0].startsWith(o.expectPrefix) && state[1] !== 'loading') break;
      if (state && state[0] !== 'about:blank' && !state[0].startsWith(o.sameSite))
        throw new Error(`${o.site} 跳转到了其他页面，请在专用 Chrome 中检查登录。`);
      if (i > 80) throw new Error(`打开 ${o.site} 超时。`);
      await new Promise((r) => setTimeout(r, 250));
    }
    return await evaluate(o.expression);
  } finally {
    clearTimeout(deadline);
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    cdp.close();
  }
}
