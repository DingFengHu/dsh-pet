/**
 * 表情包池（宿主半侧）：把配置的 memes 映射（名称 → 描述）解析成可用的候选池，供 /say 广播按名配图使用。
 *
 * 不负责目录链的推导（host/index.ts 的 memeDirsFor 决定顺序与优先级），也不碰图片字节。
 * 必须始终成立：池的顺序 = 配置里写的顺序，且只有磁盘上真实存在的图才算命中——池说「能选」，
 * /pic/memes 就必须「取得到」，否则气泡图裂。文件缺失的条目静默剔除（用户删图后不必同步改
 * 配置），配置没写的图不参与（无从得知它的描述）。纯函数 + 目录参数，便于测试。
 * 契约见 CONFIG.md 与 API.md。
 * @module dsh-pet/src/host/memes
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 池中一张图：name = 配置键（= 文件名去扩展名），desc = 描述。 */
export interface MemeEntry {
  name: string;
  desc: string;
}

/**
 * 从配置的 memes 映射解析出候选池。
 * @param memes - 配置的 memes 值（未配置 / 类型非法 → 空池）。
 * @param dirs - 表情包目录链（顺序即优先级；空链 → 空池）。
 * @returns 按配置里写的顺序排列的候选池（链上都没有该图、或描述为空 → 剔除）。
 */
export function readMemePool(memes: unknown, dirs: readonly string[]): MemeEntry[] {
  if (!memes || typeof memes !== 'object' || Array.isArray(memes)) return [];
  if (dirs.length === 0) return [];
  const out: MemeEntry[] = [];
  for (const [name, desc] of Object.entries(memes as Record<string, unknown>)) {
    const text = typeof desc === 'string' ? desc.trim() : '';
    if (!name || !text) continue;
    if (!dirs.some((dir) => existsSync(join(dir, name + '.png')))) continue;
    out.push({ name, desc: text });
  }
  // 不排序：顺序 = 配置里写的顺序（JSON.parse 保留字符串键的书写顺序，纯数字键例外）。
  return out;
}

/** 按名选图校验：只在池内命中时才认，命中返回该条目。 */
export function matchMeme(pool: MemeEntry[], name: string): MemeEntry | undefined {
  const key = String(name ?? '').trim();
  return key ? pool.find((m) => m.name === key) : undefined;
}
