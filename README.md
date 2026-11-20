# AI原生联合开发平台

> **任意人加入 · 任意 Agent 加入 · 禁止直推 `main` · 停笔自动提 PR 过 CI · 20 秒实时双向同步**

**AI原生联合开发平台**（CLI / Skill 标识：`collab-mesh`）是一套零外部依赖的 GitHub 原生多智能体协同研发底座。只需一条 `init` 命令，即可让任意仓库同时兼容 **Antigravity、Codex、Claude Code、Cursor、Gemini CLI、夜班工厂** 等任意数量的开发者与智能体无感并行开发。

---

## 一、核心特性

1. **全异构 Agent 统一引导环（Bootstrap Ring）**：
   自动维护 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.cursor/rules/00-collab.mdc` 与 `.github/copilot-instructions.md` 托管区块，全部指向单一事实源 `.collab/PROTOCOL.md`，任何新成员带着任何 Agent 克隆仓库即可 0 培训自动守规矩。
2. **本机多开动态工位（`spawn`）**：
   同一台电脑同时运行 Antigravity + 多个 Codex 时，2 秒创建共享 `.git` 的独立 `git worktree` 工位，自动分配空闲端口（如 `8791`、`8792`）并安全拷贝本地私有 `.dev.vars` 密钥，彻底告别文件锁、测试截图与端口互抢。
3. **跨机防撞车雷达（`radar` + Draft PR 信标）**：
   无需额外部署协调服务器，利用 GitHub Draft PR 广播正在施工的路径通配符；任何 Agent 动工前自动扫描重叠热区并预警。
4. **零信任主干保护 + 免审批全自动合并（`protect` + `ship` + `collab-gate.yml`）**：
   - 本地 `pre-push` 钩子 + 远端 `enforce_admins: true` 严禁任何人（含管理员）直接 `push main`；
   - PR 无需人工点击 Approve（`required_approving_review_count: 0`）；
   - 自动拦截 `.dev.vars`、硬编码 `sk-*`/`ghp_*` 密钥与超大文件，全量 CI 测试通过后自动 Squash Merge 并清理源分支。
5. **无冲突追加式决策记录（`decision`）**：
   每次架构或产品决策独立生成 `docs/decisions/<时间戳>-<slug>.md`，多人高频并发提交永不撞同一行文本。
6. **线上防崩四道保险（Zero-Downtime Guardrails）**：
   - 本地每工位自动挂载 `.collab-data/*.sqlite` 真实快照副本，预览永不因缺库报 `503`；
   - 本地 `autopilot` 与云端 `Collab Gate` 双重硬性拦截未解决的 Git 冲突标记（`<<<<<<<`）；
   - 支持 PR 独立预览网址验收，合入发布后自动执行全链路冒烟自检，一旦异常秒级自动回滚上一健康版本；
   - `.github/workflows/uptime-monitor.yml` 每 10 分钟自动巡检线上站点，连续异常自动提 `incident` Issue 告警，恢复后自动销警。

---

## 二、快速安装与使用

### 作为 Agent Skill 安装
```powershell
# Codex
git clone https://github.com/XIAO-GOD/collab-mesh.git "$env:USERPROFILE\.codex\skills\collab-mesh"

# Claude Code
git clone https://github.com/XIAO-GOD/collab-mesh.git "$env:USERPROFILE\.claude\skills\collab-mesh"
```

### 一键赋能任意 GitHub 项目
```powershell
node bin/collab-mesh.mjs init E:\GitHub\your-project --base-port 8790 --required-checks "Collab Gate,Test"
```

### 目标仓库常用命令
```powershell
node .collab/cli.mjs status                                      # 查看当前身份、工位、同步状态
node .collab/cli.mjs spawn --agent codex --topic new-feature     # 为另一个 Agent 开辟独立 Worktree 工位
node .collab/cli.mjs radar --paths "site/src/ai-*"               # 扫描远端活跃 PR 是否冲突
node .collab/cli.mjs start --agent codex --topic new-feature     # 切分支并发起 Draft PR 施工信标
node .collab/cli.mjs sync                                        # 安全暂存并同步最新 origin/main
node .collab/cli.mjs decision "接口分页上限100" --summary "..."  # 追加无冲突 ADR 决策文件
node .collab/cli.mjs ship --title "feat: 完成新功能"             # 安全审计 + 推送 PR + 开启自动合并
node .collab/cli.mjs protect --checks "Collab Gate,Test"         # （仓库管理员）开启远端强分支保护与 Auto-merge
node .collab/cli.mjs cleanup                                     # 清理已合并的本地工位与分支

# 双向无感自动同步守护进程（免命令自动提 PR 过 CI + 20 秒实时下行拉取）
node .collab/cli.mjs autopilot start --quiet 45 --interval 20    # 启动后台常驻守护进程
node .collab/cli.mjs autopilot status                            # 查看守护进程状态与最近同步日志
node .collab/cli.mjs autopilot stop                              # 停止后台守护进程
node .collab/cli.mjs autopilot install-service                   # 注册 Windows 登录开机自启任务

# 共享云主库 + 每工位独立本地副本（线上严禁手改，本地随意折腾、坏了一键秒级还原）
node .collab/cli.mjs db pull                                     # 从云端共享主库同步快照至本地缓存与当前工位副本
node .collab/cli.mjs db reset                                    # 毫秒级还原当前工位损坏的数据库副本
node .collab/cli.mjs db query "SELECT * FROM sources LIMIT 5"    # 查询本地副本（加 --remote 为线上严格只读查询）
node .collab/cli.mjs db status                                   # 查看副本大小、在招条数与已应用迁移
```

---

## 三、运行自身测试套件

```powershell
npm test
```
