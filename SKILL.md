---
name: collab-mesh
description: >-
  当用户提到“AI原生联合开发平台”“多人联合开发”“让另一个Codex/Claude/Agent加入开发”“给仓库接入多Agent协同”“开辟新工位/Worktree”“开启自动双向同步”时激活此技能，把任意 GitHub 仓库升级为支持任意人 × 任意异构 Agent 零信任自动协同的「AI原生联合开发平台」。
---

# AI原生联合开发平台（AI-Native Collaborative Development Platform）

**AI原生联合开发平台** 用于解决**多人 + 多异构编程 Agent（Antigravity、Codex、Claude Code、Cursor、Gemini CLI、夜班工厂等）在同一 GitHub 仓库高频并行研发**时的五大核心难题：规则分裂、同机多开抢锁、跨机盲改撞车、直推主干破窗、人工推拉繁琐。

## 核心入口（以本 Skill 目录 `<SKILL_DIR>` 为基准）

### 1. 给任意 GitHub 仓库一键注入多智能体协同底座

```powershell
node "<SKILL_DIR>/bin/collab-mesh.mjs" init "<目标仓库路径>" `
  --base-port 8790 `
  --required-checks "Collab Gate,Test"
```

注入后目标仓库自动获得：
- **全异构引导环**：`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.cursor/rules/00-collab.mdc`、`.github/copilot-instructions.md` 全部幂等挂载托管区块，指向唯一权威协议 `.collab/PROTOCOL.md`。
- **单文件零依赖协同 CLI**：`.collab/cli.mjs`（支持 `status` / `radar` / `spawn` / `start` / `sync` / `decision` / `ship` / `protect` / `cleanup`）。
- **双保险主干防直推与免审批自动合并**：本地 `.git/hooks/pre-push` 硬件拦截 `git push origin main` + `.github/workflows/collab-gate.yml` 云端安全门禁与 CI 全绿自动 Squash 合入 + `protect` 一键配置远端分支保护（`enforce_admins=true`、`required_approving_review_count=0`、`allow_auto_merge=true`）。

### 2. 已接入仓库中的日常协同操作

```powershell
# 为本机第二个 Agent（如另一个 Codex）开辟共享 .git 的隔离工位、独立端口并自动拷贝 .dev.vars
node .collab/cli.mjs spawn --agent codex --topic <功能英文名>

# 动工前扫描远端所有 Open / Draft PR 是否有文件范围重叠
node .collab/cli.mjs radar --paths "src/ai-*,public/assets/*"

# 切出规范工作分支并发布 Draft PR 施工信标
node .collab/cli.mjs start --agent antigravity --topic <功能英文名> --paths "src/ai-*"

# 安全扫描 + 本地测试 + 推送 PR + 开启 CI 全绿自动 Squash 合并（无需人工审批）
node .collab/cli.mjs ship --title "feat: 完成某某功能"

# （仓库管理员执行一次）在 GitHub 远端开启限制管理员直推 main + 必过 CI + 自动合并
node .collab/cli.mjs protect --checks "Collab Gate,Test"

# 开启全自动无感双向同步（停笔 45 秒自动上行提 PR 等 CI 合入，每 20 秒自动下行同步所有工位）
node .collab/cli.mjs autopilot start --quiet 45 --interval 20
node .collab/cli.mjs autopilot status
node .collab/cli.mjs autopilot install-service
```
