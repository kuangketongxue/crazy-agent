import { db } from "../lib/db";
import { normalizeApiKey } from "../lib/secrets";
import { chatWithFallback } from "../lib/model-fallback";

type SettingsRow = {
  openrouter_key: string | null;
  nvidia_key: string | null;
  google_key: string | null;
  openrouter_models: string[] | null;
  nvidia_models: string[] | null;
  google_models: string[] | null;
  openrouter_model_switches: Record<string, boolean> | null;
  nvidia_model_switches: Record<string, boolean> | null;
  google_model_switches: Record<string, boolean> | null;
};

function enabledModels(list: string[] | null | undefined, switches: Record<string, boolean> | null | undefined) {
  const ids = Array.isArray(list) ? list.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (!switches) return ids;
  return ids.filter((id) => (Object.prototype.hasOwnProperty.call(switches, id) ? Boolean(switches[id]) : true));
}

async function main() {
  const email = process.env.TEST_EMAIL || "kuangketongxue@gmail.com";
  const userRes = await db.query(`SELECT user_id FROM profiles WHERE lower(coalesce(email, '')) = lower($1) LIMIT 1`, [email]);
  const userId = String(userRes.rows[0]?.user_id || "");
  if (!userId) throw new Error(`User not found by email: ${email}`);

  const settingsRes = await db.query(
    `
      SELECT openrouter_key, nvidia_key, google_key, openrouter_models, nvidia_models, google_models, openrouter_model_switches, nvidia_model_switches, google_model_switches
      FROM user_settings
      WHERE user_id = $1
      LIMIT 1
    `,
    [userId],
  );
  const settings = (settingsRes.rows[0] || {}) as SettingsRow;
  const openrouterKey = normalizeApiKey(settings.openrouter_key) || normalizeApiKey(process.env.OPENROUTER_API_KEY);
  const nvidiaKey = normalizeApiKey(settings.nvidia_key) || normalizeApiKey(process.env.NVIDIA_API_KEY);
  const googleKey = normalizeApiKey(settings.google_key) || normalizeApiKey(process.env.GOOGLE_API_KEY);
  const openrouterModels = enabledModels(settings.openrouter_models, settings.openrouter_model_switches);
  const nvidiaModels = enabledModels(settings.nvidia_models, settings.nvidia_model_switches);
  const googleModels = enabledModels(settings.google_models, settings.google_model_switches);

  const reply = await chatWithFallback(
    {
      openrouterKey,
      nvidiaKey,
      googleKey,
      openrouterModels,
      nvidiaModels,
      googleModels,
      openrouterModelSwitches: settings.openrouter_model_switches || {},
      nvidiaModelSwitches: settings.nvidia_model_switches || {},
      googleModelSwitches: settings.google_model_switches || {},
      minCouncil: 2,
      rotateOffset: 0,
    },
    [
      { role: "system", content: "请只给一句简短结论。" },
      { role: "user", content: "现在系统是否可正常对话？" },
    ],
  );

  const allowed = new Set([
    ...nvidiaModels.map((id) => `nvidia/${id}`),
    ...openrouterModels.map((id) => `openrouter/${id}`),
    ...googleModels.map((id) => `google/${id}`),
  ]);

  const modelKey = `${reply.provider}/${reply.model}`;
  if (reply.provider === "fallback") {
    throw new Error(`fallback is not allowed: ${JSON.stringify(reply)}`);
  }
  if (!allowed.has(modelKey)) {
    throw new Error(`model not in configured enabled list: ${modelKey}`);
  }
  if (!Array.isArray(reply.councilModels) || reply.councilModels.length < 2) {
    throw new Error(`requires >=2 configured council models: ${JSON.stringify(reply.councilModels)}`);
  }
  const badCouncil = (reply.councilModels || []).filter((x) => !allowed.has(x));
  if (badCouncil.length > 0) {
    throw new Error(`council contains non-configured model ids: ${badCouncil.join(", ")}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        userId,
        provider: reply.provider,
        model: reply.model,
        council: reply.councilModels || [],
        totalTokens: reply.totalTokens,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("FAIL test-chat-with-configured-models", error);
  process.exit(1);
});
