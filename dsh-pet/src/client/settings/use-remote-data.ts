/**
 * 页面打开时一次性拉取的宿主数据：落盘位置清单（`/config/meta`）。
 * 失败不阻塞表单，只影响两张路径卡；顺带把「组件已卸载」的判断留在 hook 里，避免请求回来往死掉的组件上写状态。
 * @module dsh-pet/src/client/settings/use-remote-data
 */
import { type ConfigMeta, loadMeta } from './config/index.ts';
import type { SettingsRuntime } from './runtime.ts';

/** 一次性拉取的结果。 */
export interface RemoteData {
  /** 路径与存储清单；`null` = 还没拿到或读取失败。 */
  paths: ConfigMeta | null;
}

/**
 * 拉取元信息。
 *
 * @param rt - 只用到 `useState` 与 `useEffect`。
 * @returns 只读结果。
 */
export function useRemoteData(rt: Pick<SettingsRuntime, 'useState' | 'useEffect'>): RemoteData {
  const { useState, useEffect } = rt;
  const [paths, setPaths] = useState<ConfigMeta | null>(null);

  useEffect(() => {
    let alive = true;
    void loadMeta().then((meta) => {
      if (alive) setPaths(meta);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { paths };
}
