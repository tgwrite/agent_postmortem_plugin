import { boundCheckpoints } from "../src/checkpoint/aggregation.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Context } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { CHECKPOINT_SYSTEM_PROMPT } from "../src/checkpoint/prompt.js";
import { CHECKPOINT_TYPE, type CheckpointRecord } from "../src/checkpoint/types.js";
import { createHarness, gate, reply, streamReply, type Harness } from "./harness.js";

const fixtures: Harness[] = [];
afterEach(async () => { for (const h of fixtures.splice(0)) await h.close(); });
async function fixture(options?: Parameters<typeof createHarness>[0]) {
  const h = await createHarness({ compaction: { enabled: false, reserveTokens: 2048, keepRecentTokens: 1 }, ...options });
  fixtures.push(h);
  return h;
}
export const isSidecar = (ctx: Context) => ctx.systemPrompt === CHECKPOINT_SYSTEM_PROMPT;
function checkpoints(h: Harness) {
  return h.sessionManager.getEntries().flatMap((entry) =>
    entry.type === "custom" && entry.customType === CHECKPOINT_TYPE ? [entry.data as CheckpointRecord] : []);
}
async function seed(h: Harness, text = "Task segment: attempt A failed, B advanced the analysis.") {
  h.sessionManager.appendMessage({ role: "user", content: text.repeat(20), timestamp: Date.now() });
  h.sessionManager.appendMessage(reply("Observed A failure and B progress."));
  h.sessionManager.appendMessage({ role: "user", content: "Continue with evidence B.", timestamp: Date.now() });
  h.sessionManager.appendMessage(reply("Current task result."));
  h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
}
function lifecycle(events: string[]) {
  return (pi: ExtensionAPI) => {
    pi.on("agent_start", () => { events.push("agent_start"); });
    pi.on("turn_start", () => { events.push("turn_start"); });
    pi.on("message_start", () => { events.push("message_start"); });
    pi.on("message_end", () => { events.push("message_end"); });
    pi.on("turn_end", () => { events.push("turn_end"); });
    pi.on("agent_settled", () => { events.push("agent_settled"); });
    pi.on("tool_call", () => { events.push("tool_call"); });
  };
}

