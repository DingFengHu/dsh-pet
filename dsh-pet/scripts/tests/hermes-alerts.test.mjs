/** 真实 React/Chromium 与原生脚本的 Hermes 按钮、首拉及输入区契约，不连接用户服务。 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { rolldown } from 'rolldown';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { safeHermesUrl } = require('../../runtime/electron-helper/hermes-url.js');
const nativeFile = (name) => readFileSync(new URL('../../runtime/electron-helper/' + name, import.meta.url), 'utf8');
const alert = {
  id: 'stored-id',
  title: '<img src=x onerror=evil()>',
  message: '请查看 Hermes 对话',
  url: 'hermes://open/session%2Fone',
};
const snapshot = (alerts = [alert], stale = false) => ({ petId: 'blue', alerts, stale });
const state = (value, counter = 1, lock) => ({
  counter,
  sections: { hermesAlerts: { counter, data: value } },
  pets: lock ? { blue: { lock: { counter, data: lock } } } : {},
});
let server, browser, url;
before(async () => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL('./hermes-alerts.fixture.js', import.meta.url)),
    platform: 'browser',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  });
  const { output } = await bundle.generate({ format: 'iife' });
  await bundle.close();
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(output[0].code);
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      '<!doctype html><html><head><style>.dsh-pet-bubble{position:relative;opacity:1}button:focus-visible{outline:2px solid blue}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function open(t, initial = snapshot(), lock) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  let current = state(initial, 1, lock);
  let releaseState;
  const writes = [];
  let ack = (route) => route.fulfill({ json: { ok: true } });
  await page.route('**/dsh-pet-7340/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/config'))
      return route.fulfill({
        json: { main: { pets: [{ id: 'blue', name: 'Blue', display: 'web', font: { family: 'sans-serif' } }] } },
      });
    if (path.endsWith('/state')) {
      if (new URL(request.url()).search)
        await new Promise((resolve) => {
          releaseState = resolve;
        });
      return route.fulfill({ json: current }).catch(() => {});
    }
    writes.push({ path, body: request.postDataJSON() });
    if (path.endsWith('/hermes/ack')) return ack(route);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(url);
  await page.waitForFunction(() => !!window.slots);
  return {
    page,
    writes,
    setAck: (handler) => {
      ack = handler;
    },
    update: async (value) => {
      current = state(value, current.counter + 1);
      await page.waitForFunction(() => !!window.slots);
      // 已挂起的长轮询由测试明确完成，不依赖 sleep。
      assert.ok(releaseState, '长轮询应该已挂起');
      releaseState();
    },
  };
}

test('浏览器首拉快照立即显示，文本安全、按钮不拖宠物也不切 DSH 会话', async (t) => {
  const { page, writes } = await open(t);
  await page.getByRole('button', { name: '查看对话' }).click();
  assert.deepEqual(await page.evaluate(() => window.opened), [[alert.url, '_blank', 'noopener,noreferrer']]);
  assert.equal(await page.locator('section img').count(), 0);
  assert.equal(await page.getByRole('status').textContent(), '');
  await page.getByRole('button', { name: '知道了' }).focus();
  await page.keyboard.press('Enter');
  await page.getByText('已确认，等待同步').waitFor();
  assert.equal(await page.getByRole('button', { name: '知道了' }).isDisabled(), true);
  assert.equal(await page.getByText(alert.message).isVisible(), true, '成功也应等宿主快照删除');
  assert.deepEqual(writes, [{ path: '/dsh-pet-7340/hermes/ack', body: { id: alert.id } }]);
  assert.equal(await page.evaluate(() => window.wrongFocus), 0);
  assert.equal(await page.evaluate(() => window.petDrags), 0);
});

