/**
 * 独立应用的启动分流：正常启动，或被 Helper 拉起的 DPI 探测子进程。
 *
 * 打包后 `process.execPath` 就是 dsh-pet.exe，Helper 的 probePrimaryScale 会重新拉起应用本身。
 * 探测子进程若也去抢单实例锁，会和正同步阻塞在 execFileSync 里的主实例互等到超时，
 * 主屏缩放拿不到，强制缩放与逐屏尺寸适配都会失效。所以探测子进程必须跳过锁和 boot，只跑 Helper。
 * @module dsh-pet/src/app/launch-mode
 */

/** 应用入口的两种运行方式。 */
export type LaunchMode = 'dpi-probe' | 'app';

/** 按 Helper 注入的环境变量判定本进程的运行方式。 */
export function launchMode(env: NodeJS.ProcessEnv): LaunchMode {
  return env.DSH_PET_DPI_PROBE === '1' ? 'dpi-probe' : 'app';
}
