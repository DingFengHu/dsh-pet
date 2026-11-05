/**
 * 气泡单槽的纯函数契约（src/client/pet/card/bubble-slots.ts）：优先级判定与余额页数。
 *
 * 只覆盖无状态部分；显隐与停留计时需要真实渲染，由手动验收。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { decideBubbleSlot, type BubbleSlotInput } from './bubble-slots.ts';

/** 一份全部关闭的输入，逐项覆盖出目标场景。 */
function input(overrides: Partial<BubbleSlotInput> = {}): BubbleSlotInput {
  return {
    workTerminal: false,
    workOn: false,
    workText: null,
    workStatusEnabled: true,
    whisperOn: false,
    whisperText: null,
    todoOn: false,
    ...overrides,
  };
}

describe('decideBubbleSlot —— 同一时刻只挂一个气泡', () => {
  test('都没有点亮：返回 none', () => {
    assert.equal(decideBubbleSlot(input()), 'none');
  });

  test('终态任务压过说话：只活 10s，不让位', () => {
    const slot = decideBubbleSlot(
      input({
        workTerminal: true,
        workOn: true,
        workText: '跑完了',
        whisperOn: true,
        whisperText: '在',
      }),
    );
    assert.equal(slot, 'work-terminal');
  });

  test('说话压过非终态任务：优先级第二', () => {
    const slot = decideBubbleSlot(input({ whisperOn: true, whisperText: '在', workOn: true, workText: '干活中' }));
    assert.equal(slot, 'whisper');
  });

  test('只剩非终态任务：常驻显示', () => {
    assert.equal(decideBubbleSlot(input({ workOn: true, workText: '干活中' })), 'work');
  });

  test('关闭工作状态联动：任务气泡不占槽位', () => {
    assert.equal(decideBubbleSlot(input({ workOn: true, workText: '干活中', workStatusEnabled: false })), 'none');
  });

  test('待办面板压过一切：用户主动打开的窗口不让位', () => {
    const slot = decideBubbleSlot(
      input({
        todoOn: true,
        workTerminal: true,
        workOn: true,
        workText: '跑完了',
        whisperOn: true,
        whisperText: '在',
      }),
    );
    assert.equal(slot, 'todo');
  });
});
