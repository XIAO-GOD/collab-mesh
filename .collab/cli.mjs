#!/usr/bin/env node
/**
 * Collab-Mesh Runtime CLI (.collab/cli.mjs)
 * 零外部依赖，跨平台支持 Windows / macOS / Linux，供任意人类开发者与任意异构 Agent 统一调用。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, chmodSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findBinary(name, extraCandidates = []) {
  const probeCmd = process.platform === "win32" ? "where.exe" : "which";
  const found = spawnSync(probeCmd, [name], { encoding: "utf8", windowsHide: true });
  if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split(/\r?\n/)[0].trim();
  for (const candidate of extraCandidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return name;
}

const HOME = os.homedir();
const GIT_BIN = findBinary("git", [
  path.join(HOME, ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe"),
  "C:/Program Files/Git/cmd/git.exe",
]);
const GH_BIN = findBinary("gh", [
  path.join(HOME, ".local/gh/bin/gh.exe"),
  "C:/Program Files/GitHub CLI/gh.exe",
]);

function run(bin, args, { cwd = process.cwd(), allowFail = false, input } = {}) {
  const res = spawnSync(bin, args, { cwd, encoding: "utf8", windowsHide: true, input });
  if (!allowFail && res.status !== 0) {
    const detail = (res.stderr || res.stdout || `exit ${res.status}`).trim();
    throw new Error(`命令执行失败 [${path.basename(bin)} ${args.join(" ")}]: ${detail}`);
  }
  return { status: res.status ?? 1, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

const git = (args, opts) => run(GIT_BIN, args, opts);
const gh = (args, opts) => run(GH_BIN, args, opts);

function repoRoot(cwd = process.cwd()) {
  return git(["rev-parse", "--show-toplevel"], { cwd }).stdout;
}

function gitCommonDir(root) {
  const raw = git(["rev-parse", "--git-common-dir"], { cwd: root }).stdout;
  return path.resolve(root, raw);
}

function loadConfig(root) {
  const defaults = {
    protectedBranch: "main",
    basePort: 8790,
    maxFileSizeMb: 15,
    secretFiles: [".dev.vars", "site/.dev.vars", ".env.local", "site/.env.local"],
    requiredChecks: ["Collab Gate"],
    localTestCommand: "",
    gateTestCommand: "",
  };
  const cfgPath = path.join(root, ".collab/config.json");
  if (!existsSync(cfgPath)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(cfgPath, "utf8")) };
  } catch {
    return defaults;
  }
}

function slugify(value, fallback = "item") {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

function resolveActor(root) {
  if (process.env.COLLAB_ACTOR) return slugify(process.env.COLLAB_ACTOR, "dev");
  const ghUser = gh(["api", "user", "--jq", ".login"], { cwd: root, allowFail: true });
  if (ghUser.status === 0 && ghUser.stdout) return slugify(ghUser.stdout, "dev");
  const gitUser = git(["config", "user.name"], { cwd: root, allowFail: true });
  if (gitUser.status === 0 && gitUser.stdout) return slugify(gitUser.stdout, "dev");
  return slugify(os.userInfo().username, "dev");
}

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq > 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[token.slice(2)] = argv[++i];
      } else {
        flags[token.slice(2)] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function globToRegExp(glob) {
  const normalized = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  let pattern = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*" && normalized[i + 1] === "*") {
      pattern += ".*";
      i++;
    } else if (ch === "*") {
      pattern += "[^/]*";
    } else if (ch === "?") {
      pattern += "[^/]";
    } else if ("+.^$|()[]{}".includes(ch)) {
      pattern += "\\" + ch;
    } else {
      pattern += ch;
    }
  }
  pattern += "$";
  return new RegExp(pattern);
}

function matchesAnyGlob(filePath, globs) {
  const clean = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return globs.some((g) => {
    const trimmed = g.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!trimmed) return false;
    if (trimmed === "*") return true;
    if (globToRegExp(trimmed).test(clean)) return true;
    if (!trimmed.includes("*") && (clean === trimmed || clean.startsWith(trimmed.replace(/\/$/, "") + "/"))) return true;
    return false;
  });
}

function globsOverlap(globsA, globsB, concreteFilesB = []) {
  if (concreteFilesB.some((f) => matchesAnyGlob(f, globsA))) return true;
  for (const a of globsA) {
    const baseA = a.split("*")[0].replace(/\/$/, "");
    for (const b of globsB) {
      if (a === "*" || b === "*") return true;
      const baseB = b.split("*")[0].replace(/\/$/, "");
      if (!baseA || !baseB || baseA.startsWith(baseB) || baseB.startsWith(baseA)) return true;
    }
  }
  return false;
}

export function installHooks(root) {
  const cfg = loadConfig(root);
  const common = gitCommonDir(root);
  const hooksDir = path.join(common, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "pre-push");
  const script = `#!/bin/sh
# Collab-Mesh pre-push gate: 禁止任何人与任何 Agent 直接向受保护分支 (${cfg.protectedBranch}) 推送代码
if [ "\${COLLAB_ALLOW_PROTECTED_PUSH:-0}" = "1" ]; then
  exit 0
fi
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/heads/${cfg.protectedBranch}" ]; then
    echo "❌ [Collab-Mesh 拦截] 禁止直接推送至受保护主分支 '${cfg.protectedBranch}'！" >&2
    echo "👉 请切出工作分支并通过 PR 自动合入：node .collab/cli.mjs start --topic <名称> && node .collab/cli.mjs ship" >&2
    exit 1
  fi
done
exit 0
`;
  writeFileSync(hookPath, script, { encoding: "utf8" });
  try { chmodSync(hookPath, 0o755); } catch {}
  return hookPath;
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function allocatePort(commonDir, basePort) {
  const registryPath = path.join(commonDir, "collab-seats.json");
  let seats = [];
  if (existsSync(registryPath)) {
    try { seats = JSON.parse(readFileSync(registryPath, "utf8")); } catch { seats = []; }
  }
  const used = new Set(seats.map((s) => s.port));
  for (let p = basePort + 1; p <= basePort + 120; p++) {
    if (!used.has(p) && await isPortFree(p)) return p;
  }
  return basePort + 1;
}

function hasOrigin(root) {
  return git(["remote"], { cwd: root, allowFail: true }).stdout.split(/\r?\n/).includes("origin");
}

function parseWorktrees(root) {
  const out = git(["worktree", "list", "--porcelain"], { cwd: root }).stdout;
  const list = [];
  let current = {};
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.worktree) list.push(current);
      current = {};
      continue;
    }
    const [key, ...rest] = line.split(" ");
    current[key] = rest.join(" ");
  }
  if (current.worktree) list.push(current);
  return list;
}

function cmdStatus(root) {
  const cfg = loadConfig(root);
  const actor = resolveActor(root);
  const branch = git(["branch", "--show-current"], { cwd: root }).stdout || "(detached)";
  const common = gitCommonDir(root);
  const hookInstalled = existsSync(path.join(common, "hooks/pre-push"));
  let syncInfo = "无 origin 远端";
  if (hasOrigin(root)) {
    git(["fetch", "origin", "--prune"], { cwd: root, allowFail: true });
    const counts = git(["rev-list", "--left-right", "--count", `HEAD...origin/${cfg.protectedBranch}`], { cwd: root, allowFail: true });
    if (counts.status === 0) {
      const [ahead, behind] = counts.stdout.split(/\s+/).map(Number);
      syncInfo = `领先 origin/${cfg.protectedBranch} ${ahead} 个提交，落后 ${behind} 个提交`;
    }
  }
  const seatFile = path.join(root, ".collab-seat.json");
  const seat = existsSync(seatFile) ? JSON.parse(readFileSync(seatFile, "utf8")) : null;
  const worktrees = parseWorktrees(root);
  console.log(JSON.stringify({
    actor,
    branch,
    root,
    protectedBranch: cfg.protectedBranch,
    prePushHook: hookInstalled,
    sync: syncInfo,
    seat,
    activeWorktrees: worktrees.length,
    worktrees,
  }, null, 2));
}

function scanRadar(root, targetPaths = []) {
  const cfg = loadConfig(root);
  if (hasOrigin(root)) git(["fetch", "origin", "--prune"], { cwd: root, allowFail: true });
  const currentBranch = git(["branch", "--show-current"], { cwd: root }).stdout;
  const prsRes = gh([
    "pr", "list", "--state", "open", "--limit", "50",
    "--json", "number,title,author,headRefName,isDraft,body,files,updatedAt",
  ], { cwd: root, allowFail: true });
  if (prsRes.status !== 0 || !prsRes.stdout) {
    return { online: false, openPrs: [], overlaps: [] };
  }
  const openPrs = JSON.parse(prsRes.stdout);
  const overlaps = [];
  for (const pr of openPrs) {
    if (pr.headRefName === currentBranch) continue;
    const scopeMatch = /<!--\s*collab-scope:\s*([^>]+?)-->/i.exec(pr.body || "");
    const agentMatch = /<!--\s*collab-agent:\s*([^>]+?)-->/i.exec(pr.body || "");
    const declaredGlobs = scopeMatch ? scopeMatch[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
    const changedFiles = (pr.files || []).map((f) => f.path);
    const conflict = targetPaths.length > 0 && globsOverlap(targetPaths, declaredGlobs.filter((g) => g !== "*"), changedFiles);
    if (conflict) {
      overlaps.push({
        number: pr.number,
        title: pr.title,
        author: pr.author?.login || "unknown",
        agent: agentMatch ? agentMatch[1].trim() : "unknown",
        branch: pr.headRefName,
        isDraft: pr.isDraft,
        declaredGlobs,
        changedFiles,
      });
    }
  }
  return { online: true, protectedBranch: cfg.protectedBranch, openPrs, overlaps };
}

function cmdRadar(root, flags) {
  const paths = flags.paths ? String(flags.paths).split(",").map((s) => s.trim()).filter(Boolean) : [];
  const report = scanRadar(root, paths);
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`📡 [Collab Radar] 当前远端活跃 PR 数：${report.openPrs.length}`);
  for (const pr of report.openPrs) {
    console.log(`  - #${pr.number} [${pr.isDraft ? "Draft 信标" : "Ready"}] @${pr.author?.login} (${pr.headRefName}): ${pr.title}`);
  }
  if (report.overlaps.length > 0) {
    console.log(`\n⚠️ 检测到 ${report.overlaps.length} 个潜在文件范围重叠：`);
    for (const item of report.overlaps) {
      console.log(`  ! PR #${item.number} (@${item.author} · ${item.agent}) 分支 ${item.branch} 正在修改重叠范围`);
    }
  } else if (paths.length > 0) {
    console.log("✅ 目标路径与当前所有活跃 PR 零冲突，可安全动工。");
  }
}

async function cmdSpawn(root, flags) {
  installHooks(root);
  const cfg = loadConfig(root);
  const actor = resolveActor(root);
  const agent = slugify(flags.agent || "codex", "agent");
  const topic = slugify(flags.topic || "workspace", "workspace");
  if (hasOrigin(root)) git(["fetch", "origin", "--prune"], { cwd: root, allowFail: true });
  const baseRef = flags.base || (hasOrigin(root) ? `origin/${cfg.protectedBranch}` : cfg.protectedBranch);
  const branch = `work/${actor}/${agent}/${topic}`;
  const common = gitCommonDir(root);
  const mainWorktree = parseWorktrees(root)[0]?.worktree || root;
  const repoName = path.basename(mainWorktree);
  const targetDir = flags.dir
    ? path.resolve(flags.dir)
    : path.resolve(mainWorktree, "..", `${repoName}-seats`, `${agent}-${topic}`);
  const port = flags.port ? Number(flags.port) : await allocatePort(common, cfg.basePort);

  mkdirSync(path.dirname(targetDir), { recursive: true });
  git(["worktree", "add", "-B", branch, targetDir, baseRef], { cwd: root });

  // 安全同步本地私有开发环境变量（如 .dev.vars），保持被 .gitignore 忽略
  const copiedSecrets = [];
  for (const rel of cfg.secretFiles) {
    const src = path.join(mainWorktree, rel);
    const dst = path.join(targetDir, rel);
    if (existsSync(src) && !existsSync(dst)) {
      mkdirSync(path.dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      copiedSecrets.push(rel);
    }
  }

  const seatMeta = {
    actor,
    agent,
    topic,
    branch,
    port,
    worktree: targetDir,
    mainRepo: mainWorktree,
    copiedSecrets,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path.join(targetDir, ".collab-seat.json"), JSON.stringify(seatMeta, null, 2) + "\n", "utf8");

  const registryPath = path.join(common, "collab-seats.json");
  let seats = [];
  if (existsSync(registryPath)) {
    try { seats = JSON.parse(readFileSync(registryPath, "utf8")); } catch { seats = []; }
  }
  seats = seats.filter((s) => s.worktree !== targetDir);
  seats.push(seatMeta);
  writeFileSync(registryPath, JSON.stringify(seats, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({ ok: true, seat: seatMeta }, null, 2));
}

function cmdStart(root, flags) {
  installHooks(root);
  const cfg = loadConfig(root);
  const actor = resolveActor(root);
  const agent = slugify(flags.agent || "agent", "agent");
  const topic = slugify(flags.topic || "task", "task");
  const scopes = flags.paths ? String(flags.paths).split(",").map((s) => s.trim()).filter(Boolean) : ["*"];
  const radar = scanRadar(root, scopes);
  if (radar.overlaps.length > 0 && !flags.force) {
    console.warn(`⚠️ 雷达预警：发现 ${radar.overlaps.length} 个重叠 PR，请协调或传 --force 继续：`, JSON.stringify(radar.overlaps, null, 2));
  }
  let branch = git(["branch", "--show-current"], { cwd: root }).stdout;
  if (!branch || branch === cfg.protectedBranch) {
    branch = `work/${actor}/${agent}/${topic}`;
    const base = hasOrigin(root) ? `origin/${cfg.protectedBranch}` : cfg.protectedBranch;
    git(["checkout", "-B", branch, base], { cwd: root });
  }
  if (!flags["no-remote"] && hasOrigin(root)) {
    const ahead = Number(git(["rev-list", "--count", `origin/${cfg.protectedBranch}..HEAD`], { cwd: root, allowFail: true }).stdout || "0");
    if (ahead === 0) {
      git(["commit", "--allow-empty", "-m", `chore(beacon): 认领开发范围 ${topic} [${agent}]`], { cwd: root });
    }
    git(["push", "-u", "origin", branch], { cwd: root });
    const existing = gh(["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"], { cwd: root, allowFail: true });
    const prs = existing.status === 0 && existing.stdout ? JSON.parse(existing.stdout) : [];
    if (prs.length === 0) {
      const body = [
        `## 施工信标（Draft PR）`,
        `- **操作者**：\`${actor}\``,
        `- **智能体**：\`${agent}\``,
        `- **拟修改范围**：\`${scopes.join(", ")}\``,
        ``,
        `<!-- collab-scope: ${scopes.join(", ")} -->`,
        `<!-- collab-agent: ${agent} -->`,
      ].join("\n");
      gh(["pr", "create", "--draft", "--base", cfg.protectedBranch, "--head", branch, "--title", `wip(${topic}): ${actor}/${agent} 施工中`, "--body", body], { cwd: root, allowFail: true });
    }
  }
  console.log(JSON.stringify({ ok: true, actor, agent, branch, scopes }, null, 2));
}

function cmdSync(root) {
  installHooks(root);
  const cfg = loadConfig(root);
  if (!hasOrigin(root)) throw new Error("当前仓库未配置 origin 远端。");
  const dirty = git(["status", "--porcelain"], { cwd: root }).stdout.length > 0;
  if (dirty) git(["stash", "push", "-u", "-m", "collab-mesh-auto-sync"], { cwd: root });
  try {
    git(["fetch", "origin", "--prune"], { cwd: root });
    const branch = git(["branch", "--show-current"], { cwd: root }).stdout;
    if (branch === cfg.protectedBranch) {
      git(["merge", "--ff-only", `origin/${cfg.protectedBranch}`], { cwd: root });
    } else {
      git(["rebase", `origin/${cfg.protectedBranch}`], { cwd: root });
    }
  } finally {
    if (dirty) git(["stash", "pop"], { cwd: root, allowFail: true });
  }
  console.log(`✅ 已同步至最新 origin/${cfg.protectedBranch}`);
}

function cmdDecision(root, positional, flags) {
  const title = positional[0] || flags.title;
  if (!title) throw new Error("用法：node .collab/cli.mjs decision \"决策标题\" --summary \"决策内容\"");
  const summary = flags.summary || "详见提交说明。";
  const actor = resolveActor(root);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const slug = slugify(title, "decision");
  const dir = path.join(root, "docs/decisions");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${stamp}-${slug}.md`);
  const content = `# ${title}\n\n- **时间**：${new Date().toISOString()}\n- **记录者**：\`${actor}\`\n- **状态**：已生效\n\n## 决策摘要\n${summary}\n`;
  writeFileSync(filePath, content, "utf8");
  console.log(JSON.stringify({ ok: true, file: path.relative(root, filePath).replace(/\\/g, "/") }, null, 2));
}

export function auditPr(root, baseRef) {
  const cfg = loadConfig(root);
  const errors = [];
  const requiredFiles = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursor/rules/00-collab.mdc", ".collab/PROTOCOL.md"];
  for (const rel of requiredFiles) {
    if (!existsSync(path.join(root, rel))) errors.push(`缺少统一引导环文件：${rel}`);
  }
  const tracked = git(["ls-files"], { cwd: root }).stdout.split(/\r?\n/).filter(Boolean);
  for (const file of tracked) {
    const base = path.basename(file);
    if (base === ".dev.vars" || base === ".env.local" || base === ".collab-seat.json") {
      errors.push(`禁止跟踪敏感或本机工位文件：${file}`);
    }
  }
  const base = baseRef || (hasOrigin(root) ? `origin/${cfg.protectedBranch}` : "HEAD~1");
  const baseCheck = git(["rev-parse", "--verify", base], { cwd: root, allowFail: true });
  const diffArgs = baseCheck.status === 0 ? ["diff", "--unified=0", `${base}...HEAD`] : ["diff", "--unified=0", "HEAD"];
  const diffText = git(diffArgs, { cwd: root, allowFail: true }).stdout;
  const secretRegex = /\b(sk-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{24,}|gho_[A-Za-z0-9]{24,}|AKIA[0-9A-Z]{16})\b/;
  for (const line of diffText.split(/\r?\n/)) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (/fixture|synthetic|example|placeholder|test-only/i.test(line)) continue;
    const match = secretRegex.exec(line);
    if (match) errors.push(`新增代码疑似硬编码真实密钥：${match[1].slice(0, 8)}***`);
  }
  if (baseCheck.status === 0) {
    const changed = git(["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`], { cwd: root, allowFail: true })
      .stdout.split(/\r?\n/).filter(Boolean);
    for (const rel of changed) {
      const full = path.join(root, rel);
      if (existsSync(full) && statSync(full).isFile()) {
        const mb = statSync(full).size / (1024 * 1024);
        if (mb > cfg.maxFileSizeMb) {
          errors.push(`新增或修改文件超过 ${cfg.maxFileSizeMb} MB 上限：${rel} (${mb.toFixed(2)} MB)`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function cmdAuditPr(root, flags) {
  const report = auditPr(root, flags.base);
  if (!report.ok) {
    console.error("❌ [Collab Gate] 安全与规范检查未通过：");
    for (const err of report.errors) console.error(`  - ${err}`);
    process.exit(1);
  }
  console.log("✅ [Collab Gate] 密钥扫描、体积预算与统一引导环校验全部通过。");
}

function runShellCommand(command, cwd) {
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell.exe" : "/bin/sh";
  const args = isWin ? ["-NoProfile", "-Command", command] : ["-lc", command];
  const res = spawnSync(shell, args, { cwd, stdio: "inherit", windowsHide: true });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function cmdRunGateTests(root) {
  const cfg = loadConfig(root);
  if (!cfg.gateTestCommand) {
    console.log("ℹ️ 未配置独立 gateTestCommand（由仓库主 CI 工作流承担测试门禁）。");
    return;
  }
  console.log(`🧪 执行门禁测试：${cfg.gateTestCommand}`);
  runShellCommand(cfg.gateTestCommand, root);
}

function cmdShip(root, flags) {
  installHooks(root);
  const cfg = loadConfig(root);
  const branch = git(["branch", "--show-current"], { cwd: root }).stdout;
  if (!branch || branch === cfg.protectedBranch) {
    throw new Error(`当前位于 '${branch || "detached"}'，禁止在主分支直接交付。请先运行 node .collab/cli.mjs start --topic <名称>`);
  }
  const dirty = git(["status", "--porcelain"], { cwd: root }).stdout.trim();
  if (dirty) {
    const title = flags.title || `feat: update on ${branch}`;
    git(["add", "-A"], { cwd: root });
    git(["commit", "-m", title], { cwd: root });
  }
  const audit = auditPr(root, hasOrigin(root) ? `origin/${cfg.protectedBranch}` : undefined);
  if (!audit.ok) {
    throw new Error(`本地安全门禁未通过：\n${audit.errors.join("\n")}`);
  }
  if (!flags["skip-tests"] && cfg.localTestCommand) {
    console.log(`🧪 推送前执行本地测试：${cfg.localTestCommand}`);
    runShellCommand(cfg.localTestCommand, root);
  }
  git(["push", "-u", "origin", branch], { cwd: root });

  const actor = resolveActor(root);
  const prTitle = flags.title || git(["log", "-1", "--pretty=%s"], { cwd: root }).stdout;
  const prBody = flags.body || [
    `## 自动化交付摘要`,
    `- **提交分支**：\`${branch}\``,
    `- **操作者**：\`${actor}\``,
    ``,
    `<!-- collab-scope: ${flags.paths || "*"} -->`,
    `<!-- collab-agent: ${flags.agent || "auto"} -->`,
  ].join("\n");

  const listRes = gh(["pr", "list", "--head", branch, "--state", "open", "--json", "number,isDraft,url"], { cwd: root });
  const existing = JSON.parse(listRes.stdout || "[]");
  let prNumber, prUrl;
  if (existing.length > 0) {
    prNumber = String(existing[0].number);
    prUrl = existing[0].url;
    if (existing[0].isDraft) gh(["pr", "ready", prNumber], { cwd: root, allowFail: true });
    if (flags.title) gh(["pr", "edit", prNumber, "--title", prTitle], { cwd: root, allowFail: true });
  } else {
    const created = gh(["pr", "create", "--base", cfg.protectedBranch, "--head", branch, "--title", prTitle, "--body", prBody], { cwd: root });
    prUrl = created.stdout.split(/\r?\n/).pop().trim();
    const view = gh(["pr", "view", branch, "--json", "number,url"], { cwd: root });
    const parsed = JSON.parse(view.stdout);
    prNumber = String(parsed.number);
    prUrl = parsed.url;
  }

  const autoRes = gh(["pr", "merge", prNumber, "--squash", "--auto", "--delete-branch"], { cwd: root, allowFail: true });
  const autoMode = autoRes.status === 0 ? "native-github-automerge" : "workflow-gate-automerge";
  console.log(JSON.stringify({ ok: true, branch, prNumber: Number(prNumber), prUrl, autoMergeMode: autoMode }, null, 2));
}

function cmdCiAutomerge(root, flags) {
  const cfg = loadConfig(root);
  const repo = flags.repo || process.env.REPO;
  const sha = flags.sha || process.env.HEAD_SHA;
  if (!repo || !sha) throw new Error("缺少 --repo 或 --sha 参数");

  const prsRes = gh([
    "pr", "list", "--repo", repo, "--state", "open", "--base", cfg.protectedBranch,
    "--json", "number,headRefOid,isDraft,mergeStateStatus,title",
  ], { cwd: root });
  const prs = JSON.parse(prsRes.stdout || "[]").filter((p) => p.headRefOid === sha && !p.isDraft);
  if (prs.length === 0) {
    console.log(`ℹ️ SHA ${sha.slice(0, 7)} 无对应的非 Draft 待合并 PR。`);
    return;
  }

  const checksRes = gh(["api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`], { cwd: root });
  const checkRuns = (JSON.parse(checksRes.stdout).check_runs || [])
    .filter((c) => c.name !== "Auto-Merge When All Checks Green");

  const pending = checkRuns.filter((c) => c.status !== "completed");
  if (pending.length > 0) {
    console.log(`⏳ 仍有 ${pending.length} 个检查运行中（${pending.map((c) => c.name).join(", ")}），等待全部完成后再自动合并。`);
    return;
  }

  const failed = checkRuns.filter((c) => !["success", "skipped", "neutral"].includes(c.conclusion));
  if (failed.length > 0) {
    console.log(`❌ 存在未通过的 CI 检查（${failed.map((c) => `${c.name}:${c.conclusion}`).join(", ")}），拒绝自动合并。`);
    return;
  }

  const presentNames = new Set(checkRuns.map((c) => c.name));
  const missingRequired = (cfg.requiredChecks || []).filter((req) => !presentNames.has(req));
  if (missingRequired.length > 0) {
    console.log(`⏳ 必选检查尚未全部出结果（缺少：${missingRequired.join(", ")}），暂不合并。`);
    return;
  }

  for (const pr of prs) {
    console.log(`🚀 全部必选检查（${[...presentNames].join(", ")}）均已通过，正在自动 Squash 合入 PR #${pr.number}...`);
    const merged = gh(["pr", "merge", String(pr.number), "--repo", repo, "--squash", "--delete-branch"], { cwd: root, allowFail: true });
    if (merged.status === 0) {
      console.log(`✅ PR #${pr.number} 已自动合入 ${cfg.protectedBranch} 并删除源分支。`);
    } else {
      console.log(`ℹ️ PR #${pr.number} 暂未合入：${merged.stderr || merged.stdout}`);
    }
  }
}

function cmdProtect(root, flags) {
  const cfg = loadConfig(root);
  const remoteUrl = git(["remote", "get-url", "origin"], { cwd: root }).stdout;
  const m = /github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/i.exec(remoteUrl);
  if (!m) throw new Error(`无法从 origin 解析 GitHub 仓库名：${remoteUrl}`);
  const repo = m[1];
  const checks = flags.checks
    ? String(flags.checks).split(",").map((s) => s.trim()).filter(Boolean)
    : cfg.requiredChecks;

  const repoPatch = gh([
    "api", "-X", "PATCH", `repos/${repo}`,
    "-F", "allow_auto_merge=true",
    "-F", "allow_squash_merge=true",
    "-F", "delete_branch_on_merge=true",
  ], { cwd: root, allowFail: true });

  const protectionPayload = JSON.stringify({
    required_status_checks: { strict: true, contexts: checks },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      required_approving_review_count: 0,
    },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: false,
  });

  const branchRes = gh([
    "api", "-X", "PUT", `repos/${repo}/branches/${cfg.protectedBranch}/protection`,
    "-H", "Accept: application/vnd.github+json",
    "--input", "-",
  ], { cwd: root, allowFail: true, input: protectionPayload });

  console.log(JSON.stringify({
    repo,
    protectedBranch: cfg.protectedBranch,
    requiredChecks: checks,
    repoAutoMergeEnabled: repoPatch.status === 0,
    branchProtectionApplied: branchRes.status === 0,
    note: branchRes.status === 0
      ? "远端强分支保护（含限制管理员直推 + 0人工审批 + 必过CI + 自动合并）已生效！"
      : `远端 API 返回提示（可能当前账号非仓库 Owner，或 GitHub Free 私有仓限制原生分支保护）：${branchRes.stderr || repoPatch.stderr}。本机 pre-push 拦截钩子与 GitHub Actions 自动合并门禁已兜底生效；仓库 Owner 随时执行 'node .collab/cli.mjs protect' 即可开启远端硬件级锁。`,
  }, null, 2));
}

function cmdCleanup(root) {
  const cfg = loadConfig(root);
  if (hasOrigin(root)) git(["fetch", "origin", "--prune"], { cwd: root, allowFail: true });
  git(["worktree", "prune"], { cwd: root, allowFail: true });
  const merged = git(["branch", "--merged", hasOrigin(root) ? `origin/${cfg.protectedBranch}` : cfg.protectedBranch], { cwd: root, allowFail: true })
    .stdout.split(/\r?\n/).map((b) => b.replace(/^[*+]\s*/, "").trim()).filter((b) => b.startsWith("work/"));
  const worktrees = parseWorktrees(root);
  const removed = [];
  for (const wt of worktrees) {
    const branchName = (wt.branch || "").replace("refs/heads/", "");
    if (merged.includes(branchName) && path.resolve(wt.worktree) !== path.resolve(root)) {
      git(["worktree", "remove", "--force", wt.worktree], { cwd: root, allowFail: true });
      removed.push(wt.worktree);
    }
  }
  for (const br of merged) {
    git(["branch", "-d", br], { cwd: root, allowFail: true });
  }
  console.log(JSON.stringify({ ok: true, removedWorktrees: removed, deletedBranches: merged }, null, 2));
}

async function main() {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const command = positional[0] || "status";
  const root = repoRoot();

  switch (command) {
    case "status":
    case "doctor":
      cmdStatus(root);
      break;
    case "hooks":
      console.log(JSON.stringify({ ok: true, hook: installHooks(root) }, null, 2));
      break;
    case "radar":
      cmdRadar(root, flags);
      break;
    case "spawn":
      await cmdSpawn(root, flags);
      break;
    case "start":
      cmdStart(root, flags);
      break;
    case "sync":
      cmdSync(root);
      break;
    case "decision":
      cmdDecision(root, positional.slice(1), flags);
      break;
    case "audit-pr":
      cmdAuditPr(root, flags);
      break;
    case "run-gate-tests":
      cmdRunGateTests(root);
      break;
    case "ship":
      cmdShip(root, flags);
      break;
    case "ci-automerge":
      cmdCiAutomerge(root, flags);
      break;
    case "protect":
      cmdProtect(root, flags);
      break;
    case "cleanup":
      cmdCleanup(root);
      break;
    default:
      throw new Error(`未知命令：${command}。支持命令：status | hooks | radar | spawn | start | sync | decision | audit-pr | ship | protect | cleanup`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
