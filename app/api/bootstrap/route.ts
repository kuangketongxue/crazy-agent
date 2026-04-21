import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db, isAdminUser } from "@/lib/db";
import { REQUIRED_SKILLS } from "@/lib/skills";

export async function GET() {
  const user = await requireAuth();
  if (user instanceof NextResponse) {
    return user;
  }

  const { rows: settingsRows } = await db.query(
    `SELECT system_prompt, auto_web, memory_only_mode, voice_enabled, auto_mindmap, openrouter_key, nvidia_key, google_key, tavily_key, enabled_skills, openrouter_models, nvidia_models, google_models, openrouter_model_switches, nvidia_model_switches, google_model_switches, updated_at FROM user_settings WHERE user_id = $1`,
    [user.userId],
  );

  const { rows: usageRows } = await db.query(
    `
      SELECT
        COALESCE(SUM(prompt_tokens) FILTER (
          WHERE role = 'assistant'
            AND (timezone('Asia/Shanghai', created_at))::date = (timezone('Asia/Shanghai', now()))::date
        ), 0) AS today_prompt_tokens,
        COALESCE(SUM(completion_tokens) FILTER (
          WHERE role = 'assistant'
            AND (timezone('Asia/Shanghai', created_at))::date = (timezone('Asia/Shanghai', now()))::date
        ), 0) AS today_completion_tokens,
        COALESCE(SUM(total_tokens) FILTER (
          WHERE role = 'assistant'
            AND (timezone('Asia/Shanghai', created_at))::date = (timezone('Asia/Shanghai', now()))::date
        ), 0) AS today_total_tokens,
        COALESCE(SUM(prompt_tokens) FILTER (WHERE role = 'assistant'), 0) AS all_prompt_tokens,
        COALESCE(SUM(completion_tokens) FILTER (WHERE role = 'assistant'), 0) AS all_completion_tokens,
        COALESCE(SUM(total_tokens) FILTER (WHERE role = 'assistant'), 0) AS all_total_tokens
      FROM messages
      WHERE user_id = $1
    `,
    [user.userId],
  );
  const row = usageRows[0] || {};

  const { rows: qualityRows } = await db.query(
    `
      SELECT
        COALESCE(AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END), 1.0) AS availability_24h,
        COALESCE(
          AVG(CASE WHEN switched THEN CASE WHEN success THEN 1.0 ELSE 0.0 END END),
          1.0
        ) AS switch_success_24h
      FROM model_call_logs
      WHERE user_id = $1 AND created_at >= now() - interval '24 hours'
    `,
    [user.userId],
  );
  const quality = qualityRows[0] || {};
  const isAdmin = await isAdminUser(user);
  const { rows: announcementRows } = await db.query(
    `SELECT content, updated_at, updated_by FROM system_announcements WHERE id = 1 LIMIT 1`,
  );
  await db.query(`INSERT INTO user_pet_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [user.userId]);
  const { rows: petRows } = await db.query(
    `SELECT species, name, mood, energy, rarity, trait_focus, trait_weakness, attributes, level, xp, last_interacted_at, updated_at FROM user_pet_state WHERE user_id = $1 LIMIT 1`,
    [user.userId],
  );

  return NextResponse.json({
    profile: {
      userId: user.userId,
      email: user.email,
      isAdmin,
    },
    settings: settingsRows[0] || {
      system_prompt: "",
      auto_web: true,
      memory_only_mode: false,
      voice_enabled: true,
      auto_mindmap: true,
      openrouter_key: null,
      nvidia_key: null,
      google_key: null,
      tavily_key: null,
      enabled_skills: REQUIRED_SKILLS.map((s) => s.id),
      openrouter_models: ["google/gemma-4-31b-it:free", "openai/gpt-oss-120b:free"],
      nvidia_models: ["minimaxai/minimax-m2.7", "z-ai/glm-5.1"],
      google_models: ["gemini-2.5-flash"],
      openrouter_model_switches: {},
      nvidia_model_switches: {},
      google_model_switches: {},
      updated_at: null,
    },
    usage: {
      today: {
        prompt_tokens: Number(row.today_prompt_tokens || 0),
        completion_tokens: Number(row.today_completion_tokens || 0),
        total_tokens: Number(row.today_total_tokens || 0),
      },
      total: {
        prompt_tokens: Number(row.all_prompt_tokens || 0),
        completion_tokens: Number(row.all_completion_tokens || 0),
        total_tokens: Number(row.all_total_tokens || 0),
      },
    },
    quality: {
      availability24h: Math.round(Number(quality.availability_24h || 1) * 10000) / 100,
      switchSuccess24h: Math.round(Number(quality.switch_success_24h || 1) * 10000) / 100,
    },
    announcement: announcementRows[0] || { content: "", updated_at: null, updated_by: null },
    pet: petRows[0] || {
      species: "cat",
      name: "Mochi",
      mood: "idle",
      energy: 80,
      rarity: "rare",
      trait_focus: "wisdom",
      trait_weakness: "snark",
      attributes: { debugging: 55, patience: 50, chaos: 40, wisdom: 58, snark: 35 },
      level: 1,
      xp: 0,
      last_interacted_at: null,
    },
  });
}


