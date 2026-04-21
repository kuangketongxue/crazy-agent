import { Pool, type PoolClient } from "pg";
import { CHANGELOG_SEEDS } from "./changelog";

declare global {
  // eslint-disable-next-line no-var
  var __dbPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __dbReady: boolean | undefined;
}

function requireEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export const db =
  global.__dbPool ??
  new Pool({
    connectionString: requireEnv("DATABASE_URL"),
    ssl: { rejectUnauthorized: false },
  });

if (process.env.NODE_ENV !== "production") {
  global.__dbPool = db;
}

export async function ensureDbReady() {
  if (global.__dbReady) {
    return;
  }

  await db.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      user_id TEXT PRIMARY KEY,
      email TEXT,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
      blocked_reason TEXT,
      blocked_at TIMESTAMPTZ,
      is_legacy BOOLEAN NOT NULL DEFAULT FALSE,
      merged_into_user_id TEXT REFERENCES profiles(user_id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE;`);
  await db.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS blocked_reason TEXT;`);
  await db.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_legacy BOOLEAN NOT NULL DEFAULT FALSE;`);
  await db.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS merged_into_user_id TEXT REFERENCES profiles(user_id) ON DELETE SET NULL;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS profile_merge_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_user_id TEXT NOT NULL,
      to_user_id TEXT NOT NULL,
      email TEXT,
      merged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      note TEXT
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
      system_prompt TEXT NOT NULL DEFAULT '',
      auto_web BOOLEAN NOT NULL DEFAULT TRUE,
      memory_only_mode BOOLEAN NOT NULL DEFAULT FALSE,
      voice_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      openrouter_key TEXT,
      nvidia_key TEXT,
      google_key TEXT,
      tavily_key TEXT,
      enabled_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
      openrouter_models JSONB NOT NULL DEFAULT '["google/gemma-4-31b-it:free","openai/gpt-oss-120b:free"]'::jsonb,
      nvidia_models JSONB NOT NULL DEFAULT '["z-ai/glm-5.1","minimaxai/minimax-m2.7"]'::jsonb,
      google_models JSONB NOT NULL DEFAULT '["gemini-2.5-flash"]'::jsonb,
      openrouter_model_switches JSONB NOT NULL DEFAULT '{}'::jsonb,
      nvidia_model_switches JSONB NOT NULL DEFAULT '{}'::jsonb,
      google_model_switches JSONB NOT NULL DEFAULT '{}'::jsonb,
      model_rotation_cursor INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS system_prompt TEXT NOT NULL DEFAULT '';`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS auto_web BOOLEAN NOT NULL DEFAULT TRUE;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS memory_only_mode BOOLEAN NOT NULL DEFAULT FALSE;`);
  await db.query(`ALTER TABLE user_settings ALTER COLUMN memory_only_mode SET DEFAULT FALSE;`);
  await db.query(`UPDATE user_settings SET memory_only_mode = FALSE WHERE memory_only_mode IS NULL;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS voice_enabled BOOLEAN NOT NULL DEFAULT TRUE;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS openrouter_key TEXT;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS nvidia_key TEXT;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS google_key TEXT;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS tavily_key TEXT;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS enabled_skills JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS openrouter_models JSONB NOT NULL DEFAULT '["google/gemma-4-31b-it:free","openai/gpt-oss-120b:free"]'::jsonb;`);
  await db.query(`
    UPDATE user_settings
    SET openrouter_models = (
      SELECT to_jsonb(array_agg(CASE WHEN value = 'openroute/free' THEN 'openai/gpt-oss-120b:free' ELSE value END))
      FROM jsonb_array_elements_text(COALESCE(user_settings.openrouter_models, '[]'::jsonb)) AS t(value)
    )
    WHERE user_settings.openrouter_models::text LIKE '%openroute/free%'
  `);
  await db.query(`
    UPDATE user_settings
    SET openrouter_models = (
      SELECT to_jsonb(
        ARRAY(
          SELECT DISTINCT m
          FROM unnest(ARRAY['google/gemma-4-31b-it:free']::text[] || COALESCE(ARRAY(
            SELECT jsonb_array_elements_text(COALESCE(user_settings.openrouter_models, '[]'::jsonb))
          ), ARRAY[]::text[])) AS m
          WHERE m IS NOT NULL
            AND m <> ''
            AND m !~* 'minimax.*m2\\.5:free'
        )
      )
    )
    WHERE user_settings.openrouter_models IS NOT NULL;
  `);
  await db.query(
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS nvidia_models JSONB NOT NULL DEFAULT '["z-ai/glm-5.1","minimaxai/minimax-m2.7"]'::jsonb;`,
  );
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS google_models JSONB NOT NULL DEFAULT '["gemini-2.5-flash"]'::jsonb;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS openrouter_model_switches JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS nvidia_model_switches JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS google_model_switches JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS model_rotation_cursor INT NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS auto_mindmap BOOLEAN NOT NULL DEFAULT TRUE;`);
  await db.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT FALSE;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      model_provider TEXT,
      model_id TEXT,
      thinking_seconds NUMERIC(10, 3),
      prompt_tokens INT NOT NULL DEFAULT 0,
      completion_tokens INT NOT NULL DEFAULT 0,
      total_tokens INT NOT NULL DEFAULT 0,
      web_used BOOLEAN NOT NULL DEFAULT FALSE,
      files_used BOOLEAN NOT NULL DEFAULT FALSE,
      uploaded_file_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      confidence_level TEXT NOT NULL DEFAULT 'medium',
      sources JSONB NOT NULL DEFAULT '[]'::jsonb,
      mindmap_url TEXT,
      mindmap_prompt TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS model_provider TEXT;`);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS model_id TEXT;`);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS thinking_seconds NUMERIC(10, 3);`);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS prompt_tokens INT NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS completion_tokens INT NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS total_tokens INT NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS web_used BOOLEAN NOT NULL DEFAULT FALSE;`);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS files_used BOOLEAN NOT NULL DEFAULT FALSE;`);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS uploaded_file_ids JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS confidence_level TEXT NOT NULL DEFAULT 'medium';`);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS sources JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS mindmap_url TEXT;`);
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS mindmap_prompt TEXT;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS uploaded_files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      content_type TEXT,
      text_content TEXT NOT NULL,
      line_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS line_count INT NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      entry_type TEXT NOT NULL DEFAULT 'note',
      status TEXT NOT NULL DEFAULT 'valid',
      importance NUMERIC(6,3) NOT NULL DEFAULT 0.5,
      last_referenced_at TIMESTAMPTZ,
      source_pointer TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'valid';`);
  await db.query(`ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS importance NUMERIC(6,3) NOT NULL DEFAULT 0.5;`);
  await db.query(`ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS last_referenced_at TIMESTAMPTZ;`);
  await db.query(`
    WITH ranked AS (
      SELECT
        id,
        source_pointer,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, source_pointer
          ORDER BY updated_at DESC, created_at DESC, id DESC
        ) AS rn
      FROM memory_entries
      WHERE source_pointer IS NOT NULL
    )
    UPDATE memory_entries m
    SET
      source_pointer = CONCAT(r.source_pointer, '#dup:', LEFT(m.id::text, 8)),
      status = CASE WHEN m.status = 'valid' THEN 'outdated' ELSE m.status END,
      updated_at = now()
    FROM ranked r
    WHERE m.id = r.id
      AND r.rn > 1;
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_user_source_pointer_unique ON memory_entries(user_id, source_pointer) WHERE source_pointer IS NOT NULL;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS diary_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      diary_date DATE NOT NULL,
      success_journal TEXT NOT NULL DEFAULT '',
      money_journal TEXT NOT NULL DEFAULT '',
      gaokao_journal TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, diary_date)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS custom_skills (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      prompt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, skill_id)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      key_conclusion TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS model_call_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      provider TEXT,
      model_id TEXT,
      success BOOLEAN NOT NULL DEFAULT TRUE,
      switched BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS answer_feedback (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      feedback TEXT NOT NULL CHECK (feedback IN ('up', 'down')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, message_id)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_schedule_state (
      user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
      last_study_prompt_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS system_announcements (
      id SMALLINT PRIMARY KEY DEFAULT 1,
      content TEXT NOT NULL DEFAULT '',
      updated_by TEXT REFERENCES profiles(user_id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    INSERT INTO system_announcements (id, content)
    VALUES (1, '欢迎使用 Crazy Agent。你可以在这里用长期记忆、文件融合与联网证据来高效学习和决策。')
    ON CONFLICT (id) DO NOTHING;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_pet_state (
      user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
      species TEXT NOT NULL DEFAULT 'cat',
      name TEXT NOT NULL DEFAULT 'Mochi',
      mood TEXT NOT NULL DEFAULT 'idle',
      energy INT NOT NULL DEFAULT 80,
      rarity TEXT NOT NULL DEFAULT 'rare',
      trait_focus TEXT NOT NULL DEFAULT 'wisdom',
      trait_weakness TEXT NOT NULL DEFAULT 'snark',
      attributes JSONB NOT NULL DEFAULT '{"debugging":55,"patience":50,"chaos":40,"wisdom":58,"snark":35}'::jsonb,
      level INT NOT NULL DEFAULT 1,
      xp INT NOT NULL DEFAULT 0,
      last_interacted_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`ALTER TABLE user_pet_state ADD COLUMN IF NOT EXISTS species TEXT NOT NULL DEFAULT 'cat';`);
  await db.query(`ALTER TABLE user_pet_state ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'Mochi';`);
  await db.query(`ALTER TABLE user_pet_state ADD COLUMN IF NOT EXISTS mood TEXT NOT NULL DEFAULT 'idle';`);
  await db.query(`ALTER TABLE user_pet_state ADD COLUMN IF NOT EXISTS energy INT NOT NULL DEFAULT 80;`);
  await db.query(`ALTER TABLE user_pet_state ADD COLUMN IF NOT EXISTS rarity TEXT NOT NULL DEFAULT 'rare';`);
  await db.query(`ALTER TABLE user_pet_state ADD COLUMN IF NOT EXISTS trait_focus TEXT NOT NULL DEFAULT 'wisdom';`);
  await db.query(`ALTER TABLE user_pet_state ADD COLUMN IF NOT EXISTS trait_weakness TEXT NOT NULL DEFAULT 'snark';`);
  await db.query(
    `ALTER TABLE user_pet_state ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '{"debugging":55,"patience":50,"chaos":40,"wisdom":58,"snark":35}'::jsonb;`,
  );
  await db.query(`ALTER TABLE user_pet_state ADD COLUMN IF NOT EXISTS level INT NOT NULL DEFAULT 1;`);
  await db.query(`ALTER TABLE user_pet_state ADD COLUMN IF NOT EXISTS xp INT NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE user_pet_state ADD COLUMN IF NOT EXISTS last_interacted_at TIMESTAMPTZ;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS memory_entry_backups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source_entry_id UUID,
      source_user_id TEXT NOT NULL,
      backup_user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'valid',
      source_pointer TEXT,
      action TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
      usage_date DATE NOT NULL,
      prompt_tokens BIGINT NOT NULL DEFAULT 0,
      completion_tokens BIGINT NOT NULL DEFAULT 0,
      total_tokens BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, usage_date)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS usage_total (
      user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
      prompt_tokens BIGINT NOT NULL DEFAULT 0,
      completion_tokens BIGINT NOT NULL DEFAULT 0,
      total_tokens BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS change_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      release_key TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      details TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS study_reminder_state (
      user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
      last_asked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS nightly_memory_rollup_state (
      user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
      last_rollup_date DATE,
      last_run_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  for (const item of CHANGELOG_SEEDS) {
    await db.query(
      `
      INSERT INTO change_logs (release_key, title, details, changed_at)
      VALUES ($1, $2, $3, $4::timestamptz)
      ON CONFLICT (release_key)
      DO UPDATE SET
        title = EXCLUDED.title,
        details = EXCLUDED.details,
        changed_at = EXCLUDED.changed_at
      `,
      [item.releaseKey, item.title, item.details, item.changedAt],
    );
  }

  // Periodic low-value memory cleanup: mark stale and low-importance entries as outdated.
  await db.query(`
    UPDATE memory_entries
    SET status = 'outdated', updated_at = now()
    WHERE status <> 'outdated'
      AND COALESCE(last_referenced_at, updated_at, created_at) < now() - interval '90 days'
      AND importance < 0.3
  `);

  const autoReleaseKey =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
    process.env.VERCEL_URL?.trim();
  if (autoReleaseKey) {
    await db.query(
      `
      INSERT INTO change_logs (release_key, title, details, changed_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (release_key) DO NOTHING
      `,
      [
        `auto-${autoReleaseKey}`,
        "自动部署更新",
        "系统检测到新部署，已自动写入一条更新记录。后续可在设置-更新日志中查看。",
      ],
    );
  }

  global.__dbReady = true;
}

export type AuthUser = {
  userId: string;
  email: string | null;
};

export const PRIMARY_ADMIN_EMAIL = "kuangketongxue@gmail.com";
const RECOVERY_EMAIL_ALIASES: Record<string, string[]> = {
  "kuangketongxue@gmail.com": ["19927675096@163.com", "2195633250@qq.com"],
  "19927675096@163.com": ["kuangketongxue@gmail.com", "2195633250@qq.com"],
  "2195633250@qq.com": ["kuangketongxue@gmail.com", "19927675096@163.com"],
};
const RECOVERY_SOURCE_USER_IDS: Record<string, string[]> = {
  "kuangketongxue@gmail.com": ["user_3BzpUiQ33Uak1i2nNbyMBQjo9Lj", "user_3BtLMBBTPzvlJmvLt3w0Q8wm7K6"],
  "19927675096@163.com": ["user_3BzpUiQ33Uak1i2nNbyMBQjo9Lj", "user_3BtLMBBTPzvlJmvLt3w0Q8wm7K6"],
  "2195633250@qq.com": ["user_3BzpUiQ33Uak1i2nNbyMBQjo9Lj", "user_3BtLMBBTPzvlJmvLt3w0Q8wm7K6"],
};

function normalizeEmail(email: string | null | undefined) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function buildRecoveryEmails(email: string | null | undefined) {
  const base = normalizeEmail(email);
  const aliases = RECOVERY_EMAIL_ALIASES[base] || [];
  return [...new Set([base, ...aliases].map((x) => normalizeEmail(x)).filter(Boolean))];
}

function isMergeEligibleUserId(userId: string) {
  return /^user_[A-Za-z0-9]+$/.test(String(userId || "").trim());
}

async function rebuildUsageFromMessages(client: PoolClient, userId: string) {
  await client.query(
    `
      INSERT INTO usage_daily (user_id, usage_date, prompt_tokens, completion_tokens, total_tokens)
      SELECT
        $1 AS user_id,
        (timezone('Asia/Shanghai', created_at))::date AS usage_date,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens
      FROM messages
      WHERE user_id = $1 AND role = 'assistant'
      GROUP BY (timezone('Asia/Shanghai', created_at))::date
      ON CONFLICT (user_id, usage_date)
      DO UPDATE SET
        prompt_tokens = GREATEST(usage_daily.prompt_tokens, EXCLUDED.prompt_tokens),
        completion_tokens = GREATEST(usage_daily.completion_tokens, EXCLUDED.completion_tokens),
        total_tokens = GREATEST(usage_daily.total_tokens, EXCLUDED.total_tokens)
    `,
    [userId],
  );

  await client.query(
    `
      INSERT INTO usage_total (user_id, prompt_tokens, completion_tokens, total_tokens, updated_at)
      SELECT
        $1,
        COALESCE(SUM(prompt_tokens), 0)::bigint,
        COALESCE(SUM(completion_tokens), 0)::bigint,
        COALESCE(SUM(total_tokens), 0)::bigint,
        now()
      FROM messages
      WHERE user_id = $1 AND role = 'assistant'
      ON CONFLICT (user_id)
      DO UPDATE SET
        prompt_tokens = GREATEST(usage_total.prompt_tokens, EXCLUDED.prompt_tokens),
        completion_tokens = GREATEST(usage_total.completion_tokens, EXCLUDED.completion_tokens),
        total_tokens = GREATEST(usage_total.total_tokens, EXCLUDED.total_tokens),
        updated_at = now()
    `,
    [userId],
  );
}

export function isDesignatedAdminEmail(email: string | null | undefined) {
  return normalizeEmail(email) === PRIMARY_ADMIN_EMAIL;
}

export async function isAdminUser(user: Pick<AuthUser, "userId" | "email">) {
  if (isDesignatedAdminEmail(user.email)) return true;
  const { rows } = await db.query(`SELECT email, is_admin FROM profiles WHERE user_id = $1 LIMIT 1`, [user.userId]);
  const row = rows[0] as { email?: string | null; is_admin?: boolean } | undefined;
  return Boolean(row?.is_admin) || isDesignatedAdminEmail(row?.email || null);
}

export async function getUserBlockState(userId: string): Promise<{ blocked: boolean; reason: string | null }> {
  const { rows } = await db.query(`SELECT is_blocked, blocked_reason FROM profiles WHERE user_id = $1 LIMIT 1`, [userId]);
  const row = rows[0] as { is_blocked?: boolean; blocked_reason?: string | null } | undefined;
  return {
    blocked: Boolean(row?.is_blocked),
    reason: row?.blocked_reason || null,
  };
}

async function mergeUserDataById(
  client: PoolClient,
  nextUserId: string,
  nextEmail: string | null,
  oldUserId: string,
  oldCreatedAt: Date,
) {
  if (nextUserId === oldUserId) return;

  await client.query(
    `
      INSERT INTO profiles (user_id, email, created_at, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (user_id)
      DO UPDATE SET
        email = COALESCE(EXCLUDED.email, profiles.email),
        created_at = LEAST(profiles.created_at, EXCLUDED.created_at),
        updated_at = now()
    `,
    [nextUserId, nextEmail, oldCreatedAt],
  );

  await client.query(
    `
      INSERT INTO user_settings (
        user_id,
        system_prompt,
        auto_web,
        auto_mindmap,
        memory_only_mode,
        voice_enabled,
        openrouter_key,
        nvidia_key,
        google_key,
        tavily_key,
        enabled_skills,
        openrouter_models,
        nvidia_models,
        google_models,
        openrouter_model_switches,
        nvidia_model_switches,
        google_model_switches,
        model_rotation_cursor,
        updated_at
      )
      SELECT
        $1,
        system_prompt,
        auto_web,
        auto_mindmap,
        memory_only_mode,
        voice_enabled,
        openrouter_key,
        nvidia_key,
        google_key,
        tavily_key,
        enabled_skills,
        openrouter_models,
        nvidia_models,
        google_models,
        openrouter_model_switches,
        nvidia_model_switches,
        google_model_switches,
        model_rotation_cursor,
        now()
      FROM user_settings
      WHERE user_id = $2
      ON CONFLICT (user_id)
      DO UPDATE SET
        system_prompt = CASE
          WHEN EXCLUDED.system_prompt IS NOT NULL AND EXCLUDED.system_prompt <> '' THEN EXCLUDED.system_prompt
          ELSE user_settings.system_prompt
        END,
        auto_web = EXCLUDED.auto_web,
        auto_mindmap = EXCLUDED.auto_mindmap,
        memory_only_mode = COALESCE(EXCLUDED.memory_only_mode, user_settings.memory_only_mode),
        voice_enabled = COALESCE(EXCLUDED.voice_enabled, user_settings.voice_enabled),
        openrouter_key = COALESCE(EXCLUDED.openrouter_key, user_settings.openrouter_key),
        nvidia_key = COALESCE(EXCLUDED.nvidia_key, user_settings.nvidia_key),
        google_key = COALESCE(EXCLUDED.google_key, user_settings.google_key),
        tavily_key = COALESCE(EXCLUDED.tavily_key, user_settings.tavily_key),
        enabled_skills = CASE
          WHEN jsonb_typeof(EXCLUDED.enabled_skills) = 'array' AND jsonb_array_length(EXCLUDED.enabled_skills) > 0
            THEN EXCLUDED.enabled_skills
          ELSE user_settings.enabled_skills
        END,
        openrouter_models = CASE
          WHEN jsonb_typeof(EXCLUDED.openrouter_models) = 'array' AND jsonb_array_length(EXCLUDED.openrouter_models) > 0
            THEN EXCLUDED.openrouter_models
          ELSE user_settings.openrouter_models
        END,
        nvidia_models = CASE
          WHEN jsonb_typeof(EXCLUDED.nvidia_models) = 'array' AND jsonb_array_length(EXCLUDED.nvidia_models) > 0
            THEN EXCLUDED.nvidia_models
          ELSE user_settings.nvidia_models
        END,
        google_models = CASE
          WHEN jsonb_typeof(EXCLUDED.google_models) = 'array' AND jsonb_array_length(EXCLUDED.google_models) > 0
            THEN EXCLUDED.google_models
          ELSE user_settings.google_models
        END,
        openrouter_model_switches = CASE
          WHEN jsonb_typeof(EXCLUDED.openrouter_model_switches) = 'object' THEN EXCLUDED.openrouter_model_switches
          ELSE user_settings.openrouter_model_switches
        END,
        nvidia_model_switches = CASE
          WHEN jsonb_typeof(EXCLUDED.nvidia_model_switches) = 'object' THEN EXCLUDED.nvidia_model_switches
          ELSE user_settings.nvidia_model_switches
        END,
        google_model_switches = CASE
          WHEN jsonb_typeof(EXCLUDED.google_model_switches) = 'object' THEN EXCLUDED.google_model_switches
          ELSE user_settings.google_model_switches
        END,
        model_rotation_cursor = GREATEST(user_settings.model_rotation_cursor, EXCLUDED.model_rotation_cursor),
        updated_at = now()
    `,
    [nextUserId, oldUserId],
  );

  await client.query(
    `
      INSERT INTO usage_total (user_id, prompt_tokens, completion_tokens, total_tokens, updated_at)
      SELECT $1, prompt_tokens, completion_tokens, total_tokens, now()
      FROM usage_total
      WHERE user_id = $2
      ON CONFLICT (user_id)
      DO UPDATE SET
        prompt_tokens = usage_total.prompt_tokens + EXCLUDED.prompt_tokens,
        completion_tokens = usage_total.completion_tokens + EXCLUDED.completion_tokens,
        total_tokens = usage_total.total_tokens + EXCLUDED.total_tokens,
        updated_at = now()
    `,
    [nextUserId, oldUserId],
  );

  await client.query(
    `
      INSERT INTO usage_daily (user_id, usage_date, prompt_tokens, completion_tokens, total_tokens)
      SELECT $1, usage_date, prompt_tokens, completion_tokens, total_tokens
      FROM usage_daily
      WHERE user_id = $2
      ON CONFLICT (user_id, usage_date)
      DO UPDATE SET
        prompt_tokens = usage_daily.prompt_tokens + EXCLUDED.prompt_tokens,
        completion_tokens = usage_daily.completion_tokens + EXCLUDED.completion_tokens,
        total_tokens = usage_daily.total_tokens + EXCLUDED.total_tokens
    `,
    [nextUserId, oldUserId],
  );

  await client.query(`UPDATE conversations SET user_id = $1 WHERE user_id = $2`, [nextUserId, oldUserId]);
  await client.query(`UPDATE messages SET user_id = $1 WHERE user_id = $2`, [nextUserId, oldUserId]);
  await client.query(`UPDATE uploaded_files SET user_id = $1 WHERE user_id = $2`, [nextUserId, oldUserId]);
  await client.query(
    `
      INSERT INTO memory_entries (
        user_id, title, content, entry_type, status, importance, last_referenced_at, source_pointer, created_at, updated_at
      )
      SELECT
        $1, title, content, entry_type, status, importance, last_referenced_at, source_pointer, created_at, updated_at
      FROM memory_entries
      WHERE user_id = $2
      ON CONFLICT (user_id, source_pointer) WHERE source_pointer IS NOT NULL
      DO UPDATE SET
        title = CASE
          WHEN EXCLUDED.updated_at >= memory_entries.updated_at THEN EXCLUDED.title
          ELSE memory_entries.title
        END,
        content = CASE
          WHEN EXCLUDED.updated_at >= memory_entries.updated_at THEN EXCLUDED.content
          ELSE memory_entries.content
        END,
        entry_type = CASE
          WHEN EXCLUDED.updated_at >= memory_entries.updated_at THEN EXCLUDED.entry_type
          ELSE memory_entries.entry_type
        END,
        status = CASE
          WHEN EXCLUDED.status = 'valid' THEN 'valid'
          ELSE memory_entries.status
        END,
        importance = GREATEST(memory_entries.importance, EXCLUDED.importance),
        last_referenced_at = GREATEST(memory_entries.last_referenced_at, EXCLUDED.last_referenced_at),
        updated_at = GREATEST(memory_entries.updated_at, EXCLUDED.updated_at)
    `,
    [nextUserId, oldUserId],
  );
  await client.query(
    `
      INSERT INTO diary_entries (
        user_id, diary_date, success_journal, money_journal, gaokao_journal, created_at, updated_at
      )
      SELECT
        $1, diary_date, success_journal, money_journal, gaokao_journal, created_at, updated_at
      FROM diary_entries
      WHERE user_id = $2
      ON CONFLICT (user_id, diary_date)
      DO UPDATE SET
        success_journal = CASE
          WHEN EXCLUDED.updated_at >= diary_entries.updated_at THEN EXCLUDED.success_journal
          ELSE diary_entries.success_journal
        END,
        money_journal = CASE
          WHEN EXCLUDED.updated_at >= diary_entries.updated_at THEN EXCLUDED.money_journal
          ELSE diary_entries.money_journal
        END,
        gaokao_journal = CASE
          WHEN EXCLUDED.updated_at >= diary_entries.updated_at THEN EXCLUDED.gaokao_journal
          ELSE diary_entries.gaokao_journal
        END,
        updated_at = GREATEST(diary_entries.updated_at, EXCLUDED.updated_at)
    `,
    [nextUserId, oldUserId],
  );
  await client.query(
    `
      INSERT INTO user_pet_state (
        user_id, species, name, mood, energy, rarity, trait_focus, trait_weakness, attributes, level, xp, last_interacted_at, updated_at
      )
      SELECT
        $1, species, name, mood, energy, rarity, trait_focus, trait_weakness, attributes, level, xp, last_interacted_at, updated_at
      FROM user_pet_state
      WHERE user_id = $2
      ON CONFLICT (user_id)
      DO UPDATE SET
        species = CASE WHEN EXCLUDED.updated_at >= user_pet_state.updated_at THEN EXCLUDED.species ELSE user_pet_state.species END,
        name = CASE WHEN EXCLUDED.updated_at >= user_pet_state.updated_at THEN EXCLUDED.name ELSE user_pet_state.name END,
        mood = CASE WHEN EXCLUDED.updated_at >= user_pet_state.updated_at THEN EXCLUDED.mood ELSE user_pet_state.mood END,
        energy = GREATEST(user_pet_state.energy, EXCLUDED.energy),
        rarity = CASE WHEN EXCLUDED.updated_at >= user_pet_state.updated_at THEN EXCLUDED.rarity ELSE user_pet_state.rarity END,
        trait_focus = CASE WHEN EXCLUDED.updated_at >= user_pet_state.updated_at THEN EXCLUDED.trait_focus ELSE user_pet_state.trait_focus END,
        trait_weakness = CASE WHEN EXCLUDED.updated_at >= user_pet_state.updated_at THEN EXCLUDED.trait_weakness ELSE user_pet_state.trait_weakness END,
        attributes = CASE WHEN EXCLUDED.updated_at >= user_pet_state.updated_at THEN EXCLUDED.attributes ELSE user_pet_state.attributes END,
        level = GREATEST(user_pet_state.level, EXCLUDED.level),
        xp = GREATEST(user_pet_state.xp, EXCLUDED.xp),
        last_interacted_at = GREATEST(user_pet_state.last_interacted_at, EXCLUDED.last_interacted_at),
        updated_at = GREATEST(user_pet_state.updated_at, EXCLUDED.updated_at)
    `,
    [nextUserId, oldUserId],
  );
  await client.query(
    `
      INSERT INTO custom_skills (user_id, skill_id, name, description, prompt, created_at, updated_at)
      SELECT $1, skill_id, name, description, prompt, created_at, updated_at
      FROM custom_skills
      WHERE user_id = $2
      ON CONFLICT (user_id, skill_id)
      DO UPDATE SET
        name = CASE WHEN EXCLUDED.updated_at >= custom_skills.updated_at THEN EXCLUDED.name ELSE custom_skills.name END,
        description = CASE WHEN EXCLUDED.updated_at >= custom_skills.updated_at THEN EXCLUDED.description ELSE custom_skills.description END,
        prompt = CASE WHEN EXCLUDED.updated_at >= custom_skills.updated_at THEN EXCLUDED.prompt ELSE custom_skills.prompt END,
        updated_at = GREATEST(custom_skills.updated_at, EXCLUDED.updated_at)
    `,
    [nextUserId, oldUserId],
  );
  await client.query(`UPDATE conversation_summaries SET user_id = $1 WHERE user_id = $2`, [nextUserId, oldUserId]);
  await client.query(`UPDATE model_call_logs SET user_id = $1 WHERE user_id = $2`, [nextUserId, oldUserId]);
  await client.query(`UPDATE answer_feedback SET user_id = $1 WHERE user_id = $2`, [nextUserId, oldUserId]);
  await client.query(
    `
      INSERT INTO user_schedule_state (user_id, last_study_prompt_at, updated_at)
      SELECT $1, last_study_prompt_at, updated_at
      FROM user_schedule_state
      WHERE user_id = $2
      ON CONFLICT (user_id)
      DO UPDATE SET
        last_study_prompt_at = GREATEST(user_schedule_state.last_study_prompt_at, EXCLUDED.last_study_prompt_at),
        updated_at = GREATEST(user_schedule_state.updated_at, EXCLUDED.updated_at)
    `,
    [nextUserId, oldUserId],
  );
  await client.query(
    `
      INSERT INTO study_reminder_state (user_id, last_asked_at, updated_at)
      SELECT $1, last_asked_at, updated_at
      FROM study_reminder_state
      WHERE user_id = $2
      ON CONFLICT (user_id)
      DO UPDATE SET
        last_asked_at = GREATEST(study_reminder_state.last_asked_at, EXCLUDED.last_asked_at),
        updated_at = GREATEST(study_reminder_state.updated_at, EXCLUDED.updated_at)
    `,
    [nextUserId, oldUserId],
  );
  await client.query(
    `
      INSERT INTO nightly_memory_rollup_state (user_id, last_rollup_date, last_run_at, updated_at)
      SELECT $1, last_rollup_date, last_run_at, updated_at
      FROM nightly_memory_rollup_state
      WHERE user_id = $2
      ON CONFLICT (user_id)
      DO UPDATE SET
        last_rollup_date = GREATEST(nightly_memory_rollup_state.last_rollup_date, EXCLUDED.last_rollup_date),
        last_run_at = GREATEST(nightly_memory_rollup_state.last_run_at, EXCLUDED.last_run_at),
        updated_at = GREATEST(nightly_memory_rollup_state.updated_at, EXCLUDED.updated_at)
    `,
    [nextUserId, oldUserId],
  );

  await client.query(
    `
      INSERT INTO profile_merge_history (from_user_id, to_user_id, email, note)
      VALUES ($1, $2, $3, $4)
    `,
    [oldUserId, nextUserId, nextEmail, "merged-without-delete"],
  );

  await client.query(
    `
      UPDATE profiles
      SET
        is_legacy = TRUE,
        merged_into_user_id = $2,
        updated_at = now()
      WHERE user_id = $1
    `,
    [oldUserId, nextUserId],
  );
}

export async function ensureUserProfile(user: AuthUser) {
  await ensureDbReady();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    if (user.email && isMergeEligibleUserId(user.userId)) {
      const recoverEmails = buildRecoveryEmails(user.email);
      const oldProfiles = await client.query(
        `
          SELECT user_id, created_at
          FROM profiles
          WHERE lower(coalesce(email, '')) = ANY($1::text[])
            AND user_id <> $2
            AND COALESCE(is_legacy, FALSE) = FALSE
            AND user_id LIKE 'user_%'
          ORDER BY created_at ASC
        `,
        [recoverEmails, user.userId],
      );
      for (const row of oldProfiles.rows) {
        await mergeUserDataById(
          client,
          user.userId,
          user.email,
          String(row.user_id),
          row.created_at as Date,
        );
      }
    }

    await client.query(
      `
      INSERT INTO profiles (user_id, email, is_admin)
      VALUES ($1, $2, CASE WHEN lower(coalesce($2, '')) = $3 THEN TRUE ELSE FALSE END)
      ON CONFLICT (user_id)
      DO UPDATE SET
        email = EXCLUDED.email,
        is_admin = CASE WHEN lower(coalesce(EXCLUDED.email, '')) = $3 THEN TRUE ELSE FALSE END,
        is_legacy = FALSE,
        merged_into_user_id = NULL,
        updated_at = now();
      `,
      [user.userId, user.email, PRIMARY_ADMIN_EMAIL],
    );

    await client.query(
      `
      INSERT INTO user_settings (user_id)
      VALUES ($1)
      ON CONFLICT (user_id)
      DO NOTHING;
      `,
      [user.userId],
    );

    await client.query(
      `
      INSERT INTO usage_total (user_id)
      VALUES ($1)
      ON CONFLICT (user_id)
      DO NOTHING;
      `,
      [user.userId],
    );

    await client.query(
      `
      INSERT INTO user_pet_state (user_id)
      VALUES ($1)
      ON CONFLICT (user_id)
      DO NOTHING;
      `,
      [user.userId],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverProfileDataByEmail(user: AuthUser) {
  await ensureDbReady();
  if (!user.email || !isMergeEligibleUserId(user.userId)) {
    return { merged: 0, restoredMemories: 0 };
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const recoverEmails = buildRecoveryEmails(user.email);

    const oldProfiles = await client.query(
      `
        SELECT user_id, created_at
        FROM profiles
        WHERE lower(coalesce(email, '')) = ANY($1::text[])
          AND user_id <> $2
          AND user_id LIKE 'user_%'
          AND COALESCE(merged_into_user_id, '') <> $2
        ORDER BY created_at ASC
      `,
      [recoverEmails, user.userId],
    );

    let merged = 0;
    for (const row of oldProfiles.rows) {
      await mergeUserDataById(
        client,
        user.userId,
        user.email,
        String(row.user_id),
        row.created_at as Date,
      );
      merged += 1;
    }

    const recoverySourceIds = [
      ...new Set(
        [
          ...(RECOVERY_SOURCE_USER_IDS[normalizeEmail(user.email)] || []),
          ...oldProfiles.rows.map((row) => String(row.user_id)),
        ].filter((id) => id && id !== user.userId),
      ),
    ];

    let restoredMemories = 0;
    if (recoverySourceIds.length > 0) {
      const backupRows = await client.query(
        `
          SELECT source_user_id, title, content, entry_type, status, source_pointer, created_at
          FROM memory_entry_backups
          WHERE source_user_id = ANY($1::text[])
            AND action <> 'delete'
          ORDER BY created_at ASC
        `,
        [recoverySourceIds],
      );
      for (const row of backupRows.rows as Array<{
        source_user_id: string;
        title: string;
        content: string;
        entry_type: string;
        status: string;
        source_pointer: string | null;
      }>) {
        const sourcePointer =
          row.source_pointer && String(row.source_pointer).trim()
            ? String(row.source_pointer)
            : `backup:${row.source_user_id}:${Buffer.from(String(row.title || "")).toString("base64").slice(0, 36)}`;

        const inserted = await client.query(
          `
            INSERT INTO memory_entries (user_id, title, content, entry_type, status, source_pointer, importance, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, 0.8, now())
            ON CONFLICT (user_id, source_pointer) WHERE source_pointer IS NOT NULL
            DO UPDATE SET
              title = EXCLUDED.title,
              content = EXCLUDED.content,
              entry_type = EXCLUDED.entry_type,
              status = EXCLUDED.status,
              importance = GREATEST(memory_entries.importance, EXCLUDED.importance),
              updated_at = now()
            RETURNING id
          `,
          [user.userId, row.title, row.content, row.entry_type || "experience", row.status || "valid", sourcePointer],
        );
        if (inserted.rows.length) restoredMemories += 1;
      }
    }

    await rebuildUsageFromMessages(client, user.userId);

    await client.query("COMMIT");
    return { merged, restoredMemories };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function addUsage(userId: string, promptTokens: number, completionTokens: number, totalTokens: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});
  const today = `${parts.year}-${parts.month}-${parts.day}`;

  await db.query(
    `
    INSERT INTO usage_daily (user_id, usage_date, prompt_tokens, completion_tokens, total_tokens)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, usage_date)
    DO UPDATE SET
      prompt_tokens = usage_daily.prompt_tokens + EXCLUDED.prompt_tokens,
      completion_tokens = usage_daily.completion_tokens + EXCLUDED.completion_tokens,
      total_tokens = usage_daily.total_tokens + EXCLUDED.total_tokens;
    `,
    [userId, today, promptTokens, completionTokens, totalTokens],
  );

  await db.query(
    `
    INSERT INTO usage_total (user_id, prompt_tokens, completion_tokens, total_tokens, updated_at)
    VALUES ($1, $2, $3, $4, now())
    ON CONFLICT (user_id)
    DO UPDATE SET
      prompt_tokens = usage_total.prompt_tokens + EXCLUDED.prompt_tokens,
      completion_tokens = usage_total.completion_tokens + EXCLUDED.completion_tokens,
      total_tokens = usage_total.total_tokens + EXCLUDED.total_tokens,
      updated_at = now();
    `,
    [userId, promptTokens, completionTokens, totalTokens],
  );
}

export async function isFirstRegisteredUser(userId: string) {
  const { rows } = await db.query(
    `
      SELECT user_id
      FROM profiles
      ORDER BY created_at ASC, user_id ASC
      LIMIT 1
    `,
  );
  return rows[0]?.user_id === userId;
}

