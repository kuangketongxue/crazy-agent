import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { addUsage, db } from "@/lib/db";
import { appendModelFooter, chatWithFallback, type SourceItem } from "@/lib/model-fallback";
import { saveConversationExperience } from "@/lib/experience";
import { saveTraitSummary } from "@/lib/traits";
import { makeConversationTitle, sanitizeAssistantContent } from "@/lib/text";
import { buildSkillSystemPrompt, REQUIRED_SKILLS } from "@/lib/skills";
import { shouldSearchWeb, sourcesToContext, tavilySearch } from "@/lib/web";
import { buildRealtimeContext } from "@/lib/realtime";
import { listCustomSkills, parseSkillFromMessage, shouldCreateSkillByMessage, upsertCustomSkill } from "@/lib/user-skills";
import { buildMindmapPrompt, buildPollinationsMindmapUrl } from "@/lib/mindmap";
import { normalizeApiKey } from "@/lib/secrets";

const schema = z.object({
  content: z.string().min(1).max(50000),
  fileIds: z.array(z.string().uuid()).optional().default([]),
  forceWeb: z.boolean().optional(),
  stream: z.boolean().optional().default(false),
});

type Params = {
  params: Promise<{ id: string }>;
};

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

function mergeSources(a: SourceItem[], b: SourceItem[]) {
  const map = new Map<string, SourceItem>();
  for (const item of [...a, ...b]) {
    if (!item.url) continue;
    if (!map.has(item.url)) map.set(item.url, item);
  }
  return [...map.values()].slice(0, 8);
}

function tokenize(text: string) {
  return Array.from(text.toLowerCase().matchAll(/[a-z0-9\u4e00-\u9fa5]{2,}/g)).map((m) => m[0]);
}

function estimateContextCoverage(query: string, context: string) {
  const q = tokenize(query);
  if (!q.length) return 1;
  const c = new Set(tokenize(context));
  let hit = 0;
  for (const token of q) {
    if (c.has(token)) hit += 1;
  }
  return hit / q.length;
}

