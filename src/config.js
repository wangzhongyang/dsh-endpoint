import z from '@deepseek-ai/schemastery'

/**
 * Plugin configuration. The Settings -> Plugins form is generated from this
 * schema, so every field here is also the management surface.
 */
export const Config = z.object({
  host: z
    .string()
    .default('127.0.0.1')
    .description('Bind address. 127.0.0.1 keeps the endpoint on this machine; 0.0.0.0 exposes every interface.'),
  port: z
    .natural()
    .max(65535)
    .default(43130)
    .description('Listening port. The GUI owns 43129, so the endpoint defaults to the next one.'),
  defaultModel: z
    .string()
    .default('')
    .description('Model used when a request omits `model`, as `provider/model`.'),
  modelAliases: z
    .dict(z.string())
    .default({})
    .description('Extra request names mapped to `provider/model`, e.g. `gpt-4o: opencode-go/deepseek-v4.1-flash`.'),
  session: z
    .object({
      header: z
        .string()
        .default('x-dsh-session-id')
        .description('Request/response header carrying the DSH session id.'),
      mirror: z
        .boolean()
        .default(true)
        .description('Mirror each conversation into a real DSH session so it appears in the sidebar.'),
      deriveFrom: z
        .array(z.string())
        .default(['model', 'first-user'])
        .description('Fingerprint inputs used when a request carries no session id: model, system, first-user.'),
      mappingTtlDays: z
        .natural()
        .default(3)
        .description('Days an external conversation id keeps its DSH session after its last use.'),
      archiveOnExpire: z
        .boolean()
        .default(true)
        .description('Archive the mirrored session when its mapping expires.'),
      workspacePath: z
        .string()
        .default('')
        .description('Directory whose workspace groups mirrored sessions. Empty means $DSH_HOME/dsh-endpoint/conversations.'),
      maxOpenSessions: z
        .natural()
        .default(64)
        .description('Upper bound on sessions whose write handle stays open (each one also blocks GUI takeover).'),
    })
    .default({}),
  limits: z
    .object({
      maxBodyBytes: z
        .natural()
        .default(8 * 1024 * 1024)
        .description('Reject request bodies larger than this.'),
      maxTextFileBytes: z
        .natural()
        .default(1024 * 1024)
        .description(
          'How much of one inline text file is inlined into the prompt. The request body cap is the hard ceiling; truncation is marked in the text.',
        ),
      maxOutputTokens: z
        .natural()
        .default(32768)
        .description('Upper bound applied to max_tokens when a request does not set one.'),
      firstTokenTimeoutMs: z
        .natural()
        .default(120000)
        .description('Abort a model call that produces no first token within this window.'),
      idleTimeoutMs: z
        .natural()
        .default(120000)
        .description('Abort a model call whose stream stalls for this long.'),
    })
    .default({}),
  log: z
    .object({
      accessFile: z
        .string()
        .default('')
        .description('JSONL access log path. Empty disables it.'),
      includePayload: z
        .boolean()
        .default(false)
        .description('Record request/response bodies in the access log (may contain user text).'),
    })
    .default({}),
})
