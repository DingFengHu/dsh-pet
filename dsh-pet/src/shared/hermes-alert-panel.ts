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

/** 标题已带来源（Hermes 或虎妞）时不再加前缀，避免出现「Hermes · Hermes 需要你确认」。 */
export function hermesTitle(title: string): string {
  return /^(hermes(?![a-z])|虎妞)/i.test(title.trim()) ? title : `Hermes · ${title}`;
}

/** 女仆风提醒气泡：奶油底、蓝色蕾丝虚线边、胶囊按钮，配大肥鱼的蓝白女仆装。
 *  字体不在这里指定，一律继承气泡的 --dsh-pet-font-family（默认随包软糖体），跟随用户的字体设置。
 *  软糖体只有一个字重，强行加粗会被浏览器假粗体糊成一团，所以层级只靠字号和颜色区分。
 *  网页 .dsh-pet-bubble 与桌面 .pet-bubble 两端基础类不同，并列写；用 :has 识别装着本面板的气泡，
 *  不需要两端各自切换气泡类名。尺寸全部锚气泡字号 --f，随宠物大小与字号设置等比缩放。 */
export const HERMES_ALERT_CSS = [
  '.dsh-pet-bubble:has(>.dsh-pet-hermes),.pet-bubble:has(>.dsh-pet-hermes){',
  'background:#fffaf2;color:#24305e;border:calc(var(--f)*0.1) dashed #b9c2e4;',
  'padding:calc(var(--f)*0.55) calc(var(--f)*0.7);border-radius:calc(var(--f)*0.95);cursor:default}',
  '.dsh-pet-bubble:has(>.dsh-pet-hermes)::after,.pet-bubble:has(>.dsh-pet-hermes)::after{',
  'border-top-color:#fffaf2;bottom:calc(var(--f)*-0.42)}',
  '.dsh-pet-hermes{max-height:16em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:auto;',
  'display:flex;flex-direction:column;gap:calc(var(--f)*0.2);line-height:1.45}',
  '.dsh-pet-hermes-title{font-weight:400;font-size:calc(var(--f)*0.88);color:#24305e}',
  '.dsh-pet-hermes-msg{font-size:calc(var(--f)*0.7);color:#5b6488;white-space:pre-wrap;overflow-wrap:anywhere;max-height:calc(var(--f)*9);overflow-y:auto}',
  '.dsh-pet-hermes-status{font-size:calc(var(--f)*0.62);color:#b5523b}',
  // 状态行是 aria-live 区，不能 display:none；空的时候只抵消 flex 间距。
  '.dsh-pet-hermes-status:empty{margin-top:calc(var(--f)*-0.2)}',
  '.dsh-pet-hermes-actions{display:flex;flex-wrap:wrap;gap:calc(var(--f)*0.35);margin-top:calc(var(--f)*0.3)}',
  '.dsh-pet-hermes-btn{font:inherit;font-weight:400;font-size:calc(var(--f)*0.68);line-height:1.3;cursor:pointer;',
  'border:none;border-radius:999px;padding:calc(var(--f)*0.22) calc(var(--f)*0.7);',
  'background:#e9ecf7;color:#2c3f86;transition:background .15s ease,transform .1s ease}',
  '.dsh-pet-hermes-btn:hover{background:#dce1f3}',
  '.dsh-pet-hermes-btn.is-primary{background:#2c3f86;color:#fffaf2}',
  '.dsh-pet-hermes-btn.is-primary:hover{background:#3a51a4}',
  '.dsh-pet-hermes-btn:active{transform:scale(.96)}',
  '.dsh-pet-hermes-btn:focus-visible{outline:calc(var(--f)*0.08) solid #6d86d8;outline-offset:calc(var(--f)*0.06)}',
  '.dsh-pet-hermes-btn:disabled{opacity:.45;cursor:default;transform:none}',
].join('');

/** 每页只注入一次提醒样式。 */
function injectHermesAlertCss(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css="dsh-pet/hermes-alert"]') !== null) return;
  const tag = document.createElement('style');
  tag.setAttribute('data-plugin-css', 'dsh-pet/hermes-alert');
  tag.textContent = HERMES_ALERT_CSS;
  document.head.appendChild(tag);
}

/** 快照决定内容，调用方决定可见性及打开链接的运行时能力。 */
export interface HermesAlertView {
  readonly alert: HermesAlert;
  readonly stale: boolean;
  readonly count: number;
}

/** 建立可更新的提醒内容，卸载后迟到的响应不写 DOM。 */
export function createHermesAlertPanel(options: { open: (url: string) => void; baseUrl?: string }) {
  injectHermesAlertCss();
  const el = document.createElement('section');
  el.className = 'dsh-pet-hermes';
  el.setAttribute('aria-label', 'Hermes 提醒');
  const title = document.createElement('strong');
  title.className = 'dsh-pet-hermes-title';
  const message = document.createElement('div');
  message.className = 'dsh-pet-hermes-msg';
  const status = document.createElement('div');
  status.className = 'dsh-pet-hermes-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'dsh-pet-hermes-btn is-primary';
  open.textContent = '查看对话';
  const ack = document.createElement('button');
  ack.type = 'button';
  ack.className = 'dsh-pet-hermes-btn';
  ack.textContent = '知道了';
  const actions = document.createElement('div');
  actions.className = 'dsh-pet-hermes-actions';
  actions.append(open, ack);
  el.append(title, message, status, actions);
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
    title.textContent = `${hermesTitle(view.alert.title)}${view.count > 1 ? ` (${view.count})` : ''}`;
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
