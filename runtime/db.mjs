/**
 * AI原生联合开发平台 · 共享数据库与工位本地副本引擎 (.collab/db.mjs)
 *
 * 核心准则：
 *   1. 云端唯一真相主库（D1）：所有人与 Agent 可读；仅自动化抓取器与通过 CI 合并的 PR（migrations / data-fixes）可写。
 *   2. 每个工位独立本地副本（.collab-data/jobs.sqlite）：自动同步表结构与云端快照，Agent 可随意读写折腾，db reset 一键秒级还原。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";

function findGit() {
  const home = os.homedir();
  for (const c of [
    path.join(home, ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe"),
    "C:/Program Files/Git/cmd/git.exe",
  ]) {
    if (existsSync(c)) return c;
  }
  return "git";
}

const GIT = findGit();

function git(args, cwd) {
  const res = spawnSync(GIT, args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: res.status === 0, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

function commonGitDir(root) {
  const r = git(["rev-parse", "--git-common-dir"], root);
  return r.ok ? path.resolve(root, r.stdout) : path.join(root, ".git");
}

export function loadDbConfig(root) {
  const defaults = {
    migrationsDir: existsSync(path.join(root, "site/migrations")) ? "site/migrations" : "migrations",
    dataFixesDir: existsSync(path.join(root, "site")) ? "site/data-fixes" : "data-fixes",
    replicaFile: ".collab-data/jobs.sqlite",
    cloudDbApiOrigin: "https://aitoudi.com",
    d1AccountId: "",
    d1DatabaseId: "",
  };
  const cfgPath = path.join(root, ".collab/config.json");
  if (!existsSync(cfgPath)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    return { ...defaults, ...(raw.db || {}) };
  } catch {
    return defaults;
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function listSqlFiles(dirPath) {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath).filter((f) => f.endsWith(".sql")).sort();
}

/**
 * 打开持久化 SQLite 并包装为与 Cloudflare D1 完全一致的 prepare / bind / all / first / run / batch 接口。
 */
export function openD1Replica(sqlitePath, migrationsDir) {
  mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  applyMigrationsOnConnection(db, migrationsDir);

  const execute = (sql, params) => {
    const stmt = db.prepare(sql);
    if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql)) {
      const results = stmt.all(...params).map((row) => ({ ...row }));
      return { success: true, results, meta: { rows_read: results.length, rows_written: 0, changes: 0 } };
    }
    const info = stmt.run(...params);
    const changes = Number(info.changes);
    return { success: true, results: [], meta: { rows_read: 0, rows_written: changes, changes, last_row_id: Number(info.lastInsertRowid) } };
  };

  class Statement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params) {
      for (const v of params) {
        if (v === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported");
      }
      return new Statement(this.sql, params);
    }
    async all() { return execute(this.sql, this.params); }
    async run() { return execute(this.sql, this.params); }
    async first(column) {
      const row = execute(this.sql, this.params).results[0] ?? null;
      return column ? (row ? row[column] : null) : row;
    }
  }

  return {
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => execute(s.sql, s.params));
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    sqlite: db,
    close() { db.close(); },
  };
}

