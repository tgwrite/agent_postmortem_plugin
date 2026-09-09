import { convertToLlm, serializeConversation, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { CheckpointConfig, CheckpointRecord } from "./types.js";
import { availableInputTokens, estimateTextTokens } from "../budget.js";
import { CHECKPOINT_SYSTEM_PROMPT } from "./prompt.js";

export function boundedText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit < 100) return text.slice(0, Math.max(0, limit));
  const marker = "\n[... middle text omitted by reflection input budget ...]\n";
  const available = Math.max(0, limit - marker.length);
  const start = Math.floor(available / 2);
  return text.slice(0, start) + marker + text.slice(text.length - (available - start));
}

export function buildCheckpointInput(
  preparation: SessionBeforeCompactEvent["preparation"], config: CheckpointConfig,
  model?: { contextWindow: number; maxTokens: number },
): { text: string; metadata: NonNullable<CheckpointRecord["input"]> } {
  const segment = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const serialized = serializeConversation(convertToLlm(segment));
  const previous = preparation.previousSummary ?? "";
  const outputTokens = Math.min(config.maxTokens, model?.maxTokens ?? config.maxTokens);
  const tokenLimit = availableInputTokens(model, outputTokens, config.maxInputTokens);
  const systemTokens = estimateTextTokens(CHECKPOINT_SYSTEM_PROMPT);
  const render = (scale: number) => {
    const execution = boundedText(serialized, Math.floor(config.maxInputChars * scale));
    const prior = boundedText(previous, Math.floor(config.previousSummaryChars * scale));
    const text = JSON.stringify({
      previous_task_context: prior || null,
      execution_segment: execution,
      output_budget: {
        max_output_tokens: outputTokens,
        target_report_tokens: Math.max(1, Math.min(3500, Math.floor(outputTokens / 2))),
      },
      visibility: "Tool results follow Pi serialization limits; additional omissions are explicitly marked.",
    });
    return { text, execution, prior, tokens: systemTokens + estimateTextTokens(text) };
  };
  let supplied = render(1);
  if (supplied.tokens > tokenLimit) {
    let low = 0;
    let high = 1000000;
    supplied = render(0);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = render(mid / 1000000);
      if (candidate.tokens <= tokenLimit) { low = mid; supplied = candidate; }
      else high = mid - 1;
    }
  }
  return { text: supplied.text, metadata: {
    segment_messages: segment.length, serialized_chars: serialized.length, supplied_chars: supplied.text.length,
    truncated: supplied.execution.length < serialized.length || supplied.prior.length < previous.length,
    estimated_tokens: supplied.tokens, token_limit: tokenLimit,
    fits_budget: supplied.tokens <= tokenLimit && (serialized.length === 0 || supplied.execution.length >= Math.min(256, serialized.length)),
    max_output_tokens: outputTokens, timeout_ms: config.timeoutMs, estimator: "utf8-bytes/2",
  } };
}
