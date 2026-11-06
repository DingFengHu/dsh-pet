# AI 用量面板（自有 fork）

**Shift + 左键点大肥鱼** 弹出 AI 用量面板「大肥鱼食堂 · 饭票小票」，再点一次、按 `Esc` 或点到别处就收起。面板贴在鱼身侧边（右侧放不下放左侧），小尾巴指向鱼脸，不压到鱼；高度随内容收紧，不留空白。点 Codex API / Claude API 那一行展开每个 Key 的花费。字体与配色沿用大肥鱼（上首软糖体、奶油底、深蓝字），订阅额度见底会盖「吃光啦」章。原独立项目 `codex-usage-panel`（C# 浮窗 + 47821 端口 Node 服务）已整合进大肥鱼并移除，不再有外部进程或端口。

## 面板内容

| 区块              | 内容                                                                  | 来源                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 订阅额度 · Codex  | 周剩余、5 小时剩余、重置倒计时（纽约时间）、套餐名                    | `codex app-server --stdio` 的 `account/rateLimits/read`（Codex CLI 自己管登录）                                                                       |
| 订阅额度 · Claude | 周剩余、5 小时剩余、重置倒计时                                        | Claude Code CLI 的 `get_usage` 控制请求（不发模型请求）；CLI 读不到时用长期令牌兜底（见下）；都不行时显示上次实时数据（数字变灰）并写明原因与数据时间 |
| Codex API         | 赠送余额 / 赠送总额、本期花费、到期日、按 Key 展开花费 / 请求 / token | OpenAI 组织 Admin Key 读 costs / usage；赠送额度读专用 Chrome 里的 Credit grants 页                                                                   |
| Claude API        | 赠送余额（多笔叠加）、最近到期金额、按 Key 展开                       | 专用 Chrome 里 Claude Console 的同源请求                                                                                                              |
| DeepSeek          | 余额（充值 / 赠送）                                                   | DeepSeek API Key 读 `/user/balance`                                                                                                                   |

- 面板可见时每 60 秒刷新一次，有来源正在读取时 3 秒后再取。面板关着时每 3 分钟后台预热一次 Codex / Claude 套餐与 DeepSeek 余额（不开浏览器标签），点开即是新数；走专用 Chrome 标签的 Codex API 赠送额度与 Claude API 仍只在面板打开时读取。
- 每个来源独立节流与缓存：套餐 1 分钟，API 用量 10 分钟，OpenAI 赠送额度页 6 小时。点刷新按钮可提前读取（各来源仍有最短间隔）。
- 某个来源失败只影响它自己那一块：有旧数据时标黄并注明数据时间，从未成功时标红。

## 凭据与边界

- API Key 一律经 1Password **Hermes-agent 只读 service account**（DPAPI 保护的 `hermes_reader.py`）在用到时读取，只放进程内存，只发往对应官方 API。不读 `TOKEN.txt`，不写盘、不进日志、不经命令行参数（命令行只带条目 ID）。
- 读取器以 `python -I` 隔离模式运行，失败只给笼统错误，不转发 stderr。
- 专用 Chrome（CDP `127.0.0.1:9222`）每次读取自开一个后台标签，用完即关，不碰其他标签，不读 Cookie / 存储。
- 数据路由 `GET /dsh-pet-7340/usage` 只回数字与错误文案，受独立应用的令牌保护；令牌只注入宠物页与 `usage.html` 两个本机渲染页。

## 本机配置

在 DSH 主目录的 `dsh-pet/usage.json`（`~/.dsh/dsh-pet/usage.json`）写非秘密标识。仓库公开，这些本机标识不进代码。缺项时对应来源显示「未配置」。改完重启大肥鱼生效。

```json
{
  "onePassword": {
    "readerDir": "<hermes_reader.py 所在目录>",
    "python": "python",
    "items": {
      "deepseek": "<1Password 条目 ID>",
      "openaiAdmin": "<1Password 条目 ID>",
      "claudeOauth": "<1Password 条目 ID，可选>"
    }
  },
  "claudeConsoleOrg": "<Claude Console 组织 ID>",
  "cdpUrl": "http://127.0.0.1:9222",
  "codexCli": null,
  "claudeCli": null,
  "credits": {
    "codex": { "grantUsd": 200, "resetDay": 1 },
    "claude": { "grantUsd": 200, "expiresAt": "2026-11-07" }
  }
}
```

`credits` 只在赠送额度页面读不到时作估算兜底，面板会注明「估算值」。Claude 套餐的上次实时数据落在同目录 `usage-claude-last.json`（只有额度数字）。

`claudeOauth`（可选）指向存放 `claude setup-token` 长期令牌的 1Password 条目（credential 字段）。这种令牌没有 `user:profile` 权限，读不了额度接口，所以大肥鱼只在 CLI 的 `get_usage` 读不到额度时（限流、CLI 未登录）才用它：发一次最小的模型请求（Haiku、1 个输出 token），从应答头 `anthropic-ratelimit-unified-7d/5h-*` 取额度，最多每 15 分钟一次，会消耗极少量订阅额度。应答头里没有 5 小时窗口时，面板只显示周额度。令牌只在内存里，复制时夹带的换行会被去掉；令牌失效（401/403）时面板提示重新运行 `claude setup-token`。

## 代码位置

- 取数：`dsh-pet/src/host/usage/`（`plan.ts` 套餐、`api-keys.ts` API 用量、`cdp.ts` 专用 Chrome、`secrets.ts` 1Password、`source.ts` 缓存节流、`config.ts` 配置）
- 路由：`dsh-pet/src/host/routes/usage.ts`
- 面板：`dsh-pet/runtime/electron-helper/usage.html`，窗口 `runtime/electron-helper/main/usage-window.js`
- 快捷键：`runtime/electron-helper/sprite/input.js`（Shift+点击不播点击动画、不计分；同时按 Ctrl 时按「呼出 DSH」处理）

只在独立应用（`D:\App\dsh-pet`）形态完整可用；DSH 插件形态下面板能打开，但数据路由的令牌注入只在独立应用里生效。
