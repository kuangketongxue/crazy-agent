import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { backupMemoryEvent } from "@/lib/memory-backup";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(20000),
  entryType: z.string().min(1).max(30).default("note"),
  status: z.enum(["valid", "outdated"]).optional().default("valid"),
  sourcePointer: z.string().max(500).optional().nullable(),
});

const updateSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(20000),
  status: z.enum(["valid", "outdated"]).optional(),
});

function normalizeMemoryText(input: string) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccardSimilarity(a: string, b: string) {
  const aa = new Set(normalizeMemoryText(a).split(" ").filter(Boolean));
  const bb = new Set(normalizeMemoryText(b).split(" ").filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const token of aa) {
    if (bb.has(token)) intersection += 1;
  }
  return intersection / (aa.size + bb.size - intersection);
}

export async function GET() {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  await db.query(
    `
      UPDATE memory_entries
      SET status = 'outdated', updated_at = now()
      WHERE user_id = $1
        AND status <> 'outdated'
        AND COALESCE(last_referenced_at, updated_at, created_at) < now() - interval '90 days'
        AND importance < 0.3
    `,
    [user.userId],
  );

  const { rows: statsRows } = await db.query(
    `
      SELECT
        (SELECT COUNT(*)::int FROM uploaded_files WHERE user_id = $1) AS total_files,
        (SELECT COALESCE(SUM(line_count), 0)::int FROM uploaded_files WHERE user_id = $1) AS total_lines,
        (SELECT MAX(updated_at) FROM memory_entries WHERE user_id = $1) AS latest_memory_update
    `,
    [user.userId],
  );

  const { rows: recentRows } = await db.query(
    `
      SELECT id, title, content, entry_type, status, importance, source_pointer, updated_at
      FROM memory_entries
      WHERE user_id = $1
        AND status <> 'deleted'
      ORDER BY updated_at DESC
      LIMIT 200
    `,
    [user.userId],
  );

  return NextResponse.json({
    stats: statsRows[0],
    entries: recentRows,
  });
}

export async function POST(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const normalizedTitle = parsed.data.title.trim();
  const normalizedContent = parsed.data.content.trim();
  const existed = await db.query(
    `
      SELECT id, title, content, entry_type, status, importance, source_pointer, updated_at
      FROM memory_entries
      WHERE user_id = $1
        AND status <> 'deleted'
        AND (
          content = $2
          OR lower(regexp_replace(content, '\s+', ' ', 'g')) = lower(regexp_replace($2, '\s+', ' ', 'g'))
        )
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [user.userId, normalizedContent],
  );
  if (existed.rows[0]) {
    return NextResponse.json({ entry: existed.rows[0], deduped: true });
  }

  const similarRows = await db.query(
    `
      SELECT id, title, content, entry_type, status, importance, source_pointer, updated_at
      FROM memory_entries
      WHERE user_id = $1
        AND status <> 'deleted'
      ORDER BY updated_at DESC
      LIMIT 300
    `,
    [user.userId],
  );
  const similar = similarRows.rows.find((row) => jaccardSimilarity(String(row.content || ""), normalizedContent) >= 0.92);
  if (similar) {
    return NextResponse.json({ entry: similar, deduped: true });
  }

  const { rows } = await db.query(
    `
      INSERT INTO memory_entries (user_id, title, content, entry_type, status, source_pointer)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, title, content, entry_type, status, importance, source_pointer, updated_at
    `,
    [
      user.userId,
      normalizedTitle,
      normalizedContent,
      parsed.data.entryType,
      parsed.data.status,
      parsed.data.sourcePointer || null,
    ],
  );

  if (rows[0]) {
    await backupMemoryEvent({
      sourceEntryId: rows[0].id,
      sourceUserId: user.userId,
      title: rows[0].title,
      content: rows[0].content,
      entryType: rows[0].entry_type,
      status: rows[0].status,
      sourcePointer: rows[0].source_pointer,
      action: "create",
    });
  }

  return NextResponse.json({ entry: rows[0] });
}

export async function PUT(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const updated = await db.query(
    `
      UPDATE memory_entries
      SET
        title = $3,
        content = $4,
        status = COALESCE($5, status),
        importance = CASE WHEN COALESCE($5, status) = 'valid' THEN LEAST(1.0, importance + 0.03) ELSE GREATEST(0.1, importance - 0.05) END,
        updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING id, title, content, entry_type, status, source_pointer
    `,
    [parsed.data.id, user.userId, parsed.data.title, parsed.data.content, parsed.data.status ?? null],
  );

  if (updated.rows[0]) {
    await backupMemoryEvent({
      sourceEntryId: updated.rows[0].id,
      sourceUserId: user.userId,
      title: updated.rows[0].title,
      content: updated.rows[0].content,
      entryType: updated.rows[0].entry_type,
      status: updated.rows[0].status,
      sourcePointer: updated.rows[0].source_pointer,
      action: "update",
    });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  }

  const current = await db.query(
    `SELECT id, title, content, entry_type, status, source_pointer FROM memory_entries WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [id, user.userId],
  );
  const removed = await db.query(`DELETE FROM memory_entries WHERE id = $1 AND user_id = $2 RETURNING id`, [id, user.userId]);
  if (!removed.rows.length) {
    return NextResponse.json({ error: "记忆不存在或已删除" }, { status: 404 });
  }

  if (current.rows[0]) {
    await backupMemoryEvent({
      sourceEntryId: current.rows[0].id,
      sourceUserId: user.userId,
      title: current.rows[0].title,
      content: current.rows[0].content,
      entryType: current.rows[0].entry_type,
      status: current.rows[0].status,
      sourcePointer: current.rows[0].source_pointer,
      action: "delete",
    });
  }

  return NextResponse.json({ ok: true, deleted: true });
}
