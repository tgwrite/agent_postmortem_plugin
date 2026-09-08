import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PostmortemController } from "./controller.js";

export default function agentPostmortem(pi: ExtensionAPI): void {
  const controller = new PostmortemController(pi);
  pi.registerCommand("postmortem", {
    description: "Reflect on the current task in this session, without tools, and save a report",
    handler: async (args, ctx) => controller.request(args, ctx),
  });
  pi.on("message_start", (event, ctx) => controller.messageStart(event, ctx));
  pi.on("message_end", (event) => controller.messageEnd(event));
  pi.on("turn_end", (event, ctx) => controller.turnEnd(event, ctx));
  pi.on("agent_settled", (_event, ctx) => controller.settled(ctx));
  pi.on("session_compact", (_event, ctx) => controller.compacted(ctx));
  pi.on("session_compact_failed", (_event, ctx) => controller.schedule(ctx));
  pi.on("tool_call", (_event, ctx) => controller.guard(ctx));
  pi.on("session_before_switch", (_event, ctx) => controller.beforeNavigate(ctx));
  pi.on("session_before_fork", (_event, ctx) => controller.beforeNavigate(ctx));
  pi.on("session_before_tree", (_event, ctx) => controller.beforeNavigate(ctx));
  pi.on("session_shutdown", (_event, ctx) => controller.shutdown(ctx));
}
