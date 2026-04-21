import { db } from "@/lib/db";
import { backupMemoryEvent } from "@/lib/memory-backup";
import { extractAtomicMemories } from "@/lib/memory-intelligence";

type TraitSummaryInput = {
  userId: string;
  conversationId: string;
  userMessageId: number;
  userMessage: string;
  systemPrompt: string;
};

function pickTrait(message: string) {
  const text = message.toLowerCase();
  if (/部署|上线|交付|发布/.test(text)) return "结果导向";
  if (/验证|测试|复盘|检查/.test(text)) return "重视可验证性";
  if (/简洁|直白|别绕|结论/.test(text)) return "偏好直给结论";
  if (/记忆|长期|复用|索引/.test(text)) return "重视长期记忆";
  return "目标清晰";
}

function inferWorkflow(message: string) {
  if (/修复|恢复|排查|报错|上线|部署/.test(message)) return "问题修复与恢复工作流";
  if (/测试|验证|复盘|检查/.test(message)) return "先验证再交付工作流";
  if (/记忆|长期|总结|索引|回顾/.test(message)) return "长期记忆沉淀工作流";
  if (/日记|计划|安排|高考/.test(message)) return "日常记录与追踪工作流";
  return "普通对话与需求澄清工作流";
}

function inferSituation(message: string) {
  if (/修复|恢复|不可用|报错|失败/.test(message)) return "在功能异常、需要恢复可用性的阶段。";
  if (/上线|部署|交付/.test(message)) return "在准备交付或上线确认的阶段。";
  if (/测试|验证|检查|复盘/.test(message)) return "在要求先验证、再确认结果的阶段。";
  if (/记忆|总结|索引|回顾/.test(message)) return "在要求沉淀跨会话信息、方便后续回看的阶段。";
  return "在正常对话推进需求的阶段。";
}

export async function saveTraitSummary(input: TraitSummaryInput) {
  const trait = pickTrait(input.userMessage);
  const atomic = extractAtomicMemories(input.userMessage);
  const title = `对话特质-${new Date().toISOString().slice(0, 10)}`;
  const briefInstruction = input.userMessage.replace(/\s+/g, " ").trim().slice(0, 260);
  const promptBrief = input.systemPrompt.replace(/\s+/g, " ").trim().slice(0, 220);
  const pointer = `trait:conversation:${input.conversationId}#message:${input.userMessageId}`;
  const workflow = inferWorkflow(input.userMessage);
  const situation = inferSituation(input.userMessage);

  const content = [
    `特质: ${trait}`,
    `出现情境: ${situation}`,
    `对应工作流: ${workflow}`,
    `触发指令: ${briefInstruction || "(空)"}`,
    `原始素材摘录: ${briefInstruction || "(空)"}`,
    `素材指针: ${pointer}`,
    "回顾方式: 打开这条指针对应的对话消息，就能回看当时的上下文。",
    `Fact: ${atomic.facts.join(" | ") || "(无)"}`,
    `Preference: ${atomic.preferences.join(" | ") || "(无)"}`,
    `Context: ${atomic.contexts.join(" | ") || "(无)"}`,
    `系统长期要求摘录: ${promptBrief || "(未设置)"}`,
    "下次协作建议: 先给可执行结果，再给关键依据与验证。",
  ].join("\n");

  const inserted = await db.query(
    `
      INSERT INTO memory_entries (user_id, title, content, entry_type, source_pointer)
      VALUES ($1, $2, $3, 'trait', $4)
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
    [input.userId, title, content, pointer],
  );

  if (inserted.rows[0]) {
    await backupMemoryEvent({
      sourceEntryId: inserted.rows[0].id,
      sourceUserId: input.userId,
      title: inserted.rows[0].title,
      content: inserted.rows[0].content,
      entryType: inserted.rows[0].entry_type,
      status: inserted.rows[0].status,
      sourcePointer: inserted.rows[0].source_pointer,
      action: "update",
    });
  }
}

