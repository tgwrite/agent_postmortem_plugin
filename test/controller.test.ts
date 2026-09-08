import path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PostmortemController } from "../src/controller.js";
import { PostmortemState } from "../src/state.js";
import { assistantText, isRequestMessage } from "../src/message.js";
import { REQUEST_TYPE, type PostmortemRecord } from "../src/types.js";
import { gate, reply } from "./harness.js";

function fixture() {
  let tools = ["read", "write"];
  const sessionManager = SessionManager.inMemory(process.cwd());
  const entries: PostmortemRecord[] = [];
  const pi = {
    getActiveTools: vi.fn(() => tools),
    setActiveTools: vi.fn((next: string[]) => { tools = [...next]; }),
    sendMessage: vi.fn(),
    appendEntry: vi.fn((_type: string, record: PostmortemRecord) => entries.push(record)),
  };
  const ctx = {
    cwd: process.cwd(), sessionManager, model: undefined,
    isIdle: vi.fn(() => true), hasPendingMessages: vi.fn(() => false),
    getContextUsage: () => undefined, abort: vi.fn(), ui: { notify: vi.fn() },
  };
  const save = vi.fn(async (_record: PostmortemRecord) => ({
    artifact_path: ".agent-postmortem/reports/test.md",
  }));
  const controller = new PostmortemController(pi as unknown as ExtensionAPI, save);
  const context = ctx as unknown as ExtensionContext;
  const deliver = () => {
    const sent = pi.sendMessage.mock.calls.at(-1)?.[0] as { details: { request_id: string } };
    controller.messageStart({ message: {
      role: "custom", customType: REQUEST_TYPE, content: "prompt",
      details: sent.details, display: true, timestamp: 1,
    } }, context);
  };
  const respond = (text: string) => {
    const message = reply(text);
    controller.messageEnd({ type: "message_end", message });
    controller.turnEnd({ type: "turn_end", message, turnIndex: 0, toolResults: [] }, context);
  };
  return { pi, ctx, context, controller, save, entries, deliver, respond };
}

