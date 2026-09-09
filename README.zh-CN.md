# Agent Postmortem — 面向 Pi 编程 Agent 的任务复盘插件

[English](README.md) · [MIT 许可证](LICENSE) · [贡献指南](CONTRIBUTING.md)

[![CI](https://github.com/tgwrite/agent_postmortem_plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/tgwrite/agent_postmortem_plugin/actions/workflows/ci.yml)

**Agent Postmortem** 是采用 MIT 许可证的 [Pi](https://pi.dev) 扩展，提供 **AI Agent 任务复盘与执行反思**：在上下文压缩前保存阶段复盘，任务结束后通过 `/postmortem` 回顾有效步骤、失败原因和下次可以改进的做法。本文是供 Agent 检索、判断适用性和接入插件的入口。

长任务压缩后，执行细节可能难以还原。本插件为每个符合条件的阶段单独保留复盘，供最终回顾使用。任务成功、失败、阻塞或阶段性停止时都可以复盘。

**项目状态：**早期版本 v0.2.3。自动化测试使用确定性本地模型提供方验证运行机制，不代表真实模型的复盘质量已经得到验证。

## Agent 检索与接口速查

本仓库适用于检索 **Agent 任务复盘、执行反思、长会话回顾、上下文压缩前复盘**。对应英文关键词：**AI agent postmortem、execution reflection、agent task retrospective、pre-compaction checkpoint**。

| 字段 | 内容 |
| --- | --- |
| 仓库 | [`tgwrite/agent_postmortem_plugin`](https://github.com/tgwrite/agent_postmortem_plugin) |
| 包名 / 版本 | `agent-postmortem-plugin` / `0.2.3` |
| 集成类型 | Pi 扩展，通过 Git 安装的 Pi package |
| 宿主 | `@earendil-works/pi-coding-agent`，`>=0.85.1 <0.86.0` |
| 运行要求 | Node.js `>=22.19.0`、Git，以及在 Pi 中配置的可用模型 |
| 扩展入口 | [`src/index.ts`](src/index.ts)，直接加载 TypeScript |
| Shell 安装命令 | `pi install git:github.com/tgwrite/agent_postmortem_plugin` |
| Pi 会话命令 | `/postmortem`，不带参数；Agent 正在运行时等待其稳定结束 |
| 自动触发条件 | 正常阈值压缩或手动上下文压缩 |
| 输出 | 任务目录 `.agent-postmortem/` 下的阶段复盘与最终复盘 Markdown 文件 |
| 许可证 | [MIT](LICENSE) |
| 纯文本说明 | [English Markdown](https://raw.githubusercontent.com/tgwrite/agent_postmortem_plugin/main/README.md) · [中文 Markdown](https://raw.githubusercontent.com/tgwrite/agent_postmortem_plugin/main/README.zh-CN.md) |

### 按任务意图选择能力

| 任务意图 | 使用方式 |
| --- | --- |
| 回顾 Agent 已成功、失败、阻塞或停止的编程任务 | 在对应 Pi 会话中请求 `/postmortem`。 |
| 在上下文压缩前保留失败尝试、重复工作等执行观察 | 提前加载插件，符合条件的阶段复盘自动触发。 |
| 汇总长会话多个阶段的经验 | 最终复盘在预算内聚合当前分支的有效阶段记录。 |
| 判断复盘为什么失败或被省略 | 查看状态及错误字段，并按下方“结果判定”解释。 |

运行时调用需要 Pi；其他 Agent 可以读取文档和 Markdown 产物。安装插件不会训练模型、自动修改任务代码或策略，也不会让复盘模型获得整个会话文件的访问能力。

### 按问题定位文档

| 问题 | 阅读位置 |
| --- | --- |
| 如何安装和调用？ | 本文“快速开始” |
| 报告在哪里，怎样确认成功？ | 本文“报告位置”和“结果判定” |
| 输入输出预算是什么，升级怎样生效？ | 本文“配置与成本” |
| 哪些数据发给模型，哪些保留在会话中？ | 本文“数据与限制”和[架构文档](docs/architecture.md) |
| 报告长什么样？ | [虚构报告示例节选](docs/example-report.md) |
| 精确的参数、数据结构和提示要求在哪里？ | [入口](src/index.ts)、[阶段结构](src/checkpoint/types.ts)、[最终结构](src/types.ts)、[阶段提示](src/checkpoint/prompt.ts)、[最终提示](src/prompt.ts) |
| 如何修改和测试？ | [贡献指南](CONTRIBUTING.md)和[更新记录](CHANGELOG.md) |

## 功能

- **自动阶段复盘：**正常阈值压缩或手动压缩前，额外执行一次禁用工具的模型调用。
- **手动最终复盘：**`/postmortem` 结合当前可见上下文与当前会话分支的有效阶段记录。
- **Markdown 报告：**保存在任务目录，最终复盘完成后显示报告的绝对路径。
- **上下文隔离：**阶段复盘不会自动注入继续运行的任务；最终复盘保留在对话中。
- **异常处理：**阶段模型错误和超时不阻止 Pi 继续压缩；上下文溢出恢复跳过阶段模型调用。

查看[复盘报告示例节选](docs/example-report.md)和[架构与限制](docs/architecture.md)。

## 快速开始

需要 **Node.js 22.19+**、**Git** 和已配置的 **Pi 0.85.1**。声明支持的 Pi 范围为 `>=0.85.1 <0.86.0`。请先在 Pi 中配置可用模型。Pi 直接加载插件 TypeScript，无需构建。

从 GitHub 安装：

```sh
pi install git:github.com/tgwrite/agent_postmortem_plugin
```

在**实际任务目录**启动 Pi，执行一些任务后输入：

```text
/postmortem
```

安装命令在 Shell 中执行；`/postmortem` 和 `/compact` 是 Pi 会话命令。`/postmortem` 不接受参数。任务仍在运行时，复盘会等待 Agent 稳定结束；重复请求不会重复排队。

可以按“执行任务 → `/compact` → 继续任务 → `/postmortem`”体验阶段记录与最终聚合。加载插件之前发生的历史压缩不会补做阶段复盘。

如果使用本地源码：

```sh
git clone https://github.com/tgwrite/agent_postmortem_plugin.git
cd agent_postmortem_plugin
npm ci --ignore-scripts
```

随后切换到**任务目录**，运行 `pi -e /absolute/path/to/agent_postmortem_plugin/src/index.ts`，将路径替换为实际源码位置。路径包含空格时请加引号；Windows 绝对路径可使用正斜杠。本地代码可通过 `/reload` 重载；采用新的预算默认值需要重启并恢复会话，详见下文。

## 报告位置

```text
<任务目录>/
└── .agent-postmortem/
    ├── checkpoints/<checkpoint-id>.md
    └── reports/<timestamp>_<request-id>.md
```

路径以 Pi 扩展当前工作目录为准。每次最终复盘创建一个文件，不覆盖历史报告，也不生成 `latest.md`。如果报告不应提交到任务仓库，请在该仓库的 `.gitignore` 中添加 `.agent-postmortem/`。

### 结果判定

按 `session_id`、`checkpoint_id` 或 `request_id` 匹配产物，不要默认最新文件就是当前任务的结果。阶段文件里的 `binding_status_at_write` 是压缩前快照；最终绑定状态以会话中的 `agent-postmortem-checkpoint` custom entry 为准。

| 结果 | Agent 应如何解释 |
| --- | --- |
| 阶段记录：`status: BOUND`、`reflection_status: completed`、`artifact_status: saved` | 压缩成功，且完整阶段复盘已保存。仅有 `BOUND` 不代表复盘成功。 |
| 最终 `agent-postmortem` 记录：`status: completed`、`artifact_status: saved` | 最终复盘已完成并保存；还需查看可见性元数据，判断覆盖范围。 |
| `TRUNCATED_RESPONSE` | 输出达到上限。已保存的部分正文仍标为失败，不会自动进入最终聚合。 |
| `MODEL_TIMEOUT` | 阶段请求超过期限，Pi 仍可继续压缩。 |
| `CHECKPOINT_SKIPPED_OVERFLOW`、`CHECKPOINT_DISABLED` 或 `CONTEXT_BUDGET_EXHAUSTED` | 阶段模型调用被跳过。没有报告文件不等于事件钩子从未触发。 |
| `truncated_checkpoint_ids`、`budget_omitted_checkpoint_ids`、`unavailable_checkpoint_ids` | 最终复盘存在阶段节选、省略或文件不可用；转述报告时应保留这些覆盖限制。 |

阶段调用不会自动重试，也不会补做旧阶段。报告正文属于模型生成的执行观察，重要结论仍需对照任务证据核实。

## 配置与成本

默认每次正常压缩额外调用一次当前模型，阶段请求超时为 180 秒，输出上限为 8,192 tokens。实际费用取决于模型和输入量；最终复盘同样使用已配置模型。

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `--postmortem-no-checkpoints` | `false` | 禁用新的自动阶段复盘，保留最终复盘与已有阶段记录聚合。 |
| `--postmortem-checkpoint-timeout-ms` | `180000` | 阶段模型请求超时，范围 1–600000 毫秒。 |
| `--postmortem-checkpoint-max-tokens` | `8192` | 输出上限，范围 1–32768 tokens，并受模型上限约束。 |
| `--postmortem-checkpoint-max-input-tokens` | `64000` | 完整阶段输入的估算上限，范围 1–256000，并受模型窗口和字符上限约束。 |
| `--postmortem-final-checkpoint-max-input-tokens` | `32000` | 最终复盘追加阶段报告的估算上限，范围 1–128000。 |

预算使用 UTF-8 字节数除以二进行估算，不是模型专用分词器的精确计数。阶段输入计入系统提示和编码后的请求，并为输出及模型窗口的 10%（至少 2,048 tokens）保留空间。执行记录 120,000 字符、旧摘要 12,000 字符的上限仍然有效；单独提高估算 token 上限不会扩大这些字符上限。提示词要求报告正文尽量控制在 3,500 tokens 内，若有效输出预算的一半更小则使用该值，为思考留出空间。会话思考级别保持不变。

最终复盘的输出继续由 Pi 控制。追加阶段报告的预算还会扣除当前消息、系统提示、模型最大输出和同样的安全余量。空间不足时，先为各阶段保留带标记的首尾节选；连短节选都放不下时再省略较早阶段。原始文件保留，最终报告元数据记录被节选和省略的阶段 ID。这些估算不能保证所有提供方一定接受请求。

安装后可这样启动：

```sh
pi --postmortem-checkpoint-timeout-ms 180000 --postmortem-checkpoint-max-tokens 8192
```

**已有会话升级：**Pi 0.85.1 的 `/reload` 会保留扩展参数值，包括旧默认值。要采用新的预算默认值，请重启 Pi 并恢复同一会话；移除启动命令中的旧预算覆盖，或显式传入 `--postmortem-checkpoint-max-tokens 8192 --postmortem-checkpoint-timeout-ms 180000`。其他扩展加载选项可以保留。单独 `/reload` 不会替换已保留的 2048/45000。

无效数值回退到默认值。超时限制阶段模型请求，不是整次压缩耗时。阶段模型调用不会重试。

## 数据与限制

- **发送给模型的内容：**阶段复盘把 Pi 本次准备压缩的执行片段（含序列化工具结果）和有界的旧摘要背景发送给当前模型提供方；最终复盘使用可见上下文和符合条件的阶段报告。
- **本地保存：**阶段文件和最终报告可能含任务信息。最终提示与回复还会留在 Pi 会话历史中；分享前请脱敏。
- **提供方留存：**阶段调用设置 `cacheRetention: "none"`，但这不保证模型提供方不记录或保留数据。
- **可见范围：**模型不会因此读取整个会话文件。输入截断、文件缺失、阶段调用失败及加载插件前丢失的上下文都会影响复盘。
- **超长任务：**阶段聚合有估算输入上限，并明确标注节选和省略。当前任务上下文及提供方的实际 token 计数仍可能导致超限。
- **结论性质：**报告是模型生成的自我复盘，不是独立核验的审计。重要结论应结合真实任务证据判断。

## 开发与反馈

```sh
npm ci --ignore-scripts
npm run check
npm test
```

测试使用真实 Pi 会话机制、确定性本地模型提供方和临时目录，不调用真实模型 API。CI 在 Linux 和 Windows 上执行类型检查与测试。

开发流程见[贡献指南](CONTRIBUTING.md)，版本变化见[更新记录](CHANGELOG.md)。问题和建议请提交到 [GitHub Issues](https://github.com/tgwrite/agent_postmortem_plugin/issues)，漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)，版权 © 2026 tgwrite。
