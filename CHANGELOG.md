# Changelog

User-facing changes are recorded here. Version numbers before 1.0 indicate an evolving API and compatibility surface.

## Unreleased

## 0.2.3 — 2026-09-09

- Raise default checkpoint output to 8,192 tokens and the request timeout to 180 seconds; preserve the selected thinking level and provide an explicit report-length target.
- Add a 64,000-token estimated checkpoint input ceiling with model-window reservations, while retaining existing character caps.
- Bound final checkpoint context to 32,000 estimated tokens and available model space, with explicit excerpts, omissions, and persisted budget metadata.
- Add configurable input ceilings; extend output and timeout flag ranges to 32,768 tokens and 600 seconds.

- Add the MIT license, English and Chinese quick-start guides, a synthetic report example, architecture documentation, and contribution guidance.
- Add Linux and Windows CI, issue forms, and a pull request template.
- Complete repository metadata for GitHub distribution. npm publishing remains disabled.

## 0.2.2 — 2026-09-08

### Fixed

- Forward the current session thinking level as `reasoningEffort` for supported OpenAI-compatible Completions and Responses reasoning APIs.
- Record both the session thinking level and the effort sent to the checkpoint request, without lowering the selected level.

## 0.2.1 — 2026-09-08

### Added

- Automatic tool-free reflection before normal context compaction, with configurable time and output limits.
- Checkpoint binding to successful compactions, branch-aware aggregation, and artifact integrity checks.
- Explicit failure and visibility diagnostics; checkpoint failures let compaction continue and overflow recovery skips reflection.

## 0.1.0 — 2026-09-08

### Added

- Manual `/postmortem` reviews in the current session, with tool disabling and restoration.
- Markdown report persistence, request lifecycle handling, and completion notifications.

### Fixed

- Save individual historical reports and display their absolute paths without a `latest.md` alias.
