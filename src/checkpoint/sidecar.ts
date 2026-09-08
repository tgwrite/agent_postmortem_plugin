import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkpointReasoningEffort } from "./reasoning.js";
import { CHECKPOINT_SYSTEM_PROMPT } from "./prompt.js";
import type { CheckpointConfig } from "./types.js";

export class CheckpointError extends Error {
  readonly code: string;
  constructor(code: string, message = code) { super(message); this.code = code; }
}

// Race explicitly: some providers do not settle promptly when their signal is
// aborted. Late results are ignored and can never alter a completed checkpoint.
export async function completeSidecar(
  ctx: ExtensionContext, text: string, sessionId: string, signal: AbortSignal, config: CheckpointConfig,
  thinkingLevel: ModelThinkingLevel,
): Promise<AssistantMessage> {
  if (!ctx.model) throw new CheckpointError("NO_ACTIVE_MODEL");
  const timeout = new AbortController();
  const combined = AbortSignal.any([signal, timeout.signal]);
  const abortError = () => timeout.signal.aborted
    ? new CheckpointError("MODEL_TIMEOUT") : new CheckpointError("USER_ABORT");
  if (combined.aborted) throw abortError();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(abortError());
  combined.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => timeout.abort(), config.timeoutMs);
  try {
    const response = ctx.modelRegistry.complete(ctx.model, {
      systemPrompt: CHECKPOINT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: text, timestamp: Date.now() }],
      tools: [],
    }, {
      maxTokens: Math.min(config.maxTokens, ctx.model.maxTokens),
      reasoningEffort: checkpointReasoningEffort(ctx.model, thinkingLevel),
      signal: combined, cacheRetention: "none", sessionId,
    });
    return await Promise.race([response, aborted]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", onAbort);
  }
}
