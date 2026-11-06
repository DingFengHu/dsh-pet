/** 虎妞单向收件口：鉴权/Host/Origin 边界、MCP 协议、幂等与持久化。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHermesAlerts } from './hermes-alerts.ts';
import { alertView, diskSchema, HUNIU_TITLE, makeAlertId } from './hermes-policy.ts';
import { createInboxListener, handleRpc, HUNIU_INBOX_KEY_FILE, readInboxKey } from './huniu-inbox.ts';
import type { PollStateStore } from './state.ts';

const hex = 'a'.repeat(64);

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'huniu-inbox-'));
  const sections: unknown[] = [];
  const state = { writeSection: (_name: string, value: unknown) => sections.push(value) } as unknown as PollStateStore;
  const alerts = createHermesAlerts({ file: join(dir, 'state.json'), state, petId: () => 'main' });
  return { dir, alerts, sections, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const call = (id: number, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'pet_show_message', arguments: args },
});

test('密钥文件必须是 64 位小写 hex，否则不启用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'huniu-key-'));
  try {
    assert.equal(readInboxKey(dir), null);
    writeFileSync(join(dir, HUNIU_INBOX_KEY_FILE), 'short');
    assert.equal(readInboxKey(dir), null);
    writeFileSync(join(dir, HUNIU_INBOX_KEY_FILE), `${hex}\n`);
    assert.equal(readInboxKey(dir)?.toString(), `Bearer ${hex}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP 握手只暴露 pet_show_message 一个工具，通知不回包', async () => {
  const h = harness();
  try {
    const init = await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      { alerts: h.alerts, version: 't' },
    );
    assert.equal((init?.result as { protocolVersion: string }).protocolVersion, '2025-03-26');
    assert.equal(
      await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, { alerts: h.alerts, version: 't' }),
      null,
    );
    const list = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { alerts: h.alerts, version: 't' });
    const tools = (list?.result as { tools: { name: string }[] }).tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['pet_show_message'],
    );
    const other = await handleRpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'shell', arguments: {} } },
      { alerts: h.alerts, version: 't' },
    );
    assert.equal((other?.error as { code: number }).code, -32602);
  } finally {
    h.cleanup();
  }
});

test('消息原文进气泡、按收到顺序；同 ID 不重复；确认后不复现；非法参数拒绝', async () => {
  const h = harness();
  const deps = { alerts: h.alerts, version: 't' };
  try {
    await handleRpc(call(1, { message_id: 'm-1', text: '第一条\n第二行' }), deps);
    await handleRpc(call(2, { message_id: 'm-2', text: '第二条' }), deps);
    const dup = await handleRpc(call(3, { message_id: 'm-1', text: '改过的' }), deps);
    assert.equal((dup?.result as { structuredContent: { status: string } }).structuredContent.status, 'duplicate');
    const last = h.sections[h.sections.length - 1] as {
      alerts: { id: string; title: string; message: string; url?: string }[];
    };
    assert.deepEqual(
      last.alerts.map((alert) => [alert.title, alert.message, alert.url]),
      [
        [HUNIU_TITLE, '第一条\n第二行', undefined],
        [HUNIU_TITLE, '第二条', undefined],
      ],
    );
    assert.equal(await h.alerts.ack(makeAlertId('huniu', ['m-1'])), true);
    const again = await handleRpc(call(4, { message_id: 'm-1', text: 'x' }), deps);
    assert.equal((again?.result as { structuredContent: { status: string } }).structuredContent.status, 'duplicate');
    for (const bad of [{ message_id: 'a/b', text: 'x' }, { message_id: 'ok', text: ' ' }, { message_id: 'ok' }]) {
      const reply = await handleRpc(call(5, bad), deps);
      assert.equal((reply?.result as { isError?: boolean }).isError, true);
    }
  } finally {
    h.cleanup();
  }
});

test('超长消息截断标注，状态文件往返合法且不给深链', async () => {
  const h = harness();
  try {
    await handleRpc(call(1, { message_id: 'long', text: 'x'.repeat(5000) }), { alerts: h.alerts, version: 't' });
    const last = h.sections[h.sections.length - 1] as { alerts: { message: string }[] };
    assert.ok(last.alerts[0]!.message.endsWith('…（已截断）'));
    const { readFileSync } = await import('node:fs');
    const disk = diskSchema.parse(JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf8')));
    assert.equal(alertView(disk.pending[0]!).url, undefined);
  } finally {
    h.cleanup();
  }
});

test('HTTP：精确 Host、拒绝 Origin、Bearer 鉴权、只收 POST /mcp、32 KiB 上限', async () => {
  const h = harness();
  const key = Buffer.from(`Bearer ${hex}`);
  const server = createServer(createInboxListener({ key, port: 0, alerts: h.alerts, version: 't' }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  // 监听器用 port 0 构造，Host 必须精确等于 127.0.0.1:0，这里用自定义 Host 模拟隧道请求。
  const send = (opts: {
    host?: string;
    auth?: string;
    origin?: string;
    method?: string;
    path?: string;
    body?: string;
  }) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: opts.method ?? 'POST',
          path: opts.path ?? '/mcp',
          headers: {
            host: opts.host ?? '127.0.0.1:0',
            ...(opts.auth ? { authorization: opts.auth } : {}),
            ...(opts.origin ? { origin: opts.origin } : {}),
            'content-type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(opts.body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    });
  const auth = `Bearer ${hex}`;
  try {
    assert.equal(await send({}), 401);
    assert.equal(await send({ auth: `Bearer ${'b'.repeat(64)}` }), 401);
    assert.equal(await send({ auth, host: 'evil.test' }), 403);
    assert.equal(await send({ auth, origin: 'https://chatgpt.com' }), 403);
    assert.equal(await send({ auth, path: '/other' }), 404);
    assert.equal(await send({ auth, method: 'GET', body: '' }), 405);
    assert.equal(await send({ auth, body: '{' }), 400);
    assert.equal(await send({ auth, body: 'x'.repeat(40 * 1024) }), 413);
    assert.equal(await send({ auth }), 200);
    assert.equal(
      await send({ auth, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }),
      202,
    );
  } finally {
    server.close();
    h.cleanup();
  }
});
