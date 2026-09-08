import type { Usage } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

export const CHECKPOINT_TYPE = "agent-postmortem-checkpoint";
export const CHECKPOINT_SCHEMA = "agent-postmortem-checkpoint-v1";
export type CheckpointReason = SessionBeforeCompactEvent["reason"];
export interface CheckpointRecord {
  schema_version: typeof CHECKPOINT_SCHEMA;
  checkpoint_id: string;
  session_id: string;
  workspace: string;
  segment_leaf_id: string | null;
  started_at: string;
  completed_at?: string;
  reason: CheckpointReason;
  will_retry: boolean;
  status: "PENDING_COMPACTION" | "BOUND" | "COMPACTION_FAILED" | "ABANDONED";
  reflection_status: "completed" | "failed" | "skipped";
  error_code?: string;
  error?: string;
  compaction_error?: string;
  compaction_id?: string;
  first_kept_entry_id: string;
  tokens_before: number;
  prepared_tokens_before: number;
  model?: { provider: string; id: string };
  duration_ms: number;
  usage?: Usage;
  input?: { segment_messages: number; serialized_chars: number; supplied_chars: number; truncated: boolean };
  report: string;
  report_sha256?: string;
  artifact_status: "not_written" | "saved" | "failed";
  artifact_path?: string;
  artifact_error?: string;
}
export interface CheckpointConfig {
  enabled: boolean;
  timeoutMs: number;
  maxTokens: number;
  maxInputChars: number;
  previousSummaryChars: number;
}
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  enabled: true, timeoutMs: 45000, maxTokens: 2048, maxInputChars: 120000, previousSummaryChars: 12000,
};
