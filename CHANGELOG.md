# 定制变更记录

## 2026-11-07 DSH 提醒“查看对话”打开 DSH（0.4.3-dfh.18）

- 背景：Hermes 退役计划阶段 4 第 5 项，蓝色大肥鱼“查看对话”从 `hermes://open` 改为打开 DSH。
- 调研：DSH 0.2.2 只注册 `dsh://open`（聚焦/拉起主窗口）；Windows 上任何 `dsh://…` 都走 single-instance 只聚焦，不解析会话参数；Web UI 也没有按会话的 URL 路由。所以无法直达某个会话。
- 改动：`source=dsh` 的提醒（`dsh`/`dsh-fail`）“查看对话”固定打开 `dsh://open`；气泡标题已带会话名。外链白名单 `safeHermesUrl` 只多放行精确的 `dsh://open`（`dsh://open/x`、带参数、大小写变体都拒绝）。Hermes 自己的提醒在 Hermes 停用前仍用 `hermes://open/<id>`；Claude/Windows 提醒仍无链接。
- 验证：npm test 1711 通过 1 跳过、typecheck、UI 测试 8/8；build + dist 通过。已部署到 `D:\App\dsh-pet`（停计划任务→镜像→启动，ASAR 哈希一致，部署前程序与状态备份在 `D:\Documents\AI_project\Hermes\retirement\phase4-backups\dsh-pet-dfh17-*`）。2026-11-07 写入一条 source=dsh 测试提醒，虎哥点“查看对话”确认 DSH 主窗口弹到前台。

## 2026-11-06 DSH v1 inbox 接收端（已部署）

- 基线：接收端初稿来自 custom / 2d0788c81cbdb68c1cfb6d8779835b9c6448345c（dfh.13）；主会话发现安装版已为 dfh.17，因此切到 origin/custom / 34add86 建立 feat/dsh-inbox-notifications 分支并迁移改动，保留当前“老大”称呼及新版 Claude 功能。生产者另在父仓维护。
- 目的：现有独立宠物接收 source=dsh 的 decision / task-failed / resolved，复用已有 v1 收件协议与本地确认。
- 影响：`dsh-pet/src/host/pet-inbox.ts` 扩展输入来源；`dsh-pet/src/host/hermes-policy.ts` 扩展持久化类别、ID 校验与排序；`dsh-pet/src/host/hermes-alerts.ts` 增加 DSH 显示来源并按来源隔离 resolved；`dsh-pet/src/shared/hermes-alert-panel.ts` 识别 DSH 标题并保留“老大”。对应 host 与 panel 测试同步。
- 去重沿用现有规则：同类别 source+key 在 pending 内幂等，重启后仍有效。外部确认不占永久 dismissed，确认或 resolved 后的重投仍由生产者负责抑制。
- resolved 只清除同来源、同 session、at 不晚于 resolved 的 decision，不影响失败、其他会话或其他来源。“知道了”仍只写本地状态，不批准或回复 DSH，不提供未授权深链。
- 验证：通过 outside-runner 执行 pet-inbox、hermes-alerts、hermes-policy、hermes-alert-panel 四个测试文件，27/27 通过；npm run typecheck 通过；git diff --check 通过。首次新增测试错误地把状态文件与 inbox 混放导致计数失败，已改为独立 inbox 子目录后重跑通过。迁移至 dfh.17 后主会话再次运行相同四项测试（27/27）、typecheck、diff --check，全部通过；npm run build 与 npm run dist 均通过，使用现有本机 Electron，无下载。已通过既有计划任务停止/启动完成部署，进程归零后备份替换；ASAR 哈希核对与 /health 通过，DSH 实际问答气泡获用户确认。
- 现有独立版发布方式见 INSTALL.md：包内 npm run build、npm run dist，产物 dist-app/win-unpacked。文档安装位置 D:\App\dsh-pet，计划任务 DSH Pet Standalone，GUI exe 隐藏启动；升级前停该宠物任务、替换安装目录、再启动。本轮已按此方式核验并部署，未重启 DSH。
- 迁移：无需改变 v1 格式或现有配置，旧状态仍可读。回滚前必须备份本地 hermes-alerts-state.json；旧版本无法解析新增 dsh/dsh-fail pending。回滚程序时同时恢复部署前精确状态备份，不能直接让旧版读新增类别，也不能覆盖 Hermes/Claude 配置。

- Claude 标题：读取当前 session 最新 custom-title，三种 decision 使用“Claude 中‘名称’的这个任务需要你决定/回复/批准”。15 项测试通过，备份更新全局 hook 完成；未宣称 Claude 生产 UI 验收。
