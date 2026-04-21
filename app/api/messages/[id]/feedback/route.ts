import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";

const schema = z.object({
  feedback: z.enum(["up", "down"]),
});

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: Params) {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const msgId = Number(id);
  if (!Number.isFinite(msgId) || msgId <= 0) {
    return NextResponse.json({ error: "消息ID错误" }, { status: 400 });
  }

  const { rows } = await db.query(
    `
      SELECT m.id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND c.user_id = $2 AND m.role = 'assistant'
      LIMIT 1
    `,
    [msgId, user.userId],
  );
  if (!rows.length) {
    return NextResponse.json({ error: "消息不存在" }, { status: 404 });
  }

  await db.query(
    `
      INSERT INTO answer_feedback (user_id, message_id, feedback, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (user_id, message_id)
      DO UPDATE SET feedback = EXCLUDED.feedback, updated_at = now()
    `,
    [user.userId, msgId, parsed.data.feedback],
  );

  const hint =
    parsed.data.feedback === "up"
      ? "已记录：你喜欢这种回答风格，后续会优先保持。"
      : "已记录：你不喜欢这种回答风格，后续会减少类似表达。";

  return NextResponse.json({ ok: true, hint });
}
