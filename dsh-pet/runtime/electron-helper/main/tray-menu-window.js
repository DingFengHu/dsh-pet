'use strict';
/**
 * 托盘右键菜单窗口（Windows）：替代 Electron 自带的托盘菜单。
 *
 * 原因：应用把 Chromium 的设备缩放强制成 1（宠物定位需要，见 DPI 线性化；改成主屏缩放会让混合缩放的
 * 多屏坐标失去线性，2026-11-26 实测），Electron 的托盘菜单由 Chromium 绘制，也按 1 倍画在 1.75 倍的屏上，
 * 字小得看不清；菜单 API 又不能单独调字号。所以这里自己画，按宠物缩放设 zoomFactor（同用量面板）。
 *
 * 关闭不依赖焦点：Windows 常常不把前台焦点给这个弹窗，只靠 blur 会出现「点别处不关」。窗口铺满光标
 * 所在屏（含任务栏），背景几乎全透明但能接住点击，菜单面板画在光标处；点到面板外任何位置就关
 * （和系统菜单一样，这一下点击被菜单吃掉）。拿到焦点时 Esc、切走（blur）也关；点了某项先关再执行。
 * 每次弹出都新建窗口：透明窗口首帧前改尺寸会整窗不绘制。
 * @module dsh-pet/runtime/electron-helper/main/tray-menu-window
 */
const path = require('node:path');

/** 尺寸（CSS px）：与 tray-menu.html 的样式一一对应。 */
const MENU_W = 200;
const ITEM_H = 28;
const SEP_H = 9;
/** 外边距 6×2 + 内边距 4×2 + 边框 1×2。 */
const CHROME_H = 22;

/**
 * 把 Electron 菜单模板压成页面要的纯数据（去掉 click 等函数）。
 *
 * @param template - Menu.buildFromTemplate 用的模板。
 * @returns 页面菜单项。
 */
function toPageItems(template) {
  return template.map((item) =>
    item.type === 'separator'
      ? { separator: true }
      : { label: String(item.label || ''), checkbox: item.type === 'checkbox', checked: item.checked === true },
  );
}

/**
 * 菜单面板的 CSS 高度。
 *
 * @param template - 菜单模板。
 */
function menuHeight(template) {
  return template.reduce((h, item) => h + (item.type === 'separator' ? SEP_H : ITEM_H), CHROME_H);
}

/**
 * 面板摆在光标处：托盘在屏幕底部，默认往光标左上方展开；放不下就翻到另一侧，最后钳进工作区。
 *
 * @param cursor - 光标屏幕坐标。
 * @param area - 光标所在屏的工作区。
 * @param size - 面板尺寸（物理像素）。
 * @returns 面板矩形（屏幕坐标）。
 */
function placeMenu(cursor, area, size) {
  const w = Math.min(size.width, area.width);
  const h = Math.min(size.height, area.height);
  let x = cursor.x - w;
  if (x < area.x) x = cursor.x;
  let y = cursor.y - h;
  if (y < area.y) y = cursor.y;
  x = Math.max(area.x, Math.min(x, area.x + area.width - w));
  y = Math.max(area.y, Math.min(y, area.y + area.height - h));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

/**
 * 整个弹窗的布局：窗口 = 光标所在屏的完整范围（含任务栏），面板在窗口内的 CSS 坐标。
 *
 * @param cursor - 光标屏幕坐标。
 * @param display - 光标所在屏（bounds 与 workArea，物理像素）。
 * @param template - 菜单模板。
 * @param zoom - 页面缩放。
 * @returns 窗口矩形与面板 CSS 左上角。
 */
function layoutMenu(cursor, display, template, zoom) {
  const panel = placeMenu(cursor, display.workArea, {
    width: Math.round(MENU_W * zoom),
    height: Math.round(menuHeight(template) * zoom),
  });
  const b = display.bounds;
  return {
    window: { x: b.x, y: b.y, width: b.width, height: b.height },
    panel: { left: Math.round((panel.x - b.x) / zoom), top: Math.round((panel.y - b.y) / zoom) },
  };
}

/**
 * 造菜单窗口能力。
 *
 * @param deps.BrowserWindow - Electron BrowserWindow。
 * @param deps.screen - Electron screen。
 * @param deps.helperDir - runtime/electron-helper 目录。
 * @param deps.zoom - 页面缩放（与宠物窗口同源）。
 * @returns show(template) / close()。
 */
function createTrayMenuWindow({ BrowserWindow, screen, helperDir, zoom = () => 1 }) {
  /** @type {import('electron').BrowserWindow | null} */
  let win = null;

  function currentZoom() {
    const z = Number(zoom());
    return Number.isFinite(z) && z >= 0.5 && z <= 4 ? z : 1;
  }

  function close() {
    const w = win;
    win = null;
    if (w && !w.isDestroyed()) w.destroy();
  }

  /**
   * 在光标处弹出菜单。
   *
   * @param template - 菜单模板（与 Menu.buildFromTemplate 同形状，click 在主进程执行）。
   */
  function show(template) {
    close();
    const z = currentZoom();
    const cursor = screen.getCursorScreenPoint();
    const layout = layoutMenu(cursor, screen.getDisplayNearestPoint(cursor), template, z);
    const w = new BrowserWindow({
      ...layout.window,
      show: false,
      backgroundColor: '#00000000',
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      enableLargerThanScreen: true,
      title: 'tray-menu',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    win = w;
    // 比任务栏更高的一档，铺满时才接得住点在任务栏上的那一下
    w.setAlwaysOnTop(true, 'pop-up-menu');
    w.webContents.on('did-finish-load', () => {
      if (w.isDestroyed()) return;
      w.webContents.setZoomFactor(z);
      w.show();
      w.focus();
      w.webContents.focus();
    });
    // 页面上报：tray-menu:pick:<序号> 执行该项；tray-menu:dismiss 是点到了面板外
    w.on('page-title-updated', (event, title) => {
      const text = String(title);
      if (text === 'tray-menu:dismiss') {
        event.preventDefault();
        close();
        return;
      }
      const m = /^tray-menu:pick:(\d{1,3})$/.exec(text);
      if (!m) return;
      event.preventDefault();
      const item = template[Number(m[1])];
      close();
      if (item && typeof item.click === 'function') {
        try {
          item.click();
        } catch (e) {
          console.error('[dsh-pet-desktop-helper] tray menu click failed:', String(e && e.message ? e.message : e));
        }
      }
    });
    w.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
    w.on('blur', () => {
      if (win === w) close();
    });
    w.webContents.on('will-navigate', (event) => event.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.loadFile(path.join(helperDir, 'tray-menu.html'), {
      query: {
        items: JSON.stringify(toPageItems(template)),
        left: String(layout.panel.left),
        top: String(layout.panel.top),
      },
    }).catch((error) => {
      // 连点右键时旧窗口在加载中被新的一次关掉，这里会报 ERR_ABORTED/ERR_FAILED，属正常
      if (win === w) {
        console.error('[dsh-pet-desktop-helper] tray menu load failed:', error && error.message);
        close();
      }
    });
  }

  return { show, close };
}

module.exports = { createTrayMenuWindow, placeMenu, menuHeight, toPageItems, layoutMenu };
