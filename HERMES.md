# Hermes 提醒（自有 fork）

这项扩展用于当前 `dsh-pet` 蓝色大肥鱼，不是旧 `dsh-desktop-pet`。保留 DSH 原工作状态、待办、显示设置与物理交互。

## 权限与行为

- 通过已安装 Hermes 的同用户原生发现/认证接口读取运行中的会话与 cron 状态，不启动第二个 Hermes 网关。
- 只显示等待用户处理的请求及新出现的 cron 失败，不把助手正文中的问号当作请求。
- **知道了**仅写大肥鱼自己的确认记录，不回答、批准、取消、重跑或暂停 Hermes 任务。
- **查看对话**只在有可靠会话关联时启用，不能关联的执行不得猜造会话。
- 不输出审批参数、任务提示词、失败详情或认证票据。凭据只由 Hermes 官方同用户接口在本机处理。
- 初次接入建立 cron 历史基线，不批量弹出既往失败。新请求/失败使用不同稳定标识。
- 来源部分离线时保留未确认提醒，并显示状态可能过期。待办面板及宠物占用锁仍受原规则管理。
- 提醒气泡用女仆风样式（奶油底、蓝色虚线边、胶囊按钮），字体跟随宠物字体设置（默认随包软糖体），不使用假粗体。样式在 `src/shared/hermes-alert-panel.ts` 的 `HERMES_ALERT_CSS`，网页与桌面两端共用。

## 本机接入

在 DSH 主目录的 `dsh-pet/hermes-alerts.jsonc` 配置以下非秘密路径。没有配置时不拉起读取进程。

```json
{
  "python": "<Hermes现有Python解释器绝对路径>",
  "hermesRoot": "<Hermes安装源码绝对路径>",
  "home": "<Hermes数据主目录绝对路径>"
}
```

复用现有 Hermes 环境，不另装 Python 依赖，不复制 API key。路径配置为本机私有文件，不提交个人安装路径。运行数据存于同目录的独立确认状态文件。

## 明确边界

- 使用本机原生 `hermes://open/<session>`，不绕到网页端。注册必须指向正在使用的 Hermes 安装，而非旧开发环境。默认 profile 可跳转，其他 profile 在未验证原生 profile 切换前只提供本地确认，不冒险打开错误会话。
- cron 仅在最后 canonical execution ID 与运行历史精确匹配、失败对应本次运行时提供会话链接。较早的 sticky 失败和纯脚本失败可能没有会话链接。
- 普通审批读取 `approval.pending`，批量提问读取当前 server requests。旧式提问从带 epoch 的事件重放恢复；若事件已被截断但运行状态仍明确等待用户，只显示稳定的泛化等待提醒与过期警告，不调用 activate/resume 干扰会话。
- 本地确认记录有 2048 条安全上限，达到上限会明确拒绝新的确认而非丢掉旧记录导致重复提醒。后续如需长期大规模使用，应增加经过验证的安全清理策略。

## 开发与部署

- 源码基线：自有 fork `271d501c948922bf732a9ef9212222032cb503ff`，上游 `e3a2be8`，功能包 0.4.3。
- 执行包目录的 `npm run build`，包含网页和桌面共享核心。不要手改生成的 `shared-core.js`。
- **当前运行形态是独立 exe，不依赖 DSH**（0.4.3-dfh.3 起）：`npm run dist` 产出 `dist-app/win-unpacked/`，镜像到 `D:\App\dsh-pet`，由登录计划任务 `DSH Pet Standalone` 启动。升级见 [INSTALL.md](INSTALL.md)「开机自启」。配置与确认记录仍在 `$DSH_HOME/dsh-pet/`，两种形态通用。
- 独立 exe 用 asar 打包：`scripts/hermes-notification-snapshot.py` 必须同时列在 `electron-builder.yml` 的 `files` 与 `asarUnpack`，`hermes-poll.ts` 的 `unpackedAsarPath` 把路径换成 `app.asar.unpacked`，否则外部 Python 读不到脚本、提醒静默失效。
- 独立 exe 的渲染页是 `file://`（Origin 为 `null`/`file://`）。“知道了”走 HTTP，宿主的同源守卫只认独立模式请求安全层**令牌已核验**的请求（`host/plugin/local-request.ts` 标记），回环地址与本机 Host 检查不放宽。DSH 内走受信桥接管道，不经过这条。
- 若改回 DSH 插件形态：通过 DSH 官方 plugin 安装流程升级，保留上一版精确 tarball 和本机配置备份，并停用独立 exe 的计划任务，避免两只同时出现。
- 相关源码、Python helper 和测试一并打包/验证。
- 升级不恢复此前移除的碎碎念、聊天、余额、睡觉等功能，不替换 Hermes 安装源码。
- 实际验收结果与限制由父仓库 CHANGELOG 和本机交付回执记录。自动测试或源码构建不代表线上提醒已生效。

## 回滚

独立 exe：停计划任务，把安装目录换回上一版 `win-unpacked` 备份后再启动；回到 DSH 插件形态则 `dsh plugin --profile desktop add file:<上一版精确 tarball>` 并停用计划任务。DSH 插件形态内：重新安装升级前的精确 dsh-pet tarball，只撤回本次新增的 Hermes 路径配置。确认记录和用户其他宠物配置保留，不整份覆盖旧 profile，不强杀 DSH。

## 虎妞单向转发（0.4.3-dfh.9 起）

虎妞（ChatGPT dots）每次给虎哥回复后，调用专用私有插件「大肥鱼 · 虎妞转发」的唯一工具 `pet_show_message({message_id, text})`，大肥鱼把原文显示在提醒气泡里（标题「虎妞」，按收到顺序，点「知道了」收起）。单向，大肥鱼不回话。0.4.3-dfh.8 读 Hermes 桥接账本的做法是误解需求，已撤销。

- 收件口：`src/host/huniu-inbox.ts`，只听 `127.0.0.1:18781/mcp`，最小 MCP（Streamable HTTP，JSON 响应），精确 Host、拒绝 Origin、Bearer、32 KiB 上限。数据根 `huniu-inbox.key`（64 位 hex，ACL 仅本人/SYSTEM/Administrators）不存在就不监听。
- 消息与 Hermes 提醒共用状态文件 `hermes-alerts-state.json`（kind `huniu`），同 `message_id` 幂等，确认过的不再出现。超过 4000 字截断并标注；待确认上限 512 条，满了工具返回错误而不丢旧消息。
- 隧道：OpenAI Platform 隧道 `dsh-pet-huniu-inbox`，运行密钥仅 Tunnels Read+Use、30 天有效，存 `$DSH_HOME/dsh-pet/tunnel/tunnel.key`（ACL 同上）。`D:\App\dsh-pet-tunnel` 放独立的 tunnel-client 0.0.19 与 `scripts/huniu-inbox-tunnel.py`；隐藏计划任务 `DSH Pet Huniu Tunnel`（pythonw，登录后 1 分钟，之后每 30 分钟重跑，`runtimes connect` 复用已有别名 `dsh-pet-huniu`）。公开状态写 `tunnel/runtime-status.json`。
- ChatGPT 私有插件：隧道连接、无需身份验证（外层是账户隧道授权，内层仍校验本机 Bearer），权限保持默认「允许使用低风险工具」。
- 回滚：停用并删除计划任务，`tunnel-client runtimes stop dsh-pet-huniu`，在 ChatGPT 删除插件，Platform 撤销密钥与隧道；删 `huniu-inbox.key` 后大肥鱼不再监听。
