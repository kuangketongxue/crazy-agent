import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { makeConversationTitle } from "@/lib/text";

const createSchema = z.object({
  firstMessage: z.string().optional().default(""),
});

export async function GET() {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const { rows } = await db.query(
    `
      SELECT c.id, c.title, c.created_at, c.updated_at,
        c.is_favorite,
        (
          SELECT content FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) AS latest_message
      FROM conversations c
      WHERE c.user_id = $1
      ORDER BY c.is_favorite DESC, c.updated_at DESC
      LIMIT 100
    `,
    [user.userId],
  );

  return NextResponse.json({ conversations: rows });
}

export async function POST(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const body = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const title = makeConversationTitle(parsed.data.firstMessage);

  const { rows } = await db.query(
    `
      INSERT INTO conversations (user_id, title)
      VALUES ($1, $2)
      RETURNING id, title, created_at, updated_at
    `,
    [user.userId, title],
  );

  return NextResponse.json({ conversation: rows[0] });
}
