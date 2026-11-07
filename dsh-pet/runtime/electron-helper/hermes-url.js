/** Hermes 外链白名单，renderer 与主进程共同校验。 */
/** DSH 桌面版自注册协议：拉起或聚焦主窗口。DSH 0.2.2 不解析会话参数（Windows 上任何 dsh:// 都只聚焦），故只放行这一个精确值。 */
const DSH_OPEN_URL = 'dsh://open';

/** 只允许无凭据的网页地址、单段编码的 Hermes 会话地址，或精确的 `dsh://open`。 */
function safeHermesUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return;
  if (value === DSH_OPEN_URL) return value;
  try {
    const url = new URL(value);
    if (url.username || url.password) return;
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    if (!/^hermes:\/\/open\/(?:[A-Za-z0-9_~.!'()*-]|%[0-9A-Fa-f]{2})+$/.test(value)) return;
    const id = decodeURIComponent(value.slice('hermes://open/'.length));
    if (!id || id === '.' || id === '..' || /[\u0000-\u001f\u007f]/.test(id)) return;
    return value;
  } catch {
    return;
  }
}

module.exports = { safeHermesUrl };
