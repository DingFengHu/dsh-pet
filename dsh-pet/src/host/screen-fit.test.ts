/**
 * 逐屏尺寸适配测试：线性化后宠物在每块屏上是同样的物理像素，1080p 小屏上显得比 2K 屏大一截。
 * 修法：以 2K 屏短边 1440 为基准，短边更小的屏按比例缩小，更大的屏不变；只在空闲落定后切换。
 *
 * ① 纯换算（screen-fit.js）；② 接线：用替身全局真跑 sprite/screen-fit.js，断言缩放、锚点与守卫；
 * ③ 源码守卫：页面按顺序加载两个新脚本、主进程注入参数、发布必需清单都带上了新文件。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const F = require('../../runtime/electron-helper/screen-fit.js');

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 用户实机的三块屏（物理像素）：4K 主屏 175%、2K、1080p 小屏。 */
const P4K = { x: 0, y: 0, width: 3840, height: 2160 };
const P2K = { x: 627, y: -1440, width: 2560, height: 1440 };
const P1K = { x: 882, y: 2160, width: 1920, height: 1080 };
const PANELS = [P4K, P1K, P2K];

describe('screen-fit.js —— 纯换算', () => {
  test('参考屏短边：线性化未生效 = 0；缺省 1440；"0" 关闭；正数覆盖', () => {
    assert.equal(F.resolveRefScreenPx({ forcedScale: 0 }), 0);
    assert.equal(F.resolveRefScreenPx({ forcedScale: 1 }), 1440);
    assert.equal(F.resolveRefScreenPx({ forcedScale: 1, envValue: '' }), 1440);
    assert.equal(F.resolveRefScreenPx({ forcedScale: 1, envValue: '0' }), 0);
    assert.equal(F.resolveRefScreenPx({ forcedScale: 1, envValue: '2160' }), 2160);
    assert.equal(F.resolveRefScreenPx({ forcedScale: 1, envValue: 'abc' }), 0);
  });

  test('系数：1080p = 0.75，2K/4K = 1（只缩不放），竖屏按短边', () => {
    assert.equal(F.screenFitFactor(P1K, 1440), 0.75);
    assert.equal(F.screenFitFactor(P2K, 1440), 1);
    assert.equal(F.screenFitFactor(P4K, 1440), 1);
    assert.equal(F.screenFitFactor({ x: 0, y: 0, width: 1080, height: 1920 }, 1440), 0.75);
    assert.equal(F.screenFitFactor(P1K, 0), 1);
  });

  test('目标缩放按点所在屏；空洞返回 0', () => {
    assert.equal(F.targetScaleAt({ baseScale: 1.75, panels: PANELS, refPx: 1440, x: 1800, y: 2600 }), 1.75 * 0.75);
    assert.equal(F.targetScaleAt({ baseScale: 1.75, panels: PANELS, refPx: 1440, x: 1800, y: -500 }), 1.75);
    assert.equal(F.targetScaleAt({ baseScale: 1.75, panels: PANELS, refPx: 1440, x: 1000, y: 1000 }), 1.75);
    assert.equal(F.targetScaleAt({ baseScale: 1.75, panels: PANELS, refPx: 1440, x: 100, y: 3000 }), 0);
  });
});

// ---- 接线：替身全局加载 sprite/screen-fit.js ----
type Geo = {
  hull: { x: number; y: number; width: number; height: number };
  panels: typeof PANELS;
  areas: typeof PANELS;
};
const g = globalThis as unknown as Record<string, unknown>;
const CONFIG = { scale: 1.75, baseScale: 1.75, refScreenPx: 1440 };
const VIEW = { x: 0, y: 0, w: 0, h: 0 };
const zooms: number[] = [];
const sent: Array<{ x: number; y: number }> = [];
g.PetSprite = function PetSprite() {};
g.CONFIG = CONFIG;
g.VIEW = VIEW;
g.toScreen = (v: number): number => v * CONFIG.scale;
g.toLocal = (v: number): number => v / CONFIG.scale;
g.applyDeskGeometry = (geo: Geo): boolean => {
  VIEW.x = geo.hull.x / CONFIG.scale;
  VIEW.y = geo.hull.y / CONFIG.scale;
  VIEW.w = geo.hull.width / CONFIG.scale;
  VIEW.h = geo.hull.height / CONFIG.scale;
  return true;
};
const GEO: Geo = { hull: { x: 0, y: -1440, width: 3840, height: 4680 }, panels: PANELS, areas: PANELS };
g.LAST_GEO = GEO;
g.window = { PetScreenFit: F, __dshPetDebug: {}, petBridge: { setZoom: (z: number) => zooms.push(z) } };
require('../../runtime/electron-helper/sprite/screen-fit.js');
const proto = (g.PetSprite as { prototype: Record<string, (...a: unknown[]) => unknown> }).prototype;

