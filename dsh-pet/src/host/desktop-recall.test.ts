/**
 * 召回与隐藏的行为契约（runtime/electron-helper/main/recall.js）。
 *
 * 召回要把「不见了」的几种来路一次收掉：隐藏的窗口重新显示、沉底的窗口重新钉进置顶带、
 * 渲染端收到回到初始位置的消息。窗口全由测试注入，不需要真的 Electron。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

interface RecallApi {
  isHidden(): boolean;
  hide(): void;
  show(): void;
  recall(): void;
  reset(): void;
}
interface RecallModule {
  createRecall(deps: Record<string, unknown>): RecallApi;
}

const { createRecall } = createRequire(import.meta.url)('../../runtime/electron-helper/main/recall.js') as RecallModule;

/** 假窗口：记录收到的调用。 */
function fakeWindow(options: { visible?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = [];
  let visible = options.visible ?? true;
  return {
    calls,
    isDestroyed: () => options.destroyed === true,
    isVisible: () => visible,
    showInactive: () => {
      visible = true;
      calls.push('showInactive');
    },
    hide: () => {
      visible = false;
      calls.push('hide');
    },
    setAlwaysOnTop: (flag: boolean, level: string) => calls.push(`top:${flag}:${level}`),
    webContents: { send: (channel: string) => calls.push(`send:${channel}`) },
  };
}

function harness(windows: Array<ReturnType<typeof fakeWindow>>) {
  const offTaskbar: unknown[] = [];
  const changes: boolean[] = [];
  const recall = createRecall({
    petWindows: {
      state: { windows: new Map(windows.map((w, i) => [String(i), w])) },
      keepOffTaskbar: (win: unknown) => offTaskbar.push(win),
    },
    topmostLevel: 'screen-saver',
    onChange: (hidden: boolean) => changes.push(hidden),
  });
  return { recall, offTaskbar, changes };
}

describe('createRecall', () => {
  test('召回：隐藏的窗口重新显示，所有窗口重钉置顶，再通知渲染端回家', () => {
    const shown = fakeWindow();
    const hidden = fakeWindow({ visible: false });
    const { recall, offTaskbar, changes } = harness([shown, hidden]);
    recall.recall();
    assert.deepEqual(shown.calls, ['top:true:screen-saver', 'send:pet:go-home']);
    assert.deepEqual(hidden.calls, ['showInactive', 'top:true:screen-saver', 'send:pet:go-home']);
    assert.equal(offTaskbar.length, 2, '显示后要再摘一次任务栏按钮');
    assert.equal(recall.isHidden(), false);
    assert.deepEqual(changes, [false]);
  });

  test('隐藏 → 显示：切换状态并通知托盘；显示不让宠物回家', () => {
    const win = fakeWindow();
    const { recall, changes } = harness([win]);
    recall.hide();
    assert.equal(recall.isHidden(), true);
    assert.equal(win.isVisible(), false);
    recall.show();
    assert.equal(recall.isHidden(), false);
    assert.equal(win.isVisible(), true);
    assert.equal(win.calls.includes('send:pet:go-home'), false, '显示只是露面，位置不动');
    assert.deepEqual(changes, [true, false]);
  });

  test('已销毁的窗口一律跳过', () => {
    const dead = fakeWindow({ destroyed: true });
    const { recall } = harness([dead]);
    recall.recall();
    recall.hide();
    recall.show();
    assert.deepEqual(dead.calls, []);
  });

  test('隐藏后召回：一样回到显示状态', () => {
    const win = fakeWindow();
    const { recall } = harness([win]);
    recall.hide();
    recall.recall();
    assert.equal(recall.isHidden(), false);
    assert.equal(win.isVisible(), true);
  });

  test('reset：窗口重建后状态归位为显示', () => {
    const { recall, changes } = harness([fakeWindow()]);
    recall.hide();
    recall.reset();
    assert.equal(recall.isHidden(), false);
    assert.deepEqual(changes, [true, false]);
  });
});
