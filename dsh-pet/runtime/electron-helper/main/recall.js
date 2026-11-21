'use strict';
/**
 * 召回与隐藏：托盘「位置复原」「隐藏宠物 / 显示宠物」和再次双击桌面图标共用的窗口操作。
 *
 * 宠物「不见了」有几种来路：走到屏幕外、窗口从置顶带沉底被普通窗口盖住（WS_EX_TOPMOST 位还在，
 * Z 序却在下面）、被隐藏。召回一次把这几种都收掉：显示窗口 → 重新钉进置顶带 → 渲染端回到初始位置。
 * 隐藏只是本次运行内的状态，不写配置；重启后照常显示。
 * @module dsh-pet/runtime/electron-helper/main/recall
 */

/**
 * 造召回能力。
 *
 * @param deps.petWindows - 窗口能力（state.windows 与 keepOffTaskbar）。
 * @param deps.topmostLevel - 置顶层级（与建窗时同一口径）。
 * @param deps.onChange - 隐藏状态变化后调用（托盘据此刷新菜单文字），可选。
 * @returns isHidden / hide / show / recall / reset。
 */
function createRecall({ petWindows, topmostLevel, onChange }) {
  let hidden = false;

  /** 还活着的宠物窗口。 */
  function liveWindows() {
    return [...petWindows.state.windows.values()].filter((win) => win && !win.isDestroyed());
  }

  function changed() {
    if (typeof onChange === 'function') onChange(hidden);
  }

  /**
   * 显示并重新钉进置顶带：setAlwaysOnTop 在 Windows 上每次都发 SetWindowPos(HWND_TOPMOST)，
   * 沉底窗口靠它回到置顶带（2026-11-21 实机验证）。不用 moveTop：HWND_TOP 不落置顶带。
   */
  function surface(win) {
    if (!win.isVisible()) win.showInactive();
    win.setAlwaysOnTop(true, topmostLevel);
    petWindows.keepOffTaskbar(win);
  }

  function hide() {
    for (const win of liveWindows()) win.hide();
    hidden = true;
    changed();
  }

  function show() {
    for (const win of liveWindows()) surface(win);
    hidden = false;
    changed();
  }

  /** 召回：显示、置顶，再让渲染端停下漫游并回到配置角落（同右键「回到初始位置」）。 */
  function recall() {
    for (const win of liveWindows()) {
      surface(win);
      win.webContents.send('pet:go-home');
    }
    hidden = false;
    changed();
  }

  return {
    isHidden: () => hidden,
    hide,
    show,
    recall,
    /** 窗口重建后新窗口是显示的，状态跟着归位。 */
    reset() {
      hidden = false;
      changed();
    },
  };
}

module.exports = { createRecall };
