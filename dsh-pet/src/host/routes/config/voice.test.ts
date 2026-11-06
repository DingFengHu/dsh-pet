/**
 * POST /voice-enabled（右键「朗读」开关）的契约测试：只改 voiceEnabled，其余字段原样保留，
 * 不重启 Helper，写一次 config 信号；参数非法、用户配置缺失或损坏时不写盘。
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { setVoiceEnabledRoute } from './voice.ts';
import type { PetRouteDeps, RouteInput } from '../types.ts';
import type { RouteResult } from '../../http.ts';

const DEFAULT_FILE = fileURLToPath(new URL('../../../../assets/config.jsonc', import.meta.url));

const pet = {
  id: 'main',
  name: '大肥鱼',
  size: 360,
  display: 'desktop',
  position: { corner: 'bottom-right', marginX: 10, marginY: 10 },
};

let root = '';
let savedHome: string | undefined;

function harness(sub: string) {
  const dir = join(root, sub);
  const userFile = join(dir, 'main-config.jsonc');
  const sections: string[] = [];
  let restarts = 0;
  const deps = {
    configPaths: { defaultFile: DEFAULT_FILE, userFile, petDir: join(dir, 'pet') },
    userConfigPath: userFile,
    userRoot: dir,
    state: { writeSection: (name: string) => sections.push(name) },
    requestRestart: async () => {
      restarts += 1;
    },
  } as unknown as PetRouteDeps;
  return {
    deps,
    userFile,
    dir,
    sections,
    get restarts() {
      return restarts;
    },
  };
}

const input = (body: unknown, method = 'POST'): RouteInput => ({
  url: new URL('http://localhost/dsh-pet-7340/voice-enabled'),
  rest: 'voice-enabled',
  method,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

function jsonOf(res: RouteResult): { status: number; obj: Record<string, unknown> } {
  if (res.kind !== 'json') throw new Error('期望 JSON 应答，实际是 ' + res.kind);
  return { status: res.status, obj: res.obj as Record<string, unknown> };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-pet-voice-enabled-'));
  savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'home');
});

after(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('setVoiceEnabledRoute —— 右键朗读开关', () => {
  test('只改 voiceEnabled：音色、音量、宠物与手写键保留，不重启 Helper，写 config 信号', async () => {
    const h = harness('ok');
    mkdirSync(h.dir, { recursive: true });
    writeFileSync(
      h.userFile,
      JSON.stringify({
        voiceEnabled: true,
        voiceName: 'zh-CN-XiaoyiNeural',
        voiceVolume: 0.6,
        pets: [pet],
        note: '手写',
      }),
      'utf8',
    );
    const res = jsonOf(await setVoiceEnabledRoute(h.deps, input({ enabled: false })));
    assert.equal(res.status, 200);
    assert.deepEqual(res.obj, { ok: true, voiceEnabled: false });
    const saved = JSON.parse(readFileSync(h.userFile, 'utf8')) as Record<string, unknown>;
    assert.equal(saved.voiceEnabled, false);
    assert.equal(saved.voiceName, 'zh-CN-XiaoyiNeural');
    assert.equal(saved.voiceVolume, 0.6);
    assert.equal(saved.note, '手写');
    assert.equal((saved.pets as { id: string }[])[0]?.id, 'main');
    assert.equal(h.restarts, 0);
    assert.deepEqual(h.sections, ['config']);

    const back = jsonOf(await setVoiceEnabledRoute(h.deps, input({ enabled: true })));
    assert.equal(back.obj.voiceEnabled, true);
    assert.equal((JSON.parse(readFileSync(h.userFile, 'utf8')) as { voiceEnabled: boolean }).voiceEnabled, true);
  });

  test('enabled 不是布尔：bad-request，不写盘', async () => {
    const h = harness('bad');
    const res = jsonOf(await setVoiceEnabledRoute(h.deps, input({ enabled: 'yes' })));
    assert.equal(res.obj.ok, false);
    assert.equal(res.obj.reason, 'bad-request');
    assert.equal(existsSync(h.userFile), false);
  });

  test('没有用户配置：bad-request，不凭空造一份', async () => {
    const h = harness('missing');
    const res = jsonOf(await setVoiceEnabledRoute(h.deps, input({ enabled: false })));
    assert.equal(res.obj.reason, 'bad-request');
    assert.equal(existsSync(h.userFile), false);
  });

  test('用户配置损坏：user-config-unparsable，原文件一个字节不动', async () => {
    const h = harness('broken');
    mkdirSync(h.dir, { recursive: true });
    writeFileSync(h.userFile, '{ "pets": [ broken', 'utf8');
    const res = jsonOf(await setVoiceEnabledRoute(h.deps, input({ enabled: false })));
    assert.equal(res.obj.reason, 'user-config-unparsable');
    assert.equal(readFileSync(h.userFile, 'utf8'), '{ "pets": [ broken');
  });

  test('坏 JSON 400，非 POST 405', async () => {
    const h = harness('proto');
    assert.equal(jsonOf(await setVoiceEnabledRoute(h.deps, input('{oops'))).status, 400);
    assert.equal(jsonOf(await setVoiceEnabledRoute(h.deps, input({ enabled: true }, 'GET'))).status, 405);
  });
});
