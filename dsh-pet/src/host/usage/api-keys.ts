/**
 * API 用量：按 Key 汇总的花费 / 请求数 / token，加上套餐赠送额度的余额与到期。
 *
 * - Codex API：OpenAI 组织 Admin Key（1Password）读 costs / usage；赠送额度读专用 Chrome 里的 Credit grants 页。
 * - Claude API：专用 Chrome 里的 Claude Console 同源请求（analytics + prepaid credits）。
 * - DeepSeek：API Key（1Password）读 /user/balance。
 * @module dsh-pet/src/host/usage/api-keys
 */
import type { CreditFallback, UsageConfig } from './config.ts';
import { readInBrowserTab } from './cdp.ts';
import type { LazySecret } from './secrets.ts';
import { arr, num, obj, type Loose } from './source.ts';

/** 单个 Key 的用量。 */
export interface KeyUsage {
  readonly id: string;
  readonly name: string;
  readonly project?: string;
  readonly costUsd: number;
  readonly requests: number;
  readonly tokens: number;
}

/** 一个平台的 API 用量与赠送额度。 */
export interface ApiUsage {
  readonly keys: KeyUsage[];
  /** 本期总花费。 */
  readonly totalCostUsd: number;
  /** 赠送总额（未知为 null）。 */
  readonly grantUsd: number | null;
  /** 赠送余额（未知为 null）。 */
  readonly remainingUsd: number | null;
  /** 最近一笔到期 / 下次刷新时间（ms）。 */
  readonly nextResetAt: number | null;
  /** 最近到期那笔还剩多少（多笔叠加时才有）。 */
  readonly expiringUsd: number | null;
  /** 赠送额度来源。 */
  readonly creditSource: string;
  /** 赠送额度读取失败（Key 用量仍有效）。 */
  readonly creditError?: string;
  readonly updatedAt: number;
}

/** DeepSeek 余额。 */
export interface DeepSeekBalance {
  readonly available: boolean;
  readonly balances: Array<{ currency: string; total: number; granted: number; toppedUp: number }>;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------- 赠送额度周期

const TZ = 'America/New_York';

function nyParts(ms: number): { y: number; m: number; d: number; h: number; min: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return { y: p.year, m: p.month - 1, d: p.day, h: p.hour, min: p.minute };
}

/**
 * 纽约时间某日 0 点对应的 UTC 时刻（日期超出当月天数时取月末）。
 *
 * @param y - 年。
 * @param m - 月（0 起）。
 * @param day - 日。
 * @returns UTC 毫秒。
 */
export function nyMidnight(y: number, m: number, day: number): number {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const naive = Date.UTC(y, m, Math.min(day, last));
  const offsetAt = (t: number): number => {
    const p = nyParts(t);
    return Date.UTC(p.y, p.m, p.d, p.h, p.min) - t;
  };
  const guess = naive - offsetAt(naive + 12 * 3600000);
  return naive - offsetAt(guess);
}

/**
 * 按每月刷新日推算当前周期。
 *
 * @param resetDay - 每月刷新日（纽约时间）。
 * @param now - 当前时间。
 * @returns 周期起点与下次刷新。
 */
export function creditCycle(resetDay: number, now = Date.now()): { cycleStart: number; nextResetAt: number } {
  const { y, m } = nyParts(now);
  let start = nyMidnight(y, m, resetDay);
  if (start > now) start = nyMidnight(m === 0 ? y - 1 : y, (m + 11) % 12, resetDay);
  const s = nyParts(start + 12 * 3600000);
  return { cycleStart: start, nextResetAt: nyMidnight(s.m === 11 ? s.y + 1 : s.y, (s.m + 1) % 12, resetDay) };
}

/**
 * 已知到期日之后按月推算下一次刷新。
 *
 * @param credit - 兜底配置。
 * @param now - 当前时间。
 * @returns 下次刷新（ms）。
 */
export function nextRefresh(credit: CreditFallback, now = Date.now()): number {
  if (!credit.expiresAt) return creditCycle(credit.resetDay, now).nextResetAt;
  const d = new Date(credit.expiresAt);
  for (let i = 0; i <= 120; i++) {
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, d.getUTCDate());
    if (t > now) return t;
  }
  return credit.expiresAt;
}

