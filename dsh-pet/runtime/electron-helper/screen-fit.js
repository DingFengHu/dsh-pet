/**
 * 逐屏尺寸适配的纯换算：线性化后宠物在所有屏上是同样的物理像素，小分辨率屏上就显得很大。
 * 以参考屏短边（默认 1440，即 2K 屏）为基准：短边不足参考值的屏按比例缩小，达到或超过的屏不变。
 *
 * 经典 script + CommonJS 双用：渲染端经 index.html 加载挂到 window.PetScreenFit，
 * 主进程与 node:test 经 require 加载。不碰 Electron 与 DOM。
 * @module dsh-pet/runtime/electron-helper/screen-fit
 */
'use strict';

(function (root) {
  /** 默认参考屏短边（物理像素）：2560×1440 的 2K 屏。 */
  const DEFAULT_REF_SCREEN_PX = 1440;

  /**
   * 参考屏短边：DSH_PET_REF_SCREEN_PX 原始值（'0' = 关闭适配；正数 = 覆盖默认）。
   * 只有线性化生效（单位是物理像素）才有意义，否则返回 0。
   */
  function resolveRefScreenPx(o = {}) {
    if (!(Number(o.forcedScale) > 0)) return 0;
    const raw = o.envValue;
    if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_REF_SCREEN_PX;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  /** 某块屏（物理像素 bounds）的尺寸系数：min(1, 短边 / 参考短边)。参考值 ≤0 或数据非法时为 1。 */
  function screenFitFactor(panel, refPx) {
    const ref = Number(refPx);
    if (!(ref > 0) || !panel) return 1;
    const shortSide = Math.min(Number(panel.width), Number(panel.height));
    if (!(shortSide > 0)) return 1;
    return Math.min(1, shortSide / ref);
  }

  /** 点所在的面板（物理像素）；不在任何面板里返回 null。 */
  function panelAt(panels, x, y) {
    if (!Array.isArray(panels)) return null;
    for (const p of panels) {
      if (p && x >= p.x && x < p.x + p.width && y >= p.y && y < p.y + p.height) return p;
    }
    return null;
  }

  /** 宠物在点 (x, y)（物理像素）处应有的渲染缩放；点落在空洞里返回 0（调用方保持现状）。 */
  function targetScaleAt(o = {}) {
    const base = Number(o.baseScale) || 1;
    const panel = panelAt(o.panels, o.x, o.y);
    if (!panel) return 0;
    return base * screenFitFactor(panel, o.refPx);
  }

  const api = { DEFAULT_REF_SCREEN_PX, resolveRefScreenPx, screenFitFactor, panelAt, targetScaleAt };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetScreenFit = api;
})(typeof window !== 'undefined' ? window : globalThis);
