import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { REQUEST_TYPE } from "./types.js";

type AgentMessage = MessageEndEvent["message"];

export function isRequestMessage(message: AgentMessage, requestId: string): boolean {
  if (message.role !== "custom" || message.customType !== REQUEST_TYPE) return false;
  const details = message.details;
  return typeof details === "object" && details !== null &&
    "request_id" in details && details.request_id === requestId;
}

export function assistantText(message: AgentMessage): string | undefined {
  if (message.role !== "assistant") return undefined;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

export function responseError(message: AssistantMessage): string | undefined {
  if (message.content.some((block) => block.type === "toolCall")) return "POSTMORTEM_TOOL_CALL";
  if (message.stopReason === "aborted") return "POSTMORTEM_ABORTED";
  if (message.stopReason === "length") return "POSTMORTEM_TRUNCATED";
  if (message.stopReason !== "stop") return "POSTMORTEM_MODEL_ERROR";
  if (!assistantText(message)?.trim()) return "POSTMORTEM_EMPTY_RESPONSE";
  return undefined;
}
