/**
 * 配置写入：白名单重建用户层，或把内置默认整份同步给用户。
 *
 * 不负责读取与合并（归 ./read），也不重启桌面 Helper（由调用方决定）。
 * 必须始终成立：只写白名单字段，用户手改的非白名单字段必须原样带回。
 * @module dsh-pet/src/host/config/save
 */
import { defaultLog } from '../log-file.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CORNER_SET, isValidPetId, PET_DISPLAY_SET } from './constants.ts';
import { isValidSizePercent } from '../../shared/pet-size.ts';
import type { ConfigPaths } from './constants.ts';
import { fontValid, physicsValid, topFieldValid } from './validate.ts';

/**
 * 保存用户层（PUT /config）：接受 pets + 全局开关 + physics / font / 动作频率。
 * 非白名单顶层字段（animations、memes、已下线功能的旧字段等）从 existing 原样透传保留——
 * 用户手动编辑的精调配置不会被设置页保存抹掉；白名单字段也只在请求体真的传了时才算白名单。
 * 非法 → 返回 null，由路由回 200 + 失败实体。与读取分离：文件宠物永不回写。
 */
export function saveUserConfig(
  raw: unknown,
  existing?: Record<string, unknown>,
): { pets: unknown[]; [key: string]: unknown } | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const arr = Array.isArray(o.pets) ? o.pets : null;
  if (!arr || !arr.length) return null;
  const out: unknown[] = [];
  const seenIds = new Set<string>();
  for (const p of arr) {
    if (!p || typeof p !== 'object') return null;
    const pp = p as Record<string, unknown>;
    // 与 mergePet 的身份规则一致：先 trim，再判唯一性，最后写盘。
    const id = typeof pp.id === 'string' ? pp.id.trim() : '';
    // 有意过滤文件名非法字符（Windows 保留符 + 控制字符），防止配置值逃逸 main-config.jsonc 路径
    if (!isValidPetId(id) || seenIds.has(id)) return null;
    seenIds.add(id);
    const size = Number(pp.size);
    if (!Number.isFinite(size) || size <= 0) return null;
    // 百分比大小（可选）：与读取侧同一份判定。传了就必须是不小于 1 的数字（不设上限），否则整包 400；
    // 缺省表示不用百分比——这里不回填默认值，否则清空会变成「显式写回一个百分比」。
    const sizePercent = pp.sizePercent;
    if (sizePercent !== undefined && sizePercent !== null && !isValidSizePercent(sizePercent)) return null;
    // 显示名：可重复不校验唯一；缺失/留空/非字符串 → 按该宠物 id 处理（兼容旧配置）并告警
    let name = typeof pp.name === 'string' ? pp.name.trim() : '';
    if (!name) {
      defaultLog('warn', `dsh-pet: pet「${id}」缺少 name，已按默认 ${id}（宠物 id）处理`);
      name = id;
    }
    const workStatusEnabled = pp.workStatusEnabled;
    if (workStatusEnabled !== undefined && typeof workStatusEnabled !== 'boolean') return null;
    // 宠物固定（随机链不再抽「转向 / 移动」两档）：与 workStatusEnabled 同语义——可选，
    // 传了必须是布尔，没传则走下面的读取侧默认值（内置默认 false = 不固定）。
    const fixedEnabled = pp.fixedEnabled;
    if (fixedEnabled !== undefined && typeof fixedEnabled !== 'boolean') return null;
    const display = String(pp.display ?? '');
    if (!PET_DISPLAY_SET.has(display)) return null;
    const pos = pp.position && typeof pp.position === 'object' ? (pp.position as Record<string, unknown>) : {};
    const corner = String(pos.corner ?? '');
    if (!CORNER_SET.has(corner)) return null;
    const marginX = Number(pos.marginX);
    const marginY = Number(pos.marginY);
    if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
    const pet: Record<string, unknown> = {
      id,
      name,
      size,
      workStatusEnabled,
      fixedEnabled,
      display,
      position: { corner, marginX, marginY },
    };
    if (sizePercent !== undefined && sizePercent !== null) pet.sizePercent = sizePercent;
    out.push(pet);
  }
  const ne = o.notificationsEnabled;
  if (ne !== undefined && typeof ne !== 'boolean') return null;
  // 点击音效开关（全局布尔，与 notificationsEnabled 同语义）：传了必须是布尔，没传走透传保留
  const cse = o.clickSoundEnabled;
  if (cse !== undefined && typeof cse !== 'boolean') return null;
  const cts = o.confineToScreen;
  if (cts !== undefined && typeof cts !== 'boolean') return null;
  // 语音播报开关与音色（全局）：与上面几个布尔同语义；音色必须落在白名单内，
  // 校验直接复用读取侧的 topFieldValid，读写同一份规则。
  const ve = o.voiceEnabled;
  if (ve !== undefined && typeof ve !== 'boolean') return null;
  const vn = o.voiceName;
  if (vn !== undefined && !topFieldValid('voiceName', vn)) return null;
  // 播放音量（全局系数，0–1）：与上面同一套语义——传了必须合法，没传走透传保留。
  const vv = o.voiceVolume;
  if (vv !== undefined && !topFieldValid('voiceVolume', vv)) return null;
  // 待办提醒的语音开关：与上面两个布尔同语义——传了必须是布尔，
  // 没传走透传保留；校验直接复用读取侧的 topFieldValid，读写同一份规则。
  const vte = o.voiceTodoEnabled;
  if (vte !== undefined && !topFieldValid('voiceTodoEnabled', vte)) return null;
  // 系统托盘开关（全局，仅桌面模式）：与上面几个全局布尔同语义——传了必须是布尔，没传走透传保留。
  const te = o.trayEnabled;
  if (te !== undefined && typeof te !== 'boolean') return null;
  // physics（拖拽抛掷手感，设置页「物理」区可图形化编辑）：整段校验——physicsValid 与读取侧
  // 是同一份规则（gravity/groundFriction ≥ 0、restitution ∈ [0,1]、throwPower > 0、两个布尔）。
  // 传了就按白名单写入；没传则走下面的透传保留（用户手改的值原样不动）。
  const ph = o.physics;
  if (ph !== undefined && !physicsValid(ph)) return null;
  // animationWeights（动作频率；设置页「动作频率」卡写的就是它）：与 physics 同一套语义——
  // 传了就整段校验后进白名单，没传则走下面的透传保留。校验复用读取侧的 topFieldValid
  // （三个权重都是非负有限数），落盘只留 idle / turn / move 三个数字。
  const aw = o.animationWeights;
  if (aw !== undefined && !topFieldValid('animationWeights', aw)) return null;
  // font（字体种类 / 字号 / 是否随宠物缩放；设置页「外观与字体」区写的就是它）：与 physics
  // 同一套语义——传了就整段校验后进白名单，没传则走下面的透传保留。
  // 校验直接复用读取侧的 fontValid（family 白名单 / size 4~200 / followPet 布尔），读写同一份规则。
  const fo = o.font;
  if (fo !== undefined && !fontValid(fo)) return null;
  const cleanWeights = (v: Record<string, unknown>): { idle: number; turn: number; move: number } => ({
    idle: Number(v.idle),
    turn: Number(v.turn),
    move: Number(v.move),
  });
  // 白名单可编辑字段：pets 来自请求体，其余（全局开关 / physics / font / 动作频率）
  // 同样只在请求体真的传了时才写（未传则走下面的透传保留，不凭空造值）
  const outConfig: { pets: unknown[]; [key: string]: unknown } = { pets: out };
  if (ne !== undefined) outConfig.notificationsEnabled = ne;
  if (cse !== undefined) outConfig.clickSoundEnabled = cse;
  if (cts !== undefined) outConfig.confineToScreen = cts;
  if (ve !== undefined) outConfig.voiceEnabled = ve;
  if (vn !== undefined) outConfig.voiceName = vn;
  if (vv !== undefined) outConfig.voiceVolume = vv;
  if (vte !== undefined) outConfig.voiceTodoEnabled = vte;
  if (te !== undefined) outConfig.trayEnabled = te;
  if (ph !== undefined) outConfig.physics = ph;
  if (aw !== undefined) outConfig.animationWeights = cleanWeights(aw as Record<string, unknown>);
  if (fo !== undefined) outConfig.font = fo;
  // 透传保留：请求体未携带的顶层字段，从 existing（磁盘现有用户文件）原样带回——
  // 设置页只提交 pets(+全局开关+physics+font+动作频率)，手改的 memes/... 借此保住。
  // 白名单字段只在「请求体传了」时才算白名单（已由上方写入）；未传时走这里透传磁盘旧值——
  // 否则整包调用的调用方漏传一个字段，就会把用户既有设置悄悄抹成默认。
  const bodyOwned = new Set(['pets']);
  if (ne !== undefined) bodyOwned.add('notificationsEnabled');
  if (cse !== undefined) bodyOwned.add('clickSoundEnabled');
  if (cts !== undefined) bodyOwned.add('confineToScreen');
  if (ve !== undefined) bodyOwned.add('voiceEnabled');
  if (vn !== undefined) bodyOwned.add('voiceName');
  if (vv !== undefined) bodyOwned.add('voiceVolume');
  if (vte !== undefined) bodyOwned.add('voiceTodoEnabled');
  if (te !== undefined) bodyOwned.add('trayEnabled');
  if (ph !== undefined) bodyOwned.add('physics');
  if (aw !== undefined) bodyOwned.add('animationWeights');
  if (fo !== undefined) bodyOwned.add('font');
  if (existing && typeof existing === 'object') {
    for (const key of Object.keys(existing)) {
      if (bodyOwned.has(key)) continue; // 白名单字段由请求体决定
      // 只透传可精调的顶层字段，其余（如 memes/unknown/占位）一并保留，不丢弃用户内容
      outConfig[key] = existing[key];
    }
  }
  return outConfig;
}

/**
 * 同步用户层（POST /config，设置页「同步」）：把内置默认配置原文写入用户主配置文件。
 * 复制原文而不是删除用户层：既等价于恢复默认（合并结果 = 内置默认），又让用户拿到一份含全部
 * 注释、开箱可编辑的完整配置。读取侧统一走 stripJsonc，带注释写入照样能读。
 * 注意：文件一旦生成即成为显式覆盖层，插件升级改了内置默认后，文件里的旧值仍会继续生效。
 * 默认文件缺失 / 目录不可写 → 直接抛，由路由回 200 + 失败实体（`generate-error`），绝不静默留下半个配置文件。
 */
export function syncUserConfigFromDefault(paths: ConfigPaths): void {
  const raw = readFileSync(paths.defaultFile, 'utf8');
  mkdirSync(dirname(paths.userFile), { recursive: true });
  writeFileSync(paths.userFile, raw, 'utf8');
}

