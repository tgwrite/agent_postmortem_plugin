import type { Api, Model, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";

// These low-level APIs all use reasoningEffort. Passing the simple API's
// "reasoning" option to ModelRegistry.complete() would be silently ignored.
const EFFORT_APIS = new Set(["openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses"]);

export function checkpointReasoningEffort(model: Model<Api> | undefined, requested: ModelThinkingLevel): ThinkingLevel | undefined {
  if (!model?.reasoning || !EFFORT_APIS.has(model.api) || requested === "off") return;
  // Preserve the current Session setting exactly; do not clamp or choose a fallback.
  return requested;
}
