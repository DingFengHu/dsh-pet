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
}

const { placeMenu, menuHeight, toPageItems } = createRequire(import.meta.url)(
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

describe('menuHeight / toPageItems', () => {
  const template = [
    { label: '蓝毛小女仆', type: 'checkbox', checked: true, click: () => undefined },
    { type: 'separator' },
    { label: '位置复原', click: () => undefined },
  ];

  test('高度 = 边框留白 22 + 每项 32 + 每条分隔线 9', () => {
    assert.equal(menuHeight(template), 22 + 32 + 9 + 32);
  });

  test('页面数据不带函数，保留文字、勾选和分隔线', () => {
    assert.deepEqual(toPageItems(template), [
      { label: '蓝毛小女仆', checkbox: true, checked: true },
      { separator: true },
      { label: '位置复原', checkbox: false, checked: false },
    ]);
  });
});
