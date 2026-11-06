/**
 * 语音播报总开关（POST /voice-enabled）：桌面端右键「朗读」一键开关，只改用户层的 voiceEnabled。
 *
 * 与设置页「语音播报」是同一个配置键：推送气泡、待办朗读都受它控制。写入语义与 PUT /config 一致
 * （白名单重建 + 磁盘原值透传），但不重启桌面 Helper：发起的渲染端已就地生效，重启会让宠物闪一下。
 * @module dsh-pet/src/host/routes/config/voice
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { readUserConfig, saveUserConfig, userConfigUnparsable } from '../../config.ts';
import { type RouteResult } from '../../http.ts';
import type { PetRouteDeps, RouteInput } from '../types.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from '../result.ts';

/**
 * 写 voiceEnabled 并返回新值。
 *
 * 失败一律 200 + 失败实体：enabled 不是布尔 / 用户配置缺失或损坏 / 写盘失败都是业务结论。
 */
export async function setVoiceEnabledRoute(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult> {
  if (input.method !== 'POST') return methodNotAllowed();
  let payload: { enabled?: unknown };
  try {
    payload = JSON.parse(input.body ?? '') as { enabled?: unknown };
  } catch {
    return invalidJson();
  }
  if (typeof payload.enabled !== 'boolean') return failResult('bad-request', 'enabled 必须是布尔值');
  const { configPaths, userConfigPath, userRoot } = deps;
  // 损坏的用户层不能白名单重建（会静默丢掉文件里剩下的内容），让用户去设置页确认。
  if (userConfigUnparsable(configPaths)) {
    return failResult('user-config-unparsable', '用户配置无法解析，请到设置页处理后再切换', {
      userFile: userConfigPath,
    });
  }
  const existing = readUserConfig(configPaths);
  if (!existing || !Array.isArray(existing.pets)) {
    return failResult('bad-request', '还没有用户配置，请先在设置页保存一次');
  }
  const clean = saveUserConfig({ ...existing, voiceEnabled: payload.enabled }, existing);
  if (!clean) return failResult('bad-request', '用户配置非法');
  try {
    await mkdir(userRoot, { recursive: true });
    await writeFile(userConfigPath, JSON.stringify(clean, null, 2), 'utf8');
  } catch (e) {
    return failResult('generate-error', e instanceof Error ? e.message : String(e));
  }
  // 配置变更信号：浏览器端设置页据此重拉 /config，开关状态不会显示成旧值。
  deps.state.writeSection('config', {});
  return okResult({ ok: true, voiceEnabled: payload.enabled });
}
