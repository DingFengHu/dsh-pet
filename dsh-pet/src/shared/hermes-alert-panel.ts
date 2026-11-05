/** Hermes 提醒的共用 DOM 内容，持有单次确认请求，不隐藏条目、不改宿主快照。 */
import { ROUTE_PATH } from './constants.ts';
import { postAction } from './state.ts';
import { safeHermesUrl, type HermesAlert } from './hermes-alerts.ts';

/** 在途请求只活到 10 秒超时，切换待办或重挂面板不会重复确认。 */
const pendingAcks = new Map<string, Promise<boolean>>();

function acknowledge(baseUrl: string, id: string): Promise<boolean> {
  const key = JSON.stringify([baseUrl, id]);
  const current = pendingAcks.get(key);
  if (current) return current;
  const request = postAction(baseUrl + '/hermes/ack', { id }, AbortSignal.timeout(10000)).finally(() => {
    pendingAcks.delete(key);
  });
  pendingAcks.set(key, request);
  return request;
}

/** 快照决定内容，调用方决定可见性及打开链接的运行时能力。 */
export interface HermesAlertView {
  readonly alert: HermesAlert;
  readonly stale: boolean;
  readonly count: number;
}

/** 建立可更新的提醒内容，卸载后迟到的响应不写 DOM。 */
export function createHermesAlertPanel(options: { open: (url: string) => void; baseUrl?: string }) {
  const el = document.createElement('section');
  el.setAttribute('aria-label', 'Hermes 提醒');
  el.style.cssText = 'max-height:16em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:auto';
  const title = document.createElement('strong');
  const message = document.createElement('div');
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = '查看对话';
  const ack = document.createElement('button');
  ack.type = 'button';
  ack.textContent = '知道了';
  for (const button of [open, ack]) button.style.cssText = 'font:inherit;cursor:pointer';
  el.append(title, message, status, open, ack);
  let view: HermesAlertView | null = null;
  let pending = false;
  let acknowledgedId: string | null = null;
  let error = '';
  let disposed = false;
  const controller = new AbortController();
  // 只隔离事件，不 preventDefault，保留按钮的键盘激活及焦点行为。
  for (const name of ['pointerdown', 'pointerup', 'click', 'contextmenu']) {
    el.addEventListener(name, (event) => event.stopPropagation(), { signal: controller.signal });
  }
  function paint(): void {
    if (!view || disposed) return;
    title.textContent = `Hermes · ${view.alert.title}${view.count > 1 ? ` (${view.count})` : ''}`;
    message.textContent = view.alert.message;
    status.textContent = [
      view.stale ? '提醒数据可能已过时，仍可点击“知道了”在本地忽略' : '',
      error || (acknowledgedId === view.alert.id ? '已确认，等待同步' : ''),
    ]
      .filter(Boolean)
      .join('\n');
    open.disabled = !safeHermesUrl(view.alert.url);
    ack.disabled = pending || acknowledgedId === view.alert.id;
    ack.textContent = pending ? '确认中…' : '知道了';
  }
  open.addEventListener(
    'click',
    () => {
      const url = safeHermesUrl(view?.alert.url);
      if (!url) return;
      try {
        options.open(url);
      } catch {
        error = '无法打开对话';
        paint();
      }
    },
    { signal: controller.signal },
  );
  ack.addEventListener(
    'click',
    () => {
      if (!view || pending || acknowledgedId === view.alert.id) return;
      const id = view.alert.id;
      pending = true;
      error = '';
      paint();
      void acknowledge(options.baseUrl ?? ROUTE_PATH, id).then((ok) => {
        if (disposed) return;
        pending = false;
        if (ok) acknowledgedId = id;
        if (view?.alert.id === id) error = ok ? '' : '确认失败，请重试';
        paint();
      });
    },
    { signal: controller.signal },
  );
  return {
    el,
    update(next: HermesAlertView): void {
      if (view?.alert.id !== next.alert.id) error = '';
      view = next;
      paint();
    },
    dispose(): void {
      disposed = true;
      controller.abort();
      el.remove();
    },
  };
}
