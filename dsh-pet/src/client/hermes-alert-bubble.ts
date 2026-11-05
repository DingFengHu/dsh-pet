/** 浏览器气泡外壳，提醒内容与按钮复用桌面端的 DOM 面板。 */
import { createHermesAlertPanel, type HermesAlertView } from '../shared/hermes-alert-panel.ts';
import type { TodoBubbleRuntime } from './todo-bubble.ts';

/** 建立仅负责挂载的气泡，不发送 DSH focus-session。 */
export function makeHermesAlertBubble({ h, useEffect, useRef }: TodoBubbleRuntime) {
  return function HermesAlertBubble(view: HermesAlertView) {
    const host = useRef<HTMLDivElement | null>(null);
    const panel = useRef<ReturnType<typeof createHermesAlertPanel> | null>(null);
    useEffect(() => {
      const mounted = createHermesAlertPanel({
        open: (url) => {
          window.open(url, '_blank', 'noopener,noreferrer');
        },
      });
      panel.current = mounted;
      host.current?.appendChild(mounted.el);
      return () => {
        mounted.dispose();
        panel.current = null;
      };
    }, []);
    useEffect(() => {
      panel.current?.update(view);
    }, [view]);
    return h('div', { ref: host, className: 'dsh-pet-bubble is-on is-clickable' });
  };
}
