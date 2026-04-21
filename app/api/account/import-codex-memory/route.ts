import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import fs from "node:fs/promises";
import path from "node:path";

const schema = z.object({
  memoryEntryId: z.string().uuid().optional(),
});

function buildEntryBlock(args: {
  userId: string;
  email: string | null;
  title: string;
  content: string;
  entryType: string;
  sourcePointer: string | null;
}) {
  return [
    `## [${new Date().toISOString()}] ${args.title}`,
    `user_id: ${args.userId}`,
    `email: ${args.email || ""}`,
    `entry_type: ${args.entryType}`,
    `source_pointer: ${args.sourcePointer || ""}`,
    "",
    args.content || "",
    "",
  ].join("\n");
}

export async function POST(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) return user;

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const memoryEntryId = parsed.data.memoryEntryId;
  const userProfile = await db.query(`SELECT email FROM profiles WHERE user_id = $1 LIMIT 1`, [user.userId]);
  const email = String(userProfile.rows[0]?.email || "") || null;

  let memoryText = "";
  if (memoryEntryId) {
    const one = await db.query(
      `
        SELECT title, content, entry_type, source_pointer
        FROM memory_entries
        WHERE user_id = $1 AND id = $2
        LIMIT 1
      `,
      [user.userId, memoryEntryId],
    );
    if (!one.rows.length) return NextResponse.json({ error: "记忆不存在" }, { status: 404 });
    const row = one.rows[0];
    memoryText = buildEntryBlock({
      userId: user.userId,
      email,
      title: String(row.title || "未命名记忆"),
      content: String(row.content || ""),
      entryType: String(row.entry_type || "note"),
      sourcePointer: row.source_pointer ? String(row.source_pointer) : null,
    });
  } else {
    const memories = await db.query(
      `
        SELECT title, content, entry_type, source_pointer
        FROM memory_entries
        WHERE user_id = $1 AND status = 'valid'
        ORDER BY updated_at DESC
        LIMIT 300
      `,
      [user.userId],
    );
    const joined = memories.rows.map((row) =>
      buildEntryBlock({
        userId: user.userId,
        email,
        title: String(row.title || "未命名记忆"),
        content: String(row.content || ""),
        entryType: String(row.entry_type || "note"),
        sourcePointer: row.source_pointer ? String(row.source_pointer) : null,
      }),
    );
    memoryText = [
      `# Crazy Agent Memory Import`,
      `generated_at: ${new Date().toISOString()}`,
      `user_id: ${user.userId}`,
      `email: ${email || ""}`,
      `count: ${joined.length}`,
      "",
      ...joined,
    ].join("\n");
  }

  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (!home) {
    return NextResponse.json({ error: "无法定位系统用户目录，导入失败" }, { status: 500 });
  }
  const targetDir = path.join(home, ".codex", "memory");
  const targetFile = path.join(targetDir, "crazy-agent-memory.md");
  await fs.mkdir(targetDir, { recursive: true });
  await fs.appendFile(targetFile, `${memoryText}\n\n`, "utf8");

  return NextResponse.json({
    ok: true,
    filePath: targetFile,
    message: memoryEntryId ? "这条记忆已导入到 Codex 记忆文件" : "用户数据已导入到 Codex 记忆文件",
    memoryText: memoryText.slice(0, 100000),
  });
}
