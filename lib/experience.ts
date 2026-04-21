import { db } from "@/lib/db";
import { backupMemoryEvent } from "@/lib/memory-backup";

function summarizeText(input: string, maxLen = 260) {
  const clean = input.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}...` : clean;
}

export async function saveConversationExperience(params: {
  userId: string;
  conversationId: string;
  userMessageId: number;
  userMessage: string;
  assistantMessage: string;
}) {
  const userSummary = summarizeText(params.userMessage, 220);
  const assistantSummary = summarizeText(params.assistantMessage, 320);

  const title = `经验-${new Date().toISOString().slice(0, 10)}-${String(params.userMessageId)}`;
  const pointer = `experience:conversation:${params.conversationId}#message:${params.userMessageId}`;

  const content = [
    "复用场景: 用户提出了类似需求时优先复用。",
    `用户问题摘要: ${userSummary || "(空)"}`,
    "本次可复用做法: 回答前先读取长期记忆、近期消息和文件，再给出结构化答复。",
    `回答摘要: ${assistantSummary || "(空)"}`,
    `回看指针: ${pointer}`,
  ].join("\n");

  const inserted = await db.query(
    `
      INSERT INTO memory_entries (user_id, title, content, entry_type, source_pointer)
      VALUES ($1, $2, $3, 'experience', $4)
      ON CONFLICT (user_id, source_pointer) WHERE source_pointer IS NOT NULL
      DO UPDATE SET
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        entry_type = EXCLUDED.entry_type,
        status = 'valid',
        importance = LEAST(1.0, memory_entries.importance + 0.02),
        updated_at = now()
      RETURNING id, title, content, entry_type, status, source_pointer
    `,
    [params.userId, title, content, pointer],
  );

  if (inserted.rows[0]) {
    await backupMemoryEvent({
      sourceEntryId: inserted.rows[0].id,
      sourceUserId: params.userId,
      title: inserted.rows[0].title,
      content: inserted.rows[0].content,
      entryType: inserted.rows[0].entry_type,
      status: inserted.rows[0].status,
      sourcePointer: inserted.rows[0].source_pointer,
      action: "update",
    });
  }
}
