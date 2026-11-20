import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initRepo } from "../bin/collab-mesh.mjs";
import { auditPr } from "../runtime/cli.mjs";

const HOME = os.homedir();
const GIT = [
  path.join(HOME, ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe"),
  "C:/Program Files/Git/cmd/git.exe",
  "git",
].find((p) => p === "git" || existsSync(p));

function git(args, cwd, envExtra = {}) {
  const res = spawnSync(GIT, args, { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, ...envExtra } });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  return res;
}

function runCli(repoDir, args, envExtra = {}) {
  return spawnSync(process.execPath, [path.join(repoDir, ".collab/cli.mjs"), ...args], {
    cwd: repoDir,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, COLLAB_ACTOR: "xiao", ...envExtra },
  });
}

test("initRepo 幂等注入引导环且保留原有自定义文档内容", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "collab-mesh-init-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, "demo");
  mkdirSync(repo);
  git(["init", "-b", "main"], repo);
  writeFileSync(path.join(repo, "AGENTS.md"), "# 原有业务说明\n保留此段内容。\n", "utf8");

  initRepo(repo, { basePort: 8790, requiredChecks: "Collab Gate,Test" });
  initRepo(repo, { basePort: 8790, requiredChecks: "Collab Gate,Test" }); // 二次调用验证幂等

  for (const rel of [
    "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursor/rules/00-collab.mdc",
    ".github/copilot-instructions.md", ".collab/PROTOCOL.md", ".collab/ARCHITECTURE.md",
    ".collab/cli.mjs", ".collab/config.json", ".github/workflows/collab-gate.yml",
    "docs/decisions/0001-adopt-collab-mesh.md",
  ]) {
    assert.equal(existsSync(path.join(repo, rel)), true, `应生成 ${rel}`);
  }
  const agentsMd = readFileSync(path.join(repo, "AGENTS.md"), "utf8");
  assert.match(agentsMd, /原有业务说明/);
  assert.equal((agentsMd.match(/<!-- COLLAB-MESH:START -->/g) || []).length, 1);
});

test("pre-push 钩子严禁直接 push main，允许推送 work/* 工作分支", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "collab-mesh-hook-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const bare = path.join(tmp, "remote.git");
  const repo = path.join(tmp, "local");
  mkdirSync(bare);
  mkdirSync(repo);
  git(["init", "--bare", "-b", "main"], bare);
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "Test User"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["remote", "add", "origin", bare], repo);

  writeFileSync(path.join(repo, "README.md"), "# Demo\n", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "-m", "initial"], repo);
  // 初始化远端 main 基线后再注入禁止直推钩子
  git(["push", "-u", "origin", "main"], repo);

  initRepo(repo);
  git(["add", "-A"], repo);
  git(["commit", "-m", "chore: inject collab-mesh"], repo);

  // 直接推送 main 必须被拦截
  const directPush = spawnSync(GIT, ["push", "origin", "main"], { cwd: repo, encoding: "utf8", windowsHide: true });
  assert.notEqual(directPush.status, 0, "直推 main 必须失败");
  assert.match(directPush.stderr, /禁止直接推送至受保护主分支/);

  // 切到 work/* 分支推送必须放行
  const startRes = runCli(repo, ["start", "--agent", "codex", "--topic", "setup", "--no-remote"]);
  assert.equal(startRes.status, 0, startRes.stderr);
  const branch = JSON.parse(startRes.stdout).branch;
  assert.equal(branch, "work/xiao/codex/setup");
  const workPush = spawnSync(GIT, ["push", "-u", "origin", branch], { cwd: repo, encoding: "utf8", windowsHide: true });
  assert.equal(workPush.status, 0, workPush.stderr);
});

test("spawn 动态创建隔离 Worktree、分配不冲突端口、安全拷贝私有 .dev.vars，cleanup 自动回收", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "collab-mesh-spawn-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, "app");
  mkdirSync(repo);
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "Test User"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  initRepo(repo, { basePort: 9100 });
  mkdirSync(path.join(repo, "site"), { recursive: true });
  writeFileSync(path.join(repo, ".gitignore"), ".dev.vars\n.collab-seat.json\n", "utf8");
  writeFileSync(path.join(repo, "site/.dev.vars"), "AI_API_KEY=local-dev-secret\n", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "-m", "init with collab-mesh"], repo);

  const s1 = runCli(repo, ["spawn", "--agent", "codex", "--topic", "feat-a"]);
  assert.equal(s1.status, 0, s1.stderr);
  const seat1 = JSON.parse(s1.stdout).seat;

  const s2 = runCli(repo, ["spawn", "--agent", "claude", "--topic", "feat-b"]);
  assert.equal(s2.status, 0, s2.stderr);
  const seat2 = JSON.parse(s2.stdout).seat;

  assert.notEqual(seat1.port, seat2.port, "两个并发工位必须分配不同端口");
  assert.equal(existsSync(path.join(seat1.worktree, "site/.dev.vars")), true, "子工位应自动拷贝私有 .dev.vars");
  assert.equal(existsSync(path.join(seat1.worktree, ".collab-seat.json")), true);

  // 追加 ADR 决策文件
  const dec = runCli(seat1.worktree, ["decision", "采用统一流式接口", "--summary", "前后端通过 SSE 传输"]);
  assert.equal(dec.status, 0, dec.stderr);
  const adrRel = JSON.parse(dec.stdout).file;
  assert.equal(existsSync(path.join(seat1.worktree, adrRel)), true);

  // 合入主干前先验证干净状态下 auditPr 通过
  git(["add", "-A"], seat1.worktree);
  git(["commit", "-m", "docs: record decision"], seat1.worktree);
  assert.equal(auditPr(seat1.worktree, "main").ok, true);

  // 若有人误提交真实格式密钥，auditPr 必须拦截
  writeFileSync(path.join(seat1.worktree, "leak.js"), 'const k = "sk-liveSecretKeyAbcdefghijklmnop123456";\n', "utf8");
  git(["add", "leak.js"], seat1.worktree);
  git(["commit", "-m", "accidental leak"], seat1.worktree);
  const badAudit = auditPr(seat1.worktree, "main");
  assert.equal(badAudit.ok, false);
  assert.match(badAudit.errors.join("\n"), /硬编码真实密钥/);

  // 模拟 seat2 已合入 main 后 cleanup 自动清理 seat2，保留未合入的 seat1
  const cleanRes = runCli(repo, ["cleanup"]);
  assert.equal(cleanRes.status, 0, cleanRes.stderr);
  const cleaned = JSON.parse(cleanRes.stdout);
  assert.ok(cleaned.deletedBranches.includes("work/xiao/claude/feat-b"));
});
