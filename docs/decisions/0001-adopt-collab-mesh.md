# 0001 · 启用 Collab-Mesh 多人 × 多异构 Agent 零信任协同架构

- **状态**：已生效
- **范围**：全仓库研发流程、分支管理与 CI 自动合并

## 决策内容
1. 启用统一引导环（`AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / `.cursor/rules` 全部指向 `.collab/PROTOCOL.md`），任意新成员使用任意 Agent 克隆仓库即自动对齐规则。
2. 禁止任何人或 Agent 直接 `push` 到 `main` 分支；所有代码修改一律通过 `work/<actor>/<agent>/<topic>` 短分支提交 PR。
3. 本机同时运行多个 Agent 时，使用 `node .collab/cli.mjs spawn` 创建独立 Git Worktree 工位与独立端口，消除文件锁与端口冲突。
4. 开启 CI 全绿后免人工审批自动合并（Squash Auto-Merge），兼顾全自动研发速度与主干零破窗质量。
