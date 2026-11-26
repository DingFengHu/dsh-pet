/**
 * 托盘自绘菜单窗口的纯计算（runtime/electron-helper/main/tray-menu-window.js）。
 *
 * 摆放：托盘在屏幕底部，菜单往光标左上展开，放不下翻边，始终在工作区内；
 * 高度：与 tray-menu.html 的样式常量一致；页面数据：不带函数，只留文字与勾选。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface TrayMenuModule {
  placeMenu(cursor: { x: number; y: number }, area: Rect, size: { width: number; height: number }): Rect;
  menuHeight(template: Array<Record<string, unknown>>): number;
  toPageItems(template: Array<Record<string, unknown>>): Array<Record<string, unknown>>;
  layoutMenu(
    cursor: { x: number; y: number },
    display: { bounds: Rect; workArea: Rect },
    template: Array<Record<string, unknown>>,
    zoom: number,
  ): { window: Rect; panel: { left: number; top: number } };
}

const { placeMenu, menuHeight, toPageItems, layoutMenu } = createRequire(import.meta.url)(
  '../../runtime/electron-helper/main/tray-menu-window.js',
) as TrayMenuModule;

const area: Rect = { x: 0, y: 0, width: 3840, height: 2076 };

describe('placeMenu', () => {
  test('右下角托盘：往光标左上展开', () => {
    assert.deepEqual(placeMenu({ x: 3500, y: 2120 }, area, { width: 420, height: 400 }), {
      x: 3080,
      y: 1676,
      width: 420,
      height: 400,
    });
  });

  test('靠左上：翻到光标右下，且不出工作区', () => {
    const r = placeMenu({ x: 10, y: 10 }, area, { width: 420, height: 400 });
    assert.deepEqual([r.x, r.y], [10, 10]);
  });

  test('副屏（负坐标）也钳在该屏工作区里', () => {
    const top: Rect = { x: 627, y: -1440, width: 2560, height: 1380 };
    const r = placeMenu({ x: 700, y: -1430 }, top, { width: 420, height: 400 });
    assert.ok(r.x >= top.x && r.x + r.width <= top.x + top.width);
    assert.ok(r.y >= top.y && r.y + r.height <= top.y + top.height);
  });
});

describe('layoutMenu', () => {
  test('窗口铺满整块屏（含任务栏）用来接住点到别处的点击；面板在光标左上，按缩放换成 CSS 坐标', () => {
    const display = { bounds: { x: 0, y: 0, width: 3840, height: 2160 }, workArea: area };
    const template = [{ label: 'a' }, { label: 'b' }];
    const r = layoutMenu({ x: 3500, y: 2120 }, display, template, 1.75);
    assert.deepEqual(r.window, { x: 0, y: 0, width: 3840, height: 2160 });
    const w = Math.round(200 * 1.75);
    const h = Math.round((22 + 28 * 2) * 1.75);
    // 面板底边不超出工作区（任务栏上沿 2076）
    assert.deepEqual(r.panel, { left: Math.round((3500 - w) / 1.75), top: Math.round((2076 - h) / 1.75) });
  });

  test('副屏：面板坐标相对该屏左上角', () => {
    const display = {
      bounds: { x: 975, y: 2160, width: 1920, height: 1080 },
      workArea: { x: 975, y: 2160, width: 1920, height: 1020 },
    };
    const r = layoutMenu({ x: 2800, y: 3170 }, display, [{ label: 'a' }], 1);
    assert.deepEqual(r.window, display.bounds);
    assert.ok(r.panel.left >= 0 && r.panel.top >= 0);
    assert.ok(r.panel.left + 200 <= 1920 && r.panel.top + 50 <= 1020);
  });
});

describe('menuHeight / toPageItems', () => {
  const template = [
    { label: '蓝毛小女仆', type: 'checkbox', checked: true, click: () => undefined },
    { type: 'separator' },
    { label: '位置复原', click: () => undefined },
  ];

  test('高度 = 边框留白 22 + 每项 28 + 每条分隔线 9', () => {
    assert.equal(menuHeight(template), 22 + 28 + 9 + 28);
  });

  test('页面数据不带函数，保留文字、勾选和分隔线', () => {
    assert.deepEqual(toPageItems(template), [
      { label: '蓝毛小女仆', checkbox: true, checked: true },
      { separator: true },
      { label: '位置复原', checkbox: false, checked: false },
    ]);
  });
});
