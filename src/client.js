/**
 * Client half for dsh-endpoint.
 *
 * Loaded by DSH's module loader as a plain script (no top-level import/export):
 * the factory receives `require` and must return the module object. It declares
 * `inject: ['slots', 'locale']` — both are required before `apply` runs, and
 * accessing either without declaring it would fail the client boot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-endpoint',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement

    var NS = 'dsh-endpoint'

    var DICT = {
      zh: {
        nav: '模型端点',
        version: '版本',
        status: '状态',
        address: '运行地址',
        providers: 'Provider',
        providersEmpty: '未注册',
        sessions: '镜像会话',
        mappings: '{n} 条映射',
        endpoint: '端点',
        host: '监听地址',
        hostLocal: '127.0.0.1（仅本机）',
        hostAll: '0.0.0.0（所有网卡）',
        hostHintLocal: '仅本机可访问',
        hostHintAll: '⚠ 没有鉴权，同网段任何人都能调用',
        port: '端口',
        models: '模型',
        defaultModel: '默认模型',
        defaultModelHint: '请求不带 model 时使用，格式 provider/model',
        aliases: '模型别名',
        aliasesHint: 'JSON 对象，例如 {"gpt-4o": "opencode-go/deepseek-v4.1-flash"}',
        mirror: '会话镜像',
        mirrorOn: '把每段 API 对话写成一个 DSH 会话（侧栏可见、只读）',
        limits: '限制',
        bodyLimit: '请求体上限',
        bodyLimitHint: 'MiB。DSH 自身 /api 默认 300 MiB，超过会被拒绝',
        textLimit: '文本文件上限',
        textLimitHint: 'MiB，且不能超过请求体上限；DSH 本身不限制文件大小',
        mib: 'MiB',
        bodyLimitError: '请求体上限必须在 1 到 300 MiB 之间',
        textLimitError: '文本文件上限不能超过请求体上限',
        ttl: '映射保留',
        ttlHint: '外部会话 ID 超过这个天数没再用，就解绑并归档',
        ttlUnit: '天',
        workspace: '工作区目录',
        workspaceHint: '镜像会话归属的 workspace；留空用 $DSH_HOME/dsh-endpoint/conversations',
        save: '保存',
        saving: '保存中…',
        savedLive: '已保存，即时生效。',
        savedRebound: '已保存，监听地址已切换。',
        savedRestart: '已保存。镜像开关 / 工作区目录需要重载插件后生效。',
        client: '客户端接入',
        loading: '正在读取端点状态…',
        readStateFailed: '状态读取失败：',
        readConfigFailed: '配置读取失败：',
        saveFailed: '保存失败',
        aliasesInvalid: '模型别名不是合法 JSON：',
      },
      en: {
        nav: 'Model Endpoint',
        version: 'Version',
        status: 'Status',
        address: 'Address',
        providers: 'Providers',
        providersEmpty: 'none registered',
        sessions: 'Mirrored sessions',
        mappings: '{n} mappings',
        endpoint: 'Endpoint',
        host: 'Listen address',
        hostLocal: '127.0.0.1 (local only)',
        hostAll: '0.0.0.0 (all interfaces)',
        hostHintLocal: 'Reachable only from this machine',
        hostHintAll: '⚠ No authentication: anyone on this network can use it',
        port: 'Port',
        models: 'Models',
        defaultModel: 'Default model',
        defaultModelHint: 'Used when a request omits `model`, as provider/model',
        aliases: 'Model aliases',
        aliasesHint: 'JSON object, e.g. {"gpt-4o": "opencode-go/deepseek-v4.1-flash"}',
        mirror: 'Session mirror',
        mirrorOn: 'Write each API conversation into a DSH session (visible in the sidebar, read-only)',
        limits: 'Limits',
        bodyLimit: 'Request body limit',
        bodyLimitHint: "MiB. DSH's own /api default is 300 MiB; higher values are rejected",
        textLimit: 'Inline text file limit',
        textLimitHint: 'MiB, never above the body limit; DSH itself sets no file-size limit',
        mib: 'MiB',
        bodyLimitError: 'Request body limit must be between 1 and 300 MiB',
        textLimitError: 'Inline text file limit cannot exceed the body limit',
        ttl: 'Mapping retention',
        ttlHint: 'Days an external conversation id keeps its session after its last use',
        ttlUnit: 'days',
        workspace: 'Workspace directory',
        workspaceHint: 'Workspace that groups mirrored sessions; empty means $DSH_HOME/dsh-endpoint/conversations',
        save: 'Save',
        saving: 'Saving…',
        savedLive: 'Saved and applied.',
        savedRebound: 'Saved; the listener moved to the new address.',
        savedRestart: 'Saved. The mirror switch / workspace directory need a plugin reload.',
        client: 'Client setup',
        loading: 'Loading endpoint state…',
        readStateFailed: 'Could not read status: ',
        readConfigFailed: 'Could not read config: ',
        saveFailed: 'Save failed',
        aliasesInvalid: 'Model aliases are not valid JSON: ',
      },
    }

    var TOKEN = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
      border: 'var(--dsw-alias-border-l2, #3a3a3a)',
      bg: 'var(--dsw-alias-bg-layer-1, #1f1f1f)',
      accent: 'var(--dsw-alias-state-business-primary, #4f8cff)',
    }

    var S = {
      page: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16, color: TOKEN.text },
      card: {
        border: '1px solid ' + TOKEN.border,
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      title: { fontSize: 13, fontWeight: 600, color: TOKEN.dim, letterSpacing: '0.02em' },
      row: { display: 'flex', alignItems: 'flex-start', gap: 16, minHeight: 34 },
      label: { width: 120, flex: 'none', fontSize: 13, lineHeight: '30px' },
      control: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        height: 30,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid ' + TOKEN.border,
        background: TOKEN.bg,
        color: TOKEN.text,
        fontSize: 13,
        outline: 'none',
      },
      area: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 90,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid ' + TOKEN.border,
        background: TOKEN.bg,
        color: TOKEN.text,
        fontFamily: 'ui-monospace, Menlo, monospace',
        fontSize: 12,
        resize: 'vertical',
      },
      hint: { fontSize: 12, color: TOKEN.dim, lineHeight: '18px' },
      button: {
        alignSelf: 'flex-start',
        height: 30,
        padding: '0 16px',
        borderRadius: 8,
        border: 'none',
        background: TOKEN.accent,
        color: '#fff',
        fontSize: 13,
        cursor: 'pointer',
      },
      mono: {
        fontFamily: 'ui-monospace, Menlo, monospace',
        fontSize: 12,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid ' + TOKEN.border,
        background: TOKEN.bg,
        overflowX: 'auto',
        whiteSpace: 'pre',
      },
      pill: {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        border: '1px solid ' + TOKEN.border,
        fontSize: 12,
        marginRight: 6,
        color: TOKEN.text,
      },
      ok: { fontSize: 12, color: '#3fb950' },
      err: { fontSize: 12, color: '#f85149' },
    }

    function round1(value) {
      return Math.round(value * 10) / 10
    }

    function Field(props) {
      return h(
        'div',
        { style: S.row },
        h('div', { style: S.label }, props.label),
        h(
          'div',
          { style: S.control },
          props.children,
          props.hint === undefined ? null : h('div', { style: S.hint }, props.hint),
        ),
      )
    }

    function EndpointSection(props) {
      var t = props.t
      var locale = props.locale
      var store = React.useMemo(
        function () {
          return {
            subscribe: function (callback) {
              return locale.subscribe(callback)
            },
            get: function () {
              return locale.getSnapshot()
            },
          }
        },
        [locale],
      )
      // Re-render on locale switches; `t` itself reads the active locale at call time.
      React.useSyncExternalStore(store.subscribe, store.get)

      var statusHook = React.useState(null)
      var status = statusHook[0]
      var setStatus = statusHook[1]
      var formHook = React.useState(null)
      var form = formHook[0]
      var setForm = formHook[1]
      var msgHook = React.useState(null)
      var message = msgHook[0]
      var setMessage = msgHook[1]
      var busyHook = React.useState(false)
      var busy = busyHook[0]
      var setBusy = busyHook[1]

      React.useEffect(function () {
        var cancelled = false
        fetch('/dsh-endpoint/state')
          .then(function (response) {
            return response.json()
          })
          .then(function (value) {
            if (!cancelled) setStatus(value)
          })
          .catch(function (error) {
            if (!cancelled) setMessage({ kind: 'err', text: t('readStateFailed') + String(error) })
          })
        fetch('/dsh-endpoint/config')
          .then(function (response) {
            return response.json()
          })
          .then(function (config) {
            if (cancelled) return
            setForm({
              host: config.host,
              port: config.port,
              defaultModel: config.defaultModel || '',
              aliases: JSON.stringify(config.modelAliases || {}, null, 2),
              mirror: config.session ? config.session.mirror !== false : true,
              ttl: config.session ? config.session.mappingTtlDays : 3,
              workspacePath: config.session ? config.session.workspacePath || '' : '',
              bodyMiB: config.limits ? round1(config.limits.maxBodyBytes / 1048576) : 20,
              textMiB: config.limits ? round1(config.limits.maxTextFileBytes / 1048576) : 8,
            })
          })
          .catch(function (error) {
            if (!cancelled) setMessage({ kind: 'err', text: t('readConfigFailed') + String(error) })
          })
        return function () {
          cancelled = true
        }
      }, [])

      var update = function (patch) {
        setForm(function (current) {
          return Object.assign({}, current, patch)
        })
        setMessage(null)
      }

      var save = function () {
        var aliases
        try {
          aliases = JSON.parse(form.aliases || '{}')
        } catch (error) {
          setMessage({ kind: 'err', text: t('aliasesInvalid') + String(error.message || error) })
          return
        }
        var bodyBytes = Math.round(Number(form.bodyMiB) * 1048576)
        var textBytes = Math.round(Number(form.textMiB) * 1048576)
        if (!(bodyBytes >= 1048576) || bodyBytes > 300 * 1048576) {
          setMessage({ kind: 'err', text: t('bodyLimitError') })
          return
        }
        if (textBytes > bodyBytes) {
          setMessage({ kind: 'err', text: t('textLimitError') })
          return
        }
        setBusy(true)
        setMessage(null)
        fetch('/dsh-endpoint/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            host: form.host,
            port: Number(form.port),
            defaultModel: form.defaultModel,
            modelAliases: aliases,
            limits: { maxBodyBytes: bodyBytes, maxTextFileBytes: textBytes },
            session: {
              mirror: form.mirror,
              mappingTtlDays: Number(form.ttl),
              workspacePath: form.workspacePath,
            },
          }),
        })
          .then(function (response) {
            return response.json().then(function (body) {
              return { ok: response.ok, body: body }
            })
          })
          .then(function (result) {
            if (!result.ok) throw new Error(result.body.error || t('saveFailed'))
            var text = result.body.restartRequired
              ? t('savedRestart')
              : result.body.rebound
                ? t('savedRebound')
                : t('savedLive')
            setMessage({ kind: 'ok', text: text })
            if (result.body.config) {
              setStatus(function (current) {
                return Object.assign({}, current, {
                  host: result.body.config.host,
                  port: result.body.config.port,
                  url: 'http://' + result.body.config.host + ':' + result.body.config.port,
                })
              })
            }
          })
          .catch(function (error) {
            setMessage({ kind: 'err', text: String(error.message || error) })
          })
          .then(function () {
            setBusy(false)
          })
      }

      if (form === null) {
        return h('div', { style: S.page }, h('div', { style: S.hint }, message === null ? t('loading') : message.text))
      }

      var statusChildren =
        status === null
          ? [h('div', { key: 'loading', style: S.hint }, t('loading'))]
          : [
              h(Field, { key: 'url', label: t('address') }, h('div', { style: S.mono }, status.url)),
              h(Field, { key: 'version', label: t('version') }, h('div', { style: S.hint }, status.version || '—')),
              h(
                Field,
                { key: 'providers', label: t('providers') },
                h(
                  'div',
                  null,
                  (status.providers || []).map(function (name) {
                    return h('span', { key: name, style: S.pill }, name)
                  }),
                  (status.providers || []).length === 0 ? h('span', { style: S.hint }, t('providersEmpty')) : null,
                ),
              ),
              h(
                Field,
                { key: 'sessions', label: t('sessions'), hint: status.stateRoot },
                h('div', { style: S.hint }, t('mappings').replace('{n}', String(status.sessions || 0))),
              ),
            ]

      return h(
        'div',
        { style: S.page },
        h('div', { style: S.card }, [h('div', { key: 't', style: S.title }, t('status'))].concat(statusChildren)),
        h(
          'div',
          { style: S.card },
          h('div', { style: S.title }, t('endpoint')),
          h(
            Field,
            {
              label: t('host'),
              hint: form.host === '0.0.0.0' ? t('hostHintAll') : t('hostHintLocal'),
            },
            h(
              'select',
              {
                style: S.input,
                value: form.host,
                onChange: function (event) {
                  update({ host: event.target.value })
                },
              },
              h('option', { value: '127.0.0.1' }, t('hostLocal')),
              h('option', { value: '0.0.0.0' }, t('hostAll')),
            ),
          ),
          h(
            Field,
            { label: t('port') },
            h('input', {
              style: S.input,
              type: 'number',
              value: form.port,
              onChange: function (event) {
                update({ port: event.target.value })
              },
            }),
          ),
        ),
        h(
          'div',
          { style: S.card },
          h('div', { style: S.title }, t('models')),
          h(
            Field,
            { label: t('defaultModel'), hint: t('defaultModelHint') },
            h('input', {
              style: S.input,
              value: form.defaultModel,
              placeholder: 'opencode-go/deepseek-v4.1-flash',
              onChange: function (event) {
                update({ defaultModel: event.target.value })
              },
            }),
          ),
          h(
            Field,
            { label: t('aliases'), hint: t('aliasesHint') },
            h('textarea', {
              style: S.area,
              value: form.aliases,
              onChange: function (event) {
                update({ aliases: event.target.value })
              },
            }),
          ),
        ),
        h(
          'div',
          { style: S.card },
          h('div', { style: S.title }, t('limits')),
          h(
            Field,
            { label: t('bodyLimit'), hint: t('bodyLimitHint') },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                style: Object.assign({}, S.input, { width: 120 }),
                type: 'number',
                min: 1,
                max: 300,
                step: 1,
                value: form.bodyMiB,
                onChange: function (event) {
                  update({ bodyMiB: event.target.value })
                },
              }),
              h('span', { style: S.hint }, t('mib')),
            ),
          ),
          h(
            Field,
            { label: t('textLimit'), hint: t('textLimitHint') },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                style: Object.assign({}, S.input, { width: 120 }),
                type: 'number',
                min: 1,
                max: 300,
                step: 1,
                value: form.textMiB,
                onChange: function (event) {
                  update({ textMiB: event.target.value })
                },
              }),
              h('span', { style: S.hint }, t('mib')),
            ),
          ),
        ),
        h(
          'div',
          { style: S.card },
          h('div', { style: S.title }, t('mirror')),
          h(
            Field,
            { label: t('mirror') },
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, lineHeight: '30px' } },
              h('input', {
                type: 'checkbox',
                checked: form.mirror,
                onChange: function (event) {
                  update({ mirror: event.target.checked })
                },
              }),
              t('mirrorOn'),
            ),
          ),
          h(
            Field,
            { label: t('ttl'), hint: t('ttlHint') },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                style: Object.assign({}, S.input, { width: 100 }),
                type: 'number',
                value: form.ttl,
                onChange: function (event) {
                  update({ ttl: event.target.value })
                },
              }),
              h('span', { style: S.hint }, t('ttlUnit')),
            ),
          ),
          h(
            Field,
            { label: t('workspace'), hint: t('workspaceHint') },
            h('input', {
              style: S.input,
              value: form.workspacePath,
              onChange: function (event) {
                update({ workspacePath: event.target.value })
              },
            }),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h('button', { style: S.button, onClick: save, disabled: busy }, busy ? t('saving') : t('save')),
          message === null ? null : h('span', { style: message.kind === 'ok' ? S.ok : S.err }, message.text),
        ),
        h(
          'div',
          { style: S.card },
          h('div', { style: S.title }, t('client')),
          h(
            'div',
            { style: S.mono },
            'export OPENAI_BASE_URL=' +
              (status ? status.url : 'http://127.0.0.1:43130') +
              '/v1\nexport OPENAI_API_KEY=anything',
          ),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en })
      }, 'dsh-endpoint: dictionaries')
      var t = ctx.locale.bind(NS)

      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          {
            name: 'settings.section',
            id: 'endpoint-config',
            order: 40,
            label: function () {
              return t('nav')
            },
            inject: function () {
              return { t: t, locale: ctx.locale }
            },
          },
          EndpointSection,
        )
      })
    }

    return { name: 'dsh-endpoint', inject: ['slots', 'locale'], apply: apply }
  },
})
