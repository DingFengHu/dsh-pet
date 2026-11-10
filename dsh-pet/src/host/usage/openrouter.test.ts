/** OpenRouter 只读请求、严格解析与面板展示的离线回归。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { createOpenRouterReader, parseOpenRouterKey } from './openrouter.ts';
import { createLazySecret } from './secrets.ts';

const keyPayload = {
  limit: 12,
  limit_remaining: 9,
  limit_reset: 'monthly',
  usage: 7,
  usage_daily: 1,
  usage_weekly: 2,
  usage_monthly: 3,
};

test('OpenRouter：余额与 Key 限额独立，GET 只发固定官方端点且禁止重定向', async () => {
  const urls: string[] = [];
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    urls.push(String(url));
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-only');
    return Response.json({ data: String(url).endsWith('/key') ? keyPayload : { total_credits: 25, total_usage: 8 } });
  }) as typeof fetch;
  const result = await createOpenRouterReader({ get: async () => 'test-only', forget() {} }, fetcher)();
  assert.deepEqual(urls, ['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/credits']);
  assert.deepEqual(result.account, { totalCreditsUsd: 25, totalUsageUsd: 8, balanceUsd: 17 });
  assert.equal(result.usageUsd, 7);
  assert.equal(result.remainingUsd, 9);
  assert.equal(result.monthlyUsageUsd, 3);
});

test('OpenRouter：周期与无限额显式保留，零余额及透支不是未知值', async () => {
  for (const reset of [null, 'daily', 'weekly', 'monthly']) {
    assert.equal(parseOpenRouterKey({ data: { ...keyPayload, limit_reset: reset } }).limitReset, reset);
  }
  const unlimited = parseOpenRouterKey({ data: { ...keyPayload, limit: null, limit_remaining: null } }, 5);
  assert.equal(unlimited.limitUsd, null);
  assert.equal(unlimited.remainingUsd, null);
  assert.equal(unlimited.updatedAt, 5);
  const exhausted = parseOpenRouterKey({ data: { ...keyPayload, limit: 0, limit_remaining: -0.2 } });
  assert.equal(exhausted.remainingUsd, -0.2);
  for (const total of [0, 2]) {
    const fetcher = (async (url: unknown) =>
      Response.json({
        data: String(url).endsWith('/key') ? keyPayload : { total_credits: 0, total_usage: total },
      })) as typeof fetch;
    const result = await createOpenRouterReader({ get: async () => 'test-only', forget() {} }, fetcher)();
    assert.equal(result.account?.balanceUsd, 0 - total);
  }
});

test('OpenRouter：缺失、字符串、负用量、非有限数字和未知周期均拒绝', () => {
  for (const field of ['limit', 'limit_remaining', 'usage', 'usage_daily', 'usage_weekly', 'usage_monthly']) {
    for (const invalid of [undefined, '1', Number.NaN, Infinity]) {
      assert.throws(() => parseOpenRouterKey({ data: { ...keyPayload, [field]: invalid } }), /无效|不完整/);
    }
  }
  assert.throws(() => parseOpenRouterKey({}), /无效/);
  assert.throws(() => parseOpenRouterKey({ data: { ...keyPayload, usage: -1 } }), /无效/);
  assert.throws(() => parseOpenRouterKey({ data: { ...keyPayload, limit_reset: 'yearly' } }), /周期无效/);
  assert.throws(() => parseOpenRouterKey({ data: { ...keyPayload, limit: null } }), /不完整/);
});

test('OpenRouter：账户 HTTP、网络、JSON、字段失败均保留 Key，错误不含秘密', async () => {
  const failures = [
    async () => new Response('sensitive-body', { status: 403 }),
    async () => {
      throw new Error('sensitive-network');
    },
    async () => new Response('sensitive-json'),
    async () => Response.json({ data: { total_credits: 'sensitive-value', total_usage: 0 } }),
    async () => Response.json({ data: { total_credits: 5 } }),
  ];
  for (const fail of failures) {
    const fetcher = (async (url: unknown) =>
      String(url).endsWith('/key') ? Response.json({ data: keyPayload }) : fail()) as typeof fetch;
    const result = await createOpenRouterReader({ get: async () => 'test-only', forget() {} }, fetcher)();
    assert.equal(result.remainingUsd, 9);
    assert.equal(result.account, null);
    assert.ok(result.accountError);
    assert.doesNotMatch(result.accountError, /sensitive|test-only/);
  }
});

test('OpenRouter：Key 鉴权失败清凭据缓存，网络失败脱敏，缺配置不请求网络', async () => {
  let forgot = 0;
  const secret = { get: async () => 'test-only', forget: () => void forgot++ };
  for (const status of [401, 403]) {
    await assert.rejects(
      createOpenRouterReader(secret, (async () => new Response('secret', { status })) as typeof fetch)(),
      /HTTP/,
    );
  }
  assert.equal(forgot, 2);
  await assert.rejects(
    createOpenRouterReader(secret, (async () => {
      throw new Error('secret');
    }) as typeof fetch)(),
    /请求失败/,
  );
  const missing = createLazySecret({ python: 'unused', readerDir: null }, null, 'OpenRouter API Key');
  await assert.rejects(
    createOpenRouterReader(missing, (async () => assert.fail('不能发出网络请求')) as typeof fetch)(),
    /未配置 OpenRouter/,
  );
});

test('OpenRouter：超时信号贯穿 fetch，取消异常只显示安全文案', async (context) => {
  context.mock.method(AbortSignal, 'timeout', (delay: number) => {
    assert.equal(delay, 15000);
    return AbortSignal.abort(new Error('sensitive-timeout'));
  });
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    assert.fail('超时后不可继续');
  }) as typeof fetch;
  await assert.rejects(
    createOpenRouterReader({ get: async () => 'test-only', forget() {} }, fetcher)(),
    (error: Error) => error.message === 'OpenRouter 请求失败（网络、超时或重定向）。',
  );
});

/** 仅实现面板用到的 DOM 行为，让测试执行真实渲染函数而非匹配源码。 */
class Element {
  children: (Element | string)[] = [];
  textContent = '';
  className = '';
  classList = { add() {}, remove() {} };
  style = { setProperty() {} };
  get firstChild(): Element {
    return this.children[0] as Element;
  }
  append(...children: (Element | string)[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: (Element | string)[]): void {
    this.children = children;
  }
  addEventListener(): void {}
  getBoundingClientRect(): { bottom: number } {
    return { bottom: 0 };
  }
  text(): string {
    return (
      this.textContent + this.children.map((child) => (typeof child === 'string' ? child : child.text())).join(' ')
    );
  }
}

test('OpenRouter 面板：真实脚本显示余额、限额周期及无限额，不改变本期合计', async () => {
  const html = await readFile(new URL('../../../runtime/electron-helper/usage.html', import.meta.url), 'utf8');
  const script = html.split('<script>')[1].split('</script>')[0];
  const elements = new Map<string, Element>();
  const get = (id: string): Element => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const usage = parseOpenRouterKey({ data: keyPayload });
  const context = {
    document: { getElementById: get, createElement: () => new Element(), fonts: { ready: Promise.resolve() } },
    Node: Element,
    location: { search: '' },
    URLSearchParams,
    window: {},
    requestAnimationFrame() {},
    setTimeout,
    clearTimeout,
    fixture: { ...usage, account: { totalCreditsUsd: 25, totalUsageUsd: 8, balanceUsd: 17 } },
  };
  runInNewContext(
    script +
      `
    snap.codexApi = { data: { totalCostUsd: 2, keys: [] } };
    snap.claudeApi = { data: { totalCostUsd: 3, keys: [] } };
    snap.openrouter = { data: fixture };
    render();
  `,
    context,
  );
  const text = get('body').text();
  assert.match(text, /OpenRouter · Jev/);
  assert.doesNotMatch(text, /AUTO/);
  assert.match(text, /\$17\b/);
  assert.match(text, /总充值 \$25\b/);
  assert.match(text, /\$9 \/ \$12\b/);
  assert.match(text, /每月（UTC）/);
  assert.match(text, /累计已用 \$7\b/);
  assert.equal(get('total').textContent, '$5.00');
  runInNewContext(
    `snap.openrouter.data = { ...fixture, limitUsd: 1, remainingUsd: 0.997819612, usageUsd: 0.002180388,
      dailyUsageUsd: 0.000000001, weeklyUsageUsd: 0.002180388, monthlyUsageUsd: 0,
      account: { totalCreditsUsd: 10, totalUsageUsd: 0.002180388, balanceUsd: 9.997819612 } }; render();`,
    context,
  );
  const precise = get('body').text();
  assert.match(precise, /\$9\.997819612/);
  assert.match(precise, /\$0\.997819612 \/ \$1\b/);
  assert.match(precise, /累计已用 \$0\.002180388/);
  assert.match(precise, /UTC 日 \$0\.000000001 · 周 \$0\.002180388 · 月 \$0\b/);
  assert.equal(get('total').textContent, '$5.00');
  runInNewContext(
    `snap.openrouter.data = { ...fixture, limitUsd: null, remainingUsd: null, limitReset: null, account: null, accountError: 'HTTP 403' }; render();`,
    context,
  );
  assert.match(get('body').text(), /无限额/);
  assert.match(get('body').text(), /限额不重置/);
  assert.match(get('body').text(), /账户余额未知/);
  assert.match(get('body').text(), /账户额度未读到/);
});
