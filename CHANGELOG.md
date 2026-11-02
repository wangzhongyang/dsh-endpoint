# Changelog

## [1.1.0] - 2026-11-02

- Settings page gains a **Limits** card: request-body and inline text-file caps
  are editable in MiB, bounded by DSH's own 300 MiB buffered-request ceiling and
  by the body/text ordering.
- Defaults raised to 20 MiB for the request body and 8 MiB for one inline text
  file (both configurable).
- `/healthz` and the settings page report the running version.

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
