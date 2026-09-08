import { InMemoryCredentialStore, type Model, type ModelThinkingLevel, type Provider } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRegistry, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { completeSidecar } from "../src/checkpoint/sidecar.js";
import { DEFAULT_CHECKPOINT_CONFIG } from "../src/checkpoint/types.js";
import { CHECKPOINT_SYSTEM_PROMPT } from "../src/checkpoint/prompt.js";
import { MODEL } from "./harness.js";

const glm: Model<"openai-completions"> = {
  ...MODEL, id: "glm-5.3-flash", reasoning: true,
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: true,
    maxTokensField: "max_tokens", thinkingFormat: "zai", zaiToolStream: true },
  thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
};

interface RequestBody {
  thinking?: { type: string };
  reasoning_effort?: string;
  max_tokens?: number;
  tools?: unknown[];
  messages: { role: string; content: unknown }[];
}

async function fixture(model = glm) {
  const requests: RequestBody[] = [];
  // Exercise the real Pi -> OpenAI SDK -> HTTP payload mapping. Only transport
  // is substituted, so no real credentials, task data, or network are involved.
  const fetchRequest: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    requests.push(body);
    if (model.reasoning && body.thinking?.type !== "enabled") {
      return new Response(JSON.stringify({ code: "1210", message: "该模型始终思考，不支持关闭思考；请使用 low、high 或 max。" }),
        { status: 400, headers: { "content-type": "application/json" } });
    }
    const chunk = { id: "test-response", object: "chat.completion.chunk", created: 1, model: model.id };
    const frames = [
      { ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "# Execution Checkpoint\nSupported finding." }, finish_reason: null }] },
      { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 } },
    ];
    return new Response(frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider: Provider<"openai-completions"> = {
    id: model.provider, name: "GLM wire regression",
    auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test-only" } }) } },
    getModels: () => [model],
    stream: (selected, ctx, opts) => stream(selected as typeof model, ctx, { ...opts, fetch: fetchRequest, maxRetries: 0 }),
    streamSimple: (selected, ctx, opts) => streamSimple(selected as typeof model, ctx, { ...opts, fetch: fetchRequest, maxRetries: 0 }),
  };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
  runtime.registerNativeProvider(provider);
  const registry = new ModelRegistry(runtime);
  const ctx = { model, modelRegistry: registry } as unknown as ExtensionContext;
  const call = (thinkingLevel: ModelThinkingLevel) => completeSidecar(ctx, "Visible execution evidence.", "isolated-checkpoint-id",
    new AbortController().signal, DEFAULT_CHECKPOINT_CONFIG, thinkingLevel);
  return { registry, requests, call };
}

describe("GLM thinking transport regression", () => {
  it("reproduces the original 400, then sends enabled thinking at the Session's high level", async () => {
    const f = await fixture();
    const old = await f.registry.complete(glm, {
      systemPrompt: CHECKPOINT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Visible execution evidence.", timestamp: 1 }], tools: [],
    }, { maxTokens: 2048 });
    expect(old.stopReason).toBe("error");
    expect(old.errorMessage).toContain("400");
    expect(f.requests[0].thinking).toEqual({ type: "disabled" });
    const fixed = await f.call("high");
    expect(fixed.stopReason).toBe("stop");
    expect(fixed.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining("Supported finding.") }));
    expect(f.requests[1]).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 2048 });
    expect(f.requests[1].tools ?? []).toEqual([]);
    expect(f.requests[1].messages[0].content).toBe(CHECKPOINT_SYSTEM_PROMPT);
  });

  it("preserves max without downgrading to low or high", async () => {
    const f = await fixture();
    expect((await f.call("max")).stopReason).toBe("stop");
    expect(f.requests[0].reasoning_effort).toBe("max");
  });

  it("does not silently replace an explicit off setting with low", async () => {
    const f = await fixture();
    expect((await f.call("off")).stopReason).toBe("error");
    expect(f.requests[0].thinking?.type).toBe("disabled");
    expect(f.requests[0].reasoning_effort).toBeUndefined();
  });

  it("does not enable thinking on a non-reasoning model", async () => {
    const f = await fixture({ ...glm, reasoning: false });
    expect((await f.call("high")).stopReason).toBe("stop");
    expect(f.requests[0].thinking).toBeUndefined();
    expect(f.requests[0].reasoning_effort).toBeUndefined();
  });
});
