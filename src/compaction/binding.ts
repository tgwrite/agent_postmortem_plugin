import type { ExtensionContext, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import type { CheckpointRecord } from "../checkpoint/types.js";

export function bindCheckpoint(
  record: CheckpointRecord, event: SessionCompactEvent, ctx: ExtensionContext, previousIds: ReadonlySet<string>,
): void {
  const entry = event.compactionEntry;
  const branch = ctx.sessionManager.getBranch(entry.id);
  const matches = ctx.sessionManager.getSessionId() === record.session_id &&
    event.reason === record.reason && !previousIds.has(entry.id) &&
    entry.firstKeptEntryId === record.first_kept_entry_id &&
    (record.segment_leaf_id === null || branch.some((item) => item.id === record.segment_leaf_id));
  if (!matches) {
    record.status = "COMPACTION_FAILED";
    record.compaction_error = "CHECKPOINT_BINDING_MISMATCH";
    return;
  }
  record.status = "BOUND";
  record.compaction_id = entry.id;
  record.first_kept_entry_id = entry.firstKeptEntryId;
  record.tokens_before = entry.tokensBefore;
}
