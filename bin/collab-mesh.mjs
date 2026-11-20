#!/usr/bin/env node
/**
 * Collab-Mesh Universal Injector (bin/collab-mesh.mjs)
 * 一键把任意 Git / GitHub 项目升级为支持「任意人 × 任意异构 Agent」的零信任自动协同仓库。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installHooks } from "../runtime/cli.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const START_MARKER = "<!-- COLLAB-MESH:START -->";
const END_MARKER = "<!-- COLLAB-MESH:END -->";

const SHIM_BLOCK = `${START_MARKER}
## 多人 × 多异构 Agent 协同研发规则（Collab-Mesh）

本仓库已启用 **Collab-Mesh 零信任多智能体协同协议**，支持任意数量的人类开发者与任意编程 Agent（Antigravity、Codex、Claude Code、Cursor、Gemini CLI、夜班工厂等）并行协作：

1. **动工前必读协议**：首次进入会话或开始任务前，先阅读 \`.collab/PROTOCOL.md\` 与 \`.collab/ARCHITECTURE.md\`（若有 \`docs/decisions/\` 则一并浏览最新决策）。
2. **禁止直推主干**：**严禁直接 \`git push origin main\`**（含管理员）。一切修改必须走 \`work/<actor>/<agent>/<topic>\` 分支并通过 PR 自动合并。
3. **开工先扫防撞雷达**：修改代码前先运行 \`node .collab/cli.mjs radar --paths "<拟改路径>"\` 或 \`node .collab/cli.mjs start --agent <你的Agent名> --topic <英文短横线主题> --paths "<拟改路径>"\`。
4. **同机多开用独立工位**：若同一台机器并行运行多个 Agent，使用 \`node .collab/cli.mjs spawn --agent <agent> --topic <topic>\` 创建隔离 Worktree 与独立端口；若当前目录存在 \`.collab-seat.json\`，优先使用其中分配的 \`port\` 启动本地服务。
5. **免审批全自动交付**：完成后运行 \`node .collab/cli.mjs ship --title "<提交标题>"\`，CI 全绿后自动 Squash 合入 \`main\`。
${END_MARKER}`;

function upsertManagedBlock(filePath, block) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (!existsSync(filePath)) {
    writeFileSync(filePath, block + "\n", "utf8");
    return;
  }
  const existing = readFileSync(filePath, "utf8");
  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);
  if (startIdx >= 0 && endIdx > startIdx) {
    const updated = existing.slice(0, startIdx) + block + existing.slice(endIdx + END_MARKER.length);
    writeFileSync(filePath, updated, "utf8");
  } else {
    writeFileSync(filePath, block + "\n\n" + existing, "utf8");
  }
}

function ensureGitignoreEntries(repoDir, entries) {
  const giPath = path.join(repoDir, ".gitignore");
  const existing = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !lines.has(e));
  if (missing.length > 0) {
    const suffix = (existing && !existing.endsWith("\n") ? "\n" : "")
      + "\n# Collab-Mesh 本机多工位元数据（不入库）\n"
      + missing.join("\n") + "\n";
    writeFileSync(giPath, existing + suffix, "utf8");
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq > 0) flags[t.slice(2, eq)] = t.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[t.slice(2)] = argv[++i];
      else flags[t.slice(2)] = true;
    } else {
      positional.push(t);
    }
  }
  return { positional, flags };
}

export function initRepo(targetRepo, options = {}) {
  const root = path.resolve(targetRepo);
  if (!existsSync(path.join(root, ".git"))) {
    throw new Error(`目标路径不是有效的 Git 仓库（未找到 .git）：${root}`);
  }

  // 1. 注入 .collab/ 核心目录
  const collabDir = path.join(root, ".collab");
  mkdirSync(collabDir, { recursive: true });
  copyFileSync(path.join(PKG_ROOT, "runtime/cli.mjs"), path.join(collabDir, "cli.mjs"));
  if (!existsSync(path.join(collabDir, "PROTOCOL.md")) || options.overwrite) {
    copyFileSync(path.join(PKG_ROOT, "templates/PROTOCOL.md"), path.join(collabDir, "PROTOCOL.md"));
  }
  if (!existsSync(path.join(collabDir, "ARCHITECTURE.md")) || options.overwrite) {
    copyFileSync(path.join(PKG_ROOT, "templates/ARCHITECTURE.md"), path.join(collabDir, "ARCHITECTURE.md"));
  }

  const configPath = path.join(collabDir, "config.json");
  const prevConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const nextConfig = {
    protectedBranch: options.protectedBranch || prevConfig.protectedBranch || "main",
    basePort: Number(options.basePort || prevConfig.basePort || 8790),
    maxFileSizeMb: Number(options.maxFileSizeMb || prevConfig.maxFileSizeMb || 15),
    secretFiles: prevConfig.secretFiles || [".dev.vars", "site/.dev.vars", ".env.local", "site/.env.local"],
    requiredChecks: options.requiredChecks
      ? String(options.requiredChecks).split(",").map((s) => s.trim()).filter(Boolean)
      : prevConfig.requiredChecks || ["Collab Gate"],
    localTestCommand: options.localTestCommand ?? prevConfig.localTestCommand ?? "",
    gateTestCommand: options.gateTestCommand ?? prevConfig.gateTestCommand ?? "",
  };
  writeFileSync(configPath, JSON.stringify(nextConfig, null, 2) + "\n", "utf8");

  // 2. 注入全异构 Agent 统一引导环（AGENTS.md / CLAUDE.md / GEMINI.md / Cursor / Copilot）
  for (const shimFile of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"]) {
    upsertManagedBlock(path.join(root, shimFile), SHIM_BLOCK);
  }
  const cursorRulePath = path.join(root, ".cursor/rules/00-collab.mdc");
  mkdirSync(path.dirname(cursorRulePath), { recursive: true });
  const cursorRule = `---
description: Collab-Mesh 多人多智能体零信任协同协议
globs: *
alwaysApply: true
---

@${".collab/PROTOCOL.md"}
${SHIM_BLOCK}
`;
  writeFileSync(cursorRulePath, cursorRule, "utf8");

  // 3. 注入 GitHub Actions 自动安全闸与免审批自动合并工作流 + PR 模板
  const wfPath = path.join(root, ".github/workflows/collab-gate.yml");
  mkdirSync(path.dirname(wfPath), { recursive: true });
  copyFileSync(path.join(PKG_ROOT, "templates/collab-gate.yml"), wfPath);

  const prTplPath = path.join(root, ".github/PULL_REQUEST_TEMPLATE.md");
  if (!existsSync(prTplPath) || options.overwrite) {
    copyFileSync(path.join(PKG_ROOT, "templates/PULL_REQUEST_TEMPLATE.md"), prTplPath);
  }

  // 4. 初始化追加式架构决策目录 docs/decisions/
  const adrDir = path.join(root, "docs/decisions");
  mkdirSync(adrDir, { recursive: true });
  const adr0001 = path.join(adrDir, "0001-adopt-collab-mesh.md");
  if (!existsSync(adr0001)) {
    copyFileSync(path.join(PKG_ROOT, "templates/decision-0001.md"), adr0001);
  }

  // 5. 确保 .gitignore 忽略本机工位描述文件
  ensureGitignoreEntries(root, [".collab-seat.json"]);

  // 6. 安装本地 pre-push 钩子拦截直推 main
  const hookPath = installHooks(root);

  return { ok: true, root, config: nextConfig, hookPath };
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (cmd !== "init") {
    console.log("用法：node bin/collab-mesh.mjs init <目标Git仓库路径> [--base-port 8790] [--required-checks \"Collab Gate,Test\"] [--local-test \"...\"] [--gate-test \"...\"]");
    process.exit(cmd === "--help" || cmd === "-h" ? 0 : 1);
  }
  const target = positional[1] || process.cwd();
  const res = initRepo(target, {
    protectedBranch: flags["protected-branch"],
    basePort: flags["base-port"],
    maxFileSizeMb: flags["max-file-mb"],
    requiredChecks: flags["required-checks"],
    localTestCommand: flags["local-test"],
    gateTestCommand: flags["gate-test"],
    overwrite: Boolean(flags.overwrite),
  });
  console.log(JSON.stringify(res, null, 2));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