test('浏览器失败可重试，HTTP 与业务 ok 均必需，stale 保留旧项并允许本地确认', async (t) => {
  const app = await open(t);
  app.setAck((route) => route.fulfill({ status: 503, json: { ok: true } }));
  await app.page.getByRole('button', { name: '知道了' }).click();
  await app.page.getByText('确认失败，请重试').waitFor();
  app.setAck((route) => route.fulfill({ json: { ok: false } }));
  await app.page.getByRole('button', { name: '知道了' }).click();
  await app.page.waitForFunction(
    () =>
      document.querySelector('[role=status]').textContent === '确认失败，请重试' &&
      ![...document.querySelectorAll('button')].find((b) => b.textContent === '知道了').disabled,
  );
  await app.update(snapshot([alert], true));
  await app.page.getByText(alert.message).waitFor();
  // 用户 2026-11-06 要求去掉「可能已过时」提示（#13）：stale 时只保留提醒本身。
  assert.equal(await app.page.getByText('提醒数据可能已过时', { exact: false }).count(), 0);
  assert.equal(await app.page.getByRole('button', { name: '知道了' }).isDisabled(), false);
  assert.equal(await app.page.getByText(alert.message).isVisible(), true);
  assert.equal(app.writes.length, 2);
  await app.page.getByRole('button', { name: '知道了' }).click();
  await app.page.waitForFunction(
    () =>
      document.querySelector('[role=status]').textContent.includes('确认失败，请重试') &&
      ![...document.querySelectorAll('button')].find((b) => b.textContent === '知道了').disabled,
  );
  assert.equal(await app.page.getByText(alert.message).isVisible(), true, 'stale 时写入失败也必须保留提醒');
  assert.deepEqual(app.writes, Array(3).fill({ path: '/dsh-pet-7340/hermes/ack', body: { id: alert.id } }));
});

test('stale 首拉的健康来源提醒仍可打开和本地确认，不发送 Hermes approval', async (t) => {
  const app = await open(t, snapshot([alert], true));
  assert.equal(await app.page.getByRole('button', { name: '知道了' }).isDisabled(), false);
  await app.page.getByText(alert.message).waitFor();
  // 用户 2026-11-06 要求去掉「可能已过时」提示（#13）：stale 时只保留提醒本身。
  assert.equal(await app.page.getByText('提醒数据可能已过时', { exact: false }).count(), 0);
  await app.page.getByRole('button', { name: '查看对话' }).click();
  assert.deepEqual(await app.page.evaluate(() => window.opened), [[alert.url, '_blank', 'noopener,noreferrer']]);
  await app.page.getByRole('button', { name: '知道了' }).click();
  await app.page.getByText('已确认，等待同步', { exact: false }).waitFor();
  assert.equal(await app.page.getByRole('button', { name: '知道了' }).isDisabled(), true);
  assert.equal(await app.page.getByText(alert.message).isVisible(), true, '本地确认成功也等宿主删除');
  assert.deepEqual(app.writes, [{ path: '/dsh-pet-7340/hermes/ack', body: { id: alert.id } }]);
  await app.update(snapshot([], true));
  await app.page.getByRole('button', { name: '知道了' }).waitFor({ state: 'detached' });
});

test('确认在途时重挂面板仍只发一条请求，成功后由宿主快照删除', async (t) => {
  const app = await open(t);
  let finishAck;
  app.setAck(
    (route) =>
      new Promise((resolve) => {
        finishAck = () => resolve(route.fulfill({ json: { ok: true } }));
      }),
  );
  await app.page.getByRole('button', { name: '知道了' }).click();
  await app.page.getByRole('button', { name: '确认中…' }).waitFor();
  await app.page.evaluate(() => window.slots.showTodo());
  await app.page.getByText('用户待办').waitFor();
  await app.page.evaluate(() => window.slots.hideTodo());
  await app.page.getByRole('button', { name: '知道了' }).click();
  await app.page.getByRole('button', { name: '确认中…' }).waitFor();
  assert.equal(app.writes.length, 1);
  finishAck();
  await app.page.getByText('已确认，等待同步').waitFor();
  await app.update(snapshot([]));
  await app.page.getByRole('button', { name: '知道了' }).waitFor({ state: 'detached' });
});

