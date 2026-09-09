# Agent Postmortem

[English](README.md) · [MIT 许可证](LICENSE) · [贡献指南](CONTRIBUTING.md)

[![CI](https://github.com/tgwrite/agent_postmortem_plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/tgwrite/agent_postmortem_plugin/actions/workflows/ci.yml)

为 [Pi](https://pi.dev) 编程助手提供任务复盘：在上下文压缩前保存阶段复盘，任务结束后通过 `/postmortem` 回顾有效步骤、失败原因和下次可以改进的做法。

长任务压缩后，执行细节可能难以还原。本插件为每个符合条件的阶段单独保留复盘，供最终回顾使用。任务成功、失败、阻塞或阶段性停止时都可以复盘。

**项目状态：**早期版本 v0.2.2。自动化测试使用确定性本地模型提供方验证运行机制，不代表真实模型的复盘质量已经得到验证。

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

命令不接受参数。任务仍在运行时，复盘会等待 Agent 稳定结束；重复请求不会重复排队。

可以按“执行任务 → `/compact` → 继续任务 → `/postmortem`”体验阶段记录与最终聚合。加载插件之前发生的历史压缩不会补做阶段复盘。

如果使用本地源码：

```sh
git clone https://github.com/tgwrite/agent_postmortem_plugin.git
cd agent_postmortem_plugin
npm ci --ignore-scripts
```

随后切换到**任务目录**，运行 `pi -e /absolute/path/to/agent_postmortem_plugin/src/index.ts`，将路径替换为实际源码位置。路径包含空格时请加引号；Windows 绝对路径可使用正斜杠。已有会话在更新本地插件代码后可执行 `/reload`。

## 报告位置

```text
<任务目录>/
└── .agent-postmortem/
    ├── checkpoints/<checkpoint-id>.md
    └── reports/<timestamp>_<request-id>.md
```

路径以 Pi 扩展当前工作目录为准。每次最终复盘创建一个文件，不覆盖历史报告，也不生成 `latest.md`。如果报告不应提交到任务仓库，请在该仓库的 `.gitignore` 中添加 `.agent-postmortem/`。

## 配置与成本

默认每次正常压缩额外调用一次当前模型，阶段请求超时为 45 秒，输出上限为 2,048 tokens。实际费用取决于模型和输入量；最终复盘同样使用已配置模型。

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `--postmortem-no-checkpoints` | `false` | 禁用新的自动阶段复盘，保留最终复盘与已有阶段记录聚合。 |
| `--postmortem-checkpoint-timeout-ms` | `45000` | 阶段模型请求超时，范围 1–60000 毫秒。 |
| `--postmortem-checkpoint-max-tokens` | `2048` | 输出上限，范围 1–8192 tokens，并受模型上限约束。 |

安装后可这样启动：

```sh
pi --postmortem-checkpoint-timeout-ms 30000 --postmortem-checkpoint-max-tokens 4096
```

无效数值回退到默认值。超时限制阶段模型请求，不是整次压缩耗时。阶段模型调用不会重试。

## 数据与限制

- **发送给模型的内容：**阶段复盘把 Pi 本次准备压缩的执行片段（含序列化工具结果）和有界的旧摘要背景发送给当前模型提供方；最终复盘使用可见上下文和符合条件的阶段报告。
- **本地保存：**阶段文件和最终报告可能含任务信息。最终提示与回复还会留在 Pi 会话历史中；分享前请脱敏。
- **提供方留存：**阶段调用设置 `cacheRetention: "none"`，但这不保证模型提供方不记录或保留数据。
- **可见范围：**模型不会因此读取整个会话文件。输入截断、文件缺失、阶段调用失败及加载插件前丢失的上下文都会影响复盘。
- **超长任务：**符合条件的阶段报告直接聚合，没有二次摘要，累计输入可能超过模型窗口。
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