export function applyMigrationsOnConnection(db, migrationsDir) {
  db.exec(`CREATE TABLE IF NOT EXISTS _collab_migrations (
    name TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);
  const applied = new Map(
    db.prepare("SELECT name, sha256 FROM _collab_migrations").all().map((r) => [r.name, r.sha256])
  );
  const newlyApplied = [];
  for (const file of listSqlFiles(migrationsDir)) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    const digest = sha256(sql);
    if (applied.has(file)) continue;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _collab_migrations (name, sha256, applied_at) VALUES (?, ?, ?)")
        .run(file, digest, new Date().toISOString());
      db.exec("COMMIT");
      newlyApplied.push(file);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`迁移脚本执行失败 (${file}): ${err.message}`);
    }
  }
  return newlyApplied;
}

export function migrateReplica(root) {
  const cfg = loadDbConfig(root);
  const replicaPath = path.resolve(root, cfg.replicaFile);
  const migDir = path.resolve(root, cfg.migrationsDir);
  mkdirSync(path.dirname(replicaPath), { recursive: true });
  const db = new DatabaseSync(replicaPath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    const applied = applyMigrationsOnConnection(db, migDir);
    return { ok: true, replica: replicaPath, newlyApplied: applied };
  } finally {
    db.close();
  }
}

function stripSqlComments(sql) {
  return sql
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

function findDestructiveSql(sql) {
  const clean = stripSqlComments(sql);
  const findings = [];
  const statements = clean.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    if (/^\s*DROP\s+(TABLE|INDEX|TRIGGER|VIEW)\b/i.test(stmt)) {
      findings.push(`DROP 语句 (${stmt.slice(0, 50)}...)`);
    } else if (/^\s*TRUNCATE\b/i.test(stmt)) {
      findings.push(`TRUNCATE 语句 (${stmt.slice(0, 50)}...)`);
    } else if (/^\s*ALTER\s+TABLE\s+\S+\s+DROP\b/i.test(stmt)) {
      findings.push(`ALTER TABLE DROP 列 (${stmt.slice(0, 50)}...)`);
    } else if (/^\s*DELETE\s+FROM\s+\S+/i.test(stmt) && !/\bWHERE\b/i.test(stmt)) {
      findings.push(`无 WHERE 条件的整表 DELETE (${stmt.slice(0, 50)}...)`);
    } else if (/^\s*UPDATE\s+\S+\s+SET\b/i.test(stmt) && !/\bWHERE\b/i.test(stmt)) {
      findings.push(`无 WHERE 条件的整表 UPDATE (${stmt.slice(0, 50)}...)`);
    }
  }
  return findings;
}

/**
 * Collab Gate 零信任数据库变更审查：
 *   1. 编号连续且唯一（0001_xxx.sql, 0002_yyy.sql）
 *   2. 已合并的迁移与数据修正脚本严禁篡改或删除（Append-Only）
 *   3. 破坏性 SQL（DROP / 无 WHERE 的 DELETE 或 UPDATE）必须带 db-destructive 标签
 *   4. 所有 SQL 必须在真实内存 SQLite 上从零演练通过
 */
export function auditDatabaseChanges(root, baseRef, prLabels = []) {
  const cfg = loadDbConfig(root);
  const errors = [];
  const migDir = path.resolve(root, cfg.migrationsDir);
  const fixDir = path.resolve(root, cfg.dataFixesDir);

  for (const [label, dirPath] of [["migrations", migDir], ["data-fixes", fixDir]]) {
    if (!existsSync(dirPath)) continue;
    const files = listSqlFiles(dirPath);
    const seenNums = new Set();
    files.forEach((file, idx) => {
      const m = /^(\d{4})_[a-z0-9_]+\.sql$/i.exec(file);
      if (!m) {
        errors.push(`[${label}] 文件命名不符合 NNNN_name.sql 规范：${file}`);
        return;
      }
      const num = Number(m[1]);
      if (seenNums.has(num)) errors.push(`[${label}] 存在重复序号 ${m[1]}（并发撞车）：${file}`);
      seenNums.add(num);
      if (num !== idx + 1) {
        errors.push(`[${label}] 序号必须从 0001 起连续递增，期望 ${String(idx + 1).padStart(4, "0")} 实际 ${m[1]} (${file})`);
      }
    });
  }

  // 检查相比 baseRef 是否篡改或删除了已合入的 SQL 脚本，并扫描新增脚本中的破坏性语句
  if (baseRef && git(["rev-parse", "--verify", baseRef], root).ok) {
    const prefixes = [cfg.migrationsDir, cfg.dataFixesDir].map((p) => p.replace(/\\/g, "/").replace(/\/$/, "") + "/");
    const diffStatus = git(["diff", "--name-status", `${baseRef}...HEAD`], root);
    const allowDestructive = prLabels.includes("db-destructive");
    for (const line of diffStatus.stdout.split(/\r?\n/).filter(Boolean)) {
      const parts = line.split(/\t+/);
      const status = parts[0];
      const relPath = (parts[1] || "").replace(/\\/g, "/");
      if (!prefixes.some((pre) => relPath.startsWith(pre)) || !relPath.endsWith(".sql")) continue;

      if (status !== "A") {
        errors.push(`禁止修改或删除已合入主干的数据库脚本（只能新增）：${status} ${relPath}`);
        continue;
      }
      const full = path.join(root, relPath);
      if (existsSync(full)) {
        const destructive = findDestructiveSql(readFileSync(full, "utf8"));
        if (destructive.length > 0 && !allowDestructive) {
          errors.push(`检测到高危数据库变更 [${relPath}]: ${destructive.join("; ")}（如确需执行，请为 PR 添加 'db-destructive' 标签）`);
        }
      }
    }
  }

  // 在干净的 node:sqlite 内存库中从头演练全部建表迁移与数据修正脚本
  if (existsSync(migDir) || existsSync(fixDir)) {
    const mem = new DatabaseSync(":memory:");
    try {
      for (const file of listSqlFiles(migDir)) {
        try {
          mem.exec(readFileSync(path.join(migDir, file), "utf8"));
        } catch (err) {
          errors.push(`迁移脚本语法或约束演练失败 (${file}): ${err.message}`);
        }
      }
      for (const file of listSqlFiles(fixDir)) {
        try {
          mem.exec(readFileSync(path.join(fixDir, file), "utf8"));
        } catch (err) {
          errors.push(`数据修正脚本演练失败 (${file}): ${err.message}`);
        }
      }
    } finally {
      mem.close();
    }
  }

  return { ok: errors.length === 0, errors };
}

function removeSqliteFiles(sqlitePath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(sqlitePath + suffix, { force: true });
  }
}

/**
 * 从云端唯一真相库拉取最新岗位快照至本机共享种子缓存（.git/collab-db-seed.sqlite），并复制到当前工位副本。
 */
export async function pullCloudReplica(root, {
  remoteUrl,
  limit = 1000,
  withDetails = 40,
  fetcher = globalThis.fetch,
} = {}) {
  const cfg = loadDbConfig(root);
  const origin = (remoteUrl || cfg.cloudDbApiOrigin || "https://aitoudi.com").replace(/\/$/, "");
  const migDir = path.resolve(root, cfg.migrationsDir);
  const common = commonGitDir(root);
  const seedPath = path.join(common, "collab-db-seed.sqlite");
  const tmpSeedPath = path.join(common, `collab-db-seed.tmp-${process.pid}.sqlite`);
  const replicaPath = path.resolve(root, cfg.replicaFile);

  removeSqliteFiles(tmpSeedPath);
  const db = new DatabaseSync(tmpSeedPath);
  let syncedJobs = 0;
  let syncedSources = 0;
  let cloudTotalOpen = 0;

  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    applyMigrationsOnConnection(db, migDir);

    // 1. 拉取 /api/jobdb/stats 同步 sources 与最新运行记录 runs
    const statsRes = await fetcher(`${origin}/api/jobdb/stats`, { headers: { accept: "application/json" } });
    if (!statsRes.ok) throw new Error(`拉取云端状态失败 HTTP ${statsRes.status}`);
    const stats = await statsRes.json();
    cloudTotalOpen = stats.total_open || 0;

    db.exec("BEGIN");
    const insertSource = db.prepare(`INSERT OR REPLACE INTO sources (
      source, company, adapter, open_count, last_run_at, last_ok_at, last_status,
      last_seen, last_new, last_changed, last_closed, last_deferred, last_error, last_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)`);
    for (const s of stats.sources || []) {
      insertSource.run(
        s.source, s.company, s.adapter, s.open_count ?? 0,
        s.last_run_at ?? null, s.last_ok_at ?? null, s.last_status ?? null,
        s.last_new ?? null, s.last_changed ?? null, s.last_closed ?? null, s.last_deferred ?? null
      );
      syncedSources++;
    }
    if (stats.last_run?.started_at && stats.last_run?.finished_at) {
      db.prepare("DELETE FROM runs").run();
      db.prepare("INSERT INTO runs (started_at, finished_at, triggered_by, summary) VALUES (?, ?, ?, ?)")
        .run(stats.last_run.started_at, stats.last_run.finished_at, stats.last_run.triggered_by || "cloud-sync", JSON.stringify(stats.last_run));
    }
    db.exec("COMMIT");

    // 2. 游标分页拉取最新在招岗位写入种子库
    let cursor = null;
    const collectedIds = [];
    const insertJob = db.prepare(`INSERT OR REPLACE INTO jobs (
      id, source, company, company_type, title, category, department, cities, recruit_type, education,
      min_years, experience, salary, description, requirements, url, posted_at, source_updated_at, deadline,
      content_hash, sig, cluster_key, first_seen_at, last_changed_at, closed_at, missing_since
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)`);

    while (syncedJobs < limit) {
      const batchSize = Math.min(50, limit - syncedJobs);
      const q = new URL(`${origin}/api/jobdb/jobs`);
      q.searchParams.set("limit", String(batchSize));
      if (cursor) q.searchParams.set("cursor", cursor);
      const listRes = await fetcher(q.href, { headers: { accept: "application/json" } });
      if (!listRes.ok) throw new Error(`拉取云端岗位列表失败 HTTP ${listRes.status}`);
      const page = await listRes.json();
      const items = page.jobs || [];
      if (items.length === 0) break;

      db.exec("BEGIN");
      for (const j of items) {
        const seenAt = j.first_seen_at || new Date().toISOString();
        insertJob.run(
          j.id, j.source, j.company, j.company_type ?? null, j.title, j.category ?? null,
          j.department ?? null, JSON.stringify(Array.isArray(j.cities) ? j.cities : []),
          j.recruit_type || "social", j.education ?? null, j.min_years ?? null,
          j.experience ?? null, j.salary ?? null, j.description || "", j.requirements || "",
          j.url, j.posted_at ?? null, j.source_updated_at ?? null, j.deadline ?? null,
          sha256(`${j.id}:${j.title}:${seenAt}`).slice(0, 16), seenAt, seenAt
        );
        collectedIds.push(j.id);
        syncedJobs++;
      }
      db.exec("COMMIT");
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }

    // 3. 为前 withDetails 条岗位补齐完整 JD 正文（description + requirements）供本地详情联调
    const detailIds = collectedIds.slice(0, Math.max(0, withDetails));
    if (detailIds.length > 0) {
      const updateDetail = db.prepare(`UPDATE jobs SET
        department = COALESCE(?, department),
        experience = COALESCE(?, experience),
        description = ?,
        requirements = ?,
        source_updated_at = COALESCE(?, source_updated_at),
        last_changed_at = COALESCE(?, last_changed_at)
      WHERE id = ?`);
      const fetchedDetails = [];
      for (let i = 0; i < detailIds.length; i += 8) {
        const slice = detailIds.slice(i, i + 8);
        const batch = await Promise.all(slice.map(async (id) => {
          const r = await fetcher(`${origin}/api/jobdb/jobs/${encodeURIComponent(id)}`).catch(() => null);
          if (!r || !r.ok) return null;
          const body = await r.json().catch(() => null);
          return body?.job || null;
        }));
        for (const item of batch) if (item) fetchedDetails.push(item);
      }
      db.exec("BEGIN");
      for (const d of fetchedDetails) {
        updateDetail.run(
          d.department ?? null, d.experience ?? null,
          d.description || "", d.requirements || "",
          d.source_updated_at ?? null, d.last_changed_at ?? null, d.id
        );
      }
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }

  removeSqliteFiles(seedPath);
  copyFileSync(tmpSeedPath, seedPath);
  removeSqliteFiles(tmpSeedPath);
  writeFileSync(path.join(common, "collab-db-seed.meta.json"), JSON.stringify({
    syncedAt: new Date().toISOString(),
    origin,
    cloudTotalOpen,
    syncedJobs,
    syncedSources,
  }, null, 2) + "\n", "utf8");

  mkdirSync(path.dirname(replicaPath), { recursive: true });
  removeSqliteFiles(replicaPath);
  copyFileSync(seedPath, replicaPath);
  migrateReplica(root);

  return {
    ok: true,
    origin,
    replica: replicaPath,
    seedCache: seedPath,
    cloudTotalOpen,
    syncedSources,
    syncedJobs,
  };
}

/**
 * 一键还原当前工位数据库副本（毫秒级从本机种子缓存恢复，无需重新联网下载）。
 */
export async function resetReplica(root, pullOpts = {}) {
  const cfg = loadDbConfig(root);
  const common = commonGitDir(root);
  const seedPath = path.join(common, "collab-db-seed.sqlite");
  const replicaPath = path.resolve(root, cfg.replicaFile);

  if (!existsSync(seedPath)) {
    return pullCloudReplica(root, pullOpts);
  }
  mkdirSync(path.dirname(replicaPath), { recursive: true });
  removeSqliteFiles(replicaPath);
  copyFileSync(seedPath, replicaPath);
  const mig = migrateReplica(root);
  return {
    ok: true,
    restoredFromSeed: true,
    replica: replicaPath,
    newlyAppliedMigrations: mig.newlyApplied,
  };
}

/**
 * 为新开辟的 Worktree 工位秒级初始化本地数据库副本。
 */
export function seedWorktreeReplicaIfAvailable(mainRoot, targetWorktree) {
  const cfg = loadDbConfig(targetWorktree);
  const common = commonGitDir(mainRoot);
  const seedPath = path.join(common, "collab-db-seed.sqlite");
  const dstPath = path.resolve(targetWorktree, cfg.replicaFile);
  if (existsSync(dstPath)) return { seeded: false, reason: "already-exists", path: dstPath };
  if (existsSync(seedPath)) {
    mkdirSync(path.dirname(dstPath), { recursive: true });
    copyFileSync(seedPath, dstPath);
    migrateReplica(targetWorktree);
    return { seeded: true, source: "seed-cache", path: dstPath };
  }
  if (existsSync(path.resolve(targetWorktree, cfg.migrationsDir))) {
    migrateReplica(targetWorktree);
    return { seeded: true, source: "empty-schema", path: dstPath };
  }
  return { seeded: false, reason: "no-migrations" };
}

export function assertReadOnlySql(sql) {
  const clean = stripSqlComments(String(sql || "")).trim().replace(/;+\s*$/, "");
  if (!clean) throw new Error("SQL 不能为空");
  if (clean.includes(";")) {
    throw new Error("远端查询仅允许单条只读 SQL，禁止使用分号拼接多条语句。");
  }
  if (!/^(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(clean)) {
    throw new Error("安全拦截：远端主库严禁手动执行写操作（仅允许 SELECT / WITH / PRAGMA / EXPLAIN 只读查询；写操作必须提交 PR 经 CI 执行）。");
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH|VACUUM|REINDEX)\b/i.test(clean)) {
    throw new Error("安全拦截：检测到写操作关键字，远端主库仅开放只读查询。");
  }
  return clean;
}

function readLocalVar(root, key) {
  if (process.env[key]) return process.env[key];
  for (const rel of [".dev.vars", "site/.dev.vars", ".env.local"]) {
    const full = path.join(root, rel);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

export async function queryDatabase(root, sql, { remote = false, fetcher = globalThis.fetch } = {}) {
  const cfg = loadDbConfig(root);
  if (!remote) {
    const replicaPath = path.resolve(root, cfg.replicaFile);
    if (!existsSync(replicaPath)) {
      migrateReplica(root);
    }
    const db = new DatabaseSync(replicaPath);
    try {
      const trimmed = String(sql || "").trim();
      const stmt = db.prepare(trimmed);
      if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(trimmed)) {
        return { mode: "local-replica", replica: replicaPath, rows: stmt.all() };
      }
      const info = stmt.run();
      return { mode: "local-replica", replica: replicaPath, changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
    } finally {
      db.close();
    }
  }

  const safeSql = assertReadOnlySql(sql);
  const cfToken = readLocalVar(root, "CLOUDFLARE_D1_READ_TOKEN") || readLocalVar(root, "CLOUDFLARE_API_TOKEN");
  let accountId = cfg.d1AccountId || readLocalVar(root, "CLOUDFLARE_ACCOUNT_ID");
  let databaseId = cfg.d1DatabaseId || readLocalVar(root, "CLOUDFLARE_D1_DATABASE_ID");

  // 自动从 site/wrangler.jsonc 提取公开的 account_id 与 database_id
  const wranglerPath = path.join(root, "site/wrangler.jsonc");
  if ((!accountId || !databaseId) && existsSync(wranglerPath)) {
    const raw = readFileSync(wranglerPath, "utf8");
    accountId ||= /"account_id"\s*:\s*"([a-f0-9]{32})"/i.exec(raw)?.[1] || "";
    databaseId ||= /"database_id"\s*:\s*"([a-f0-9-]{36})"/i.exec(raw)?.[1] || "";
  }

  if (!cfToken || !accountId || !databaseId) {
    throw new Error("未找到 CLOUDFLARE_D1_READ_TOKEN（可在 site/.dev.vars 中配置只读令牌）；日常开发请先用 'node .collab/cli.mjs db pull' 拉取到本地副本后直接免令牌查询。");
  }

  const res = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfToken}`,
    },
    body: JSON.stringify({ sql: safeSql }),
  });
  const body = await res.json();
  if (!res.ok || !body.success) {
    throw new Error(`远端 D1 只读查询失败：${JSON.stringify(body.errors || body)}`);
  }
  return { mode: "remote-d1-readonly", rows: body.result?.[0]?.results || [] };
}

