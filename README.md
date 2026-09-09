# Agent Postmortem

[中文](README.zh-CN.md) · [MIT license](LICENSE) · [Contributing](CONTRIBUTING.md)

[![CI](https://github.com/tgwrite/agent_postmortem_plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/tgwrite/agent_postmortem_plugin/actions/workflows/ci.yml)

Task reflection for [Pi](https://pi.dev): save execution checkpoints before context compaction, then run `/postmortem` to review what worked, what failed, and what to change next time.

Long sessions can lose execution details during compaction. This plugin saves a separate reflection of each eligible segment for the final review. It can review successful, failed, blocked, or partially completed tasks.

**Status:** early release, v0.2.2. Automated tests verify behavior with a deterministic local model provider; they do not establish the quality of real-model reflections.

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

The command takes no arguments. If the agent is still running, the review waits for it to settle. Repeated pending requests are not queued twice.

To exercise the checkpoint flow, do some work, run `/compact`, continue the task, and run `/postmortem`. Compactions that happened before this plugin was loaded are not backfilled.

To load a local checkout instead:

```sh
git clone https://github.com/tgwrite/agent_postmortem_plugin.git
cd agent_postmortem_plugin
npm ci --ignore-scripts
```

Then, from your **task directory**, run `pi -e /absolute/path/to/agent_postmortem_plugin/src/index.ts`, replacing the path with your checkout. Quote paths containing spaces. On Windows, forward slashes work in the absolute path. Existing sessions can use `/reload` after changing local extension code.

## Reports

```text
<task-directory>/
└── .agent-postmortem/
    ├── checkpoints/<checkpoint-id>.md
    └── reports/<timestamp>_<request-id>.md
```

Paths use Pi's current extension working directory. Each final review creates one report; existing reports are not overwritten, and there is no `latest.md` alias. Add `.agent-postmortem/` to your task repository's `.gitignore` if its reports should remain local.

## Configuration and cost

By default, each normal compaction adds one model call using the current model. The checkpoint request has a 45-second timeout and an output limit of 2,048 tokens. Provider charges depend on the model and input size; the final review also uses the configured model.

| Flag | Default | Behavior |
| --- | --- | --- |
| `--postmortem-no-checkpoints` | `false` | Disable new automatic checkpoints; keep final reviews and aggregation of existing checkpoints. |
| `--postmortem-checkpoint-timeout-ms` | `45000` | Model request timeout, from 1 to 60000 ms. |
| `--postmortem-checkpoint-max-tokens` | `2048` | Output limit, from 1 to 8192 tokens, capped by the model's limit. |

After installation, for example:

```sh
pi --postmortem-checkpoint-timeout-ms 30000 --postmortem-checkpoint-max-tokens 4096
```

Invalid numeric values fall back to defaults. The timeout covers the checkpoint model request, not the entire compaction. Checkpoint calls are not retried.

## Data and limitations

- **Model input:** the checkpoint sends the segment Pi is about to compact, including serialized tool results, plus bounded previous-summary context to the currently configured model provider. Final reviews use visible context and eligible saved checkpoints.
- **Local storage:** checkpoint and final report files may contain task details. The final prompt and assistant reply also remain in Pi's session history. Redact reports and logs before sharing them.
- **Provider retention:** the checkpoint requests `cacheRetention: "none"`; this is not a guarantee about the provider's logging or retention policy.
- **Visibility:** the model does not gain access to the full session file. Truncated input, missing files, failed checkpoints, and context lost before loading the plugin can limit the review.
- **Long sessions:** valid checkpoints are aggregated without a second summarization pass; their accumulated input can exceed a model's context window.
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
