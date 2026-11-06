/** 独立应用启动分流：DPI 探测子进程不得进入单实例锁。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { launchMode } from './launch-mode.ts';

test('Helper 注入 DSH_PET_DPI_PROBE=1 时按探测子进程运行', () => {
  assert.equal(launchMode({ DSH_PET_DPI_PROBE: '1' }), 'dpi-probe');
  assert.equal(launchMode({}), 'app');
  assert.equal(launchMode({ DSH_PET_DPI_PROBE: '0' }), 'app');
});

test('应用入口在抢单实例锁之前先分流探测子进程', async () => {
  const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
  const probe = source.indexOf("launchMode(process.env) === 'dpi-probe'");
  const lock = source.indexOf('app.requestSingleInstanceLock()');
  assert.ok(probe > 0, '入口必须调用 launchMode 分流');
  assert.ok(lock > 0 && probe < lock, '探测分流必须早于 requestSingleInstanceLock，否则主实例与探测子进程互等');
});
