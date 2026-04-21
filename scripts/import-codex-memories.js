const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error("Missing DATABASE_URL");

const CODEX_HOME = path.join(process.env.USERPROFILE || "C:/Users/binlo", ".codex");

function readIfExists(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function walkFiles(dir, out = []) {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

function dedupe(arr) {
  const set = new Set();
  const out = [];
  for (const item of arr) {
    const key = normalize(item);
    if (!key || set.has(key)) continue;
    set.add(key);
    out.push(key);
  }
  return out;
}

function pickImportantLines(mdText) {
  const raw = mdText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const keep = raw.filter((line) => /目标|偏好|要求|结论|策略|协作|记忆|上线|测试|高考|任务|workflow|summary|archive|部署|修复|输出|风格/i.test(line));
  return dedupe((keep.length ? keep : raw).slice(0, 80));
}

function summarizePreferences(text) {
  const source = text.toLowerCase();
  const features = [
    { key: /上线|部署|交付|完成|结果|build|deploy/g, line: "偏好结果导向：强调可直接使用和上线交付。" },
    { key: /验证|测试|跑一遍|检查|实测|稳定|修复/g, line: "偏好先验证：要求真实测试通过后再汇报。" },
    { key: /简单|直白|不要术语|结论|别绕/g, line: "沟通偏好：内容要直白，减少术语。" },
    { key: /长期记忆|记忆|历史对话|总结/g, line: "记忆偏好：要求把跨会话信息沉淀进长期记忆。" },
    { key: /马上|尽快|直接做|不要停/g, line: "执行偏好：节奏快，追求闭环完成。" },
  ];

  const lines = ["这是基于你在 Codex 全部历史聊天提炼出的长期协作偏好（纯文本版）。"];
  for (const f of features) {
    if ((source.match(f.key) || []).length > 0) lines.push(f.line);
  }
  lines.push("协作建议：先给可用结果，再补充关键依据；每次改动都做可见验证。");
  return lines.join("\n");
}

(async () => {
  const pool = new Pool({ connectionString: DB, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    const profiles = await client.query(
      `SELECT user_id,email FROM profiles WHERE email NOT LIKE 'e2e-%' ORDER BY created_at ASC LIMIT 1`,
    );
    if (!profiles.rows.length) throw new Error("No real user profile found");
    const userId = profiles.rows[0].user_id;

    const historyLines = readIfExists(path.join(CODEX_HOME, "history.jsonl"))
      .split(/\r?\n/)
      .map((line) => safeJson(line))
      .filter(Boolean)
      .map((obj) => String(obj.text || ""))
      .map(normalize)
      .filter(Boolean)
      .slice(-10000);

    const mdFiles = walkFiles(CODEX_HOME)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .filter((f) => !f.includes(`${path.sep}plugins${path.sep}`))
      .filter((f) => !f.includes(`${path.sep}skills${path.sep}`));

    const mdLines = dedupe(
      mdFiles
        .map((f) => pickImportantLines(readIfExists(f)))
        .flat()
        .slice(0, 5000),
    );

    const preferenceText = summarizePreferences([...historyLines, ...mdLines].join("\n"));

    const requirementText = dedupe(
      historyLines.filter((t) => /上线|部署|修复|长期记忆|测试|语音|管理员|设置|保存|对话|vercel|supabase|clerk|tavily|openrouter|nvidia/i.test(t)),
    )
      .slice(-80)
      .map((t, i) => `${i + 1}. ${t}`)
      .join("\n");

    const archiveText = mdLines
      .slice(0, 120)
      .map((t, i) => `${i + 1}. ${t}`)
      .join("\n");

    await client.query(`DELETE FROM memory_entries WHERE user_id=$1 AND entry_type='codex_import'`, [userId]);

    await client.query(
      `INSERT INTO memory_entries (user_id,title,content,entry_type,source_pointer)
       VALUES ($1,$2,$3,'codex_import',NULL)`,
      [userId, "Codex全局记忆-协作偏好(全文字版)", preferenceText],
    );

    await client.query(
      `INSERT INTO memory_entries (user_id,title,content,entry_type,source_pointer)
       VALUES ($1,$2,$3,'codex_import',NULL)`,
      [userId, "Codex全局记忆-历史需求(全文字版)", requirementText || "暂无可提取需求文本"],
    );

    await client.query(
      `INSERT INTO memory_entries (user_id,title,content,entry_type,source_pointer)
       VALUES ($1,$2,$3,'codex_import',NULL)`,
      [userId, "Codex全局记忆-历史资料(全文字版)", archiveText || "暂无可提取资料文本"],
    );

    const check = await client.query(
      `SELECT id,title,entry_type,source_pointer,updated_at FROM memory_entries WHERE user_id=$1 AND entry_type='codex_import' ORDER BY updated_at DESC`,
      [userId],
    );

    console.log(JSON.stringify({ ok: true, userId, imported: check.rows.length, entries: check.rows }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
})();
