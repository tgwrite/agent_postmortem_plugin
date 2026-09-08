import { convertToLlm, serializeConversation, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { CheckpointConfig, CheckpointRecord } from "./types.js";

export function boundedText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit < 100) return text.slice(0, Math.max(0, limit));
  const marker = "\n[... execution text omitted by checkpoint character budget ...]\n";
  const available = Math.max(0, limit - marker.length);
  const start = Math.floor(available / 2);
  return text.slice(0, start) + marker + text.slice(text.length - (available - start));
}

export function buildCheckpointInput(
  preparation: SessionBeforeCompactEvent["preparation"], config: CheckpointConfig,
): { text: string; metadata: NonNullable<CheckpointRecord["input"]> } {
  const segment = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const serialized = serializeConversation(convertToLlm(segment));
  const prior = boundedText(preparation.previousSummary ?? "", config.previousSummaryChars);
  const bounded = boundedText(serialized, config.maxInputChars);
  // JSON encoding makes segment boundaries unambiguous even when tool output
  // includes XML/Markdown delimiters. No raw session JSONL or system prompt.
  const text = JSON.stringify({
    previous_task_context: prior || null,
    execution_segment: bounded,
    visibility: "Tool results follow Pi serialization limits; additional omissions are explicitly marked.",
  });
  return { text, metadata: {
    segment_messages: segment.length, serialized_chars: serialized.length, supplied_chars: text.length,
    truncated: bounded.length < serialized.length || prior.length < (preparation.previousSummary?.length ?? 0),
  } };
}
