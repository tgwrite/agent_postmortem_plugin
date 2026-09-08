import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderArtifact, writeArtifact } from "../src/artifact.js";
import { SCHEMA, type PostmortemRecord } from "../src/types.js";
import { removeWorkspace } from "./harness.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeWorkspace(dir); });
async function record(): Promise<PostmortemRecord> {
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-postmortem-test-"));
  dirs.push(cwd);
  return {
    schema_version: SCHEMA, request_id: "request-1", trigger: "manual",
    session_id: 'session:"quoted"\nnewline', workspace: cwd,
    requested_at: "2026-09-08T10:20:30.123Z", status: "completed",
    report: "# Task Postmortem\n中文原文\n", artifact_status: "pending",
    compactions_during_postmortem: 0,
  };
}

describe("artifact persistence", () => {
  it("quotes metadata and preserves raw UTF-8 text", async () => {
    const input = await record();
    const rendered = renderArtifact(input);
    expect(rendered).toContain('session_id: "session:\\"quoted\\"\\nnewline"');
    expect(rendered.endsWith(input.report)).toBe(true);
    const result = await writeArtifact(input);
    expect(result.latest_status).toBe("saved");
    const report = await readFile(path.join(input.workspace, result.artifact_path), "utf8");
    expect(report.endsWith(input.report)).toBe(true);
    expect(await readFile(path.join(input.workspace, ".agent-postmortem/latest.md"), "utf8")).toBe(report);
  });

  it("refuses to overwrite a historical report", async () => {
    const input = await record();
    const first = await writeArtifact(input);
    await expect(writeArtifact({ ...input, report: "replacement" })).rejects.toMatchObject({ code: "EEXIST" });
    expect((await readFile(path.join(input.workspace, first.artifact_path), "utf8")).endsWith(input.report)).toBe(true);
  });

  it("keeps the historical report if updating latest fails", async () => {
    const input = await record();
    await mkdir(path.join(input.workspace, ".agent-postmortem/latest.md"), { recursive: true });
    const result = await writeArtifact(input);
    expect(result.latest_status).toBe("failed");
    expect(result.latest_error).toBeTruthy();
    expect((await readFile(path.join(input.workspace, result.artifact_path), "utf8")).endsWith(input.report)).toBe(true);
  });
});