describe("controller failure and ownership boundaries", () => {
  it("rejects unsupported arguments without mutating tools", () => {
    const f = fixture();
    f.controller.request("auto", f.context);
    expect(f.pi.setActiveTools).not.toHaveBeenCalled();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("restores tools and records synchronous injection failure", async () => {
    const f = fixture();
    f.pi.sendMessage.mockImplementation(() => { throw new Error("injection failed"); });
    f.controller.request("", f.context);
    await vi.waitFor(() => expect(f.entries).toHaveLength(1));
    expect(f.pi.getActiveTools()).toEqual(["read", "write"]);
    expect(f.entries[0].error_code).toBe("POSTMORTEM_START_FAILED");
    expect(f.entries[0].report).toBe("");
  });

  it("ignores unrelated assistant output until its own request is delivered", async () => {
    const f = fixture();
    f.controller.request("", f.context);
    f.respond("unrelated");
    await f.controller.settled(f.context);
    expect(f.entries[0].error_code).toBe("POSTMORTEM_REQUEST_NOT_DELIVERED");
    expect(f.entries[0].report).toBe("");
  });

  it("restores before slow persistence and serializes shutdown/finalization", async () => {
    const f = fixture();
    const hold = gate();
    f.save.mockImplementation(async () => { await hold.promise; return { artifact_path: ".agent-postmortem/reports/test.md" }; });
    f.controller.request("", f.context);
    f.deliver();
    f.respond("raw reflection");
    expect(f.pi.getActiveTools()).toEqual(["read", "write"]);
    const settled = f.controller.settled(f.context);
    const shutdown = f.controller.shutdown(f.context);
    f.controller.request("", f.context);
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    hold.release();
    await Promise.all([settled, shutdown]);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.entries).toHaveLength(1);
    expect(f.ctx.ui.notify).toHaveBeenCalledWith(
      "Postmortem saved: " + path.resolve(f.ctx.cwd, ".agent-postmortem/reports/test.md"), "info",
    );
  });

  it("keeps the report artifact and tools when session persistence throws", async () => {
    const f = fixture();
    f.pi.appendEntry.mockImplementation(() => { throw new Error("session disk full"); });
    f.controller.request("", f.context);
    f.deliver();
    f.respond("raw");
    await f.controller.settled(f.context);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.pi.getActiveTools()).toEqual(["read", "write"]);
    expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("session disk full"), "error");
  });

  it("survives both persistence failures and unavailable UI", async () => {
    const f = fixture();
    f.save.mockRejectedValue(new Error("artifact failure"));
    f.pi.appendEntry.mockImplementation(() => { throw new Error("entry failure"); });
    f.ctx.ui.notify.mockImplementation(() => { throw new Error("UI failure"); });
    f.controller.request("", f.context);
    f.deliver();
    f.respond("raw");
    await f.controller.settled(f.context);
    expect(f.pi.getActiveTools()).toEqual(["read", "write"]);
    f.controller.request("", f.context);
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(2);
    await f.controller.shutdown(f.context);
  });

  it("retains a failed tool snapshot for recovery before accepting another request", async () => {
    const f = fixture();
    f.controller.request("", f.context);
    f.deliver();
    f.pi.setActiveTools.mockImplementation(() => { throw new Error("temporary restoration failure"); });
    f.respond("raw");
    await f.controller.settled(f.context);
    expect(f.entries[0].tool_restore_error).toContain("temporary");
    f.controller.request("", f.context);
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    f.pi.setActiveTools.mockImplementation((next) => { f.pi.getActiveTools.mockReturnValue([...next]); });
    f.controller.request("", f.context);
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(2);
    await f.controller.shutdown(f.context);
    expect(f.pi.getActiveTools()).toEqual(["read", "write"]);
  });

  it("cancels pending and running requests at reload/shutdown and prevents branch changes", async () => {
    for (const idle of [false, true]) {
      const f = fixture();
      f.ctx.isIdle.mockReturnValue(idle);
      f.controller.request("", f.context);
      expect(f.controller.beforeNavigate(f.context)).toEqual({ cancel: true });
      await f.controller.shutdown(f.context);
      expect(f.entries[0].status).toBe("cancelled");
      expect(f.entries[0].error_code).toBe("POSTMORTEM_SESSION_SHUTDOWN");
      expect(f.controller.beforeNavigate(f.context)).toBeUndefined();
      expect(f.pi.getActiveTools()).toEqual(["read", "write"]);
    }
  });

  it("rechecks idle after settled to allow a later extension continuation", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.ctx.isIdle.mockReturnValue(false);
      f.controller.request("", f.context);
      await f.controller.settled(f.context);
      await vi.runAllTimersAsync();
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
      f.ctx.isIdle.mockReturnValue(true);
      await f.controller.settled(f.context);
      await vi.runAllTimersAsync();
      expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
      await f.controller.shutdown(f.context);
    } finally { vi.useRealTimers(); }
  });
});

describe("message extraction and state", () => {
  it("preserves all text blocks verbatim and excludes thinking", () => {
    const message = reply("");
    message.content = [{ type: "thinking", thinking: "internal" },
      { type: "text", text: "# Report\n" }, { type: "text", text: "中文\n" }];
    expect(assistantText(message)).toBe("# Report\n中文\n");
    expect(assistantText({ role: "user", content: "ignore", timestamp: 1 })).toBeUndefined();
  });

  it("requires the exact custom message type and request ID", () => {
    const message = { role: "custom" as const, customType: REQUEST_TYPE, content: "",
      display: false, timestamp: 1, details: { request_id: "right" } };
    expect(isRequestMessage(message, "wrong")).toBe(false);
    expect(isRequestMessage(message, "right")).toBe(true);
  });

  it("allows completion and cancellation but rejects recursive starts", () => {
    const state = new PostmortemState();
    expect(() => state.move("RUNNING")).toThrow();
    state.move("REQUESTED"); state.move("RUNNING");
    expect(() => state.move("RUNNING")).toThrow();
    state.move("CAPTURED"); state.move("IDLE");
    state.move("REQUESTED"); state.move("CAPTURED"); state.move("IDLE");
  });
});
