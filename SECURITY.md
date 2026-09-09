# Security

## Supported versions

Security fixes target the latest project version on `main`. Older releases do not have a separate maintenance branch.

## Report a vulnerability

Use GitHub's [private vulnerability report form](https://github.com/tgwrite/agent_postmortem_plugin/security/advisories/new). Include the affected version, impact, and a minimal reproduction using synthetic data. English and Chinese are welcome.

Do not post exploit details, credentials, or real task sessions in a public issue. There is no guaranteed response time. For ordinary bugs and feature requests, use [Issues](https://github.com/tgwrite/agent_postmortem_plugin/issues).

## Task data

The plugin sends reflection input to the model provider configured in Pi and stores Markdown artifacts in the task directory. Final reviews also remain in Pi's session history. These records can contain task details. Review and redact them before sharing, and keep `.agent-postmortem/` ignored in task repositories where reports should remain local.

The checkpoint request's `cacheRetention: "none"` option does not override a provider's logging or retention policy. The model should treat recorded task content as data, but model-generated conclusions still require human review.
