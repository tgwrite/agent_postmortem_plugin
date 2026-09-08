import { createHash, randomUUID } from "node:crypto";
import type {
  ExtensionAPI, ExtensionContext, ExtensionEvent, SessionBeforeCompactEvent, SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { assistantText } from "../message.js";
import { errorText } from "../types.js";
import { bindCheckpoint } from "../compaction/binding.js";
import { writeCheckpointArtifact } from "./artifact.js";
import { buildCheckpointInput } from "./input.js";
import { CheckpointError, completeSidecar } from "./sidecar.js";
import { CHECKPOINT_SCHEMA, CHECKPOINT_TYPE, DEFAULT_CHECKPOINT_CONFIG, type CheckpointConfig, type CheckpointRecord } from "./types.js";

type SessionCompactFailedEvent = Extract<ExtensionEvent, { type: "session_compact_failed" }>;

interface Pending {
  record: CheckpointRecord;
  phase: "REFLECTING" | "PENDING_COMPACTION";
  abort: AbortController;
  previousIds: Set<string>;
}
export class CheckpointController {
  private pending?: Pending;
  private readonly pi: ExtensionAPI;
  private readonly config: () => CheckpointConfig;
  private readonly isFinalReflecting: () => boolean;
  private readonly write: typeof writeCheckpointArtifact;

  constructor(pi: ExtensionAPI, options: {
    config?: () => CheckpointConfig; isFinalReflecting?: () => boolean; write?: typeof writeCheckpointArtifact;
  } = {}) {
    this.pi = pi;
    this.config = options.config ?? (() => DEFAULT_CHECKPOINT_CONFIG);
    this.isFinalReflecting = options.isFinalReflecting ?? (() => false);
    this.write = options.write ?? writeCheckpointArtifact;
  }

  async before(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<void> {
    // Pi serializes compactions. If another extension suppressed the terminal
    // event, abandon its pending record rather than bind it to a later compact.
    if (this.pending) this.close(ctx, "ABANDONED", "CHECKPOINT_SUPERSEDED");
    const config = this.config();
    const start = Date.now();
    const record: CheckpointRecord = {
      schema_version: CHECKPOINT_SCHEMA, checkpoint_id: randomUUID(),
      session_id: ctx.sessionManager.getSessionId(), workspace: ctx.cwd,
      segment_leaf_id: ctx.sessionManager.getLeafId(), started_at: new Date(start).toISOString(),
      reason: event.reason, will_retry: event.willRetry, status: "PENDING_COMPACTION",
      reflection_status: "skipped", first_kept_entry_id: event.preparation.firstKeptEntryId,
      tokens_before: event.preparation.tokensBefore, prepared_tokens_before: event.preparation.tokensBefore,
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      report: "", duration_ms: 0, artifact_status: "not_written",
    };
    const pending: Pending = { record, phase: "REFLECTING", abort: new AbortController(),
      previousIds: new Set(event.branchEntries.filter((entry) => entry.type === "compaction").map((entry) => entry.id)) };
    this.pending = pending;
    const signal = AbortSignal.any([event.signal, pending.abort.signal]);
    try {
      if (event.reason === "overflow") { record.error_code = "CHECKPOINT_SKIPPED_OVERFLOW"; return; }
      if (!config.enabled) { record.error_code = "CHECKPOINT_DISABLED"; return; }
      if (this.isFinalReflecting()) { record.error_code = "CHECKPOINT_SKIPPED_FINAL_POSTMORTEM"; return; }
      if (!ctx.model) { record.error_code = "NO_ACTIVE_MODEL"; return; }
      if (signal.aborted) { record.error_code = "USER_ABORT"; return; }
      const input = buildCheckpointInput(event.preparation, config);
      record.input = input.metadata;
      if (!input.metadata.segment_messages) { record.error_code = "EMPTY_SEGMENT"; return; }
      const response = await completeSidecar(ctx, input.text, record.checkpoint_id, signal, config);
      if (this.pending !== pending) return;
      if (!Array.isArray(response.content) || response.content.some((block) => block.type === "text" && typeof block.text !== "string")) {
        throw new CheckpointError("PARSE_FAILURE");
      }
      record.usage = response.usage;
      record.report = assistantText(response) ?? "";
      if (response.content.some((block) => block.type === "toolCall")) throw new CheckpointError("TOOL_CALL_REJECTED");
      if (response.stopReason === "aborted") throw new CheckpointError("USER_ABORT");
      if (response.stopReason === "length") throw new CheckpointError("TRUNCATED_RESPONSE");
      if (response.stopReason !== "stop") {
        throw new CheckpointError(/429|rate.?limit/i.test(response.errorMessage ?? "") ? "RATE_LIMIT" : "MODEL_ERROR",
          response.errorMessage ?? response.stopReason);
      }
      if (!record.report.trim()) throw new CheckpointError("EMPTY_RESPONSE");
      record.reflection_status = "completed";
    } catch (error) {
      if (this.pending !== pending) return;
      record.reflection_status = "failed";
      record.error_code = error instanceof CheckpointError ? error.code :
        /429|rate.?limit/i.test(errorText(error)) ? "RATE_LIMIT" : "MODEL_ERROR";
      record.error = errorText(error);
    } finally {
      if (this.pending === pending) {
        record.duration_ms = Date.now() - start;
        record.completed_at = new Date().toISOString();
        // Overflow and skipped attempts do no filesystem I/O before recovery.
        if (record.reflection_status !== "skipped" && !signal.aborted) {
          record.report_sha256 = createHash("sha256").update(record.report).digest("hex");
          try {
            const artifact = await this.write(record, signal);
            if (this.pending === pending) {
              record.artifact_path = artifact;
              record.artifact_status = "saved";
            }
          } catch (error) {
            if (this.pending === pending) {
              record.artifact_status = "failed";
              record.artifact_error = errorText(error);
              record.error_code ??= "ARTIFACT_WRITE_FAILURE";
            }
          }
        }
        if (this.pending === pending) pending.phase = "PENDING_COMPACTION";
      }
    }
    // Always undefined: this observer neither cancels nor replaces compaction.
  }

  compacted(event: SessionCompactEvent, ctx: ExtensionContext): void {
    const pending = this.pending;
    if (!pending) return;
    if (pending.phase !== "PENDING_COMPACTION") {
      this.close(ctx, "ABANDONED", "CHECKPOINT_COMPACTION_RACE");
      return;
    }
    this.pending = undefined;
    try {
      bindCheckpoint(pending.record, event, ctx, pending.previousIds);
      this.persist(pending.record, ctx);
    } catch (error) { this.notify(ctx, "Checkpoint binding failed: " + errorText(error)); }
  }

  failed(event: SessionCompactFailedEvent, ctx: ExtensionContext): void {
    this.close(ctx, "COMPACTION_FAILED", event.errorMessage ?? (event.aborted ? "COMPACTION_ABORTED" : "COMPACTION_FAILED"));
  }

  shutdown(ctx: ExtensionContext): void {
    this.close(ctx, "ABANDONED", "CHECKPOINT_SESSION_SHUTDOWN");
  }

  private close(ctx: ExtensionContext, status: "ABANDONED" | "COMPACTION_FAILED", error: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.abort.abort();
    pending.record.status = status;
    pending.record.compaction_error = error;
    pending.record.completed_at ??= new Date().toISOString();
    this.persist(pending.record, ctx);
  }

  private persist(record: CheckpointRecord, ctx: ExtensionContext): void {
    try {
      if (record.session_id !== ctx.sessionManager.getSessionId()) throw new Error("Session changed before checkpoint binding.");
      const { report: _report, ...metadata } = record;
      this.pi.appendEntry(CHECKPOINT_TYPE, structuredClone(metadata));
      if (record.reflection_status === "failed" || record.artifact_status === "failed") {
        this.notify(ctx, "Checkpoint " + record.checkpoint_id + ": " + (record.error_code ?? record.artifact_error));
      }
    } catch (error) { this.notify(ctx, "Checkpoint entry could not be saved: " + errorText(error)); }
  }

  private notify(ctx: ExtensionContext, message: string): void {
    try { ctx.ui.notify(message, "warning"); } catch { /* Telemetry cannot gate task execution. */ }
  }
}
