# Contributing

Bug reports, documentation improvements, and focused pull requests are welcome. Issues and pull requests may be written in English or Chinese.

## Local development

Use Node.js 22.19 or newer and Git:

```sh
git clone https://github.com/tgwrite/agent_postmortem_plugin.git
cd agent_postmortem_plugin
npm ci --ignore-scripts
npm run check
npm test
```

Pi 0.85.1 is pinned in the development dependencies. The extension loads TypeScript directly, so there is no build step. Test a local change by launching Pi from a separate task directory with `pi -e /absolute/path/to/agent_postmortem_plugin/src/index.ts`.

The automated tests use Pi's session machinery and a deterministic local model provider. They do not require model credentials or additional repositories. Test workspaces are created under the operating system's temporary directory and cleaned up by the harness.

## Before submitting

- Describe the observed behavior, the intended change, and how you verified it.
- Add a regression test when changing behavior or fixing a bug. Documentation-only changes do not need new tests.
- Run `npm run check` and `npm test` for code changes.
- Keep `README.md` and `README.zh-CN.md` aligned when changing user-facing behavior. Record relevant changes under `Unreleased` in `CHANGELOG.md`.
- Keep examples portable and synthetic. Do not commit credentials, real session files, generated task reports, private project details, or workstation paths. Review the diff before submitting.

Useful behavior to preserve includes tool restoration after final reviews, accurate checkpoint binding, branch isolation, continued compaction after checkpoint failure, and explicit visibility gaps when saved artifacts are unavailable.

For substantial feature changes, open an issue first to discuss scope. Keep each pull request focused. A successful deterministic test does not establish that a model-generated reflection is useful; label live-model evaluations separately and use shareable task data.

## Reporting problems

Include the plugin, Pi, Node.js, operating system, and model/provider versions where relevant. Provide minimal steps, expected behavior, actual behavior, and sanitized logs. Do not attach full task sessions by default. For vulnerabilities, follow [SECURITY.md](SECURITY.md).

## License

By submitting a contribution, you agree to license it under this project's [MIT license](LICENSE). Preserve applicable third-party copyright and license notices.
