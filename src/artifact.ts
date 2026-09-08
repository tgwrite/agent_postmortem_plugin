import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { errorText, SCHEMA, type ArtifactResult, type PostmortemRecord } from "./types.js";

export function renderArtifact(record: PostmortemRecord): string {
  const { report, ...metadata } = record;
  // JSON scalars/objects are valid YAML values and safely quote paths and newlines.
  const header = Object.entries({ schema: SCHEMA, ...metadata })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  return `---\n${header}\n---\n\n${report}`;
}

export async function writeArtifact(record: PostmortemRecord): Promise<ArtifactResult> {
  const timestamp = (record.started_at ?? record.requested_at).replace(/[:.]/g, "-");
  // File components never contain untrusted workspace/session names.
  const id = record.request_id.replace(/[^a-zA-Z0-9-]/g, "_");
  const relative = `.agent-postmortem/reports/${timestamp}_${id}.md`;
  const destination = path.join(record.workspace, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  const document = renderArtifact({ ...record, artifact_status: "saved", artifact_path: relative });
  await writeFile(destination, document, { encoding: "utf8", flag: "wx" });

  const temporary = path.join(record.workspace, ".agent-postmortem", `.latest-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, document, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path.join(record.workspace, ".agent-postmortem", "latest.md"));
    return { artifact_path: relative, latest_status: "saved" };
  } catch (error) {
    return { artifact_path: relative, latest_status: "failed", latest_error: errorText(error) };
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
