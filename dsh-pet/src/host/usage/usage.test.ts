/** AI 用量面板：解析器、配置、缓存节流与凭据门控的回归。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { installDesktopAuth, type DesktopSession } from '../../app/desktop-auth.ts';
import {
  creditCycle,
  nextRefresh,
  parseOpenAiGrants,
  summarizeClaudeConsole,
  summarizeDeepSeek,
  summarizeOpenAiKeys,
} from './api-keys.ts';
import { parseUsageConfig } from './config.ts';
import { summarizeClaudeHistory, summarizeClaudeUsage, summarizeCodex } from './plan.ts';
import { createLazySecret } from './secrets.ts';
import { createSource } from './source.ts';

test('Codex rateLimits：按窗口时长识别 5 小时与周窗口', () => {
  const r = summarizeCodex(
    {
      rateLimitsByLimitId: {
        codex: {
          planType: 'pro',
          primary: { windowDurationMins: 300, usedPercent: 40, resetsAt: 100 },
          secondary: { windowDurationMins: 10080, usedPercent: 100.5, resetsAt: 200 },
        },
      },
    },
    5,
  );
  assert.deepEqual(r.fiveHour, { remainingPercent: 60, usedPercent: 40, resetsAt: 100 });
  assert.equal(r.weekly?.remainingPercent, 0);
  assert.equal(r.plan, 'pro');
  assert.throws(() => summarizeCodex({ rateLimits: {} }), /没有返回/);
});

test('Claude get_usage：深搜 five_hour / seven_day，ISO 与毫秒重置时间都转成秒', () => {
  const r = summarizeClaudeUsage({
    rate_limits: {
      five_hour: { utilization: 10, resets_at: '2026-11-06T00:00:00Z' },
      seven_day: { utilization: 3, resets_at: 1794524400000 },
    },
  });
  assert.equal(r.fiveHour?.remainingPercent, 90);
  assert.equal(r.fiveHour?.resetsAt, Date.parse('2026-11-06T00:00:00Z') / 1000);
  assert.equal(r.weekly?.resetsAt, 1794524400);
  assert.throws(() => summarizeClaudeUsage({ rate_limits: null }), /没有返回套餐额度/);
  const hist = summarizeClaudeHistory({
    samples: [
      { t: 1, u: { fh: 50, sd: 20 } },
      { t: 2, u: { fh: 10, sd: 30 } },
    ],
  });
  assert.equal(hist.updatedAt, 2);
  assert.equal(hist.weekly?.remainingPercent, 70);
});

test('OpenAI Credit grants 页：只合计未过期的 Available 行', () => {
  const text =
    'RECEIVED STATE BALANCE EXPIRES\nOct 29, 2026  Available  $47.00 / $50.00  Dec 05, 2026\nSep 01, 2026  Expired  $0.00 / $100.00  Oct 01, 2026\n';
  const g = parseOpenAiGrants(text, Date.parse('2026-11-05T00:00:00Z'));
  assert.equal(g.grantUsd, 50);
  assert.equal(g.remainingUsd, 47);
  assert.equal(g.cycleStart, Date.parse('2026-10-29T00:00:00Z'));
  assert.equal(g.nextResetAt, Date.parse('2026-12-05T00:00:00Z'));
  assert.throws(() => parseOpenAiGrants('garbage'), /无法识别/);
});

test('OpenAI Key 汇总：未知 Key 的花费计入总额；余额缺失时按花费推算', () => {
  const r = summarizeOpenAiKeys(
    {
      keys: [{ id: 'k1', name: 'Local', project: 'P' }],
      cost: [
        { api_key_id: 'k1', amount: { value: 1.5 } },
        { api_key_id: 'kx', amount: { value: '0.5' } },
      ],
      usage: [{ api_key_id: 'k1', num_model_requests: 3, input_tokens: 10, output_tokens: 5 }],
    },
    { grantUsd: 200, remainingUsd: null, nextResetAt: 9, source: 'config' },
    1,
  );
  assert.equal(r.totalCostUsd, 2);
  assert.equal(r.remainingUsd, 198);
  assert.deepEqual(r.keys[0], { id: 'k1', name: 'Local', project: 'P', costUsd: 1.5, requests: 3, tokens: 15 });
});

test('Claude Console 汇总：排除 admin Key，多笔赠送叠加并给出最近到期金额', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
  const r = summarizeClaudeConsole(
    {
      keys: [
        { id: 'a', name: 'Local DSH', status: 'active' },
        { id: 'b', name: 'Monitor Admin', status: 'active' },
        { id: 'c', name: 'Old', status: 'archived' },
      ],
      cost: [{ group: { api_key_id: 'a' }, cost: { amount: '1050', requests: 7 } }],
      usage: [{ group: { api_key_id: 'a' }, usage: { input_tokens: 5, cache: { cache_read_tokens: 2 } } }],
      grants: [
        { remainingMinor: 3663, grantedMinor: 20000, expiresAt: '2026-11-07T00:00:00Z' },
        { remainingMinor: 20000, grantedMinor: 20000, expiresAt: '2026-12-07T00:00:00Z' },
        { remainingMinor: 9999, grantedMinor: 20000, expiresAt: '2026-10-01T00:00:00Z' },
      ],
    },
    { grantUsd: 200, resetDay: 1, expiresAt: null },
    now,
  );
  assert.deepEqual(
    r.keys.map((k) => k.name),
    ['Local DSH'],
  );
  assert.equal(r.keys[0].costUsd, 10.5);
  assert.equal(r.keys[0].tokens, 7);
  assert.equal(r.grantUsd, 400);
  assert.equal(r.remainingUsd, 236.63);
  assert.equal(r.expiringUsd, 36.63);
  assert.equal(r.nextResetAt, Date.parse('2026-11-07T00:00:00Z'));
});

test('DeepSeek 余额解析', () => {
  const r = summarizeDeepSeek({
    is_available: true,
    balance_infos: [{ currency: 'USD', total_balance: '92.06', granted_balance: '1.66', topped_up_balance: '90.39' }],
  });
  assert.equal(r.balances[0].total, 92.06);
  assert.throws(() => summarizeDeepSeek({}), /没有返回余额/);
});

test('赠送周期：纽约时间每月刷新日与已知到期日后的按月推算', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const c = creditCycle(1, now);
  assert.equal(new Date(c.cycleStart).toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(new Date(c.nextResetAt).toISOString(), '2026-12-01T05:00:00.000Z');
  assert.equal(
    nextRefresh({ grantUsd: 200, resetDay: 1, expiresAt: Date.parse('2026-10-07T00:00:00Z') }, now),
    Date.parse('2026-11-07T00:00:00Z'),
  );
});

test('配置：非法字段回落默认，标识符只来自本机文件', () => {
  const empty = parseUsageConfig(null);
  assert.equal(empty.opReaderDir, null);
  assert.equal(empty.deepseekItem, null);
  assert.equal(empty.cdpUrl, 'http://127.0.0.1:9222');
  const c = parseUsageConfig({
    onePassword: { readerDir: 'D:/x', items: { deepseek: 'abc', openaiAdmin: ' ' } },
    credits: { claude: { expiresAt: '2026-11-07', resetDay: 40 } },
  });
  assert.equal(c.opReaderDir, 'D:/x');
  assert.equal(c.deepseekItem, 'abc');
  assert.equal(c.openaiAdminItem, null);
  assert.equal(c.credits.claude.resetDay, 1);
  assert.equal(c.credits.claude.expiresAt, Date.parse('2026-11-07T00:00:00Z'));
});

test('缓存来源：节流、失败保留旧数据、手动刷新受最短间隔约束、同一时刻只读一次', async () => {
  let t = 0;
  let calls = 0;
  let fail = false;
  const src = createSource(
    async () => {
      calls++;
      if (fail) throw new Error('boom');
      return calls;
    },
    { refreshMs: 100, retryMs: 50, minForceMs: 20 },
    () => t,
  );
  await Promise.all([src.ensure(), src.ensure()]);
  assert.equal(calls, 1);
  assert.equal(src.peek().data, 1);
  t = 10;
  await src.ensure(true);
  assert.equal(calls, 1, '最短间隔内的手动刷新被忽略');
  t = 30;
  await src.ensure(true);
  assert.equal(calls, 2);
  fail = true;
  t = 200;
  await src.ensure();
  assert.deepEqual(
    { ...src.peek(), okAt: null },
    { data: 2, error: 'boom', stale: true, refreshing: false, okAt: null },
  );
  t = 220;
  await src.ensure();
  assert.equal(calls, 3, '失败后按 retryMs 而非 refreshMs 重试');
});

test('凭据：未配置不启动读取器，读到后缓存，forget 后重读，错误不带原因细节', async () => {
  let reads = 0;
  const none = createLazySecret({ python: 'python', readerDir: null }, 'id', 'X', async () => 'v');
  await assert.rejects(none.get(), /未配置 X/);
  const s = createLazySecret({ python: 'python', readerDir: 'D:/r' }, 'id', 'X', async (o, id) => {
    reads++;
    assert.equal(o.readerDir, 'D:/r');
    assert.equal(id, 'id');
    return 'secret';
  });
  assert.equal(await s.get(), 'secret');
  assert.equal(await s.get(), 'secret');
  assert.equal(reads, 1);
  s.forget();
  await s.get();
  assert.equal(reads, 2);
  const bad = createLazySecret({ python: 'python', readerDir: 'D:/r' }, 'id', 'X', async () => {
    throw new Error('raw stderr with secret-ish detail');
  });
  await assert.rejects(bad.get(), (e: Error) => e.message === '无法从 1Password 读取 X。');
});

test('令牌只注入白名单里的渲染页（宠物页与用量面板页）', () => {
  let listener: Parameters<DesktopSession['webRequest']['onBeforeSendHeaders']>[0] | undefined;
  const index = resolve('runtime/electron-helper/index.html');
  const usage = resolve('runtime/electron-helper/usage.html');
  installDesktopAuth(
    { webRequest: { onBeforeSendHeaders: (fn) => (listener = fn) } },
    'http://127.0.0.1:3080',
    [index, usage],
    'tok',
  );
  const send = (page: string): string | undefined => {
    let out: Record<string, string> = {};
    listener!(
      { url: 'http://127.0.0.1:3080/dsh-pet-7340/usage', frame: { url: page, parent: null }, requestHeaders: {} },
      (r) => (out = r.requestHeaders),
    );
    return out['X-DSH-Pet-Token'];
  };
  assert.equal(send(pathToFileURL(usage).href + '?api=x'), 'tok');
  assert.equal(send(pathToFileURL(index).href), 'tok');
  assert.equal(send(pathToFileURL(resolve('runtime/electron-helper/other.html')).href), undefined);
});

test('面板摆放：贴在鱼身右侧不重叠，放不下换左侧，尾巴对准鱼脸，整体钳进工作区', () => {
  type Rect = { x: number; y: number; width: number; height: number };
  const { placePanel } = createRequire(import.meta.url)('../../../runtime/electron-helper/main/usage-window.js') as {
    placePanel: (
      b: Rect,
      a: Rect,
      s: { width: number; height: number },
      z?: number,
    ) => Rect & { side: string; tailY: number };
  };
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const body = { x: 400, y: 300, width: 200, height: 300 };
  const right = placePanel(body, area, { width: 312, height: 440 });
  assert.equal(right.side, 'left');
  assert.ok(right.x >= body.x + body.width, '面板不压到鱼身');
  assert.equal(right.y, 300 + 300 * 0.32 - 70);
  assert.equal(right.tailY, 70);
  const left = placePanel({ ...body, x: 1700 }, area, { width: 312, height: 440 });
  assert.equal(left.side, 'right');
  assert.ok(left.x + left.width <= 1700, '左侧放置也不压到鱼身');
  const low = placePanel({ ...body, y: 900 }, area, { width: 312, height: 440 });
  assert.equal(low.y, 600, '贴底时钳进工作区');
  assert.ok(low.tailY > 70 && low.tailY <= 440 - 40, '面板被上推后尾巴下移');
  const zoomed = placePanel(body, area, { width: 546, height: 770 }, 1.75);
  assert.equal(zoomed.x, Math.round(600 + 2 * 1.75));
});
