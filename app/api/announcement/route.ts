import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { db, isAdminUser } from "@/lib/db";

const schema = z.object({
  content: z.string().max(5000),
});

export async function GET() {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const { rows } = await db.query(
    `SELECT content, updated_at, updated_by FROM system_announcements WHERE id = 1 LIMIT 1`,
  );
  return NextResponse.json({
    announcement: rows[0] || { content: "", updated_at: null, updated_by: null },
  });
}

export async function PUT(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const isAdmin = await isAdminUser(user);
  if (!isAdmin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  await db.query(
    `
      INSERT INTO system_announcements (id, content, updated_by, updated_at)
      VALUES (1, $1, $2, now())
      ON CONFLICT (id)
      DO UPDATE SET content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = now()
    `,
    [parsed.data.content, user.userId],
  );

  return NextResponse.json({ ok: true });
}



