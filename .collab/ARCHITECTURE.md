# 模块边界与低冲突架构指南（ARCHITECTURE）

为保证任意数量的人类开发者与异构 Agent 并行研发时不发生代码踩踏，请遵循以下边界约定：

## 1. 角色与分支命名规范
- 分支统一格式：`work/<actor>/<agent>/<topic>`
  - `<actor>`：自动取自 GitHub 登录名或 Git 用户名（小写短横线化）
  - `<agent>`：当前使用的智能体标识（如 `antigravity`、`codex`、`claude`、`cursor`、`nightshift`）
  - `<topic>`：简短英文功能短语（如 `d1-pagination`、`resume-pdf-export`）

## 2. 避免“咽喉文件”冲突的三大原则
1. **薄路由、厚模块**：
   - 顶层入口（如路由分发器、首页骨架 HTML）仅负责挂载与转发，具体业务逻辑拆分到独立文件。
2. **样式与测试就近归属**：
   - 新增独立页面或组件时，优先新增对应的独立测试文件 `tests/<feature>.test.*`，避免多人同时往同一个超大测试文件末尾追加用例。
3. **决策记录单文件化**：
   - 所有跨模块约定写入 `docs/decisions/YYYYMMDD-HHMMSS-<slug>.md`（使用 `node .collab/cli.mjs decision` 自动生成）。

## 3. 本机多工位端口约定
- 主工作区默认占用基础预览端口（由 `.collab/config.json` 中 `basePort` 指定，默认 `8790`）。
- 通过 `node .collab/cli.mjs spawn` 创建的每个副工位会自动在 `basePort + 1 .. basePort + 99` 范围内分配空闲端口，并写入工位根目录 `.collab-seat.json`（已被 `.gitignore` 忽略）。
