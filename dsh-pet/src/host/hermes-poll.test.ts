/** Hermes 本地配置、固定子进程契约与 HTTP 确认来源检查。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { ChildProcess, execFile } from 'node:child_process';
import type { HermesAlerts } from './hermes-alerts.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { HostContext } from './plugin/context.ts';
import {
  HERMES_CONFIG_FILE,
  HERMES_PROCESS_OPTIONS,
  hermesArgs,
  hermesConfigSchema,
  startHermesPolling,
  unpackedAsarPath,
} from './hermes-poll.ts';
import { isLocalHermesRequest, markAuthenticatedLocalRequest, registerHttpRoute } from './plugin/http-route.ts';

test('仅固定只读脚本和路径参数，不提供命令、shell、approval 响应', () => {
  const config = hermesConfigSchema.parse({
    python: resolve('python.exe'),
    hermesRoot: resolve('Hermes root & spaces'),
  });
  const args = hermesArgs(config);
  assert.equal(args[0]?.endsWith('hermes-notification-snapshot.py'), true);
  assert.deepEqual(args.slice(1), ['--hermes-root', config.hermesRoot]);
  const home = resolve('profile home');
  assert.deepEqual(hermesArgs({ ...config, home }).slice(1), ['--hermes-root', config.hermesRoot, '--home', home]);
  assert.deepEqual(HERMES_PROCESS_OPTIONS, {
    shell: false,
    timeout: 50_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  assert.equal(hermesConfigSchema.safeParse({ ...config, command: 'send' }).success, false);
  assert.equal(hermesConfigSchema.safeParse({ ...config, webOrigin: 'https://x.test/path' }).success, false);
  assert.equal(hermesConfigSchema.safeParse({ ...config, webOrigin: 'https://x.test' }).success, false);
  assert.equal(hermesConfigSchema.safeParse({ ...config, python: 'python' }).success, false);
});

test('独立 exe 的 asar 包内路径改指 app.asar.unpacked，外部 Python 才能读到脚本', () => {
  const packed = join('D:', 'dsh-pet', 'resources', 'app.asar', 'scripts', 'hermes-notification-snapshot.py');
  assert.equal(
    unpackedAsarPath(packed),
    join('D:', 'dsh-pet', 'resources', 'app.asar.unpacked', 'scripts', 'hermes-notification-snapshot.py'),
  );
  const plain = join('D:', 'plugins', 'dsh-pet', 'scripts', 'hermes-notification-snapshot.py');
  assert.equal(unpackedAsarPath(plain), plain, '插件模式路径保持不变');
  const lookalike = join('D:', 'my.app.asar.backup', 'x.py');
  assert.equal(unpackedAsarPath(lookalike), lookalike, '只替换完整的 app.asar 路径段');
});

test('electron-builder 把 Hermes 只读脚本打进独立 exe 并解包', async () => {
  const { readFile } = await import('node:fs/promises');
  const yaml = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  const script = 'scripts/hermes-notification-snapshot.py';
  const section = (name: string): string => yaml.split(new RegExp(`^${name}:`, 'm'))[1]?.split(/^\S/m)[0] ?? '';
  assert.match(section('files'), new RegExp(`- ${script}`), 'files 必须包含 Hermes 脚本');
  assert.match(section('asarUnpack'), new RegExp(`- ${script}`), 'asarUnpack 必须包含 Hermes 脚本');
});

test('单飞采集在完成后 15s 再运行，卸载结束当前子进程且不接收迟到结果', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const userRoot = await mkdtemp(join(tmpdir(), 'dsh-hermes-poll-'));
  const config = { python: resolve('python.exe'), hermesRoot: resolve('Hermes root') };
  await writeFile(join(userRoot, HERMES_CONFIG_FILE), JSON.stringify(config));
  let callback: (cause: Error | null, stdout: string) => void = () => {};
  let calls = 0;
  let killed = 0;
  let accepted = 0;
  let stopped = false;
  let started!: () => void;
  const firstStart = new Promise<void>((done) => {
    started = done;
  });
  const execute = ((python: string, args: string[], options: unknown, complete: typeof callback) => {
    assert.equal(python, config.python);
    assert.deepEqual(args, hermesArgs(config));
    assert.deepEqual(options, HERMES_PROCESS_OPTIONS);
    calls++;
    callback = complete;
    started();
    return {
      kill: () => {
        killed++;
      },
    } as unknown as ChildProcess;
  }) as unknown as typeof execFile;
  const alerts = {
    initialize: async () => {},
    accept: async () => {
      accepted++;
    },
    offline: () => {},
    stop: () => {
      stopped = true;
    },
  } as unknown as HermesAlerts;
  const dispose = startHermesPolling({ userRoot, alerts, execute });
  try {
    await firstStart;
    context.mock.timers.tick(100_000);
    assert.equal(calls, 1);
    callback(null, '{}');
    await new Promise<void>((done) => setImmediate(done));
    context.mock.timers.tick(14_999);
    assert.equal(calls, 1);
    context.mock.timers.tick(1);
    assert.equal(calls, 2);
    assert.equal(accepted, 1);
    dispose();
    assert.equal(killed, 1);
    assert.equal(stopped, true);
    callback(null, '{}');
    context.mock.timers.tick(100_000);
    assert.equal(accepted, 1);
    assert.equal(calls, 2);
  } finally {
    dispose();
    await rm(userRoot, { recursive: true, force: true });
  }
});

test('未配置且无持久状态时完全不发布 Hermes 状态', async () => {
  const userRoot = await mkdtemp(join(tmpdir(), 'dsh-hermes-disabled-'));
  const calls: string[] = [];
  const alerts = {
    initialize: async () => {
      calls.push('initialize');
    },
    offline: () => {
      calls.push('offline');
    },
    stop: () => {
      calls.push('stop');
    },
  } as unknown as HermesAlerts;
  const dispose = startHermesPolling({ userRoot, alerts });
  dispose();
  assert.deepEqual(calls, ['stop']);
  await rm(userRoot, { recursive: true, force: true });
});

test('确认路由原始和编码路径均拒绝跨源，不把请求交给本地确认服务', async () => {
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> = async () => {};
  let accepted = 0;
  registerHttpRoute(
    {
      effect: (setup: () => unknown) => setup(),
      webServer: {
        register: (spec: { handler: typeof handler }) => {
          handler = spec.handler;
          return () => {};
        },
      },
    } as unknown as HostContext,
    async () => {
      accepted++;
      return { kind: 'json', status: 200, obj: { ok: true } };
    },
  );
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const path of ['hermes/ack', 'hermes%2Fack', 'hermes/%61ck']) {
      const response = await fetch(`${origin}/dsh-pet-7340/${path}`, {
        method: 'POST',
        headers: { Origin: 'https://evil.test' },
        body: '{}',
      });
      assert.equal(response.status, 403);
    }
    assert.equal(accepted, 0);
    const response = await fetch(`${origin}/dsh-pet-7340/hermes/ack`, {
      method: 'POST',
      headers: { Origin: origin },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal(accepted, 1);
  } finally {
    await new Promise<void>((done, reject) => server.close((cause) => (cause ? reject(cause) : done())));
  }
});

test('确认 HTTP 只接受回环同源，拒绝跨源/null origin 与远端', () => {
  const request = (address: string, origin?: string, host = '127.0.0.1:5000') =>
    ({ socket: { remoteAddress: address }, headers: { host, ...(origin ? { origin } : {}) } }) as IncomingMessage;
  assert.equal(isLocalHermesRequest(request('127.0.0.1', 'http://127.0.0.1:5000')), true);
  assert.equal(isLocalHermesRequest(request('::1')), true);
  assert.equal(isLocalHermesRequest(request('127.0.0.1', 'http://evil.test')), false);
  assert.equal(isLocalHermesRequest(request('127.0.0.1', 'null')), false);
  assert.equal(isLocalHermesRequest(request('192.168.1.2')), false);
  assert.equal(isLocalHermesRequest(request('127.0.0.1', undefined, 'evil.test')), false);
});

test('独立模式令牌已认证的 file 渲染端可确认，标记不放宽回环与 Host 检查', () => {
  const request = (address: string, origin: string, host = '127.0.0.1:5000') =>
    ({ socket: { remoteAddress: address }, headers: { host, origin } }) as IncomingMessage;
  for (const origin of ['null', 'file://']) {
    const unmarked = request('127.0.0.1', origin);
    assert.equal(isLocalHermesRequest(unmarked), false, '未经认证的 file 来源仍拒绝');
    const marked = request('127.0.0.1', origin);
    markAuthenticatedLocalRequest(marked);
    assert.equal(isLocalHermesRequest(marked), true);
    // 请求体回放流与原请求共享同一个 headers 对象，标记随之生效
    const replay = { socket: marked.socket, headers: marked.headers } as IncomingMessage;
    assert.equal(isLocalHermesRequest(replay), true);
  }
  const remote = request('192.168.1.2', 'null');
  markAuthenticatedLocalRequest(remote);
  assert.equal(isLocalHermesRequest(remote), false, '远端地址即使被标记也拒绝');
  const foreignHost = request('127.0.0.1', 'null', 'evil.test');
  markAuthenticatedLocalRequest(foreignHost);
  assert.equal(isLocalHermesRequest(foreignHost), false, '非本机 Host 即使被标记也拒绝');
});
