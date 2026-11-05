/**
 * dsh-cordis-probe 的宿主半侧：一个开关（语音合成），默认关闭，打开后注册一个 mock 实现，
 * 用来验证 `petApi7340.voice.register` 这条第三方入口。
 *
 * @module dsh-cordis-probe
 */
import { createMockVoiceProvider } from './mock-voice.js';
import { VOICE_ROUTE, createToggleHandler } from './toggle-route.js';

/** Cordis 插件名（诊断与日志里显示）。 */
export const name = 'cordis-probe';

/**
 * 依赖声明：Cordis 会等这些服务就绪后再执行 `apply`。
 * 缺少 `inject` 时 `apply` 会在服务提供之前跑，`ctx.get` 全部拿不到（已实测）。
 */
export const inject = ['petApi7340'];

/**
 * 注册 mock 语音开关。
 *
 * @param ctx - 宿主 Cordis 上下文；服务由 inject 保证在场。
 */
export function apply(ctx) {
  // 语音开关：默认关闭，打开后 register 一个 mock 实现。
  // 注册在宿主、按钮在页面，两半没有直接通道，所以额外开一个最小路由给页面点。
  const api = ctx.get('petApi7340', false);
  /** 待挂载的开关路由：路径 → 读写控制。 */
  const toggles = [];

  const voice = api?.voice;
  if (voice) {
    /** 已打开的注销函数；null = 当前关闭。 */
    let disposeVoice = null;
    /** 打开/关闭 mock 语音；幂等，重复调用不会叠加注册。 */
    const setVoiceOn = (on) => {
      if (on && !disposeVoice) disposeVoice = voice.register(createMockVoiceProvider());
      if (!on && disposeVoice) {
        disposeVoice();
        disposeVoice = null;
      }
      return on;
    };
    // 插件卸载时确保注销：否则 mock 语音会赖在宿主里，之后的 /voice/speak 一直走提示音
    ctx.effect(() => () => {
      setVoiceOn(false);
    });
    toggles.push([VOICE_ROUTE, { isOn: () => disposeVoice !== null, setOn: setVoiceOn }]);
  }

  const webServer = ctx.get('webServer', false);
  if (!webServer) return;
  for (const [path, control] of toggles) {
    try {
      ctx.effect(() => webServer.register({ kind: 'prefix', path, handler: createToggleHandler(control) }));
    } catch (e) {
      warn('开关路由 ' + path, e);
    }
  }
}

/** 注册失败不该让整个探针起不来：记一行日志即可。 */
function warn(what, e) {
  console.warn('[cordis-probe] 注册失败 ' + what + '：' + (e instanceof Error ? e.message : String(e)));
}
