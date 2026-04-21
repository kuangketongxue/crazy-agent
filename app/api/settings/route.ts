import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { REQUIRED_SKILLS } from "@/lib/skills";
import { normalizeApiKey } from "@/lib/secrets";

const schema = z.object({
  systemPrompt: z.string().max(8000).optional(),
  autoWeb: z.boolean().optional(),
  memoryOnlyMode: z.boolean().optional(),
  voiceEnabled: z.boolean().optional(),
  autoMindmap: z.boolean().optional(),
  openrouterKey: z.string().optional().nullable(),
  nvidiaKey: z.string().optional().nullable(),
  googleKey: z.string().optional().nullable(),
  tavilyKey: z.string().optional().nullable(),
  enabledSkills: z.array(z.string().min(1)).optional(),
  openrouterModels: z.array(z.string().min(1)).optional(),
  nvidiaModels: z.array(z.string().min(1)).optional(),
  googleModels: z.array(z.string().min(1)).optional(),
  openrouterModelSwitches: z.record(z.string(), z.boolean()).optional(),
  nvidiaModelSwitches: z.record(z.string(), z.boolean()).optional(),
  googleModelSwitches: z.record(z.string(), z.boolean()).optional(),
});

function normalizeModelId(id: string) {
  return String(id || "").trim();
}

function sanitizeModelList(list: string[]) {
  const blocked = [/minimax.*m2\.5:free/i, /nemotron-3-super-120b.*:free/i];
  return [...new Set((list || []).map((x) => normalizeModelId(String(x || "").trim())).filter(Boolean))].filter(
    (id) => !blocked.some((p) => p.test(id)),
  );
}

function prioritizeNvidiaModels(list: string[]) {
  const priority = ["minimaxai/minimax-m2.7", "z-ai/glm-5.1"];
  const normalized = sanitizeModelList(list);
  const front = priority.filter((id) => normalized.includes(id));
  const rest = normalized.filter((id) => !front.includes(id));
  return [...front, ...rest];
}

function prioritizeOpenrouterModels(list: string[]) {
  const priority = ["google/gemma-4-31b-it:free", "openai/gpt-oss-120b:free"];
  const normalized = sanitizeModelList(list);
  const front = priority.filter((id) => normalized.includes(id));
  const rest = normalized.filter((id) => !front.includes(id));
  return [...front, ...rest];
}

const DEFAULT_OPENROUTER_MODELS = ["google/gemma-4-31b-it:free", "openai/gpt-oss-120b:free"];
const DEFAULT_NVIDIA_MODELS = ["minimaxai/minimax-m2.7", "z-ai/glm-5.1"];
const DEFAULT_GOOGLE_MODELS = ["gemini-2.5-flash"];

export async function GET() {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const { rows } = await db.query(
    `SELECT system_prompt, auto_web, memory_only_mode, voice_enabled, auto_mindmap, openrouter_key, nvidia_key, google_key, tavily_key, enabled_skills, openrouter_models, nvidia_models, google_models, openrouter_model_switches, nvidia_model_switches, google_model_switches, updated_at FROM user_settings WHERE user_id = $1`,
    [user.userId],
  );

  return NextResponse.json({ settings: rows[0] });
}

