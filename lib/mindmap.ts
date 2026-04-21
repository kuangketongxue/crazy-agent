function squeeze(text: string, max = 800) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

export function estimateTokenUsage(args: { userText: string; assistantText: string }) {
  const promptTokens = Math.max(1, Math.ceil(args.userText.length / 3.8));
  const completionTokens = Math.max(1, Math.ceil(args.assistantText.length / 3.8));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

export function buildMindmapPrompt(params: {
  conversationTitle: string;
  userQuestion: string;
  assistantAnswer: string;
}) {
  const title = squeeze(params.conversationTitle || "本次对话", 60);
  const question = squeeze(params.userQuestion, 220);
  const answer = squeeze(params.assistantAnswer, 480);

  return [
    "High-end neon style Chinese mind map infographic, clean layout, dark navy background, bright cyan and gold lines.",
    `Center title: ${title}`,
    `Branch 1: 用户问题 = ${question}`,
    `Branch 2: 核心结论 = ${answer}`,
    "Branch 3: 关键行动 = 3 concise actionable items in Chinese",
    "Branch 4: 风险与注意 = 2 concise caution points in Chinese",
    "Readable Chinese typography, sharp, no watermark.",
  ].join(" | ");
}

export function buildPollinationsMindmapUrl(prompt: string) {
  const encoded = encodeURIComponent(prompt);
  const seed = Date.now();
  return `https://image.pollinations.ai/prompt/${encoded}?width=1400&height=900&model=flux&nologo=true&seed=${seed}`;
}

