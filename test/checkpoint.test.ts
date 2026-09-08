import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CheckpointController } from "../src/checkpoint/controller.js";
import { buildCheckpointInput } from "../src/checkpoint/input.js";
import { DEFAULT_CHECKPOINT_CONFIG, type CheckpointConfig, type CheckpointRecord } from "../src/checkpoint/types.js";
import { MODEL, gate, reply } from "./harness.js";

function fixture(config: Partial<CheckpointConfig> = {}) {
  const manager = SessionManager.inMemory(process.cwd());
  const first = manager.appendMessage({ role: "user", content: "Attempt A failed; inspect evidence B.", timestamp: 1 });
  manager.appendMessage(reply("Evidence B was useful."));
  const kept = manager.appendMessage({ role: "user", content: "Continue.", timestamp: 2 });
  const complete = vi.fn(async () => reply("PRIVATE_CHECKPOINT_BODY"));
  const records: CheckpointRecord[] = [];
  const pi = {
    appendEntry: vi.fn((_type: string, record: CheckpointRecord) => records.push(record)),
    sendMessage: vi.fn(), setActiveTools: vi.fn(), getThinkingLevel: vi.fn(() => "off" as const),
  };
  const ctx = {
    cwd: process.cwd(), sessionManager: manager, model: MODEL, modelRegistry: { complete },
    ui: { notify: vi.fn() }, abort: vi.fn(),
  };
  const context = ctx as unknown as ExtensionContext;
  const write = vi.fn(async (record: CheckpointRecord) => ".agent-postmortem/checkpoints/" + record.checkpoint_id + ".md");
  const reflecting = vi.fn(() => false);
  const controller = new CheckpointController(pi as unknown as ExtensionAPI, {
    config: () => ({ ...DEFAULT_CHECKPOINT_CONFIG, ...config }), write, isFinalReflecting: reflecting,
  });
  const abort = new AbortController();
  const event: SessionBeforeCompactEvent = {
    type: "session_before_compact", reason: "threshold", willRetry: false, signal: abort.signal,
    branchEntries: manager.getBranch(),
    preparation: {
      firstKeptEntryId: kept, tokensBefore: 99000, messagesToSummarize: [
        { role: "user", content: "Attempt A failed.", timestamp: 1 }, reply("Evidence B was useful."),
      ],
      turnPrefixMessages: [], previousSummary: "Earlier task context.", isSplitTurn: false,
      settings: { enabled: true, reserveTokens: 2048, keepRecentTokens: 20 },
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    },
  };
  const terminal = (): SessionCompactEvent => {
    const id = manager.appendCompaction("Clean task summary", kept, 99001);
    return { type: "session_compact", reason: event.reason, willRetry: false, fromExtension: false,
      compactionEntry: manager.getEntry(id) as SessionCompactEvent["compactionEntry"] };
  };
  return { manager, first, kept, complete, pi, ctx, context, write, reflecting, records, controller, abort, event, terminal };
}

