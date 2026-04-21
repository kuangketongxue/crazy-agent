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

async function main() {
  const email = String(process.argv[2] || "").trim().toLowerCase();
  if (!email) {
    throw new Error("Usage: tsx scripts/recover-user-history.ts <email>");
  }
  loadEnvFromFile(process.env.DOTENV_CONFIG_PATH || ".env.vercel.production");

  const { db, recoverProfileDataByEmail } = await import("../lib/db");
  const { rows } = await db.query(
    `
      SELECT user_id, created_at, updated_at
      FROM profiles
      WHERE lower(coalesce(email, '')) = $1
      ORDER BY updated_at DESC, created_at DESC
    `,
    [email],
  );

  if (!rows.length) {
    throw new Error(`No profile found for email: ${email}`);
  }

  const targetUserId = String(rows[0].user_id);
  const result = await recoverProfileDataByEmail({ userId: targetUserId, email });

  const counts = await db.query(
    `
      SELECT
        (SELECT COUNT(*)::int FROM conversations WHERE user_id = $1) AS conversations,
        (SELECT COUNT(*)::int FROM messages WHERE user_id = $1) AS messages,
        (SELECT COUNT(*)::int FROM memory_entries WHERE user_id = $1) AS memories,
        (SELECT COUNT(*)::int FROM diary_entries WHERE user_id = $1) AS diaries,
        (SELECT COALESCE(total_tokens, 0)::bigint FROM usage_total WHERE user_id = $1 LIMIT 1) AS total_tokens
    `,
    [targetUserId],
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        email,
        targetUserId,
        mergedProfiles: result.merged,
        after: counts.rows[0] || {},
      },
      null,
      2,
    ),
  );

  await db.end();
}

main().catch((err) => {
  console.error("recover-user-history failed:", err);
  process.exit(1);
});
