import type { SourceItem } from "@/lib/model-fallback";

const WEB_HINTS = [
  "今天",
  "最新",
  "最近",
  "实时",
  "新闻",
  "价格",
  "汇率",
  "比分",
  "政策",
  "发布",
  "现在",
  "now",
  "latest",
  "today",
  "news",
  "price",
  "score",
  "update",
  "天气",
  "温度",
  "下雨",
  "台风",
  "几点",
  "几号",
  "星期",
  "现在时间",
  "北京时间",
  "几点了",
];

function normalizeText(value: string) {
  return value
    .replace(/\u0000/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/�/g, "")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldSearchWeb(query: string, forceAutoWeb: boolean) {
  if (!forceAutoWeb) {
    return false;
  }
  const q = query.toLowerCase();
  if (WEB_HINTS.some((hint) => q.includes(hint.toLowerCase()))) {
    return true;
  }
  if (/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/.test(q)) return true;
  if (/(是谁|谁是|最新|最近|实时|今天|明天|本周|本月).*(情况|消息|政策|新闻|数据|价格|天气)/.test(q)) return true;
  if (/(推特|twitter|x\.com|热搜|头条|实时动态|股价|币价|航班|路况)/.test(q)) return true;
  return false;
}

async function fallbackFreeWebSearch(query: string): Promise<SourceItem[]> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "crazy-agent",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) {
    throw new Error(`免费联网搜索失败: ${response.status}`);
  }
  const html = await response.text();
  const matches = Array.from(
    html.matchAll(
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g,
    ),
  );
  const items = matches
    .map((m) => {
      const rawUrl = String(m[1] || "");
      const resolved = rawUrl.includes("uddg=")
        ? decodeURIComponent(rawUrl.split("uddg=")[1] || rawUrl)
        : rawUrl;
      const title = normalizeText(String(m[2] || "").replace(/<[^>]+>/g, ""));
      const snippet = normalizeText(String(m[3] || "").replace(/<[^>]+>/g, ""));
      return {
        title: title || "未命名来源",
        url: resolved,
        snippet,
      } satisfies SourceItem;
    })
    .filter((x) => /^https?:\/\//i.test(x.url));
  return items.slice(0, 6);
}

export async function tavilySearch(query: string, apiKey?: string | null): Promise<SourceItem[]> {
  if (!apiKey) {
    return fallbackFreeWebSearch(query);
  }
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 5,
      include_answer: false,
    }),
  });

  if (!response.ok) {
    return fallbackFreeWebSearch(query);
  }

  const data = await response.json();
  const results = (data?.results ?? []) as Array<{ title?: string; url?: string; content?: string }>;

  const normalized = results
    .filter((item) => item.url)
    .map((item) => ({
      title: normalizeText(item.title || "未命名来源") || "未命名来源",
      url: item.url || "",
      snippet: normalizeText(item.content || ""),
    }));
  if (normalized.length > 0) return normalized;
  return fallbackFreeWebSearch(query);
}

export function sourcesToContext(sources: SourceItem[]) {
  if (!sources.length) {
    return "";
  }

  return sources
    .map((item, index) => `来源${index + 1}: ${item.title}\n链接: ${item.url}\n摘要: ${item.snippet}`)
    .join("\n\n");
}
