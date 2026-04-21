const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const NVIDIA_KEY = process.env.NVIDIA_KEY;
const GOOGLE_KEY = process.env.GOOGLE_KEY || process.env.GOOGLE_API_KEY;

if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}

const OPENROUTER_MODELS = [
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-120b:free",
  "openai/gpt-oss-120b",
];

const NVIDIA_MODELS = [
  "minimaxai/minimax-m2.7",
  "z-ai/glm-5.1",
  "google/gemma-4-31b-it",
];

const GOOGLE_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

function extractContent(data) {
  return data?.choices?.[0]?.message?.content?.trim?.() || "";
}

async function callOpenRouter(messages) {
  if (!OPENROUTER_KEY) return null;
  for (const model of OPENROUTER_MODELS) {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://crazy-agent.vercel.app",
        "X-Title": "Crazy Agent E2E Test",
      },
      body: JSON.stringify({ model, messages, temperature: 0.2 }),
    });

    if (!resp.ok) continue;
    const data = await resp.json();
    const content = extractContent(data);
    if (content) {
      return { provider: "openrouter", model, content };
    }
  }
  return null;
}

async function callNvidia(messages) {
  if (!NVIDIA_KEY) return null;
  for (const model of NVIDIA_MODELS) {
    const resp = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NVIDIA_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, temperature: 0.2 }),
    });

    if (!resp.ok) continue;
    const data = await resp.json();
    const content = extractContent(data);
    if (content) {
      return { provider: "nvidia", model, content };
    }
  }
  return null;
}

async function callGoogle(messages) {
  if (!GOOGLE_KEY) return null;
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  for (const model of GOOGLE_MODELS) {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GOOGLE_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: { temperature: 0.2 },
        }),
      },
    );
    if (!resp.ok) continue;
    const data = await resp.json();
    const content = String(data?.candidates?.[0]?.content?.parts?.map((x) => x?.text || "").join("\n") || "").trim();
    if (content) {
      return { provider: "google", model, content };
    }
  }
  return null;
}

(async () => {
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  const testUserId = `e2e-${Date.now()}`;

  try {
    await client.query("BEGIN");

    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
    await client.query("CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, email TEXT, is_admin BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());");
    await client.query("CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE, system_prompt TEXT NOT NULL DEFAULT '', auto_web BOOLEAN NOT NULL DEFAULT TRUE, openrouter_key TEXT, nvidia_key TEXT, tavily_key TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());");
    await client.query("CREATE TABLE IF NOT EXISTS conversations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE, title TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());");
    await client.query("CREATE TABLE IF NOT EXISTS messages (id BIGSERIAL PRIMARY KEY, conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('user','assistant','system')), content TEXT NOT NULL, model_provider TEXT, model_id TEXT, thinking_seconds NUMERIC(10,3), prompt_tokens INT NOT NULL DEFAULT 0, completion_tokens INT NOT NULL DEFAULT 0, total_tokens INT NOT NULL DEFAULT 0, web_used BOOLEAN NOT NULL DEFAULT FALSE, sources JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now());");
    await client.query("CREATE TABLE IF NOT EXISTS memory_entries (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE, title TEXT NOT NULL, content TEXT NOT NULL, entry_type TEXT NOT NULL DEFAULT 'note', source_pointer TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());");

    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS auto_web BOOLEAN NOT NULL DEFAULT TRUE;");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS openrouter_key TEXT;");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS nvidia_key TEXT;");
    await client.query("ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS tavily_key TEXT;");
    await client.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS model_provider TEXT;");
    await client.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS model_id TEXT;");
    await client.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS thinking_seconds NUMERIC(10,3);");
    await client.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS prompt_tokens INT NOT NULL DEFAULT 0;");
    await client.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS completion_tokens INT NOT NULL DEFAULT 0;");
    await client.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS total_tokens INT NOT NULL DEFAULT 0;");
    await client.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS web_used BOOLEAN NOT NULL DEFAULT FALSE;");
    await client.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS sources JSONB NOT NULL DEFAULT '[]'::jsonb;");

    await client.query(
      "INSERT INTO profiles (user_id, email) VALUES ($1, $2)",
      [testUserId, `${testUserId}@example.com`],
    );

    await client.query(
      "INSERT INTO user_settings (user_id, system_prompt, auto_web, openrouter_key, nvidia_key) VALUES ($1, $2, $3, $4, $5)",
      [testUserId, "回答要简洁，并结合长期记忆。", true, OPENROUTER_KEY || null, NVIDIA_KEY || null],
    );

    await client.query(
      "INSERT INTO memory_entries (user_id, title, content, entry_type, source_pointer) VALUES ($1, $2, $3, 'experience', $4)",
      [testUserId, "偏好记录", "用户偏好先给结论，再给要点。", "seed:test"],
    );

    const convo = await client.query(
      "INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id",
      [testUserId, "E2E真实对话测试"],
    );
    const conversationId = convo.rows[0].id;

    const userText = "请用一句话回复：系统现在是否正常对话。";
    const userMsg = await client.query(
      "INSERT INTO messages (conversation_id, user_id, role, content) VALUES ($1, $2, 'user', $3) RETURNING id",
      [conversationId, testUserId, userText],
    );

    const memory = await client.query(
      "SELECT title, content, source_pointer FROM memory_entries WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50",
      [testUserId],
    );

    const memoryText = memory.rows.map((r) => `${r.title}: ${r.content} (索引:${r.source_pointer || "无"})`).join("\n");
    const messages = [
      { role: "system", content: "你是用户的个人助手。回答先给结论。" },
      { role: "system", content: `长期记忆:\n${memoryText || "(暂无)"}` },
      { role: "user", content: userText },
    ];

    let result = await callNvidia(messages);
    if (!result) result = await callOpenRouter(messages);
    if (!result) result = await callGoogle(messages);
    if (!result) {
      throw new Error("真实模型调用失败：NVIDIA、OpenRouter、Google 都没有返回可用内容");
    }

    await client.query(
      "INSERT INTO messages (conversation_id, user_id, role, content, model_provider, model_id) VALUES ($1,$2,'assistant',$3,$4,$5)",
      [conversationId, testUserId, result.content, result.provider, result.model],
    );

    await client.query(
      "INSERT INTO memory_entries (user_id, title, content, entry_type, source_pointer) VALUES ($1,$2,$3,'experience',$4)",
      [
        testUserId,
        `经验-${new Date().toISOString().slice(0, 10)}`,
        `用户问题:${userText}\n可复用经验:回答前读取长期记忆，回答后沉淀经验。\n本次回答:${result.content.slice(0, 220)}`,
        `conversation:${conversationId}#message:${userMsg.rows[0].id}`,
      ],
    );

    const count = await client.query(
      "SELECT COUNT(*)::int AS c FROM messages WHERE conversation_id=$1",
      [conversationId],
    );
    const exp = await client.query(
      "SELECT title, source_pointer FROM memory_entries WHERE user_id=$1 AND entry_type='experience' ORDER BY created_at DESC LIMIT 1",
      [testUserId],
    );

    await client.query("COMMIT");

    console.log(JSON.stringify({
      ok: true,
      provider: result.provider,
      model: result.model,
      replyPreview: result.content.slice(0, 120),
      messageCount: count.rows[0].c,
      latestExperience: exp.rows[0] || null,
    }, null, 2));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
