export const SCHEMA = "agent-postmortem-v1";
export const REQUEST_TYPE = "agent-postmortem-request";
export const ENTRY_TYPE = "agent-postmortem";

export type PostmortemPhase = "IDLE" | "REQUESTED" | "RUNNING" | "CAPTURED";

export interface ContextSnapshot {
  session_leaf_id: string | null;
  branch_entry_count: number;
  compaction_count: number;
  latest_compaction_id?: string;
  context_tokens: number | null;
  context_window: number | null;
}

export interface PostmortemRecord {
  schema_version: typeof SCHEMA;
  request_id: string;
  trigger: "manual";
  requested_at: string;
  started_at?: string;
  completed_at?: string;
  session_id: string;
  session_file?: string;
  workspace: string;
  context?: ContextSnapshot;
  model?: { provider: string; id: string };
  status: "completed" | "failed" | "cancelled";
  error_code?: string;
  error?: string;
  report: string;
  assistant_stop_reason?: string;
  response_entry_id?: string;
  compactions_during_postmortem: number;
  checkpoint_ids?: string[];
  unavailable_checkpoint_ids?: string[];
  artifact_status: "pending" | "saved" | "failed";
  artifact_path?: string;
  artifact_error?: string;
  tool_restore_error?: string;
}

export interface ArtifactResult {
  artifact_path: string;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
