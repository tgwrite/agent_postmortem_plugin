import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CheckpointRecord } from "./types.js";

export async function writeCheckpointArtifact(record: CheckpointRecord, signal?: AbortSignal): Promise<string> {
  const relative = ".agent-postmortem/checkpoints/" + record.checkpoint_id + ".md";
  const destination = path.join(record.workspace, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  const { report, status, ...metadata } = record;
  // This is the Phase A snapshot. The later custom entry is authoritative for
  // BOUND/COMPACTION_FAILED; do not falsely claim a compaction succeeded here.
  const header = Object.entries({ ...metadata, artifact_path: relative, artifact_status: "saved", binding_status_at_write: status })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => key + ": " + JSON.stringify(value)).join("\n");
  await writeFile(destination, "---\n" + header + "\n---\n\n" + report,
    { encoding: "utf8", flag: "wx", signal });
  return relative;
}
