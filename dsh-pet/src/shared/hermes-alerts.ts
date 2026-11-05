/** Hermes 提醒的快照边界与安全链接判定，两端共用，不参与 DSH 会话切换。 */
import type { StateLeaf } from './state.ts';
import { safeHermesUrl } from '../../runtime/electron-helper/hermes-url.js';

/** 共用 renderer 与主进程的外链白名单。 */
export { safeHermesUrl };

/** 一条本地提醒，确认不代表批准或拒绝任务。 */
export interface HermesAlert {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly url?: string;
}

/** 宿主提供的当前快照，stale 时保留提醒但禁止确认。 */
export interface HermesAlerts {
  readonly petId: string;
  readonly alerts: readonly HermesAlert[];
  readonly stale: boolean;
  readonly error?: string;
}

/** 收窄完整快照，非法条目不进入视图，非法链接只禁用查看。 */
export function readHermesAlerts(leaf: StateLeaf | undefined): HermesAlerts | null {
  const raw = leaf?.data;
  if (!raw || typeof raw !== 'object') return null;
  const snapshot = raw as Record<string, unknown>;
  if (
    typeof snapshot.petId !== 'string' ||
    !snapshot.petId ||
    snapshot.petId.length > 512 ||
    !Array.isArray(snapshot.alerts) ||
    snapshot.alerts.length > 1000 ||
    typeof snapshot.stale !== 'boolean'
  )
    return null;
  const alerts: HermesAlert[] = [];
  const ids = new Set<string>();
  for (const rawAlert of snapshot.alerts) {
    if (!rawAlert || typeof rawAlert !== 'object') continue;
    const alert = rawAlert as Record<string, unknown>;
    if (
      typeof alert.id !== 'string' ||
      !alert.id ||
      alert.id.length > 512 ||
      ids.has(alert.id) ||
      typeof alert.title !== 'string' ||
      !alert.title ||
      alert.title.length > 2048 ||
      typeof alert.message !== 'string' ||
      alert.message.length > 16384
    )
      continue;
    ids.add(alert.id);
    alerts.push({ id: alert.id, title: alert.title, message: alert.message, url: safeHermesUrl(alert.url) });
  }
  return {
    petId: snapshot.petId,
    alerts,
    stale: snapshot.stale,
    ...(typeof snapshot.error === 'string' ? { error: snapshot.error.slice(0, 512) } : {}),
  };
}

/** 只为目标宠物选第一条，锁定时不占槽，不生成任何本地提醒。 */
export function selectHermesAlert(
  snapshot: HermesAlerts | null | undefined,
  petId: string,
  locked: boolean,
): HermesAlert | null {
  return !locked && snapshot?.petId === petId ? (snapshot.alerts[0] ?? null) : null;
}
