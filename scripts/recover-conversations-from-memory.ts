import { existsSync, readFileSync } from "node:fs";

function loadEnvFromFile(path: string) {
  if (!path || !existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function extractBetween(text: string, startLabel: string, endLabel?: string) {
  const start = text.indexOf(startLabel);
  if (start < 0) return "";
  const from = start + startLabel.length;
  if (!endLabel) return text.slice(from).trim();
  const end = text.indexOf(endLabel, from);
  return (end < 0 ? text.slice(from) : text.slice(from, end)).trim();
}

function cleanLine(text: string) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

async function main() {
  const email = String(process.argv[2] || "").trim().toLowerCase();
  if (!email) {
    throw new Error("Usage: tsx scripts/recover-conversations-from-memory.ts <email>");
  }
  loadEnvFromFile(process.env.DOTENV_CONFIG_PATH || ".env.vercel.production");

  const { db } = await import("../lib/db");
  const profileRes = await db.query(`SELECT user_id FROM profiles WHERE lower(coalesce(email, '')) = $1 LIMIT 1`, [email]);
  if (!profileRes.rows.length) throw new Error(`profile not found: ${email}`);
  const userId = String(profileRes.rows[0].user_id);

  const sourceRes = await db.query(
    `
      SELECT id, title, content, updated_at
      FROM memory_entries
      WHERE user_id = $1
        AND (
          entry_type = 'experience'
          OR (
            entry_type = 'global_import'
            AND content LIKE '%用户问题:%'
            AND content LIKE '%本次回答:%'
          )
        )
      ORDER BY updated_at ASC
      LIMIT 2000
    `,
    [userId],
  );

  let createdConversations = 0;
  let createdMessages = 0;
  let skipped = 0;

  for (const row of sourceRes.rows as Array<{ id: string; title: string; content: string; updated_at: string }>) {
    const raw = String(row.content || "");
    let question = "";
    let answer = "";
    let convId = "";

    if (raw.includes("用户问题摘要:") && raw.includes("回答摘要:")) {
      question = cleanLine(extractBetween(raw, "用户问题摘要:", "\n本次可复用做法:"));
      answer = cleanLine(extractBetween(raw, "回答摘要:", "\n回看指针:"));
      const pointer = cleanLine(extractBetween(raw, "回看指针:"));
      const m = pointer.match(/conversation:([0-9a-f-]{36})/i);
      if (m) convId = m[1];
    } else if (raw.includes("用户问题:") && raw.includes("本次回答:")) {
      question = cleanLine(extractBetween(raw, "用户问题:", "\n可复用经验:"));
      answer = cleanLine(extractBetween(raw, "本次回答:"));
      const m = raw.match(/conversation:([0-9a-f-]{36})/i);
      if (m) convId = m[1];
    }

    if (!question || !answer) {
      skipped += 1;
      continue;
    }
    if (!convId) {
      // fallback deterministic UUID-like storage via generated uuid
      const idRes = await db.query(`SELECT gen_random_uuid()::text AS id`);
      convId = String(idRes.rows[0].id);
    }

    const existedRes = await db.query(`SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 LIMIT 1`, [convId, userId]);
    if (!existedRes.rows.length) {
      const title = cleanLine(question).slice(0, 24) || "历史恢复对话";
      await db.query(
        `
          INSERT INTO conversations (id, user_id, title, is_favorite, created_at, updated_at)
          VALUES ($1::uuid, $2, $3, FALSE, $4::timestamptz, $4::timestamptz)
          ON CONFLICT (id) DO NOTHING
        `,
        [convId, userId, title, row.updated_at],
      );
      createdConversations += 1;
    }

    const msgCheck = await db.query(`SELECT COUNT(*)::int AS c FROM messages WHERE conversation_id = $1`, [convId]);
    if (Number(msgCheck.rows[0]?.c || 0) > 0) {
      skipped += 1;
      continue;
    }

    await db.query(
      `
        INSERT INTO messages (conversation_id, user_id, role, content, created_at)
        VALUES
          ($1::uuid, $2, 'user', $3, $5::timestamptz),
          ($1::uuid, $2, 'assistant', $4, $5::timestamptz)
      `,
      [convId, userId, question, answer, row.updated_at],
    );
    createdMessages += 2;
  }

  const summary = await db.query(
    `
      SELECT
        (SELECT COUNT(*)::int FROM conversations WHERE user_id = $1) AS conversations,
        (SELECT COUNT(*)::int FROM messages WHERE user_id = $1) AS messages
    `,
    [userId],
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        email,
        userId,
        sourceEntries: sourceRes.rows.length,
        createdConversations,
        createdMessages,
        skipped,
        after: summary.rows[0] || {},
      },
      null,
      2,
    ),
  );

  await db.end();
}

main().catch((err) => {
  console.error("recover-conversations-from-memory failed:", err);
  process.exit(1);
});