test('浏览器待办优先、锁定隐藏、底层说话保留、宿主移除驱动消失', async (t) => {
  const app = await open(t);
  await app.page.getByText(alert.message).waitFor();
  await app.page.evaluate(() => {
    window.slots.showWhisper('原有说话', {}, 60000);
    window.slots.showTodo();
  });
  await app.page.getByText('用户待办').waitFor();
  assert.equal(await app.page.getByText(alert.message).count(), 0);
  await app.page.evaluate(() => window.slots.hideTodo());
  await app.page.getByText(alert.message).waitFor();
  await app.page.evaluate(() => window.lockAlerts(true));
  await app.page.getByText('原有说话').waitFor();
  await app.page.evaluate(() => window.lockAlerts(false));
  await app.page.getByText(alert.message).waitFor();
  await app.update(snapshot([]));
  await app.page.getByText('原有说话').waitFor();
  assert.equal(await app.page.getByText(alert.message).count(), 0);
});

test('首拉占用锁和无 URL，不能先闪出可点提醒', async (t) => {
  const app = await open(t, snapshot(), { locked: true, expiresAt: Date.now() + 60000 });
  assert.equal(await app.page.getByRole('button', { name: '知道了' }).count(), 0);
  const noUrl = await open(t, snapshot([{ ...alert, url: 'javascript:evil()' }]));
  await noUrl.page.getByText(alert.message).waitFor();
  assert.equal(await noUrl.page.getByRole('button', { name: '查看对话' }).isDisabled(), true);
});

async function native(t) {
  const app = await open(t, snapshot([]));
  await app.page.evaluate(() => {
    window.__dshPetDebug = {};
    window.CONFIG = { isWindowClampedToWorkArea: false };
    window.VIEW = { x: 0, y: 0, w: 1920, h: 1080 };
    window.WORK_AREAS = [{ x: 0, y: 0, width: 1920, height: 1040 }];
    window.sprites = [];
    window.STATE_URL = location.origin + '/native-state';
    window.STATE_WAIT_MS = 20000;
    window.BASE = location.origin + '/dsh-pet-7340';
    window.workTick = 0;
    window.toScreen = (value) => value;
    window.petBridge = {
      openHermesConversation: (url) => window.opened.push(url),
      focusDshHost: () => window.wrongFocus++,
      setInputBusy: (value) => {
        window.busy = value;
      },
      setInputRegions: (value) => {
        window.regions = value;
      },
      requestKeyboardFocus: () => {},
    };
  });
  await app.page.setViewportSize({ width: 880, height: 782 });
  await app.page.addStyleTag({ content: nativeFile('index.html').match(/<style>([\s\S]*?)<\/style>/)[1] });
  for (const file of ['sprite.js', 'sprite/window-fit.js', 'sprite/input.js', 'sprite/bubble.js', 'events.js'])
    await app.page.addScriptTag({ content: nativeFile(file) });
  await app.page.evaluate(() => {
    const sprite = Object.create(PetSprite.prototype);
    Object.assign(sprite, {
      pet: { id: 'blue' },
      frozen: false,
      bubble: document.createElement('div'),
      menuOpen: false,
      todoOpen: false,
      dragState: { active: false },
      menuItems: [],
      inputRegionElements: new Set(),
      workSessionId: 'wrong-dsh-session',
      size: 440,
      winH: 268,
      halfW: 220,
      halfH: 123.75,
      margin: { l: 220, r: 220, t: 294, b: 220 },
      pos: { x: 600, y: 400 },
      winOffset: { x: 220, y: 294 },
      hitRect: { x: 137.5, y: 55, w: 165, h: 196 },
      el: document.createElement('div'),
      reportWindow() {},
      markPoseDirty() {},
    });
    sprite.inputRegionResize = new ResizeObserver(() => sprite.syncInputRegions());
    sprite.el.className = 'pet-sprite';
    sprite.el.style.cssText =
      'left:220px;top:294px;width:440px;height:247.5px;--pet-size:440px;--dsh-pet-font-bubble:20px';
    sprite.bubble.className = 'pet-bubble';
    sprite.bubble.addEventListener('pointerdown', () => window.wrongFocus++);
    sprite.el.appendChild(sprite.bubble);
    document.body.appendChild(sprite.el);
    window.nativeSprite = sprite;
    sprites.push(sprite);
  });
  return app;
}

