import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const { id } = await params;

  const { rows: convoRows } = await db.query(
    `SELECT id, title, created_at, updated_at FROM conversations WHERE id = $1 AND user_id = $2`,
    [id, user.userId],
  );

  if (!convoRows.length) {
    return NextResponse.json({ error: "对话不存在" }, { status: 404 });
  }

  const { rows: messageRows } = await db.query(
    `
      SELECT
        m.id,
        m.role,
        m.content,
        m.model_provider,
        m.model_id,
        m.thinking_seconds,
        m.web_used,
        m.files_used,
        m.confidence_level,
        m.sources,
        m.mindmap_url,
        m.mindmap_prompt,
        m.created_at,
        f.feedback
      FROM messages m
      LEFT JOIN answer_feedback f ON f.message_id = m.id AND f.user_id = $2
      WHERE m.conversation_id = $1
      ORDER BY m.created_at ASC
    `,
    [id, user.userId],
  );

  const { rows: summaryRows } = await db.query(
    `
      SELECT key_conclusion, updated_at
      FROM conversation_summaries
      WHERE conversation_id = $1 AND user_id = $2
      LIMIT 1
    `,
    [id, user.userId],
  );

  return NextResponse.json({ conversation: convoRows[0], messages: messageRows, summary: summaryRows[0] || null });
}

export async function DELETE(_request: Request, { params }: Params) {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const { id } = await params;
  const removed = await db.query(`DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id`, [id, user.userId]);
  if (!removed.rows.length) {
    return NextResponse.json({ error: "对话不存在或已删除" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deleted: true, id });
}
