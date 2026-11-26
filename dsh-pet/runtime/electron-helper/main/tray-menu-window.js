'use strict';
/**
 * 托盘右键菜单窗口（Windows）：替代 Electron 自带的托盘菜单。
 *
 * 原因：应用把 Chromium 的设备缩放强制成 1（宠物定位需要，见 DPI 线性化），Electron 的托盘菜单由 Chromium
 * 自己绘制，于是也按 1 倍画在 1.75 倍的屏上，字小得看不清；菜单 API 又不能单独调字号。
 * 这里用一个小透明窗口画菜单，按宠物缩放设 zoomFactor（同用量面板）。每次弹出都新建窗口：
 * 透明窗口首帧前改尺寸会整窗不绘制。点到别处（失焦）、按 Esc 或点了某项就关。
 * @module dsh-pet/runtime/electron-helper/main/tray-menu-window
 */
const path = require('node:path');

/** 尺寸（CSS px）：与 tray-menu.html 的样式一一对应。 */
const MENU_W = 240;
const ITEM_H = 32;
const SEP_H = 9;
/** 外边距 6×2 + 内边距 4×2 + 边框 1×2。 */
const CHROME_H = 22;
/** 失焦兜底的轮询间隔与「一直没碰」的自动关闭时长（ms）。 */
const WATCH_TICK_MS = 200;
const UNFOCUSED_TIMEOUT_MS = 8000;

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
 * 菜单窗口的 CSS 高度。
 *
 * @param template - 菜单模板。
 */
function menuHeight(template) {
  return template.reduce((h, item) => h + (item.type === 'separator' ? SEP_H : ITEM_H), CHROME_H);
}

/**
 * 弹在光标处：托盘在屏幕底部，默认往光标左上方展开；放不下就翻到另一侧，最后钳进工作区。
 *
 * @param cursor - 光标屏幕坐标。
 * @param area - 光标所在屏的工作区。
 * @param size - 窗口尺寸（物理像素）。
 * @returns 窗口矩形。
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

  /** 没拿到焦点时的兜底轮询（见 watchUnfocused）。 */
  let watchTimer = null;

  function close() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
    const w = win;
    win = null;
    if (w && !w.isDestroyed()) w.destroy();
  }

  /**
   * 失焦兜底：Windows 可能不给弹窗前台焦点（右键后用户又动了别的窗口），那样 blur 永远不来。
   * 拿不到焦点期间：鼠标进过菜单再离开就关；一直没碰过，超过 UNFOCUSED_TIMEOUT_MS 也关。拿到焦点后交给 blur。
   */
  function watchUnfocused(w) {
    const started = Date.now();
    let hovered = false;
    watchTimer = setInterval(() => {
      if (win !== w || w.isDestroyed()) return close();
      if (w.isFocused()) {
        clearInterval(watchTimer);
        watchTimer = null;
        return;
      }
      const c = screen.getCursorScreenPoint();
      const b = w.getBounds();
      const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
      if (inside) hovered = true;
      else if (hovered || Date.now() - started > UNFOCUSED_TIMEOUT_MS) close();
    }, WATCH_TICK_MS);
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
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const bounds = placeMenu(cursor, area, {
      width: Math.round(MENU_W * z),
      height: Math.round(menuHeight(template) * z),
    });
    const w = new BrowserWindow({
      ...bounds,
      show: false,
      backgroundColor: '#00000000',
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      title: 'tray-menu',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    win = w;
    w.setAlwaysOnTop(true, 'pop-up-menu');
    w.webContents.on('did-finish-load', () => {
      if (w.isDestroyed()) return;
      w.webContents.setZoomFactor(z);
      w.show();
      w.focus();
      w.webContents.focus();
      watchUnfocused(w);
    });
    // 点击上报：title 形如 tray-menu:pick:<序号>，拦下来执行模板里的 click
    w.on('page-title-updated', (event, title) => {
      const m = /^tray-menu:pick:(\d{1,3})$/.exec(String(title));
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
      query: { items: JSON.stringify(toPageItems(template)) },
    }).catch((error) => {
      console.error('[dsh-pet-desktop-helper] tray menu load failed:', error && error.message);
      if (win === w) close();
    });
  }

  return { show, close };
}

module.exports = { createTrayMenuWindow, placeMenu, menuHeight, toPageItems };
