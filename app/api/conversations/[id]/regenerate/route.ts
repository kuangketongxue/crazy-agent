import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { addUsage, db } from "@/lib/db";
import { appendModelFooter, chatWithFallback } from "@/lib/model-fallback";
import { saveConversationExperience } from "@/lib/experience";
import { saveTraitSummary } from "@/lib/traits";
import { sanitizeAssistantContent } from "@/lib/text";
import { buildSkillSystemPrompt, REQUIRED_SKILLS } from "@/lib/skills";
import { shouldSearchWeb, sourcesToContext, tavilySearch } from "@/lib/web";
import { buildRealtimeContext } from "@/lib/realtime";
import { listCustomSkills } from "@/lib/user-skills";
import { buildMindmapPrompt, buildPollinationsMindmapUrl } from "@/lib/mindmap";
import { normalizeApiKey } from "@/lib/secrets";

const schema = z.object({
  assistantMessageId: z.coerce.number().int().positive(),
  forceWeb: z.boolean().optional(),
});

type Params = {
  params: Promise<{ id: string }>;
};

type Source = { title: string; url: string; snippet: string };

function deriveConfidenceLevel(args: { hasRealtime: boolean; hasSources: boolean; hasFiles: boolean; provider: string }) {
  if (args.provider === "fallback") return "low";
  let score = 0;
  if (args.hasRealtime) score += 2;
  if (args.hasSources) score += 2;
  if (args.hasFiles) score += 1;
  return score >= 4 ? "high" : score >= 2 ? "medium" : "low";
}

function buildKeyConclusion(answer: string) {
  const cleaned = answer.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "暂无关键结论";
  const sliced = cleaned.slice(0, 180);
  return sliced.endsWith("。") ? sliced : `${sliced}…`;
}