test('原生首拉、输入 busy/矩形和两按钮事件路径，pending 防重复，失败保留提醒', async (t) => {
  const app = await native(t);
  await app.page.route('**/native-state*', (route) => route.fulfill({ json: state(snapshot()) }));
  await app.page.evaluate(() => pollStateOnce());
  await app.page.getByText(alert.message).waitFor();
  assert.equal(await app.page.evaluate(() => window.busy), true);
  assert.equal(await app.page.evaluate(() => window.regions.rects.length), 1);
  await app.page.getByRole('button', { name: '查看对话' }).click();
  assert.deepEqual(await app.page.evaluate(() => window.opened), [alert.url]);
  let finishAck;
  app.setAck(
    (route) =>
      new Promise((resolve) => {
        finishAck = () => {
          resolve(route.fulfill({ json: { ok: false } }));
        };
      }),
  );
  await app.page.getByRole('button', { name: '知道了' }).click();
  await app.page.getByRole('button', { name: '确认中…' }).waitFor();
  await app.page.evaluate(() => document.querySelector('section button:last-child').click());
  assert.equal(app.writes.length, 1);
  finishAck();
  await app.page.getByText('确认失败，请重试').waitFor();
  assert.equal(await app.page.evaluate(() => window.wrongFocus), 0);
  await app.page.evaluate(() => {
    nativeSprite.frozen = true;
    nativeSprite.renderBubble();
  });
  assert.equal(await app.page.getByRole('button', { name: '知道了' }).count(), 0);
  assert.equal(await app.page.evaluate(() => window.busy), false);
  await app.page.evaluate(() => {
    nativeSprite.frozen = false;
    nativeSprite.renderBubble();
  });
  await app.page.getByText(alert.message).waitFor();
  app.setAck((route) => route.fulfill({ json: { ok: true } }));
  await app.page.getByRole('button', { name: '知道了' }).click();
  await app.page.getByText('已确认，等待同步').waitFor();
  assert.equal(await app.page.getByText(alert.message).isVisible(), true);
  await app.page.evaluate(() =>
    applyHermesAlertsLeaf({ counter: 2, data: { ...nativeSprite.hermesAlerts, stale: true } }),
  );
  await app.page.getByText(alert.message).waitFor();
  // 用户 2026-11-06 要求去掉「可能已过时」提示（#13）：stale 时只保留提醒本身。
  assert.equal(await app.page.getByText('提醒数据可能已过时', { exact: false }).count(), 0);
  await app.page.evaluate(() => {
    nativeSprite.todoOpen = true;
    nativeSprite.renderBubble();
  });
  assert.equal(await app.page.evaluate(() => nativeSprite.bubbleSlot), 'todo');
  await app.page.evaluate(() => {
    nativeSprite.todoOpen = false;
    nativeSprite.renderBubble();
  });
  await app.page.getByText(alert.message).waitFor();
  await app.page.evaluate(() =>
    applyHermesAlertsLeaf({ counter: 3, data: { petId: 'blue', alerts: [], stale: false } }),
  );
  assert.equal(await app.page.getByRole('button', { name: '知道了' }).count(), 0);
  assert.equal(await app.page.evaluate(() => window.busy), false);
});

