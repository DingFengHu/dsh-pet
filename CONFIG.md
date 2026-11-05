# 配置（大小 / 位置 / 多开）

> 返回 [README](README.md)

桌宠的大小、位置、多开均可配置，两条途径：

> 💡 **两条途径只是编辑入口不同，最终都是同一份用户配置**——配置能力远不止设置页那几个选项：设置页可改大小/位置/边距/显示位置/多开，但**手动编写配置文件可以任意自由配置**（动画池、播放权重、事件动画……），只要**格式与包内默认配置 `config.jsonc` 一致**即可，用户配置会**整体覆盖**对应字段的默认值。

## 方式一：设置页（推荐）

DSH 设置 → 「桌宠配置」：

- **大小**：宽度 px（高度自动 = 宽度 × 9/16）；另有**屏幕宽度上限**（%，默认 100，不设上限）：按人物本体占屏宽收口、px 作画框上限——100 ≈ 不限制（桌面观感与纯 px 一致），填 30–50 可让手机竖屏明显变小，填 150 人物会比屏还宽（画框仍受 px 夹住）。只在页面加载时算一次，改完窗口大小要刷新才生效
- **位置**：四角（corner）＋ 水平/垂直边距（marginX / marginY）
- **显示位置**（display）：web=仅浏览器 / desktop=仅桌面 / both=两者都显示 / none=都不显示
- **多开**：添加/删除宠物，每只宠物独立 id、大小、位置
- **种类（pet pack）**：`pet/` 目录里的角色包也会列在宠物列表里（按种类分组），同样能改名称/大小/位置/显示方式/两个开关；每组的「+」在该种类下新建实例。保存时 main 写 `main-config.jsonc`，文件宠物写回各自角色包配置（顶层动画池原样保留）；每种至少留一只，删最后一只会被拒绝
- **物理参数**：拖拽抛掷手感（重力 / 弹性 / 地面摩擦 / 总力度 / 顶部反弹 / 宠物互撞 / 碰撞震动 / 倾斜控制重力 / 摇一摇抛出）也能在设置页图形化改，不用去手改配置文件。碰撞震动（`physics.hapticEnabled`，默认开）在撞墙、落地、撞顶与宠物互撞时各震一下：Chrome / Edge 等浏览器可用，iOS 与 Via 这类 WebView 套壳浏览器不生效，系统勿扰模式会挡住振动。宠物互撞（`physics.petCollision`，默认开）按动量守恒弹开（质量 ∝ 尺寸²）。体感拆成两个开关：倾斜控制重力（`physics.tiltGravity`，默认关）用手机倾斜方向代替固定向下的重力（`gravity` 为 0 时无从取值，等同关闭）；摇一摇抛出（`physics.shakeThrow`，默认关）沿甩动方向把宠物甩出去（力度 = 基准 × `throwPower`），与重力大小无关，`gravity` 设 0 也能甩着玩。两个都只在 HTTPS 或 localhost 下有效
- 点「保存」**即时生效**（无需刷新）；「同步」把包内 `config.jsonc` 的**原文**（含注释与全部高级字段）整份写入用户配置——既回到默认，又留下一份可直接编辑的完整配置
- **语音**：待办提醒与投喂的气泡可以念出来（默认关闭），音色四选一、默认晓伊（女声 · 活泼）；音色列表来自宿主 `/voice/voices`，不在页面里硬编码

## 方式二：config.jsonc（单一来源）

插件包内 `dsh-pet/assets/config.jsonc` 的 `pets` 数组定义**默认宠物**：

```jsonc
"pets": [
  { "id": "main", "size": 462, "display": "both", "position": { "corner": "top-right", "marginX": 24, "marginY": 100 } }
]
```

- 每只宠物：`id`（标识）／`size`（宽度 px）／`sizePercent`（可选，屏幕宽度百分比 1–100；写了就按窗口宽收口、`size` 作上限）／`display`（web/desktop/both/none，必填，见上）／`position`（corner 四角之一 + marginX/marginY 边距）
- 设置页的修改保存到用户层 `$DSH_HOME/dsh-pet/main-config.jsonc`（**完整宠物列表**，覆盖包内默认）；「同步」把包内 `config.jsonc` 原文整份写入该文件（等价于回落默认，但文件保留下来、可直接编辑）

## 方式三：手动编辑配置文件（高级，任意自由配置）

