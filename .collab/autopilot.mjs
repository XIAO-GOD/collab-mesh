/**
 * Collab-Mesh Autopilot Daemon (.collab/autopilot.mjs)
 * 双向无感自动同步守护引擎：
 *   1. 上行（Outbound）：检测所有工位停笔静默满 quietSeconds → 语法与密钥预检 → 零直推自动建/更 PR → 等 CI 全绿自动合入 main
 *   2. 下行（Inbound）：每 pullIntervalSeconds 轮询 origin/main → 无冲突实时同步主预览工位与所有活跃 Worktree 副工位
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditPr, installHooks } from "./cli.mjs";

function findBin(name, extras = []) {
  const cmd = process.platform === "win32" ? "where.exe" : "which";
  const r = spawnSync(cmd, [name], { encoding: "utf8", windowsHide: true });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0].trim();
  for (const c of extras) if (c && existsSync(c)) return c;
  return name;
}

const HOME = os.homedir();
const GIT = findBin("git", [
  path.join(HOME, ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe"),
  "C:/Program Files/Git/cmd/git.exe",
]);
const GH = findBin("gh", [
  path.join(HOME, ".local/gh/bin/gh.exe"),
  "C:/Program Files/GitHub CLI/gh.exe",
]);
const PY = findBin("python", [
  path.join(HOME, ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"),
]);

function exec(bin, args, { cwd, env, timeout = 30000 } = {}) {
  const res = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return {
    ok: res.status === 0,
    status: res.status ?? 1,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
  };
}

function listWorktrees(root) {
  const res = exec(GIT, ["worktree", "list", "--porcelain"], { cwd: root });
  if (!res.ok) return [];
  const items = [];
  let cur = {};
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      if (cur.worktree) items.push(cur);
      cur = {};
      continue;
    }
    const [k, ...rest] = line.split(" ");
    cur[k] = rest.join(" ");
  }
  if (cur.worktree) items.push(cur);
  return items;
}

function gitDirOf(wtPath) {
  const r = exec(GIT, ["rev-parse", "--git-dir"], { cwd: wtPath });
  return r.ok ? path.resolve(wtPath, r.stdout) : path.join(wtPath, ".git");
}

function commonGitDir(root) {
  const r = exec(GIT, ["rev-parse", "--git-common-dir"], { cwd: root });
  return r.ok ? path.resolve(root, r.stdout) : path.join(root, ".git");
}

function isProcessAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseDirtyFiles(wtPath) {
  const res = exec(GIT, ["status", "--porcelain", "-uall"], { cwd: wtPath });
  if (!res.ok || !res.stdout) return [];
  return res.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const code = line.slice(0, 2);
    let rel = line.slice(3).trim();
    if (rel.includes(" -> ")) rel = rel.split(" -> ").pop().trim();
    if (rel.startsWith('"') && rel.endsWith('"')) {
      try { rel = JSON.parse(rel); } catch {}
    }
    return { code, rel };
  });
}

export function syntaxPrecheck(wtPath, dirtyFiles) {
  for (const { rel } of dirtyFiles) {
    const full = path.join(wtPath, rel);
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    const ext = path.extname(rel).toLowerCase();
    if (ext === ".js" || ext === ".mjs") {
      const chk = exec(process.execPath, ["--check", full], { cwd: wtPath, timeout: 8000 });
      if (!chk.ok) return { ok: false, reason: `JS 语法未闭合 (${rel}): ${chk.stderr.split("\n")[0]}` };
    } else if (ext === ".json") {
      try {
        JSON.parse(readFileSync(full, "utf8"));
      } catch (e) {
        return { ok: false, reason: `JSON 语法未闭合 (${rel}): ${e.message}` };
      }
    } else if (ext === ".py" && existsSync(PY)) {
      const chk = exec(PY, ["-m", "py_compile", full], { cwd: wtPath, timeout: 8000 });
      if (!chk.ok) return { ok: false, reason: `Python 语法未闭合 (${rel}): ${chk.stderr.split("\n")[0]}` };
    }
  }
  return { ok: true };
}

function resolveActor(root) {
  const ghUser = exec(GH, ["api", "user", "--jq", ".login"], { cwd: root, timeout: 8000 });
  if (ghUser.ok && ghUser.stdout) return ghUser.stdout.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const gitUser = exec(GIT, ["config", "user.name"], { cwd: root });
  if (gitUser.ok && gitUser.stdout) return gitUser.stdout.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "dev";
  return "dev";
}

function summarizeFiles(files) {
  const names = files.slice(0, 3).map((f) => path.basename(f.rel));
  return files.length > 3 ? `${names.join(", ")} 等 ${files.length} 个文件` : names.join(", ");
}

function ensurePrAndAutoMerge(wtPath, branch, protectedBranch, title, actor) {
  const hasOrigin = exec(GIT, ["remote"], { cwd: wtPath }).stdout.split(/\r?\n/).includes("origin");
  if (!hasOrigin) return { pushed: false };
  const remoteUrl = exec(GIT, ["remote", "get-url", "origin"], { cwd: wtPath }).stdout;
  if (!/github\.com/i.test(remoteUrl)) return { pushed: true, prUrl: null };

  const listRes = exec(GH, ["pr", "list", "--head", branch, "--state", "open", "--json", "number,isDraft,url"], { cwd: wtPath, timeout: 15000 });
  if (!listRes.ok) return { pushed: true, prError: listRes.stderr };

  const prs = JSON.parse(listRes.stdout || "[]");
  let prNumber, prUrl;
  if (prs.length > 0) {
    prNumber = String(prs[0].number);
    prUrl = prs[0].url;
    if (prs[0].isDraft) exec(GH, ["pr", "ready", prNumber], { cwd: wtPath, timeout: 15000 });
  } else {
    const body = [
      `## Collab-Mesh Autopilot 自动同步`,
      `- **来源分支**：\`${branch}\``,
      `- **操作者**：\`${actor}\``,
      `- **说明**：检测到工作区静默完成，经本地语法与密钥门禁预检后自动提交，等待全量 CI 检测通过后自动合入 \`${protectedBranch}\`。`,
      ``,
      `<!-- collab-scope: * -->`,
      `<!-- collab-agent: autopilot -->`,
    ].join("\n");
    const created = exec(GH, ["pr", "create", "--base", protectedBranch, "--head", branch, "--title", title, "--body", body], { cwd: wtPath, timeout: 20000 });
    if (!created.ok) return { pushed: true, prError: created.stderr };
    prUrl = created.stdout.split(/\r?\n/).pop().trim();
    const view = exec(GH, ["pr", "view", branch, "--json", "number,url"], { cwd: wtPath, timeout: 15000 });
    if (view.ok) {
      const v = JSON.parse(view.stdout);
      prNumber = String(v.number);
      prUrl = v.url;
    }
  }

  const repoMatch = /github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/i.exec(remoteUrl);
  if (prNumber && repoMatch) {
    const prot = exec(GH, ["api", `repos/${repoMatch[1]}/branches/${protectedBranch}/protection`], { cwd: wtPath, timeout: 10000 });
    if (prot.ok) {
      exec(GH, ["pr", "merge", prNumber, "--squash", "--auto", "--delete-branch"], { cwd: wtPath, timeout: 15000 });
    }
  }
  return { pushed: true, prNumber: prNumber ? Number(prNumber) : null, prUrl };
}

/**
 * 在不切换主工作区 main 分支、不争抢默认 .git/index 的前提下，把主工作区的修改打包成临时树并推送至远端 autopilot PR 分支。
 */
