/**
 * 虎妞 → 大肥鱼单向收件口：只给专用 OpenAI 隧道用的最小 MCP（Streamable HTTP，JSON 响应）。
 * 唯一工具 `pet_show_message` 把虎妞发给虎哥的一条消息显示在气泡里，不回话、不执行任何操作。
 * 只听 127.0.0.1，精确 Host、拒绝 Origin、Bearer 鉴权、32 KiB 请求上限；没有密钥文件就不启动。
 * @module dsh-pet/host/huniu-inbox
 */
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { HermesAlerts } from './hermes-alerts.ts';
import { PACKAGE_ROOT } from './paths.ts';

/** 隧道 profile 指向的固定回环端口。 */
export const HUNIU_INBOX_PORT = 18781;
/** 64 位小写 hex Bearer，由部署写入数据根，不入库。 */
export const HUNIU_INBOX_KEY_FILE = 'huniu-inbox.key';
/** 单条消息上限，超长截断后标注。 */
export const HUNIU_TEXT_LIMIT = 4000;
const BODY_LIMIT = 32 * 1024;
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TOOL = {
  name: 'pet_show_message',
  title: '转发给大肥鱼',
  description:
    '把虎妞刚发给虎哥的这条消息原文转发到虎哥 Windows 桌面上的大肥鱼气泡里提醒他。单向显示，大肥鱼不会回复，也不执行任何操作。每次给虎哥回复后调用一次。',
  inputSchema: {
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description: '这条消息的唯一 ID（1–80 个字母、数字、下划线或连字符），重发同一 ID 不会重复显示',
        pattern: '^[A-Za-z0-9_-]{1,80}$',
      },
      text: { type: 'string', description: '发给虎哥的消息原文', minLength: 1, maxLength: HUNIU_TEXT_LIMIT },
    },
    required: ['message_id', 'text'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
} as const;

type Json = Record<string, unknown>;

/** 读密钥文件，格式不对视为未启用。 */
export function readInboxKey(userRoot: string): Buffer | null {
  try {
    const path = join(userRoot, HUNIU_INBOX_KEY_FILE);
    if (statSync(path).size > 256) return null;
    const raw = readFileSync(path, 'utf8').trim();
    return /^[a-f0-9]{64}$/.test(raw) ? Buffer.from(`Bearer ${raw}`) : null;
  } catch {
    return null;
  }
}

function authorized(header: string | undefined, expected: Buffer): boolean {
  if (typeof header !== 'string') return false;
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const rpcResult = (id: unknown, result: unknown): Json => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string): Json => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

/** 处理一条已鉴权的 JSON-RPC 消息；通知返回 null（HTTP 202）。 */
export async function handleRpc(
  message: unknown,
  deps: { alerts: Pick<HermesAlerts, 'pushHuniu'>; version: string },
): Promise<Json | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return rpcError(null, -32600, 'invalid');
  const { id, method, params } = message as Json;
  if (id === undefined) return null;
  const args = (params && typeof params === 'object' ? params : {}) as Json;
  switch (method) {
    case 'initialize': {
      const asked = typeof args.protocolVersion === 'string' ? args.protocolVersion : '';
      return rpcResult(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-pet-huniu-inbox', title: '大肥鱼 · 虎妞收件', version: deps.version },
        instructions: '单向：虎妞每次给虎哥回复后，调用 pet_show_message 把原文转发给大肥鱼。不会有回复。',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: [TOOL] });
    case 'tools/call': {
      if (args.name !== TOOL.name) return rpcError(id, -32602, 'unknown tool');
      const input = (args.arguments && typeof args.arguments === 'object' ? args.arguments : {}) as Json;
      const messageId = input.message_id;
      const text = input.text;
      if (
        typeof messageId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(messageId) ||
        typeof text !== 'string' ||
        !text.trim() ||
        Object.keys(input).some((key) => key !== 'message_id' && key !== 'text')
      )
        return rpcResult(id, { isError: true, content: [{ type: 'text', text: 'invalid message_id or text' }] });
      const shown = text.length > HUNIU_TEXT_LIMIT ? `${text.slice(0, HUNIU_TEXT_LIMIT)}…（已截断）` : text;
      try {
        const state = await deps.alerts.pushHuniu(messageId, shown);
        return rpcResult(id, {
          content: [{ type: 'text', text: state === 'duplicate' ? '同一 ID 已显示过，未重复显示' : '已显示给虎哥' }],
          structuredContent: { status: state },
        });
      } catch {
        return rpcResult(id, { isError: true, content: [{ type: 'text', text: '大肥鱼暂时无法保存这条消息' }] });
      }
    }
    default:
      return rpcError(id, -32601, 'method not found');
  }
}

function send(res: ServerResponse, status: number, body?: Json): void {
  if (body) {
    const raw = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) });
    res.end(raw);
  } else {
    res.writeHead(status);
    res.end();
  }
}

/** 单请求处理，导出以便不占端口地测试。 */
export function createInboxListener(deps: {
  key: Buffer;
  port: number;
  alerts: Pick<HermesAlerts, 'pushHuniu'>;
  version: string;
}) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers.host !== `127.0.0.1:${deps.port}` || req.headers.origin !== undefined) return send(res, 403);
    if (!authorized(req.headers.authorization, deps.key)) return send(res, 401);
    if ((req.url ?? '').split('?')[0] !== '/mcp') return send(res, 404);
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return send(res, 405);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT && !aborted) {
        aborted = true;
        // 不 destroy：先回 413，剩余请求体读完丢弃，客户端能拿到状态码。
        send(res, 413);
      } else if (!aborted) chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      let message: unknown;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, rpcError(null, -32700, 'parse error'));
      }
      void handleRpc(message, deps).then(
        (reply) => (reply ? send(res, 200, reply) : send(res, 202)),
        () => send(res, 500),
      );
    });
  };
}

function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 有密钥才监听；返回卸载函数。端口被占只记日志，不影响宠物其他功能。 */
export function startHuniuInbox(options: {
  userRoot: string;
  alerts: HermesAlerts;
  version?: string;
  log?: (message: string) => void;
  port?: number;
}): () => void {
  const key = readInboxKey(options.userRoot);
  if (!key) return () => undefined;
  const version = options.version ?? packageVersion();
  const port = options.port ?? HUNIU_INBOX_PORT;
  void options.alerts.initialize();
  const server: Server = createServer(createInboxListener({ key, port, alerts: options.alerts, version }));
  server.requestTimeout = 10_000;
  server.on('error', () => options.log?.(`虎妞收件口监听失败 127.0.0.1:${port}`));
  server.listen(port, '127.0.0.1', () => options.log?.(`虎妞收件口 127.0.0.1:${port}/mcp`));
  return () => {
    server.close();
  };
}