export function getDatabaseStatus(root) {
  const cfg = loadDbConfig(root);
  const common = commonGitDir(root);
  const replicaPath = path.resolve(root, cfg.replicaFile);
  const metaPath = path.join(common, "collab-db-seed.meta.json");
  const seedMeta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;

  if (!existsSync(replicaPath)) {
    return {
      exists: false,
      replica: replicaPath,
      seedMeta,
      hint: "运行 'node .collab/cli.mjs db pull' 即可从云端主库拉取最新共享岗位副本。",
    };
  }

  const db = new DatabaseSync(replicaPath);
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const jobsCount = tables.has("jobs") ? db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE closed_at IS NULL").get().n : 0;
    const sourcesCount = tables.has("sources") ? db.prepare("SELECT COUNT(*) AS n FROM sources").get().n : 0;
    const migrations = tables.has("_collab_migrations")
      ? db.prepare("SELECT name, applied_at FROM _collab_migrations ORDER BY name").all()
      : [];
    return {
      exists: true,
      replica: replicaPath,
      sizeBytes: statSync(replicaPath).size,
      openJobsInReplica: Number(jobsCount),
      sourcesInReplica: Number(sourcesCount),
      appliedMigrations: migrations,
      seedMeta,
    };
  } finally {
    db.close();
  }
}
