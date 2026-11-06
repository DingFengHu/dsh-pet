'use strict';
/**
 * AI 用量面板窗口：Shift+左键点大肥鱼弹出，再点一次、按 Esc 或点到别处就收起。
 *
 * 单例窗口，按点击位置摆在光标旁边并钳进当前屏工作区；页面是同目录的 usage.html（file://），
 * 数据经本机插件路由 /usage 读取（凭证由应用层按渲染页白名单注入，见 src/app/desktop-auth.ts）。
 * @module dsh-pet/runtime/electron-helper/main/usage-window
 */
const path = require('node:path');

/** 面板内容区尺寸（CSS px）。 */
const PANEL_W = 400;
const PANEL_H = 700;
/** 与光标的间距。 */
const GAP = 18;

/**
 * 按光标位置摆放：优先放右侧，放不下放左侧；纵向以光标为中心，整体钳进工作区。
 *
 * @param cursor - 光标屏幕坐标。
 * @param area - 当前屏工作区。
 * @param size - 面板尺寸。
 * @returns 窗口左上角。
 */
function placePanel(cursor, area, size) {
  const w = Math.min(size.width, area.width);
  const h = Math.min(size.height, area.height);
  let x = cursor.x + GAP;
  if (x + w > area.x + area.width) x = cursor.x - GAP - w;
  x = Math.max(area.x, Math.min(x, area.x + area.width - w));
  let y = Math.round(cursor.y - h / 2);
  y = Math.max(area.y, Math.min(y, area.y + area.height - h));
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

/**
 * 造面板能力。
 *
 * @param deps.BrowserWindow - Electron BrowserWindow。
 * @param deps.screen - Electron screen。
 * @param deps.helperDir - runtime/electron-helper 目录。
 * @param deps.apiUrl - 用量数据地址（`<origin>/dsh-pet-7340/usage`）。
 * @param deps.zoom - 页面缩放（与宠物窗口同源：应用强制设备缩放为 1，高 DPI 屏靠 zoomFactor 放大）。
 */
function createUsageWindow({ BrowserWindow, screen, helperDir, apiUrl, zoom = () => 1 }) {
  /** @type {import('electron').BrowserWindow | null} */
  let win = null;
  /** 刚刚因失焦收起的时刻：同一次 Shift+点击先触发失焦再触发 toggle，别把它又打开。 */
  let hiddenByBlurAt = 0;

  /**
   * 取（必要时新建）面板窗口。透明窗口在首帧前改尺寸会整窗不绘制（实测 Windows），
   * 所以窗口直接按目标尺寸创建；缩放变了（换屏 / 改 DPI）就重建而不是 setSize。
   *
   * @param bounds - 目标矩形。
   */
  function ensure(bounds) {
    if (win && !win.isDestroyed()) {
      const [w, h] = win.getSize();
      if (w === bounds.width && h === bounds.height) return win;
      win.destroy();
      win = null;
    }
    win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
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
      title: 'AI 用量',
      icon: path.join(helperDir, '..', '..', 'assets', 'logo.png'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.webContents.on(
      'did-finish-load',
      () => win && !win.isDestroyed() && win.webContents.setZoomFactor(currentZoom()),
    );
    win.webContents.on('context-menu', (event) => event.preventDefault());
    // 页面里只有本机数据请求；任何导航或新窗口一律拒绝。
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        hide();
      }
    });
    win.on('blur', () => {
      if (win && !win.isDestroyed() && win.isVisible()) {
        hiddenByBlurAt = Date.now();
        hide();
      }
    });
    win.on('closed', () => {
      win = null;
    });
    win.loadFile(path.join(helperDir, 'usage.html'), { query: { api: apiUrl } }).catch((error) => {
      console.error('[dsh-pet-desktop-helper] usage panel load failed:', error && error.message);
    });
    return win;
  }

  function currentZoom() {
    const z = Number(zoom());
    return Number.isFinite(z) && z >= 0.5 && z <= 4 ? z : 1;
  }

  function hide() {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.webContents.executeJavaScript('window.__usageHidden && window.__usageHidden()').catch(() => undefined);
    win.hide();
    console.log('[dsh-pet-desktop-helper] usage panel hidden');
  }

  function show() {
    const cursor = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const z = currentZoom();
    const bounds = placePanel(cursor, area, { width: Math.round(PANEL_W * z), height: Math.round(PANEL_H * z) });
    const w = ensure(bounds);
    w.webContents.setZoomFactor(z);
    w.setPosition(bounds.x, bounds.y);
    w.show();
    w.focus();
    w.webContents.focus();
    console.log(
      `[dsh-pet-desktop-helper] usage panel shown ${bounds.width}x${bounds.height}@${bounds.x},${bounds.y} zoom=${z}`,
    );
    // 页面据此立即刷新一次（隐藏期间不轮询）
    w.webContents.executeJavaScript('window.__usageShown && window.__usageShown()').catch(() => undefined);
  }

  return {
    toggle() {
      if (win && !win.isDestroyed() && win.isVisible()) {
        hide();
        return;
      }
      if (Date.now() - hiddenByBlurAt < 300) return;
      show();
    },
    hide,
    destroy() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}

module.exports = { createUsageWindow, placePanel };
