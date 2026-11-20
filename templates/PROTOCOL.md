# 多人 × 多异构 Agent 协同研发宪法（Collab-Mesh Protocol）

> **本文件为仓库内所有人类开发者与所有编程 Agent（Antigravity / Codex / Claude Code / Cursor / Gemini CLI / 夜班工厂等）共同遵守的唯一权威工程协议。**

---

## 一、五条铁律（Zero-Trust Rules）

1. **严禁直接向 `main` 推送代码**：
   - 本地 `pre-push` 钩子与远端 GitHub 规则均禁止直接 `git push origin main`（含管理员）。
   - **所有改动必须走短生命周期分支（`work/<操作者>/<agent>/<主题>`）并通过 Pull Request 合入**。
2. **开工必扫雷达（Pre-flight Radar）**：
   - 接到任务后、动手改代码前，**必须先运行** `node .collab/cli.mjs radar --paths "<拟修改路径通配>"`（或直接用 `node .collab/cli.mjs start`）。
   - 系统会自动执行 `git fetch origin` 并扫描所有 Open / Draft PR 的改动文件与信标范围，避免与他人的 Agent 撞车。
3. **本机多开必用独立工位（Worktree Seat）**：
   - 同一台电脑同时运行 2 个及以上 Agent 时，严禁共用同一工作目录。
   - 必须通过 `node .collab/cli.mjs spawn --agent <codex|claude|cursor|...> --topic <slug>` 开辟共享 `.git` 的独立工作树、独立预览端口与独立本地锁。
4. **追加优于篡改（Append over Mutate）**：
   - 重大产品/架构决策一律通过 `node .collab/cli.mjs decision "<标题>" --summary "<内容>"` 在 `docs/decisions/` 下生成独立文件，禁止多人反复争抢修改同一大文档顶部。
   - 测试临时截图与缓存不得混入业务提交。
5. **全自动 CI 门禁与自动合并（Auto-Merge without Human Bottleneck）**：
   - 完成开发后运行 `node .collab/cli.mjs ship --title "<提交说明>"`。
   - PR 无需等待人工审批；只要通过密钥/体积安全闸与全量 CI 测试，系统即自动执行 Squash Auto-Merge 合入 `main` 并清理临时分支。

---

## 二、标准开发闭环命令（所有 Agent 统一调用）

```bash
# 1. 查看当前工位、身份、主干落后情况与钩子健康度
node .collab/cli.mjs status

# 2. 【跨机防撞车】扫描远端正在进行的 PR 是否与本次目标文件重叠
node .collab/cli.mjs radar --paths "site/src/ai-*,site/public/assets/account.js"

# 3. 【同机多Agent】为另一个 Agent（如第二个 Codex）开辟独立 Worktree 工位与独立端口
node .collab/cli.mjs spawn --agent codex --topic feature-x

# 4. 【正式开工】切出规范分支并发布 Draft PR 施工信标（向全团队广播正在修改的范围）
node .collab/cli.mjs start --agent antigravity --topic feature-x --paths "site/src/ai-*"

# 5. 【同步主干】无损暂存本地修改 → 拉取最新 origin/main → 变基对齐 → 恢复工作区
node .collab/cli.mjs sync

# 6. 【记录决策】无冲突追加一条架构/产品决策记录（ADR）
node .collab/cli.mjs decision "统一模型超时为90秒" --summary "适配 High 思考模型响应耗时"

# 7. 【一键交付】密钥安全扫描 + 本地测试 + 推送分支 + 创建/转正 PR + 开启 CI 通过后自动合并
node .collab/cli.mjs ship --title "feat: 完成某某功能"

# 8. 【回收清理】清理已合入 main 的本地 Worktree 工位与过期分支
node .collab/cli.mjs cleanup
```

---

## 三、敏感信息与环境隔离红线

- 本地私有密钥仅允许存放在被 `.gitignore` 忽略的 `.dev.vars` 或 `.env.local` 中（`spawn` 创建新工位时会自动安全拷贝至子工位，绝不进入 Git）。
- 严禁在源码、测试夹具或 Markdown 文档中硬编码真实 `sk-*`、`ghp_*`、`AKIA*` 等凭据。
