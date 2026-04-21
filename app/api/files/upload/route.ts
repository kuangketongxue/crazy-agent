import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { countLines, extractFileText } from "@/lib/files";
import { normalizeApiKey } from "@/lib/secrets";

export async function POST(request: Request) {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const formData = await request.formData();
  const conversationId = String(formData.get("conversationId") || "").trim() || null;
  const files = formData.getAll("files") as File[];

  if (!files.length) {
    return NextResponse.json({ error: "没有文件" }, { status: 400 });
  }

  const { rows: settingsRows } = await db.query(
    `SELECT openrouter_key, nvidia_key, google_key FROM user_settings WHERE user_id = $1`,
    [user.userId],
  );
  const settings = settingsRows[0] || {};
  const openrouterKey = normalizeApiKey(settings.openrouter_key);
  const nvidiaKey = normalizeApiKey(settings.nvidia_key);
  const googleKey = normalizeApiKey(settings.google_key);

  const result = [];
  const MAX_INLINE_PARSE_BYTES = 12 * 1024 * 1024;
  const PARSE_TIMEOUT_MS = 95_000;

  for (const file of files) {
    let text = "";
    try {
      if (file.size > MAX_INLINE_PARSE_BYTES) {
        text = `文件已上传：${file.name}\n大小: ${(file.size / 1024 / 1024).toFixed(2)}MB\n说明: 文件过大，已跳过即时识别。你可以先发送该消息，系统会基于文件元信息继续处理。`;
      } else {
        text = await Promise.race([
          extractFileText(file, {
            openrouterKey,
            nvidiaKey,
            googleKey,
          }),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve(`文件已上传：${file.name}\n说明: 即时识别超时，已保留文件，发送后可继续处理。`), PARSE_TIMEOUT_MS),
          ),
        ]);
      }
    } catch (error) {
      text = `文件解析失败: ${file.name}\n${String(error)}`;
    }
    const safeText = text || `已上传文件: ${file.name}（未提取到文本）`;
    const lines = countLines(safeText);

    const { rows } = await db.query(
      `
        INSERT INTO uploaded_files (user_id, conversation_id, name, content_type, text_content, line_count)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, name, line_count, created_at
      `,
      [user.userId, conversationId, file.name, file.type || null, safeText.slice(0, 200000), lines],
    );

    result.push(rows[0]);
  }

  return NextResponse.json({ files: result });
}
