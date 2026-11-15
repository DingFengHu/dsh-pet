import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { clampReachableRect, resolveRect } from '../shared/displays.ts';
import { fitWindowInArea, planMove } from '../shared/motion.ts';
import { MIN_REACHABLE_PX } from '../shared/constants.ts';

/** 跑真实漫游与落位脚本；只替换视频时钟、rAF 和 IPC，不发送鼠标事件。 */
test('Windows 连续自主漫游：各帧身体可见，到边缘拒绝继续向外走', () => {
  const context = vm.createContext({
    navigator: { platform: 'Win32' },
    BASE: 'http://unused.invalid',
    S: { clampReachableRect, resolveRect, fitWindowInArea, planMove, MIN_REACHABLE_PX, PET_REF_WIDTH: 640 },
    CONFIG: { isWindowClampedToWorkArea: false },
    VIEW: { x: 0, y: 0, w: 1920, h: 1040 },
    AREAS: [{ x: 0, y: 0, width: 1920, height: 1040 }],
    WORK_AREAS: [{ x: 0, y: 0, width: 1920, height: 1040 }],
    window: { __dshPetDebug: {} },
    performance: { now: () => 0 },
  });
  for (const file of ['sprite.js', 'sprite/window-fit.js', 'sprite/motion.js', 'sprite/playback.js']) {
    vm.runInContext(readFileSync(new URL('../../runtime/electron-helper/' + file, import.meta.url), 'utf8'), context);
  }
  const result = vm.runInContext(
    `(() => {
    let nextFrame;
    globalThis.requestAnimationFrame = (fn) => { nextFrame = fn; return 1; };
    globalThis.cancelAnimationFrame = () => { nextFrame = null; };
    const sprite = Object.assign(Object.create(PetSprite.prototype), {
      size: 440, height: 247.5, winH: 268, halfW: 220, halfH: 123.75,
      margin: { l: 220, r: 220, t: 294, b: 220 },
      pos: { x: 740, y: 400 }, winOffset: { x: 220, y: 294 },
      el: { style: {} }, hitRect: { x: 137.5, y: 55, w: 165, h: 196 },
      sideAllow: 137.5, customPos: null, _facing: 'left',
      moveRef: null, pendingMove: null, throwRef: null, moveToken: 0,
      animations: { moves: { default: { minDist: 100, maxDist: 100, margin: 20, leadSec: 1, tailSec: 1 }, actions: [{ name: 'walk' }] } },
      reportWindow() {}, markPoseDirty() {},
      switchTo() { this.startMoveDrive(video); },
    });
    const video = { duration: 10, currentTime: 0 };
    let walks = 0;
    let frames = 0;
    let visible = true;
    for (const facing of ['left', 'right']) {
      sprite._facing = facing;
      for (let n = 0; n < 60; n++) {
        video.currentTime = 0;
        if (!sprite.tryMove('walk')) break;
        walks++;
        for (let t = 0; t <= 9; t += 0.25) {
          video.currentTime = t;
          const frame = nextFrame;
          nextFrame = null;
          if (!frame) break;
          frame();
          frames++;
          const left = sprite.pos.x + sprite.hitRect.x;
          const right = left + sprite.hitRect.w;
          visible = visible && left >= 0 && right <= VIEW.w;
        }
      }
      if (sprite.tryMove('walk')) throw new Error('walked past edge');
    }
    // 模拟异常自主坐标：不管来自哪条运动路径，最终落位必须兜底。
    sprite.sendBounds(-9999, 400);
    const hitRight = sprite.pos.x + sprite.hitRect.x + sprite.hitRect.w;
    return { walks, frames, visible, hitRight };
  })()`,
    context,
  ) as { walks: number; frames: number; visible: boolean; hitRight: number };
  assert.ok(result.walks > 20);
  assert.ok(result.frames > 500);
  assert.equal(result.visible, true);
  assert.ok(result.hitRight >= MIN_REACHABLE_PX);
});

test('多屏兜底不把正常跨屏身体吸回主屏，空洞中的身体则回到最近屏', () => {
  const areas = [
    { x: -1000, y: 0, width: 1000, height: 800 },
    { x: 0, y: 0, width: 1000, height: 800 },
  ];
  assert.deepEqual(clampReachableRect(areas, { x: -50, y: 200, width: 100, height: 100 }, 24), { x: -50, y: 200 });
  assert.deepEqual(clampReachableRect([areas[1]], { x: 1200, y: -500, width: 100, height: 100 }, 24), {
    x: 976,
    y: -76,
  });
  assert.deepEqual(clampReachableRect([areas[1]], { x: -100, y: 200, width: 10, height: 10 }, 24), { x: 0, y: 200 });
});
