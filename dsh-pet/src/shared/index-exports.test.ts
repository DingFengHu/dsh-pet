/**
 * 桌面端 JS 经 window.PetShared（= 本层 index 的全部导出）取共享函数，那一侧没有类型检查：
 * 漏导出只会在运行时报「S.xxx is not a function」（2026-11-08 的 isTypingTarget 就是这样）。
 * 这里扫一遍桌面运行时里所有 `S.名字`，逐个确认共享层出口真有这个符号。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as shared from './index.ts';

const RUNTIME = fileURLToPath(new URL('../../runtime/electron-helper/', import.meta.url));

/** 递归列出运行时目录里的手写 JS（shared-core.js 是本层的构建产物，跳过）。 */
function runtimeScripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return runtimeScripts(path);
    return entry.name.endsWith('.js') && entry.name !== 'shared-core.js' ? [path] : [];
  });
}

test('桌面运行时用到的每个 S.名字 都由共享层导出', () => {
  const missing = new Set<string>();
  for (const file of runtimeScripts(RUNTIME)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/(?<![\w.$])S\.([A-Za-z_$][\w$]*)/g)) {
      if (!(match[1] in shared)) missing.add(`${match[1]}（${file.slice(RUNTIME.length)}）`);
    }
  }
  assert.deepEqual([...missing], []);
});
