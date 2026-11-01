# Changelog

## [1.0.0] - 2026-11-02

First public release.

- OpenAI-compatible `POST /v1/chat/completions` (streaming and non-streaming) and
  `GET /v1/models`, every call forwarded through `ctx.llm.stream()`.
- Tool calls pass through both ways; inline images and text files are supported.
- Stable conversation identity and read-only session mirroring into DSH.
- Settings page (Chinese/English) with in-place listener rebind.
