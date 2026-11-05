/**
 * 快捷键卡：列出宠物自己的悬停键（鼠标停在宠物上按下才生效）。
 * 悬停键是插件自己的监听，直接读各模块常量，不能改绑。
 * 与页尾其它参考卡一样默认收起；纯展示，开合态只活在组件里。
 * @module dsh-pet/src/client/settings/shortcuts-card
 */
import type { FunctionComponent } from 'react';
import { DISPLAY_HOTKEY_HINTS } from '../../shared/display-hotkey.ts';
import { TODO_HOTKEY_HINT } from '../../shared/todo/hotkey.ts';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit } from './ui.ts';

/** 折叠正文的 id：与标题按钮的 `aria-controls` 成对。 */
const BODY_ID = 'pet-cfg-shortcuts';

/**
 * 造快捷键卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makeShortcutsCard(rt: SettingsRuntime): FunctionComponent {
  const { h, t, useState } = rt;
  const { foldCard } = makeUiKit({ h, t });

  return function ShortcutsCard() {
    const [open, setOpen] = useState(false);
    /** 一行：左边动作名，右边键帽。 */
    const row = (label: string, keys: string) =>
      h('div', {
        className: 'dsh-pet-cfg__field',
        children: [
          h('span', { key: 'l', className: 'dsh-pet-cfg__flabel', children: t(label) }),
          h('span', { key: 'v', className: 'dsh-pet-cfg__note', children: keys }),
        ],
      });

    return foldCard({
      id: BODY_ID,
      title: t('shortcutCardTitle'),
      hint: t('shortcutCardHint'),
      body: [
        h('p', { key: 'petTitle', className: 'dsh-pet-cfg__cardTitle', children: t('shortcutGroupPet') }),
        h('p', { key: 'petHint', className: 'dsh-pet-cfg__note', children: t('shortcutGroupPetHint') }),
        h('div', {
          key: 'petRows',
          className: 'dsh-pet-cfg__grid2',
          children: [
            row('shortcutRowTodo', TODO_HOTKEY_HINT),
            row('shortcutRowDisplay', DISPLAY_HOTKEY_HINTS.join(' · ')),
          ],
        }),
      ],
      open,
      onToggle: () => setOpen(!open),
    });
  };
}
