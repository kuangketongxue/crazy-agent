import type { SourceItem } from "@/lib/model-fallback";

export type RealtimeResult = {
  context: string;
  sources: SourceItem[];
};

function nowInShanghai() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "long",
  }).format(now);
  return { date, time, weekday };
}

function extractUrls(text: string): string[] {
  return Array.from(text.matchAll(/https?:\/\/[^\s)\]}>"']+/g)).map((m) => m[0]);
}

function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, "") };
}

function parseYoutubeId(url: string): string | null {
  const u = url.toLowerCase();
  if (u.includes("youtu.be/")) {
    const m = url.match(/youtu\.be\/([^?&#/]+)/i);
    return m?.[1] || null;
  }
  const m = url.match(/[?&]v=([^&#]+)/i);
  if (m?.[1]) return m[1];
  const m2 = url.match(/\/shorts\/([^?&#/]+)/i);
  return m2?.[1] || null;
}

function parseTwitterUrl(url: string): { username: string; tweetId: string | null } | null {
  const u = url.toLowerCase();
  if (u.includes("twitter.com/") || u.includes("x.com/")) {
    const m = url.match(/(?:twitter\.com|x\.com)\/([^/\s]+)(?:\/status\/([^?&#/]+))?/i);
    if (m?.[1]) {
      return { username: m[1], tweetId: m[2] || null };
    }
  }
  return null;
}

function extractTwitterQuery(query: string) {
  const m = query.match(/(?:推特|twitter|x\.com)\s*[:：]?\s*([^\n]{2,60})/i);
  if (!m?.[1]) return "";
  return m[1].trim();
}

function detectWeatherLocation(query: string) {
  const m = query.match(/([A-Za-z\u4e00-\u9fa5]{2,20})(?:天气|温度|下雨|降温|气温)/);
  if (m?.[1]) return m[1].trim();
  return "上海";
}

async function fetchWeatherContext(query: string) {
  const location = detectWeatherLocation(query);
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
  const response = await fetch(url);
  if (!response.ok) {
    return { context: `${location} 天气信息读取失败（${response.status}）` };
  }
  const data = await response.json();
  const current = data?.current_condition?.[0] || {};
  const today = data?.weather?.[0] || {};
  const desc = current?.weatherDesc?.[0]?.value || "未知";
  const temp = current?.temp_C ?? "?";
  const feels = current?.FeelsLikeC ?? "?";
  const humidity = current?.humidity ?? "?";
  const wind = current?.windspeedKmph ?? "?";
  const max = today?.maxtempC ?? "?";
  const min = today?.mintempC ?? "?";
  const context = [
    `天气位置: ${location}`,
    `当前天气: ${desc}`,
    `当前温度: ${temp}°C (体感 ${feels}°C)`,
    `今日区间: ${min}°C - ${max}°C`,
    `湿度: ${humidity}%`,
    `风速: ${wind} km/h`,
  ].join("\n");
  return {
    context,
    source: {
      title: `天气: ${location}`,
      url: url.replace("?format=j1", ""),
      snippet: `${desc} ${temp}°C 体感${feels}°C`,
    } satisfies SourceItem,
  };
}

async function fetchGithubRepoSummary(url: string): Promise<{ context: string; source?: SourceItem }> {
  const parsed = parseGithubRepo(url);
  if (!parsed) return { context: "" };

  const api = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
  const r = await fetch(api, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "crazy-agent",
    },
  });
  if (!r.ok) {
    return { context: `GitHub 仓库 ${parsed.owner}/${parsed.repo} 读取失败（${r.status}）。` };
  }

  const repo = await r.json();
  const readmeUrl = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${repo.default_branch || "main"}/README.md`;
  const rr = await fetch(readmeUrl);
  const readme = rr.ok ? (await rr.text()).slice(0, 2200) : "";

  const context = [
    `GitHub 仓库: ${repo.full_name || `${parsed.owner}/${parsed.repo}`}`,
    `描述: ${repo.description || "(无)"}`,
    `主分支: ${repo.default_branch || "(未知)"}`,
    `Star: ${repo.stargazers_count ?? 0}, Fork: ${repo.forks_count ?? 0}`,
    `主要语言: ${repo.language || "(未知)"}`,
    `README 摘要:\n${readme || "(未读到 README)"}`,
  ].join("\n");

  return {
    context,
    source: {
      title: `GitHub: ${repo.full_name || `${parsed.owner}/${parsed.repo}`}`,
      url,
      snippet: `${repo.description || "无描述"} | Stars ${repo.stargazers_count ?? 0}`,
    },
  };
}

async function fetchYoutubeSummary(url: string): Promise<{ context: string; source?: SourceItem }> {
  const videoId = parseYoutubeId(url);
  if (!videoId) return { context: "" };

  const oembed = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  const r = await fetch(oembed);
  if (!r.ok) {
    return { context: `YouTube 视频 ${videoId} 元信息读取失败（${r.status}）。` };
  }

  const data = await r.json();
  const context = [
    `YouTube 视频标题: ${data.title || "(未知)"}`,
    `频道: ${data.author_name || "(未知)"}`,
    `视频链接: https://www.youtube.com/watch?v=${videoId}`,
    "说明: 当前已获取视频标题与作者信息，可据此进行内容层面的初步回答；若需要逐段摘要，建议再执行网页摘要/字幕抽取流程。",
  ].join("\n");

  return {
    context,
    source: {
      title: `YouTube: ${data.title || videoId}`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      snippet: `频道 ${data.author_name || "未知"}`,
    },
  };
}

async function fetchTwitterSummary(url: string): Promise<{ context: string; source?: SourceItem }> {
  const parsed = parseTwitterUrl(url);
  if (!parsed) return { context: "" };

  try {
    // 使用Nitter API作为免费的Twitter信息获取方式
    const nitterUrl = `https://nitter.net/${parsed.username}${parsed.tweetId ? `/status/${parsed.tweetId}` : ""}`;
    const r = await fetch(nitterUrl);
    if (!r.ok) {
      return { context: `Twitter 信息读取失败（${r.status}）。` };
    }

    const html = await r.text();
    // 提取基本信息
    const titleMatch = html.match(/<title>(.+?)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : `Twitter: ${parsed.username}`;

    const context = [
      `Twitter 链接: ${url}`,
      `用户名: @${parsed.username}`,
      `标题: ${title}`,
      `说明: 当前已获取Twitter页面信息，可据此进行内容层面的初步回答。`,
    ].join("\n");

    return {
      context,
      source: {
        title: `Twitter: ${parsed.username}`,
        url,
        snippet: title,
      },
    };
  } catch (error) {
    return { context: `Twitter 信息读取失败: ${String(error)}` };
  }
}

async function fetchTwitterQuerySummary(query: string): Promise<{ context: string; source?: SourceItem }> {
  const keyword = extractTwitterQuery(query);
  if (!keyword) return { context: "" };
  const searchUrl = `https://nitter.net/search?f=tweets&q=${encodeURIComponent(keyword)}`;
  try {
    const response = await fetch(searchUrl);
    if (!response.ok) return { context: `Twitter 搜索失败（${response.status}）` };
    const html = await response.text();
    const firstText = html.match(/<div class="tweet-content media-body"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
    const cleaned = firstText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return { context: `Twitter 搜索关键词: ${keyword}（未抓到公开内容）` };
    return {
      context: [`Twitter 搜索关键词: ${keyword}`, `实时结果摘录: ${cleaned.slice(0, 260)}`].join("\n"),
      source: {
        title: `Twitter 搜索: ${keyword}`,
        url: searchUrl,
        snippet: cleaned.slice(0, 120),
      },
    };
  } catch (error) {
    return { context: `Twitter 搜索失败: ${String(error)}` };
  }
}

export async function buildRealtimeContext(userQuery: string): Promise<RealtimeResult> {
  const urls = extractUrls(userQuery);
  const blocks: string[] = [];
  const extraSources: SourceItem[] = [];

  const timeHint = /几点|几号|日期|时间|星期|now|time|date|today/i.test(userQuery);
  if (timeHint) {
    const now = nowInShanghai();
    blocks.push(`当前北京时间: ${now.date} ${now.time}，${now.weekday}`);
  }
  if (/天气|温度|下雨|风速|湿度|气温|weather/i.test(userQuery)) {
    try {
      const weather = await fetchWeatherContext(userQuery);
      if (weather.context) blocks.push(weather.context);
      if (weather.source) extraSources.push(weather.source);
    } catch {
      blocks.push("天气信息读取失败。");
    }
  }
  if (/推特|twitter|x\.com/i.test(userQuery)) {
    try {
      const twq = await fetchTwitterQuerySummary(userQuery);
      if (twq.context) blocks.push(twq.context);
      if (twq.source) extraSources.push(twq.source);
    } catch {
      blocks.push("Twitter 搜索失败。");
    }
  }

  for (const url of urls) {
    if (/github\.com\//i.test(url)) {
      try {
        const gh = await fetchGithubRepoSummary(url);
        if (gh.context) blocks.push(gh.context);
        if (gh.source) extraSources.push(gh.source);
      } catch {
        blocks.push(`GitHub 链接读取失败: ${url}`);
      }
      continue;
    }

    if (/youtu\.be\//i.test(url) || /youtube\.com\//i.test(url)) {
      try {
        const yt = await fetchYoutubeSummary(url);
        if (yt.context) blocks.push(yt.context);
        if (yt.source) extraSources.push(yt.source);
      } catch {
        blocks.push(`YouTube 链接读取失败: ${url}`);
      }
      continue;
    }

    if (/twitter\.com\//i.test(url) || /x\.com\//i.test(url)) {
      try {
        const tw = await fetchTwitterSummary(url);
        if (tw.context) blocks.push(tw.context);
        if (tw.source) extraSources.push(tw.source);
      } catch {
        blocks.push(`Twitter 链接读取失败: ${url}`);
      }
    }
  }

  return {
    context: blocks.join("\n\n"),
    sources: extraSources,
  };
}