describe("checkpoint failure boundaries", () => {
  it("writes phase A without session mutation, binds the exact terminal event only once", async () => {
    const f = fixture();
    const before = JSON.stringify(f.event);
    await expect(f.controller.before(f.event, f.context)).resolves.toBeUndefined();
    expect(JSON.stringify(f.event)).toBe(before);
    expect(f.records).toEqual([]);
    expect(f.write.mock.calls[0][0].status).toBe("PENDING_COMPACTION");
    const event = f.terminal();
    f.controller.compacted(event, f.context);
    f.controller.compacted(event, f.context);
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ status: "BOUND", compaction_id: event.compactionEntry.id,
      tokens_before: 99001, prepared_tokens_before: 99000 });
    expect(f.records[0].report).toBeUndefined();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(f.pi.setActiveTools).not.toHaveBeenCalled();
    expect(f.ctx.abort).not.toHaveBeenCalled();
  });

  it.each(["overflow", "disabled", "final", "no-model", "empty", "pre-aborted"] as const)(
    "skips %s without provider calls or artifact writes", async (mode) => {
      const f = fixture({ enabled: mode !== "disabled" });
      if (mode === "overflow") { f.event.reason = "overflow"; f.event.willRetry = true; }
      if (mode === "final") f.reflecting.mockReturnValue(true);
      if (mode === "no-model") f.ctx.model = undefined as unknown as typeof MODEL;
      if (mode === "empty") f.event.preparation.messagesToSummarize = [];
      if (mode === "pre-aborted") f.abort.abort();
      await expect(f.controller.before(f.event, f.context)).resolves.toBeUndefined();
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
      f.controller.compacted(f.terminal(), f.context);
      expect(f.records[0]).toMatchObject({ status: "BOUND", reflection_status: "skipped", artifact_status: "not_written" });
      if (mode === "overflow") expect(f.records[0].error_code).toBe("CHECKPOINT_SKIPPED_OVERFLOW");
    });

  it.each(["truncated", "tool", "malformed", "rate-limit"] as const)("fails open on %s output", async (mode) => {
    const f = fixture();
    const response = reply("Partial");
    if (mode === "truncated") response.stopReason = "length";
    if (mode === "tool") response.content = [{ type: "toolCall", id: "bad", name: "read", arguments: {} }];
    if (mode === "malformed") response.content = null as unknown as typeof response.content;
    if (mode === "rate-limit") f.complete.mockRejectedValue(new Error("429 Too Many Requests"));
    else f.complete.mockResolvedValue(response);
    await expect(f.controller.before(f.event, f.context)).resolves.toBeUndefined();
    f.controller.compacted(f.terminal(), f.context);
    expect(f.records[0].reflection_status).toBe("failed");
    expect(f.records[0].error_code).toBe({
      truncated: "TRUNCATED_RESPONSE", tool: "TOOL_CALL_REJECTED", malformed: "PARSE_FAILURE", "rate-limit": "RATE_LIMIT",
    }[mode]);
    expect(f.ctx.abort).not.toHaveBeenCalled();
    expect(f.abort.signal.aborted).toBe(false);
  });

  it("deadlines a provider that ignores abort and ignores its late completion", async () => {
    const f = fixture({ timeoutMs: 10 });
    const hold = gate();
    f.complete.mockImplementation(async () => { await hold.promise; return reply("LATE_BODY"); });
    await f.controller.before(f.event, f.context);
    expect(f.abort.signal.aborted).toBe(false);
    f.controller.compacted(f.terminal(), f.context);
    expect(f.records[0]).toMatchObject({ error_code: "MODEL_TIMEOUT", reflection_status: "failed", status: "BOUND" });
    const saved = JSON.stringify(f.records);
    hold.release();
    await Promise.resolve();
    expect(JSON.stringify(f.records)).toBe(saved);
  });

  it("reacts to user abort without cancelling the host itself", async () => {
    const f = fixture();
    f.complete.mockImplementation(() => new Promise(() => {}));
    const attempt = f.controller.before(f.event, f.context);
    f.abort.abort();
    await expect(attempt).resolves.toBeUndefined();
    f.controller.failed({ type: "session_compact_failed", reason: "threshold", aborted: true,
      willRetry: false, fromExtension: false }, f.context);
    expect(f.records[0]).toMatchObject({ status: "COMPACTION_FAILED", error_code: "USER_ABORT", artifact_status: "not_written" });
    expect(f.ctx.abort).not.toHaveBeenCalled();
  });

  it("retains binding diagnostics when artifact storage fails", async () => {
    const f = fixture();
    f.write.mockRejectedValue(new Error("disk full"));
    await expect(f.controller.before(f.event, f.context)).resolves.toBeUndefined();
    f.controller.compacted(f.terminal(), f.context);
    expect(f.records[0]).toMatchObject({ status: "BOUND", artifact_status: "failed", error_code: "ARTIFACT_WRITE_FAILURE" });
    expect(f.records[0].report).toBeUndefined();
  });

  it("survives session persistence and UI failures", async () => {
    const f = fixture();
    f.pi.appendEntry.mockImplementation(() => { throw new Error("session disk full"); });
    f.ctx.ui.notify.mockImplementation(() => { throw new Error("UI closed"); });
    await f.controller.before(f.event, f.context);
    expect(() => f.controller.compacted(f.terminal(), f.context)).not.toThrow();
    expect(f.write).toHaveBeenCalledTimes(1);
  });

  it("abandons an interrupted reflection at shutdown", async () => {
    const f = fixture();
    f.complete.mockImplementation(() => new Promise(() => {}));
    const attempt = f.controller.before(f.event, f.context);
    f.controller.shutdown(f.context);
    await attempt;
    f.controller.compacted(f.terminal(), f.context);
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ status: "ABANDONED", compaction_error: "CHECKPOINT_SESSION_SHUTDOWN" });
    expect(f.write).not.toHaveBeenCalled();
  });

  it.each(["boundary", "old-id", "reason"] as const)("rejects a mismatched %s compaction", async (mode) => {
    const f = fixture();
    const old = mode === "old-id" ? f.terminal() : undefined;
    if (old) f.event.branchEntries = f.manager.getBranch();
    await f.controller.before(f.event, f.context);
    const event = old ?? f.terminal();
    if (mode === "boundary") event.compactionEntry.firstKeptEntryId = f.first;
    if (mode === "reason") event.reason = "manual";
    f.controller.compacted(event, f.context);
    expect(f.records[0]).toMatchObject({ status: "COMPACTION_FAILED", compaction_error: "CHECKPOINT_BINDING_MISMATCH" });
    expect(f.records[0].compaction_id).toBeUndefined();
  });
});

describe("checkpoint input", () => {
  it("serializes both prepared segments and bounds history without mutating them", () => {
    const f = fixture();
    f.event.preparation.messagesToSummarize[0] = { role: "user", content: "A".repeat(2000), timestamp: 1 };
    f.event.preparation.turnPrefixMessages = [reply("TAIL_EVIDENCE")];
    f.event.preparation.previousSummary = "P".repeat(1000);
    const before = JSON.stringify(f.event.preparation);
    const input = buildCheckpointInput(f.event.preparation, { ...DEFAULT_CHECKPOINT_CONFIG, maxInputChars: 500, previousSummaryChars: 200 });
    const parsed = JSON.parse(input.text);
    expect(parsed.execution_segment).toHaveLength(500);
    expect(parsed.execution_segment).toContain("TAIL_EVIDENCE");
    expect(parsed.execution_segment).toContain("omitted");
    expect(parsed.previous_task_context).toHaveLength(200);
    expect(input.metadata).toMatchObject({ segment_messages: 3, truncated: true });
    expect(JSON.stringify(f.event.preparation)).toBe(before);
  });
});
