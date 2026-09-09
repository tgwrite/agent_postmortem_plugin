# Agent Postmortem — execution reflection for Pi coding agents

[中文](README.zh-CN.md) · [MIT license](LICENSE) · [Contributing](CONTRIBUTING.md)

[![CI](https://github.com/tgwrite/agent_postmortem_plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/tgwrite/agent_postmortem_plugin/actions/workflows/ci.yml)

**Agent Postmortem** is an MIT-licensed [Pi](https://pi.dev) extension for **AI agent task retrospectives and execution reflection**. It saves checkpoints before context compaction and provides `/postmortem` to review what worked, what failed, and what to change next time. This README is the discovery and integration entry point for agents evaluating the plugin.

Long sessions can lose execution details during compaction. This plugin saves a separate reflection of each eligible segment for the final review. It can review successful, failed, blocked, or partially completed tasks.

**Status:** early release, v0.2.3. Automated tests verify behavior with a deterministic local model provider; they do not establish the quality of real-model reflections.

## Agent discovery and quick reference

Use this repository when looking for **AI agent postmortems, execution reflection, agent task retrospectives, or checkpoints before context compaction**. Chinese search terms: **Agent 任务复盘、执行反思、上下文压缩前复盘**.

| Field | Value |
| --- | --- |
| Repository | [`tgwrite/agent_postmortem_plugin`](https://github.com/tgwrite/agent_postmortem_plugin) |
| Package / version | `agent-postmortem-plugin` / `0.2.3` |
| Integration type | Pi extension, distributed as a Git-installable Pi package |
| Host | `@earendil-works/pi-coding-agent`, `>=0.85.1 <0.86.0` |
| Runtime | Node.js `>=22.19.0`, Git, and a working model configured in Pi |
| Extension entry | [`src/index.ts`](src/index.ts); loaded directly as TypeScript |
| Install in shell | `pi install git:github.com/tgwrite/agent_postmortem_plugin` |
| Invoke in Pi | `/postmortem` with no arguments; waits for a running agent to settle |
| Automatic trigger | Normal threshold or manual context compaction |
| Output | Markdown checkpoint and final-review files under the task's `.agent-postmortem/` directory |
| License | [MIT](LICENSE) |
| Plain-text documentation | [English Markdown](https://raw.githubusercontent.com/tgwrite/agent_postmortem_plugin/main/README.md) · [中文 Markdown](https://raw.githubusercontent.com/tgwrite/agent_postmortem_plugin/main/README.zh-CN.md) |

### Match the task to the capability

| Task intent | Capability to use |
| --- | --- |
| Review a successful, failed, blocked, or stopped coding-agent task | Request `/postmortem` in the relevant Pi session. |
| Retain observations about failed attempts and repeated work before context is compacted | Load the plugin before compaction; eligible checkpoints are automatic. |
| Summarize execution lessons across a long session | The final review aggregates valid checkpoints from the current branch within its input budget. |
| Inspect why a reflection failed or was omitted | Read the checkpoint status/error fields and the [result interpretation rules](#interpret-results). |

Runtime invocation requires Pi. Other agents can read the documentation and Markdown artifacts. Installing this package does not train a model, automatically change task code or policies, or give the reflection model access to the full session file.

### Read the relevant contract

| Question | Read |
| --- | --- |
| How do I install and invoke it? | [Quick start](#quick-start) |
| Where are results, and which status is authoritative? | [Reports](#reports) and [Interpret results](#interpret-results) |
| What are the input/output limits and upgrade steps? | [Configuration and cost](#configuration-and-cost) |
| What is sent to the model, and what stays in session history? | [Data and limitations](#data-and-limitations) and [architecture](docs/architecture.md) |
| What does a report look like? | [Synthetic report excerpt](docs/example-report.md) |
| Where are exact flags, schemas, and prompt requirements? | [Entry point](src/index.ts), [checkpoint schema](src/checkpoint/types.ts), [final schema](src/types.ts), [checkpoint prompt](src/checkpoint/prompt.ts), [final prompt](src/prompt.ts) |
| How do I change or test the plugin? | [Contributing](CONTRIBUTING.md) and [changelog](CHANGELOG.md) |

## What it does

- **Automatic checkpoints:** one tool-free model call before normal threshold or manual compaction.
- **Manual final review:** `/postmortem` combines the currently visible context with valid checkpoints from the current session branch.
- **Markdown reports:** saved in the task directory, with the final report's absolute path shown on completion.
- **Context separation:** checkpoint reflections are not automatically fed back into the running task. The final review remains in the conversation.
- **Failure handling:** checkpoint model errors and timeouts let Pi continue compaction; context-overflow recovery skips the checkpoint call.

See an [illustrative report excerpt](docs/example-report.md) and the [architecture and limits](docs/architecture.md).

## Quick start

Requires **Node.js 22.19+**, **Git**, and a configured **Pi 0.85.1** installation. The declared Pi compatibility range is `>=0.85.1 <0.86.0`. Configure a working model in Pi before requesting a reflection. Pi loads this extension's TypeScript directly; no build is required.

Install the plugin from GitHub:

```sh
pi install git:github.com/tgwrite/agent_postmortem_plugin
```

Start Pi in the directory of the task you want to review. Complete some work, then enter:

```text
/postmortem
```

Run installation commands in a shell; `/postmortem` and `/compact` are Pi session commands. The `/postmortem` command takes no arguments. If the agent is still running, the review waits for it to settle. Repeated pending requests are not queued twice.

To exercise the checkpoint flow, do some work, run `/compact`, continue the task, and run `/postmortem`. Compactions that happened before this plugin was loaded are not backfilled.

To load a local checkout instead:

```sh
git clone https://github.com/tgwrite/agent_postmortem_plugin.git
cd agent_postmortem_plugin
npm ci --ignore-scripts
```

Then, from your **task directory**, run `pi -e /absolute/path/to/agent_postmortem_plugin/src/index.ts`, replacing the path with your checkout. Quote paths containing spaces. On Windows, forward slashes work in the absolute path. Use `/reload` to reload local code; adopting changed budget defaults requires a restart and resume, as described below.

## Reports

```text
<task-directory>/
└── .agent-postmortem/
    ├── checkpoints/<checkpoint-id>.md
    └── reports/<timestamp>_<request-id>.md
```

Paths use Pi's current extension working directory. Each final review creates one report; existing reports are not overwritten, and there is no `latest.md` alias. Add `.agent-postmortem/` to your task repository's `.gitignore` if its reports should remain local.

### Interpret results

Match artifacts by `session_id` and `checkpoint_id` or `request_id`, rather than assuming the newest file belongs to the current task. The checkpoint file's `binding_status_at_write` is a pre-compaction snapshot; the session's `agent-postmortem-checkpoint` custom entry contains the authoritative final binding state.

| Result | Interpretation for an agent consuming it |
| --- | --- |
| Checkpoint: `status: BOUND`, `reflection_status: completed`, `artifact_status: saved` | Compaction succeeded and a completed checkpoint was saved. `BOUND` alone is not reflection success. |
| Final review: `status: completed`, `artifact_status: saved` in the `agent-postmortem` record | The final reflection completed and its report was saved; inspect visibility metadata before treating its coverage as complete. |
| `TRUNCATED_RESPONSE` | Output reached its limit. The saved partial report is marked failed and excluded from automatic final aggregation. |
| `MODEL_TIMEOUT` | The checkpoint request exceeded its deadline. Pi can still proceed with compaction. |
| `CHECKPOINT_SKIPPED_OVERFLOW`, `CHECKPOINT_DISABLED`, or `CONTEXT_BUDGET_EXHAUSTED` | The checkpoint model call was skipped. Absence of a report does not mean the event hook was never invoked. |
| `truncated_checkpoint_ids`, `budget_omitted_checkpoint_ids`, `unavailable_checkpoint_ids` | Final-review coverage has excerpted, omitted, or unavailable checkpoint material. Preserve these limitations when summarizing the report. |

Checkpoint calls do not retry or backfill old segments automatically. Report bodies are model-generated observations; verify consequential claims against the task evidence.

## Configuration and cost

By default, each normal compaction adds one model call using the current model. The checkpoint request has a 180-second timeout and an output limit of 8,192 tokens. Provider charges depend on the model and input size; the final review also uses the configured model.

| Flag | Default | Behavior |
| --- | --- | --- |
| `--postmortem-no-checkpoints` | `false` | Disable new automatic checkpoints; keep final reviews and aggregation of existing checkpoints. |
| `--postmortem-checkpoint-timeout-ms` | `180000` | Model request timeout, from 1 to 600000 ms. |
| `--postmortem-checkpoint-max-tokens` | `8192` | Output limit, from 1 to 32768 tokens, capped by the model's limit. |
| `--postmortem-checkpoint-max-input-tokens` | `64000` | Estimated complete checkpoint input ceiling, from 1 to 256000; also constrained by the model window and character caps. |
| `--postmortem-final-checkpoint-max-input-tokens` | `32000` | Estimated ceiling for saved checkpoints added to the final review, from 1 to 128000. |

Token budgets use an estimate of UTF-8 bytes divided by two, not a model-specific tokenizer. The checkpoint input includes its system prompt and encoded user payload; it reserves the requested output plus 10% of the model window (at least 2,048 tokens). The existing 120,000-character execution cap and 12,000-character previous-summary cap still apply, so increasing the estimated token ceiling alone does not expand those caps. The report is asked to target at most 3,500 tokens, or half its effective output budget if lower, leaving headroom for reasoning. The session's thinking level is preserved.

Final review output remains controlled by Pi. Its added checkpoint context is constrained by the estimated space left after current messages, system prompt, the model's maximum output, and the same safety margin. When necessary, it uses marked beginning/end excerpts across stages, then omits older stages if even short excerpts cannot fit. The original files are preserved; report metadata records excerpted and omitted checkpoint IDs. These estimates cannot guarantee that every provider will accept the request.

After installation, for example:

```sh
pi --postmortem-checkpoint-timeout-ms 180000 --postmortem-checkpoint-max-tokens 8192
```

**Upgrading an existing session:** Pi 0.85.1 preserves extension flag values across `/reload`, including old defaults. Restart Pi and resume the same session to adopt changed budget defaults. Remove old budget overrides from the launch command, or explicitly pass `--postmortem-checkpoint-max-tokens 8192 --postmortem-checkpoint-timeout-ms 180000`. Other extension loading options can be kept. A reload alone does not replace a retained 2048/45000 value.

Invalid numeric values fall back to defaults. The timeout covers the checkpoint model request, not the entire compaction. Checkpoint calls are not retried.

## Data and limitations

- **Model input:** the checkpoint sends the segment Pi is about to compact, including serialized tool results, plus bounded previous-summary context to the currently configured model provider. Final reviews use visible context and eligible saved checkpoints.
- **Local storage:** checkpoint and final report files may contain task details. The final prompt and assistant reply also remain in Pi's session history. Redact reports and logs before sharing them.
- **Provider retention:** the checkpoint requests `cacheRetention: "none"`; this is not a guarantee about the provider's logging or retention policy.
- **Visibility:** the model does not gain access to the full session file. Truncated input, missing files, failed checkpoints, and context lost before loading the plugin can limit the review.
- **Long sessions:** checkpoint aggregation has an estimated input ceiling and explicit excerpt/omission markers. The current task context and provider-specific token accounting can still cause an overflow.
- **Interpretation:** reports are model-generated reflections, not independently verified audits. Review important conclusions against the actual task evidence.

## Development and support

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests use real Pi session machinery with a deterministic local provider, temporary directories, and no real model API calls. CI runs type checking and tests on Linux and Windows.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, [CHANGELOG.md](CHANGELOG.md) for changes, and [GitHub Issues](https://github.com/tgwrite/agent_postmortem_plugin/issues) for bugs and feature requests. For vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE), copyright © 2026 tgwrite.
