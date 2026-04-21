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
    throw new Error("Usage: tsx scripts/audit-user-recovery.ts <email>");
  }
  loadEnvFromFile(process.env.DOTENV_CONFIG_PATH || ".env.vercel.production");
  const { db } = await import("../lib/db");

  const profiles = await db.query(
    `
      SELECT user_id, email, is_admin, is_legacy, merged_into_user_id, created_at, updated_at
      FROM profiles
      WHERE lower(coalesce(email, '')) = $1
      ORDER BY created_at ASC
    `,
    [email],
  );

  const userIds = profiles.rows.map((r) => String(r.user_id));
  if (!userIds.length) {
    console.log(JSON.stringify({ ok: true, email, profiles: [], note: "no-profile" }, null, 2));
    await db.end();
    return;
  }

  const perUser = await db.query(
    `
      SELECT
        p.user_id,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.user_id = p.user_id) AS conversations,
        (SELECT COUNT(*)::int FROM messages m WHERE m.user_id = p.user_id) AS messages,
        (SELECT COUNT(*)::int FROM memory_entries me WHERE me.user_id = p.user_id) AS memories,
        (SELECT COUNT(*)::int FROM diary_entries d WHERE d.user_id = p.user_id) AS diaries,
        (SELECT COUNT(*)::int FROM uploaded_files f WHERE f.user_id = p.user_id) AS files,
        (SELECT COALESCE(total_tokens, 0)::bigint FROM usage_total ut WHERE ut.user_id = p.user_id LIMIT 1) AS total_tokens,
        (SELECT openrouter_key FROM user_settings us WHERE us.user_id = p.user_id LIMIT 1) AS openrouter_key,
        (SELECT nvidia_key FROM user_settings us WHERE us.user_id = p.user_id LIMIT 1) AS nvidia_key,
        (SELECT tavily_key FROM user_settings us WHERE us.user_id = p.user_id LIMIT 1) AS tavily_key,
        (SELECT openrouter_models FROM user_settings us WHERE us.user_id = p.user_id LIMIT 1) AS openrouter_models,
        (SELECT nvidia_models FROM user_settings us WHERE us.user_id = p.user_id LIMIT 1) AS nvidia_models,
        (SELECT name FROM user_pet_state ps WHERE ps.user_id = p.user_id LIMIT 1) AS pet_name,
        (SELECT level FROM user_pet_state ps WHERE ps.user_id = p.user_id LIMIT 1) AS pet_level
      FROM profiles p
      WHERE p.user_id = ANY($1::text[])
      ORDER BY p.user_id ASC
    `,
    [userIds],
  );

  const mergeHistory = await db.query(
    `
      SELECT from_user_id, to_user_id, email, merged_at, note
      FROM profile_merge_history
      WHERE lower(coalesce(email, '')) = $1
         OR from_user_id = ANY($2::text[])
         OR to_user_id = ANY($2::text[])
      ORDER BY merged_at DESC
      LIMIT 200
    `,
    [email, userIds],
  );

  const memoryBackups = await db.query(
    `
      SELECT
        source_user_id,
        COUNT(*)::int AS backups,
        MAX(created_at) AS last_backup_at
      FROM memory_entry_backups
      WHERE source_user_id = ANY($1::text[])
      GROUP BY source_user_id
      ORDER BY backups DESC
    `,
    [userIds],
  );

  const orphanBackups = await db.query(
    `
      SELECT source_user_id, COUNT(*)::int AS backups, MAX(created_at) AS last_backup_at
      FROM memory_entry_backups
      WHERE source_user_id NOT IN (SELECT user_id FROM profiles)
      GROUP BY source_user_id
      ORDER BY backups DESC
      LIMIT 100
    `,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        email,
        profiles: profiles.rows,
        perUser: perUser.rows,
        mergeHistory: mergeHistory.rows,
        memoryBackups: memoryBackups.rows,
        orphanBackupsTop: orphanBackups.rows,
      },
      null,
      2,
    ),
  );

  await db.end();
}

main().catch((err) => {
  console.error("audit-user-recovery failed:", err);
  process.exit(1);
});
