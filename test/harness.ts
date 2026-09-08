import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore,
  type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type Provider,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";
import postmortem from "../src/index.js";
import { ENTRY_TYPE, type PostmortemRecord } from "../src/types.js";

export const MODEL: Model<"openai-completions"> = {
  id: "postmortem-test", name: "Postmortem deterministic test model",
  provider: "postmortem-test", api: "openai-completions", baseUrl: "http://invalid.test",
  reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function reply(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: MODEL.api,
    provider: MODEL.provider, model: MODEL.id, stopReason, timestamp: Date.now(),
    usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
  };
}

export function streamReply(message: AssistantMessage, gate?: Promise<void>, signal?: AbortSignal): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  let ended = false;
  const finish = (result: AssistantMessage) => {
    if (ended) return;
    ended = true;
    signal?.removeEventListener("abort", abort);
    stream.push({ type: "start", partial: { ...result, content: [] } });
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      stream.push({ type: "error", reason: result.stopReason, error: result });
    } else {
      stream.push({ type: "done", reason: result.stopReason === "toolUse" ? "toolUse" :
        result.stopReason === "length" ? "length" : "stop", message: result });
    }
    stream.end();
  };
  const abort = () => finish(reply("", "aborted"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  else if (gate) void gate.then(() => finish(message));
  else finish(message);
  return stream;
}

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export async function removeWorkspace(cwd: string): Promise<void> {
  const resolved = path.resolve(cwd);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) ||
      !path.basename(resolved).startsWith("agent-postmortem-test-")) {
    throw new Error("Refusing cleanup outside the generated test workspace.");
  }
  await rm(resolved, { recursive: true, force: true });
}

export async function createHarness(options: {
  extensions?: ExtensionFactory[];
  paths?: string[];
  postmortemFirst?: boolean;
  includePostmortem?: boolean;
  retry?: boolean;
  compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  tools?: string[];
  setup?: (cwd: string) => Promise<void>;
} = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-postmortem-test-"));
  const agentDir = path.join(cwd, "agent");
  await options.setup?.(cwd);
  const settingsManager = SettingsManager.inMemory({
    compaction: options.compaction ?? { enabled: false },
    retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    extensionFactories: options.includePostmortem === false ? (options.extensions ?? []) : options.postmortemFirst ? [postmortem, ...(options.extensions ?? [])] :
      [...(options.extensions ?? []), postmortem],
    additionalExtensionPaths: options.paths ?? [],
    noExtensions: !options.paths?.length, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const requests: Context[] = [];
  const requestOptions: { sessionId?: string; cacheRetention?: string; maxTokens?: number }[] = [];
  let respond: (ctx: Context, signal?: AbortSignal) => AssistantMessageEventStream =
    () => streamReply(reply("# Task Postmortem\n\nA supported observation."));
  const provider: Provider = {
    id: MODEL.provider, name: "Deterministic postmortem provider",
    auth: { apiKey: { name: "test", resolve: async () => ({ auth: {} }) } },
    getModels: () => [MODEL],
    stream: (_model, ctx, opts) => { requests.push(JSON.parse(JSON.stringify(ctx)) as Context); requestOptions.push({ sessionId: opts?.sessionId, cacheRetention: opts?.cacheRetention, maxTokens: opts?.maxTokens }); return respond(ctx, opts?.signal); },
    streamSimple: (_model, ctx, opts) => { requests.push(JSON.parse(JSON.stringify(ctx)) as Context); requestOptions.push({ sessionId: opts?.sessionId, cacheRetention: opts?.cacheRetention, maxTokens: opts?.maxTokens }); return respond(ctx, opts?.signal); },
  };
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
  modelRuntime.registerNativeProvider(provider);
  const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, model: MODEL, thinkingLevel: "off",
    resourceLoader, sessionManager, settingsManager, tools: options.tools ?? (options.paths?.length ? undefined : ["read", "write"]),
  });
  await session.bindExtensions({});
  const records = () => sessionManager.getEntries().flatMap((entry) =>
    entry.type === "custom" && entry.customType === ENTRY_TYPE ? [entry.data as PostmortemRecord] : []);
  return {
    cwd, session, sessionManager, requests, requestOptions, records,
    respond(fn: typeof respond) { respond = fn; },
    async waitForReports(count = 1) {
      await expect.poll(() => records().length, { timeout: 5000 }).toBe(count);
      await session.waitForIdle();
    },
    async close() {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await session.dispose();
      await removeWorkspace(cwd);
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
