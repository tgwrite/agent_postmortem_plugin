import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ContextEvent, ExtensionAPI, ExtensionContext, MessageEndEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { boundCheckpoints, checkpointContext } from "./checkpoint/aggregation.js";
import { writeArtifact } from "./artifact.js";
import { assistantText, isRequestMessage, responseError } from "./message.js";
import { POSTMORTEM_PROMPT } from "./prompt.js";
import { PostmortemState } from "./state.js";
import { ENTRY_TYPE, REQUEST_TYPE, SCHEMA, errorText, type PostmortemRecord } from "./types.js";

export class PostmortemController {
  private readonly pi: ExtensionAPI;
  private readonly saveArtifact: typeof writeArtifact;
  private readonly state = new PostmortemState();
  private record?: PostmortemRecord;
  private previousTools?: string[];
  private requestSeen = false;
  private candidate?: AssistantMessage;
  private timer?: ReturnType<typeof setTimeout>;
  private finalizing?: Promise<void>;

  constructor(pi: ExtensionAPI, saveArtifact = writeArtifact) {
    this.pi = pi;
    this.saveArtifact = saveArtifact;
  }

  get isReflecting(): boolean {
    return this.state.phase === "RUNNING" || this.state.phase === "CAPTURED";
  }

  async context(event: ContextEvent, ctx: ExtensionContext): Promise<{ messages: ContextEvent["messages"] } | undefined> {
    if (this.state.phase !== "RUNNING" || !this.requestSeen || !this.record) return;
    const record = this.record;
    try {
      const { records: checkpoints, unavailable } = await boundCheckpoints(ctx);
      if (this.record !== record || this.state.phase !== "RUNNING") return;
      record.checkpoint_ids = checkpoints.map((checkpoint) => checkpoint.checkpoint_id);
      record.unavailable_checkpoint_ids = unavailable;
      const content = checkpointContext(checkpoints, unavailable);
      if (!content) return;
      // Ephemeral provider context only: no checkpoint material is added to the
      // session tree, ordinary messages, follow-ups, or compaction preparation.
      return { messages: [...event.messages, { role: "user", content, timestamp: Date.now() }] };
    } catch (error) {
      this.notify(ctx, "Checkpoint aggregation unavailable: " + errorText(error), "warning");
      return;
    }
  }

  request(args: string, ctx: ExtensionContext): void {
    if (args.trim()) {
      this.notify(ctx, "Usage: /postmortem (no arguments)", "warning");
      return;
    }
    if (this.state.phase !== "IDLE") {
      this.notify(ctx, this.state.phase === "REQUESTED" ? "Postmortem already requested." :
        "Postmortem is already running or being saved.", "warning");
      return;
    }
    // A failed restoration must never be overwritten by a new empty snapshot.
    this.restore(ctx);
    if (this.previousTools) return;
    this.record = {
      schema_version: SCHEMA, request_id: randomUUID(), trigger: "manual",
      requested_at: new Date().toISOString(),
      session_id: ctx.sessionManager.getSessionId(),
      session_file: ctx.sessionManager.getSessionFile(), workspace: ctx.cwd,
      status: "failed", report: "", compactions_during_postmortem: 0,
      artifact_status: "pending",
    };
    this.requestSeen = false;
    this.candidate = undefined;
    this.state.move("REQUESTED");
    if (ctx.isIdle() && !ctx.hasPendingMessages()) this.start(ctx);
    else this.notify(ctx, "Postmortem requested; waiting for the agent to settle.");
  }

