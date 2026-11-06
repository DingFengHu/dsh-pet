'use strict';
/**
 * AI 用量面板窗口「大肥鱼食堂 · 饭票小票」：Shift+左键点大肥鱼弹出，再点一次、按 Esc 或点到别处就收起。
 *
 * 单例窗口，贴在鱼身侧边（右侧放不下放左侧），尾巴指向鱼，不压到鱼；高度跟随小票内容
 * （页面经 document.title「usage:<高度>」上报，主进程据此收紧窗口）。页面是同目录的 usage.html（file://），
 * 数据经本机插件路由 /usage 读取（凭证由应用层按渲染页白名单注入，见 src/app/desktop-auth.ts）。
 * @module dsh-pet/runtime/electron-helper/main/usage-window
 */
const path = require('node:path');

/** 窗口宽（CSS px，含两侧尾巴与阴影余量）。 */
const PANEL_W = 312;
/** 首次打开、还没拿到小票实际高度时的窗口高（CSS px）。 */
const DEFAULT_H = 440;
/** 与鱼身的间距（CSS px）。 */
const GAP = 2;
/** 尾巴瞄准鱼身的高度比例（从鱼身顶部算，约在脸部）。 */
const AIM = 0.32;

/**
 * 贴着鱼身摆放：优先放右侧，放不下放左侧；纵向让尾巴对准鱼脸，整体钳进工作区。
 *
 * @param body - 鱼身命中区的屏幕矩形（物理像素）；缺失时退化为光标点。
 * @param area - 当前屏工作区。
 * @param size - 面板尺寸（物理像素）。
 * @param zoom - 页面缩放（CSS → 物理像素）。
 * @returns 窗口矩形、尾巴所在侧（相对面板）与尾巴的窗口内 CSS 纵坐标。
 */
function placePanel(body, area, size, zoom = 1) {
  const w = Math.min(size.width, area.width);
  const h = Math.min(size.height, area.height);
  const gap = GAP * zoom;
  let side = 'left'; // 尾巴在面板左边 = 面板在鱼右侧
  let x = body.x + body.width + gap;
  if (x + w > area.x + area.width) {
    x = body.x - gap - w;
    side = 'right';
  }
  x = Math.max(area.x, Math.min(x, area.x + area.width - w));
  const aimY = body.y + body.height * AIM;
  let y = Math.round(aimY - 70 * zoom);
  y = Math.max(area.y, Math.min(y, area.y + area.height - h));
  const tailY = Math.max(24, Math.min((aimY - y) / zoom, h / zoom - 40));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h), side, tailY };
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
  /** 小票实际高度（CSS px），页面渲染后上报。 */
  let contentH = DEFAULT_H;
  /** 本次显示的摆放（内容高度变化时据此在工作区内重新钳位）。 */
  let placed = null;

  function currentZoom() {
    const z = Number(zoom());
    return Number.isFinite(z) && z >= 0.5 && z <= 4 ? z : 1;
  }

  /**
   * 取（必要时新建）面板窗口。透明窗口在首帧前改尺寸会整窗不绘制（实测 Windows），
   * 所以新窗口直接按目标矩形创建；显示过的窗口才允许改尺寸。
   *
   * @param bounds - 目标矩形。
   */
  function ensure(bounds) {
    if (win && !win.isDestroyed()) return win;
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
    win.webContents.on('did-finish-load', () => {
      if (!win || win.isDestroyed()) return;
      win.webContents.setZoomFactor(currentZoom());
      applyPlace();
    });
    // 小票高度上报：title 形如 usage:<CSS 高度>，拦下来收紧窗口，不让它真的改标题
    win.on('page-title-updated', (event, title) => {
      const m = /^usage:(\d{2,4})$/.exec(String(title));
      if (!m) return;
      event.preventDefault();
      contentH = Math.max(160, Math.min(2000, Number(m[1])));
      fitHeight();
    });
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

  /** 把尾巴朝向与位置告诉页面。 */
  function applyPlace() {
    if (!win || win.isDestroyed() || !placed) return;
    win.webContents
      .executeJavaScript(
        `window.__usagePlace && window.__usagePlace(${JSON.stringify(placed.side)}, ${Number(placed.tailY)})`,
      )
      .catch(() => undefined);
  }

  /** 内容高度变了：显示中的窗口按新高度收紧（放不下时上移，尾巴随之下移继续对准鱼脸）。 */
  function fitHeight() {
    if (!win || win.isDestroyed() || !win.isVisible() || !placed) return;
    const z = currentZoom();
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const h = Math.min(Math.round(contentH * z), area.height);
    const y = Math.max(area.y, Math.min(b.y, area.y + area.height - h));
    if (b.height === h && b.y === y) return;
    win.setBounds({ x: b.x, y, width: b.width, height: h });
    if (y !== placed.y) {
      placed = { ...placed, tailY: Math.max(24, Math.min(placed.tailY + (placed.y - y) / z, h / z - 40)), y };
      applyPlace();
    }
  }

  function hide() {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.webContents.executeJavaScript('window.__usageHidden && window.__usageHidden()').catch(() => undefined);
    win.hide();
    console.log('[dsh-pet-desktop-helper] usage panel hidden');
  }

  /**
   * 显示在鱼身旁边。
   *
   * @param body - 鱼身屏幕矩形（物理像素），缺失时用光标点。
   */
  function show(body) {
    const cursor = screen.getCursorScreenPoint();
    const anchor = body || { x: cursor.x, y: cursor.y, width: 1, height: 1 };
    const area = screen.getDisplayNearestPoint({
      x: Math.round(anchor.x + anchor.width / 2),
      y: Math.round(anchor.y + anchor.height / 2),
    }).workArea;
    const z = currentZoom();
    // 宽度随缩放变了（换屏 / 改 DPI）就重建：透明窗口首帧前不能改尺寸
    if (win && !win.isDestroyed() && win.getBounds().width !== Math.round(PANEL_W * z)) {
      win.destroy();
      win = null;
    }
    const existing = !!(win && !win.isDestroyed());
    placed = placePanel(anchor, area, { width: Math.round(PANEL_W * z), height: Math.round(contentH * z) }, z);
    const w = ensure(placed);
    w.webContents.setZoomFactor(z);
    if (existing) w.setBounds({ x: placed.x, y: placed.y, width: placed.width, height: placed.height });
    applyPlace();
    w.show();
    w.focus();
    w.webContents.focus();
    console.log(
      `[dsh-pet-desktop-helper] usage panel shown ${placed.width}x${placed.height}@${placed.x},${placed.y} side=${placed.side} zoom=${z}`,
    );
    // 页面据此立即刷新一次（隐藏期间不轮询）
    w.webContents.executeJavaScript('window.__usageShown && window.__usageShown()').catch(() => undefined);
  }

  return {
    /**
     * 开关面板。
     *
     * @param body - 鱼身屏幕矩形（物理像素），可缺省。
     */
    toggle(body) {
      if (win && !win.isDestroyed() && win.isVisible()) {
        hide();
        return;
      }
      if (Date.now() - hiddenByBlurAt < 300) return;
      show(body);
    },
    hide,
    destroy() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}

module.exports = { createUsageWindow, placePanel };