export async function POST(request: Request, { params }: Params) {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const { assistantMessageId, forceWeb } = parsed.data;

  const { rows: convoRows } = await db.query(`SELECT id FROM conversations WHERE id = $1 AND user_id = $2`, [id, user.userId]);
  if (!convoRows.length) {
    return NextResponse.json({ error: "对话不存在" }, { status: 404 });
  }

  const { rows: targetRows } = await db.query(
    `
      SELECT id, created_at
      FROM messages
      WHERE id = $1 AND conversation_id = $2 AND role = 'assistant'
      LIMIT 1
    `,
    [assistantMessageId, id],
  );
  if (!targetRows.length) {
    return NextResponse.json({ error: "目标回答不存在" }, { status: 404 });
  }

  const { rows: userRows } = await db.query(
    `
      SELECT id, content, uploaded_file_ids
      FROM messages
      WHERE conversation_id = $1
      AND role = 'user'
      AND created_at <= $2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [id, targetRows[0].created_at],
  );
  if (!userRows.length) {
    return NextResponse.json({ error: "找不到对应的问题" }, { status: 400 });
  }
  const userMessage = String(userRows[0].content || "");
  const targetFileIds = Array.isArray(userRows[0].uploaded_file_ids) ? (userRows[0].uploaded_file_ids as string[]) : [];

  const { rows: settingsRows } = await db.query(
    `SELECT system_prompt, auto_web, memory_only_mode, auto_mindmap, openrouter_key, nvidia_key, google_key, tavily_key, enabled_skills, openrouter_models, nvidia_models, google_models, openrouter_model_switches, nvidia_model_switches, google_model_switches FROM user_settings WHERE user_id = $1`,
    [user.userId],
  );
  const settings = settingsRows[0];
  const openrouterKey = normalizeApiKey(settings?.openrouter_key) || normalizeApiKey(process.env.OPENROUTER_API_KEY);
  const nvidiaKey = normalizeApiKey(settings?.nvidia_key) || normalizeApiKey(process.env.NVIDIA_API_KEY);
  const googleKey = normalizeApiKey(settings?.google_key) || normalizeApiKey(process.env.GOOGLE_API_KEY);
  const tavilyKey = normalizeApiKey(settings?.tavily_key);
  const enabledSkills: string[] =
    Array.isArray(settings?.enabled_skills) && settings.enabled_skills.length
      ? settings.enabled_skills
      : REQUIRED_SKILLS.map((s) => s.id);
  const openrouterModels: string[] = Array.isArray(settings?.openrouter_models) ? settings.openrouter_models : [];
  const nvidiaModels: string[] = Array.isArray(settings?.nvidia_models) ? settings.nvidia_models : [];
  const googleModels: string[] = Array.isArray(settings?.google_models) ? settings.google_models : [];
  const openrouterModelSwitches: Record<string, boolean> =
    settings?.openrouter_model_switches && typeof settings.openrouter_model_switches === "object"
      ? settings.openrouter_model_switches
      : {};
  const nvidiaModelSwitches: Record<string, boolean> =
    settings?.nvidia_model_switches && typeof settings.nvidia_model_switches === "object"
      ? settings.nvidia_model_switches
      : {};
  const googleModelSwitches: Record<string, boolean> =
    settings?.google_model_switches && typeof settings.google_model_switches === "object"
      ? settings.google_model_switches
      : {};
  const { rows: petRows } = await db.query(
    `SELECT name, trait_focus, trait_weakness, attributes, level, xp FROM user_pet_state WHERE user_id = $1 LIMIT 1`,
    [user.userId],
  );
  const pet = petRows[0] || null;
  const petAttrs = (pet?.attributes || {}) as Record<string, number>;
  const petStyleHints = [
    Number(petAttrs.debugging || 0) >= 70 ? "给更清晰的排错步骤和检查清单。" : "",
    Number(petAttrs.patience || 0) >= 70 ? "解释更耐心，分层给出原因和建议。" : "",
    Number(petAttrs.chaos || 0) >= 70 ? "额外给1个有创意但可落地的备选方案。" : "",
    Number(petAttrs.wisdom || 0) >= 70 ? "先给结论，再给长期策略建议。" : "",
    Number(petAttrs.snark || 0) >= 70 ? "语言更直接，减少冗余客套。" : "",
  ]
    .filter(Boolean)
    .join("");
  const rotateCursorRes = await db.query(
    `
      UPDATE user_settings
      SET model_rotation_cursor = COALESCE(model_rotation_cursor, 0) + 1, updated_at = now()
      WHERE user_id = $1
      RETURNING COALESCE(model_rotation_cursor, 1) - 1 AS rotate_offset
    `,
    [user.userId],
  );
  const rotateOffset = Number(rotateCursorRes.rows[0]?.rotate_offset || 0);
  const customSkills = await listCustomSkills(user.userId);
  const { rows: feedbackRows } = await db.query(
    `
      SELECT af.feedback, m.content
      FROM answer_feedback af
      JOIN messages m ON m.id = af.message_id
      WHERE af.user_id = $1
      ORDER BY af.updated_at DESC
      LIMIT 20
    `,
    [user.userId],
  );

  const { rows: memoryRows } = await db.query(
    `
      SELECT id, title, content, entry_type, source_pointer
      FROM memory_entries
      WHERE user_id = $1
        AND status = 'valid'
      ORDER BY updated_at DESC
    `,
    [user.userId],
  );

  const { rows: fileRows } = await db.query(
    `
      SELECT name, text_content
      FROM uploaded_files
      WHERE user_id = $1
        AND conversation_id = $2
        AND (cardinality($3::uuid[]) = 0 OR id = ANY($3::uuid[]))
      ORDER BY created_at DESC
      LIMIT 10
    `,
    [user.userId, id, targetFileIds],
  );

  const { rows: historyRows } = await db.query(
    `
      SELECT role, content
      FROM messages
      WHERE conversation_id = $1 AND created_at <= $2
      ORDER BY created_at DESC
      LIMIT 12
    `,
    [id, targetRows[0].created_at],
  );

  const memoryOnlyMode = settings?.memory_only_mode ?? false;
  const realtimeHardNeed = /几点|几号|日期|时间|星期|天气|温度|下雨|风速|湿度|气温|twitter|推特|x\.com|news|latest|today/i.test(userMessage);
  const webEnabled = (memoryOnlyMode && !realtimeHardNeed) ? false : forceWeb ?? shouldSearchWeb(userMessage, settings?.auto_web ?? true);
  let sources: Source[] = [];
  if (webEnabled) {
    try {
      sources = await tavilySearch(userMessage, tavilyKey);
    } catch {
      sources = [];
    }
  }
  const realtime = memoryOnlyMode && !realtimeHardNeed ? { context: "", sources: [] as Source[] } : await buildRealtimeContext(userMessage);
  const mergedSources = [...sources, ...realtime.sources].filter((v, i, arr) => arr.findIndex((x) => x.url === v.url) === i).slice(0, 8);

  const memoryContext = memoryRows
    .map(
      (row: { id: string; title: string; content: string; entry_type: string; source_pointer: string | null }) =>
        `- [${row.entry_type}] ${row.title}\n${row.content}\n索引: ${row.source_pointer || row.id}`,
    )
    .join("\n\n");

  const filesContext = fileRows
    .map((row: { name: string; text_content: string }) => `文件: ${row.name}\n${String(row.text_content).slice(0, 2000)}`)
    .join("\n\n");

  const historyContext = historyRows
    .reverse()
    .map((row: { role: string; content: string }) => `${row.role === "user" ? "用户" : "助手"}: ${row.content}`)
    .join("\n");
  const likedStyleHints = feedbackRows
    .filter((x: { feedback: string }) => x.feedback === "up")
    .slice(0, 3)
    .map((x: { content: string }) => String(x.content).slice(0, 120))
    .join("\n");
  const dislikedStyleHints = feedbackRows
    .filter((x: { feedback: string }) => x.feedback === "down")
    .slice(0, 3)
    .map((x: { content: string }) => String(x.content).slice(0, 120))
    .join("\n");

  const promptMessages = [
    {
      role: "system" as const,
      content:
        `${settings?.system_prompt || "你是用户的个人智能助手。"}\n\n` +
        (memoryOnlyMode
          ? "当前处于“日记记忆优先模式”：只能依据用户输入、对话历史、长期记忆和已上传文件回答。禁止引入外部事实。若证据不足，必须明确说“根据现有记录无法确认”。不要输出任何工具调用标记或内部控制标签。"
          : "采用 LLM Wiki 工作流：先检索长期记忆、上传文件与历史对话，再判断证据缺口；缺口存在时再联网/实时补证据。输出应先给结论，再给证据来源；当证据不足时明确不确定点。不要输出任何工具调用标记或内部控制标签。"),
    },
    {
      role: "system" as const,
      content:
        `用户回答偏好(来自点赞/踩):\n` +
        `偏好风格示例:\n${likedStyleHints || "(暂无)"}\n\n` +
        `应减少风格示例:\n${dislikedStyleHints || "(暂无)"}`,
    },
    {
      role: "system" as const,
      content:
        `当前宠物协作状态：名称=${pet?.name || "Mochi"}，等级=${Number(pet?.level || 1)}，经验=${Number(pet?.xp || 0)}，` +
        `主属性=${pet?.trait_focus || "wisdom"}，短板=${pet?.trait_weakness || "snark"}。` +
        (petStyleHints || "输出保持稳定、实用。"),
    },
    {
      role: "system" as const,
      content: "输出时请把最重要的1-3句用 **...** 包起来，方便界面用荧光笔突出重点。尽量避免使用“等”“等等”这类省略词，细节写完整。",
    },
    {
      role: "system" as const,
      content: buildSkillSystemPrompt(
        enabledSkills,
        customSkills.map((s) => ({ skillId: s.skill_id, name: s.name, prompt: s.prompt })),
      ),
    },
    {
      role: "system" as const,
      content:
        `长期记忆:\n${memoryContext || "(暂无)"}\n\n` +
        `文件摘要:\n${filesContext || "(暂无)"}\n\n` +
        `最近上下文:\n${historyContext || "(暂无)"}\n\n` +
        `联网结果:\n${memoryOnlyMode ? "(记忆优先模式已禁用联网)" : sourcesToContext(mergedSources) || "(未联网或无结果)"}\n\n` +
        `实时信息提取:\n${memoryOnlyMode ? "(记忆优先模式已禁用实时外部信息)" : realtime.context || "(无)"}`,
    },
    {
      role: "system" as const,
      content:
        "Role: 你是一个拥有长期记忆能力的智能助理。每次都先调取有效长期记忆，再回答当前问题。禁止说“根据你的个人资料”这类桥接语，要像老同事一样自然融合背景。",
    },
    {
      role: "system" as const,
      content:
        "禁止命令、训斥或操控用户，禁止试图改变用户核心价值观。语气保持协作和支持，只提供事实、方案和可执行建议。",
    },
    {
      role: "system" as const,
      content:
        "记忆闭环要求: 1) Recall: 优先引用相关记忆但不要生硬复读。2) Extract: 识别原子化长期信息(Fact/Preference/Context)。3) Maintain: 新信息覆盖旧信息；若用户说“忘了刚才那个”，立即排除。",
    },
    {
      role: "system" as const,
      content: realtime.context
        ? "你已拿到实时数据与来源。禁止再说“无法获取当前时间/天气/联网信息”。请直接基于实时数据回答。"
        : "若没有实时数据，明确说明缺口并给出下一步。",
    },
    { role: "user" as const, content: `${userMessage}\n\n请重新生成一个更好的答案。` },
  ];

  let assistantText = "";
  let provider = "";
  let model = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let thinkingSeconds = 0;
  let confidenceLevel: "high" | "medium" | "low" = "medium";
  let failedAttempts = 0;

  try {
    const reply = await chatWithFallback(
      {
        openrouterKey,
        nvidiaKey,
        googleKey,
        openrouterModels,
        nvidiaModels,
        googleModels,
        openrouterModelSwitches,
        nvidiaModelSwitches,
        googleModelSwitches,
        rotateOffset,
        minCouncil: 2,
      },
      promptMessages,
    );

    const cleanedContent = sanitizeAssistantContent(reply.content);
    assistantText = appendModelFooter(
      cleanedContent,
      reply.provider,
      reply.model,
      reply.thinkingSeconds,
      reply.totalTokens,
      reply.councilModels || [],
    );
    provider = reply.provider;
    model = reply.model;
    promptTokens = reply.promptTokens;
    completionTokens = reply.completionTokens;
    totalTokens = reply.totalTokens;
    thinkingSeconds = reply.thinkingSeconds;
    failedAttempts = reply.failedAttempts ?? 0;
    confidenceLevel = deriveConfidenceLevel({
      hasRealtime: Boolean(realtime.context),
      hasSources: mergedSources.length > 0,
      hasFiles: fileRows.length > 0,
      provider: reply.provider,
    }) as "high" | "medium" | "low";
  } catch (error) {
    assistantText = `当前已启用模型暂不可用（已按重试策略探索）。请稍后重试或在模型ID管理里启用更多可用模型。\n\n错误: ${String(error)}`;
    confidenceLevel = "low";
  }

  if (!Number.isFinite(totalTokens) || totalTokens < 0) totalTokens = 0;
  if (!Number.isFinite(promptTokens) || promptTokens < 0) promptTokens = 0;
  if (!Number.isFinite(completionTokens) || completionTokens < 0) completionTokens = 0;

  const enableMindmap = settings?.auto_mindmap ?? true;
  const mindmapPrompt = enableMindmap
    ? buildMindmapPrompt({
        conversationTitle: "重生成对话",
        userQuestion: userMessage,
        assistantAnswer: assistantText,
      })
    : null;
  const mindmapUrl = mindmapPrompt ? buildPollinationsMindmapUrl(mindmapPrompt) : null;

  const insert = await db.query(
    `
      INSERT INTO messages (
        conversation_id,
        user_id,
        role,
        content,
        model_provider,
        model_id,
        thinking_seconds,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        web_used,
        files_used,
        confidence_level,
        sources,
        mindmap_url,
        mindmap_prompt
      )
      VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
      RETURNING id
    `,
    [
      id,
      user.userId,
      assistantText,
      provider || null,
      model || null,
      thinkingSeconds || 0,
      promptTokens,
      completionTokens,
      totalTokens,
      webEnabled || Boolean(realtime.context),
      fileRows.length > 0,
      confidenceLevel,
      JSON.stringify(mergedSources),
      mindmapUrl,
      mindmapPrompt,
    ],
  );

  const safeSideEffect = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      console.error(`[regenerate] side-effect failed: ${label}`, error);
    }
  };

  await safeSideEffect("model_call_logs", async () => {
    await db.query(
      `INSERT INTO model_call_logs (user_id, provider, model_id, success, switched) VALUES ($1, $2, $3, $4, $5)`,
      [user.userId, provider || null, model || null, provider !== "fallback", failedAttempts > 0],
    );
  });

  await safeSideEffect("conversation_summaries", async () => {
    await db.query(
      `
        INSERT INTO conversation_summaries (conversation_id, user_id, key_conclusion, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT (conversation_id)
        DO UPDATE SET key_conclusion = EXCLUDED.key_conclusion, updated_at = now()
      `,
      [id, user.userId, buildKeyConclusion(assistantText)],
    );
  });

  await safeSideEffect("touch_conversation", async () => {
    await db.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [id]);
  });

  if (totalTokens > 0) {
    await safeSideEffect("usage", async () => {
      await addUsage(user.userId, promptTokens, completionTokens, totalTokens);
    });
  }

  await safeSideEffect("trait_summary", async () => {
    await saveTraitSummary({
      userId: user.userId,
      conversationId: id,
      userMessageId: Number(userRows[0].id),
      userMessage,
      systemPrompt: settings?.system_prompt || "",
    });
  });

  await safeSideEffect("experience", async () => {
    await saveConversationExperience({
      userId: user.userId,
      conversationId: id,
      userMessageId: Number(userRows[0].id),
      userMessage,
      assistantMessage: assistantText,
    });
  });

  return NextResponse.json({
    ok: true,
    assistantMessageId: insert.rows[0].id,
  });
}
