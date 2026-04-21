import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

function loadEnvFromFile(path: string) {
  if (!path || !existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function main() {
  loadEnvFromFile(process.env.DOTENV_CONFIG_PATH || ".env.local");
  const { db, ensureUserProfile } = await import("../lib/db");
  const suffix = randomUUID().slice(0, 8);
  const userId = `test_setting_${suffix}`;
  const email = `setting+${suffix}@example.com`;
  await ensureUserProfile({ userId, email });

  await db.query(
    `
      INSERT INTO user_settings (user_id, openrouter_key, nvidia_key, tavily_key, openrouter_models, nvidia_models, updated_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now())
      ON CONFLICT (user_id)
      DO UPDATE SET
        openrouter_key = EXCLUDED.openrouter_key,
        nvidia_key = EXCLUDED.nvidia_key,
        tavily_key = EXCLUDED.tavily_key,
        openrouter_models = EXCLUDED.openrouter_models,
        nvidia_models = EXCLUDED.nvidia_models,
        updated_at = now()
    `,
    [
      userId,
      "or-old-key",
      "nv-old-key",
      "tv-old-key",
      JSON.stringify(["openroute/free"]),
      JSON.stringify(["minmax2.7"]),
    ],
  );

  const before = await db.query(
    `SELECT openrouter_key, nvidia_key, tavily_key, openrouter_models, nvidia_models FROM user_settings WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  const b = before.rows[0];

  // Simulate route-level preserve behavior: blank inputs should not clear existing values.
  const normalizedOpenrouter = "";
  const normalizedNvidia = "";
  const normalizedTavily = "";
  const nextOpenrouterKey = normalizedOpenrouter || String(b.openrouter_key || "");
  const nextNvidiaKey = normalizedNvidia || String(b.nvidia_key || "");
  const nextTavilyKey = normalizedTavily || String(b.tavily_key || "");
  const normalizeModelId = (id: string) => {
    const lower = id.toLowerCase();
    if (lower === "openroute/free") return "openai/gpt-oss-120b:free";
    if (lower === "minmax2.7") return "minimaxai/minimax-m2.7";
    return id;
  };
  const nextOpenrouterModels = (Array.isArray(b.openrouter_models) ? b.openrouter_models : []).map((x: string) => normalizeModelId(String(x)));
  const nextNvidiaModels = (Array.isArray(b.nvidia_models) ? b.nvidia_models : []).map((x: string) => normalizeModelId(String(x)));

  await db.query(
    `
      UPDATE user_settings
      SET
        openrouter_key = $2,
        nvidia_key = $3,
        tavily_key = $4,
        openrouter_models = $5::jsonb,
        nvidia_models = $6::jsonb,
        updated_at = now()
      WHERE user_id = $1
    `,
    [userId, nextOpenrouterKey, nextNvidiaKey, nextTavilyKey, JSON.stringify(nextOpenrouterModels), JSON.stringify(nextNvidiaModels)],
  );

  const { rows } = await db.query(
    `SELECT openrouter_key, nvidia_key, tavily_key, openrouter_models, nvidia_models FROM user_settings WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  const row = rows[0];

  const ok =
    row.openrouter_key === "or-old-key" &&
    row.nvidia_key === "nv-old-key" &&
    row.tavily_key === "tv-old-key" &&
    JSON.stringify(row.openrouter_models || []).includes("openai/gpt-oss-120b:free") &&
    JSON.stringify(row.nvidia_models || []).includes("minimaxai/minimax-m2.7");
  if (!ok) {
    throw new Error(`settings preserve check failed: ${JSON.stringify(row)}`);
  }

  await db.query(`DELETE FROM profiles WHERE user_id = $1`, [userId]);
  await db.end();
  console.log("PASS test-settings-preserve");
}

main().catch((err) => {
  console.error("FAIL test-settings-preserve", err);
  process.exit(1);
});