/** 造一只宠物，物理中心落在 (cx, cy)。 */
function makePet(cx: number, cy: number, busy = false) {
  CONFIG.scale = CONFIG.baseScale;
  (g.applyDeskGeometry as (geo: Geo) => boolean)(GEO);
  const pet = Object.create(proto) as Record<string, unknown>;
  Object.assign(pet, {
    size: 192,
    halfW: 96,
    halfH: 54,
    winH: 120,
    dragState: { active: busy },
    throwRef: null,
    moveRef: null,
    posFollow: null,
    pendingMove: null,
    customPos: null,
    space: {},
    inputBusy: () => false,
    syncInputRegions: () => {},
    sendBounds(this: Record<string, unknown>, x: number, y: number) {
      this.pos = { x, y };
      sent.push({ x, y });
    },
  });
  pet.pos = { x: cx / CONFIG.scale - VIEW.x - 96, y: cy / CONFIG.scale - VIEW.y - 54 };
  return pet as Record<string, unknown> & { fitScreenScale: () => boolean; pos: { x: number; y: number } };
}

describe('sprite/screen-fit.js —— 换屏缩放接线', () => {
  test('落在 1080p 屏：缩到 0.75 倍，页面缩放同步，脚底中点物理位置不动', () => {
    zooms.length = 0;
    const pet = makePet(1800, 2600);
    const footX = (VIEW.x + pet.pos.x + 96) * CONFIG.scale;
    const footY = (VIEW.y + pet.pos.y + 120) * CONFIG.scale;
    assert.equal(pet.fitScreenScale(), true);
    assert.equal(CONFIG.scale, 1.75 * 0.75);
    assert.deepEqual(zooms, [1.75 * 0.75]);
    assert.ok(Math.abs((VIEW.x + pet.pos.x + 96) * CONFIG.scale - footX) < 1e-6);
    assert.ok(Math.abs((VIEW.y + pet.pos.y + 120) * CONFIG.scale - footY) < 1e-6);
    assert.ok(pet.customPos, '位置写成会话内比例，resize → position() 才不会跳');
    // 再调一次：已是目标值，不重复切换
    assert.equal(pet.fitScreenScale(), false);
  });

  test('从 1080p 回到 4K：恢复基准缩放', () => {
    const pet = makePet(1800, 2600);
    pet.fitScreenScale();
    pet.pos = { x: 1000 / CONFIG.scale - VIEW.x - 96, y: 1000 / CONFIG.scale - VIEW.y - 54 };
    assert.equal(pet.fitScreenScale(), true);
    assert.equal(CONFIG.scale, 1.75);
  });

  test('2K 屏与 4K 屏：不动', () => {
    zooms.length = 0;
    assert.equal(makePet(1800, -500).fitScreenScale(), false);
    assert.equal(makePet(1000, 1000).fitScreenScale(), false);
    assert.deepEqual(zooms, []);
  });

  test('拖拽中不切换', () => {
    zooms.length = 0;
    assert.equal(makePet(1800, 2600, true).fitScreenScale(), false);
    assert.deepEqual(zooms, []);
  });

  test('参考值 0（关闭）不切换', () => {
    CONFIG.refScreenPx = 0;
    try {
      assert.equal(makePet(1800, 2600).fitScreenScale(), false);
    } finally {
      CONFIG.refScreenPx = 1440;
    }
  });
});

describe('源码守卫 —— 加载顺序、参数注入与发布清单', () => {
  test('index.html：screen-fit.js 在 constants.js 前，sprite/screen-fit.js 在 sprite.js 后', () => {
    const html = readSource('../../runtime/electron-helper/index.html');
    const i = (s: string): number => html.indexOf(s);
    assert.ok(i('./screen-fit.js') > 0 && i('./screen-fit.js') < i('./constants.js'));
    assert.ok(i('./sprite/screen-fit.js') > i('./sprite.js') && i('./sprite/screen-fit.js') < i('./renderer.js'));
  });

  test('主进程注入 refScreenPx，并处理 pet:set-zoom', () => {
    assert.match(
      readSource('../../runtime/electron-helper/main/windows.js'),
      /refScreenPx: String\(dpi\.refScreenPx\)/,
    );
    assert.match(readSource('../../runtime/electron-helper/main/ipc.js'), /'pet:set-zoom'/);
    assert.match(readSource('../../runtime/electron-helper/preload.js'), /'pet:set-zoom'/);
  });

  test('发布必需清单带上两个新文件', () => {
    const check = readSource('../../scripts/prepack-check.js');
    assert.ok(check.includes("'runtime/electron-helper/screen-fit.js'"));
    assert.ok(check.includes("'runtime/electron-helper/sprite/screen-fit.js'"));
  });
});
