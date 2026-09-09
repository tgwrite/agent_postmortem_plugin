# Architecture and limits

The plugin has two reflection paths: a checkpoint before compaction and a final review requested by `/postmortem`. Neither reflection is an independent audit of task correctness.

## Checkpoint lifecycle

On `session_before_compact`, the checkpoint controller takes Pi's prepared compaction segment and calls `ctx.modelRegistry.complete()` with the current model, a separate reflection system prompt, no tools, a separate request session ID, and `cacheRetention: "none"`.

The input contains `messagesToSummarize + turnPrefixMessages`, with `previousSummary` as bounded background. Serialization uses Pi's `convertToLlm` and `serializeConversation`, including their tool-result truncation behavior. Additional limits retain the beginning and end of the execution text within 120,000 characters and the previous summary within 12,000 characters, with omission markers. These are character budgets, not exact token budgets.

The checkpoint call does not create a main agent turn, inherit the main task system prompt, or change active tools. Task messages already present in the execution segment remain input data.

Binding happens in two phases:

1. Save the initial Markdown artifact with `binding_status_at_write: PENDING_COMPACTION`.
2. On `session_compact`, verify the session, trigger, compaction boundaries, and source branch. Persist the authoritative binding in an `agent-postmortem-checkpoint` custom entry, including the exact `compaction_id`, `first_kept_entry_id`, and `tokens_before`.

Checkpoint custom entries contain metadata, not the reflection body. The artifact retains its initial snapshot and is not rewritten after compaction. A failed compaction records `COMPACTION_FAILED`; shutdown or a superseding request can record `ABANDONED`. A nearby later compaction does not automatically adopt an unbound file.

`BOUND` means that the corresponding compaction succeeded. Check `reflection_status` and `artifact_status` separately to determine whether the reflection completed and its artifact was saved. Diagnostics include usage when supplied by the provider, model identity, duration, input length, truncation, and error codes. Missing usage is not fabricated.

## Failure handling and thinking settings

The checkpoint request defaults to 45 seconds and 2,048 output tokens, capped by the model's output limit. It is not retried. Errors, empty responses, truncated output, attempted tool calls, and timeouts are recorded as failures. Late responses from a provider that ignores cancellation do not overwrite reports or bind to later compactions.

Checkpoint errors do not replace or cancel compaction. Existing cancellation signals are respected. Disabled checkpoints, missing models, empty execution segments, and compaction during a final review skip the sidecar. Context-overflow recovery skips its model call and artifact write, recording `CHECKPOINT_SKIPPED_OVERFLOW`.

For supported OpenAI-compatible Completions and Responses reasoning APIs, the plugin reads `pi.getThinkingLevel()` at each trigger and forwards it as `reasoningEffort`, retaining the selected level rather than selecting a lower default. Metadata records `session_thinking_level` and `reasoning_effort`. This adapter does not cover every provider API.

## Final review

`/postmortem` takes no arguments. If the task is running, its request waits for `agent_settled`. Pending duplicate requests are deduplicated. The final controller snapshots active tools, disables tool use during reflection, associates the response with its request, and restores the prior tool selection when the review finishes or is interrupted.

A temporary `context` hook adds completed, bound checkpoint reports from the current branch to the final model request. Aggregation verifies paths, size limits, and the report body's SHA-256. Missing, corrupted, or unsuccessfully saved reports are identified as visibility gaps. Reports from failed compactions or other branches are excluded. Reopened sessions can recover aggregation using the custom entries and original artifact files.

Checkpoint input and raw responses do not become normal conversation messages or subsequent compaction summaries. Ordinary task continuation does not automatically receive checkpoint reflection text. The final review's prompt and assistant reply do remain in normal conversation history. Users and other extensions can explicitly read or inject saved artifacts; this plugin cannot prevent that.

Final review records use the `agent-postmortem` custom entry type. Shutdown and reload clean up the current lifecycle without automatically restarting unfinished reviews.

## Storage and privacy

Artifact paths are rooted in the current extension context's `ctx.cwd`, including when resuming a session. They do not use the source checkout or the session header's historical directory.

- Checkpoints: `.agent-postmortem/checkpoints/<checkpoint-id>.md`
- Final reports: `.agent-postmortem/reports/<timestamp>_<request-id>.md`

One final review writes one report. Existing files are not automatically removed, and there is no `latest.md`. Store or delete task artifacts according to the task's needs, and ignore the output directory in repositories where reports should remain local.

Reflections send task content to the configured model provider. Disabling request caching is not a promise about provider-side data retention. Report files and Pi session history can retain task details locally; sanitize them before sharing.

## Validation boundaries

The test suite covers controller lifecycle, tools, artifact persistence, manual and threshold compaction, overflow recovery, failure continuation, context separation, branch recovery, aggregation, and reasoning settings using a deterministic local provider.

Real-model usefulness must be evaluated separately. Models can omit or misinterpret evidence. The plugin cannot reconstruct execution details that were never visible, and aggregating many checkpoint reports without further summarization can exceed the model's context window.
