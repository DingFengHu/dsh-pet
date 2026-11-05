/**
 * 右键菜单、悬浮提示与悬停键的入口：贴在宠物上的浮层，共享同一套关闭与定位时机。
 * 不负责动作本身：菜单叶子交给 menu-actions 派发。
 * 浮层句柄只在本模块持有，卸载时统一关闭；提示位置直接写 style，不走 React 状态。
 * @module dsh-pet/src/client/pet/card/entry
 */
import { displayOfHotkey } from '../../../shared/display-hotkey.ts';
import { TODO_HOTKEY_HINT, isTodoHotkey } from '../../../shared/todo/hotkey.ts';
import type { PetDisplay } from '../../../shared/types.ts';
import {
  buildMenuTree,
  buildMoreBranch,
  displayMenuBranch,
  mountContextMenu,
  type MenuNode,
} from '../../../shared/menu.ts';
import { TOOLTIP_GAP_RATIO, tooltipPlacement } from '../../../shared/tooltip.ts';
import type { MenuMoreItem } from '../../../shared/menu.ts';
import type { CardLive } from './live.ts';
import type { CardMotion } from './motion.ts';
import type { CardStateApi } from './state.ts';
import type { Drag } from '../motion/drag.ts';
import type { MenuActions } from '../menu-actions.ts';
import type { RuntimePet } from '../types.ts';
import type * as ReactNS from 'react';

/** 注入的 react 能力。 */
export interface CardEntryRuntime {
  /** 副作用；卸载时关闭浮层。 */
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
  /** 引用；浮层句柄与提示节点。 */
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
}

/** 浮层入口的输入。 */
export interface CardEntryInput {
  /** 卡状态：提示显隐与写入口。 */
  card: CardStateApi;
  /** 成品配置的最新值。 */
  cfgRef: ReactNS.MutableRefObject<RuntimePet>;
  /** 装配根迟绑槽。 */
  live: ReactNS.MutableRefObject<CardLive>;
  /** 运动面：开菜单前要停飞与停走。 */
  motion: CardMotion;
  /** 拖拽驱动：拖拽中或刚拖完不弹菜单。 */
  drag: Drag;
  /** 第三方菜单项快照；只在右键那一刻读。 */
  menuItemsRef: ReactNS.MutableRefObject<MenuMoreItem[]>;
  /** 菜单动作派发。 */
  runMenuAction: MenuActions['run'];
  /** 打开待办面板：面板占气泡槽，显隐归气泡单槽管。 */
  showTodo: () => void;
  /** 开关待办面板：D 键用，已开则收起。 */
  toggleTodo: () => void;
  /** 悬浮提示节点：位置由本模块直接写 style。 */
  tipRef: ReactNS.MutableRefObject<HTMLDivElement | null>;
}

/** 浮层入口对外的读写面。 */
export interface CardEntry {
  /** 把提示框摆到光标右下，放不下时翻边并夹回视口。 */
  placeTip: (clientX: number, clientY: number) => void;
  /** 打开右键菜单。 */
  handleContextMenu: (e: ReactNS.MouseEvent<HTMLDivElement>) => void;
  /** 打开待办面板（右键菜单入口）。 */
  openTodo: () => void;
  /** 指针进入：先摆位再显示。 */
  onPointerEnter: (e: ReactNS.PointerEvent<HTMLDivElement>) => void;
  /** 指针离开：收起提示。 */
  onPointerLeave: () => void;
}

/**
 * 造浮层入口的 hook。
 *
 * @param rt - 注入的 react 能力。
 * @returns 接收装配输入的 hook，返回菜单与提示的入口。
 */
