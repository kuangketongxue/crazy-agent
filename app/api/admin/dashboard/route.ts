import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db, isAdminUser } from "@/lib/db";

export async function GET() {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const isAdmin = await isAdminUser(user);
  if (!isAdmin) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  const { rows: usersRows } = await db.query(
    `
      WITH msg_usage AS (
        SELECT
          user_id,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens
        FROM messages
        WHERE role = 'assistant'
        GROUP BY user_id
      )
      SELECT
        p.user_id,
        p.email,
        p.created_at,
        p.is_blocked,
        p.blocked_reason,
        p.blocked_at,
        COALESCE(u.total_tokens, 0) AS total_tokens,
        COALESCE(u.prompt_tokens, 0) AS prompt_tokens,
        COALESCE(u.completion_tokens, 0) AS completion_tokens,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.user_id = p.user_id) AS conversations,
        (SELECT COUNT(*)::int FROM messages m WHERE m.user_id = p.user_id) AS messages
      FROM profiles p
      LEFT JOIN msg_usage u ON u.user_id = p.user_id
      ORDER BY p.created_at DESC
      LIMIT 200
    `,
  );
  const { rows: recentConversations } = await db.query(
    `
      SELECT
        c.id,
        c.user_id,
        p.email,
        c.title,
        c.updated_at,
        (
          SELECT content
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) AS latest_message
      FROM conversations c
      JOIN profiles p ON p.user_id = c.user_id
      ORDER BY c.updated_at DESC
      LIMIT 500
    `,
  );

  const { rows: convoRows } = await db.query(`SELECT COUNT(*)::int AS total_conversations FROM conversations`);
  const { rows: msgRows } = await db.query(`SELECT COUNT(*)::int AS total_messages FROM messages`);
  const { rows: backupRows } = await db.query(`SELECT COUNT(*)::int AS total_backups FROM memory_entry_backups`);
  const { rows: annRows } = await db.query(`SELECT content, updated_at FROM system_announcements WHERE id = 1 LIMIT 1`);

  return NextResponse.json({
    stats: {
      totalUsers: usersRows.length,
      totalConversations: convoRows[0]?.total_conversations || 0,
      totalMessages: msgRows[0]?.total_messages || 0,
      totalMemoryBackups: backupRows[0]?.total_backups || 0,
    },
    users: usersRows,
    conversations: recentConversations,
    announcement: annRows[0] || null,
  });
}

const blockSchema = {
  parse(input: unknown): { targetUserId: string; blocked: boolean; reason: string } {
    const row = (input || {}) as Record<string, unknown>;
    const targetUserId = String(row.targetUserId || "").trim();
    const blocked = Boolean(row.blocked);
    const reason = String(row.reason || "").trim();
    if (!targetUserId) throw new Error("缺少 targetUserId");
    return { targetUserId, blocked, reason };
  },
};

export async function POST(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }
  const admin = await isAdminUser(user);
  if (!admin) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  let payload: { targetUserId: string; blocked: boolean; reason: string };
  try {
    payload = blockSchema.parse(await request.json().catch(() => ({})));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
  if (payload.targetUserId === user.userId) {
    return NextResponse.json({ error: "不能屏蔽当前管理员账号" }, { status: 400 });
  }

  await db.query(
    `
      UPDATE profiles
      SET
        is_blocked = $2,
        blocked_reason = CASE WHEN $2 THEN NULLIF($3, '') ELSE NULL END,
        blocked_at = CASE WHEN $2 THEN now() ELSE NULL END,
        updated_at = now()
      WHERE user_id = $1
    `,
    [payload.targetUserId, payload.blocked, payload.reason || null],
  );

  return NextResponse.json({ ok: true });
}


