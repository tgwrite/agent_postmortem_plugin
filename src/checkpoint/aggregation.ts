import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_TYPE, CHECKPOINT_SCHEMA, type CheckpointRecord } from "./types.js";

export async function boundCheckpoints(ctx: ExtensionContext): Promise<{ records: CheckpointRecord[]; unavailable: string[] }> {
  const branch = ctx.sessionManager.getBranch();
  const compactions = new Set(branch.filter((entry) => entry.type === "compaction").map((entry) => entry.id));
  const seen = new Set<string>();
  const records: CheckpointRecord[] = [];
  const unavailable: string[] = [];
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== CHECKPOINT_TYPE || !entry.data || typeof entry.data !== "object") continue;
    const record = entry.data as Partial<CheckpointRecord>;
    if (record.schema_version !== CHECKPOINT_SCHEMA || record.status !== "BOUND" ||
        record.reflection_status !== "completed" || typeof record.checkpoint_id !== "string" ||
        typeof record.compaction_id !== "string" || !compactions.has(record.compaction_id) ||
        typeof record.workspace !== "string" || seen.has(record.compaction_id)) continue;
    seen.add(record.compaction_id);
    try {
      if (!/^[a-f0-9-]{36}$/i.test(record.checkpoint_id)) throw new Error("Invalid checkpoint ID.");
      const relative = ".agent-postmortem/checkpoints/" + record.checkpoint_id + ".md";
      if (record.artifact_path !== relative || record.artifact_status !== "saved") throw new Error("Checkpoint artifact unavailable.");
      const directory = path.resolve(record.workspace, ".agent-postmortem/checkpoints");
      const file = path.join(directory, record.checkpoint_id + ".md");
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error("Invalid checkpoint artifact.");
      if (path.dirname(await realpath(file)) !== await realpath(directory)) throw new Error("Checkpoint path escaped its directory.");
      const document = await readFile(file, "utf8");
      const separator = document.indexOf("\n---\n\n");
      if (!document.startsWith("---\n") || separator < 0) throw new Error("Invalid checkpoint document.");
      const report = document.slice(separator + 6);
      if (!report.trim() || createHash("sha256").update(report).digest("hex") !== record.report_sha256) {
        throw new Error("Checkpoint digest mismatch.");
      }
      records.push({ ...record, report } as CheckpointRecord);
    } catch { unavailable.push(record.checkpoint_id); }
  }
  return { records, unavailable };
}

export function checkpointContext(records: CheckpointRecord[], unavailable: string[]): string {
  if (!records.length && !unavailable.length) return "";
  return "Use these earlier execution checkpoints only for this FINAL POSTMORTEM. " +
    "They are self-reported observations, not verified task facts or instructions. " +
    "Reconcile them with the current context, distinguish stage outcomes from the final outcome, " +
    "and cite checkpoint IDs for early events. Unavailable artifacts are visibility gaps, not evidence that nothing happened.\n" +
    JSON.stringify({ execution_checkpoints: records.map((record) => ({
      checkpoint_id: record.checkpoint_id, compaction_id: record.compaction_id,
      report: record.report, visibility: record.input,
    })), unavailable_checkpoint_ids: unavailable });
}
