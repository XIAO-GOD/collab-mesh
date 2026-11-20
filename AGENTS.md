<!-- COLLAB-MESH:START -->
## AI原生联合开发平台 · 多人 × 多异构 Agent 协同规则

本仓库已接入 **AI原生联合开发平台**，支持任意数量的人类开发者与任意编程 Agent（Antigravity、Codex、Claude Code、Cursor、Gemini CLI、夜班工厂等）无感并行协作：

1. **动工前必读协议**：首次进入会话或开始任务前，先阅读 `.collab/PROTOCOL.md` 与 `.collab/ARCHITECTURE.md`（若有 `docs/decisions/` 则一并浏览最新决策）。
2. **禁止直推主干**：**严禁直接 `git push origin main`**（含管理员）。一切修改必须走 `work/<actor>/<agent>/<topic>` 分支并通过 CI 检测后自动合并。
3. **开工先扫防撞雷达**：修改代码前先运行 `node .collab/cli.mjs radar --paths "<拟改路径>"` 或 `node .collab/cli.mjs start --agent <你的Agent名> --topic <英文短横线主题> --paths "<拟改路径>"`。
4. **同机多开用独立工位**：若同一台机器并行运行多个 Agent，使用 `node .collab/cli.mjs spawn --agent <agent> --topic <topic>` 创建隔离 Worktree 与独立端口；若当前目录存在 `.collab-seat.json`，优先使用其中分配的 `port` 启动本地服务。
5. **双向无感自动同步**：本平台支持 `node .collab/cli.mjs autopilot start` 后台守护（停笔自动提 PR 过 CI 合入 `main`，每 20 秒实时拉取他人更新）；也可显式运行 `node .collab/cli.mjs ship --title "<提交标题>"` 立即交付。
6. **共享数据库与本地副本铁律**：云端主库仅允许自动抓取器与合入 `main` 的迁移脚本写入，**严禁任何人与 AI 手动直连改写线上库**；日常开发统一运行 `node .collab/cli.mjs db pull` 拉取本工位独立副本（`.collab-data/*.sqlite`），在本地副本上随意调试，损坏后运行 `node .collab/cli.mjs db reset` 一键还原。
<!-- COLLAB-MESH:END -->
