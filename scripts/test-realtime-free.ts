import { shouldSearchWeb, tavilySearch } from "../lib/web";
import { buildRealtimeContext } from "../lib/realtime";

async function main() {
  if (!shouldSearchWeb("现在几点了，顺便看下上海天气", true)) {
    throw new Error("shouldSearchWeb failed for time/weather query");
  }
  if (!shouldSearchWeb("查推特 OpenAI 最新消息", true)) {
    throw new Error("shouldSearchWeb failed for twitter query");
  }

  const realtime = await buildRealtimeContext("现在几点了？上海天气怎么样？查推特 OpenAI 最新消息");
  if (!realtime.context.includes("当前北京时间")) {
    throw new Error(`missing realtime time context: ${realtime.context}`);
  }
  if (!/天气位置|当前天气|当前温度/.test(realtime.context)) {
    throw new Error(`missing weather context: ${realtime.context}`);
  }

  const web = await tavilySearch("OpenAI latest news", null);
  if (!Array.isArray(web) || web.length === 0) {
    throw new Error("free web search returned empty result");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        realtimePreview: realtime.context.slice(0, 160),
        sourceCount: realtime.sources.length,
        webCount: web.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("FAIL test-realtime-free", error);
  process.exit(1);
});

