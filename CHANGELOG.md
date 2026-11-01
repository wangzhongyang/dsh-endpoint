# Changelog

## [1.0.1] - 2026-11-02

- `/healthz` and the settings page report the running version.
- `limits.maxTextFileBytes` (default 1 MiB) controls how much of one inline text
  file is inlined; the request body cap remains the hard ceiling.

## [1.0.0] - 2026-11-02

First public release.

- OpenAI-compatible `POST /v1/chat/completions` (streaming and non-streaming) and
  `GET /v1/models`, every call forwarded through `ctx.llm.stream()`.
- Tool calls pass through both ways; inline images and text files are supported.
- Stable conversation identity and read-only session mirroring into DSH.
- Settings page (Chinese/English) with in-place listener rebind.