export function createCardEntry(rt: CardEntryRuntime) {
  const { useEffect, useRef } = rt;

  return function useCardEntry(input: CardEntryInput): CardEntry {
    const { card, cfgRef, drag, live, menuItemsRef, motion, runMenuAction, showTodo, tipRef, toggleTodo } = input;
    // 右键菜单当前的句柄，卸载或重开前清理。
    const menuRef = useRef<{ close: () => void } | null>(null);

    /** 把提示框摆到光标右下，放不下时翻边并夹回视口。
     *  直接写 DOM style：每次鼠标移动都走 React 状态会让整个 PetCard 重渲染。
     */
    const placeTip = (clientX: number, clientY: number): void => {
      const tipEl = tipRef.current;
      if (!tipEl) return;
      const viewport = document.documentElement;
      const p = tooltipPlacement(
        { x: clientX, y: clientY },
        { w: tipEl.offsetWidth, h: tipEl.offsetHeight },
        { x: 0, y: 0, w: viewport.clientWidth, h: viewport.clientHeight },
        motion.metrics().size * TOOLTIP_GAP_RATIO,
      );
      tipEl.style.left = p.x + 'px';
      tipEl.style.top = p.y + 'px';
    };

    // 卸载时关闭可能开着的右键菜单。
    useEffect(
      () => () => {
        if (menuRef.current) {
          menuRef.current.close();
          menuRef.current = null;
        }
      },
      [],
    );

    /** 打开待办面板：面板占气泡槽，重复点击是幂等的。 */
    const openTodo = (): void => showTodo();

    // 悬停标记：快捷键只在"鼠标停在这只宠物上"时生效，避免和页面其它交互抢事件。
    const hoverRef = useRef(false);
    // 待办开关同样只在悬停时生效；存 ref 是因为它每次渲染都新建，闭包会捕获旧的那份。
    const toggleTodoRef = useRef(toggleTodo);
    toggleTodoRef.current = toggleTodo;
    // 数字键切显示位置：与右键「显示位置」子菜单同一条动作派发（写 display 配置，宿主重启生效）。
    const switchDisplayRef = useRef<(display: PetDisplay) => void>(() => {});
    switchDisplayRef.current = (display) => {
      runMenuAction({ label: '显示位置', action: 'set-display', display });
    };
    // 悬停键：D 开关待办、1-4 切显示位置；只在鼠标停在这只宠物上时生效。
    useEffect(() => {
      // 挂载时注册一次监听，但始终调用最新的闭包（它们读 ref，不能捕获旧值）。
      const onKeyDown = (e: KeyboardEvent): void => {
        if (!hoverRef.current) return;
        const display = displayOfHotkey(e);
        if (display !== undefined) {
          e.preventDefault();
          switchDisplayRef.current(display);
          return;
        }
        if (!isTodoHotkey(e)) return;
        e.preventDefault();
        toggleTodoRef.current();
      };
      document.addEventListener('keydown', onKeyDown, true);
      return () => {
        document.removeEventListener('keydown', onKeyDown, true);
      };
    }, []);
    live.current.placeTip = placeTip;
    live.current.tipOn = () => card.state.tipOn;

    /** 打开右键菜单。 */
    const handleContextMenu = (e: ReactNS.MouseEvent<HTMLDivElement>): void => {
      // 第三方菜单项统一收在「更多」下：label 唯一的平铺，重名的按 owner 分子菜单（见 buildMoreBranch）。
      const more = buildMoreBranch(menuItemsRef.current);
      // 顺序与桌面端同一排法：待办 → 动作树 → 显示位置 / 回到初始位置。
      // 桌面专属的两项（打开软件、重载配置）在网页端没有对应动作，不出现。
      const tools: MenuNode[] = [
        { label: '待办事项', action: 'todo', hint: TODO_HOTKEY_HINT },
      ];
      const tail: MenuNode[] = [
        // 显示位置子菜单与桌面端同一份；改成不含 web 的值后本宠物会从页面消失。
        displayMenuBranch(),
        { label: '回到初始位置', action: 'home' },
      ];
      const tree: MenuNode[] = [
        ...tools,
        ...buildMenuTree(cfgRef.current.animations),
        ...tail,
        ...(more ? [more] : []),
      ];
      if (!tree.length) return;
      e.preventDefault();
      e.stopPropagation(); // 不触碰 DSH 页面的菜单与右键处理。
      if (drag.isActive() || drag.justDragged()) return;
      motion.flight.stop(); // 菜单弹出前停住飞行中的宠物。
      motion.stopMove(); // 菜单悬停期间宠物不漫游。
      if (menuRef.current) menuRef.current.close();
      menuRef.current = mountContextMenu({
        tree,
        x: e.clientX,
        y: e.clientY,
        onAction: runMenuAction,
        // 菜单被点外或 Esc 关闭时置空句柄，避免残留引用。
        onClose: () => {
          if (menuRef.current) menuRef.current = null;
        },
      });
    };

    return {
      handleContextMenu,
      onPointerEnter: (e) => {
        hoverRef.current = true;
        placeTip(e.clientX, e.clientY); // 先摆位再显示，否则会先在兜底坐标闪一帧。
        card.actions.setTipOn(true);
      },
      onPointerLeave: () => {
        hoverRef.current = false;
        card.actions.setTipOn(false);
      },
      openTodo,
      placeTip,
    };
  };
}