test('通知在四边、挂边、多屏和小屏内完整摆放，移动后命中区同步', async (t) => {
  const app = await native(t);
  await app.page.evaluate((alert) => {
    nativeSprite.hermesAlerts = { petId: 'blue', alerts: [alert], stale: false };
    nativeSprite.renderBubble();
  }, alert);
  for (const [x, y] of [
    [-200, -100],
    [1680, -100],
    [-200, 900],
    [1680, 900],
    [-200, 400],
    [1680, 400],
    [600, -100],
    [600, 900],
    [600, 400],
  ]) {
    const result = await app.page.evaluate(
      ([x, y]) => {
        nativeSprite.sendBounds(x, y);
        const rect = nativeSprite.bubble.getBoundingClientRect().toJSON();
        const bounds = nativeSprite.visibleClampRect();
        nativeSprite.syncInputRegions();
        return {
          rect,
          bounds,
          repeated: nativeSprite.bubble.getBoundingClientRect().toJSON(),
          region: regions.rects[0],
        };
      },
      [x, y],
    );
    const { rect, bounds } = result;
    assert.ok(rect.left >= bounds.x && rect.top >= bounds.y, `左上边界 ${x},${y}`);
    assert.ok(rect.right <= bounds.x + bounds.w && rect.bottom <= bounds.y + bounds.h, `右下边界 ${x},${y}`);
    assert.deepEqual(result.repeated, rect, '重复布局不能振荡');
    assert.deepEqual(result.region, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }
  await app.page.evaluate(() => {
    nativeSprite.sendBounds(1680, -100);
    nativeSprite.el.style.setProperty('--dsh-pet-font-bubble', '36px');
  });
  await app.page.waitForFunction(() => {
    const rect = nativeSprite.bubble.getBoundingClientRect();
    const bounds = nativeSprite.visibleClampRect();
    return (
      rect.right <= bounds.x + bounds.w &&
      rect.bottom <= bounds.y + bounds.h &&
      regions.rects[0].width === rect.width &&
      regions.rects[0].height === rect.height
    );
  });
  await app.page.evaluate(() => {
    VIEW.x = -1920;
    VIEW.y = -200;
    WORK_AREAS = [
      { x: 0, y: 200, width: 1920, height: 1040 },
      { x: 1920, y: 0, width: 360, height: 300 },
    ];
    toScreen = (value) => value * 1.5;
    nativeSprite.hermesAlerts.alerts[0].title = 'DSH 长任务名称'.repeat(50);
    nativeSprite.hermesAlerts.alerts[0].message = '多行正文\n'.repeat(100);
    nativeSprite.sendBounds(1900, 0);
    nativeSprite.renderBubble();
  });
  await app.page.getByRole('button', { name: '知道了' }).scrollIntoViewIfNeeded();
  const small = await app.page.evaluate(() => {
    const rect = nativeSprite.bubble.getBoundingClientRect().toJSON();
    const panel = nativeSprite.hermesPanel.el;
    return {
      rect,
      bounds: nativeSprite.visibleClampRect(),
      scrollable: panel.scrollHeight > panel.clientHeight,
      region: regions.rects[0],
    };
  });
  assert.ok(small.scrollable, '过长内容仍可滚动访问按钮');
  assert.ok(small.rect.left >= small.bounds.x && small.rect.top >= small.bounds.y);
  assert.ok(
    small.rect.right <= small.bounds.x + small.bounds.w && small.rect.bottom <= small.bounds.y + small.bounds.h,
  );
  assert.equal(small.region.x, small.rect.x * 1.5, 'DPI 换算只发生在 IPC 边界');
  await app.page.getByRole('button', { name: '知道了' }).click();
  await app.page.getByText('已确认，等待同步').waitFor();
  await app.page.evaluate(() => {
    nativeSprite.hermesAlerts.alerts = [];
    nativeSprite.renderBubble();
  });
  assert.equal(await app.page.locator('.is-fitted-alert').count(), 0, '退出通知槽不影响其它气泡');
});

test('原生 IPC 白名单仅打开安全 Hermes/网页，不调用 DSH 或执行命令', () => {
  const handlers = new Map(),
    opened = [];
  const win = { isDestroyed: () => false };
  const sandbox = {
    require: (name) =>
      name === 'electron'
        ? { BrowserWindow: { fromWebContents: () => win }, screen: {} }
        : name === '../hermes-url.js'
          ? { safeHermesUrl }
          : { decideWindowIgnore() {} },
    module: { exports: {} },
    console,
    process: { env: {} },
    URL,
  };
  vm.runInNewContext(nativeFile('main/ipc.js'), sandbox);
  sandbox.module.exports.registerIpc({
    ipcMain: { on: (name, handler) => handlers.set(name, handler) },
    petWindows: { state: { windows: new Map([['blue', win]]) } },
    shell: { openExternal: async (url) => opened.push(url) },
    openTarget: 'desktop',
  });
  for (const url of [
    'javascript:evil()',
    'file:///x',
    'https://name:pass@example.test',
    'hermes://open/a/b',
    alert.url,
    'https://example.test/#/session',
  ]) {
    handlers.get('pet:open-hermes')({ sender: {} }, { url });
  }
  assert.deepEqual(opened, [alert.url, 'https://example.test/#/session']);
});
