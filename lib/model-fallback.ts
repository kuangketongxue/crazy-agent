import { normalizeApiKey } from "@/lib/secrets";

export type SourceItem = {
  title: string;
  url: string;
  snippet: string;
};

type ProviderName = "openrouter" | "nvidia" | "google" | "fallback";

export type ModelReply = {
  content: string;
  provider: ProviderName;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  thinkingSeconds: number;
  failedAttempts: number;
  councilModels?: string[];
};

export type ProviderKeys = {
  openrouterKey?: string | null;
  nvidiaKey?: string | null;
  googleKey?: string | null;
  openrouterModels?: string[] | null;
  nvidiaModels?: string[] | null;
  googleModels?: string[] | null;
  openrouterModelSwitches?: Record<string, boolean> | null;
  nvidiaModelSwitches?: Record<string, boolean> | null;
  googleModelSwitches?: Record<string, boolean> | null;
  rotateOffset?: number;
  minCouncil?: number;
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ModelCandidate = {
  provider: "openrouter" | "nvidia" | "google";
  model: string;
};

type ModelOpinion = {
  candidate: ModelCandidate;
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
};

const DEFAULT_OPENROUTER_MODELS = ["google/gemma-4-31b-it:free", "openai/gpt-oss-120b:free"];
const DEFAULT_NVIDIA_MODELS = ["minimaxai/minimax-m2.7", "z-ai/glm-5.1"];
const DEFAULT_GOOGLE_MODELS = ["gemini-2.5-flash"];
const MODEL_TIMEOUT_MS = 28_000;
const MAX_COUNCIL_BATCH = 6;
const RETRY_DELAYS_MS = [1200, 2600, 5200, 8500];
const BLOCKED_MODEL_PATTERNS = [/minimax.*m2\.5:free/i, /nemotron-3-super-120b.*:free/i];
const PRIORITY_HINTS = [
  "minimax-m2.7",
  "glm-5.1",
  "gemini-2.5",
  "gemma-4-31b-it",
  "qwen3",
  "kimi-k2.5",
  "gpt-oss-120b",
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStatusCodeFromError(error: unknown) {
  const text = String(error || "");
  const m = /:(\d{3})(?:$|[^0-9])/.exec(text);
  return m ? Number(m[1]) : null;
}

function shouldRetryError(error: unknown) {
  const text = String(error || "").toLowerCase();
  if (text.includes("timeout") || text.includes("aborterror")) return true;
  const status = parseStatusCodeFromError(error);
  if (!status) return true;
  if (status === 404 || status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  return false;
}

function normalizeModelList(
  list: string[] | null | undefined,
  defaults: string[],
  switches?: Record<string, boolean> | null,
) {
  const base = Array.isArray(list) && list.length ? list : defaults;
  const normalized = [...new Set(base.map((x) => String(x || "").trim()).filter(Boolean))].filter(
    (id) => !BLOCKED_MODEL_PATTERNS.some((p) => p.test(id)),
  );
  if (!switches || typeof switches !== "object") return normalized;
  return normalized.filter((id) => {
    if (!Object.prototype.hasOwnProperty.call(switches, id)) return true;
    return Boolean(switches[id]);
  });
}

function scoreModelPriority(model: string) {
  const normalized = model.toLowerCase();
  for (let i = 0; i < PRIORITY_HINTS.length; i += 1) {
    if (normalized.includes(PRIORITY_HINTS[i])) return 100 - i;
  }
  return 1;
}

function buildCandidates(keys: {
  openrouterKey?: string | null;
  nvidiaKey?: string | null;
  googleKey?: string | null;
  openrouterModels: string[];
  nvidiaModels: string[];
  googleModels: string[];
}) {
  const all: ModelCandidate[] = [];
  if (keys.nvidiaKey) {
    for (const model of keys.nvidiaModels) all.push({ provider: "nvidia", model });
  }
  if (keys.googleKey) {
    for (const model of keys.googleModels) all.push({ provider: "google", model });
  }
  if (keys.openrouterKey) {
    for (const model of keys.openrouterModels) all.push({ provider: "openrouter", model });
  }
  const deduped = [...new Map(all.map((item) => [`${item.provider}:${item.model}`, item])).values()];
  return deduped.sort((a, b) => scoreModelPriority(b.model) - scoreModelPriority(a.model));
}

function rotateCandidates(candidates: ModelCandidate[], offset: number) {
  if (!candidates.length) return candidates;
  const start = ((offset % candidates.length) + candidates.length) % candidates.length;
  return [...candidates.slice(start), ...candidates.slice(0, start)];
}

function extractUsage(data: unknown) {
  const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage;
  return {
    promptTokens: Number(usage?.prompt_tokens || 0),
    completionTokens: Number(usage?.completion_tokens || 0),
    totalTokens: Number(usage?.total_tokens || 0),
  };
}

function extractContent(data: unknown) {
  const choice = (data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0];
  return String(choice?.message?.content || "").trim();
}

function latestUserText(messages: ChatMessage[]) {
  return [...messages].reverse().find((m) => m.role === "user")?.content || "";
}

function isGreeting(text: string) {
  return /^(hi|hello|hey|你好|您好|在吗|哈喽|嗨|你好[，。?\s]*)$/i.test(String(text || "").trim());
}

function buildCouncilMessages(messages: ChatMessage[]): ChatMessage[] {
  return [
    ...messages,
    {
      role: "system",
      content: "请先给一句结论，再给2-4条依据。回答要直白、可执行。",
    },
  ];
}

function buildSynthesisMessages(messages: ChatMessage[], opinions: ModelOpinion[]): ChatMessage[] {
  const opinionText = opinions
    .map((item, idx) => `[观点${idx + 1} | ${item.candidate.provider}/${item.candidate.model}]\n${item.content}`)
    .join("\n\n");
  const question = latestUserText(messages);
  return [
    {
      role: "system",
      content: "你是多模型协同整合器。输出格式：1)结论 2)关键依据 3)下一步行动。不要空话。",
    },
    {
      role: "user",
      content: `用户问题:\n${question}\n\n模型讨论观点:\n${opinionText}`,
    },
  ];
}

function buildLocalSynthesis(opinions: ModelOpinion[]) {
  const top = opinions.slice(0, Math.max(2, Math.min(4, opinions.length)));
  const merged = top.map((x, i) => `${i + 1}. ${x.content}`).join("\n");
  return `结论：综合多模型讨论，建议按以下要点执行。\n\n关键要点：\n${merged}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}:timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function tryOpenRouter(openrouterKey: string, model: string, messages: ChatMessage[]) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://crazy-agent.vercel.app",
      "X-Title": "Crazy Agent",
    },
    body: JSON.stringify({ model, messages, temperature: 0.2 }),
  });
  if (!response.ok) throw new Error(`openrouter:${model}:${response.status}`);
  const data = await response.json();
  const content = extractContent(data);
  if (!content) throw new Error(`openrouter:${model}:empty`);
  return { content, usage: extractUsage(data) };
}

async function tryNvidia(nvidiaKey: string, model: string, messages: ChatMessage[]) {
  const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${nvidiaKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, temperature: 0.2 }),
  });
  if (!response.ok) throw new Error(`nvidia:${model}:${response.status}`);
  const data = await response.json();
  const content = extractContent(data);
  if (!content) throw new Error(`nvidia:${model}:empty`);
  return { content, usage: extractUsage(data) };
}

async function tryGoogle(googleKey: string, model: string, messages: ChatMessage[]) {
  const payload = {
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: { temperature: 0.2 },
  };
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(googleKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) throw new Error(`google:${model}:${response.status}`);
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };
  const content = String(data?.candidates?.[0]?.content?.parts?.map((x) => x?.text || "").join("\n") || "").trim();
  if (!content) throw new Error(`google:${model}:empty`);
  const promptTokens = Number(data?.usageMetadata?.promptTokenCount || 0);
  const completionTokens = Number(data?.usageMetadata?.candidatesTokenCount || 0);
  const totalTokens = Number(data?.usageMetadata?.totalTokenCount || promptTokens + completionTokens);
  return { content, usage: { promptTokens, completionTokens, totalTokens } };
}

async function callModel(candidate: ModelCandidate, keys: { openrouterKey?: string | null; nvidiaKey?: string | null; googleKey?: string | null }, messages: ChatMessage[]) {
  if (candidate.provider === "nvidia") {
    if (!keys.nvidiaKey) throw new Error(`nvidia:${candidate.model}:missing-key`);
    return tryNvidia(keys.nvidiaKey, candidate.model, messages);
  }
  if (candidate.provider === "google") {
    if (!keys.googleKey) throw new Error(`google:${candidate.model}:missing-key`);
    return tryGoogle(keys.googleKey, candidate.model, messages);
  }
  if (!keys.openrouterKey) throw new Error(`openrouter:${candidate.model}:missing-key`);
  return tryOpenRouter(keys.openrouterKey, candidate.model, messages);
}

async function callModelWithRetry(
  candidate: ModelCandidate,
  keys: { openrouterKey?: string | null; nvidiaKey?: string | null; googleKey?: string | null },
  messages: ChatMessage[],
) {
  let lastError: unknown = null;
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i += 1) {
    try {
      return await withTimeout(
        callModel(candidate, keys, messages),
        MODEL_TIMEOUT_MS + i * 4000,
        `${candidate.provider}:${candidate.model}`,
      );
    } catch (error) {
      lastError = error;
      if (!shouldRetryError(error) || i >= RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[i]);
    }
  }
  throw lastError || new Error(`${candidate.provider}:${candidate.model}:unknown-error`);
}

export async function chatWithFallback(keys: ProviderKeys, messages: ChatMessage[]): Promise<ModelReply> {
  const errors: string[] = [];
  const openrouterKey = normalizeApiKey(keys.openrouterKey);
  const nvidiaKey = normalizeApiKey(keys.nvidiaKey);
  const googleKey = normalizeApiKey(keys.googleKey);

  const openrouterModels = normalizeModelList(keys.openrouterModels, DEFAULT_OPENROUTER_MODELS, keys.openrouterModelSwitches);
  const nvidiaModels = normalizeModelList(keys.nvidiaModels, DEFAULT_NVIDIA_MODELS, keys.nvidiaModelSwitches);
  const googleModels = normalizeModelList(keys.googleModels, DEFAULT_GOOGLE_MODELS, keys.googleModelSwitches);
  const minCouncil = Math.max(2, Math.floor(Number(keys.minCouncil ?? 2) || 2));

  const candidates = buildCandidates({ openrouterKey, nvidiaKey, googleKey, openrouterModels, nvidiaModels, googleModels });
  if (candidates.length < 2) {
    throw new Error("NO_MODEL_QUORUM: 至少需要2个已启用模型");
  }

  const rotated = rotateCandidates(candidates, Number(keys.rotateOffset || 0));
  const targetCouncil = Math.max(2, Math.min(minCouncil, rotated.length));
  const councilPrompt = buildCouncilMessages(messages);
  const opinions: ModelOpinion[] = [];
  const tried = new Set<string>();

  for (let i = 0; i < rotated.length; i += MAX_COUNCIL_BATCH) {
    const batch = rotated.slice(i, i + MAX_COUNCIL_BATCH).filter((x) => {
      const k = `${x.provider}:${x.model}`;
      if (tried.has(k)) return false;
      tried.add(k);
      return true;
    });
    if (!batch.length) continue;

    const batchResults = await Promise.allSettled(
      batch.map(async (candidate): Promise<ModelOpinion> => {
        const startedAt = Date.now();
        const result = await callModelWithRetry(candidate, { openrouterKey, nvidiaKey, googleKey }, councilPrompt);
        return {
          candidate,
          content: result.content,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: Date.now() - startedAt,
        };
      }),
    );
    for (const item of batchResults) {
      if (item.status === "fulfilled") opinions.push(item.value);
      else errors.push(String(item.reason));
    }
    if (opinions.length >= targetCouncil) break;
  }

  if (opinions.length < 2) {
    throw new Error(`NO_MODEL_QUORUM: 有效模型不足2个。errors=${errors.slice(0, 6).join(" | ")}`);
  }

  const selected = opinions.slice(0, Math.max(2, Math.min(targetCouncil, opinions.length)));
  const councilModels = selected.map((x) => `${x.candidate.provider}/${x.candidate.model}`);
  const usageFromOpinions = selected.reduce(
    (acc, item) => ({
      promptTokens: acc.promptTokens + item.promptTokens,
      completionTokens: acc.completionTokens + item.completionTokens,
      totalTokens: acc.totalTokens + item.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );

  const synthesisCandidate = selected[0].candidate;
  const synthMessages = buildSynthesisMessages(messages, selected);
  const startedAt = Date.now();

  try {
    const merged = await callModelWithRetry(
      synthesisCandidate,
      { openrouterKey, nvidiaKey, googleKey },
      synthMessages,
    );
    return {
      content: merged.content,
      provider: synthesisCandidate.provider,
      model: synthesisCandidate.model,
      promptTokens: usageFromOpinions.promptTokens + merged.usage.promptTokens,
      completionTokens: usageFromOpinions.completionTokens + merged.usage.completionTokens,
      totalTokens: usageFromOpinions.totalTokens + merged.usage.totalTokens,
      thinkingSeconds: (Date.now() - startedAt) / 1000,
      failedAttempts: errors.length,
      councilModels,
    };
  } catch (error) {
    errors.push(String(error));
    throw new Error(
      `SYNTHESIS_FAILED: ${String(error)} | council=${councilModels.join(",")} | collected=${selected.length}`,
    );
  }
}

export function appendModelFooter(
  content: string,
  provider: string,
  model: string,
  thinkingSeconds: number,
  totalTokens: number,
  councilModels: string[] = [],
) {
  const modelSource = provider && model ? `${provider} / ${model}` : "未命中可用模型";
  const councilLine = councilModels.length > 0 ? `模型讨论: ${councilModels.join("，")}` : "模型讨论: 无";
  const tokenLine = `本次 token 消耗: ${Math.max(0, Number(totalTokens || 0))}`;
  return `${content}\n\n---\n模型来源: ${modelSource}\n${councilLine}\n${tokenLine}\n思考用时: ${thinkingSeconds.toFixed(2)} 秒`;
}