// ---------------------------------------------------------------- OpenAI 赠送额度（Credit grants 页）

/** Credit grants 页解析结果。 */
export interface OpenAiGrants {
  readonly grantUsd: number;
  readonly remainingUsd: number;
  readonly cycleStart: number | null;
  readonly nextResetAt: number | null;
}

const money = (s: string): number => Number.parseFloat(s.replace(/[$,]/g, ''));
const utcDay = (s: string): number | null => {
  const t = Date.parse(s + ' 00:00:00 UTC');
  return Number.isFinite(t) ? t : null;
};

/**
 * 解析 Credit grants 页文本：「Oct 29, 2026  Available  $47.00 / $47.00  Nov 05, 2026」，日期是 UTC 日。
 *
 * @param text - 页面 main 的 innerText。
 * @param now - 当前时间。
 * @returns 生效中赠送额度的合计。
 */
export function parseOpenAiGrants(text: string, now = Date.now()): OpenAiGrants {
  const rows: Array<{
    receivedAt: number | null;
    state: string;
    balance: number;
    grant: number;
    expiresAt: number | null;
  }> = [];
  const re = /(\w{3} \d{1,2}, \d{4})\s+(\w[\w ]*?)\s+(\$[\d,.]+)\s*\/\s*(\$[\d,.]+)\s+(\w{3} \d{1,2}, \d{4})/g;
  for (let m = re.exec(text); m; m = re.exec(text))
    rows.push({
      receivedAt: utcDay(m[1]),
      state: m[2].trim(),
      balance: money(m[3]),
      grant: money(m[4]),
      expiresAt: utcDay(m[5]),
    });
  if (!rows.length && !/no credit grants/i.test(text)) throw new Error('无法识别 OpenAI 赠送额度页面。');
  const live = rows.filter((g) => /available/i.test(g.state) && (!g.expiresAt || g.expiresAt > now));
  const starts = live.map((g) => g.receivedAt).filter((t): t is number => t !== null);
  const ends = live.map((g) => g.expiresAt).filter((t): t is number => t !== null);
  return {
    grantUsd: live.reduce((s, g) => s + g.grant, 0),
    remainingUsd: live.reduce((s, g) => s + g.balance, 0),
    cycleStart: starts.length ? Math.min(...starts) : null,
    nextResetAt: ends.length ? Math.min(...ends) : null,
  };
}

/** 在页面里等表格（或空状态）出现再取文本。 */
const GRANTS_PAGE_TEXT = `(async () => {
  for (let i = 0; i < 60; i++) {
    const main = document.querySelector('main');
    const text = main ? main.innerText : '';
    if (/RECEIVED[\\s\\S]*EXPIRES/.test(text) && (/\\$[\\d,.]+\\s*\\/\\s*\\$[\\d,.]+\\s+\\w{3} \\d{1,2}, \\d{4}/.test(text) || /no credit grants/i.test(text))) return text;
    if (/log in|sign up/i.test(document.title + ' ' + text.slice(0, 200)) && !/Credit Grants/.test(text)) throw new Error('AUTH');
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('TIMEOUT');
})()`;

const GRANTS_URL = 'https://platform.openai.com/settings/organization/billing/credit-grants';

/**
 * 读 OpenAI 赠送额度。
 *
 * @param cdpUrl - CDP 地址。
 * @returns 解析结果。
 */
