/**
 * Browser half of dsh-shixu-channel: contributes the Shixu configuration page.
 *
 * Built the way the official pages are built — the shape here is taken from the
 * shipped type declarations of `@deepseek-ai/dsh-client-ui-primitives`
 * (`lib/types/settings-form/*.d.ts`) and the `dsh-client-ui-settings` README:
 * the page is gated by `ctx.configForms.whileServed`, the Host entry is bound
 * through `ctx.configForms.get`, edits are staged by the shared
 * `SettingsFormModel`, and chrome and controls come from primitives. No
 * hand-written input, label, colour or spacing.
 *
 * The data path writes the same profile patch row the YAML holds; there is no
 * plugin-private store.
 */
window.__ModuleLoader__.load({
  id: 'dsh-shixu-channel',
  factory: function factory(require) {
    var React = require('react');
    var h = React.createElement;
    var prim = require('@deepseek-ai/dsh-client-ui-primitives');

    var LOCALE_NS = 'shixu';
    var NS = 'shixu-driver-onebot11';
    var inject = ['slots', 'locale', 'remote', 'remote.settings', 'configForms'];

    var MESSAGES = {
      zh: {
        'section.label': '时煦',
        'form.unavailable': '时煦驱动未加载。',
        'form.readOnly': '配置为只读。',
        'form.saveFailed': '保存失败。请重试。',
        'form.save': '保存',
        'form.saving': '保存中…',
        'field.host': '监听地址',
        'field.host.hint': '反向模式下本机监听的地址。填 0.0.0.0 表示监听所有网卡。',
        'field.port': '监听端口',
        'field.port.hint': '反向模式下本机监听的端口。机器人端的端口必须与此一致。',
        'field.url': '对方地址',
        'field.url.hint': '正向模式下要连的 WebSocket 服务端地址。',
        'field.accessToken': '访问令牌',
        'field.accessToken.hint': '两端必须一致。已保存的值不会显示。重新输入才会覆盖。留空保存会恢复继承值。',
        'badge.overridden': '已覆盖',
        'action.reset': '恢复继承值',
        'state.invalid': '值无效',
        'restart.note': '重启实例后，地址与端口的改动才生效。',
      },
      en: {
        'section.label': 'Shixu',
        'form.unavailable': 'This deployment does not configure the Shixu driver.',
        'form.readOnly': 'This configuration is read-only.',
        'form.saveFailed': 'Save failed, please retry.',
        'form.save': 'Save',
        'form.saving': 'Saving…',
        'field.host': 'Listen host',
        'field.host.hint': 'Address we listen on in reverse mode. 0.0.0.0 means all interfaces.',
        'field.port': 'Listen port',
        'field.port.hint': 'Port we listen on in reverse mode; the bot must use the same one.',
        'field.url': 'Peer URL',
        'field.url.hint': 'WebSocket server to connect to in forward mode.',
        'field.accessToken': 'Access token',
        'field.accessToken.hint': 'Both ends must match. A stored value is never displayed; type to replace it, save empty to re-inherit.',
        'badge.overridden': 'Overridden',
        'action.reset': 'Reset to inherited',
        'state.invalid': 'This value is not usable',
        'restart.note': 'Address changes take effect after the instance restarts.',
      },
    };

    /**
     * Staged editor over one Host entry, mirroring the official controllers:
     * the shared model owns staging, validation and saving; this class maps the
     * model into the hook surface the slot renderer consumes.
     *
     * @param scope - `ctx.configForms.get` view of the entry.
     */
    function FormController(scope) {
      var form = new prim.SettingsFormModel(scope, [
        prim.settingsTextField('host'),
        prim.settingsNumberField('port'),
        prim.settingsTextField('url'),
        prim.settingsTextField('accessToken'),
      ]);
      this.form = form;
      this.store = form.bind(function () {
        return {
          shell: form.shell(),
          host: form.field('host'),
          port: form.field('port'),
          url: form.field('url'),
          accessToken: form.field('accessToken'),
        };
      });
    }

    /** Hook surface handed to the slot renderer. */
    FormController.prototype.inject = function () {
      return Object.assign({ hooks: { shixuForm: this.store } }, this.form.actions());
    };

    /** Release the accepted-value subscription owned by this controller. */
    FormController.prototype.dispose = function () {
      this.form.dispose();
    };

    /**
     * Render the page.
     *
     * @param t - translate function bound to this plugin's namespace.
     * @returns the section component.
     */
    function createSection(t) {
      // slot 系统把每个 hook 变成 `use<Name>Form` 这样的 hook prop，且只能在组件顶层调用。
      return function ShixuSettingsSection(props) {
        // hook prop 读的是快照选择器：它接收 store 的快照并返回要渲染的那部分。
        var snapshot = props.useShixuForm(function (state) {
          return state;
        });
        if (snapshot === undefined || snapshot === null) {
          return h('p', { role: 'status' }, t('form.unavailable'));
        }
        try {
          return renderSection(props, snapshot);
        } catch (err) {
          // 抛出去的异常会连累整个设置面板，宁可把错误显示出来。
          return h('p', { role: 'status' }, 'shixu panel error: ' + ((err && err.message) || String(err)));
        }
      };

      function renderSection(props, snapshot) {
        if (snapshot === undefined || snapshot === null) {
          return h('p', { role: 'status' }, t('form.unavailable'));
        }

        var shell = snapshot.shell || {};
        var disabled = shell.writable === false || shell.saving === true;

        function field(name, props2) {
          var state = snapshot[name] || {};
          return h(
            prim.SettingsValueField,
            Object.assign(
              {
                key: name,
                id: 'shixu-' + name,
                label: t('field.' + name),
                hint: t('field.' + name + '.hint'),
                overriddenLabel: t('badge.overridden'),
                resetLabel: t('action.reset'),
                invalidLabel: t('state.invalid'),
                disabled: disabled,
                onEdit: function (text) {
                  props.edit(name, text);
                },
                onReset: function () {
                  props.resetField(name);
                },
              },
              state
            ),
            props2
          );
        }

        return h(
          prim.SettingsForm,
          {
            state: {
              available: shell.available !== false,
              writable: shell.writable !== false,
              dirty: shell.dirty === true,
              invalid: shell.invalid === true,
              saving: shell.saving === true,
              failed: shell.failed === true,
            },
            labels: {
              unavailable: t('form.unavailable'),
              readOnly: t('form.readOnly'),
              saveFailed: t('form.saveFailed'),
              save: t('form.save'),
              saving: t('form.saving'),
            },
            onSave: props.save,
            onDiscard: props.discard,
            children: [
              h('div', { key: 'fields' }, [
                field('host', { numeric: false }),
                field('port', { numeric: true }),
                field('url', { numeric: false }),
                field('accessToken', { numeric: false }),
              ]),
              h('p', { key: 'restart' }, t('restart.note')),
            ],
          }
        );
      }
    }

    /**
     * Register the dictionaries and the settings page once the Host serves our
     * entry: `whileServed` keeps the page absent in deployments that never
     * composed the driver.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(LOCALE_NS, MESSAGES);
      }, 'shixu: locale dictionaries');

      var t = ctx.locale.bind(LOCALE_NS);
      var Section = createSection(t);

      ctx.effect(function () {
        return ctx.configForms.whileServed([NS], function () {
          var controller = new FormController(ctx.configForms.get(NS));
          var disposeSlot = ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'shixu',
                order: 40,
                label: function () {
                  return t('section.label');
                },
                inject: function () {
                  return controller.inject();
                },
              },
              Section
            );
          });
          return function () {
            if (typeof disposeSlot === 'function') disposeSlot();
            controller.dispose();
          };
        });
      }, 'shixu: settings page');
    }

    return { inject: inject, apply: apply };
  },
});
