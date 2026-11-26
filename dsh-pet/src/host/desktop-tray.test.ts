/**
 * 桌面托盘的行为契约（runtime/electron-helper/main/tray.js）。
 *
 * 三条行为必须成立：勾选来自配置、点一下写回相反的一档、退出项按运行形态决定自己退还是交给宿主。
 * 依赖全由调用方注入（含 Electron 的 Tray/Menu/nativeImage），所以这里不需要真的 Electron。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/** 托盘模块是给 Helper 用的 CJS，没有类型声明：这里按用到的形状窄化。 */
interface TrayModule {
  createTray(deps: Record<string, unknown>): {
    start(): Promise<void>;
    refresh(): Promise<void>;
    exists(): boolean;
    destroy(): void;
  };
}

/** 一条菜单项：只断言用到的字段。 */
interface MenuItem {
  label: string;
  type?: string;
  checked?: boolean;
  click?: () => void;
}

const { createTray } = createRequire(import.meta.url)('../../runtime/electron-helper/main/tray.js') as TrayModule;

/** 造一套假依赖：记录宿主请求、菜单模板与退出调用。 */
function harness(options: {
  appMode?: boolean;
  isBridge?: boolean;
  canQuit?: boolean;
  pets?: Array<Record<string, unknown>>;
  recall?: Record<string, unknown>;
  popupMenu?: Record<string, unknown>;
}) {
  const handlers: Record<string, () => void> = {};
  const requests: string[] = [];
  const bodies: string[] = [];
  const quits: string[] = [];
  const menus: MenuItem[][] = [];

  class FakeTray {
    setToolTip(): void {}
    setContextMenu(menu: unknown): void {
      menus.push((menu as { template: MenuItem[] }).template);
    }
    on(event: string, handler: () => void): void {
      handlers[event] = handler;
    }
    popUpContextMenu(): void {}
    destroy(): void {}
  }

  const deps = {
    app: { quit: () => quits.push('app.quit') },
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template: MenuItem[]) => ({ template }) },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => false, resize: () => ({ setTemplateImage: () => {} }) }),
    },
    hostRequest: async (method: string, url: string, body?: string) => {
      requests.push(method + ' ' + url);
      if (body !== undefined) bodies.push(body);
      if (url.endsWith('/config')) {
        return { status: 200, body: JSON.stringify({ main: { pets: options.pets ?? [] } }) };
      }
      if (url.endsWith('/quit')) {
        return { status: 200, body: JSON.stringify({ canQuit: options.canQuit === true }) };
      }
      return { status: 200, body: '{}' };
    },
    callbackUrl: () => 'http://127.0.0.1:1/bridge',
    isBridge: options.isBridge ?? false,
    appMode: options.appMode ?? false,
    petRoute: '/dsh-pet-7340',
    platform: { templateImage: false, leftClickPopsMenu: false },
    helperDir: '.',
    recall: options.recall,
    popupMenu: options.popupMenu,
  };

  const tray = createTray(deps);
  return { tray, requests, bodies, quits, menus, handlers };
}

/** 取最后一次构建出来的菜单模板。 */
function lastMenu(menus: MenuItem[][]): MenuItem[] {
  const menu = menus[menus.length - 1];
  assert.ok(menu, '托盘应已构建出菜单');
  return menu;
}

describe('createTray —— 勾选与点击', () => {
  test('勾选状态来自配置：含 desktop / both 的两只被打勾', async () => {
    const { tray, menus } = harness({
      pets: [
        { label: 'a', id: 'a', display: 'both' },
        { label: 'b', id: 'b', display: 'web' },
        { label: 'c', id: 'c', display: 'desktop' },
      ],
    });
    await tray.start();
    const items = lastMenu(menus).filter((item) => item.type === 'checkbox');
    assert.deepEqual(
      items.map((item) => item.checked),
      [true, false, true],
    );
  });

  test('点一下写回相反的一档：both→web，web→both，desktop→none，none→desktop', async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['both', 'web'],
      ['web', 'both'],
      ['desktop', 'none'],
      ['none', 'desktop'],
    ];
    for (const [from, to] of cases) {
      const { tray, menus, requests, bodies } = harness({ pets: [{ label: 'a', id: 'a', display: from }] });
      await tray.start();
      const item = lastMenu(menus).find((entry) => entry.type === 'checkbox');
      assert.ok(item?.click, '每只宠物都应有可点的开关项');
      item.click();
      assert.ok(requests.includes('POST /dsh-pet-7340/pet-display'), `display=${from} 时应把新值写回宿主`);
      assert.equal(
        (JSON.parse(bodies[0] ?? '{}') as { display?: string }).display,
        to,
        `display=${from} 应写成 ${to}（浏览器位保持不动）`,
      );
    }
  });
});

describe('createTray —— 退出项的分支', () => {
  test('应用模式：自己 app.quit()，不请求宿主', async () => {
    const { tray, menus, quits, requests } = harness({
      appMode: true,
      pets: [{ label: 'a', id: 'a', display: 'both' }],
    });
    await tray.start();
    const quit = lastMenu(menus).find((item) => item.label === '退出');
    assert.ok(quit?.click, '应用模式必须有退出项');
    quit.click();
    assert.deepEqual(quits, ['app.quit']);
    assert.equal(
      requests.some((request) => request.startsWith('POST') && request.endsWith('/quit')),
      false,
    );
  });

  test('bridge 且宿主允许：把退出交给宿主（自己退会被当成崩溃重启）', async () => {
    const { tray, menus, quits, requests } = harness({
      isBridge: true,
      canQuit: true,
      pets: [{ label: 'a', id: 'a', display: 'both' }],
    });
    await tray.start();
    const quit = lastMenu(menus).find((item) => item.label === '退出');
    assert.ok(quit?.click, '宿主允许时应有退出项');
    quit.click();
    assert.deepEqual(quits, [], 'bridge 下不得自己退');
    assert.ok(requests.includes('POST /dsh-pet-7340/quit'), '必须把退出请求交给宿主');
  });

  test('bridge 且宿主不允许：不出现退出项', async () => {
    const { tray, menus } = harness({
      isBridge: true,
      canQuit: false,
      pets: [{ label: 'a', id: 'a', display: 'both' }],
    });
    await tray.start();
    assert.equal(
      lastMenu(menus).some((item) => item.label === '退出'),
      false,
    );
  });
});

