# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/wangzhongyang/dsh-endpoint/security/advisories/new)
on this repository. Include the version, your platform, and reproduction steps;
you will get an acknowledgement within a few days.

## Threat model

`dsh-endpoint` is a **local development tool**. Its security posture is deliberate
and documented rather than accidental:

- **No authentication, no rate limiting.** Anyone who can reach the listening port
  can spend the model quota configured in your harness. This is why the default
  bind address is `127.0.0.1` and why the plugin logs a warning when you switch to
  `0.0.0.0`.
- **No provider credentials.** The plugin never reads or stores API keys. Every
  call goes through `ctx.llm`, so credentials stay in DSH's credential store and
  are resolved per request by the provider adapter.
- **Loopback-only management routes.** The settings page talks to
  `/dsh-endpoint/state` and `/dsh-endpoint/config` on the GUI server, and both
  routes reject non-loopback peers.
- **Remote media URLs are refused.** Only inline `data:` URLs are accepted, so the
  endpoint cannot be used to make the host fetch arbitrary internal addresses
  (SSRF).

If you need to expose the endpoint beyond your machine, put it behind a reverse
proxy that terminates TLS and enforces authentication, and keep the plugin's own
listener bound to `127.0.0.1`.

## Supported versions

Only the latest released version receives fixes.