describe("JIT sidecar with real Pi compaction", () => {
  it("reflects before manual compact without main lifecycle/history/summary contamination", async () => {
    const events: string[] = [];
    const h = await fixture({ extensions: [lifecycle(events)] });
    await seed(h);
    const sourceLeaf = h.sessionManager.getLeafId();
    const originalTools = h.session.getActiveToolNames();
    h.respond((ctx) => streamReply(reply(isSidecar(ctx) ?
      "# Execution Checkpoint\n## Plugin Friction\nSIDECAR_ONLY_SECRET_1\n## Reusable Lessons\nSpecific observation." :
      "CLEAN_COMPACTION_SUMMARY")));
    await h.session.compact();
    expect(events).toEqual([]);
    expect(h.requests.length).toBeGreaterThanOrEqual(2);
    expect(isSidecar(h.requests[0])).toBe(true);
    expect(h.requests[0].tools).toEqual([]);
    expect(h.requests[0].systemPrompt).toBe(CHECKPOINT_SYSTEM_PROMPT);
    expect(h.requestOptions[0]).toMatchObject({ cacheRetention: "none", maxTokens: 2048 });
    expect(h.requestOptions[0].sessionId).not.toBe(h.session.sessionId);
    expect(JSON.stringify(h.requests[1])).not.toContain("SIDECAR_ONLY_SECRET_1");
    expect(JSON.stringify(h.requests[1])).not.toContain(CHECKPOINT_SYSTEM_PROMPT);
    expect(h.session.getActiveToolNames()).toEqual(originalTools);
    const checkpoint = checkpoints(h)[0];
    const compaction = h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")!;
    expect(checkpoint).toMatchObject({
      status: "BOUND", reflection_status: "completed", reason: "manual",
      compaction_id: compaction.id, first_kept_entry_id: compaction.firstKeptEntryId,
      tokens_before: compaction.tokensBefore, segment_leaf_id: sourceLeaf, artifact_status: "saved",
      usage: { input: 10, output: 10 },
    });
    expect(checkpoint.report).toBeUndefined();
    expect(checkpoint.duration_ms).toBeGreaterThanOrEqual(0);
    const artifact = await readFile(path.join(h.cwd, checkpoint.artifact_path!), "utf8");
    expect(artifact).toContain("SIDECAR_ONLY_SECRET_1");
    expect(JSON.stringify(h.sessionManager.buildContextEntries())).not.toContain("SIDECAR_ONLY_SECRET_1");
    expect(compaction.summary).toContain("CLEAN_COMPACTION_SUMMARY");
    h.respond(() => streamReply(reply("Task continues.")));
    await h.session.prompt("Continue the original task.");
    expect(JSON.stringify(h.requests.at(-1))).not.toContain("SIDECAR_ONLY_SECRET_1");
    expect(checkpoints(h)).toHaveLength(1);
  });

  it("triggers at an actual threshold compact inside an unsettled tool loop", async () => {
    const events: string[] = [];
    const probe = (pi: ExtensionAPI) => pi.registerTool({
      name: "checkpoint_probe", label: "Probe", description: "Test probe", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "Tool observed an execution failure." }], details: {} }),
    });
    const h = await fixture({
      extensions: [lifecycle(events), probe], tools: ["checkpoint_probe"],
      compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 20 },
    });
    await seed(h);
    let mainCalls = 0;
    let sidecarSnapshot: string[] | undefined;
    h.respond((ctx) => {
      if (isSidecar(ctx)) {
        sidecarSnapshot = [...events];
        expect(events.filter((event) => event === "agent_settled")).toHaveLength(0);
        return streamReply(reply("AUTOMATIC_CHECKPOINT"));
      }
      if (ctx.systemPrompt?.includes("context summarization assistant")) return streamReply(reply("COMPACTED_TOOL_SEGMENT"));
      mainCalls++;
      if (mainCalls === 1) {
        const message = reply("", "toolUse");
        message.usage.input = 98990;
        message.usage.totalTokens = 99000;
        message.content = [{ type: "toolCall", id: "probe-1", name: "checkpoint_probe", arguments: {} }];
        return streamReply(message);
      }
      return streamReply(reply("Task completed."));
    });
    await h.session.prompt("Inspect the execution evidence.");
    expect(sidecarSnapshot).toBeDefined();
    expect(events.filter((event) => event === "agent_start")).toHaveLength(1);
    expect(events.filter((event) => event === "agent_settled")).toHaveLength(1);
    expect(events.filter((event) => event === "turn_start")).toHaveLength(2);
    expect(mainCalls).toBe(2);
    expect(checkpoints(h)[0]).toMatchObject({ reason: "threshold", status: "BOUND" });
    expect(JSON.stringify(h.requests.at(-1))).not.toContain("AUTOMATIC_CHECKPOINT");
  });

  it.each(["error", "empty", "timeout"] as const)("lets real compaction and task continuation proceed after sidecar %s", async (failure) => {
    const h = await fixture();
    await seed(h);
    h.session.extensionRunner.setFlagValue("postmortem-checkpoint-timeout-ms", "10");
    const hold = gate();
    h.respond((ctx, signal) => {
      if (!isSidecar(ctx)) return streamReply(reply("COMPACT_STILL_WORKS"));
      if (failure === "timeout") return streamReply(reply("late"), hold.promise, signal);
      if (failure === "empty") return streamReply(reply(""));
      return streamReply({ ...reply("", "error"), errorMessage: "429 rate limit" });
    });
    await h.session.compact();
    hold.release();
    const checkpoint = checkpoints(h)[0];
    expect(checkpoint).toMatchObject({ status: "BOUND", reflection_status: "failed" });
    expect(checkpoint.error_code).toBe(failure === "timeout" ? "MODEL_TIMEOUT" : failure === "empty" ? "EMPTY_RESPONSE" : "RATE_LIMIT");
    h.respond(() => streamReply(reply("Task continued.")));
    await h.session.prompt("Continue.");
    expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("does not bind a cancelled compaction as successful", async () => {
    const cancel = (pi: ExtensionAPI) => pi.on("session_before_compact", () => ({ cancel: true }));
    const h = await fixture({ extensions: [cancel], postmortemFirst: true });
    await seed(h);
    h.respond(() => streamReply(reply("CHECKPOINT_FOR_CANCELLED_COMPACT")));
    await expect(h.session.compact()).rejects.toThrow("cancelled");
    expect(checkpoints(h)[0]).toMatchObject({ status: "COMPACTION_FAILED", reflection_status: "completed" });
    expect(checkpoints(h)[0].compaction_id).toBeUndefined();
  });

  it("aggregates only bound successful checkpoints, solely into the final provider context", async () => {
    const h = await fixture();
    let sidecars = 0;
    let failCompact = false;
    let summaries = 0;
    h.respond((ctx) => {
      if (isSidecar(ctx)) return streamReply(reply("STAGE_PRIVATE_" + ++sidecars));
      if (failCompact) return streamReply({ ...reply("", "error"), errorMessage: "compaction model failure" });
      return streamReply(reply("TASK_SUMMARY_" + ++summaries));
    });
    await seed(h, "stage one ");
    await h.session.compact();
    await seed(h, "stage two ");
    failCompact = true;
    await expect(h.session.compact()).rejects.toThrow();
    failCompact = false;
    await seed(h, "stage three ");
    await h.session.compact();
    expect(checkpoints(h).map((record) => record.status)).toEqual(["BOUND", "COMPACTION_FAILED", "BOUND"]);
    expect(JSON.stringify(h.sessionManager.getEntries())).not.toContain("STAGE_PRIVATE_");
    h.respond(() => streamReply(reply("Final stitched reflection.")));
    await h.session.prompt("/postmortem");
    await h.waitForReports();
    const finalRequest = JSON.stringify(h.requests.at(-1));
    expect(finalRequest).toContain("STAGE_PRIVATE_1");
    expect(finalRequest).toContain("STAGE_PRIVATE_3");
    expect(finalRequest).not.toContain("STAGE_PRIVATE_2");
    expect(h.records()[0].checkpoint_ids).toEqual([checkpoints(h)[0].checkpoint_id, checkpoints(h)[2].checkpoint_id]);
    expect(JSON.stringify(h.sessionManager.getEntries())).not.toContain("STAGE_PRIVATE_");
    await h.session.prompt("Continue normal work.");
    expect(JSON.stringify(h.requests.at(-1))).not.toContain("STAGE_PRIVATE_");
  });

  it("reports unavailable/tampered checkpoint artifacts as visibility gaps", async () => {
    const h = await fixture();
    await seed(h);
    h.respond((ctx) => streamReply(reply(isSidecar(ctx) ? "ORIGINAL_STAGE" : "SUMMARY")));
    await h.session.compact();
    const checkpoint = checkpoints(h)[0];
    await writeFile(path.join(h.cwd, checkpoint.artifact_path!), "---\nmetadata: 1\n---\n\nTAMPERED_STAGE");
    h.respond(() => streamReply(reply("Final with visibility limits.")));
    await h.session.prompt("/postmortem");
    await h.waitForReports();
    expect(h.records()[0].checkpoint_ids).toEqual([]);
    expect(h.records()[0].unavailable_checkpoint_ids).toEqual([checkpoint.checkpoint_id]);
    expect(JSON.stringify(h.requests.at(-1))).not.toContain("TAMPERED_STAGE");
  });

  it("skips reflection during real overflow recovery and lets Pi retry", async () => {
    const h = await fixture({ compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 20 } });
    await seed(h);
    let mainCalls = 0;
    h.respond((ctx) => {
      if (isSidecar(ctx)) throw new Error("Overflow must not call the sidecar");
      if (ctx.systemPrompt?.includes("context summarization assistant")) return streamReply(reply("OVERFLOW_SUMMARY"));
      if (++mainCalls === 1) return streamReply({ ...reply("", "error"), errorMessage: "context_length_exceeded: maximum context length exceeded" });
      return streamReply(reply("Recovered task response."));
    });
    await h.session.prompt("Continue the analysis from the available evidence.");
    await h.session.waitForIdle();
    expect(mainCalls).toBe(2);
    expect(checkpoints(h)[0]).toMatchObject({
      status: "BOUND", reason: "overflow", reflection_status: "skipped",
      error_code: "CHECKPOINT_SKIPPED_OVERFLOW", artifact_status: "not_written",
    });
    expect(h.requests.some(isSidecar)).toBe(false);
    expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("recovers bound metadata from disk and excludes checkpoints outside the current branch", async () => {
    const h = await fixture();
    await seed(h);
    const leaf = h.sessionManager.getLeafId()!;
    h.respond((ctx) => streamReply(reply(isSidecar(ctx) ? "RESTORED_STAGE" : "RESTORED_SUMMARY")));
    await h.session.compact();
    const restored = SessionManager.open(h.sessionManager.getSessionFile()!);
    const ctx = { sessionManager: restored } as unknown as ExtensionContext;
    expect((await boundCheckpoints(ctx)).records.map((record) => record.report)).toEqual(["RESTORED_STAGE"]);
    restored.branch(leaf);
    expect((await boundCheckpoints(ctx)).records).toEqual([]);
  });
});