  private start(ctx: ExtensionContext): void {
    const record = this.record;
    if (!record || this.state.phase !== "REQUESTED") return;
    if (record.session_id !== ctx.sessionManager.getSessionId()) {
      this.capture(ctx, "POSTMORTEM_SESSION_CHANGED", "cancelled");
      void this.finalize(ctx);
      return;
    }
    try {
      const branch = ctx.sessionManager.getBranch();
      const compactions = branch.filter((entry) => entry.type === "compaction");
      const usage = ctx.getContextUsage();
      record.context = {
        session_leaf_id: ctx.sessionManager.getLeafId(), branch_entry_count: branch.length,
        compaction_count: compactions.length, latest_compaction_id: compactions.at(-1)?.id,
        context_tokens: usage?.tokens ?? null, context_window: usage?.contextWindow ?? null,
      };
      record.model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
      record.started_at = new Date().toISOString();
      this.previousTools = [...this.pi.getActiveTools()];
      this.state.move("RUNNING");
      this.pi.setActiveTools([]);
      this.pi.sendMessage({
        customType: REQUEST_TYPE,
        content: POSTMORTEM_PROMPT + "\nPostmortem request ID: " + record.request_id,
        display: true, details: { request_id: record.request_id },
      }, { deliverAs: "followUp", triggerTurn: true });
      this.notify(ctx, "Postmortem running; tools are temporarily disabled.");
    } catch (error) {
      record.error = errorText(error);
      this.capture(ctx, "POSTMORTEM_START_FAILED");
      void this.finalize(ctx);
    }
  }