export function shipMainWorktreeShadow(wtPath, { actor, protectedBranch, activeBranch, baseRef }) {
  const dirty = parseDirtyFiles(wtPath);
  if (dirty.length === 0) return { skipped: "clean" };

  const syn = syntaxPrecheck(wtPath, dirty);
  if (!syn.ok) return { skipped: syn.reason };

  const tmpIndex = path.join(os.tmpdir(), `collab-autopilot-idx-${process.pid}-${Date.now()}`);
  try {
    const readRes = exec(GIT, ["read-tree", baseRef], { cwd: wtPath, env: { GIT_INDEX_FILE: tmpIndex } });
    if (!readRes.ok) return { skipped: `read-tree failed: ${readRes.stderr}` };

    const addRes = exec(GIT, ["add", "-A"], { cwd: wtPath, env: { GIT_INDEX_FILE: tmpIndex } });
    if (!addRes.ok) return { skipped: `git add failed: ${addRes.stderr}` };

    const treeRes = exec(GIT, ["write-tree"], { cwd: wtPath, env: { GIT_INDEX_FILE: tmpIndex } });
    if (!treeRes.ok) return { skipped: `write-tree failed: ${treeRes.stderr}` };
    const treeSha = treeRes.stdout;

    // 校验暂存区不包含敏感文件
    const cachedFiles = exec(GIT, ["ls-files"], { cwd: wtPath, env: { GIT_INDEX_FILE: tmpIndex } }).stdout.split(/\r?\n/);
    if (cachedFiles.some((f) => [".dev.vars", ".env.local", ".collab-seat.json"].includes(path.basename(f)))) {
      return { skipped: "检测到敏感文件试图入库，已拦截" };
    }

    const baseTree = exec(GIT, ["rev-parse", `${baseRef}^{tree}`], { cwd: wtPath }).stdout;
    if (treeSha === baseTree) return { skipped: "matches-base", treeSha };

    const title = `feat(autopilot): 自动同步 ${summarizeFiles(dirty)}`;
    const parentSha = exec(GIT, ["rev-parse", baseRef], { cwd: wtPath }).stdout;
    const commitRes = exec(GIT, ["commit-tree", treeSha, "-p", parentSha, "-m", title], { cwd: wtPath });
    if (!commitRes.ok) return { skipped: `commit-tree failed: ${commitRes.stderr}` };
    const commitSha = commitRes.stdout;

    // 扫描新增行是否含真实密钥
    const diffCheck = exec(GIT, ["diff", "--unified=0", parentSha, commitSha], { cwd: wtPath });
    const secretRegex = /\b(sk-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{24,}|gho_[A-Za-z0-9]{24,}|AKIA[0-9A-Z]{16})\b/;
    for (const line of diffCheck.stdout.split(/\r?\n/)) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      if (/fixture|synthetic|example|placeholder|test-only/i.test(line)) continue;
      if (secretRegex.test(line)) return { skipped: "检测到疑似硬编码 API 密钥，已安全拦截" };
    }

    const branch = activeBranch || `work/${actor}/autopilot/sync-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
    const pushRes = exec(GIT, ["push", "--force-with-lease", "origin", `${commitSha}:refs/heads/${branch}`], { cwd: wtPath, timeout: 30000 });
    if (!pushRes.ok) {
      // 首次推送无远端引用时直接推送
      const firstPush = exec(GIT, ["push", "origin", `${commitSha}:refs/heads/${branch}`], { cwd: wtPath, timeout: 30000 });
      if (!firstPush.ok) return { skipped: `push failed: ${firstPush.stderr}` };
    }

    const prInfo = ensurePrAndAutoMerge(wtPath, branch, protectedBranch, title, actor);
    return { ok: true, mode: "shadow-branch", branch, treeSha, commitSha, ...prInfo };
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

/**
 * 针对 work/* 副工位分支：自动提交静默修改（或推送 Agent 已提交但未推的本地 commit）并确保建好 PR。
 */
export function shipSeatWorktree(wtPath, { actor, branch, protectedBranch, baseRef, quietReady }) {
  const dirty = parseDirtyFiles(wtPath);
  if (dirty.length > 0) {
    if (!quietReady) return { skipped: "waiting-quiet-window" };
    const syn = syntaxPrecheck(wtPath, dirty);
    if (!syn.ok) return { skipped: syn.reason };

    const title = `feat(autopilot): 自动同步 ${summarizeFiles(dirty)}`;
    const addRes = exec(GIT, ["add", "-A"], { cwd: wtPath });
    if (!addRes.ok) return { skipped: addRes.stderr };
    const commitRes = exec(GIT, ["commit", "-m", title], { cwd: wtPath });
    if (!commitRes.ok) return { skipped: commitRes.stderr };
  }

  const aheadRes = exec(GIT, ["rev-list", "--count", `${baseRef}..HEAD`], { cwd: wtPath });
  const ahead = aheadRes.ok ? Number(aheadRes.stdout || "0") : 0;
  if (ahead === 0) return { skipped: "nothing-ahead" };

  // 检查相比远端同名分支是否有未推送提交
  const remoteRef = `origin/${branch}`;
  const hasRemoteBranch = exec(GIT, ["rev-parse", "--verify", remoteRef], { cwd: wtPath }).ok;
  const unpushed = hasRemoteBranch
    ? Number(exec(GIT, ["rev-list", "--count", `${remoteRef}..HEAD`], { cwd: wtPath }).stdout || "0")
    : ahead;

  if (unpushed === 0) return { skipped: "already-pushed" };

  const audit = auditPr(wtPath, baseRef);
  if (!audit.ok) return { skipped: `安全门禁拦截: ${audit.errors.join("; ")}` };

  const pushRes = exec(GIT, ["push", "-u", "origin", branch], { cwd: wtPath, timeout: 30000 });
  if (!pushRes.ok) return { skipped: `push failed: ${pushRes.stderr}` };

  const lastTitle = exec(GIT, ["log", "-1", "--pretty=%s"], { cwd: wtPath }).stdout || `feat: update ${branch}`;
  const prInfo = ensurePrAndAutoMerge(wtPath, branch, protectedBranch, lastTitle, actor);
  return { ok: true, mode: "seat-branch", branch, ...prInfo };
}

/**
 * 下行同步：将远端最新 origin/main 安全同步到主工位与各副工位，绝不破坏未完成手改代码。
 */
export function pullAllWorktrees(root, protectedBranch, wtStates) {
  const events = [];
  const fetchRes = exec(GIT, ["fetch", "origin", "--prune"], { cwd: root, timeout: 25000 });
  if (!fetchRes.ok) return { ok: false, error: `fetch 暂不可用: ${fetchRes.stderr}`, events };

  const baseRef = `origin/${protectedBranch}`;
  const remoteShaRes = exec(GIT, ["rev-parse", baseRef], { cwd: root });
  if (!remoteShaRes.ok) return { ok: false, error: "未找到远端主分支", events };
  const remoteSha = remoteShaRes.stdout;
  const remoteTree = exec(GIT, ["rev-parse", `${baseRef}^{tree}`], { cwd: root }).stdout;

  for (const wt of listWorktrees(root)) {
    const wtPath = wt.worktree;
    const gDir = gitDirOf(wtPath);
    if (existsSync(path.join(gDir, "index.lock"))) continue;

    const branch = (wt.branch || "").replace("refs/heads/", "");
    const headSha = exec(GIT, ["rev-parse", "HEAD"], { cwd: wtPath }).stdout;
    if (headSha === remoteSha && parseDirtyFiles(wtPath).length === 0) continue;

    const countsRes = exec(GIT, ["rev-list", "--left-right", "--count", `HEAD...${baseRef}`], { cwd: wtPath });
    if (!countsRes.ok) continue;
    const [ahead, behind] = countsRes.stdout.split(/\s+/).map(Number);
    if (behind === 0) continue;

    const dirty = parseDirtyFiles(wtPath);
    const st = wtStates.get(wtPath) || {};

    if (branch === protectedBranch) {
      if (dirty.length === 0) {
        const ff = exec(GIT, ["merge", "--ff-only", baseRef], { cwd: wtPath });
        if (ff.ok) events.push(`⬇️ 主工位 (${wtPath}) 已快进同步至最新 ${protectedBranch} (${remoteSha.slice(0, 7)})`);
      } else {
        // 若当前工作区恰好就是刚刚在云端 Squash 合入 main 的那份树，直接无损对齐指针！
        const tmpIdx = path.join(os.tmpdir(), `collab-chk-${process.pid}-${Date.now()}`);
        let curTree = "";
        try {
          if (exec(GIT, ["read-tree", "HEAD"], { cwd: wtPath, env: { GIT_INDEX_FILE: tmpIdx } }).ok &&
              exec(GIT, ["add", "-A"], { cwd: wtPath, env: { GIT_INDEX_FILE: tmpIdx } }).ok) {
            curTree = exec(GIT, ["write-tree"], { cwd: wtPath, env: { GIT_INDEX_FILE: tmpIdx } }).stdout;
          }
        } finally {
          rmSync(tmpIdx, { force: true });
        }
        if (curTree && curTree === remoteTree) {
          exec(GIT, ["reset", "--mixed", baseRef], { cwd: wtPath });
          st.activeShadowBranch = null;
          st.lastShippedTreeSha = remoteTree;
          wtStates.set(wtPath, st);
          events.push(`✅ 主工位本地修改已在云端通过 CI 合入 ${protectedBranch} (${remoteSha.slice(0, 7)})，本地指针已自动归位`);
        } else {
          // 存在其他未提交本地修改时，尝试安全 stash → ff-only → stash pop
          const stashed = exec(GIT, ["stash", "push", "-u", "-m", "autopilot-inbound-sync"], { cwd: wtPath });
          if (stashed.ok) {
            const ff = exec(GIT, ["merge", "--ff-only", baseRef], { cwd: wtPath });
            const popped = exec(GIT, ["stash", "pop"], { cwd: wtPath });
            if (ff.ok && popped.ok) {
              events.push(`⬇️ 主工位保留本地改动并无冲突同步至 ${remoteSha.slice(0, 7)}`);
            } else {
              exec(GIT, [" checkout", "--", "."], { cwd: wtPath });
              events.push(`⚠️ 主工位本地未提交改动与远端同位置冲突，已保留在 git stash 中避免覆盖`);
            }
          }
        }
      }
    } else if (branch.startsWith("work/") && dirty.length === 0) {
      // 副工位干净时：若无独有提交，直接快进跟上最新 origin/main；若有独有提交，看 PR 是否已被 Squash 合并
      if (ahead === 0) {
        if (exec(GIT, ["merge", "--ff-only", baseRef], { cwd: wtPath }).ok) {
          events.push(`⬇️ 副工位 [${branch}] 已同步至最新 ${protectedBranch} (${remoteSha.slice(0, 7)})`);
        }
      } else {
        const prCheck = exec(GH, ["pr", "list", "--head", branch, "--state", "merged", "--limit", "1", "--json", "number"], { cwd: wtPath, timeout: 10000 });
        const mergedPrs = prCheck.ok ? JSON.parse(prCheck.stdout || "[]") : [];
        if (mergedPrs.length > 0) {
          exec(GIT, ["checkout", "-B", branch, baseRef], { cwd: wtPath });
          events.push(`🔄 副工位 [${branch}] 原 PR 已合入主干，分支底座已自动刷新至 ${remoteSha.slice(0, 7)}`);
        } else {
          const rb = exec(GIT, ["rebase", baseRef], { cwd: wtPath });
          if (rb.ok) {
            events.push(`⬇️ 副工位 [${branch}] 已自动无冲突变基至最新 ${protectedBranch}`);
          } else {
            exec(GIT, ["rebase", "--abort"], { cwd: wtPath });
          }
        }
      }
    }
  }
  return { ok: true, remoteSha, events };
}

function measureWorktreeQuiet(wtPath, st, quietMs) {
  const dirty = parseDirtyFiles(wtPath);
  if (dirty.length === 0) {
    st.deletionSeenAt = null;
    return { dirtyCount: 0, quietReady: true, latestMtime: 0 };
  }
  let latest = 0;
  for (const { rel } of dirty) {
    const full = path.join(wtPath, rel);
    if (existsSync(full)) {
      const m = statSync(full).mtimeMs;
      if (m > latest) latest = m;
    } else {
      if (!st.deletionSeenAt) st.deletionSeenAt = Date.now();
      if (st.deletionSeenAt > latest) latest = st.deletionSeenAt;
    }
  }
  return {
    dirtyCount: dirty.length,
    latestMtime: latest,
    quietReady: Date.now() - latest >= quietMs,
  };
}

export async function runAutopilotLoop(root, {
  quietSeconds = 45,
  pullIntervalSeconds = 20,
  protectedBranch = "main",
  once = false,
} = {}) {
  installHooks(root);
  const common = commonGitDir(root);
  const pidFile = path.join(common, "collab-autopilot.pid");
  const statusFile = path.join(common, "collab-autopilot-status.json");
  const logFile = path.join(common, "collab-autopilot.log");

  if (!once && existsSync(pidFile)) {
    const oldPid = Number(readFileSync(pidFile, "utf8").trim());
    if (oldPid !== process.pid && isProcessAlive(oldPid)) {
      console.log(`ℹ️ Autopilot 守护进程已在运行中 (PID ${oldPid})。`);
      return;
    }
  }
  if (!once) writeFileSync(pidFile, String(process.pid), "utf8");

  const actor = resolveActor(root);
  const wtStates = new Map();
  const recentEvents = [];
  let lastPullAt = 0;
  let lastRemoteSha = "";

  function recordEvent(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    recentEvents.push(line);
    if (recentEvents.length > 40) recentEvents.shift();
    try {
      const prev = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
      const trimmed = prev.length > 200000 ? prev.slice(-100000) : prev;
      writeFileSync(logFile, trimmed + line + "\n", "utf8");
    } catch {}
    console.log(line);
  }

  function writeStatus(extra = {}) {
    const payload = {
      running: true,
      pid: process.pid,
      actor,
      root,
      protectedBranch,
      quietSeconds,
      pullIntervalSeconds,
      lastRemoteSha,
      updatedAt: new Date().toISOString(),
      recentEvents: recentEvents.slice(-12),
      ...extra,
    };
    writeFileSync(statusFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }

  const cleanupPid = () => {
    try {
      if (existsSync(pidFile) && Number(readFileSync(pidFile, "utf8").trim()) === process.pid) {
        rmSync(pidFile, { force: true });
      }
      if (existsSync(statusFile)) {
        const cur = JSON.parse(readFileSync(statusFile, "utf8"));
        cur.running = false;
        writeFileSync(statusFile, JSON.stringify(cur, null, 2) + "\n", "utf8");
      }
    } catch {}
  };

  if (!once) {
    process.on("SIGINT", () => { cleanupPid(); process.exit(0); });
    process.on("SIGTERM", () => { cleanupPid(); process.exit(0); });
    recordEvent(`🚀 Collab-Mesh Autopilot 启动 (actor=${actor}, 停笔静默=${quietSeconds}s, 下行拉取=${pullIntervalSeconds}s)`);
  }

  const tickMs = Math.min(5000, Math.max(1000, pullIntervalSeconds * 250));
  while (true) {
    try {
      const now = Date.now();
      // 1. 到点执行下行实时同步
      if (once || now - lastPullAt >= pullIntervalSeconds * 1000) {
        lastPullAt = now;
        const pulled = pullAllWorktrees(root, protectedBranch, wtStates);
        if (pulled.ok) {
          lastRemoteSha = pulled.remoteSha;
          for (const ev of pulled.events) recordEvent(ev);
        }
      }

      // 2. 扫描所有本地工位执行上行自动打包提 PR
      const baseRef = exec(GIT, ["rev-parse", "--verify", `origin/${protectedBranch}`], { cwd: root }).ok
        ? `origin/${protectedBranch}`
        : protectedBranch;

      for (const wt of listWorktrees(root)) {
        const wtPath = wt.worktree;
        const gDir = gitDirOf(wtPath);
        if (existsSync(path.join(gDir, "index.lock"))) continue;

        const branch = (wt.branch || "").replace("refs/heads/", "");
        if (!branch) continue;
        const st = wtStates.get(wtPath) || {};
        const quiet = measureWorktreeQuiet(wtPath, st, quietSeconds * 1000);
        wtStates.set(wtPath, st);

        if (branch === protectedBranch) {
          if (quiet.dirtyCount > 0 && quiet.quietReady) {
            // 计算当前暂存树避免对同一份未变内容重复推送
            const res = shipMainWorktreeShadow(wtPath, {
              actor,
              protectedBranch,
              activeBranch: st.activeShadowBranch,
              baseRef,
            });
            if (res.ok && res.treeSha !== st.lastShippedTreeSha) {
              st.lastShippedTreeSha = res.treeSha;
              st.activeShadowBranch = res.branch;
              wtStates.set(wtPath, st);
              recordEvent(`⬆️ 主工位静默修改已自动推送分支 ${res.branch}${res.prUrl ? ` → ${res.prUrl}` : ""}（等待 CI 全绿合入）`);
            } else if (res.skipped === "matches-base") {
              st.lastShippedTreeSha = res.treeSha;
            }
          }
        } else if (branch.startsWith("work/")) {
          const res = shipSeatWorktree(wtPath, {
            actor,
            branch,
            protectedBranch,
            baseRef,
            quietReady: quiet.quietReady,
          });
          if (res.ok) {
            recordEvent(`⬆️ 副工位 [${branch}] 已自动推送并挂入 CI 合并队列${res.prUrl ? ` → ${res.prUrl}` : ""}`);
          }
        }
      }

      writeStatus();
    } catch (err) {
      recordEvent(`⚠️ Autopilot 巡检异常（已自动恢复）：${err.message}`);
    }

    if (once) break;
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

export function startAutopilotDetached(root, { quietSeconds = 45, pullIntervalSeconds = 20 } = {}) {
  const common = commonGitDir(root);
  const pidFile = path.join(common, "collab-autopilot.pid");
  if (existsSync(pidFile)) {
    const existingPid = Number(readFileSync(pidFile, "utf8").trim());
    if (isProcessAlive(existingPid)) {
      return { ok: true, alreadyRunning: true, pid: existingPid };
    }
  }
  const logOut = openSync(path.join(common, "collab-autopilot.out.log"), "a");
  const cliScript = path.join(root, ".collab/cli.mjs");
  const child = spawn(
    process.execPath,
    [cliScript, "autopilot", "run", "--quiet", String(quietSeconds), "--interval", String(pullIntervalSeconds)],
    {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logOut, logOut],
    }
  );
  child.unref();
  closeSync(logOut);
  writeFileSync(pidFile, String(child.pid), "utf8");
  return { ok: true, alreadyRunning: false, pid: child.pid, quietSeconds, pullIntervalSeconds };
}

export function stopAutopilot(root) {
  const common = commonGitDir(root);
  const pidFile = path.join(common, "collab-autopilot.pid");
  if (!existsSync(pidFile)) return { ok: true, stopped: false, note: "当前无运行中的 Autopilot 守护进程" };
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (isProcessAlive(pid)) {
    try { process.kill(pid); } catch {}
  }
  rmSync(pidFile, { force: true });
  return { ok: true, stopped: true, pid };
}

export function getAutopilotStatus(root) {
  const common = commonGitDir(root);
  const pidFile = path.join(common, "collab-autopilot.pid");
  const statusFile = path.join(common, "collab-autopilot-status.json");
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : null;
  const alive = isProcessAlive(pid);
  const saved = existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, "utf8")) : {};
  return { ...saved, pid: alive ? pid : null, running: alive };
}

export function installAutopilotStartupTask(root, { quietSeconds = 45, pullIntervalSeconds = 20 } = {}) {
  if (process.platform !== "win32") {
    return { ok: false, note: "开机计划任务自动注册当前仅面向 Windows，macOS/Linux 可直接用 autopilot start 常驻后台。" };
  }
  const repoSlug = path.basename(root).replace(/[^A-Za-z0-9_-]/g, "");
  const taskName = `CollabMeshAutopilot-${repoSlug}`;
  const cliPath = path.join(root, ".collab/cli.mjs");
  const actionCmd = `"${process.execPath}" "${cliPath}" autopilot start --quiet ${quietSeconds} --interval ${pullIntervalSeconds}`;
  const res = exec("schtasks.exe", [
    "/Create", "/F",
    "/SC", "ONLOGON",
    "/TN", taskName,
    "/TR", actionCmd,
  ], { cwd: root });
  return { ok: res.ok, taskName, detail: res.stdout || res.stderr };
}
