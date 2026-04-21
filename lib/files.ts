import { Buffer } from "node:buffer";
import { normalizeApiKey } from "@/lib/secrets";

const TEXT_TYPES = ["text/plain", "text/markdown", "text/csv", "application/json", "application/xml", "text/html"];
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp|gif|bmp)$/i;
const DOCX_RE = /\.(docx)$/i;
const PDF_RE = /\.(pdf)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;
const AUDIO_EXT_RE = /\.(mp3|m4a|wav|aac|ogg|flac)$/i;

type VisionKeys = {
  openrouterKey?: string | null;
  nvidiaKey?: string | null;
  googleKey?: string | null;
};

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

async function extractPdfText(buffer: Buffer) {
  try {
    const mod = await import("pdf-parse");
    const parser = (mod as unknown as { default?: (b: Buffer) => Promise<{ text?: string }> }).default;
    if (!parser) return "";
    const result = await parser(buffer);
    return String(result?.text || "").trim();
  } catch {
    return "";
  }
}

async function extractDocxText(buffer: Buffer) {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return String(result?.value || "").trim();
  } catch {
    return "";
  }
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || IMAGE_EXT_RE.test(file.name);
}

function detectImageMime(file: File) {
  if (file.type?.startsWith("image/")) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".bmp")) return "image/bmp";
  return "image/jpeg";
}

function decodeOpenAIContent(data: OpenAIResponse) {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === "text" ? part.text || "" : ""))
      .join("\n")
      .trim();
  }
  return "";
}