用户层配置文件位于 `$DSH_HOME/dsh-pet/main-config.jsonc`。**它和包内默认配置是同一套格式**——想改什么直接照着 `assets/config.jsonc` 的结构写即可，写错的字段/缺失的字段回落默认，无需（也无法）写完整份。设置页「同步」可直接生成这份完整文件（原文复制包内 `config.jsonc`，注释齐全）：

| 字段                   | 作用                                                                                                           | 格式与默认一致即可         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `pets`                 | 宠物列表（大小/位置/多开/开关）                                                                            | 数组，每项同 `pets[]` 结构 |
| `animations`           | **动画池**：idle / turn / drag / clicks / moves / categories / events（说话 / 工作状态等事件动画） | 同 `animations` 结构       |
| `animationWeights`     | 动画链播放权重（idle / turn / move）                                                                           | 同 `animationWeights` 结构 |
| `notificationsEnabled` | 系统通知总开关（布尔）                                                                                         | 同 `notificationsEnabled`  |

> 覆盖语义：用户层给出即**整体替换**该字段（如写了 `animations` 就用你的整份动画池，替代默认），没写的字段回落包内默认。校验在插件加载时执行——格式错误会在 DSH 控制台显式报错，不会静默运行残缺配置。

## 方式四：额外宠物（pet pack）——添加新「种类」

方式一~三都只调整**默认宠物的实例**（数量/大小/位置），动画池始终是全局一份。要添加**全新种类的宠物**（独立动画池 + 自己的素材），在用户数据根下建 `pet/` 目录：

```
$DSH_HOME/dsh-pet/
├─ main-config.jsonc           ← 主宠物配置（现有，不动）
├─ main-animation/webm/*.webm  ← 主宠物素材（现有，只属于 main）
└── pet/
   ├── pig-config.json          ← 额外宠物 pig 的配置（命名词干 = 种类名，实例 id 任意）
   └── pig-animation/*.webm     ← pig 自己的动画素材（直接平铺，仿 main-animation）
```

每只额外宠物 = 一个 `-config.json` + 一个 `-animation/` 目录，同前缀配对；扫描 `pet/` 自动发现，浏览器与桌面同时生效。一个 `-config.json` 定义**一个「种类」**（动画池 + 素材目录），`pets` 数组可放该种类的**任意多只实例**（共享动画池与素材）：

```jsonc
// pet/pig-config.json —— 与 main-config.jsonc 同构的完整配置
{
  "notificationsEnabled": true,
  "pets": [
    {
      "id": "pig1", // 实例 id（可多只；不必等于文件名前缀）
      "size": 420,
      "display": "both", // web / desktop / both / none
      "position": { "corner": "top-right", "marginX": 24, "marginY": 100 },
    },
    {
      "id": "pig2",
      "size": 360,
      "display": "web",
      "position": { "corner": "top-left", "marginX": 24, "marginY": 100 },
    },
  ],
  "animations": {
    "idle": ["待机"],
    "turn": [],
    "drag": [],
    "clicks": ["打滚"],
    "moves": {
      "default": {
        "minDist": 80,
        "maxDist": 360,
        "margin": 20,
        "leadSec": 2,
        "tailSec": 2,
      },
      "actions": [],
    },
    "categories": [],
    "events": {},
  },
  "animationWeights": { "idle": 80, "turn": 0, "move": 0 },
}
```

规则（与主宠物**严格隔离**，绝不混用）：

- **素材只查自己的**：素材目录名 = 文件名前缀（`pet/pig-config.json` → `pet/pig-animation/`），该种类所有实例共用；动画 URL `/thumb/<前缀>/<名>.webm`，查不到即 404——绝不落到 `main-animation` 或包内素材
- **动画池不回落全局**：`animations` / `animationWeights` 必须写全（缺失即配置错误）
- 与主配置同构的约束：`pets` 每只字段完整合法、数组内 id 唯一、`animations` / `animationWeights` 结构校验同一套规则；`notificationsEnabled` 是全局属性，不归宠物文件管（写了忽略、不写不报错）
- 配置非法 / 缺少 `-animation/` 目录 / 实例 id 与主宠物冲突 → 加载时显式报错并跳过（不影响其他宠物）
- 设置页**会列出**文件宠物（按种类分组）：改名称/大小/位置/显示方式/两个开关后保存，写回该种类自己的配置文件——不混进 `main-config.jsonc`，文件顶层的动画池原样保留；「+」可在该种类下新建实例，每种至少留一只


