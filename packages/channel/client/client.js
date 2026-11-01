/**
 * Browser half of dsh-shixu-channel: contributes the Shixu section to the
 * Settings panel.
 *
 * DSH's client module system runs this file only to register a lazy factory,
 * and hands that factory a `require` resolving the shared browser module table
 * (React comes from there). That is why this file is plain CommonJS: no JSX,
 * no bundler, and no React copy of its own.
 *
 * Visible text is translated through the client locale service
 * (`ctx.locale`, namespace `shixu`). The dictionary is inline because the
 * browser can only load `client.js` and `client.*.js` chunks from /plugins:
 * a package's `locale/*.json` is host-side package metadata and is not
 * reachable from a plugin bundle without a build step.
 *
 * The section edits the profile patch row `shixu-driver-onebot11` through
 * `ctx.remote.settings`: `describe()` reads every namespace, `update()` merges
 * only the fields the user actually changed. There is no plugin-private store —
 * the panel and the YAML are two views of one document.
 */
window.__ModuleLoader__.load({
  id: 'dsh-shixu-channel',
  factory: function factory(require) {
    var React = require('react');
    var h = React.createElement;

    /** Locale namespace owned by this plugin. */
    var LOCALE_NS = 'shixu';

    /** The profile row this section edits. Namespaces are keyed by row id, not package name. */
    var NS = 'shixu-driver-onebot11';

    /**
     * Services this module cannot run without. `slots` owns the registration
     * seat, `locale` the dictionaries, `remote` and `remote.settings` the
     * settings transport.
     */
    var inject = ['slots', 'locale', 'remote', 'remote.settings'];

    /**
     * Section copy, keyed by locale id. English terminates the fallback chain,
     * so it has to stay complete when other locales arrive.
     */
    var MESSAGES = {
      zh: {
        'section.label': '时煦',
        'section.hint': '这里的改动直接写进这个 profile 的配置，与配置文件是同一份数据。',
        'load.failed': '读不到配置',
        'save.failed': '保存失败',
        'conflict': '配置已被别处改动，已重新读取最新值，请再改一次。',
        'saved': '已保存',
        'save': '保存',
        'saving': '保存中…',
        'reload': '重新读取',
        'field.mode': '连接方向',
        'field.mode.reverse': '反向（机器人连我们）',
        'field.mode.forward': '正向（我们连机器人）',
        'field.host': '监听地址',
        'field.port': '监听端口',
        'field.url': '对方地址',
        'field.token': '访问令牌',
        'restart.note': '连接方向与地址改完要重启实例才生效；令牌与端口会被驱动在启动时读一次。',
        'token.set': '已设置（留空表示不修改）',
        'token.hint': '两端要一致；令牌只会在你输入后写入，读不到原值。',
      },
      en: {
        'section.label': 'Shixu',
        'section.hint': 'Edits here write into this profile\'s configuration — the same document the YAML holds.',
        'load.failed': 'Cannot read configuration',
        'save.failed': 'Save failed',
        'conflict': 'Configuration changed elsewhere; the latest values were re-read, please edit again.',
        'saved': 'Saved',
        'save': 'Save',
        'saving': 'Saving…',
        'reload': 'Reload',
        'field.mode': 'Direction',
        'field.mode.reverse': 'Reverse (bot connects to us)',
        'field.mode.forward': 'Forward (we connect to the bot)',
        'field.host': 'Listen host',
        'field.port': 'Listen port',
        'field.url': 'Peer URL',
        'field.token': 'Access token',
        'restart.note': 'Direction and address take effect after the instance restarts; the driver reads them once at start.',
        'token.set': 'Set (leave blank to keep)',
        'token.hint': 'Both ends must match; the stored value is never readable.',
      },
    };

    /** Only theme tokens: a renamed token degrades appearance, while a literal colour would ignore the host theme. */
    var styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px 0', color: 'var(--dsw-alias-label-primary)' },
      hint: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      input: { padding: '6px 8px', fontSize: '13px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-subtle)', background: 'var(--dsw-alias-bg-elevated)', color: 'var(--dsw-alias-label-primary)' },
      actions: { display: 'flex', alignItems: 'center', gap: '8px' },
      status: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      error: { fontSize: '12px', color: 'var(--dsw-alias-label-error)' },
    };

    /**
     * Read our namespace out of one describe() document.
     *
     * @param doc - `{ ok, value: { namespaces } }` envelope.
     * @returns the namespace descriptor, or undefined when the row is absent.
     */
    function pickNs(doc) {
      var value = (doc && doc.value) || doc || {};
      var list = value.namespaces || [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].ns === NS) return list[i];
      }
      return undefined;
    }

    /** Whether the row marks the token as configured (the value itself is never readable). */
    function tokenIsSet(entry) {
      var secrets = (entry && entry.secrets) || [];
      for (var i = 0; i < secrets.length; i += 1) {
        var path = secrets[i].path || [];
        if (path.length === 1 && path[0] === 'accessToken' && secrets[i].set) return true;
      }
      return false;
    }

    /** Field value as shown in an input: undefined/null become ''. */
    function text(value) {
      return value === undefined || value === null ? '' : String(value);
    }

    /**
     * Build the minimal patch: only fields whose shown value differs from the
     * loaded one. Untouched fields stay out, which is what keeps the masked
     * token from being written back over the real one.
     */
    function diffPatch(form, loaded) {
      var patch = {};
      if (form.mode !== text(loaded.mode)) patch.mode = form.mode;
      if (form.mode === 'forward') {
        if (form.url !== text(loaded.url)) patch.url = form.url;
      } else {
        if (form.host !== text(loaded.host)) patch.host = form.host;
        if (form.port !== text(loaded.port)) patch.port = Number(form.port);
      }
      // 令牌为空 = 用户没打算改，绝不能把空串写回去把真令牌冲掉。
      if (form.token !== '') patch.accessToken = form.token;
      return patch;
    }

    /**
     * Build the section around one bound translate function, so the body
     * follows a locale switch without re-registering the slot entry.
     *
     * @param t - translate function bound to this plugin's namespace.
     * @param ctx - client root context, captured for the remote settings calls.
     * @returns the section component.
     */
    function createSection(t, ctx) {
      return function ShixuSettingsSection() {
        var stateHook = React.useState({ phase: 'loading', error: '', entry: undefined });
        var state = stateHook[0];
        var setState = stateHook[1];
        var formHook = React.useState({ mode: 'reverse', host: '', port: '', url: '', token: '' });
        var form = formHook[0];
        var setForm = formHook[1];
        var statusHook = React.useState('');
        var status = statusHook[0];
        var setStatus = statusHook[1];

        var load = React.useCallback(function () {
          setState({ phase: 'loading', error: '', entry: undefined });
          return Promise.resolve(ctx.remote.settings.describe()).then(
            function (doc) {
              var entry = pickNs(doc);
              if (entry === undefined) {
                setState({ phase: 'error', error: NS, entry: undefined });
                return;
              }
              var value = entry.value || {};
              setState({ phase: 'ready', error: '', entry: entry });
              setForm({
                mode: text(value.mode) || 'reverse',
                host: text(value.host),
                port: text(value.port),
                url: text(value.url),
                token: '',
              });
            },
            function (err) {
              setState({ phase: 'error', error: (err && err.message) || String(err), entry: undefined });
            }
          );
        }, [setState, setForm]);

        React.useEffect(function () {
          load();
        }, [load]);

        function bind(field) {
          return function (event) {
            var next = Object.assign({}, form);
            next[field] = event.target.value;
            setForm(next);
            setStatus('');
          };
        }

        function save() {
          if (state.entry === undefined) return;
          var patch = diffPatch(form, state.entry.value || {});
          if (Object.keys(patch).length === 0) {
            setStatus(t('saved'));
            return;
          }
          setState({ phase: 'saving', error: '', entry: state.entry });
          setStatus(t('saving'));
          Promise.resolve(ctx.remote.settings.update(NS, patch, state.entry.revision)).then(
            function () {
              setStatus(t('saved'));
              load();
            },
            function (err) {
              var message = (err && err.message) || String(err);
              var conflict = /SETTINGS_CONFLICT|settings\/conflict|changed since it was read/i.test(message);
              setStatus('');
              setState({ phase: 'ready', error: conflict ? t('conflict') : t('save.failed') + '：' + message, entry: state.entry });
              if (conflict) load();
            }
          );
        }

        if (state.phase === 'loading') {
          return h('div', { style: styles.root }, h('p', { style: styles.hint }, t('reload') + '…'));
        }
        if (state.phase === 'error') {
          return h('div', { style: styles.root }, h('p', { style: styles.error }, t('load.failed') + '：' + state.error));
        }

        var entry = state.entry;
        var busy = state.phase === 'saving';
        var rows = [
          h('div', { style: styles.row, key: 'mode' },
            h('label', { style: styles.label }, t('field.mode')),
            h('select', { style: styles.input, value: form.mode, disabled: busy, onChange: bind('mode') },
              h('option', { value: 'reverse' }, t('field.mode.reverse')),
              h('option', { value: 'forward' }, t('field.mode.forward'))
            )
          ),
        ];

        if (form.mode === 'forward') {
          rows.push(h('div', { style: styles.row, key: 'url' },
            h('label', { style: styles.label }, t('field.url')),
            h('input', { style: styles.input, value: form.url, disabled: busy, placeholder: 'ws://127.0.0.1:3001/', onChange: bind('url') })
          ));
        } else {
          rows.push(h('div', { style: styles.row, key: 'host' },
            h('label', { style: styles.label }, t('field.host')),
            h('input', { style: styles.input, value: form.host, disabled: busy, placeholder: '0.0.0.0', onChange: bind('host') })
          ));
          rows.push(h('div', { style: styles.row, key: 'port' },
            h('label', { style: styles.label }, t('field.port')),
            h('input', { style: styles.input, value: form.port, disabled: busy, inputMode: 'numeric', placeholder: '6700', onChange: bind('port') })
          ));
        }

        rows.push(h('div', { style: styles.row, key: 'token' },
          h('label', { style: styles.label }, t('field.token')),
          h('input', {
            style: styles.input,
            type: 'password',
            value: form.token,
            disabled: busy,
            placeholder: tokenIsSet(entry) ? t('token.set') : '',
            onChange: bind('token'),
          }),
          h('p', { style: styles.hint }, t('token.hint'))
        ));

        return h('div', { style: styles.root },
          h('p', { style: styles.hint }, t('section.hint')),
          rows,
          h('p', { style: styles.hint }, t('restart.note')),
          h('div', { style: styles.actions },
            h('button', { type: 'button', disabled: busy, onClick: save }, busy ? t('saving') : t('save')),
            status === '' ? null : h('span', { style: styles.status }, status)
          ),
          state.error === '' ? null : h('p', { style: styles.error }, state.error)
        );
      };
    }

    /**
     * Register the dictionaries and the settings section once its slot
     * declaration is on the ledger.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(LOCALE_NS, MESSAGES);
      }, 'shixu: locale dictionaries');

      var t = ctx.locale.bind(LOCALE_NS);
      var Section = createSection(t, ctx);

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'shixu',
            order: 40,
            label: function () {
              return t('section.label');
            },
          },
          Section
        );
      });
    }

    return { inject: inject, apply: apply };
  },
});
