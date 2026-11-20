import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initRepo } from "../bin/collab-mesh.mjs";
import { syntaxPrecheck, shipMainWorktreeShadow, shipSeatWorktree, pullAllWorktrees } from "../runtime/autopilot.mjs";

const HOME = os.homedir();
const GIT = [
  path.join(HOME, ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe"),
  "C:/Program Files/Git/cmd/git.exe",
  "git",
].find((p) => p === "git" || existsSync(p));

function git(args, cwd) {
  const res = spawnSync(GIT, args, { cwd, encoding: "utf8", windowsHide: true });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

test("syntaxPrecheck 拦截半截 JS 与损坏 JSON，放行完整语法", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "autopilot-syn-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(tmp, "broken.mjs"), "export function foo( {\n", "utf8");
  assert.equal(syntaxPrecheck(tmp, [{ rel: "broken.mjs" }]).ok, false);

  writeFileSync(path.join(tmp, "bad.json"), '{"a": 1,', "utf8");
  assert.equal(syntaxPrecheck(tmp, [{ rel: "bad.json" }]).ok, false);

  writeFileSync(path.join(tmp, "good.mjs"), "export const ok = 42;\n", "utf8");
  writeFileSync(path.join(tmp, "good.json"), '{"a": 1}\n', "utf8");
  assert.equal(syntaxPrecheck(tmp, [{ rel: "good.mjs" }, { rel: "good.json" }]).ok, true);

  // 回归：含冲突标记的文件、未解决冲突状态（UU）都必须拦截，不许自动上行
  writeFileSync(path.join(tmp, "doc.md"), "a\n<<<<<<< Updated upstream\nx\n=======\ny\n>>>>>>> Stashed changes\n", "utf8");
  assert.equal(syntaxPrecheck(tmp, [{ rel: "doc.md" }]).ok, false);
  assert.equal(syntaxPrecheck(tmp, [{ code: "UU", rel: "good.mjs" }]).ok, false);
});

test("Autopilot 双向无感同步：上行自动推 work/* 与影子分支，下行实时拉回所有工位", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "autopilot-e2e-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const bare = path.join(tmp, "origin.git");
  const mainRepo = path.join(tmp, "aitoudi");
  const peerRepo = path.join(tmp, "peer");
  mkdirSync(bare);
  mkdirSync(mainRepo);

  git(["init", "--bare", "-b", "main"], bare);
  git(["init", "-b", "main"], mainRepo);
  git(["config", "user.name", "Xiao"], mainRepo);
  git(["config", "user.email", "xiao@example.com"], mainRepo);
  git(["remote", "add", "origin", bare], mainRepo);

  writeFileSync(path.join(mainRepo, "app.mjs"), "export const version = 1;\n", "utf8");
  git(["add", "-A"], mainRepo);
  git(["commit", "-m", "init"], mainRepo);
  git(["push", "-u", "origin", "main"], mainRepo);

  initRepo(mainRepo, { basePort: 9200 });
  git(["add", "-A"], mainRepo);
  git(["commit", "-m", "chore: setup collab-mesh"], mainRepo);
  spawnSync(GIT, ["push", "origin", "main"], { cwd: mainRepo, env: { ...process.env, COLLAB_ALLOW_PROTECTED_PUSH: "1" } });

  // 创建 Codex 副工位
  const spawnRes = spawnSync(process.execPath, [path.join(mainRepo, ".collab/cli.mjs"), "spawn", "--agent", "codex", "--topic", "ui"], {
    cwd: mainRepo, encoding: "utf8", windowsHide: true, env: { ...process.env, COLLAB_ACTOR: "xiao" },
  });
  assert.equal(spawnRes.status, 0, spawnRes.stderr);
  const codexSeat = JSON.parse(spawnRes.stdout).seat.worktree;
  git(["config", "user.name", "Codex"], codexSeat);
  git(["config", "user.email", "codex@example.com"], codexSeat);

  // 1. Codex 在副工位修改文件并满足静默窗口 → 自动提交并推送到远端分支
  writeFileSync(path.join(codexSeat, "feature.mjs"), "export const feature = 'ready';\n", "utf8");
  const oldTime = new Date(Date.now() - 60000);
  utimesSync(path.join(codexSeat, "feature.mjs"), oldTime, oldTime);

  const shippedSeat = shipSeatWorktree(codexSeat, {
    actor: "xiao",
    branch: "work/xiao/codex/ui",
    protectedBranch: "main",
    baseRef: "origin/main",
    quietReady: true,
  });
  assert.equal(shippedSeat.ok, true);
  const remoteBranches = git(["branch", "--list"], bare);
  assert.match(remoteBranches, /work\/xiao\/codex\/ui/);

  // 2. 主工位不小心直接改了文件 → 不切换 main 分支，自动以影子分支推到远端
  writeFileSync(path.join(mainRepo, "note.txt"), "edited on main worktree\n", "utf8");
  const shadow = shipMainWorktreeShadow(mainRepo, {
    actor: "xiao",
    protectedBranch: "main",
    baseRef: "origin/main",
  });
  assert.equal(shadow.ok, true);
  assert.equal(git(["branch", "--show-current"], mainRepo), "main");

  // 回归：同一份内容不得重复强推（否则反复取消 CI）
  const again = shipMainWorktreeShadow(mainRepo, {
    actor: "xiao",
    protectedBranch: "main",
    baseRef: "origin/main",
    activeBranch: shadow.branch,
    lastShippedTreeSha: shadow.treeSha,
  });
  assert.equal(again.skipped, "already-shipped");

  // 3. 模拟另一位协作者（如 Yong 的 Claude Code）在远端合入了新功能到 main
  git(["clone", bare, peerRepo], tmp);
  git(["config", "user.name", "Yong"], peerRepo);
  git(["config", "user.email", "yong@example.com"], peerRepo);
  writeFileSync(path.join(peerRepo, "yong-module.mjs"), "export const fromYong = true;\n", "utf8");
  git(["add", "-A"], peerRepo);
  git(["commit", "-m", "feat: add yong module"], peerRepo);
  git(["push", "origin", "main"], peerRepo);

  // 清理主工位未提交临时文件后执行下行拉取 → 主工位与副工位双双自动同步拿到 yong-module.mjs！
  rmSync(path.join(mainRepo, "note.txt"));
  const pulled = pullAllWorktrees(mainRepo, "main", new Map());
  assert.equal(pulled.ok, true);
  assert.equal(existsSync(path.join(mainRepo, "yong-module.mjs")), true, "主工位应实时获得远端新模块");
  assert.equal(existsSync(path.join(codexSeat, "yong-module.mjs")), true, "Codex 副工位应自动变基获得远端新模块");
  assert.equal(existsSync(path.join(codexSeat, "feature.mjs")), true, "Codex 副工位原有工作保持完好");
});
