import { db, isAdminUser, PRIMARY_ADMIN_EMAIL } from "@/lib/db";

async function getAdminUserId() {
  const { rows } = await db.query(
    `
      SELECT user_id
      FROM profiles
      WHERE lower(coalesce(email, '')) = $1
      ORDER BY
        CASE WHEN COALESCE(is_legacy, FALSE) = FALSE AND user_id LIKE 'user_%' THEN 0 ELSE 1 END,
        CASE WHEN COALESCE(merged_into_user_id, '') = '' THEN 0 ELSE 1 END,
        updated_at DESC,
        created_at ASC,
        user_id ASC
      LIMIT 1
    `,
    [PRIMARY_ADMIN_EMAIL],
  );
  return (rows[0]?.user_id as string | undefined) || null;
}

export async function backupMemoryEvent(args: {
  sourceEntryId?: string | null;
  sourceUserId: string;
  title: string;
  content: string;
  entryType: string;
  status?: string | null;
  sourcePointer?: string | null;
  action: "create" | "update" | "delete" | "sync";
}) {
  const adminUserId = await getAdminUserId();
  if (!adminUserId) return;

  await db.query(
    `
      INSERT INTO memory_entry_backups (
        source_entry_id, source_user_id, backup_user_id,
        title, content, entry_type, status, source_pointer, action
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      args.sourceEntryId || null,
      args.sourceUserId,
      adminUserId,
      args.title,
      args.content,
      args.entryType,
      args.status || "valid",
      args.sourcePointer || null,
      args.action,
    ],
  );

  if (args.action === "delete") {
    return;
  }

  const isSourceAdmin = await isAdminUser({ userId: args.sourceUserId, email: null });
  if (isSourceAdmin) return;

  const mirrorPointer = `mirror:${args.sourceUserId}:${args.sourceEntryId || "noid"}`;
  await db.query(
    `
      INSERT INTO memory_entries (
        user_id, title, content, entry_type, status, importance, source_pointer, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 0.8, $6, now())
      ON CONFLICT DO NOTHING
    `,
    [
      adminUserId,
      `镜像-${args.title}`,
      args.content,
      "global_import",
      args.status || "valid",
      mirrorPointer,
    ],
  );
}

export async function syncAllMemoriesToAdmin() {
  const adminUserId = await getAdminUserId();
  if (!adminUserId) {
    return { synced: 0, skipped: 0 };
  }

  const { rows } = await db.query(
    `
      SELECT id, user_id, title, content, entry_type, status, source_pointer
      FROM memory_entries
      WHERE user_id <> $1
      ORDER BY updated_at DESC
      LIMIT 5000
    `,
    [adminUserId],
  );

  let synced = 0;
  let skipped = 0;
  for (const row of rows as Array<{
    id: string;
    user_id: string;
    title: string;
    content: string;
    entry_type: string;
    status: string;
    source_pointer: string | null;
  }>) {
    const pointer = `mirror:${row.user_id}:${row.id}`;
    const check = await db.query(
      `SELECT id FROM memory_entries WHERE user_id = $1 AND source_pointer = $2 LIMIT 1`,
      [adminUserId, pointer],
    );
    if (check.rows.length) {
      skipped += 1;
      continue;
    }
    await backupMemoryEvent({
      sourceEntryId: row.id,
      sourceUserId: row.user_id,
      title: row.title,
      content: row.content,
      entryType: row.entry_type || "note",
      status: row.status || "valid",
      sourcePointer: row.source_pointer,
      action: "sync",
    });
    synced += 1;
  }

  return { synced, skipped };
}




