/**
 * Browser half of dsh-shixu-channel: contributes the Shixu section to the
 * Settings panel.
 *
 * The section is built from DSH's own UI kit (`@deepseek-ai/dsh-client-ui-primitives`):
 * `SettingsForm` supplies the form chrome (save/discard footer, read-only and
 * save-failed states), `SettingsValueField` the label+hint layout around a
 * control, `SettingsSecretField` the masked token row. Nothing here defines its
 * own colours or spacing — a native section and this one have to look like they
 * were made by the same person.
 *
 * The data path stays `ctx.remote.settings`: `describe()` reads every
 * namespace, `update()` merges only the fields the user actually changed.
 * There is no plugin-private store — the panel and the YAML are two views of
 * one document.
 *
 * Everything visible is translated through `ctx.locale` (namespace `shixu`).
 * The dictionary is inline because the browser can only load `client.js` and
 * `client.*.js` chunks from /plugins; a package's `locale/*.json` is host-side
 * metadata.
 */
window.__ModuleLoader__.load({
  id: 'dsh-shixu-channel',
  factory: function factory(require) {
    var React = require('react');
    var h = React.createElement;
    var prim = require('@deepseek-ai/dsh-client-ui-primitives');

    /** Locale namespace owned by this plugin. */
    var LOCALE_NS = 'shixu';

    /** The profile row this section edits. Namespaces are keyed by row id, not package name. */
    var NS = 'shixu-driver-onebot11';

    /** Services this module cannot run without. */
    var inject = ['slots', 'locale', 'remote', 'remote.settings', 'configForms'];

    /** Section copy. English terminates the fallback chain, so it has to stay complete. */
    var MESSAGES = {
      zh: {
        'section.label': '时煦',
        'section.hint': '这里的改动直接写进这个 profile 的配置，与配置文件是同一份数据。',
        'section.missing': '找不到 shixu-driver-onebot11 这一行配置。',
        'state.unavailable': '正在读取配置…',
        'state.readOnly': '当前配置不可写。',
        'state.saveFailed': '保存失败，请重试。',
        'state.saving': '保存中…',
        'action.save': '保存',
        'action.discard': '放弃修改',
        'field.forward': '正向连接',
        'field.forward.help': '开启后我们主动连对方的 WebSocket；关闭则由对方连我们。',
        'field.host': '监听地址',
        'field.host.help': '反向模式下本机监听的地址。默认 0.0.0.0 表示所有网卡。',
        'field.port': '监听端口',
        'field.port.help': '反向模式下本机监听的端口，机器人那边要填同一个。',
        'field.url': '对方地址',
        'field.url.help': '正向模式下要连的 WebSocket 服务端地址。',
        'field.token': '访问令牌',
        'field.token.hint': '两端要一致。已设置时不会显示原值，只有你重新输入才会覆盖。',
        'token.configured': '已设置',
        'token.absent': '未设置',
        'restart.note': '连接方向与地址改完要重启实例才生效：驱动在启动时读一次就绑定了。',
      },
      en: {
        'section.label': 'Shixu',
        'section.hint': 'Edits here write into this profile\'s configuration — the same document the YAML holds.',
        'section.missing': 'The shixu-driver-onebot11 configuration row was not found.',
        'state.unavailable': 'Reading configuration…',
        'state.readOnly': 'This configuration is read-only.',
        'state.saveFailed': 'Save failed, please retry.',
        'state.saving': 'Saving…',
        'action.save': 'Save',
        'action.discard': 'Discard',
        'field.forward': 'Forward connection',
        'field.forward.help': 'On: we connect to the peer WebSocket. Off: the peer connects to us.',
        'field.host': 'Listen host',
        'field.host.help': 'Address we listen on in reverse mode. 0.0.0.0 means all interfaces.',
        'field.port': 'Listen port',
        'field.port.help': 'Port we listen on in reverse mode; the bot must use the same one.',
        'field.url': 'Peer URL',
        'field.url.help': 'WebSocket server to connect to in forward mode.',
        'field.token': 'Access token',
        'field.token.hint': 'Both ends must match. A stored token is never displayed; type a new one to replace it.',
        'token.configured': 'Configured',
        'token.absent': 'Not set',
        'restart.note': 'Direction and address take effect after the instance restarts: the driver binds them once at start.',
      },
    };

    /** Read our namespace out of one describe() document. */
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

    /** Field value as shown in a control: undefined/null become ''. */
    function text(value) {
      return value === undefined || value === null ? '' : String(value);
    }

    var INVALID_PORT = /^\d+$/;

    /**
     * Build the minimal patch: only fields whose shown value differs from the
     * loaded one. Untouched fields stay out, which is what keeps a masked
     * secret from being written back over the real value.
     */
    function diffPatch(form, loaded, forward) {
      var patch = {};
      var loadedForward = text(loaded.mode) === 'forward';
      if (form.forward !== loadedForward) patch.mode = form.forward ? 'forward' : 'reverse';
      if (form.forward) {
        if (form.url !== text(loaded.url)) patch.url = form.url.trim();
      } else {
        if (form.host !== text(loaded.host)) patch.host = form.host.trim();
        if (form.port !== text(loaded.port)) patch.port = Number(form.port.trim());
      }
      if (form.token !== '') patch.accessToken = form.token;
      return patch;
    }

    /**
     * Build the section around one bound translate function, so the body follows
     * a locale switch without re-registering the slot entry.
     *
     * @param t - translate function bound to this plugin's namespace.
     * @param ctx - client root context, captured for the remote settings calls.
     * @returns the section component.
     */
    function createSection(t, ctx) {
      return function ShixuSettingsSection() {
        var entryHook = React.useState({ phase: 'loading', entry: undefined, error: '' });
        var entryState = entryHook[0];
        var setEntryState = entryHook[1];
        var formHook = React.useState({ forward: false, host: '', port: '', url: '', token: '' });
        var form = formHook[0];
        var setForm = formHook[1];
        var lifeHook = React.useState({ saving: false, failed: false });
        var life = lifeHook[0];
        var setLife = lifeHook[1];

        var load = React.useCallback(function () {
          setEntryState({ phase: 'loading', entry: undefined, error: '' });
          return Promise.resolve(ctx.remote.settings.describe()).then(
            function (doc) {
              var entry = pickNs(doc);
              if (entry === undefined) {
                setEntryState({ phase: 'missing', entry: undefined, error: '' });
                return;
              }
              var value = entry.value || {};
              setEntryState({ phase: 'ready', entry: entry, error: '' });
              setForm({
                forward: text(value.mode) === 'forward',
                host: text(value.host),
                port: text(value.port),
                url: text(value.url),
                token: '',
              });
            },
            function (err) {
              setEntryState({ phase: 'error', entry: undefined, error: (err && err.message) || String(err) });
            }
          );
        }, []);

        React.useEffect(function () {
          load();
        }, [load]);

        if (entryState.phase === 'loading') {
          return h(prim.SettingsForm, { state: { available: false, writable: false, dirty: false, invalid: false, saving: false, failed: false }, labels: labels(t), onSave: noop, onDiscard: noop, children: null });
        }
        if (entryState.phase === 'missing' || entryState.phase === 'error') {
          return h('p', { role: 'status' }, entryState.phase === 'missing' ? t('section.missing') : entryState.error);
        }

        var entry = entryState.entry;
        var loaded = entry.value || {};
        var patch = diffPatch(form, loaded, form.forward);
        var dirty = Object.keys(patch).length > 0;
        var invalid = !form.forward && form.port.trim() !== '' && !INVALID_PORT.test(form.port.trim());

        function onField(field) {
          return function (next) {
            var copy = Object.assign({}, form);
            copy[field] = next;
            setForm(copy);
            setLife({ saving: false, failed: false });
          };
        }

        function save() {
          if (!dirty || invalid) return;
          setLife({ saving: true, failed: false });
          Promise.resolve(ctx.remote.settings.update(NS, patch, entry.revision)).then(
            function () {
              setLife({ saving: false, failed: false });
              load();
            },
            function () {
              setLife({ saving: false, failed: true });
            }
          );
        }

        function discard() {
          setLife({ saving: false, failed: false });
          load();
        }

        var state = {
          available: true,
          writable: true,
          dirty: dirty,
          invalid: invalid,
          saving: life.saving,
          failed: life.failed,
        };

        return h(
          prim.SettingsForm,
          {
            state: state,
            labels: labels(t),
            onSave: save,
            onDiscard: discard,
            children: h(
              'div',
              null,
              h('p', null, t('section.hint')),
              h(prim.SettingsValueField, {
                id: 'shixu-forward',
                label: t('field.forward'),
                help: { label: t('field.forward.help'), content: t('field.forward.help') },
                hint: t('field.forward.help'),
                children: h(prim.Switch, {
                  id: 'shixu-forward',
                  checked: form.forward,
                  onChange: function (next) {
                    onField('forward')(next === undefined ? !form.forward : next);
                  },
                }),
              }),
              form.forward
                ? h(prim.SettingsValueField, {
                    id: 'shixu-url',
                    label: t('field.url'),
                    hint: t('field.url.help'),
                    children: h(prim.Input, {
                      id: 'shixu-url',
                      value: form.url,
                      placeholder: 'ws://127.0.0.1:3001/',
                      onInput: function (event) {
                        onField('url')(event.target.value);
                      },
                      onChange: function (event) {
                        onField('url')(event.target.value);
                      },
                    }),
                  })
                : h(
                    'div',
                    null,
                    h(prim.SettingsValueField, {
                      id: 'shixu-host',
                      label: t('field.host'),
                      hint: t('field.host.help'),
                      children: h(prim.Input, {
                        id: 'shixu-host',
                        value: form.host,
                        placeholder: '0.0.0.0',
                        onInput: function (event) {
                          onField('host')(event.target.value);
                        },
                        onChange: function (event) {
                          onField('host')(event.target.value);
                        },
                      }),
                    }),
                    h(prim.SettingsValueField, {
                      id: 'shixu-port',
                      label: t('field.port'),
                      hint: t('field.port.help'),
                      invalid: invalid,
                      message: invalid ? t('field.port') : undefined,
                      children: h(prim.Input, {
                        id: 'shixu-port',
                        value: form.port,
                        placeholder: '6700',
                        inputMode: 'numeric',
                        onInput: function (event) {
                          onField('port')(event.target.value);
                        },
                        onChange: function (event) {
                          onField('port')(event.target.value);
                        },
                      }),
                    })
                  ),
              h(prim.SettingsSecretField, {
                id: 'shixu-token',
                label: t('field.token'),
                configured: tokenIsSet(entry),
                stateLabel: tokenIsSet(entry) ? t('token.configured') : t('token.absent'),
                text: form.token,
                disabled: life.saving,
                onEdit: function (value) {
                  onField('token')(value);
                },
                hint: t('field.token.hint'),
              }),
              h('p', null, t('restart.note'))
            ),
          }
        );
      };
    }

    /** Chrome labels for the native form shell. */
    function labels(t) {
      return {
        unavailable: t('state.unavailable'),
        readOnly: t('state.readOnly'),
        saveFailed: t('state.saveFailed'),
        save: t('action.save'),
        saving: t('state.saving'),
        discard: t('action.discard'),
      };
    }

    function noop() {}

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

      // 临时探针：configForms scope 与 SettingsFormModel 的真实方法面。
      try {
        var scope = ctx.configForms.get(NS);
        var Model = prim.SettingsFormModel;
        var proto = Model && Model.prototype ? Object.getOwnPropertyNames(Model.prototype) : [];
        window.__shixuScope = JSON.stringify({
          scopeFound: scope !== undefined,
          scopeProto: scope ? Object.getOwnPropertyNames(Object.getPrototypeOf(scope)) : [],
          scopeOwn: scope ? Object.keys(scope) : [],
          modelProto: proto,
          snap: scope && scope.getSnapshot ? Object.keys(scope.getSnapshot()) : [],
        });
      } catch (e) {
        window.__shixuScope = 'ERR ' + ((e && e.message) || String(e));
      }

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
