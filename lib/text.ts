export function makeConversationTitle(firstMessage: string) {
  const clean = firstMessage.replace(/\s+/g, " ").trim();
  if (!clean) {
    return "新对话";
  }
  return clean.length > 28 ? `${clean.slice(0, 28)}...` : clean;
}

export function makeSnippet(content: string, keyword: string) {
  const idx = content.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) {
    return { snippet: content.slice(0, 80), index: -1 };
  }

  const start = Math.max(0, idx - 24);
  const end = Math.min(content.length, idx + keyword.length + 24);
  return {
    snippet: content.slice(start, end),
    index: idx,
  };
}

export function sanitizeAssistantContent(raw: string) {
  if (!raw) return "";

  const cleaned = raw
    .replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/gi, "")
    .replace(/<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/gi, "")
    .replace(/<\|tool_call_argument_begin\|>[\s\S]*?<\|tool_call_argument_end\|>/gi, "")
    .replace(/<tool_calls_section_begin>[\s\S]*?<tool_calls_section_end>/gi, "")
    .replace(/<tool_call_begin>[\s\S]*?<tool_call_end>/gi, "")
    .replace(/<tool_call_argument_begin>[\s\S]*?<tool_call_argument_end>/gi, "")
    .replace(/\\u0000/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/<\|[^|]+\|>/g, "")
    .replace(/�/g, "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned || "模型返回了空内容，请重试一次。";
}
