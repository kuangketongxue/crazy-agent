import { db } from "../lib/db";
import { normalizeApiKey } from "../lib/secrets";

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

type ProbeResult = {
  provider: "openrouter" | "nvidia" | "google";
  model: string;
  ok: boolean;
  status?: number;
  error?: string;
};

function enabledModels(list: string[] | null | undefined, switches: Record<string, boolean> | null | undefined) {
  const ids = Array.isArray(list) ? list.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (!switches) return ids;
  return ids.filter((id) => (Object.prototype.hasOwnProperty.call(switches, id) ? Boolean(switches[id]) : true));
}

async function probeOpenrouter(apiKey: string, model: string): Promise<ProbeResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 16_000);
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://crazy-agent.vercel.app",
        "X-Title": "Crazy Agent Model Probe",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: "user", content: "只回复 OK" }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return { provider: "openrouter", model, ok: false, status: resp.status };
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = String(data?.choices?.[0]?.message?.content || "").trim();
    return { provider: "openrouter", model, ok: Boolean(text), status: resp.status };
  } catch (error) {
    return { provider: "openrouter", model, ok: false, error: String(error) };
  }
}

async function probeNvidia(apiKey: string, model: string): Promise<ProbeResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 16_000);
    const resp = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: "user", content: "只回复 OK" }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return { provider: "nvidia", model, ok: false, status: resp.status };
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = String(data?.choices?.[0]?.message?.content || "").trim();
    return { provider: "nvidia", model, ok: Boolean(text), status: resp.status };
  } catch (error) {
    return { provider: "nvidia", model, ok: false, error: String(error) };
  }
}

async function probeGoogle(apiKey: string, model: string): Promise<ProbeResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "只回复 OK" }] }],
          generationConfig: { temperature: 0 },
        }),
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    if (!resp.ok) return { provider: "google", model, ok: false, status: resp.status };
    const data = (await resp.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = String(data?.candidates?.[0]?.content?.parts?.map((x) => x?.text || "").join("\n") || "").trim();
    return { provider: "google", model, ok: Boolean(text), status: resp.status };
  } catch (error) {
    return { provider: "google", model, ok: false, error: String(error) };
  }
}

async function main() {
  const email = process.env.TEST_EMAIL || "kuangketongxue@gmail.com";
  const userRes = await db.query(`SELECT user_id FROM profiles WHERE lower(coalesce(email, '')) = lower($1) LIMIT 1`, [email]);
  const userId = String(userRes.rows[0]?.user_id || "");
  if (!userId) {
    throw new Error(`User not found by email: ${email}`);
  }

  const settingsRes = await db.query(
    `
      SELECT openrouter_key, nvidia_key, openrouter_models, nvidia_models, openrouter_model_switches, nvidia_model_switches
           , google_key, google_models, google_model_switches
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

  const results: ProbeResult[] = [];
  if (nvidiaKey) {
    for (const model of nvidiaModels) results.push(await probeNvidia(nvidiaKey, model));
  }
  if (openrouterKey) {
    for (const model of openrouterModels) results.push(await probeOpenrouter(openrouterKey, model));
  }
  if (googleKey) {
    for (const model of googleModels) results.push(await probeGoogle(googleKey, model));
  }

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        userId,
        tested: results.length,
        passed: ok.length,
        failed: failed.length,
        results,
      },
      null,
      2,
    ),
  );

  if (results.length === 0) {
    throw new Error("No enabled models to test.");
  }
}

main().catch((error) => {
  console.error("FAIL test-configured-model-ids", error);
  process.exit(1);
});
