/**
 * 快捷键卡的契约：行都在、键位取自真源，且与页尾参考卡一样是折叠卡。
 *
 * 这张卡唯一的价值就是「键位只有一处真源」——悬停键读共享常量。
 * 哪天有人把键位写死，这里的断言就会红。
 *
 * 跑法：node --experimental-strip-types --test src/client/settings/shortcuts-card.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { jsx } from 'react/jsx-runtime';

import { DISPLAY_HOTKEY_HINTS } from '../../shared/display-hotkey.ts';
import { TODO_HOTKEY_HINT } from '../../shared/todo/hotkey.ts';
import { makeShortcutsCard } from './shortcuts-card.ts';

/** 节点桩：`h` 只把 tag 与 props 收集起来，不渲染。 */
interface Node {
  tag: string;
  props: Record<string, unknown>;
}

const h = ((tag: unknown, props: Record<string, unknown>) => ({ tag, props })) as unknown as typeof jsx;
/** 假 useState：初始值原样收下，setter 只吞掉调用。 */
const useState = ((init: unknown) => [init, () => {}]) as never;
/** 摊平节点树，把所有文本片段收成数组。 */
function texts(node: unknown): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts((node as Node).props?.children);
}

/** 摊平节点树，收集所有 `data-tip`（问号气泡的内容不在文本里）。 */
function tips(node: unknown): string[] {
  if (node === null || node === undefined || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(tips);
  const element = node as Node;
  const tip = element.props?.['data-tip'];
  return [...(typeof tip === 'string' ? [tip] : []), ...tips(element.props?.children)];
}

/** 摊平节点树，收集所有元素节点。 */
function nodes(node: unknown): Node[] {
  if (node === null || node === undefined || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  const element = node as Node;
  return [element, ...nodes(element.props?.children)];
}

/** 按给定目录渲染一次整张卡。 */
function render(): unknown {
  const Card = makeShortcutsCard({ h, t: (key: string) => key, useState } as never);
  return Card({});
}

describe('ShortcutsCard —— 快捷键卡', () => {
  test('悬停键读共享常量', () => {
    const text = texts(render()).join('\n');
    assert.ok(text.includes(TODO_HOTKEY_HINT), '待办');
    assert.ok(text.includes(DISPLAY_HOTKEY_HINTS.join(' · ')), '显示切换');
  });

  test('标题与说明、以及全部行标签都在', () => {
    const text = texts(render()).join('\n');
    for (const key of ['shortcutGroupPet', 'shortcutGroupPetHint', 'shortcutRowTodo', 'shortcutRowDisplay']) {
      assert.ok(text.includes(key), key + ' 应该出现');
    }
  });

  test('是折叠卡，默认收起（与页尾两张参考卡同一套骨架）', () => {
    const all = nodes(render());
    const card = all.find((node) => String(node.props?.className ?? '').includes('dsh-pet-cfg__card'));
    assert.ok(String(card?.props?.className).includes('is-fold'), '应该是折叠卡');
    assert.ok(!String(card?.props?.className).includes('is-open'), '默认不该展开');
    const toggle = all.find((node) => String(node.props?.className ?? '').includes('dsh-pet-cfg__foldToggle'));
    assert.equal(toggle?.props?.['aria-expanded'], false);
    assert.equal(toggle?.props?.['aria-controls'], 'pet-cfg-shortcuts');
  });

  test('标题是卡片头文本，说明挂在问号气泡上', () => {
    const tree = render();
    assert.ok(texts(tree).join('\n').includes('shortcutCardTitle'), '标题应该在文本里');
    assert.ok(tips(tree).includes('shortcutCardHint'), '说明应该挂在 data-tip 上');
  });
});
