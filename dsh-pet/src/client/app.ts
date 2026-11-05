/**
 * 浏览器半侧装配层：注入 react，组装宠物 overlay 与设置页，注册进 DSH 插槽。
 * 不负责页面业务：宠物页面在 pet.ts，设置页在 settings.ts。
 * 依赖 DSH 注入的 slots / locale / remote 等 Cordis 服务。
 * 任何可选能力缺失都只降级功能，绝不让整个插件加载失败。
 * @module dsh-pet/src/client/app
 */
import { makePetUI } from './pet.ts';
import { readPose } from './pose.ts';
import { readProgress } from './progress.ts';
import { takeMenuEvents } from './menu-service.ts';
import { getStateSnapshot } from './state-service.ts';
import { dicts, makePetConfigSection, NS } from './settings.ts';
import { initNotify } from './notify.ts';
import { mountBaifan } from './baifan.ts';
import { installSectionNavIcon } from './nav-icon.ts';
import type * as ReactNS from 'react';
import type * as PrimitivesNS from '@deepseek-ai/dsh-client-ui-primitives';

/** 创建 DSH 插件 factory，返回带 name / inject / apply 的模块。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH __ModuleLoader__ 契约（f(require) => module），外部无静态类型
export function makeFactory(): (require: (mod: string) => any) => any {
  return (require) => {
    const module = { exports: {} };

    const react: typeof ReactNS = require('react');
    const { useEffect, useRef, useState, useCallback } = react;
    const { jsx: h } = require('react/jsx-runtime');

    // primitives 是平台种子模块；取不到只影响设置页导航图标，不影响插件加载。
    let primitives: typeof PrimitivesNS | undefined;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      console.warn('[dsh-pet] 图标模块不可用：' + (error instanceof Error ? error.message : String(error)));
    }

    // react-dom 也是平台种子模块，仅用于把图标同步渲成 SVG 供 CSS mask 使用。
    // 取不到就退化成齿轮图标，不影响插件加载。
    let renderIconSvg: ((icon: ReactNS.ComponentType<PrimitivesNS.IconProps>) => string) | undefined;
    try {
      const { createRoot } = require('react-dom/client');
      const { flushSync } = require('react-dom');
      renderIconSvg = (icon) => {
        const holder = document.createElement('div');
        const root = createRoot(holder);
        try {
          // flushSync：root.render 是异步调度，不同步刷一次拿不到 DOM。
          flushSync(() => root.render(h(icon, { size: 16 })));
          return holder.innerHTML;
        } finally {
          root.unmount();
        }
      };
    } catch (error) {
      console.warn(
        '[dsh-pet] 图标渲染器不可用（react-dom 缺失）：' + (error instanceof Error ? error.message : String(error)),
      );
    }

    // 宠物 overlay 与设置页各自独立成文件，这里只组装和注册。
    const PetMulti = makePetUI({ h, useState, useEffect, useRef });

    const name = 'pet';
    const inject = ['slots', 'locale', 'connection', 'remote'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（locale/slots/webServer 等 service 无静态类型）
    function apply(ctx: any) {
      // 设置页文案字典。
      ctx.effect(() => ctx.locale.register(NS, dicts), 'dsh-pet: dictionaries');
      const t = ctx.locale.bind(NS);

      // 同页第三方插件可通过 Cordis 服务 petApi7340 读取本页宠物的实况、播放进度、最近一拍状态与菜单点击。
      // 只开读，控制仍走 HTTP，避免出现两条控制通道。
      // 服务名带 7340 后缀避免与生态里的同名服务冲突；Cordis 同名 provide 会直接抛错。
      // 消费者用 ctx.get('petApi7340') 探测，拿不到就是老版本；`getState` / `menuEvents` 也要单独探测（老版本没有它们）。
      ctx.provide('petApi7340', {
        getState: getStateSnapshot,
        menuEvents: takeMenuEvents,
        pose: readPose,
        progress: readProgress,
      });

      // 内置玩法「吃白饭」：注册走 HTTP，点击读页面内 Cordis 服务，不读本模块的内部状态。
      ctx.effect(() => mountBaifan(ctx), 'dsh-pet: activity-baifan');

      // 系统通知：host 把通知帧写进 /state 的 sections.notify，统一轮询发现变化后弹 toast。
      ctx.effect(
        () =>
          initNotify({
            // 惰性取服务：它可能晚于本插件注册；缺失时退化为只把窗口叫回前台。
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入服务无静态类型
            openSession: (sessionId: string) => (ctx as any).get?.('uiWorkspace')?.openSession?.(sessionId),
            // 通知标题用会话名：会话列表里那一行的 title；空白会话 / 未命名会话取到空串就返回 undefined。
            sessionTitle: (sessionId: string) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入服务无静态类型
              const row = (ctx as any).get?.('sessions')?.list?.getSnapshot?.()?.byId?.[sessionId];
              const name = typeof row?.title === 'string' ? row.title.trim() : '';
              return name || undefined;
            },
          }),
        'dsh-pet: notifications',
      );

      // 设置页导航「桌宠配置」的图标：DSH 只给白名单分区配图标，只能在 DOM 层补。
      // 依据与降级策略见 nav-icon.ts。
      ctx.effect(() => {
        const renderIcon = renderIconSvg;
        const icon = primitives?.IconSlidersTwoOutlineMedium;
        if (renderIcon === undefined || icon === undefined) {
          console.warn('[dsh-pet] 设置页导航图标不可用（那一行仍是齿轮）');
          return () => {};
        }
        return installSectionNavIcon({ label: () => t('nav'), renderSvg: () => renderIcon(icon) });
      }, 'dsh-pet: settings nav icon');

      // 宠物 overlay：容器渲染多个 PetCard。
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'pet', order: 1000 }, () => h(PetMulti, {}));
      });

      // 设置页「桌宠配置」：大小、位置，保存即时生效。
      const PetConfigSection = makePetConfigSection({ h, useState, useEffect, useRef, useCallback, t });
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 'pet-config', order: 30, label: () => t('nav'), inject: () => ({ t }) },
          PetConfigSection,
        );
      });
    }

    module.exports = { apply, inject, name };
    return module.exports;
  };
}
