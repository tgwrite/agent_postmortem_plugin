import { Buffer } from "node:buffer";

export const DEFAULT_FINAL_CHECKPOINT_TOKENS = 32000;

// Deliberately more conservative than a characters/4 heuristic for mixed
// prose, code and CJK. This is an estimate, not a provider tokenizer.
export function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 2);
}

export function availableInputTokens(
  model: { contextWindow: number } | undefined, outputTokens: number, requested: number,
): number {
  if (!model) return requested;
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return 0;
  const margin = Math.max(2048, Math.ceil(model.contextWindow * 0.1));
  return Math.max(0, Math.min(requested, Math.floor(model.contextWindow) - outputTokens - margin));
}
