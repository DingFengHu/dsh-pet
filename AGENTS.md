# DFY（大肥鱼 dsh-pet 定制 fork）协作规则

- 定制发布分支是 `custom`，PR 一律合进 `custom`，不合进 `main`。
- 共享 checkout `D:\Documents\AI_project\Projects\DFY` 会被多个会话同时使用。不要在里面切分支，也不要在里面开发；每个改动都在 `output/wt/<任务名>` 下自己开 worktree，从 `origin/custom` 拉分支。
- **只部署已经合并的代码。** 部署只用 `dsh-pet/scripts/deploy-standalone.ps1`，在 `origin/custom` 最新提交的干净 worktree 里、通过 outside-runner 运行。禁止以下做法：
  - 手动 robocopy 到 `D:\App\dsh-pet`；
  - 直接改安装目录里的 `app.asar` 或其中的文件；
  - 用带未提交改动的工作区构建并部署。
- 原因（2026-11-10）：OpenRouter 额度和「虎妞说：」标题都是从未提交的工作区直接改包上线的，下一次从 `custom` 正规重建时被覆盖丢失。脚本拒绝部署时，先把缺的代码提交合并，再重新部署，不要绕过脚本。
- 文档：用户可见的改动同时更新 `CHANGELOG.md`，涉及用量面板的还要更新 `USAGE.md`，涉及安装部署的更新 `INSTALL.md`。