async function buildSafeImageDataUrl(file: File) {
  const input = Buffer.from(await file.arrayBuffer());
  let output: Buffer = input;
  let mime = detectImageMime(file);

  try {
    const sharp = (await import("sharp")).default;
    output = await sharp(input)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    mime = "image/jpeg";
  } catch {
    output = input;
  }

  const base64 = output.toString("base64");
  return `data:${mime};base64,${base64}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 18_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tryOpenRouterVision(dataUrl: string, apiKey: string) {
  const models = ["google/gemini-2.0-flash-001", "openai/gpt-4o-mini"];
  const key = normalizeApiKey(apiKey);
  if (!key) return "";

  for (const model of models) {
    const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://crazy-agent.vercel.app",
        "X-Title": "Crazy Agent Image OCR",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "请识别图片里的完整文字并给出摘要；如果没有文字，请描述图片主体和关键细节。",
              },
              {
                type: "image_url",
                image_url: { url: dataUrl },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) continue;
    const data = (await response.json()) as OpenAIResponse;
    const text = decodeOpenAIContent(data);
    if (text) return text;
  }
  return "";
}

async function tryNvidiaVision(dataUrl: string, apiKey: string) {
  const models = ["meta/llama-3.2-90b-vision-instruct", "meta/llama-3.2-11b-vision-instruct"];
  const key = normalizeApiKey(apiKey);
  if (!key) return "";

  for (const model of models) {
    const response = await fetchWithTimeout("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "请识别图片里的完整文字并给出摘要；无文字时描述图片主体。" },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });

    if (!response.ok) continue;
    const data = (await response.json()) as OpenAIResponse;
    const text = decodeOpenAIContent(data);
    if (text) return text;
  }
  return "";
}

async function tryGoogleVision(dataUrl: string, apiKey: string) {
  const key = normalizeApiKey(apiKey);
  if (!key) return "";
  const matched = /^data:(.+?);base64,(.+)$/.exec(dataUrl);
  if (!matched) return "";
  const mimeType = matched[1];
  const data = matched[2];
  const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

  for (const model of models) {
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: "请识别图片里的完整文字并给出摘要；如果没有文字，请描述主体画面和关键细节。" },
                { inlineData: { mimeType, data } },
              ],
            },
          ],
          generationConfig: { temperature: 0 },
        }),
      },
    );
    if (!response.ok) continue;
    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = String(json?.candidates?.[0]?.content?.parts?.map((x) => x?.text || "").join("\n") || "").trim();
    if (text) return text;
  }
  return "";
}

async function tryGoogleMediaSummary(file: File, apiKey: string) {
  const key = normalizeApiKey(apiKey);
  if (!key) return "";
  const raw = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || (VIDEO_EXT_RE.test(file.name) ? "video/mp4" : "audio/mpeg");
  const data = raw.toString("base64");
  const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
  const prompt = VIDEO_EXT_RE.test(file.name)
    ? "请识别这段自拍视频并输出：1) 逐段要点摘要 2) 情绪与状态判断 3) 可执行下一步。尽量保留原句信息，不要省略。"
    : "请转写这段语音并输出：1) 完整转写 2) 要点摘要 3) 可执行下一步。尽量保留原句信息，不要省略。";

  for (const model of models) {
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }, { inlineData: { mimeType, data } }],
            },
          ],
          generationConfig: { temperature: 0.1 },
        }),
      },
      30_000,
    );
    if (!response.ok) continue;
    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = String(json?.candidates?.[0]?.content?.parts?.map((x) => x?.text || "").join("\n") || "").trim();
    if (text) return text;
  }
  return "";
}

async function extractImageText(file: File, keys: VisionKeys) {
  try {
    const dataUrl = await buildSafeImageDataUrl(file);
    const googleKey = normalizeApiKey(keys.googleKey);
    const nvidiaKey = normalizeApiKey(keys.nvidiaKey);
    const openrouterKey = normalizeApiKey(keys.openrouterKey);

    if (googleKey) {
      const text = await tryGoogleVision(dataUrl, googleKey);
      if (text) return text;
    }
    if (nvidiaKey) {
      const text = await tryNvidiaVision(dataUrl, nvidiaKey);
      if (text) return text;
    }
    if (openrouterKey) {
      const text = await tryOpenRouterVision(dataUrl, openrouterKey);
      if (text) return text;
    }

    if (!googleKey && !nvidiaKey && !openrouterKey) {
      return "图片已上传，但未配置可用识别模型。请在设置里填写 Google / NVIDIA / OpenRouter Key 后重试。";
    }
    return "图片识别失败：模型没有返回可用结果，请重试或换更清晰的图片。";
  } catch (error) {
    return `图片识别失败: ${String(error)}`;
  }
}

export async function extractFileText(file: File, keys: VisionKeys = {}) {
  const contentType = file.type || "application/octet-stream";

  try {
    if (TEXT_TYPES.includes(contentType) || /\.(txt|md|csv|json|xml|html)$/i.test(file.name)) {
      return await file.text();
    }

    if (contentType === "application/pdf" || PDF_RE.test(file.name)) {
      const raw = Buffer.from(await file.arrayBuffer());
      const text = await extractPdfText(raw);
      return text || `PDF 文本提取失败或内容为空：${file.name}`;
    }

    if (
      contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      DOCX_RE.test(file.name)
    ) {
      const raw = Buffer.from(await file.arrayBuffer());
      const text = await extractDocxText(raw);
      return text || `DOCX 文本提取失败或内容为空：${file.name}`;
    }

    if (isImageFile(file)) {
      const recognized = await extractImageText(file, keys);
      return `图片识别结果 (${file.name})\n${recognized}`;
    }

    if (contentType.startsWith("video/") || VIDEO_EXT_RE.test(file.name) || contentType.startsWith("audio/") || AUDIO_EXT_RE.test(file.name)) {
      const googleKey = normalizeApiKey(keys.googleKey);
      if (!googleKey) {
        return `已上传媒体文件 (${file.name})，但未配置 Google Key，暂无法自动识别视频/音频内容。`;
      }
      const summary = await tryGoogleMediaSummary(file, googleKey);
      if (summary) {
        return `媒体识别结果 (${file.name})\n${summary}`;
      }
      return `媒体识别失败 (${file.name})：模型没有返回可用结果。`;
    }

    return `暂不支持自动提取该类型文件：${file.name}。文件已保存，你仍可在对话中继续引用它。`;
  } catch {
    return `文件解析失败：${file.name}`;
  }
}

export function countLines(text: string) {
  if (!text.trim()) return 0;
  return text.split(/\r?\n/).length;
}
