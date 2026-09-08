import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, gate, reply, streamReply, type Harness } from "./harness.js";
import { ENTRY_TYPE, REQUEST_TYPE } from "../src/types.js";

const fixtures: Harness[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture(options?: Parameters<typeof createHarness>[0]) {
  const result = await createHarness(options);
  fixtures.push(result);
  return result;
}

describe("postmortem in the real Pi agent loop", () => {
  it("uses current history, saves one raw report in both locations, and restores tools", async () => {
    const h = await fixture();
    h.respond(() => streamReply(reply("Task completed after attempt B.")));
    await h.session.prompt("Try A then B.");
    const tools = h.session.getActiveToolNames();
    const report = "# Task Postmortem\n\n中文复盘\nA failed; B worked.\n";
    h.respond(() => streamReply(reply(report)));
    await h.session.prompt("/postmortem");
    await h.waitForReports();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].tools).toEqual([]);
    expect(JSON.stringify(h.requests[1].messages)).toContain("Task completed after attempt B.");
    expect(h.session.getActiveToolNames()).toEqual(tools);
    const record = h.records()[0];
    expect(record.status).toBe("completed");
    expect(record.report).toBe(report);
    expect(record.context?.session_leaf_id).toBeTruthy();
    expect(record.response_entry_id).toBeTruthy();
    const artifact = await readFile(path.join(h.cwd, record.artifact_path!), "utf8");
    expect(artifact.split("---\n\n")[1]).toBe(report);
    expect(await readFile(path.join(h.cwd, ".agent-postmortem/latest.md"), "utf8")).toBe(artifact);
    const loaded = SessionManager.open(h.session.sessionFile!);
    expect(loaded.getEntries().filter((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE)).toHaveLength(1);
    expect(JSON.stringify(loaded.buildSessionContext().messages)).not.toContain('"artifact_status"');
    await h.session.extensionRunner.emit({ type: "agent_settled" });
    expect(h.records()).toHaveLength(1);
  });

  it("waits for a running task and its queued continuation; rejects duplicate requests", async () => {
    const h = await fixture();
    const hold = gate();
    let calls = 0;
    h.respond((_ctx, signal) => streamReply(reply(++calls === 1 ? "first" : calls === 2 ? "follow-up" : "reflection"),
      calls === 1 ? hold.promise : undefined, signal));
    const task = h.session.prompt("task");
    await expect.poll(() => h.requests.length).toBe(1);
    await h.session.prompt("/postmortem");
    await h.session.prompt("/postmortem");
    expect(h.session.getActiveToolNames()).toEqual(["read", "write"]);
    await h.session.prompt("finish the follow-up", { streamingBehavior: "followUp" });
    hold.release();
    await task;
    await h.waitForReports();
    expect(h.requests).toHaveLength(3);
    expect(h.requests[1].tools?.map((tool) => tool.name)).toEqual(["read", "write"]);
    expect(h.requests[2].tools).toEqual([]);
    expect(h.records()[0].report).toBe("reflection");
  });

  it("restores tools before a queued ordinary follow-up and captures only the reflection", async () => {
    const h = await fixture();
    const hold = gate();
    h.respond((_ctx, signal) => streamReply(reply(h.requests.length === 1 ? "reflection" : "new task answer"),
      h.requests.length === 1 ? hold.promise : undefined, signal));
    await h.session.prompt("/postmortem");
    await expect.poll(() => h.requests.length).toBe(1);
    await h.session.prompt("/postmortem");
    await h.session.prompt("a new task", { streamingBehavior: "followUp" });
    hold.release();
    await h.waitForReports();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[0].tools).toEqual([]);
    expect(h.requests[1].tools?.map((tool) => tool.name)).toEqual(["read", "write"]);
    expect(h.records()[0].report).toBe("reflection");
  });

  it.each(["error", "aborted", "length"] as const)("records %s responses as failures, preserving partial text", async (reason) => {
    const h = await fixture();
    h.respond(() => streamReply(reply("partial", reason)));
    await h.session.prompt("/postmortem");
    await h.waitForReports();
    expect(h.records()[0].status).toBe("failed");
    expect(h.records()[0].report).toBe("partial");
    expect(h.records()[0].assistant_stop_reason).toBe(reason);
    expect(h.session.getActiveToolNames()).toEqual(["read", "write"]);
  });

  it("records empty responses without inventing a report", async () => {
    const h = await fixture();
    h.respond(() => streamReply(reply("")));
    await h.session.prompt("/postmortem");
    await h.waitForReports();
    expect(h.records()[0].error_code).toBe("POSTMORTEM_EMPTY_RESPONSE");
    expect(h.records()[0].report).toBe("");
  });

  it("captures the successful automatic retry rather than its earlier error", async () => {
    const h = await fixture({ retry: true });
    h.respond(() => {
      if (h.requests.length === 1) return streamReply({ ...reply("", "error"), errorMessage: "429 rate limit exceeded" });
      return streamReply(reply("reflection after retry"));
    });
    await h.session.prompt("/postmortem");
    await h.waitForReports();
    expect(h.requests).toHaveLength(2);
    expect(h.requests.every((request) => request.tools?.length === 0)).toBe(true);
    expect(h.records()[0].status).toBe("completed");
    expect(h.records()[0].report).toBe("reflection after retry");
  });

  it("preserves session output when the reports directory cannot be written", async () => {
    const h = await fixture({ setup: async (cwd) => {
      await mkdir(path.join(cwd, ".agent-postmortem"));
      await writeFile(path.join(cwd, ".agent-postmortem/reports"), "file, not directory");
    } });
    await h.session.prompt("/postmortem");
    await h.waitForReports();
    expect(h.records()[0].artifact_status).toBe("failed");
    expect(h.records()[0].report).toContain("# Task Postmortem");
    expect(h.session.getActiveToolNames()).toEqual(["read", "write"]);
  });

  it("blocks a hallucinated tool call and restores the original tool surface", async () => {
    const h = await fixture();
    const message = reply("I will read", "toolUse");
    message.content.push({ type: "toolCall", id: "forbidden", name: "read", arguments: { path: "secret.txt" } });
    h.respond(() => streamReply(message));
    await h.session.prompt("/postmortem");
    await h.waitForReports();
    expect(h.records()[0].error_code).toBe("POSTMORTEM_TOOL_CALL");
    expect(h.records()[0].status).toBe("failed");
    expect(h.session.getActiveToolNames()).toEqual(["read", "write"]);
  });

  it("does not capture a reply when another extension replaces the reflection with steering", async () => {
    const inject = (pi: ExtensionAPI) => {
      let used = false;
      pi.on("message_end", (event) => {
        if (!used && event.message.role === "custom" && event.message.customType === REQUEST_TYPE) {
          used = true;
          pi.sendUserMessage("new instructions", { deliverAs: "steer" });
        }
      });
    };
    const h = await fixture({ extensions: [inject] });
    h.respond(() => streamReply(reply("answer to new instructions")));
    await h.session.prompt("/postmortem");
    await h.waitForReports();
    expect(h.records()[0].status).toBe("cancelled");
    expect(h.records()[0].error_code).toBe("POSTMORTEM_INTERLEAVED_MESSAGE");
    expect(h.records()[0].report).toBe("");
  });

  it("records the active branch's compaction boundary without replaying compacted history", async () => {
    const h = await fixture();
    const old = h.sessionManager.appendMessage({ role: "user", content: "lost early attempt", timestamp: 1 });
    const kept = h.sessionManager.appendMessage({ role: "user", content: "retained evidence", timestamp: 2 });
    h.sessionManager.appendCompaction("Earlier work summarized.", kept, 10000);
    h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
    await h.session.prompt("/postmortem");
    await h.waitForReports();
    expect(h.records()[0].context?.compaction_count).toBe(1);
    const request = JSON.stringify(h.requests[0].messages);
    expect(request).toContain("Earlier work summarized.");
    expect(request).toContain("retained evidence");
    expect(request).not.toContain("lost early attempt");
    expect(h.sessionManager.getEntry(old)).toBeDefined();
  });

  it("loads the shipped TypeScript entry through Pi's extension loader", async () => {
    const h = await fixture({ paths: [path.resolve("src/index.ts")], includePostmortem: false });
    expect(h.session.extensionRunner.getRegisteredCommands().filter((command) => command.name === "postmortem")).toHaveLength(1);
    await h.session.prompt("/postmortem");
    await h.waitForReports();
    expect(h.records()[0].status).toBe("completed");
    expect(h.requests[0].tools).toEqual([]);
  });

  it("restores tools when the user aborts an active model stream", async () => {
    const h = await fixture();
    const hold = gate();
    h.respond((_ctx, signal) => streamReply(reply("unfinished"), hold.promise, signal));
    await h.session.prompt("/postmortem");
    await expect.poll(() => h.requests.length).toBe(1);
    await h.session.abort();
    hold.release();
    await h.waitForReports();
    expect(h.records()[0].error_code).toBe("POSTMORTEM_ABORTED");
    expect(h.session.getActiveToolNames()).toEqual(["read", "write"]);
  });
  it("supports another explicit postmortem and writes unique artifacts", async () => {
    const h = await fixture();
    await h.session.prompt("/postmortem");
    await h.waitForReports();
    await h.session.prompt("/postmortem");
    await h.waitForReports(2);
    expect(h.records()[0].request_id).not.toBe(h.records()[1].request_id);
    expect(await readdir(path.join(h.cwd, ".agent-postmortem/reports"))).toHaveLength(2);
  });
});
