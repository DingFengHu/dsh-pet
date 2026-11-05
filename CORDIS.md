# dsh-pet 对外 Cordis 服务

同名服务 `petApi7340` 在两半各有一份，分属不同容器（宿主进程 / DSH web 页面），互不可见。

本文是**完整契约**（参数、返回字段、边界与示例）；只要成员的一句话预览，见 [`CORDIS-API.md`](CORDIS-API.md)。

```js
ctx.get('petApi7340')
```

拿不到对应分组 = 你在另一半，或 dsh-pet 未启用 / 版本过旧。

## 客户端半侧（DSH web 页面内，只在该页面内有效）

入口返回 `{ getState, menuEvents, pose, progress }`。

### pose

**参数**

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `petId` | string | 宠物 id |

**返回**：`{ x, y, facing } \| null`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `x` | number | 中心点横坐标，视口归一化 0–1 |
| `y` | number | 中心点纵坐标，视口归一化 0–1 |
| `facing` | `left` \| `right` | 朝向 |

`null`：这一页没有这只宠物。

```js
ctx.get('petApi7340').pose('main');
// { x: 0.8467, y: 0.2438, facing: 'left' }
```

### progress

**参数**

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `petId` | string | 宠物 id |

**返回**：`{ playbackId, anim, currentTime, duration, paused, buffering } \| null`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `playbackId` | `string \| null` | 本次播放编号；自播动画（随机走位 / 点击…）为 `null` |
| `anim` | string | 当前动画：池内动作给名字（`walk`），`url` 点播给该地址 |
| `currentTime` | number | 当前播放位置，秒 |
| `duration` | number | 视频总长，秒；元数据未就绪时为 `0` |
| `paused` | boolean | 是否暂停；播完也是 `true` |
| `buffering` | boolean | 是否在缓冲（`readyState < 3` 或正在 seek） |

`null`：这一页没有这只宠物。

```js
ctx.get('petApi7340').progress('main');
// { playbackId: 'pb_1755...', anim: 'walk', currentTime: 3.42, duration: 10.09, paused: false, buffering: false }
```

### getState

**参数**：无。

**返回**：`PollState | null` —— 本页最近一拍的轮询状态，与 `GET /state` 的响应体同形；`/state` 首拍还没回来时为 `null`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `counter` | number | 整份状态的版本号；任意叶子被写入都递增 |
| `sections` | `Record<SectionName, StateLeaf>` | 全局段：`workStatus` / `notify` / `config` / `menu` |
| `pets` | `Record<petId, Record<PetLeafName, StateLeaf>>` | 每只宠物的叶子：`say` / `anim` / `position` / `throw` / `lock` |

每个叶子都是 `{ counter, data }`：`counter` 变了就说明这一项变过，`data` 是它当前的值（`null` = 还没写过）。

使用要点：

- 返回的是**快照引用**，只读；改它会影响宠物页自己的渲染。
- 每拍整包替换，所以拿在手里的旧对象不会被后续写入改掉。
- 首拍之前是 `null`；页面级数据，别的标签页读不到。
- 零请求：读的是内存，可以在渲染或 `requestAnimationFrame` 里按需读。

```js
const s = ctx.get('petApi7340').getState();
if (s) {
  console.log('版本', s.counter, '这只宠物最近说：', s.pets.main?.say?.data);
}
```

### menuEvents

**参数**

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `owner` | string | 注册菜单项时用的 owner |

**返回**：与 `GET /menu/events` 的响应体同形。

| 形态 | 内容 |
| --- | --- |
| 成功 | `{ ok: true, events: Record<label, petId \| null> }` |
| 未知 owner | `{ ok: false, reason: 'unknown-owner' }` |

`events` 覆盖本页可见的全部菜单项：值是 `petId` 表示这一项被点过（点在哪只宠物上），`null` 表示没被点过。

**读取即消费**：读走后所有标记清回 `null`，下一次读到的是之后的新点击；连续点同一条只留最后一次。这个 owner 在本页没有可见项（没注册、已清除，或只注册给 `desktop`）时回 `unknown-owner`。

```js
const res = ctx.get('petApi7340').menuEvents('my-plugin');
if (res.ok) {
  for (const [label, petId] of Object.entries(res.events)) {
    if (petId !== null) console.log(label, '被点了，点在', petId);
  }
}
```

## 宿主半侧（宿主插件进程内）

入口返回 `{ voice }`。

### voice.register

第三方插件注册自己的语音合成实现。注册后 `POST /voice/speak` 改走它；没注册时走内置实现。

**参数**

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 唯一标识；参与缓存键，换实现不会命中旧音频。不能与内置实现同名（`edge`） |
| `name` | string | 展示名，只用于排障 |
| `synthesize` | function | 入参 `{ text, rate }`，返回 mp3 字节（`Uint8Array`） |

**返回**：`() => void`，注销函数。配合 `ctx.effect` 使用，插件卸载时自动注销。

**抛错**：定义不是对象、`id` 为空、`id` 与内置实现同名、`synthesize` 不是函数。

**行为**

- 同一时刻只有一个实现生效，**后注册的覆盖先注册的**；注销只清「仍是自己那份」，迟到的注销不会顶掉后来者。
- 注册后 `POST /voice/speak` 的 `voice` 参数不生效（音色由实现自己决定），但校验口径不变：非法值仍按 `bad-request` 拒绝。
- 不接收音色与配置：`voiceEnabled` 只控制端上要不要播，与本实现无关。
- 失败必须 `throw`：宿主归一成 `generate-error` 并记日志；返回空字节同样按失败处理。
- 单次合成上限 15 秒，超时按失败处理。
- **不回落**：注册了就不会退到内置实现——第三方坏了就是没声音，不会静默改用 edge。

```js
export const inject = ['petApi7340'];

export function apply(ctx) {
  ctx.effect(() =>
    ctx.get('petApi7340').voice.register({
      id: 'my-tts',
      name: '我的语音',
      async synthesize({ text, rate }) {
        const res = await fetch('http://127.0.0.1:9000/speak', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, rate }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return new Uint8Array(await res.arrayBuffer());
      },
    }),
  );
}
```

### voice.list

**参数**：无。

**返回**：`{ builtin, external }`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `builtin` | string[] | 内置实现 id（目前只有 `edge`） |
| `external` | string[] | 当前生效的第三方 id；没注册则为空数组 |

```js
ctx.get('petApi7340').voice.list();
// { builtin: ['edge'], external: ['my-tts'] }
```
