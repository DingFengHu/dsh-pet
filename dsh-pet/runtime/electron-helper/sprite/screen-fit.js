/**
 * 逐屏尺寸适配：宠物落定在短边小于参考值（默认 2K 的 1440）的屏上时按比例缩小，回到大屏恢复。
 *
 * 线性化后 CSS 像素 = 物理像素 ÷ CONFIG.scale，所以换缩放只需三步：改 CONFIG.scale 并请主进程同步
 * 页面缩放、按新比例重新导入物理几何、让脚底中点停在原来的物理位置。拖拽/抛掷/走路/菜单等输入
 * 期间绝不切换（位置由输入或物理驱动），由 renderer.js 的低频定时器在空闲时调用。
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * @module dsh-pet/runtime/electron-helper/sprite-screen-fit
 */
'use strict';

/** 缩放差小于此值视为相同，避免取整抖动反复切换。 */
const SCREEN_FIT_EPSILON = 0.01;

Object.assign(PetSprite.prototype, {
  /** 此刻能否安全切换缩放：任何运动或输入进行中都不行。 */
  screenFitIdle() {
    return (
      !this.dragState.active &&
      this.throwRef === null &&
      this.moveRef === null &&
      this.posFollow === null &&
      this.pendingMove === null &&
      !this.inputBusy()
    );
  },

  /**
   * 按宠物中心所在的屏调整缩放；切换了返回 true。
   * 判定用中心点，锚定用脚底中点：上下叠放的屏缝处缩放后中心只会往脚底方向移，不会来回翻转。
   */
  fitScreenScale() {
    if (!(CONFIG.refScreenPx > 0) || !LAST_GEO || !this.pos) return false;
    if (!window.petBridge || typeof window.petBridge.setZoom !== 'function') return false;
    if (!this.screenFitIdle()) return false;
    const F = window.PetScreenFit;
    const panels = Array.isArray(LAST_GEO.panels) && LAST_GEO.panels.length > 0 ? LAST_GEO.panels : LAST_GEO.areas;
    const target = F.targetScaleAt({
      baseScale: CONFIG.baseScale,
      panels,
      refPx: CONFIG.refScreenPx,
      x: toScreen(VIEW.x + this.pos.x + this.halfW),
      y: toScreen(VIEW.y + this.pos.y + this.halfH),
    });
    if (!(target > 0) || Math.abs(target - CONFIG.scale) < SCREEN_FIT_EPSILON) return false;
    // 脚底中点（物理像素）在换算前取：换完比例后它要原地不动
    const anchorX = toScreen(VIEW.x + this.pos.x + this.halfW);
    const anchorY = toScreen(VIEW.y + this.pos.y + this.winH);
    CONFIG.scale = target;
    window.petBridge.setZoom(target);
    if (!applyDeskGeometry(LAST_GEO)) return false;
    this.space = null; // 抛掷空间按新单位重建
    const x = toLocal(anchorX) - VIEW.x - this.halfW;
    const y = toLocal(anchorY) - VIEW.y - this.winH;
    // 位置写成会话内比例：页面缩放改变会触发 resize → position()，它按 customPos 还原
    this.customPos = { rx: (x + this.halfW) / VIEW.w, ry: (y + this.halfH) / VIEW.h };
    this.sendBounds(x, y);
    this.syncInputRegions();
    window.__dshPetDebug.screenFitScale = target;
    return true;
  },
});
