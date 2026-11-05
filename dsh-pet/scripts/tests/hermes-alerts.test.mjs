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
  await app.page.getByText('提醒数据可能已过时，仍可点击“知道了”在本地忽略').waitFor();
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
  await app.page.getByText('提醒数据可能已过时，仍可点击“知道了”在本地忽略').waitFor();
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
    window.PetSprite = class {};
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
  for (const file of ['sprite/input.js', 'sprite/bubble.js', 'events.js'])
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
      inputRegionResize: { observe() {}, unobserve() {} },
      workSessionId: 'wrong-dsh-session',
    });
    sprite.bubble.className = 'pet-bubble';
    sprite.bubble.style.cssText = 'display:block;width:300px;min-height:30px';
    sprite.bubble.addEventListener('pointerdown', () => window.wrongFocus++);
    document.body.appendChild(sprite.bubble);
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
  await app.page.getByText('提醒数据可能已过时，仍可点击“知道了”在本地忽略').waitFor();
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