describe('createTray —— 位置复原与隐藏/显示', () => {
  /** 假召回能力：记录调用，hidden 可由测试改。 */
  function fakeRecall() {
    const calls: string[] = [];
    const state = { hidden: false };
    return {
      calls,
      state,
      recall: {
        isHidden: () => state.hidden,
        recall: () => calls.push('recall'),
        hide: () => calls.push('hide'),
        show: () => calls.push('show'),
      },
    };
  }

  test('没注入 recall：菜单与原来一样，没有这两项', async () => {
    const { tray, menus } = harness({ appMode: true, pets: [{ label: 'a', id: 'a', display: 'both' }] });
    await tray.start();
    const labels = lastMenu(menus).map((item) => item.label);
    assert.equal(labels.includes('位置复原'), false);
    assert.equal(labels.includes('隐藏宠物'), false);
  });

  test('显示中：有「位置复原」和「隐藏宠物」，点了分别调 recall / hide，且排在退出之前', async () => {
    const r = fakeRecall();
    const { tray, menus } = harness({ appMode: true, pets: [{ label: 'a', id: 'a', display: 'both' }], recall: r.recall });
    await tray.start();
    const menu = lastMenu(menus);
    const labels = menu.map((item) => item.label);
    assert.ok(labels.indexOf('位置复原') < labels.indexOf('退出'));
    menu.find((item) => item.label === '位置复原')?.click?.();
    menu.find((item) => item.label === '隐藏宠物')?.click?.();
    assert.deepEqual(r.calls, ['recall', 'hide']);
    assert.equal(labels.includes('显示宠物'), false);
    // 新增两项都是普通项：宠物勾选项的数量不变
    assert.equal(menu.filter((item) => item.type === 'checkbox').length, 1);
  });

  test('隐藏中：刷新后变成「显示宠物」，点了调 show', async () => {
    const r = fakeRecall();
    const { tray, menus } = harness({ appMode: true, pets: [{ label: 'a', id: 'a', display: 'both' }], recall: r.recall });
    await tray.start();
    r.state.hidden = true;
    await tray.refresh();
    const menu = lastMenu(menus);
    assert.equal(
      menu.some((item) => item.label === '隐藏宠物'),
      false,
    );
    menu.find((item) => item.label === '显示宠物')?.click?.();
    assert.deepEqual(r.calls, ['show']);
  });

  test('菜单文字过期（刷新失败）时，点击仍按真实状态切换', async () => {
    const r = fakeRecall();
    const { tray, menus } = harness({ appMode: true, pets: [{ label: 'a', id: 'a', display: 'both' }], recall: r.recall });
    await tray.start();
    const stale = lastMenu(menus).find((item) => item.label === '隐藏宠物');
    r.state.hidden = true; // 已隐藏，但菜单没刷新，仍写着「隐藏宠物」
    stale?.click?.();
    assert.deepEqual(r.calls, ['show']);
  });
});

describe('createTray —— 自绘菜单（Windows 高 DPI 字号）', () => {
  test('注入 popupMenu：不挂 Electron 菜单，右键现读配置弹自绘菜单，点击照常生效', async () => {
    const shown: MenuItem[][] = [];
    const pets: Array<Record<string, unknown>> = [{ label: 'a', id: 'a', display: 'both' }];
    const { tray, menus, handlers, quits } = harness({
      appMode: true,
      pets,
      popupMenu: { show: (template: MenuItem[]) => shown.push(template) },
    });
    await tray.start();
    assert.equal(menus.length, 0, '不得再 setContextMenu（那份菜单按 1 倍缩放绘制，字太小）');
    assert.ok(handlers['right-click'], '必须自己接管右键');
    pets[0] = { label: 'a', id: 'a', display: 'web' };
    handlers['right-click']();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const template = shown[shown.length - 1];
    assert.ok(template, '右键应弹出自绘菜单');
    assert.equal(template[0].checked, false, '每次右键现读配置，勾选是当下的');
    template.find((item) => item.label === '退出')?.click?.();
    assert.deepEqual(quits, ['app.quit']);
    await tray.refresh();
    assert.equal(menus.length, 0, 'refresh 也不得挂回 Electron 菜单');
  });
});

describe('createTray —— 重建后刷新', () => {
  test('refresh 重读配置：勾选跟着变，菜单被替换', async () => {
    const pets: Array<Record<string, unknown>> = [{ label: 'a', id: 'a', display: 'both' }];
    const { tray, menus } = harness({ pets });
    await tray.start();
    assert.equal(lastMenu(menus)[0].checked, true);
    pets[0] = { label: 'a', id: 'a', display: 'web' };
    await tray.refresh();
    assert.equal(menus.length, 2, 'refresh 应重新设置一次菜单');
    assert.equal(lastMenu(menus)[0].checked, false, '配置变了勾选要跟着变');
  });

  test('没建托盘时 refresh 什么都不做（托盘开关关掉的情况）', async () => {
    const { tray, menus } = harness({ pets: [] });
    await tray.refresh();
    assert.equal(menus.length, 0);
  });
});
