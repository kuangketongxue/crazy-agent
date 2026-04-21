import { chatWithFallback } from "../lib/model-fallback";

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function makeResponse(content: string, totalTokens = 42): FetchResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: totalTokens - 20,
        total_tokens: totalTokens,
      },
    }),
  };
}

async function main() {
  const originalFetch = global.fetch;
  try {
    global.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const model = String(body.model || "");
      if (model === "model-a") return makeResponse("观点A") as Response;
      if (model === "model-b") return makeResponse("观点B") as Response;
      throw new Error(`${model}:timeout`);
    }) as typeof fetch;

    const ok = await chatWithFallback(
      {
        openrouterKey: "or-key",
        openrouterModels: ["model-a", "model-b"],
        minCouncil: 2,
      },
      [{ role: "user", content: "测试双模型投票" }],
    );

    if (ok.provider !== "openrouter") throw new Error(`expected openrouter, got ${ok.provider}`);
    if (!Array.isArray(ok.councilModels) || ok.councilModels.length < 2) {
      throw new Error(`expected >=2 council models, got ${JSON.stringify(ok.councilModels)}`);
    }

    global.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const model = String(body.model || "");
      if (model === "model-a") return makeResponse("仅一个模型可用") as Response;
      throw new Error(`${model}:timeout`);
    }) as typeof fetch;

    let thrown = false;
    try {
      await chatWithFallback(
        {
          openrouterKey: "or-key",
          openrouterModels: ["model-a", "model-b"],
          minCouncil: 2,
        },
        [{ role: "user", content: "至少两个模型" }],
      );
    } catch {
      thrown = true;
    }
    if (!thrown) {
      throw new Error("expected NO_MODEL_QUORUM throw when only one model succeeds");
    }

    console.log("PASS test-model-fallback");
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error("FAIL test-model-fallback", error);
  process.exit(1);
});
