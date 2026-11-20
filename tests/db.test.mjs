import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initRepo } from "../bin/collab-mesh.mjs";
import {
  assertReadOnlySql,
  auditDatabaseChanges,
  getDatabaseStatus,
  incrementalSyncCloudDb,
  openD1Replica,
  pullCloudReplica,
  queryDatabase,
  resetReplica,
} from "../runtime/db.mjs";

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

const SCHEMA_0001 = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, company TEXT NOT NULL, company_type TEXT,
  title TEXT NOT NULL, category TEXT, department TEXT, cities TEXT NOT NULL DEFAULT '[]',
  recruit_type TEXT NOT NULL DEFAULT 'social', education TEXT, min_years INTEGER,
  experience TEXT, salary TEXT, description TEXT NOT NULL DEFAULT '', requirements TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL, posted_at TEXT, source_updated_at TEXT, deadline TEXT,
  content_hash TEXT NOT NULL, sig TEXT, cluster_key TEXT, first_seen_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL, closed_at TEXT, missing_since TEXT
);
CREATE TABLE IF NOT EXISTS sources (
  source TEXT PRIMARY KEY, company TEXT NOT NULL, adapter TEXT NOT NULL, open_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT, last_ok_at TEXT, last_status TEXT, last_seen INTEGER, last_new INTEGER,
  last_changed INTEGER, last_closed INTEGER, last_deferred INTEGER, last_error TEXT, last_ms INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
  triggered_by TEXT, summary TEXT NOT NULL
);
`;

test("db pull 同步云端数据到本地副本、AI 随意删改后 db reset 一键还原、spawn 新工位自动继承副本", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "collab-db-pull-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const repo = path.join(tmp, "aitoudi");
  mkdirSync(path.join(repo, "site/migrations"), { recursive: true });
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "Tester"], repo);
  git(["config", "user.email", "tester@example.com"], repo);
  writeFileSync(path.join(repo, "site/migrations/0001_jobs.sql"), SCHEMA_0001, "utf8");
  initRepo(repo);
  git(["add", "-A"], repo);
  git(["commit", "-m", "init"], repo);

  const mockFetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/jobdb/stats") {
      return Response.json({
        ok: true,
        total_open: 2,
        sources: [{ source: "bytedance", company: "字节跳动", adapter: "feishu", open_count: 2, last_status: "ok" }],
        last_run: { started_at: "2026-11-20T01:00:00Z", finished_at: "2026-11-20T01:05:00Z", triggered_by: "schedule" },
      });
    }
    if (u.pathname === "/api/jobdb/jobs") {
      return Response.json({
        ok: true,
        jobs: [
          { id: "bytedance:1", source: "bytedance", company: "字节跳动", title: "大模型工程师", cities: ["北京"], recruit_type: "social", url: "https://jobs.bytedance.com/1", first_seen_at: "2026-11-20T00:00:00Z" },
          { id: "bytedance:2", source: "bytedance", company: "字节跳动", title: "强化学习实习生", cities: ["上海"], recruit_type: "intern", url: "https://jobs.bytedance.com/2", first_seen_at: "2026-11-19T00:00:00Z" },
        ],
        next_cursor: null,
      });
    }
    if (u.pathname.startsWith("/api/jobdb/jobs/")) {
      const id = decodeURIComponent(u.pathname.slice("/api/jobdb/jobs/".length));
      return Response.json({ ok: true, job: { id, description: `完整职责 ${id}`, requirements: `完整要求 ${id}` } });
    }
    return new Response("not found", { status: 404 });
  };

  const pulled = await pullCloudReplica(repo, { remoteUrl: "https://aitoudi.com", limit: 10, withDetails: 10, fetcher: mockFetcher });
  assert.equal(pulled.ok, true);
  assert.equal(pulled.syncedJobs, 2);

  const st1 = getDatabaseStatus(repo);
  assert.equal(st1.openJobsInReplica, 2);
  assert.equal(st1.sourcesInReplica, 1);

  // 验证 D1 兼容接口可直接查询完整详情
  const d1 = openD1Replica(pulled.replica, path.join(repo, "site/migrations"));
  const detailRow = await d1.prepare("SELECT description FROM jobs WHERE id = ?1").bind("bytedance:1").first();
  assert.equal(detailRow.description, "完整职责 bytedance:1");
  d1.close();

  // 模拟 AI 在本地副本里误删整表数据
  await queryDatabase(repo, "DELETE FROM jobs");
  assert.equal(getDatabaseStatus(repo).openJobsInReplica, 0);

  // 一键还原（无需联网，直接从本机种子缓存恢复）
  const restored = await resetReplica(repo);
  assert.equal(restored.restoredFromSeed, true);
  assert.equal(getDatabaseStatus(repo).openJobsInReplica, 2);

  // spawn 开辟第二个 Agent 工位时自动秒级继承独立副本
  const spawnRes = spawnSync(process.execPath, [path.join(repo, ".collab/cli.mjs"), "spawn", "--agent", "codex", "--topic", "db-work"], {
    cwd: repo, encoding: "utf8", windowsHide: true, env: { ...process.env, COLLAB_ACTOR: "xiao" },
  });
  assert.equal(spawnRes.status, 0, spawnRes.stderr);
  const codexSeat = JSON.parse(spawnRes.stdout).seat;
  assert.equal(codexSeat.dbReplica.seeded, true);
  assert.equal(getDatabaseStatus(codexSeat.worktree).openJobsInReplica, 2);

  // 开发者在副工位本地造了一条测试数据，同时云端大库新增了第 3 条真实岗位 → 增量同步同时保留本地测试数据并合入云端新数据！
  await queryDatabase(codexSeat.worktree, `INSERT INTO jobs (id, source, company, title, url, content_hash, first_seen_at, last_changed_at) VALUES ('local:test1', 'bytedance', '本地测试公司', '测试岗', 'https://example.com/t1', 'h1', '2026-11-20T02:00:00Z', '2026-11-20T02:00:00Z')`);
  const nextCloudFetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/jobdb/stats") {
      return Response.json({
        ok: true,
        total_open: 3,
        updated_at: "2026-11-20T03:00:00Z",
        sources: [{ source: "bytedance", company: "字节跳动", adapter: "feishu", open_count: 3, last_status: "ok" }],
      });
    }
    if (u.pathname === "/api/jobdb/jobs") {
      return Response.json({
        ok: true,
        jobs: [
          { id: "bytedance:3", source: "bytedance", company: "字节跳动", title: "新入库云端岗位", cities: ["深圳"], recruit_type: "social", url: "https://jobs.bytedance.com/3", first_seen_at: "2026-11-20T03:00:00Z" },
          { id: "bytedance:1", source: "bytedance", company: "字节跳动", title: "大模型工程师", cities: ["北京"], recruit_type: "social", url: "https://jobs.bytedance.com/1", first_seen_at: "2026-11-20T00:00:00Z" },
        ],
        next_cursor: null,
      });
    }
    return new Response("not found", { status: 404 });
  };

  const inc = await incrementalSyncCloudDb(repo, [repo, codexSeat.worktree], { fetcher: nextCloudFetcher });
  assert.equal(inc.updated, true);
  assert.equal(inc.deltaJobs, 1);
  assert.equal(getDatabaseStatus(repo).openJobsInReplica, 3, "主工位自动获得第 3 条云端新岗位");
  assert.equal(getDatabaseStatus(codexSeat.worktree).openJobsInReplica, 4, "副工位同时拥有 3 条云端岗位 + 1 条本地自造测试数据");
});

test("远端只读屏障与 Collab Gate 数据库变更四重门禁校验", (t) => {
  // 1. 远端查询严格拦截任何写语句
  assert.equal(assertReadOnlySql("SELECT COUNT(*) FROM jobs;"), "SELECT COUNT(*) FROM jobs");
  for (const badSql of [
    "DELETE FROM jobs WHERE id='1'",
    "UPDATE jobs SET title='x'",
    "DROP TABLE jobs",
    "INSERT INTO jobs VALUES ('1')",
    "SELECT 1; DELETE FROM jobs",
  ]) {
    assert.throws(() => assertReadOnlySql(badSql), /安全拦截|禁止使用分号/);
  }

  // 2. 数据库迁移门禁测试：跳号、篡改已合入文件、高危无 WHERE 语句
  const tmp = mkdtempSync(path.join(os.tmpdir(), "collab-db-gate-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, "gate-repo");
  mkdirSync(path.join(repo, "site/migrations"), { recursive: true });
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "Tester"], repo);
  git(["config", "user.email", "tester@example.com"], repo);
  writeFileSync(path.join(repo, "site/migrations/0001_jobs.sql"), SCHEMA_0001, "utf8");
  initRepo(repo);
  git(["add", "-A"], repo);
  git(["commit", "-m", "base"], repo);

  // 切工作分支测试跳号 0003
  git(["checkout", "-b", "work/xiao/codex/bad-mig"], repo);
  writeFileSync(path.join(repo, "site/migrations/0003_skip.sql"), "CREATE INDEX idx_test ON jobs(company);\n", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "-m", "skip number"], repo);
  const skipAudit = auditDatabaseChanges(repo, "main");
  assert.equal(skipAudit.ok, false);
  assert.match(skipAudit.errors.join("\n"), /连续递增/);

  // 改为正确序号 0002，但包含高危 DROP TABLE → 未加标签时拦截，加 db-destructive 标签后放行
  rmSync(path.join(repo, "site/migrations/0003_skip.sql"));
  writeFileSync(path.join(repo, "site/migrations/0002_drop_runs.sql"), "DROP TABLE runs;\n", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "-m", "destructive sql"], repo);
  assert.equal(auditDatabaseChanges(repo, "main", []).ok, false);
  assert.equal(auditDatabaseChanges(repo, "main", ["db-destructive"]).ok, true);

  // 篡改已合入 main 的 0001_jobs.sql → 即使加标签也严禁篡改历史迁移
  writeFileSync(path.join(repo, "site/migrations/0001_jobs.sql"), SCHEMA_0001 + "\n-- mutated\n", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "-m", "mutate 0001"], repo);
  const mutAudit = auditDatabaseChanges(repo, "main", ["db-destructive"]);
  assert.equal(mutAudit.ok, false);
  assert.match(mutAudit.errors.join("\n"), /禁止修改或删除已合入主干的数据库脚本/);
});
