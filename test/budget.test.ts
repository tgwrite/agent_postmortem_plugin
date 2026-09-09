import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { availableInputTokens, estimateTextTokens } from "../src/budget.js";
import { checkpointContext } from "../src/checkpoint/aggregation.js";
import { buildCheckpointInput } from "../src/checkpoint/input.js";
import { completeSidecar } from "../src/checkpoint/sidecar.js";
import { DEFAULT_CHECKPOINT_CONFIG, type CheckpointRecord } from "../src/checkpoint/types.js";
import { MODEL, reply } from "./harness.js";

function preparation(text: string): SessionBeforeCompactEvent["preparation"] {
  return {
    firstKeptEntryId: "kept", tokensBefore: 200000, messagesToSummarize: [
      { role: "user", content: text, timestamp: 1 },
    ], turnPrefixMessages: [], previousSummary: "Earlier observations. ".repeat(800), isSplitTurn: false,
    settings: { enabled: true, reserveTokens: 2048, keepRecentTokens: 20 },
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
  };
}

function record(id: string, repeats = 4000): CheckpointRecord {
  return { checkpoint_id: id, compaction_id: "compact-" + id,
    report: "START_" + id + "\n" + "Synthetic observation. ".repeat(repeats) + "\nEND_" + id } as CheckpointRecord;
}

describe("reflection input budgets", () => {
  it("fits a long multilingual segment including JSON escaping, system prompt and output reservation", () => {
    const source = preparation('START_EVIDENCE\n' + '任务结果："可见证据"\\n'.repeat(40000) + '\nEND_EVIDENCE');
    const original = JSON.stringify(source.messagesToSummarize);
    const model = { ...MODEL, contextWindow: 32000, maxTokens: 16384 };
    const input = buildCheckpointInput(source, DEFAULT_CHECKPOINT_CONFIG, model);
    const parsed = JSON.parse(input.text);
    expect(input.metadata.fits_budget).toBe(true);
    expect(input.metadata.truncated).toBe(true);
    expect(input.metadata.estimated_tokens).toBeLessThanOrEqual(32000 - 8192 - 3200);
    expect(parsed.execution_segment).toContain("START_EVIDENCE");
    expect(parsed.execution_segment).toContain("END_EVIDENCE");
    expect(parsed.execution_segment).toContain("omitted");
    expect(parsed.output_budget).toEqual({ max_output_tokens: 8192, target_report_tokens: 3500 });
    expect(JSON.stringify(source.messagesToSummarize)).toBe(original);
  });

  it("honors a lower configured input limit and a smaller model output cap", () => {
    const input = buildCheckpointInput(preparation("Evidence. ".repeat(30000)),
      { ...DEFAULT_CHECKPOINT_CONFIG, maxInputTokens: 5000 }, MODEL);
    expect(input.metadata).toMatchObject({ token_limit: 5000, max_output_tokens: MODEL.maxTokens, fits_budget: true });
    expect(input.metadata.estimated_tokens).toBeLessThanOrEqual(5000);
  });

  it("reports an exhausted context budget instead of pretending empty input is a valid reflection", () => {
    const input = buildCheckpointInput(preparation("Visible observation."), DEFAULT_CHECKPOINT_CONFIG,
      { ...MODEL, contextWindow: 4096 });
    expect(input.metadata).toMatchObject({ fits_budget: false, token_limit: 0 });
    expect(availableInputTokens({ contextWindow: NaN }, 8192, 64000)).toBe(0);
  });
});

describe("final checkpoint aggregation budget", () => {
  it("shares excerpts across stages, preserves beginning/end evidence and leaves source reports intact", () => {
    const records = [record("first"), record("middle"), record("last")];
    const original = JSON.stringify(records);
    const result = checkpointContext(records, [], 4000);
    expect(result.included).toEqual(["first", "middle", "last"]);
    expect(result.truncated).toEqual(["first", "middle", "last"]);
    expect(result.omitted).toEqual([]);
    expect(estimateTextTokens(result.content)).toBeLessThanOrEqual(4000);
    for (const id of result.included) {
      expect(result.content).toContain("START_" + id);
      expect(result.content).toContain("END_" + id);
    }
    expect(result.content).toContain('"report_truncated":true');
    expect(JSON.stringify(records)).toBe(original);
  });

  it("bounds diagnostic overhead and records omissions even when no checkpoint can fit", () => {
    const records = Array.from({ length: 100 }, (_, i) => record(String(i), 30));
    const unavailable = Array.from({ length: 1000 }, (_, i) => "unavailable-" + i);
    const result = checkpointContext(records, unavailable, 120);
    expect(result.included).toEqual([]);
    expect(result.omitted).toHaveLength(100);
    expect(result.content).toContain("incomplete");
    expect(estimateTextTokens(result.content)).toBeLessThanOrEqual(120);
    expect(checkpointContext(records, [], 0)).toMatchObject({ content: "", included: [], estimatedTokens: 0 });
  });

  it("keeps short valid reports complete", () => {
    const source = record("short", 1);
    const result = checkpointContext([source], ["missing"], 4000);
    expect(result.included).toEqual(["short"]);
    expect(result.truncated).toEqual([]);
    expect(result.content).toContain("missing");
  });
});

describe("long reasoning request", () => {
  it("allows work beyond the old timeout while retaining high thinking and the expanded output budget", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (message: ReturnType<typeof reply>) => void;
      const complete = vi.fn(() => new Promise<ReturnType<typeof reply>>((done) => { resolve = done; }));
      const model = { ...MODEL, reasoning: true, maxTokens: 16384 };
      const ctx = { model, modelRegistry: { complete } } as unknown as ExtensionContext;
      const abort = new AbortController();
      const pending = completeSidecar(ctx, "Synthetic task evidence.", "test-checkpoint", abort.signal, DEFAULT_CHECKPOINT_CONFIG, "high");
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(120000);
      expect(settled).toBe(false);
      expect(complete).toHaveBeenCalledWith(model, expect.objectContaining({ tools: [] }),
        expect.objectContaining({ maxTokens: 8192, reasoningEffort: "high", cacheRetention: "none" }));
      resolve(reply("Complete synthetic reflection."));
      expect((await pending).stopReason).toBe("stop");
      expect(abort.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
