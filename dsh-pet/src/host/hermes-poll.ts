/**
 * 可选 Hermes 只读采集进程，配置来自插件私有 JSONC，不启动 Hermes owner。
 * 同一轮结束后才排下一轮，dispose 先停定时器再结束子进程。
 * stdout 有界且不转发 stderr，固定脚本与参数数组不经过 shell。
 * @module dsh-pet/host/hermes-poll
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { readJsonc } from './config/jsonc.ts';
import { PACKAGE_ROOT } from './paths.ts';
import { HERMES_STATE_FILE, type HermesAlerts } from './hermes-alerts.ts';

/** 仅接收本地非敏感路径，未知项拒绝。 */
export const hermesConfigSchema = z
  .object({
    python: z.string().min(1).max(4096).refine(isAbsolute),
    hermesRoot: z.string().min(1).max(4096).refine(isAbsolute),
    home: z.string().min(1).max(4096).refine(isAbsolute).optional(),
  })
  .strict();
/** 本地配置文件名，不经公共 config API 暴露路径。 */
export const HERMES_CONFIG_FILE = 'hermes-alerts.jsonc';
/** 固定采集上限，低于轮询器 50s 子进程硬超时。 */
export const HERMES_PROCESS_OPTIONS = {
  shell: false,
  timeout: 50_000,
  maxBuffer: 2 * 1024 * 1024,
  windowsHide: true,
} as const;

/**
 * 独立 exe 里包根落在 `resources/app.asar`，外部 Python 读不到 asar 内文件；
 * electron-builder 的 asarUnpack 把脚本放在同级 `app.asar.unpacked`，这里只换完整路径段。
 */
export function unpackedAsarPath(path: string): string {
  return path.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked');
}

/** 构造只读 helper 的固定 argv，所有用户路径都保持独立参数。 */
export function hermesArgs(config: z.infer<typeof hermesConfigSchema>): string[] {
  return [
    unpackedAsarPath(join(PACKAGE_ROOT, 'scripts', 'hermes-notification-snapshot.py')),
    '--hermes-root',
    config.hermesRoot,
    ...(config.home ? ['--home', config.home] : []),
  ];
}

/** 启动单飞采集，返回卸载清理函数。 */
export function startHermesPolling(options: {
  userRoot: string;
  alerts: HermesAlerts;
  execute?: typeof execFile;
}): () => void {
  let stopped = false;
  let initialized = false;
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(poll, 15_000);
    timer.unref?.();
  };
  const poll = (): void => {
    if (stopped) return;
    const path = join(options.userRoot, HERMES_CONFIG_FILE);
    try {
      const configured = existsSync(path);
      const hasState = existsSync(join(options.userRoot, HERMES_STATE_FILE));
      if (!initialized && (configured || hasState)) {
        initialized = true;
        void options.alerts.initialize().then(poll);
        return;
      }
      if (!configured) {
        if (hasState) options.alerts.offline('hermes-not-configured');
        schedule();
        return;
      }
      if (statSync(path).size > 16 * 1024) throw new Error('invalid-config');
      const config = hermesConfigSchema.parse(readJsonc(path));
      child = (options.execute ?? execFile)(
        config.python,
        hermesArgs(config),
        HERMES_PROCESS_OPTIONS,
        (cause, stdout) => {
          child = undefined;
          if (stopped) return;
          const complete = async (): Promise<void> => {
            if (cause) options.alerts.offline();
            else {
              try {
                await options.alerts.accept(JSON.parse(stdout));
              } catch {
                options.alerts.offline('snapshot-invalid');
              }
            }
          };
          void complete().finally(schedule);
        },
      );
    } catch {
      options.alerts.offline('hermes-config-invalid');
      schedule();
    }
  };
  poll();
  return () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    child?.kill();
    options.alerts.stop();
  };
}
