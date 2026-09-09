import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PostmortemController } from "./controller.js";
import { CheckpointController } from "./checkpoint/controller.js";
import { DEFAULT_FINAL_CHECKPOINT_TOKENS } from "./budget.js";
import { DEFAULT_CHECKPOINT_CONFIG } from "./checkpoint/types.js";

function positiveFlag(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

export default function agentPostmortem(pi: ExtensionAPI): void {
  const controller = new PostmortemController(pi, undefined, () =>
    positiveFlag(pi.getFlag("postmortem-final-checkpoint-max-input-tokens"), DEFAULT_FINAL_CHECKPOINT_TOKENS, 128000));
  pi.registerFlag("postmortem-no-checkpoints", {
    type: "boolean", default: false, description: "Disable automatic pre-compaction sidecar reflections",
  });
  pi.registerFlag("postmortem-checkpoint-timeout-ms", {
    type: "string", default: "180000", description: "Sidecar deadline in milliseconds (1-600000; default 180000)",
  });
  pi.registerFlag("postmortem-checkpoint-max-tokens", {
    type: "string", default: "8192", description: "Maximum checkpoint output tokens (1-32768; default 8192)",
  });
  pi.registerFlag("postmortem-checkpoint-max-input-tokens", {
    type: "string", default: "64000", description: "Estimated checkpoint input token ceiling (1-256000; default 64000)",
  });
  pi.registerFlag("postmortem-final-checkpoint-max-input-tokens", {
    type: "string", default: String(DEFAULT_FINAL_CHECKPOINT_TOKENS),
    description: "Estimated token ceiling for checkpoints added to the final review (1-128000; default 32000)",
  });
  const checkpoint = new CheckpointController(pi, {
    isFinalReflecting: () => controller.isReflecting,
    config: () => ({
      ...DEFAULT_CHECKPOINT_CONFIG,
      enabled: pi.getFlag("postmortem-no-checkpoints") !== true,
      maxInputTokens: positiveFlag(pi.getFlag("postmortem-checkpoint-max-input-tokens"), DEFAULT_CHECKPOINT_CONFIG.maxInputTokens, 256000),
      timeoutMs: positiveFlag(pi.getFlag("postmortem-checkpoint-timeout-ms"), DEFAULT_CHECKPOINT_CONFIG.timeoutMs, 600000),
      maxTokens: positiveFlag(pi.getFlag("postmortem-checkpoint-max-tokens"), DEFAULT_CHECKPOINT_CONFIG.maxTokens, 32768),
    }),
  });
  pi.registerCommand("postmortem", {
    description: "Reflect on the current task and its bound checkpoints without tools, and save a report",
    handler: async (args, ctx) => controller.request(args, ctx),
  });
  pi.on("context", (event, ctx) => controller.context(event, ctx));
  pi.on("session_before_compact", async (event, ctx) => {
    try { await checkpoint.before(event, ctx); }
    catch (error) {
      try { ctx.ui.notify("Checkpoint observer failed; Pi compaction will continue: " + String(error), "warning"); } catch {}
    }
  });
  pi.on("message_start", (event, ctx) => controller.messageStart(event, ctx));
  pi.on("message_end", (event) => controller.messageEnd(event));
  pi.on("turn_end", (event, ctx) => controller.turnEnd(event, ctx));
  pi.on("agent_settled", (_event, ctx) => controller.settled(ctx));
  pi.on("session_compact", (event, ctx) => {
    checkpoint.compacted(event, ctx);
    controller.compacted(ctx);
  });
  pi.on("session_compact_failed", (event, ctx) => {
    checkpoint.failed(event, ctx);
    controller.schedule(ctx);
  });
  pi.on("tool_call", (_event, ctx) => controller.guard(ctx));
  pi.on("session_before_switch", (_event, ctx) => controller.beforeNavigate(ctx));
  pi.on("session_before_fork", (_event, ctx) => controller.beforeNavigate(ctx));
  pi.on("session_before_tree", (_event, ctx) => controller.beforeNavigate(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    checkpoint.shutdown(ctx);
    await controller.shutdown(ctx);
  });
}