  // Start after the old settled dispatch returns. Another extension may enqueue
  // a continuation in a later handler, so recheck idle instead of nesting runs.
  schedule(ctx: ExtensionContext): void {
    if (this.state.phase !== "REQUESTED" || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (ctx.isIdle() && !ctx.hasPendingMessages()) this.start(ctx);
    }, 0);
  }

  messageStart(event: Pick<MessageEndEvent, "message">, ctx: ExtensionContext): void {
    if (this.state.phase !== "RUNNING" || !this.record) return;
    const message = event.message;
    if (isRequestMessage(message, this.record.request_id)) {
      this.requestSeen = true;
    } else if (message.role === "user" || message.role === "custom") {
      // Steering changes the next answer's meaning. Return tools to that task
      // and never save its answer as the requested reflection.
      this.capture(ctx, "POSTMORTEM_INTERLEAVED_MESSAGE", "cancelled");
    }
  }

  messageEnd(event: MessageEndEvent): void {
    if (this.state.phase !== "RUNNING" || !this.requestSeen || !this.record) return;
    if (event.message.role === "assistant") this.candidate = event.message;
  }

  turnEnd(event: TurnEndEvent, ctx: ExtensionContext): void {
    if (this.state.phase !== "RUNNING" || !this.requestSeen || !this.record) return;
    if (event.message.role !== "assistant") return;
    this.candidate = event.message;
    if (event.message.content.some((block) => block.type === "toolCall")) {
      this.record.error_code = "POSTMORTEM_TOOL_CALL";
      ctx.abort();
      return;
    }
    // Error responses may be retried. Restore after a completed response so
    // queued ordinary follow-ups run with the original tools.
    if (event.message.stopReason === "stop" && !this.record.error_code) {
      this.capture(ctx, responseError(event.message));
    }
  }

  guard(ctx: ExtensionContext): { block: true; reason: string } | undefined {
    if (this.state.phase !== "RUNNING" || !this.record) return;
    this.record.error_code = "POSTMORTEM_TOOL_CALL";
    ctx.abort();
    return { block: true, reason: "Postmortem is a tool-free reflective turn." };
  }

  async settled(ctx: ExtensionContext): Promise<void> {
    if (this.state.phase === "REQUESTED") {
      this.schedule(ctx);
    } else if (this.state.phase === "RUNNING") {
      const error = this.record?.error_code ?? (this.requestSeen ?
        (this.candidate ? responseError(this.candidate) : "POSTMORTEM_EMPTY_RESPONSE") :
        "POSTMORTEM_REQUEST_NOT_DELIVERED");
      this.capture(ctx, error);
      await this.finalize(ctx);
    } else if (this.state.phase === "CAPTURED") {
      await this.finalize(ctx);
    }
  }

  compacted(ctx: ExtensionContext): void {
    if (this.state.phase === "RUNNING" && this.record) this.record.compactions_during_postmortem++;
    this.schedule(ctx);
  }

  beforeNavigate(ctx: ExtensionContext): { cancel: true } | undefined {
    if (this.state.phase === "IDLE") return;
    this.notify(ctx, "Finish or abort the postmortem before switching sessions or branches.", "warning");
    return { cancel: true };
  }

  async shutdown(ctx: ExtensionContext): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.state.phase === "IDLE") {
      this.restore(ctx);
      return;
    }
    if (this.state.phase !== "CAPTURED") this.capture(ctx, "POSTMORTEM_SESSION_SHUTDOWN", "cancelled");
    await this.finalize(ctx);
  }

  private capture(ctx: ExtensionContext, error?: string, status: "failed" | "cancelled" = "failed"): void {
    if (!this.record || this.state.phase === "CAPTURED" || this.state.phase === "IDLE") return;
    this.state.move("CAPTURED");
    const record = this.record;
    record.completed_at = new Date().toISOString();
    record.status = error ? status : "completed";
    record.error_code = error;
    record.report = this.candidate ? assistantText(this.candidate) ?? "" : "";
    record.assistant_stop_reason = this.candidate?.stopReason;
    // Cleanup must still run if reading branch metadata fails.
    try {
      if (this.candidate) {
        const response = ctx.sessionManager.getBranch().findLast((entry) =>
          entry.type === "message" && entry.message.role === "assistant" &&
          entry.message.timestamp === this.candidate?.timestamp);
        record.response_entry_id = response?.id;
        if (this.candidate.errorMessage) record.error = this.candidate.errorMessage;
      }
    } catch (error) {
      record.error = errorText(error);
    } finally {
      this.restore(ctx);
    }
  }

  private restore(ctx: ExtensionContext): void {
    if (!this.previousTools) return;
    try {
      this.pi.setActiveTools(this.previousTools);
      const restored = this.pi.getActiveTools();
      if (restored.length !== this.previousTools.length ||
          restored.some((name, i) => name !== this.previousTools?.[i])) {
        throw new Error("The original active tool collection could not be restored.");
      }
      this.previousTools = undefined;
      if (this.record) delete this.record.tool_restore_error;
    } catch (error) {
      if (this.record) this.record.tool_restore_error = errorText(error);
      this.notify(ctx, "Postmortem tool restoration failed: " + errorText(error), "error");
    }
  }

  private finalize(ctx: ExtensionContext): Promise<void> {
    if (this.finalizing) return this.finalizing;
    const record = this.record;
    if (!record || this.state.phase !== "CAPTURED") return Promise.resolve();
    this.finalizing = this.persist(record, ctx).finally(() => { this.finalizing = undefined; });
    return this.finalizing;
  }

  private async persist(record: PostmortemRecord, ctx: ExtensionContext): Promise<void> {
    let sessionSaved = false;
    try {
      this.restore(ctx);
      try {
        Object.assign(record, await this.saveArtifact(record), { artifact_status: "saved" });
      } catch (error) {
        record.artifact_status = "failed";
        record.artifact_error = errorText(error);
      }
      try {
        if (ctx.sessionManager.getSessionId() !== record.session_id) throw new Error("Session changed before persistence.");
        this.pi.appendEntry(ENTRY_TYPE, { ...record });
        sessionSaved = true;
      } catch (error) {
        this.notify(ctx, "Postmortem session entry could not be saved: " + errorText(error), "error");
      }
      const complete = record.status === "completed" && record.artifact_status === "saved" &&
        sessionSaved && !record.tool_restore_error;
      const reportPath = record.artifact_path ? path.resolve(record.workspace, record.artifact_path) : undefined;
      this.notify(ctx, complete ? "Postmortem saved: " + reportPath :
        "Postmortem " + record.status + ": " + (record.error_code ?? record.artifact_error ?? "cleanup/persistence incomplete") +
        ". Session: " + (sessionSaved ? "saved" : "failed") + "; artifact: " + record.artifact_status + "." +
        (reportPath ? " Report: " + reportPath : ""),
        complete ? "info" : "warning");
    } finally {
      this.restore(ctx);
      this.state.move("IDLE");
      this.record = undefined;
      this.candidate = undefined;
      this.requestSeen = false;
    }
  }

  private notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
    try { ctx.ui.notify(message, level); } catch { /* UI failures must not prevent cleanup. */ }
  }
}
