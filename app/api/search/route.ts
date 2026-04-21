import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { makeSnippet } from "@/lib/text";

export async function GET(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").trim();

  if (!q) {
    return NextResponse.json({ conversations: [], messages: [] });
  }

  const like = `%${q}%`;

  const { rows: convRows } = await db.query(
    `
      SELECT id, title, updated_at
      FROM conversations
      WHERE user_id = $1
        AND title ILIKE $2
      ORDER BY updated_at DESC
      LIMIT 30
    `,
    [user.userId, like],
  );

  const { rows: msgRows } = await db.query(
    `
      SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.user_id = $1
        AND m.content ILIKE $2
      ORDER BY m.created_at DESC
      LIMIT 100
    `,
    [user.userId, like],
  );

  const messageResults = msgRows.map((row: { id: number; conversation_id: string; role: string; content: string; created_at: string; title: string }) => {
    const hit = makeSnippet(row.content, q);
    return {
      id: row.id,
      conversationId: row.conversation_id,
      title: row.title,
      role: row.role,
      snippet: hit.snippet,
      hitIndex: hit.index,
      createdAt: row.created_at,
    };
  });

  return NextResponse.json({
    conversations: convRows,
    messages: messageResults,
  });
}
