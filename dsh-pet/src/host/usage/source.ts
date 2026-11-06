/**
 * 用量数据源的缓存外壳：每个来源各自节流、各自记错，读取从不阻塞调用方。
 *
 * 只管「什么时候该再读一次」和「上次读到什么」；读取本身由各来源模块提供。
 * 始终成立：同一时刻每个来源最多一个在途读取；失败保留上次成功的数据并标记 stale。
 * @module dsh-pet/src/host/usage/source
 */

/** 一个来源对外的快照。 */
export interface SourceSnapshot<T> {
  /** 上次成功读到的数据；从未成功时为 null。 */
  readonly data: T | null;
  /** 最近一次读取的错误文案；最近一次成功时为 null。 */
  readonly error: string | null;
  /** 数据是否已过期（最近一次读取失败但仍保留旧数据）。 */
  readonly stale: boolean;
  /** 是否有读取正在进行。 */
  readonly refreshing: boolean;
  /** 最近一次成功的时间（ms）。 */
  readonly okAt: number | null;
}

/** 来源节流参数。 */
export interface SourceTiming {
  /** 成功后多久再读（ms）。 */
  readonly refreshMs: number;
  /** 失败后多久重试（ms）。 */
  readonly retryMs: number;
  /** 手动刷新的最短间隔（ms），防止连点把外部接口打爆。 */
  readonly minForceMs: number;
}

/** 带缓存的来源。 */
export interface Source<T> {
  /** 按节流规则决定是否发起读取；返回本次（或在途）读取的完成信号。 */
  ensure(force?: boolean): Promise<void>;
  /** 当前快照。 */
  peek(): SourceSnapshot<T>;
}

/**
 * 包一层缓存与节流。
 *
 * @param read - 真正的读取函数；抛错即视为失败，错误文案直接展示给用户（不得带凭据）。
 * @param timing - 节流参数。
 * @param now - 时钟（测试注入）。
 * @returns 带缓存的来源。
 */
export function createSource<T>(read: () => Promise<T>, timing: SourceTiming, now: () => number = Date.now): Source<T> {
  let data: T | null = null;
  let error: string | null = null;
  let okAt: number | null = null;
  let attemptAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  const ensure = (force = false): Promise<void> => {
    if (inFlight) return inFlight;
    const since = now() - attemptAt;
    const due = force ? since >= timing.minForceMs : since >= (error ? timing.retryMs : timing.refreshMs);
    if (!due) return Promise.resolve();
    attemptAt = now();
    inFlight = read()
      .then((value) => {
        data = value;
        error = null;
        okAt = now();
      })
      .catch((e: unknown) => {
        error = e instanceof Error && e.message ? e.message : '读取失败';
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    ensure,
    peek: () => ({ data, error, stale: error !== null && data !== null, refreshing: inFlight !== null, okAt }),
  };
}

/** 数字容错：字符串数字也接受，非法值记 0。 */
export const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
};

/** 宽松对象：外部接口的 JSON 一律先当它读，再逐字段校验。 */
export type Loose = Record<string, unknown>;

/** 取对象（非对象返回空对象）。 */
export const obj = (value: unknown): Loose =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {};

/** 取数组（非数组返回空数组）。 */
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
