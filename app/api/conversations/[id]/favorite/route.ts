import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const { rows } = await db.query(
    `
      UPDATE conversations
      SET is_favorite = NOT is_favorite, updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING id, is_favorite
    `,
    [id, user.userId],
  );
  if (!rows.length) {
    return NextResponse.json({ error: "对话不存在" }, { status: 404 });
  }
  return NextResponse.json({ conversation: rows[0] });
}