export async function readOpenAiGrants(cdpUrl: string): Promise<OpenAiGrants> {
  try {
    const text = await readInBrowserTab({
      cdpUrl,
      url: GRANTS_URL,
      expectPrefix: GRANTS_URL,
      sameSite: 'https://platform.openai.com/',
      expression: GRANTS_PAGE_TEXT,
      site: 'OpenAI 赠送额度页',
      timeoutMs: 60000,
    });
    return parseOpenAiGrants(String(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/AUTH/.test(message))
      throw new Error('OpenAI 平台未登录，请在专用 Chrome 中登录 platform.openai.com。', { cause: error });
    if (/TIMEOUT/.test(message)) throw new Error('读取 OpenAI 赠送额度超时。', { cause: error });
    throw error;
  }
}

// ---------------------------------------------------------------- Codex API（OpenAI Admin）

/**
 * OpenAI 原始数据 → 汇总。
 *
 * @param raw - keys / cost / usage 三组原始行。
 * @param credit - 赠送额度信息。
 * @param now - 当前时间。
 * @returns 汇总。
 */
export function summarizeOpenAiKeys(
  raw: { keys: Array<{ id: string; name: string; project: string }>; cost: Loose[]; usage: Loose[] },
  credit: { grantUsd: number; remainingUsd: number | null; nextResetAt: number | null; source: string; error?: string },
  now = Date.now(),
): ApiUsage {
  if (!raw.keys.length) throw new Error('OpenAI 组织下没有 project API Key。');
  const byKey = new Map(
    raw.keys.map((k) => [k.id, { id: k.id, name: k.name, project: k.project, costUsd: 0, requests: 0, tokens: 0 }]),
  );
  let other = 0;
  for (const row of raw.cost) {
    const amount = num(obj(row.amount).value);
    const key = byKey.get(String(row.api_key_id));
    if (key) key.costUsd += amount;
    else other += amount;
  }
  for (const row of raw.usage) {
    const key = byKey.get(String(row.api_key_id));
    if (!key) continue;
    key.requests += num(row.num_model_requests);
    key.tokens += num(row.input_tokens) + num(row.output_tokens);
  }
  const keys = [...byKey.values()];
  const total = keys.reduce((s, k) => s + k.costUsd, 0) + other;
  return {
    keys,
    totalCostUsd: total,
    grantUsd: credit.grantUsd,
    remainingUsd: credit.remainingUsd ?? Math.max(0, credit.grantUsd - total),
    nextResetAt: credit.nextResetAt,
    expiringUsd: null,
    creditSource: credit.source,
    ...(credit.error ? { creditError: credit.error } : {}),
    updatedAt: now,
  };
}

/**
 * Codex API 用量读取器。
 *
 * @param config - 用量配置。
 * @param adminKey - OpenAI Admin Key（1Password）。
 * @param grants - 赠送额度读取（带自己的缓存；失败返回 error）。
 * @returns 读取函数。
 */
export function createCodexApiReader(
  config: UsageConfig,
  adminKey: LazySecret,
  grants: () => Promise<{ data: OpenAiGrants | null; error: string | null }>,
): () => Promise<ApiUsage> {
  const get = async (path: string): Promise<Loose> => {
    const key = await adminKey.get();
    let response: Response;
    try {
      response = await fetch('https://api.openai.com' + path, {
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      throw new Error('OpenAI 连接失败，稍后自动重试。');
    }
    if (response.status === 401 || response.status === 403) {
      adminKey.forget();
      throw new Error('Codex Admin Key 无效或权限不足。');
    }
    if (!response.ok) throw new Error(`OpenAI 用量查询失败（HTTP ${response.status}）。`);
    return obj(await response.json());
  };
  const buckets = async (kind: string, startSec: number): Promise<Loose[]> => {
    const rows: Loose[] = [];
    let page: string | null = null;
    for (let i = 0; i < 10; i++) {
      const q = new URLSearchParams({ start_time: String(startSec), bucket_width: '1d', limit: '31' });
      q.append('group_by', 'api_key_id');
      if (page) q.set('page', page);
      const body = await get(`/v1/organization/${kind}?${q}`);
      for (const bucket of arr(body.data)) rows.push(...arr(obj(bucket).results).map(obj));
      if (!body.has_more || !body.next_page) break;
      page = String(body.next_page);
    }
    return rows;
  };
  return async () => {
    const g = await grants();
    let credit: {
      grantUsd: number;
      remainingUsd: number | null;
      nextResetAt: number | null;
      source: string;
      error?: string;
    };
    let cycleStart: number;
    if (g.data && g.data.grantUsd > 0 && g.data.cycleStart) {
      credit = {
        grantUsd: g.data.grantUsd,
        remainingUsd: g.data.remainingUsd,
        nextResetAt: g.data.nextResetAt,
        source: 'openai-credit-grants',
      };
      cycleStart = g.data.cycleStart;
    } else {
      const cycle = creditCycle(config.credits.codex.resetDay);
      credit = {
        grantUsd: config.credits.codex.grantUsd,
        remainingUsd: null,
        nextResetAt: cycle.nextResetAt,
        source: 'config',
      };
      cycleStart = cycle.cycleStart;
    }
    if (g.error) credit.error = g.error;
    const projects = arr((await get('/v1/organization/projects?limit=100')).data).map(obj);
    const keys: Array<{ id: string; name: string; project: string }> = [];
    for (const p of projects.filter((x) => x.status === 'active'))
      for (const k of arr((await get(`/v1/organization/projects/${String(p.id)}/api_keys?limit=100`)).data).map(obj))
        keys.push({ id: String(k.id), name: String(k.name ?? ''), project: String(p.name ?? '') });
    const startSec = Math.floor(cycleStart / 1000);
    const [cost, usage] = await Promise.all([buckets('costs', startSec), buckets('usage/completions', startSec)]);
    return summarizeOpenAiKeys({ keys, cost, usage }, credit);
  };
}

// ---------------------------------------------------------------- Claude API（Console）

/** 在 platform.claude.com 标签里跑：只返回 Key 名称 / ID 与数字。参数经 JSON 内联。 */
function claudeConsoleExpression(org: string, startIso: string, endIso: string): string {
  return `(async (org, startIso, endIso) => {
  const headers = { accept: 'application/json', 'anthropic-version': '2026-10-21', 'anthropic-beta': 'analytics-usage-cost-2026-08-24',
    'anthropic-dangerous-direct-browser-access': 'true', 'x-organization-uuid': org };
  const get = async (path, h) => {
    const r = await fetch(path, { headers: h, cache: 'no-store', redirect: 'error', credentials: 'same-origin' });
    if (r.status === 401 || r.status === 403) throw new Error('AUTH');
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path.split('?')[0]);
    return r.json();
  };
  const report = async (kind) => {
    const rows = []; let page = null, refreshedAt = null;
    for (let i = 0; i < 20; i++) {
      const u = new URL('/v1/organizations/analytics/' + kind, location.origin);
      u.searchParams.set('starting_at', startIso); u.searchParams.set('ending_at', endIso);
      u.searchParams.append('group_by[]', 'api_key_id'); u.searchParams.set('limit', '5000');
      if (page) u.searchParams.set('page', page);
      const body = await get(u.pathname + u.search, headers);
      refreshedAt = body.data_refreshed_at || refreshedAt;
      for (const bucket of body.data || []) rows.push(...(Array.isArray(bucket.results) ? bucket.results : [bucket]));
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
    return { rows, refreshedAt };
  };
  const keys = await get('/api/console/organizations/' + org + '/api_keys', { accept: 'application/json' });
  const [cost, usage, credits] = await Promise.all([report('cost'), report('usage'),
    get('/api/organizations/' + org + '/prepaid/credits', { accept: 'application/json' }).catch(() => null)]);
  return {
    keys: (Array.isArray(keys) ? keys : keys.data || []).map((k) => ({ id: k.id, name: k.name, status: k.status })),
    cost: cost.rows, usage: usage.rows,
    credits: credits && credits.balance && credits.balance.credits ? credits.balance.credits.amount_minor / 10 ** credits.balance.credits.exponent
      : credits && Number.isFinite(credits.amount) ? credits.amount / 100 : null,
    grants: ((credits && credits.promo_tranches) || []).map((t) => ({ remainingMinor: t.remaining_amount_minor_units,
      grantedMinor: t.granted_amount_minor_units, expiresAt: t.expires_at })),
  };
})(${JSON.stringify(org)}, ${JSON.stringify(startIso)}, ${JSON.stringify(endIso)})`;
}

/**
 * 本自然月（UTC）的查询区间。
 *
 * @param now - 当前时间。
 * @returns ISO 起止。
 */
export function monthRange(now = new Date()): [string, string] {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const end = new Date(Math.min(tomorrow, start.getTime() + 31 * 86400000));
  return [start.toISOString().replace('.000Z', 'Z'), end.toISOString().replace('.000Z', 'Z')];
}

/** 嵌套 token 字段求和（显式 total 优先）。 */
function sumTokens(row: Loose): number {
  if (typeof row.total_tokens === 'number') return row.total_tokens;
  if (typeof row.total === 'number') return row.total;
  let sum = 0;
  const visit = (value: unknown, key: string): void => {
    if (typeof value === 'number' && /tokens$/.test(key)) sum += value;
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value as Loose)) visit(v, k);
  };
  visit(row, '');
  return sum;
}

/**
 * Claude Console 原始数据 → 汇总；赠送额度以 Console 的 promo tranches 为准（多笔 $200 可能叠加）。
 *
 * @param raw - 页面返回值。
 * @param fallback - 赠送额度兜底。
 * @param now - 当前时间。
 * @returns 汇总。
 */
export function summarizeClaudeConsole(raw: unknown, fallback: CreditFallback, now = Date.now()): ApiUsage {
  const r = obj(raw);
  // 监控用的 Admin Key 自己没有流量：只列在用的业务 Key。
  const active = arr(r.keys)
    .map(obj)
    .filter((k) => k.status === 'active' && !/\badmin\b/i.test(String(k.name ?? '')));
  if (!active.length) throw new Error('Claude Console 没有在用的 API Key。');
  const byKey = new Map(
    active.map((k) => [
      String(k.id),
      { id: String(k.id), name: String(k.name ?? ''), costUsd: 0, requests: 0, tokens: 0 },
    ]),
  );
  const keyOf = (row: Loose): KeyUsage | undefined => byKey.get(String(obj(row.group).api_key_id ?? row.api_key_id));
  for (const row of arr(r.cost).map(obj)) {
    const key = keyOf(row) as { costUsd: number; requests: number } | undefined;
    if (!key) continue;
    const c = row.cost ? obj(row.cost) : row;
    key.costUsd += num(c.amount) / 100; // 美分（可带小数）
    key.requests += num(c.requests);
  }
  for (const row of arr(r.usage).map(obj)) {
    const key = keyOf(row) as { tokens: number } | undefined;
    if (!key) continue;
    key.tokens += sumTokens(row.usage ? obj(row.usage) : row);
  }
  const keys = [...byKey.values()];
  const total = keys.reduce((s, k) => s + k.costUsd, 0);
  const live = arr(r.grants)
    .map(obj)
    .map((g) => ({
      remaining: num(g.remainingMinor) / 100,
      grant: num(g.grantedMinor) / 100,
      expiresAt: Date.parse(String(g.expiresAt)),
    }))
    .filter((g) => Number.isFinite(g.expiresAt) && g.expiresAt > now && g.grant > 0)
    .sort((a, b) => a.expiresAt - b.expiresAt);
  const base = { keys, totalCostUsd: total, updatedAt: now };
  if (live.length) {
    const next = live.find((g) => g.remaining > 0) ?? live[0];
    return {
      ...base,
      grantUsd: live.reduce((s, g) => s + g.grant, 0),
      remainingUsd: live.reduce((s, g) => s + g.remaining, 0),
      nextResetAt: next.expiresAt,
      expiringUsd: live.length > 1 ? next.remaining : null,
      creditSource: 'claude-promo-tranches',
    };
  }
  const credits = typeof r.credits === 'number' && Number.isFinite(r.credits) ? r.credits : null;
  return {
    ...base,
    grantUsd: fallback.grantUsd,
    remainingUsd: credits !== null ? Math.min(credits, fallback.grantUsd) : Math.max(0, fallback.grantUsd - total),
    nextResetAt: nextRefresh(fallback, now),
    expiringUsd: null,
    creditSource: credits !== null ? 'claude-prepaid' : 'config',
  };
}

/**
 * Claude API 用量读取器。
 *
 * @param config - 用量配置。
 * @returns 读取函数。
 */
export function createClaudeApiReader(config: UsageConfig): () => Promise<ApiUsage> {
  return async () => {
    if (!config.claudeConsoleOrg) throw new Error('未配置 Claude Console 组织 ID。');
    const [start, end] = monthRange();
    try {
      const raw = await readInBrowserTab({
        cdpUrl: config.cdpUrl,
        url: 'https://platform.claude.com/robots.txt',
        expectPrefix: 'https://platform.claude.com/',
        sameSite: 'https://platform.claude.com/',
        expression: claudeConsoleExpression(config.claudeConsoleOrg, start, end),
        site: 'Claude Console',
        timeoutMs: 45000,
      });
      return summarizeClaudeConsole(raw, config.credits.claude);
    } catch (error) {
      if (error instanceof Error && /AUTH/.test(error.message))
        throw new Error('Claude Console 未登录，请在专用 Chrome 中登录 platform.claude.com。', { cause: error });
      throw error;
    }
  };
}

// ---------------------------------------------------------------- DeepSeek

/**
 * DeepSeek /user/balance 应答 → 余额。
 *
 * @param result - 应答 JSON。
 * @param now - 当前时间。
 * @returns 余额。
 */
export function summarizeDeepSeek(result: unknown, now = Date.now()): DeepSeekBalance {
  const r = obj(result);
  if (!Array.isArray(r.balance_infos)) throw new Error('DeepSeek 没有返回余额数据。');
  const n = (v: unknown): number | null => {
    const x = Number.parseFloat(String(v));
    return Number.isFinite(x) ? x : null;
  };
  const balances = r.balance_infos
    .map(obj)
    .map((b) => ({
      currency: String(b.currency ?? ''),
      total: n(b.total_balance),
      granted: n(b.granted_balance) ?? 0,
      toppedUp: n(b.topped_up_balance) ?? 0,
    }))
    .filter(
      (b): b is { currency: string; total: number; granted: number; toppedUp: number } =>
        !!b.currency && b.total !== null,
    );
  if (!balances.length) throw new Error('DeepSeek 余额格式无法识别。');
  return { available: r.is_available === true, balances, updatedAt: now };
}

/**
 * DeepSeek 余额读取器。
 *
 * @param apiKey - DeepSeek API Key（1Password）。
 * @returns 读取函数。
 */
export function createDeepSeekReader(apiKey: LazySecret): () => Promise<DeepSeekBalance> {
  return async () => {
    const key = await apiKey.get();
    let response: Response;
    try {
      response = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new Error('DeepSeek 连接失败，稍后自动重试。');
    }
    if (response.status === 401) {
      apiKey.forget();
      throw new Error('DeepSeek API Key 无效或已失效。');
    }
    if (!response.ok) throw new Error(`DeepSeek 余额查询失败（HTTP ${response.status}）。`);
    return summarizeDeepSeek(await response.json());
  };
}