function streamAssistantPayload(payload: {
  content: string;
  modelProvider: string | null;
  modelId: string | null;
  thinkingSeconds: number;
  webUsed: boolean;
  sources: SourceItem[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  userMessageId: number;
  assistantMessageId: number;
}) {
  const encoder = new TextEncoder();
  const text = payload.content;

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data:${JSON.stringify({ type: "begin", payload: { ...payload, content: "" } })}\n\n`));

      let i = 0;
      const timer = setInterval(() => {
        if (i >= text.length) {
          clearInterval(timer);
          controller.enqueue(encoder.encode(`data:${JSON.stringify({ type: "done" })}\n\n`));
          controller.close();
          return;
        }

        const delta = text.slice(i, i + 1);
        i += 1;
        controller.enqueue(encoder.encode(`data:${JSON.stringify({ type: "delta", delta })}\n\n`));
      }, 8);
    },
  });
}

export async function POST(request: Request, { params }: Params) {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const { id } = await params;
  const { rows: convoRows } = await db.query(`SELECT id, title FROM conversations WHERE id = $1 AND user_id = $2`, [id, user.userId]);

  if (!convoRows.length) {
    return NextResponse.json({ error: "对话不存在" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const { content, fileIds, forceWeb, stream } = parsed.data;

  const { rows: settingsRows } = await db.query(
    `SELECT system_prompt, auto_web, memory_only_mode, voice_enabled, auto_mindmap, openrouter_key, nvidia_key, google_key, tavily_key, enabled_skills, openrouter_models, nvidia_models, google_models, openrouter_model_switches, nvidia_model_switches, google_model_switches FROM user_settings WHERE user_id = $1`,
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

  const { rows: filesRows } = await db.query(
    `
      SELECT id, name, text_content
      FROM uploaded_files
      WHERE user_id = $1
      AND (conversation_id = $2 OR conversation_id IS NULL)
      AND id = ANY($3::uuid[])
      ORDER BY created_at DESC
      LIMIT 10
    `,
    [user.userId, id, fileIds],
  );

  const { rows: memoryRows } = await db.query(
    `
      SELECT id, title, content, entry_type, source_pointer
      FROM memory_entries
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT 50
    `,
    [user.userId],
  );

  const { rows: historyRows } = await db.query(
    `
      SELECT role, content
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT 12
    `,
    [id],
  );

  const userInsert = await db.query(
    `INSERT INTO messages (conversation_id, user_id, role, content, uploaded_file_ids) VALUES ($1, $2, 'user', $3, $4::jsonb) RETURNING id`,
    [id, user.userId, content, JSON.stringify(fileIds || [])],
  );

  const currentTitle = String(convoRows[0].title || "").trim();
  if (!currentTitle || currentTitle === makeConversationTitle("")) {
    await db.query(`UPDATE conversations SET title = $2, updated_at = now() WHERE id = $1`, [id, makeConversationTitle(content)]);
  } else {
    await db.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [id]);
  }

  if (shouldCreateSkillByMessage(content)) {
    const parsedSkill = parseSkillFromMessage(content);
    const created = await upsertCustomSkill(user.userId, {
      skillId: parsedSkill.skillId,
      name: parsedSkill.name,
      description: parsedSkill.description,
      prompt: parsedSkill.prompt,
    });

    const assistantText = [
      `已创建自定义技能：${created.name}`,
      `技能ID：${created.skill_id}`,
      "从下一次对话开始，这个技能会自动加入执行流程。",
      "你也可以继续发消息：例如“把这个技能改成更强调结构化输出”。",
    ].join("\n");

    const assistantInsert = await db.query(
      `
        INSERT INTO messages (
          conversation_id, user_id, role, content, model_provider, model_id, thinking_seconds,
          prompt_tokens, completion_tokens, total_tokens, web_used, sources
        )
        VALUES ($1, $2, 'assistant', $3, $4, $5, 0, 0, 0, 0, false, '[]'::jsonb)
        RETURNING id
      `,
      [id, user.userId, assistantText, "local", "skill-builder"],
    );

    return NextResponse.json({
      userMessageId: userInsert.rows[0].id,
      assistantMessageId: assistantInsert.rows[0].id,
      assistant: {
        content: assistantText,
        modelProvider: "local",
        modelId: "skill-builder",
        thinkingSeconds: 0,
        webUsed: false,
        sources: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    });
  }

  const memoryOnlyMode = settings?.memory_only_mode ?? false;
  const memoryContext = memoryRows
    .map((row: { id: string; title: string; content: string; entry_type: string; source_pointer: string | null }) =>
      `- [${row.entry_type}] ${row.title}\n${row.content}\n索引: ${row.source_pointer || row.id}`,
    )
    .join("\n\n");

  if (memoryRows.length > 0) {
    await db.query(
      `UPDATE memory_entries SET last_referenced_at = now(), importance = LEAST(1.0, importance + 0.02) WHERE id = ANY($1::uuid[])`,
      [memoryRows.map((x: { id: string }) => x.id)],
    );
  }

  const filesContext = filesRows
    .map((row: { name: string; text_content: string }) => `文件: ${row.name}\n${String(row.text_content).slice(0, 2000)}`)
    .join("\n\n");

  const historyContext = historyRows
    .reverse()
    .map((row: { role: string; content: string }) => `${row.role === "user" ? "用户" : "助手"}: ${row.content}`)
    .join("\n");

  const wikiContext = `${memoryContext}\n${filesContext}\n${historyContext}`;
  const contextCoverage = estimateContextCoverage(content, wikiContext);
  const needsExternalValidation =
    forceWeb === true ||
    shouldSearchWeb(content, settings?.auto_web ?? true) ||
    contextCoverage < 0.18;

  const webEnabled = memoryOnlyMode ? false : needsExternalValidation;
  let webSources: SourceItem[] = [];
  if (webEnabled && tavilyKey) {
    try {
      webSources = await tavilySearch(content, tavilyKey);
    } catch {
      webSources = [];
    }
  }

  const realtimeEnabled = !memoryOnlyMode && (needsExternalValidation || /https?:\/\//i.test(content));
  const realtime = realtimeEnabled ? await buildRealtimeContext(content) : { context: "", sources: [] as SourceItem[] };
  const allSources = mergeSources(webSources, realtime.sources);
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
        `联网结果:\n${memoryOnlyMode ? "(记忆优先模式已禁用联网)" : sourcesToContext(allSources) || "(未联网或无结果)"}\n\n` +
        `实时信息提取:\n${memoryOnlyMode ? "(记忆优先模式已禁用实时外部信息)" : realtime.context || "(无)"}\n\n` +
        `上下文覆盖度(用于判断是否需外部补证): ${(contextCoverage * 100).toFixed(1)}%`,
    },
    { role: "user" as const, content },
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
      hasSources: allSources.length > 0,
      hasFiles: filesRows.length > 0,
      provider: reply.provider,
    }) as "high" | "medium" | "low";
  } catch (error) {
    assistantText = `本次回答失败：${String(error)}`;
    confidenceLevel = "low";
  }

  if (!Number.isFinite(totalTokens) || totalTokens < 0) totalTokens = 0;
  if (!Number.isFinite(promptTokens) || promptTokens < 0) promptTokens = 0;
  if (!Number.isFinite(completionTokens) || completionTokens < 0) completionTokens = 0;

  const enableMindmap = settings?.auto_mindmap ?? true;
  const mindmapPrompt = enableMindmap
    ? buildMindmapPrompt({
        conversationTitle: String(convoRows[0]?.title || ""),
        userQuestion: content,
        assistantAnswer: assistantText,
      })
    : null;
  const mindmapUrl = mindmapPrompt ? buildPollinationsMindmapUrl(mindmapPrompt) : null;

  const assistantInsert = await db.query(
    `
      INSERT INTO messages (
        conversation_id, user_id, role, content, model_provider, model_id, thinking_seconds,
        prompt_tokens, completion_tokens, total_tokens, web_used, files_used, confidence_level, sources, mindmap_url, mindmap_prompt
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
      filesRows.length > 0,
      confidenceLevel,
      JSON.stringify(allSources),
      mindmapUrl,
      mindmapPrompt,
    ],
  );

  const safeSideEffect = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      console.error(`[messages] side-effect failed: ${label}`, error);
    }
  };

  await safeSideEffect("model_call_logs", async () => {
    await db.query(
      `
        INSERT INTO model_call_logs (user_id, provider, model_id, success, switched)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [user.userId, provider || null, model || null, Boolean(provider && model), failedAttempts > 0],
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
      userMessageId: Number(userInsert.rows[0].id),
      userMessage: content,
      systemPrompt: settings?.system_prompt || "",
    });
  });

  await safeSideEffect("experience", async () => {
    await saveConversationExperience({
      userId: user.userId,
      conversationId: id,
      userMessageId: Number(userInsert.rows[0].id),
      userMessage: content,
      assistantMessage: assistantText,
    });
  });

  const payload = {
    userMessageId: Number(userInsert.rows[0].id),
    assistantMessageId: Number(assistantInsert.rows[0].id),
    content: assistantText,
    modelProvider: provider || null,
    modelId: model || null,
    thinkingSeconds,
    webUsed: webEnabled || Boolean(realtime.context),
    filesUsed: filesRows.length > 0,
    confidenceLevel,
    mindmapUrl,
    mindmapPrompt,
    sources: allSources,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens,
    },
  };

  if (stream) {
    return new Response(streamAssistantPayload(payload), {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  return NextResponse.json({
    userMessageId: payload.userMessageId,
    assistantMessageId: payload.assistantMessageId,
    assistant: {
      content: payload.content,
      modelProvider: payload.modelProvider,
      modelId: payload.modelId,
      thinkingSeconds: payload.thinkingSeconds,
      webUsed: payload.webUsed,
      filesUsed: payload.filesUsed,
      confidenceLevel: payload.confidenceLevel,
      mindmapUrl: payload.mindmapUrl,
      mindmapPrompt: payload.mindmapPrompt,
      sources: payload.sources,
      usage: payload.usage,
    },
  });
}