export async function PUT(request: Request) {
  try {
    const user = await requireAuth();
    if (user instanceof NextResponse) {
      return user;
    }

    const body = await request.json().catch(() => ({}));
    const parsed = schema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: "参数错误" }, { status: 400 });
    }

    const payload = parsed.data;
    const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
    const hasOpenrouterKey = has("openrouterKey");
    const hasNvidiaKey = has("nvidiaKey");
    const hasGoogleKey = has("googleKey");
    const hasTavilyKey = has("tavilyKey");
    const hasOpenrouterModels = has("openrouterModels");
    const hasNvidiaModels = has("nvidiaModels");
    const hasGoogleModels = has("googleModels");
    const hasOpenrouterModelSwitches = has("openrouterModelSwitches");
    const hasNvidiaModelSwitches = has("nvidiaModelSwitches");
    const hasGoogleModelSwitches = has("googleModelSwitches");

    const { rows: existingRows } = await db.query(
      `SELECT system_prompt, auto_web, memory_only_mode, voice_enabled, auto_mindmap, enabled_skills, openrouter_key, nvidia_key, google_key, tavily_key, openrouter_models, nvidia_models, google_models, openrouter_model_switches, nvidia_model_switches, google_model_switches FROM user_settings WHERE user_id = $1 LIMIT 1`,
      [user.userId],
    );
    const existing = existingRows[0] || {};
    const enabledSkills = payload.enabledSkills && payload.enabledSkills.length
      ? payload.enabledSkills
      : (Array.isArray(existing.enabled_skills) && existing.enabled_skills.length
        ? existing.enabled_skills
        : REQUIRED_SKILLS.map((s) => s.id));
    const currentOpenrouterModels = prioritizeOpenrouterModels(Array.isArray(existing.openrouter_models) ? existing.openrouter_models : []);
    const currentNvidiaModels = prioritizeNvidiaModels(Array.isArray(existing.nvidia_models) ? existing.nvidia_models : []);
    const currentGoogleModels = sanitizeModelList(Array.isArray(existing.google_models) ? existing.google_models : []);
    const requestedOpenrouterModels = prioritizeOpenrouterModels(payload.openrouterModels || []);
    const requestedNvidiaModels = prioritizeNvidiaModels(payload.nvidiaModels || []);
    const requestedGoogleModels = sanitizeModelList(payload.googleModels || []);

    let finalOpenrouterModels = hasOpenrouterModels
      ? (requestedOpenrouterModels.length ? requestedOpenrouterModels : currentOpenrouterModels)
      : currentOpenrouterModels;
    let finalNvidiaModels = hasNvidiaModels
      ? (requestedNvidiaModels.length ? requestedNvidiaModels : currentNvidiaModels)
      : currentNvidiaModels;
    let finalGoogleModels = hasGoogleModels
      ? (requestedGoogleModels.length ? requestedGoogleModels : currentGoogleModels)
      : currentGoogleModels;

    if (!finalOpenrouterModels.length) finalOpenrouterModels = [...DEFAULT_OPENROUTER_MODELS];
    if (!finalNvidiaModels.length) finalNvidiaModels = [...DEFAULT_NVIDIA_MODELS];
    if (!finalGoogleModels.length) finalGoogleModels = [...DEFAULT_GOOGLE_MODELS];

    const normalizedOpenrouter = normalizeApiKey(payload.openrouterKey);
    const normalizedNvidia = normalizeApiKey(payload.nvidiaKey);
    const normalizedGoogle = normalizeApiKey(payload.googleKey);
    const normalizedTavily = normalizeApiKey(payload.tavilyKey);
    const finalOpenrouterKey = hasOpenrouterKey
      ? (normalizedOpenrouter || normalizeApiKey(existing.openrouter_key) || null)
      : (normalizeApiKey(existing.openrouter_key) || null);
    const finalNvidiaKey = hasNvidiaKey
      ? (normalizedNvidia || normalizeApiKey(existing.nvidia_key) || null)
      : (normalizeApiKey(existing.nvidia_key) || null);
    const finalGoogleKey = hasGoogleKey
      ? (normalizedGoogle || normalizeApiKey(existing.google_key) || null)
      : (normalizeApiKey(existing.google_key) || null);
    const finalTavilyKey = hasTavilyKey
      ? (normalizedTavily || normalizeApiKey(existing.tavily_key) || null)
      : (normalizeApiKey(existing.tavily_key) || null);

    const finalSystemPrompt = has("systemPrompt") ? (payload.systemPrompt ?? "") : String(existing.system_prompt || "");
    const finalAutoWeb = has("autoWeb") ? Boolean(payload.autoWeb) : Boolean(existing.auto_web ?? true);
    const finalMemoryOnlyMode = has("memoryOnlyMode")
      ? Boolean(payload.memoryOnlyMode)
      : Boolean(existing.memory_only_mode ?? false);
    const finalVoiceEnabled = has("voiceEnabled") ? Boolean(payload.voiceEnabled) : Boolean(existing.voice_enabled ?? true);
    const finalAutoMindmap = has("autoMindmap") ? Boolean(payload.autoMindmap) : Boolean(existing.auto_mindmap ?? true);
    const modelSwitchesFrom = (input: unknown, models: string[], existingMap: Record<string, boolean>) => {
      const base: Record<string, boolean> = {};
      for (const model of models) {
        if (Object.prototype.hasOwnProperty.call(existingMap, model)) {
          base[model] = Boolean(existingMap[model]);
        } else {
          base[model] = true;
        }
      }
      if (input && typeof input === "object" && !Array.isArray(input)) {
        for (const model of models) {
          if (Object.prototype.hasOwnProperty.call(input, model)) {
            base[model] = Boolean((input as Record<string, unknown>)[model]);
          }
        }
      }
      return base;
    };
    const currentOpenrouterSwitches =
      existing.openrouter_model_switches && typeof existing.openrouter_model_switches === "object"
        ? (existing.openrouter_model_switches as Record<string, boolean>)
        : {};
    const currentNvidiaSwitches =
      existing.nvidia_model_switches && typeof existing.nvidia_model_switches === "object"
        ? (existing.nvidia_model_switches as Record<string, boolean>)
        : {};
    const currentGoogleSwitches =
      existing.google_model_switches && typeof existing.google_model_switches === "object"
        ? (existing.google_model_switches as Record<string, boolean>)
        : {};
    const finalOpenrouterSwitches = modelSwitchesFrom(
      hasOpenrouterModelSwitches ? payload.openrouterModelSwitches : null,
      finalOpenrouterModels,
      currentOpenrouterSwitches,
    );
    const finalNvidiaSwitches = modelSwitchesFrom(
      hasNvidiaModelSwitches ? payload.nvidiaModelSwitches : null,
      finalNvidiaModels,
      currentNvidiaSwitches,
    );
    const finalGoogleSwitches = modelSwitchesFrom(
      hasGoogleModelSwitches ? payload.googleModelSwitches : null,
      finalGoogleModels,
      currentGoogleSwitches,
    );

    await db.query(
      `
      INSERT INTO user_settings (
        user_id, system_prompt, auto_web, memory_only_mode, voice_enabled, auto_mindmap,
        openrouter_key, nvidia_key, google_key, tavily_key, enabled_skills, openrouter_models, nvidia_models, google_models, openrouter_model_switches, nvidia_model_switches, google_model_switches, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, now())
      ON CONFLICT (user_id)
      DO UPDATE SET
        system_prompt = EXCLUDED.system_prompt,
        auto_web = EXCLUDED.auto_web,
        memory_only_mode = EXCLUDED.memory_only_mode,
        voice_enabled = EXCLUDED.voice_enabled,
        auto_mindmap = EXCLUDED.auto_mindmap,
        openrouter_key = EXCLUDED.openrouter_key,
        nvidia_key = EXCLUDED.nvidia_key,
        google_key = EXCLUDED.google_key,
        tavily_key = EXCLUDED.tavily_key,
        enabled_skills = EXCLUDED.enabled_skills,
        openrouter_models = EXCLUDED.openrouter_models,
        nvidia_models = EXCLUDED.nvidia_models,
        google_models = EXCLUDED.google_models,
        openrouter_model_switches = EXCLUDED.openrouter_model_switches,
        nvidia_model_switches = EXCLUDED.nvidia_model_switches,
        google_model_switches = EXCLUDED.google_model_switches,
        updated_at = now()
      `,
      [
        user.userId,
        finalSystemPrompt,
        finalAutoWeb,
        finalMemoryOnlyMode,
        finalVoiceEnabled,
        finalAutoMindmap,
        finalOpenrouterKey,
        finalNvidiaKey,
        finalGoogleKey,
        finalTavilyKey,
        JSON.stringify(enabledSkills),
        JSON.stringify(finalOpenrouterModels),
        JSON.stringify(finalNvidiaModels),
        JSON.stringify(finalGoogleModels),
        JSON.stringify(finalOpenrouterSwitches),
        JSON.stringify(finalNvidiaSwitches),
        JSON.stringify(finalGoogleSwitches),
      ],
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: `保存失败: ${String(error)}` }, { status: 500 });
  }
}
